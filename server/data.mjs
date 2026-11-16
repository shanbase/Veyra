import { randomUUID } from 'node:crypto';
import { pool, isPostgres } from './db.mjs';
import { ensureDirectMessage } from './rpc.mjs';
import { notifyNewMessage } from './notifications.mjs';
import { cachedRead, invalidateReadCache, redisGetJson, redisSetJson, cachedUserRoles, invalidateUserRole, ezmsgPush, ezmsgPop, ezmsgAck, ezmsgPending, ezmsgRecover, ezmsgMarkFailed, ezmsgScheduleRetry, ezmsgMoveDueRetries, isTransientQueueError } from './redis.mjs';
import { decryptRowsForTable, encryptRowForTable } from './encryption.mjs';
import { publishMariaDbChanges } from './realtime.mjs';

const TABLES = new Set([
  'admin_logs', 'announcement_messages', 'blocked_users', 'conversation_members',
  'conversations', 'friend_requests', 'global_messages', 'message_reactions',
  'messages', 'message_reports', 'native_push_tokens', 'notification_digest_state',
  'notification_preferences', 'notification_trigger_events', 'pinned_conversations',
  'poll_options', 'poll_votes', 'polls', 'profiles', 'user_roles',
  'profile_links', 'profile_friend_codes',
]);
const columnCache = new Map();

async function columnsFor(table) {
  if (!TABLES.has(table)) throw new Error('Unknown table.');
  if (!columnCache.has(table)) {
    // Schema metadata is stable — share it through Redis so every serverless
    // instance doesn't pay 19 SHOW COLUMNS queries on cold start.
    const cacheKey = `veyra:v1:cols:${isPostgres ? 'pg' : 'my'}:${table}`;
    const cached = await redisGetJson(cacheKey);
    if (cached && typeof cached === 'object') {
      columnCache.set(table, new Map(Object.entries(cached)));
      return columnCache.get(table);
    }
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    const columns = new Map(rows.map((row) => [row.Field, row.Type]));
    columnCache.set(table, columns);
    await redisSetJson(cacheKey, Object.fromEntries(columns), 3600);
  }
  return columnCache.get(table);
}

function identifier(value, columns) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) || !columns.has(value)) {
    throw new Error(`Unsupported column: ${value}`);
  }
  return `\`${value}\``;
}

function normalizeTemporalValue(value, columnType) {
  // PostgreSQL BOOLEAN columns reject integer 0/1 params; coerce them while
  // MariaDB tinyint(1) columns keep accepting raw values.
  if (isPostgres && /^boolean$/i.test(columnType || '') && value !== null && value !== undefined) {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
  }
  if (value == null || typeof value !== 'string' || !/^(?:date|datetime|timestamp)\b/i.test(columnType || '')) return value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid date or time value.');
  const iso = parsed.toISOString();
  if (/^date\b/i.test(columnType) && !/^datetime\b/i.test(columnType)) return iso.slice(0, 10);
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}

function normalizeRowTemporalValues(row, columns) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    normalizeTemporalValue(value, columns.get(key)),
  ]));
}

async function isAdmin(userId) {
  return (await cachedUserRoles(userId)).admin;
}

async function isSuperAdmin(userId) {
  return (await cachedUserRoles(userId)).super;
}

function membershipExists(userId, conversationColumn = 'conversation_id') {
  return `EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = t.${conversationColumn} AND cm.user_id = ?)`;
}

