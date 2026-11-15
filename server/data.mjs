import { randomUUID } from 'node:crypto';
import { pool, isPostgres } from './db.mjs';
import { ensureDirectMessage, friendPair } from './dm.mjs';
import { notifyNewMessage } from './notifications.mjs';
import { canPostInServerChannel, getServerMemberContext, serverChannelForConversation } from './permissions.mjs';
import { cachedRead, invalidateReadCache, redisGetJson, redisSetJson, cachedUserRoles, invalidateUserRole } from './redis.mjs';
import { decryptRowsForTable, encryptRowForTable } from './encryption.mjs';

const TABLES = new Set([
  'admin_logs', 'announcement_messages', 'blocked_users', 'conversation_members',
  'conversations', 'friend_requests', 'global_messages', 'message_reactions',
  'messages', 'native_push_tokens', 'notification_digest_state',
  'notification_preferences', 'notification_trigger_events', 'pinned_conversations',
  'poll_options', 'poll_votes', 'polls', 'profiles', 'server_bans', 'server_categories',
  'server_channels', 'server_invites', 'server_members', 'server_roles', 'servers',
  'user_roles',
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

async function serverIdsWithPermission(userId, permission) {
  const [members] = await pool.execute('SELECT server_id FROM server_members WHERE user_id = ?', [userId]);
  const ids = [];
  for (const member of members) {
    const context = await getServerMemberContext(userId, member.server_id);
    if (context?.permissions.has(permission)) ids.push(member.server_id);
  }
  return ids;
}

async function viewableServerIds(userId) {
  return serverIdsWithPermission(userId, 'view_channel');
}

function serverConversationAccessSql(serverIds, conversationColumn = 't.conversation_id') {
  if (!serverIds.length) return { sql: '1 = 0', args: [] };
  const placeholders = serverIds.map(() => '?').join(', ');
  return {
    sql: `${conversationColumn} IN (SELECT sc.conversation_id FROM server_channels sc WHERE sc.server_id IN (${placeholders}))`,
    args: serverIds,
  };
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
  if (table === 'admin_logs') return admin
    ? { sql: operation === 'insert' ? '1 = 1' : '1 = 1', args: [] }
    : { sql: '1 = 0', args: [] };
  if (table === 'profiles') return operation === 'select'
    ? { sql: '1 = 1', args: [] }
    : { sql: 'id = ?', args: [userId] };
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
    if (operation === 'insert') return { sql: `created_by = ? AND (kind IS NULL OR kind <> 'server')`, args: [userId] };
    if (operation === 'select') {
      const serverIds = await viewableServerIds(userId);
      const serverAccess = serverConversationAccessSql(serverIds, 't.id');
      if (admin) {
        return {
          sql: `(t.kind IS NULL OR t.kind <> 'server') OR (t.kind = 'server' AND ${serverAccess.sql})`,
          args: [...serverAccess.args],
        };
      }
      return {
        sql: `((t.kind IS NULL OR t.kind <> 'server') AND ${membershipExists(userId)}) OR (t.kind = 'server' AND ${serverAccess.sql})`,
        args: [userId, ...serverAccess.args],
      };
    }
    if (admin) return { sql: `t.kind <> 'server'`, args: [] };
    return { sql: `EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = t.id AND cm.user_id = ? AND cm.role IN ('owner','admin'))`, args: [userId] };
  }
  if (table === 'conversation_members') {
    const serverConversation = `EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = t.conversation_id AND sc.kind = 'server')`;
    if (operation === 'insert') {
      if (admin) return { sql: `NOT ${serverConversation}`, args: [] };
      return { sql: `(user_id = ? AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.created_by = ? AND c.kind <> 'server')) OR EXISTS (SELECT 1 FROM conversation_members mine WHERE mine.conversation_id = t.conversation_id AND mine.user_id = ? AND mine.role IN ('owner','admin'))`, args: [userId, userId, userId] };
    }
    if (operation === 'select') {
      const serverIds = await viewableServerIds(userId);
      const serverAccess = serverConversationAccessSql(serverIds, 't.conversation_id');
      if (admin) {
        return {
          sql: `(user_id = ? OR NOT ${serverConversation} OR (${serverConversation} AND ${serverAccess.sql}))`,
          args: [userId, ...serverAccess.args],
        };
      }
      return {
        sql: `(user_id = ? OR (NOT ${serverConversation} AND ${membershipExists(userId)})) OR (${serverConversation} AND ${serverAccess.sql})`,
        args: [userId, userId, ...serverAccess.args],
      };
    }
    if (admin) return { sql: `NOT ${serverConversation}`, args: [] };
    // Members may update their own row (e.g. toggling `muted`); sensitive
    // columns (role, ids, joined_at) are blocked by protectedColumns anyway.
    return { sql: `user_id = ? OR EXISTS (SELECT 1 FROM conversation_members mine WHERE mine.conversation_id = t.conversation_id AND mine.user_id = ? AND mine.role IN ('owner','admin'))`, args: [userId, userId] };
  }
  if (table === 'friend_requests') {
    if (admin) return operation === 'select' || operation === 'delete'
      ? { sql: '1 = 1', args: [] }
      : { sql: '1 = 0', args: [] };
    if (operation === 'select' || operation === 'delete') return { sql: '(sender_id = ? OR receiver_id = ?)', args: [userId, userId] };
    return { sql: '1 = 0', args: [] };
  }
  if (table === 'messages') {
    const serverConversation = `EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = t.conversation_id AND sc.kind = 'server')`;
    if (operation === 'select') {
      const serverIds = await viewableServerIds(userId);
      const serverAccess = serverConversationAccessSql(serverIds, 't.conversation_id');
      if (admin) {
        return {
          sql: `NOT ${serverConversation} OR ${serverAccess.sql}`,
          args: [...serverAccess.args],
        };
      }
      return {
        sql: `(NOT ${serverConversation} AND ${membershipExists(userId)}) OR ${serverAccess.sql}`,
        args: [userId, ...serverAccess.args],
      };
    }
    if (admin) return { sql: `(NOT ${serverConversation} OR (sender_id = ? AND ${membershipExists(userId)}))`, args: [userId, userId] };
    const serverIds = await viewableServerIds(userId);
    const serverAccess = serverConversationAccessSql(serverIds, 't.conversation_id');
    let manageSql = '1 = 0';
    const manageArgs = [];
    if (operation === 'delete') {
      const viewSet = new Set(serverIds);
      const manageIds = (await serverIdsWithPermission(userId, 'manage_messages')).filter((id) => viewSet.has(id));
      const manageAccess = serverConversationAccessSql(manageIds, 't.conversation_id');
      manageSql = manageAccess.sql;
      manageArgs.push(...manageAccess.args);
    }
    return {
      sql: `(NOT ${serverConversation} AND sender_id = ? AND ${membershipExists(userId)}) OR (sender_id = ? AND ${serverAccess.sql}) OR (${serverConversation} AND ${manageSql})`,
      args: [userId, userId, userId, ...serverAccess.args, ...manageArgs],
    };
  }
  if (table === 'message_reactions') {
    if (admin) return { sql: '1 = 1', args: [] };
    if (operation === 'select') {
      const serverIds = await viewableServerIds(userId);
      const serverAccess = serverConversationAccessSql(serverIds, 'm.conversation_id');
      const serverConversation = `EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.conversation_id AND sc.kind = 'server')`;
      // message_id is polymorphic: a reaction is visible when the target is a DM
      // or viewable server message in a conversation the user belongs to, or any
      // global/announcement message (those channels are readable by everyone).
      return {
        sql: `(EXISTS (SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.id = t.message_id AND cm.user_id = ? AND (NOT ${serverConversation} OR ${serverAccess.sql})) OR EXISTS (SELECT 1 FROM global_messages g WHERE g.id = t.message_id) OR EXISTS (SELECT 1 FROM announcement_messages a WHERE a.id = t.message_id))`,
        args: [userId, ...serverAccess.args],
      };
    }
    return { sql: 'user_id = ?', args: [userId] };
  }
  if (table === 'polls') {
    if (operation === 'select') {
      const serverIds = await viewableServerIds(userId);
      const serverAccess = serverConversationAccessSql(serverIds, 't.conversation_id');
      const serverConversation = `EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = t.conversation_id AND sc.kind = 'server')`;
      if (admin) {
        return {
          sql: `(t.conversation_id IS NULL OR NOT ${serverConversation} OR ${serverAccess.sql})`,
          args: [...serverAccess.args],
        };
      }
      return {
        sql: `(t.conversation_id IS NULL OR (NOT ${serverConversation} AND ${membershipExists(userId)}) OR ${serverAccess.sql})`,
        args: [userId, ...serverAccess.args],
      };
    }
    if (admin) return { sql: '1 = 1', args: [] };
    return { sql: 'created_by = ?', args: [userId] };
  }
  if (table === 'poll_options' || table === 'poll_votes') {
    if (admin) return { sql: '1 = 1', args: [] };
    if (table === 'poll_votes' && operation !== 'select') return { sql: 'user_id = ?', args: [userId] };
    if (operation === 'select') {
      const serverIds = await viewableServerIds(userId);
      const serverAccess = serverConversationAccessSql(serverIds, 'p.conversation_id');
      const serverConversation = `EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = p.conversation_id AND sc.kind = 'server')`;
      return {
        sql: `EXISTS (SELECT 1 FROM polls p WHERE p.id = t.poll_id AND (p.conversation_id IS NULL OR (NOT ${serverConversation} AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = p.conversation_id AND cm.user_id = ?)) OR ${serverAccess.sql})${table === 'poll_options' && operation !== 'select' ? ' AND p.created_by = ?' : ''})`,
        args: [userId, ...serverAccess.args, ...(table === 'poll_options' && operation !== 'select' ? [userId] : [])],
      };
    }
    const extra = table === 'poll_options' && operation !== 'select' ? ' AND p.created_by = ?' : '';
    return { sql: `EXISTS (SELECT 1 FROM polls p WHERE p.id = t.poll_id AND (p.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = p.conversation_id AND cm.user_id = ?))${extra})`, args: extra ? [userId, userId] : [userId] };
  }
  if (['servers', 'server_roles', 'server_members', 'server_bans', 'server_categories', 'server_channels', 'server_invites'].includes(table)) {
    if ((table === 'server_channels' || table === 'server_categories') && operation === 'select') {
      const ids = await viewableServerIds(userId);
      if (!ids.length) return { sql: '1 = 0', args: [] };
      return { sql: `t.server_id IN (${ids.map(() => '?').join(', ')})`, args: ids };
    }
    if (table === 'server_bans' && operation === 'select') {
      const ids = await serverIdsWithPermission(userId, 'ban_members');
      if (!ids.length) return { sql: '1 = 0', args: [] };
      return { sql: `t.server_id IN (${ids.map(() => '?').join(', ')})`, args: ids };
    }
    const serverColumn = table === 'servers' ? 't.id' : 't.server_id';
    if (operation === 'select') {
      return { sql: `EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = ${serverColumn} AND sm.user_id = ?)`, args: [userId] };
    }
    return { sql: '1 = 0', args: [] };
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

function filterSql(filters, columns) {
  const parts = [];
  const args = [];
  for (const filter of filters || []) {
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
        } else {
          parts.push(`${col} IS ?`);
          args.push(normalizeTemporalValue(filter.value, columns.get(filter.column)));
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
    if (!inputRows.length) return { data: [], count: 0 };
    const inserted = [];
    for (const input of inputRows) {
      const row = { ...input };
      if (columns.has('id') && !row.id) row.id = randomUUID();
      if (!await canInsert(table, row, userId, access)) throw new Error('Not allowed to insert this row.');
      if (table === 'messages' && columns.has('preview')) row.preview = messagePreview(row);
      const normalizedRow = normalizeRowTemporalValues(row, columns);
      const storedRow = encryptRowForTable(table, normalizedRow);
      const keys = Object.keys(storedRow);
      for (const key of keys) identifier(key, columns);
      if (!keys.length) throw new Error('Insert data is empty.');
      const updateKeys = operation === 'upsert' ? keys.filter((key) => key !== 'id' && key !== 'user_id') : [];
      const insertSql = `INSERT INTO \`${table}\` (${keys.map((key) => `\`${key}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})${operation === 'upsert' && updateKeys.length ? ` ON DUPLICATE KEY UPDATE ${updateKeys.map((key) => `\`${key}\` = VALUES(\`${key}\`)`).join(', ')}` : ''}`;
      const insertArgs = keys.map((key) => storedRow[key]);
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
      : await fetchByIds(table, inserted, requested, columns);
    if (['messages', 'global_messages', 'announcement_messages'].includes(table)) {
      for (const row of inputRows) void notifyNewMessage(table, row).catch((error) => console.error('Notification delivery failed:', error));
    }
    if (table === 'user_roles') await invalidateUserRole(...rows.map((row) => row.user_id));
    return { data: payload.single ? rows[0] ?? null : rows, count: rows.length };
  }

  if (operation === 'update') {
    const rawPatch = normalizeRowTemporalValues(payload.values || {}, columns);
    if (table === 'messages' && columns.has('preview') && typeof rawPatch.content === 'string') rawPatch.preview = messagePreview(rawPatch);
    const patch = encryptRowForTable(table, rawPatch);
    const keys = Object.keys(patch);
    for (const key of keys) identifier(key, columns);
    if (!keys.length) return { data: [], count: 0 };
    const protectedColumns = new Set(['id']);
    const protectedByTable = {
      profiles: ['id'], user_roles: ['user_id'], conversations: ['created_by', 'is_group', 'kind'],
      conversation_members: ['conversation_id', 'user_id', 'role', 'joined_at'], friend_requests: ['sender_id', 'receiver_id', 'user_low', 'user_high'],
      messages: ['conversation_id', 'sender_id', 'preview'], global_messages: ['sender_id'],
      announcement_messages: ['sender_id'], message_reactions: ['message_id', 'user_id'],
      blocked_users: ['blocker_id', 'blocked_id'], pinned_conversations: ['user_id', 'conversation_id'],
      polls: ['created_by', 'conversation_id'], poll_options: ['poll_id'],
      poll_votes: ['poll_id', 'option_id', 'user_id'], notification_preferences: ['user_id'],
      notification_digest_state: ['user_id', 'channel_key'], native_push_tokens: ['user_id'],
    };
    for (const column of protectedByTable[table] || []) protectedColumns.add(column);
    if (keys.some((key) => protectedColumns.has(key))) throw new Error('This field cannot be changed.');
    if (MESSAGE_TABLES.has(table) && !messagePayloadAllowed(patch)) throw new Error('Message content is too large.');
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
      const before = payload.returning ? await fetchSelection(table, requested, whereSql, whereArgs) : null;
      const [result] = await pool.execute(`DELETE FROM \`${table}\` AS t WHERE ${whereSql}`, whereArgs);
      return { data: before, count: result.affectedRows ?? 0 };
    }
    const realtimeColumns = ['id', 'user_id', 'conversation_id', 'message_id', 'poll_id', 'option_id', 'sender_id', 'receiver_id', 'blocker_id', 'blocked_id', 'group_id', 'server_id', 'role_id', 'category_id', 'channel_id']
      .filter((column) => columns.has(column));
    const [rows] = await pool.execute(`SELECT ${realtimeColumns.map((column) => `t.\`${column}\``).join(', ')} FROM \`${table}\` t WHERE ${whereSql}`, whereArgs);
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
    return cachedRead(userId, table, payload, () => queryDataUncached(userId, payload)).then(withDecryptedData);
  }
  const result = await queryDataUncached(userId, payload);
  if (result?.count > 0) await invalidateReadCache(table);
  return withDecryptedData(result);
}

// Client composer caps at 2000 chars; the API allows headroom for API/other
// clients but must never accept unbounded LONGTEXT payloads.
const MAX_MESSAGE_CONTENT = 8000;
const MAX_MESSAGE_MEDIA_META = 65535;
const MESSAGE_TABLES = new Set(['messages', 'global_messages', 'announcement_messages']);

function messagePayloadAllowed(row) {
  if (typeof row.content === 'string' && row.content.length > MAX_MESSAGE_CONTENT) return false;
  if (typeof row.image_url === 'string' && row.image_url.length > MAX_MESSAGE_MEDIA_META) return false;
  return true;
}

function messagePreview(row) {
  const content = String(row.content || '').replace(/\s+/g, ' ').trim();
  if (content.startsWith('[[poll:')) return 'Poll';
  if (content) return content.slice(0, 140);
  if (row.image_url) return '[Attachment]';
  return '';
}

async function serverChannelContext(conversationId, userId) {
  const channel = await serverChannelForConversation(conversationId);
  if (!channel) return null;
  const context = await getServerMemberContext(userId, channel.server_id);
  return { channel, context };
}

async function canInsert(table, row, userId, access) {
  const admin = await isAdmin(userId);
  if (MESSAGE_TABLES.has(table) && !messagePayloadAllowed(row)) return false;
  if (table === 'admin_logs') return admin && row.admin_id === userId;
  if (table === 'profiles') return row.id === userId;
  if (table === 'user_roles') return await isSuperAdmin(userId) && ['user', 'admin', 'super_admin'].includes(row.role);
  if (table === 'notification_trigger_events') return false;
  if (table === 'notification_preferences' || table === 'notification_digest_state' || table === 'native_push_tokens' || table === 'pinned_conversations') return row.user_id === userId;
  if (table === 'blocked_users') return row.blocker_id === userId && row.blocked_id !== userId;
  if (table === 'friend_requests') return false;
  if (table === 'messages') {
    if (row.sender_id !== userId) return false;
    const [members] = await pool.execute(
      'SELECT c.is_group, c.kind FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ? AND cm.user_id = ? LIMIT 1',
      [row.conversation_id, userId],
    );
    if (!members.length) return false;
    const channel = members[0];
    if (channel.kind === 'server') {
      const post = await canPostInServerChannel(userId, row.conversation_id, String(row.content || ''), pool, Boolean(row.image_url));
      return post.allowed;
    }
    // 1:1 DMs enforce blocks in both directions — being in a shared
    // conversation must not let a blocked user keep messaging.
    if (!channel.is_group) {
      const [others] = await pool.execute('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?', [row.conversation_id, userId]);
      for (const other of others) {
        const [blocked] = await pool.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, other.user_id, other.user_id, userId]);
        if (blocked.length) return false;
        const [low, high] = friendPair(userId, other.user_id);
        const [friendship] = await pool.execute("SELECT 1 FROM friend_requests WHERE status = 'accepted' AND user_low = ? AND user_high = ? LIMIT 1", [low, high]);
        if (!friendship.length) return false;
      }
    }
    return true;
  }
  if (table === 'global_messages') return row.sender_id === userId;
  if (table === 'announcement_messages') return admin && row.sender_id === userId;
  if (table === 'message_reactions') {
    if (row.user_id !== userId) return false;
    const [message] = await pool.execute('SELECT m.conversation_id, c.kind FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.id = ? AND cm.user_id = ? LIMIT 1', [row.message_id, userId]);
    if (message.length) {
      if (message[0].kind === 'server') {
        const server = await serverChannelContext(message[0].conversation_id, userId);
        return Boolean(server?.context?.member && server.context.permissions.has('view_channel') && server.context.permissions.has('add_reactions'));
      }
      if (message[0].kind === 'dm') {
        const [others] = await pool.execute('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1', [message[0].conversation_id, userId]);
        for (const other of others) {
          const [low, high] = friendPair(userId, other.user_id);
          const [friendship] = await pool.execute("SELECT 1 FROM friend_requests WHERE status = 'accepted' AND user_low = ? AND user_high = ? LIMIT 1", [low, high]);
          if (!friendship.length) return false;
        }
      }
      return true;
    }
    // Global chat and announcements are readable by everyone, so anyone may
    // react to their messages.
    const [publicMessage] = await pool.execute('SELECT 1 FROM global_messages WHERE id = ? UNION ALL SELECT 1 FROM announcement_messages WHERE id = ? LIMIT 1', [row.message_id, row.message_id]);
    return publicMessage.length > 0;
  }
  if (table === 'polls') {
    if (row.created_by !== userId || !['dm', 'global', 'announcement'].includes(row.channel)) return false;
    if (row.channel === 'dm') {
      const [members] = await pool.execute('SELECT c.kind FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ? AND cm.user_id = ? LIMIT 1', [row.conversation_id, userId]);
      if (!members.length) return false;
      if (members[0].kind !== 'server') return true;
      const post = await canPostInServerChannel(userId, row.conversation_id, `[[poll:${row.id || 'new'}]]`);
      if (!post.allowed || !post.context?.permissions.has('create_poll')) return false;
      return true;
    }
    return row.channel !== 'announcement' || admin;
  }
  if (table === 'poll_options') {
    const [poll] = await pool.execute('SELECT created_by FROM polls WHERE id = ? LIMIT 1', [row.poll_id]);
    return poll[0]?.created_by === userId;
  }
  if (table === 'poll_votes') {
    if (row.user_id !== userId) return false;
    const [poll] = await pool.execute('SELECT p.id, p.conversation_id, c.kind FROM polls p JOIN poll_options o ON o.poll_id = p.id LEFT JOIN conversations c ON c.id = p.conversation_id WHERE p.id = ? AND o.id = ? AND p.closed_at IS NULL AND p.ends_at > CURRENT_TIMESTAMP(3)', [row.poll_id, row.option_id]);
    if (!poll.length) return false;
    if (poll[0].conversation_id) {
      if (poll[0].kind === 'server') {
        const server = await serverChannelContext(poll[0].conversation_id, userId);
        return Boolean(server?.context?.member && server.context.permissions.has('view_channel'));
      }
      const [member] = await pool.execute('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1', [poll[0].conversation_id, userId]);
      return member.length > 0;
    }
    return true;
  }
  if (table === 'conversation_members') {
    const [conversation] = await pool.execute('SELECT kind FROM conversations WHERE id = ? LIMIT 1', [row.conversation_id]);
    if (conversation[0]?.kind === 'server') return false;
    if (row.role && row.role !== 'member') return false;
    if (admin) return true;
    if (row.user_id === userId) {
      const [created] = await pool.execute('SELECT 1 FROM conversations WHERE id = ? AND created_by = ? LIMIT 1', [row.conversation_id, userId]);
      if (created.length) return true;
    }
    const [member] = await pool.execute("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND role IN ('owner','admin') LIMIT 1", [row.conversation_id, userId]);
    return member.length > 0;
  }
  if (table === 'conversations') return row.created_by === userId && row.kind !== 'server';
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