async function policy(table, userId, operation) {
  const admin = await isAdmin(userId);
  const owner = {
    profiles: ['id'], user_roles: ['user_id'], friend_requests: ['sender_id', 'receiver_id'],
    blocked_users: ['blocker_id'], pinned_conversations: ['user_id'],
    notification_preferences: ['user_id'], notification_digest_state: ['user_id'],
    native_push_tokens: ['user_id'],
  };

  if (table === 'notification_trigger_events') return { sql: '1 = 0', args: [] };
  if (table === 'message_reports') {
    if (admin) return { sql: '1 = 1', args: [] };
    // Reports are write-only for regular users — nobody reads other people's
    // reports back through the generic data API.
    return operation === 'insert'
      ? { sql: 'reporter_id = ?', args: [userId] }
      : { sql: '1 = 0', args: [] };
  }
  if (table === 'admin_logs') return admin
    ? { sql: operation === 'insert' ? '1 = 1' : '1 = 1', args: [] }
    : { sql: '1 = 0', args: [] };
  if (table === 'profiles') return operation === 'select'
    ? { sql: '1 = 1', args: [] }
    : { sql: 'id = ?', args: [userId] };
  if (table === 'profile_links') {
    // Links are public profile content; only the owner writes them.
    return operation === 'select'
      ? { sql: '1 = 1', args: [] }
      : { sql: 'user_id = ?', args: [userId] };
  }
  if (table === 'profile_friend_codes') {
    // The code is a bearer credential: owner reads it for the QR card, but
    // every mutation goes through the friend-code RPCs so rotation rate
    // limits and redeem rules cannot be bypassed via the generic data API.
    return operation === 'select'
      ? { sql: 'user_id = ?', args: [userId] }
      : { sql: '1 = 0', args: [] };
  }
  if (table === 'user_roles') return await isSuperAdmin(userId)
    ? { sql: '1 = 1', args: [] }
    : { sql: 'user_id = ?', args: [userId] };
  if (table === 'announcement_messages') return operation === 'select' || admin
    ? { sql: '1 = 1', args: [] }
    : { sql: '1 = 0', args: [] };
  if (table === 'global_messages' && operation === 'select') return { sql: '1 = 1', args: [] };
  if (table === 'global_messages') return admin
    ? { sql: '1 = 1', args: [] }
    : { sql: 'sender_id = ?', args: [userId] };
  if (table === 'conversations') {
    if (operation === 'insert') return { sql: 'created_by = ?', args: [userId] };
    if (admin) return { sql: '1 = 1', args: [] };
    if (operation === 'select') return { sql: membershipExists(userId), args: [userId] };
    return { sql: `EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = t.id AND cm.user_id = ? AND cm.role IN ('owner','admin'))`, args: [userId] };
  }
  if (table === 'conversation_members') {
    if (operation === 'insert') return admin
      ? { sql: '1 = 1', args: [] }
      : { sql: `(user_id = ? AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.created_by = ?)) OR EXISTS (SELECT 1 FROM conversation_members mine WHERE mine.conversation_id = t.conversation_id AND mine.user_id = ? AND mine.role IN ('owner','admin'))`, args: [userId, userId, userId] };
    if (admin) return { sql: '1 = 1', args: [] };
    if (operation === 'select') return { sql: `(${membershipExists(userId)} OR user_id = ?)`, args: [userId, userId] };
    // Members may update their own row (e.g. toggling `muted`); sensitive
    // columns (role, ids, joined_at) are blocked by protectedColumns anyway.
    return { sql: `user_id = ? OR EXISTS (SELECT 1 FROM conversation_members mine WHERE mine.conversation_id = t.conversation_id AND mine.user_id = ? AND mine.role IN ('owner','admin'))`, args: [userId, userId] };
  }
  if (table === 'friend_requests') {
    if (admin) return { sql: '1 = 1', args: [] };
    if (operation === 'select' || operation === 'delete') return { sql: '(sender_id = ? OR receiver_id = ?)', args: [userId, userId] };
    return { sql: operation === 'insert' ? 'sender_id = ?' : 'receiver_id = ?', args: [userId] };
  }
  if (table === 'messages') return admin
    ? { sql: '1 = 1', args: [] }
    : operation === 'select'
      ? { sql: membershipExists(userId), args: [userId] }
      : { sql: `sender_id = ? AND ${membershipExists(userId)}`, args: [userId, userId] };
  if (table === 'message_reactions') {
    if (admin) return { sql: '1 = 1', args: [] };
    // message_id is polymorphic: a reaction is visible when the target is a DM
    // message in a conversation the user belongs to, or any global/announcement
    // message (those channels are readable by everyone).
    return operation === 'select'
      ? { sql: `(EXISTS (SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.id = t.message_id AND cm.user_id = ?) OR EXISTS (SELECT 1 FROM global_messages g WHERE g.id = t.message_id) OR EXISTS (SELECT 1 FROM announcement_messages a WHERE a.id = t.message_id))`, args: [userId] }
      : { sql: 'user_id = ?', args: [userId] };
  }
  if (table === 'polls') {
    if (admin) return { sql: '1 = 1', args: [] };
    return operation === 'select'
      ? { sql: `(conversation_id IS NULL OR ${membershipExists(userId)})`, args: [userId] }
      : { sql: 'created_by = ?', args: [userId] };
  }
  if (table === 'poll_options' || table === 'poll_votes') {
    if (admin) return { sql: '1 = 1', args: [] };
    if (table === 'poll_votes' && operation !== 'select') return { sql: 'user_id = ?', args: [userId] };
    const extra = table === 'poll_options' && operation !== 'select' ? ' AND p.created_by = ?' : '';
    return { sql: `EXISTS (SELECT 1 FROM polls p WHERE p.id = t.poll_id AND (p.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = p.conversation_id AND cm.user_id = ?))${extra})`, args: extra ? [userId, userId] : [userId] };
  }
  if (owner[table]) {
    const cols = owner[table];
    return { sql: admin && table === 'user_roles' ? '1 = 1' : `(${cols.map((col) => `${col} = ?`).join(' OR ')})`, args: admin && table === 'user_roles' ? [] : cols.map(() => userId) };
  }
  return { sql: '1 = 0', args: [] };
}

// Escapes LIKE metacharacters so user input can't inject wildcards; `*` is
// still mapped to `%` as the PostgREST-style wildcard the client sends.
function escapeLike(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
    .replaceAll('*', '%');
}

const MAX_FILTERS = 25;
const MAX_IN_VALUES = 200;
const MAX_OR_LENGTH = 500;

function filterSql(filters, columns) {
  const parts = [];
  const args = [];
  if (!Array.isArray(filters)) filters = [];
  if (filters.length > MAX_FILTERS) throw new Error('Too many filters.');
  for (const filter of filters) {
    const col = identifier(filter.column, columns);
    switch (filter.op) {
      case 'eq': parts.push(`${col} = ?`); args.push(normalizeTemporalValue(filter.value, columns.get(filter.column))); break;
      case 'neq': parts.push(`${col} <> ?`); args.push(normalizeTemporalValue(filter.value, columns.get(filter.column))); break;
      case 'gt': parts.push(`${col} > ?`); args.push(normalizeTemporalValue(filter.value, columns.get(filter.column))); break;
      case 'gte': parts.push(`${col} >= ?`); args.push(normalizeTemporalValue(filter.value, columns.get(filter.column))); break;
      case 'lt': parts.push(`${col} < ?`); args.push(normalizeTemporalValue(filter.value, columns.get(filter.column))); break;
      case 'lte': parts.push(`${col} <= ?`); args.push(normalizeTemporalValue(filter.value, columns.get(filter.column))); break;
      case 'in': {
        if (!Array.isArray(filter.value) || !filter.value.length) parts.push('1 = 0');
        else if (filter.value.length > MAX_IN_VALUES) throw new Error('Too many values in filter.');
        else {
          parts.push(`${col} IN (${filter.value.map(() => '?').join(',')})`);
          args.push(...filter.value.map((value) => normalizeTemporalValue(value, columns.get(filter.column))));
        }
        break;
      }
      case 'is':
        if (filter.value === null) {
          parts.push(`${col} IS NULL`);
        } else if (isPostgres) {
          // `IS ?` is not valid PostgreSQL; IS NOT DISTINCT FROM covers all types.
          parts.push(`${col} IS NOT DISTINCT FROM ?`);
          args.push(normalizeTemporalValue(filter.value, columns.get(filter.column)));
        } else if (/^(?:tinyint\(1\)|boolean)/i.test(columns.get(filter.column) || '')) {
          // MariaDB `IS` only accepts boolean/NULL literals — tinyint(1) and
          // boolean columns can take a real comparison value.
          parts.push(`${col} IS ?`);
          args.push(normalizeTemporalValue(filter.value, columns.get(filter.column)));
        } else {
          throw new Error('Unsupported IS filter value for this column.');
        }
        break;
      case 'ilike': parts.push(`LOWER(${col}) LIKE LOWER(?)`); args.push(escapeLike(filter.value)); break;
      default: throw new Error(`Unsupported filter: ${filter.op}`);
    }
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', args };
}

function parseOr(raw, columns) {
  if (!raw) return { sql: '', args: [] };
  if (String(raw).length > MAX_OR_LENGTH) throw new Error('OR filter is too long.');
  const clauses = String(raw).split(',');
  const args = [];
  const sql = clauses.map((clause) => {
    const match = clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|neq|ilike)\.(.*)$/);
    if (!match) throw new Error('Unsupported OR filter.');
    const col = identifier(match[1], columns);
    const op = match[2];
    const value = match[3];
    if (op === 'ilike') { args.push(escapeLike(value)); return `LOWER(${col}) LIKE LOWER(?)`; }
    args.push(normalizeTemporalValue(value, columns.get(match[1])));
    return `${col} ${op === 'eq' ? '=' : '<>'} ?`;
  });
  return { sql: `(${sql.join(' OR ')})`, args };
}

function selection(select, columns) {
  const value = select || '*';
  if (value.trim() === '*') return '*';
  return value.split(',').map((part) => identifier(part.trim(), columns)).join(', ');
}

async function queryDataUncached(userId, payload) {
  const { table, operation = 'select' } = payload || {};
  const columns = await columnsFor(table);
  if (!['select', 'insert', 'update', 'delete', 'upsert'].includes(operation)) throw new Error('Unsupported operation.');
  const requested = selection(payload.columns, columns);
  const filters = filterSql(payload.filters, columns);
  const or = parseOr(payload.or, columns);
  const where = [filters.sql, ...(or.sql ? [or.sql] : [])];
  const filterArgs = [...filters.args, ...or.args];
  const access = await policy(table, userId, operation);
  const whereSql = [...where, `(${access.sql})`].join(' AND ');
  const whereArgs = [...filterArgs, ...access.args];

  if (operation === 'select') {
    const countRequested = payload.count === 'exact';
    let count = null;
    if (countRequested) {
      const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM \`${table}\` t WHERE ${whereSql}`, whereArgs);
      count = Number(countRows[0]?.total || 0);
    }
    if (payload.head) return { data: null, count };
    const order = (payload.order || []).map(({ column, ascending }) => `${identifier(column, columns)} ${ascending === false ? 'DESC' : 'ASC'}`).join(', ');
    const limit = Math.min(Math.max(Number(payload.limit ?? 100), 0), 500);
    const offset = Math.max(Number(payload.offset || 0), 0);
    const [rows] = await pool.execute(
      `SELECT ${requested} FROM \`${table}\` t WHERE ${whereSql}${order ? ` ORDER BY ${order}` : ''} LIMIT ${limit} OFFSET ${offset}`,
      whereArgs,
    );
    return { data: payload.single ? rows[0] ?? null : rows, count };
  }

  if (operation === 'insert' || operation === 'upsert') {
    const inputRows = (Array.isArray(payload.values) ? payload.values : [payload.values]).filter(Boolean);
    if (inputRows.length > MAX_WRITE_ROWS) throw new Error('Too many rows in one request.');
    if (!inputRows.length) return { data: [], count: 0 };
    const inserted = [];
    const queuedResponses = [];
    const persistedRows = [];
    for (const input of inputRows) {
      const row = { ...input };
      if (columns.has('id') && !row.id) row.id = randomUUID();
      if (!await canInsert(table, row, userId, access)) throw new Error('Not allowed to insert this row.');
      const normalizedRow = normalizeRowTemporalValues(row, columns);
      if (table === 'profiles') sanitizeProfileFields(normalizedRow);
      // EZMSG write-behind (REDIS_EZMSG=true): message inserts are queued in
      // Redis and persisted by the drain worker; the API still returns the
      // row shape immediately. Falls through to a direct insert when Redis
      // is unavailable so messaging never depends on the queue.
      if (operation === 'insert' && EZMSG_ENABLED && MESSAGE_TABLES.has(table)) {
        const queued = await ezmsgEnqueue(table, normalizedRow, row, userId, columns, requested);
        if (queued) {
          queuedResponses.push(queued.response);
          continue;
        }
      }
      persistedRows.push(row);
      const storedRow = encryptRowForTable(table, normalizedRow);
      const keys = Object.keys(storedRow);
      for (const key of keys) identifier(key, columns);
      if (!keys.length) throw new Error('Insert data is empty.');
      const updateKeys = operation === 'upsert' ? keys.filter((key) => key !== 'id' && key !== 'user_id') : [];
      const insertSql = `INSERT INTO \`${table}\` (${keys.map((key) => `\`${key}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})${operation === 'upsert' && updateKeys.length ? ` ON DUPLICATE KEY UPDATE ${updateKeys.map((key) => `\`${key}\` = VALUES(\`${key}\`)`).join(', ')}` : ''}`;
      const insertArgs = keys.map((key) => storedRow[key]);
      // An FCM token identifies a device, not an account: when a different
      // user registers a token this device already used, retire the old
      // account's row so one device never receives two accounts' pushes.
      if (table === 'native_push_tokens' && typeof row.token === 'string' && row.token) {
        await pool.execute('UPDATE native_push_tokens SET enabled = FALSE WHERE token = ? AND user_id <> ?', [row.token, userId]);
      }
      if (table === 'poll_votes') {
        // Single-choice votes delete-then-insert; both must be atomic or two
        // concurrent votes on different options can both land.
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [polls] = await connection.execute('SELECT multiple_choice FROM polls WHERE id = ? AND closed_at IS NULL AND ends_at > CURRENT_TIMESTAMP(3)', [row.poll_id]);
          if (!polls.length) throw new Error('This poll is closed.');
          if (!polls[0].multiple_choice) await connection.execute('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_id <> ?', [row.poll_id, row.user_id, row.option_id]);
          await connection.execute(insertSql, insertArgs);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally { connection.release(); }
        inserted.push(row.id ?? row.user_id);
      } else {
        const [result] = await pool.execute(insertSql, insertArgs);
        inserted.push(row.id ?? row.user_id ?? result.insertId);
      }
    }
    const rows = operation === 'upsert' && table === 'friend_requests'
      ? await fetchUpsertedFriendRequests(inputRows, requested)
      : [...await fetchByIds(table, inserted, requested, columns), ...queuedResponses];
    if (['messages', 'global_messages', 'announcement_messages'].includes(table)) {
      // Queued rows are notified by the drain worker once actually persisted.
      for (const row of persistedRows) void notifyNewMessage(table, row).catch((error) => console.error('Notification delivery failed:', error));
    }
    if (table === 'user_roles') await invalidateUserRole(...rows.map((row) => row.user_id));
    const allQueued = queuedResponses.length > 0 && inserted.length === 0;
    return { data: payload.single ? rows[0] ?? null : rows, count: rows.length, ...(allQueued ? { queued: true } : {}) };
  }

  if (operation === 'update') {
    const normalizedPatch = normalizeRowTemporalValues(payload.values || {}, columns);
    if (table === 'profiles') sanitizeProfileFields(normalizedPatch);
    if (table === 'profile_links') validateProfileLinkPatch(normalizedPatch);
    const patch = encryptRowForTable(table, normalizedPatch);
    const keys = Object.keys(patch);
    for (const key of keys) identifier(key, columns);
    if (!keys.length) return { data: [], count: 0 };
    const protectedColumns = new Set(['id']);
    const protectedByTable = {
      profiles: ['id', 'created_at'], user_roles: ['user_id'], conversations: ['created_by', 'is_group', 'created_at'],
      conversation_members: ['conversation_id', 'user_id', 'role', 'joined_at'], friend_requests: ['sender_id', 'receiver_id', 'source'],
      // Receipt timestamps and thread linkage are server-managed: a sender
      // must not be able to forge read/delivered state or rewrite replies.
      // Content/edited_at/pin fields stay writable — the composer uses them.
      messages: ['conversation_id', 'sender_id', 'read_at', 'delivered_at', 'reply_to_id', 'created_at', 'is_forwarded'],
      global_messages: ['sender_id', 'reply_to_id', 'created_at'],
      announcement_messages: ['sender_id', 'reply_to_id', 'created_at'],
      message_reactions: ['message_id', 'user_id'],
      blocked_users: ['blocker_id', 'blocked_id'], pinned_conversations: ['user_id', 'conversation_id'],
      polls: ['created_by', 'conversation_id'], poll_options: ['poll_id'],
      poll_votes: ['poll_id', 'option_id', 'user_id'], notification_preferences: ['user_id'],
      notification_digest_state: ['user_id', 'channel_key'], native_push_tokens: ['user_id'],
      profile_links: ['id', 'user_id', 'created_at'], profile_friend_codes: ['id', 'user_id', 'created_at'],
    };
    for (const column of protectedByTable[table] || []) protectedColumns.add(column);
    if (keys.some((key) => protectedColumns.has(key))) throw new Error('This field cannot be changed.');
    if (MESSAGE_TABLES.has(table) && !messagePayloadAllowed(patch)) throw new Error('Message content is too large.');
    // UPDATE has no LIMIT in the policy-scoped WHERE; cap the blast radius so
    // one request cannot rewrite every row the policy happens to allow.
    const [matched] = await pool.execute(`SELECT COUNT(*) AS total FROM \`${table}\` t WHERE ${whereSql}`, whereArgs);
    if (Number(matched[0]?.total || 0) > MAX_WRITE_ROWS) throw new Error('Too many rows match this update.');
    const friendRows = table === 'friend_requests' && patch.status === 'accepted'
      ? (await pool.execute(`SELECT sender_id, receiver_id FROM \`${table}\` t WHERE ${whereSql}`, whereArgs))[0]
      : [];
    // user_roles updates need the affected user_ids up front so the cached
    // role flags can be invalidated (the UPDATE itself returns no rows).
    const roleUserIds = table === 'user_roles'
      ? (await pool.execute(`SELECT user_id FROM \`${table}\` t WHERE ${whereSql}`, whereArgs))[0].map((row) => row.user_id)
      : [];
    const [result] = await pool.execute(`UPDATE \`${table}\` t SET ${keys.map((key) => `\`${key}\` = ?`).join(', ')} WHERE ${whereSql}`, [...keys.map((key) => patch[key]), ...whereArgs]);
    if (roleUserIds.length) await invalidateUserRole(...roleUserIds);
    for (const friendship of friendRows) await ensureDirectMessage(friendship.sender_id, friendship.receiver_id);
    return { data: payload.returning ? await fetchSelection(table, requested, whereSql, whereArgs) : null, count: result.affectedRows };
  }

  if (operation === 'delete') {
    // Tables without a surrogate `id` column (composite PKs like
    // notification_preferences / notification_digest_state) delete directly
    // by the policy-scoped WHERE instead of an id IN (...) list.
    if (!columns.has('id')) {
      const [matched] = await pool.execute(`SELECT COUNT(*) AS total FROM \`${table}\` t WHERE ${whereSql}`, whereArgs);
      if (Number(matched[0]?.total || 0) > MAX_WRITE_ROWS) throw new Error('Too many rows match this delete.');
      const before = payload.returning ? await fetchSelection(table, requested, whereSql, whereArgs) : null;
      const [result] = await pool.execute(`DELETE FROM \`${table}\` AS t WHERE ${whereSql}`, whereArgs);
      return { data: before, count: result.affectedRows ?? 0 };
    }
    const realtimeColumns = ['id', 'user_id', 'conversation_id', 'message_id', 'poll_id', 'option_id', 'sender_id', 'receiver_id', 'blocker_id', 'blocked_id', 'group_id']
      .filter((column) => columns.has(column));
    const [rows] = await pool.execute(`SELECT ${realtimeColumns.map((column) => `t.\`${column}\``).join(', ')} FROM \`${table}\` t WHERE ${whereSql} LIMIT ${MAX_WRITE_ROWS + 1}`, whereArgs);
    if (rows.length > MAX_WRITE_ROWS) throw new Error('Too many rows match this delete.');
    if (!rows.length) return { data: payload.returning ? [] : null, count: 0 };
    const ids = rows.map((row) => row.id);
    const before = payload.returning ? await fetchByIds(table, ids, requested, columns) : null;
    await pool.execute(`DELETE FROM \`${table}\` WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    // message_reactions.message_id is polymorphic with no FK — clean up
    // reactions for deleted messages explicitly.
    if (['messages', 'global_messages', 'announcement_messages'].includes(table)) {
      await pool.execute(`DELETE FROM message_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    if (table === 'user_roles') await invalidateUserRole(...rows.map((row) => row.user_id));
    return { data: before, count: ids.length, realtimeRows: rows };
  }
}

// --- EZMSG write-behind (REDIS_EZMSG=true) ---------------------------------
// Message inserts are pushed to a Redis list and persisted by a drain worker
// instead of hitting MariaDB inside the request. Opt-in only; when disabled
// or Redis is unavailable every path below is skipped and inserts stay direct.
// Disabled on Vercel: serverless instances freeze after the response, so the
// unref'd drain timers would never run and queued messages would stall.
const EZMSG_ENABLED = process.env.REDIS_EZMSG === 'true' && !process.env.VERCEL;
const EZMSG_DRAIN_BATCH = 200;
const EZMSG_DRAIN_BUDGET_MS = 4000;
// Transient failures retry with exponential backoff (1s → 2s → 5s → 15s →
// 60s cap) up to this many attempts before dead-lettering.
const EZMSG_MAX_ATTEMPTS = 8;
const EZMSG_RETRY_DELAYS_MS = [1000, 2000, 5000, 15000, 60000];

let ezmsgDraining = false;
let ezmsgDrainTimer = null;
let ezmsgRecovered = false;

function ezmsgResponseRow(table, row, columns, requested) {
  // Shape a queued row like fetchByIds would return: every column present,
  // NULL defaults, then the queued values on top.
  const shaped = Object.fromEntries([...columns.keys()].map((column) => [column, null]));
  Object.assign(shaped, row);
  if (requested !== '*') {
    const wanted = new Set(String(requested).split(',').map((part) => part.trim().replace(/^`|`$/g, '')));
    return Object.fromEntries(Object.entries(shaped).filter(([key]) => wanted.has(key)));
  }
  return shaped;
}

async function ezmsgEnqueue(table, normalizedRow, sourceRow, userId, columns, requested) {
  const now = new Date().toISOString().slice(0, 23).replace('T', ' ');
  const queuedRow = { ...normalizedRow };
  if (columns.has('created_at') && queuedRow.created_at == null) queuedRow.created_at = now;
  if (columns.has('updated_at') && queuedRow.updated_at == null) queuedRow.updated_at = now;
  const pushed = await ezmsgPush({
    v: 1,
    table,
    row: queuedRow,
    actorId: userId,
    queuedAt: Date.now(),
  });
  if (!pushed) return null;
  scheduleEzmsgDrain();
  return { response: ezmsgResponseRow(table, queuedRow, columns, requested), plain: sourceRow };
}

function scheduleEzmsgDrain(delay = 0) {
  if (!EZMSG_ENABLED || ezmsgDrainTimer) return;
  ezmsgDrainTimer = setTimeout(() => {
    ezmsgDrainTimer = null;
    void drainEzmsgQueue();
  }, delay);
  ezmsgDrainTimer.unref?.();
}

async function insertQueuedRow(item) {
  const { table, row, actorId } = item;
  const columns = await columnsFor(table);
  const storedRow = encryptRowForTable(table, normalizeRowTemporalValues(row, columns));
  const keys = Object.keys(storedRow);
  for (const key of keys) identifier(key, columns);
  if (!keys.length) throw new Error('Queued message row is empty.');
  try {
    await pool.execute(
      `INSERT INTO \`${table}\` (${keys.map((key) => `\`${key}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((key) => storedRow[key]),
    );
  } catch (error) {
    // Message ids are client-generated UUIDs, so a duplicate key means a
    // previous drain already persisted this exact row (crash between insert
    // and ack, or a retry overlap). Ack without re-publishing or re-notifying —
    // the first successful insert already did both.
    if (error?.code === 'ER_DUP_ENTRY') return { duplicate: true };
    throw error;
  }
  void notifyNewMessage(table, row).catch((error) => console.error('Notification delivery failed:', error));
  return { table, row, actorId };
}

async function drainEzmsgQueue() {
  if (ezmsgDraining) return;
  ezmsgDraining = true;
  try {
    if (!ezmsgRecovered) {
      ezmsgRecovered = true;
      await ezmsgRecover();
    }
    // Parked retries whose backoff expired go back onto the queue (tail = pop
    // side) before new work is drained.
    await ezmsgMoveDueRetries(EZMSG_DRAIN_BATCH);
    const deadline = Date.now() + EZMSG_DRAIN_BUDGET_MS;
    let processed = 0;
    const changesByActor = new Map();
    const touchedTables = new Set();
    while (processed < EZMSG_DRAIN_BATCH && Date.now() < deadline) {
      const raw = await ezmsgPop();
      if (!raw) break;
      let item = null;
      try { item = JSON.parse(raw); } catch { /* corrupt entry */ }
      if (!item || typeof item.table !== 'string' || !MESSAGE_TABLES.has(item.table) || !item.row || typeof item.row !== 'object') {
        await ezmsgAck(raw);
        continue;
      }
      try {
        const change = await insertQueuedRow(item);
        await ezmsgAck(raw);
        processed += 1;
        // Duplicate-key recovery: the row is already persisted, so skip the
        // realtime publish and notification fan-out the first insert ran.
        if (change?.duplicate) continue;
        touchedTables.add(item.table);
        const list = changesByActor.get(item.actorId) || [];
        list.push({
          table: item.table,
          operation: 'insert',
          eventType: 'INSERT',
          values: item.row,
          data: item.row,
        });
        changesByActor.set(item.actorId, list);
      } catch (error) {
        const attempts = (Number(item.attempts) || 0) + 1;
        const annotated = { ...item, attempts, lastError: String(error?.message || error) };
        console.error(`EZMSG drain failed for ${item.table} row ${item.row?.id} (attempt ${attempts}):`, error);
        if (isTransientQueueError(error) && attempts < EZMSG_MAX_ATTEMPTS) {
          annotated.notBefore = Date.now() + EZMSG_RETRY_DELAYS_MS[Math.min(attempts - 1, EZMSG_RETRY_DELAYS_MS.length - 1)];
          // If the delayed set is unavailable, fall back to an immediate
          // requeue so the message is never dropped; the ack below may also
          // no-op while Redis is down, leaving the item in processing for
          // ezmsgRecover — the idempotent insert makes either path safe.
          if (!await ezmsgScheduleRetry(annotated)) await ezmsgPush(annotated);
        } else {
          await ezmsgMarkFailed(annotated, error);
        }
        await ezmsgAck(raw);
      }
    }
    for (const table of touchedTables) await invalidateReadCache(table);
    for (const [actorId, changes] of changesByActor) {
      await publishMariaDbChanges(changes, actorId).catch((error) => console.error('EZMSG realtime publish failed:', error));
    }
    // If we hit the batch/budget cap the queue may still have items — keep draining.
    if (processed >= EZMSG_DRAIN_BATCH) scheduleEzmsgDrain(10);
  } finally {
    ezmsgDraining = false;
  }
}

if (EZMSG_ENABLED) {
  // Safety net: drain anything left behind by a restart or a missed trigger.
  setInterval(() => scheduleEzmsgDrain(), 1000).unref();
}

// Merge still-queued (not yet drained) message rows into select results so a
// client refetching right after sending sees its own message. Only applies to
// the chat-history shape: message tables filtered by conversation_id eq, or
// the public tables where every queued row is visible anyway.
async function mergeQueuedSelect(table, payload, result) {
  if (!EZMSG_ENABLED || !MESSAGE_TABLES.has(table) || !Array.isArray(result?.data)) return result;
  const pending = await ezmsgPending(500);
  const relevant = pending.filter((item) => item.table === table);
  if (!relevant.length) return result;
  const convEq = (payload.filters || []).find((filter) => filter?.column === 'conversation_id' && filter?.op === 'eq');
  const columns = await columnsFor(table);
  const wanted = payload.columns && String(payload.columns).trim() !== '*'
    ? new Set(String(payload.columns).split(',').map((part) => part.trim()))
    : null;
  const rows = relevant
    .filter((item) => table !== 'messages' || (convEq && item.row.conversation_id === convEq.value))
    .map((item) => {
      const shaped = ezmsgResponseRow(table, item.row, columns, wanted ? [...wanted].join(',') : '*');
      return wanted ? Object.fromEntries(Object.entries(shaped).filter(([key]) => wanted.has(key))) : shaped;
    });
  if (!rows.length) return result;
  const seen = new Set(result.data.map((entry) => entry?.id));
  const fresh = rows.filter((entry) => entry?.id && !seen.has(entry.id));
  if (!fresh.length) return result;
  const orderColumn = payload.order?.[0]?.column || 'created_at';
  const descending = payload.order?.[0]?.ascending === false;
  result.data = [...result.data, ...fresh].sort((a, b) => {
    const av = String(a?.[orderColumn] ?? '');
    const bv = String(b?.[orderColumn] ?? '');
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return descending ? -cmp : cmp;
  });
  if (typeof result.count === 'number') result.count += fresh.length;
  return result;
}

export async function queryData(userId, payload) {
  const table = payload?.table;
  const operation = payload?.operation || 'select';
  // Decryption happens after the Redis read cache so cached payloads only ever
  // contain ciphertext, never plaintext message content.
  const withDecryptedData = (result) => {
    if (result && result.data != null) result.data = decryptRowsForTable(table, result.data);
    return result;
  };
  if (operation === 'select') {
    return cachedRead(userId, table, payload, () => queryDataUncached(userId, payload))
      .then(withDecryptedData)
      .then((result) => mergeQueuedSelect(table, payload, result));
  }
  const result = await queryDataUncached(userId, payload);
  if (result?.count > 0) await invalidateReadCache(table);
  return withDecryptedData(result);
}

// Client composer caps at 2000 chars; the API allows headroom for API/other
// clients but must never accept unbounded LONGTEXT payloads.
const MAX_MESSAGE_CONTENT = 8000;
const MAX_MESSAGE_MEDIA_META = 65535;
const MAX_WRITE_ROWS = 200;
const MESSAGE_TABLES = new Set(['messages', 'global_messages', 'announcement_messages']);

function messagePayloadAllowed(row) {
  if (typeof row.content === 'string' && row.content.length > MAX_MESSAGE_CONTENT) return false;
  if (typeof row.image_url === 'string' && row.image_url.length > MAX_MESSAGE_MEDIA_META) return false;
  return true;
}

// --- Profile customization validation (1.2.8) --------------------------------
// Social/profile fields are public, so the API is the trust boundary: status
// modes, JSON payloads, and link rows are normalized or rejected here rather
// than trusted from the client.

const PROFILE_STATUS_MODES = new Set(['online', 'idle', 'do_not_disturb']);
const PROFILE_BANNER_MEDIA_KINDS = new Set(['image', 'video']);
const MAX_BANNER_MEDIA_DURATION_MS = 10_000;
const PROFILE_LAYOUT_SECTIONS = new Set(['bio', 'banner', 'links', 'interests', 'languages', 'song', 'custom_status', 'badges']);
const MAX_PROFILE_INTERESTS = 10;
const MAX_PROFILE_INTEREST_LENGTH = 32;
const MAX_PROFILE_LANGUAGES = 10;
const MAX_PROFILE_LANGUAGE_LABEL = 40;
const MAX_PROFILE_LANGUAGE_CODE = 8;
const MAX_PROFILE_SONG_URL = 2048;
const MAX_PROFILE_LINKS = 10;
const FRIEND_REQUEST_SOURCES = new Set(['search', 'qr', 'link']);

function parseJsonField(value, label) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error(`Invalid ${label}.`); }
  }
  return value;
}

function isHttpsUrl(value, maxLength = MAX_PROFILE_SONG_URL) {
  return typeof value === 'string' && value.length <= maxLength && /^https:\/\//i.test(value);
}

// Mutates `row` in place, replacing raw client values with normalized ones.
// Throws on anything outside the whitelist so bad payloads never reach SQL.
function sanitizeProfileFields(row) {
  if ('status_mode' in row) {
    if (!PROFILE_STATUS_MODES.has(row.status_mode)) throw new Error('Invalid status mode.');
  }
  if ('banner_media_kind' in row) {
    if (!PROFILE_BANNER_MEDIA_KINDS.has(row.banner_media_kind)) throw new Error('Invalid banner media kind.');
  }
  if ('banner_media_duration_ms' in row) {
    const duration = row.banner_media_duration_ms;
    if (duration != null) {
      const parsed = Number(duration);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_BANNER_MEDIA_DURATION_MS) {
        throw new Error('Invalid banner media duration.');
      }
      row.banner_media_duration_ms = parsed;
    }
  }
  if ('interests' in row) {
    const value = parseJsonField(row.interests, 'interests');
    if (value == null) { row.interests = null; }
    else {
      if (!Array.isArray(value)) throw new Error('Interests must be a list.');
      const tags = [...new Set(value.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean))];
      if (tags.length > MAX_PROFILE_INTERESTS || tags.some((tag) => tag.length > MAX_PROFILE_INTEREST_LENGTH)) {
        throw new Error('Too many or invalid interests.');
      }
      row.interests = JSON.stringify(tags);
    }
  }
  if ('languages_spoken' in row) {
    const value = parseJsonField(row.languages_spoken, 'languages');
    if (value == null) { row.languages_spoken = null; }
    else {
      if (!Array.isArray(value)) throw new Error('Languages must be a list.');
      const languages = value.map((entry) => {
        if (typeof entry === 'string') {
          const label = entry.trim();
          if (!label || label.length > MAX_PROFILE_LANGUAGE_LABEL) throw new Error('Invalid language entry.');
          return { code: '', label };
        }
        const label = String(entry?.label ?? '').trim();
        const code = String(entry?.code ?? '').trim().toLowerCase();
        if (!label || label.length > MAX_PROFILE_LANGUAGE_LABEL || code.length > MAX_PROFILE_LANGUAGE_CODE || !/^[a-z0-9-]*$/.test(code)) {
          throw new Error('Invalid language entry.');
        }
        return { code, label };
      });
      if (languages.length > MAX_PROFILE_LANGUAGES) throw new Error('Too many languages.');
      row.languages_spoken = JSON.stringify(languages);
    }
  }
  if ('profile_song' in row) {
    const value = parseJsonField(row.profile_song, 'profile song');
    if (value == null) { row.profile_song = null; }
    else {
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile song.');
      const title = String(value.title ?? '').trim();
      const artist = String(value.artist ?? '').trim();
      const url = String(value.url ?? '').trim();
      const artworkUrl = value.artwork_url == null ? null : String(value.artwork_url).trim();
      if (!title || title.length > 200 || artist.length > 200 || !isHttpsUrl(url) || (artworkUrl && !isHttpsUrl(artworkUrl))) {
        throw new Error('Invalid profile song.');
      }
      row.profile_song = JSON.stringify({ title, artist, url, ...(artworkUrl ? { artwork_url: artworkUrl } : {}) });
    }
  }
  if ('profile_layout' in row) {
    const value = parseJsonField(row.profile_layout, 'profile layout');
    if (value == null) { row.profile_layout = null; }
    else {
      if (!Array.isArray(value)) throw new Error('Invalid profile layout.');
      const sections = [...new Set(value.map((entry) => String(entry)))];
      if (sections.length > PROFILE_LAYOUT_SECTIONS.size || sections.some((section) => !PROFILE_LAYOUT_SECTIONS.has(section))) {
        throw new Error('Invalid profile layout.');
      }
      row.profile_layout = JSON.stringify(sections);
    }
  }
}

function isValidProfileLink(row) {
  const label = String(row.label ?? '').trim();
  const url = String(row.url ?? '').trim();
  const position = Number(row.position ?? 0);
  return label.length > 0 && label.length <= 80
    && url.length <= 2048 && /^https?:\/\//i.test(url)
    && Number.isInteger(position) && position >= 0 && position <= 1000;
}

// Update patches are partial — validate only the fields being changed.
function validateProfileLinkPatch(patch) {
  if ('label' in patch) {
    const label = String(patch.label ?? '').trim();
    if (!label || label.length > 80) throw new Error('Invalid link label.');
    patch.label = label;
  }
  if ('url' in patch) {
    const url = String(patch.url ?? '').trim();
    if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) throw new Error('Links must be http(s) URLs.');
    patch.url = url;
  }
  if ('position' in patch) {
    const position = Number(patch.position);
    if (!Number.isInteger(position) || position < 0 || position > 1000) throw new Error('Invalid link position.');
    patch.position = position;
  }
}

async function canInsert(table, row, userId, access) {
  const admin = await isAdmin(userId);
  if (MESSAGE_TABLES.has(table) && !messagePayloadAllowed(row)) return false;
  if (table === 'admin_logs') return admin && row.admin_id === userId;
  if (table === 'profiles') return row.id === userId;
  if (table === 'user_roles') return await isSuperAdmin(userId) && ['user', 'admin', 'super_admin'].includes(row.role);
  if (table === 'notification_trigger_events') return false;
  if (table === 'message_reports') {
    return row.reporter_id === userId
      && ['messages', 'global_messages', 'announcement_messages'].includes(row.message_table)
      && typeof row.message_id === 'string' && row.message_id.length > 0 && row.message_id.length <= 64
      && (row.reason == null || String(row.reason).length <= 2000);
  }
  if (table === 'notification_preferences' || table === 'notification_digest_state' || table === 'native_push_tokens' || table === 'pinned_conversations') return row.user_id === userId;
  if (table === 'blocked_users') return row.blocker_id === userId && row.blocked_id !== userId;
  if (table === 'friend_requests') {
    if (row.sender_id !== userId || row.receiver_id === userId || row.status !== 'pending') return false;
    if (row.source != null && !FRIEND_REQUEST_SOURCES.has(row.source)) return false;
    const [recipient] = await pool.execute('SELECT allow_friend_requests FROM profiles WHERE id = ? LIMIT 1', [row.receiver_id]);
    if (!recipient[0]?.allow_friend_requests) return false;
    const [blocked] = await pool.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, row.receiver_id, row.receiver_id, userId]);
    return blocked.length === 0;
  }
  if (table === 'messages') {
    if (row.sender_id !== userId) return false;
    const [members] = await pool.execute(
      'SELECT c.is_group FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ? AND cm.user_id = ? LIMIT 1',
      [row.conversation_id, userId],
    );
    if (!members.length) return false;
    // 1:1 DMs enforce blocks in both directions — being in a shared
    // conversation must not let a blocked user keep messaging.
    if (!members[0].is_group) {
      const [others] = await pool.execute('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?', [row.conversation_id, userId]);
      for (const other of others) {
        const [blocked] = await pool.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, other.user_id, other.user_id, userId]);
        if (blocked.length) return false;
      }
    }
    return true;
  }
  if (table === 'global_messages') return row.sender_id === userId;
  if (table === 'announcement_messages') return admin && row.sender_id === userId;
  if (table === 'message_reactions') {
    if (row.user_id !== userId) return false;
    const [message] = await pool.execute('SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.id = ? AND cm.user_id = ? LIMIT 1', [row.message_id, userId]);
    if (message.length) return true;
    // Global chat and announcements are readable by everyone, so anyone may
    // react to their messages.
    const [publicMessage] = await pool.execute('SELECT 1 FROM global_messages WHERE id = ? UNION ALL SELECT 1 FROM announcement_messages WHERE id = ? LIMIT 1', [row.message_id, row.message_id]);
    return publicMessage.length > 0;
  }
  if (table === 'polls') {
    if (row.created_by !== userId || !['dm', 'global', 'announcement'].includes(row.channel)) return false;
    if (row.channel === 'dm') {
      const [members] = await pool.execute('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1', [row.conversation_id, userId]);
      return members.length > 0;
    }
    return row.channel !== 'announcement' || admin;
  }
  if (table === 'poll_options') {
    const [poll] = await pool.execute('SELECT created_by FROM polls WHERE id = ? LIMIT 1', [row.poll_id]);
    return poll[0]?.created_by === userId;
  }
  if (table === 'poll_votes') {
    if (row.user_id !== userId) return false;
    const [poll] = await pool.execute('SELECT p.id FROM polls p JOIN poll_options o ON o.poll_id = p.id WHERE p.id = ? AND o.id = ? AND p.closed_at IS NULL AND p.ends_at > CURRENT_TIMESTAMP(3)', [row.poll_id, row.option_id]);
    return poll.length > 0;
  }
  if (table === 'conversation_members') {
    if (row.role && row.role !== 'member') return false;
    if (admin) return true;
    if (row.user_id === userId) {
      const [created] = await pool.execute('SELECT 1 FROM conversations WHERE id = ? AND created_by = ? LIMIT 1', [row.conversation_id, userId]);
      if (created.length) return true;
    }
    const [member] = await pool.execute("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND role IN ('owner','admin') LIMIT 1", [row.conversation_id, userId]);
    return member.length > 0;
  }
  if (table === 'conversations') return row.created_by === userId;
  if (table === 'profile_links') {
    if (row.user_id !== userId || !isValidProfileLink(row)) return false;
    const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM profile_links WHERE user_id = ?', [userId]);
    return Number(countRows[0]?.total || 0) < MAX_PROFILE_LINKS;
  }
  return access.sql !== '1 = 0' && admin;
}

async function fetchSelection(table, requested, whereSql, args) {
  const [rows] = await pool.execute(`SELECT ${requested} FROM \`${table}\` t WHERE ${whereSql}`, args);
  return rows;
}

async function fetchByIds(table, ids, requested, columns) {
  if (!ids.length) return [];
  const key = columns.has('id') ? 'id' : columns.has('user_id') ? 'user_id' : null;
  if (!key) return [];
  const idColumn = identifier(key, columns);
  const [rows] = await pool.execute(`SELECT ${requested} FROM \`${table}\` WHERE ${idColumn} IN (${ids.map(() => '?').join(',')})`, ids);
  return rows;
}

async function fetchUpsertedFriendRequests(rows, requested) {
  const clauses = rows.map(() => '(sender_id = ? AND receiver_id = ?)').join(' OR ');
  const args = rows.flatMap((row) => [row.sender_id, row.receiver_id]);
  const [result] = await pool.execute(`SELECT ${requested} FROM friend_requests WHERE ${clauses}`, args);
  return result;
}
