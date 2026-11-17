import { randomUUID, randomBytes } from 'node:crypto';
import { pool, readPool, isPostgres } from './db.mjs';
import { encryptField } from './encryption.mjs';
import { notifyNewMessage } from './notifications.mjs';
import { cachedUserRoles } from './redis.mjs';

// Boolean columns are BOOLEAN in PostgreSQL but tinyint(1) in MariaDB; pass
// the right JS type per dialect (mysql2 wants 0/1, node-postgres wants bool).
const boolParam = (value) => (isPostgres ? Boolean(value) : value ? 1 : 0);

// `UPDATE ... JOIN` is MariaDB-only. PostgreSQL uses UPDATE ... FROM with the
// join condition moved into WHERE; SET targets must be unqualified there.
// read=true marks read (and backfills delivered_at only when unset);
// read=false marks delivered only.
function updateMessageReceiptsSql(read) {
  if (!isPostgres) {
    const sets = read
      ? 'm.read_at = CURRENT_TIMESTAMP(3), m.delivered_at = COALESCE(m.delivered_at, CURRENT_TIMESTAMP(3))'
      : 'm.delivered_at = CURRENT_TIMESTAMP(3)';
    return `UPDATE messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id SET ${sets} WHERE m.conversation_id = ? AND cm.user_id = ? AND m.sender_id <> ? AND m.${read ? 'read_at' : 'delivered_at'} IS NULL`;
  }
  const sets = read
    ? 'read_at = NOW(), delivered_at = COALESCE(delivered_at, NOW())'
    : 'delivered_at = NOW()';
  return `UPDATE messages m SET ${sets} FROM conversation_members cm WHERE cm.conversation_id = m.conversation_id AND m.conversation_id = ? AND cm.user_id = ? AND m.sender_id <> ? AND m.${read ? 'read_at' : 'delivered_at'} IS NULL`;
}

async function adminCheck(userId, connection = pool) {
  // Inside a transaction the caller's connection must be used; outside one
  // the role flags come from the Redis-backed cache.
  if (connection === pool) return (await cachedUserRoles(userId)).admin;
  const [rows] = await connection.execute("SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('admin','super_admin') LIMIT 1", [userId]);
  return rows.length > 0;
}

async function groupRole(userId, conversationId, connection = pool) {
  const [rows] = await connection.execute('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1', [conversationId, userId]);
  return rows[0]?.role || null;
}

async function userDmList(userId) {
  const [rows] = await readPool().execute(
    `SELECT c.id AS conversation_id, other.user_id AS other_user_id,
      p.username AS other_username, p.display_name AS other_display_name,
      p.avatar_url AS other_avatar_url, p.status AS other_status,
      p.status_mode AS other_status_mode,
      p.custom_status_text AS other_custom_status_text,
      p.custom_status_emoji AS other_custom_status_emoji,
      p.custom_status_expires_at AS other_custom_status_expires_at,
      (SELECT COUNT(*) FROM messages um WHERE um.conversation_id = c.id AND um.sender_id <> ? AND um.read_at IS NULL) AS unread_count,
      COALESCE((SELECT MAX(lm.created_at) FROM messages lm WHERE lm.conversation_id = c.id), c.created_at) AS last_message_at,
      (SELECT fr.id FROM friend_requests fr WHERE fr.status = 'accepted' AND ((fr.sender_id = ? AND fr.receiver_id = other.user_id) OR (fr.sender_id = other.user_id AND fr.receiver_id = ?)) LIMIT 1) AS friend_request_id,
      EXISTS(SELECT 1 FROM pinned_conversations pc WHERE pc.user_id = ? AND pc.conversation_id = c.id) AS is_pinned,
      mine.muted AS muted
     FROM conversations c
     JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
     JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id <> ?
     JOIN profiles p ON p.id = other.user_id
     WHERE c.is_group = 0
     ORDER BY is_pinned DESC, last_message_at DESC`,
    [userId, userId, userId, userId, userId, userId],
  );
  return rows;
}

async function userGroupList(userId) {
  const [rows] = await readPool().execute(
    `SELECT c.id AS conversation_id, c.name, mine.role AS my_role,
      (SELECT COUNT(*) FROM conversation_members mc WHERE mc.conversation_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM messages um WHERE um.conversation_id = c.id AND um.sender_id <> ? AND um.read_at IS NULL) AS unread_count,
      COALESCE((SELECT MAX(lm.created_at) FROM messages lm WHERE lm.conversation_id = c.id), c.created_at) AS last_message_at,
      EXISTS(SELECT 1 FROM pinned_conversations pc WHERE pc.user_id = ? AND pc.conversation_id = c.id) AS is_pinned,
      mine.muted AS muted,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_url', p.avatar_url))
         FROM conversation_members cm JOIN profiles p ON p.id = cm.user_id WHERE cm.conversation_id = c.id) AS member_previews
     FROM conversations c JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
     WHERE c.is_group = 1
     ORDER BY is_pinned DESC, last_message_at DESC`,
    [userId, userId, userId],
  );
  return rows.map((row) => ({ ...row, member_previews: typeof row.member_previews === 'string' ? JSON.parse(row.member_previews) : row.member_previews || [] }));
}

export async function callRpc(userId, name, args = {}) {
  switch (name) {
    case 'get_user_dm_list': return userDmList(userId);
    case 'get_user_group_list': return userGroupList(userId);
    case 'get_user_role_for_admin': {
      if (!await adminCheck(userId)) throw new Error('Admin access required.');
      const [rows] = await readPool().execute('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role = \'super_admin\' DESC LIMIT 1', [args._target_user_id]);
      return rows[0]?.role ?? null;
    }
    case 'get_admin_analytics_counts': {
      if (!await adminCheck(userId)) throw new Error('Admin access required.');
      const [rows] = await readPool().query(`SELECT
        (SELECT COUNT(*) FROM conversations WHERE is_group = 0) AS totalConversations,
        (SELECT COUNT(*) FROM messages) AS totalMessages,
        (SELECT COUNT(*) FROM friend_requests WHERE status = 'accepted') AS totalFriendships,
        (SELECT COUNT(*) FROM global_messages) AS totalGlobalMessages,
        (SELECT COUNT(*) FROM announcement_messages) AS totalAnnouncements`);
      return rows[0];
    }
    case 'get_admin_daily_stats': {
      if (!await adminCheck(userId)) throw new Error('Admin access required.');
      const days = Math.min(Math.max(Number(args.days_count || 7), 1), 90);
      const [rows] = await readPool().query(`SELECT calendar.day,
        COALESCE((SELECT COUNT(*) FROM messages WHERE DATE(created_at) = calendar.day), 0) AS messages,
        COALESCE((SELECT COUNT(*) FROM global_messages WHERE DATE(created_at) = calendar.day), 0) AS global_messages,
        COALESCE((SELECT COUNT(*) FROM profiles WHERE DATE(created_at) = calendar.day), 0) AS new_users
        FROM (SELECT DATE_SUB(CURRENT_DATE(), INTERVAL seq DAY) AS day FROM (
          SELECT 0 AS seq UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16 UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20 UNION ALL SELECT 21 UNION ALL SELECT 22 UNION ALL SELECT 23 UNION ALL SELECT 24 UNION ALL SELECT 25 UNION ALL SELECT 26 UNION ALL SELECT 27 UNION ALL SELECT 28 UNION ALL SELECT 29 UNION ALL SELECT 30 UNION ALL SELECT 31 UNION ALL SELECT 32 UNION ALL SELECT 33 UNION ALL SELECT 34 UNION ALL SELECT 35 UNION ALL SELECT 36 UNION ALL SELECT 37 UNION ALL SELECT 38 UNION ALL SELECT 39 UNION ALL SELECT 40 UNION ALL SELECT 41 UNION ALL SELECT 42 UNION ALL SELECT 43 UNION ALL SELECT 44 UNION ALL SELECT 45 UNION ALL SELECT 46 UNION ALL SELECT 47 UNION ALL SELECT 48 UNION ALL SELECT 49 UNION ALL SELECT 50 UNION ALL SELECT 51 UNION ALL SELECT 52 UNION ALL SELECT 53 UNION ALL SELECT 54 UNION ALL SELECT 55 UNION ALL SELECT 56 UNION ALL SELECT 57 UNION ALL SELECT 58 UNION ALL SELECT 59 UNION ALL SELECT 60 UNION ALL SELECT 61 UNION ALL SELECT 62 UNION ALL SELECT 63 UNION ALL SELECT 64 UNION ALL SELECT 65 UNION ALL SELECT 66 UNION ALL SELECT 67 UNION ALL SELECT 68 UNION ALL SELECT 69 UNION ALL SELECT 70 UNION ALL SELECT 71 UNION ALL SELECT 72 UNION ALL SELECT 73 UNION ALL SELECT 74 UNION ALL SELECT 75 UNION ALL SELECT 76 UNION ALL SELECT 77 UNION ALL SELECT 78 UNION ALL SELECT 79 UNION ALL SELECT 80 UNION ALL SELECT 81 UNION ALL SELECT 82 UNION ALL SELECT 83 UNION ALL SELECT 84 UNION ALL SELECT 85 UNION ALL SELECT 86 UNION ALL SELECT 87 UNION ALL SELECT 88 UNION ALL SELECT 89 UNION ALL SELECT 90
        ) seqs WHERE seq < ${days}) calendar ORDER BY calendar.day`);
      return rows;
    }
    case 'get_admin_top_users': {
      if (!await adminCheck(userId)) throw new Error('Admin access required.');
      const limit = Math.min(Math.max(Number(args.limit_count || 10), 1), 100);
      const [rows] = await readPool().execute(`SELECT p.id, p.username, p.display_name, p.avatar_url,
        COALESCE(m.message_count, 0) + COALESCE(gm.message_count, 0) AS message_count
        FROM profiles p
        LEFT JOIN (SELECT sender_id, COUNT(*) AS message_count FROM messages GROUP BY sender_id) m ON m.sender_id = p.id
        LEFT JOIN (SELECT sender_id, COUNT(*) AS message_count FROM global_messages GROUP BY sender_id) gm ON gm.sender_id = p.id
        ORDER BY message_count DESC LIMIT ?`, [limit]);
      return rows;
    }
    case 'get_or_create_dm': return getOrCreateDm(userId, args._other_user_id);
    case 'create_group_chat': return createGroupChat(userId, args._name, args._member_ids || []);
    case 'rename_group': return renameGroup(userId, args._conv, args._name);
    case 'add_group_members': return addGroupMembers(userId, args._conv, args._user_ids || []);
    case 'remove_group_member': return removeGroupMember(userId, args._conv, args._user_id);
    case 'set_member_role': return setMemberRole(userId, args._conv, args._user_id, args._role);
    case 'transfer_group_ownership': return transferOwnership(userId, args._conv, args._new_owner);
    case 'leave_group': return leaveGroup(userId, args._conv);
    case 'mark_message_read': return markMessage(userId, args._message_id, 'read_at');
    case 'mark_message_delivered': return markMessage(userId, args._message_id, 'delivered_at');
    case 'mark_conversation_read': {
      const [result] = await pool.execute(
        updateMessageReceiptsSql(true),
        [args._conversation_id, userId, userId],
      );
      return result.affectedRows;
    }
    case 'mark_conversation_delivered': {
      const [result] = await pool.execute(updateMessageReceiptsSql(false), [args._conversation_id, userId, userId]);
      return result.affectedRows;
    }
    case 'mark_global_mentions_read': {
      await pool.execute('UPDATE profiles SET global_mentions_last_read_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [userId]);
      return null;
    }
    case 'create_poll': return createPoll(userId, args);
    case 'finalize_poll': {
      await pool.execute('UPDATE polls SET closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND (created_by = ? OR ends_at <= CURRENT_TIMESTAMP(3) OR ? = 1)', [args._poll_id, userId, await adminCheck(userId) ? 1 : 0]);
      const [rows] = await pool.execute('SELECT closed_at FROM polls WHERE id = ?', [args._poll_id]);
      return rows[0]?.closed_at ?? null;
    }
    case 'get_my_friend_code': return getOrCreateFriendCode(userId);
    case 'rotate_friend_code': return rotateFriendCode(userId);
    case 'set_friend_code_auto_accept': return setFriendCodeAutoAccept(userId, args._enabled);
    case 'revoke_friend_code': return revokeFriendCode(userId);
    case 'redeem_friend_code': return redeemFriendCode(userId, args._code);
    case 'get_user_sessions':
    case 'revoke_user_session':
      throw new Error('Session management is not available through the data RPC API.');
    default: throw new Error(`Unsupported database action: ${name}`);
  }
}

// Creates a poll, its options, and the marker message in one transaction so
// poll creation is a single API round trip instead of 4-5 sequential calls.
// Channel rules mirror data.mjs canInsert: dm requires membership, global is
// open to everyone, announcement requires an admin role.
async function createPoll(userId, args = {}) {
  const channel = String(args._channel || '');
  const question = String(args._question || '').trim();
  const options = (Array.isArray(args._options) ? args._options : [])
    .map((option) => String(option ?? '').trim())
    .filter(Boolean);
  const endsAt = new Date(args._ends_at);
  const conversationId = channel === 'dm' ? String(args._conversation_id || '') : null;
  if (!['dm', 'global', 'announcement'].includes(channel)) throw new Error('Invalid poll channel.');
  if (channel === 'dm' && !conversationId) throw new Error('A conversation is required for direct-message polls.');
  if (!question || question.length > 300) throw new Error('Poll question is required (300 characters max).');
  if (options.length < 2 || options.length > 10) throw new Error('Polls need between 2 and 10 options.');
  if (options.some((option) => option.length > 150)) throw new Error('Poll options must be 150 characters or fewer.');
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now() + 60_000) {
    throw new Error('Poll end time must be at least a minute in the future.');
  }

  const connection = await pool.getConnection();
  const pollId = randomUUID();
  const messageId = randomUUID();
  const messageTable = channel === 'dm' ? 'messages' : channel === 'announcement' ? 'announcement_messages' : 'global_messages';
  // DATETIME(3) columns are stored/read in UTC; format matches mysql2 output.
  const endsAtDb = endsAt.toISOString().slice(0, 23).replace('T', ' ');
  try {
    await connection.beginTransaction();
    if (channel === 'dm') {
      const [members] = await connection.execute(
        'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1',
        [conversationId, userId],
      );
      if (!members.length) throw new Error('You are not a member of this conversation.');
    } else if (channel === 'announcement' && !await adminCheck(userId, connection)) {
      throw new Error('Admin access required.');
    }
    await connection.execute(
      'INSERT INTO polls (id, channel, conversation_id, created_by, question, multiple_choice, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [pollId, channel, conversationId, userId, encryptField(question), boolParam(args._multiple_choice), endsAtDb],
    );
    for (const [position, text] of options.entries()) {
      await connection.execute(
        'INSERT INTO poll_options (id, poll_id, text, position) VALUES (?, ?, ?, ?)',
        [randomUUID(), pollId, text, position],
      );
    }
    const marker = `[[poll:${pollId}]]`;
    if (channel === 'dm') {
      await connection.execute(
        'INSERT INTO messages (id, conversation_id, sender_id, content) VALUES (?, ?, ?, ?)',
        [messageId, conversationId, userId, encryptField(marker)],
      );
    } else {
      await connection.execute(
        `INSERT INTO ${messageTable} (id, sender_id, content) VALUES (?, ?, ?)`,
        [messageId, userId, encryptField(marker)],
      );
    }
    await connection.execute('UPDATE polls SET message_id = ? WHERE id = ?', [messageId, pollId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // Fire-and-forget, same as the data-API insert path. Plaintext marker keeps
  // notification bodies identical to client-created polls.
  const notificationRow = { id: messageId, conversation_id: conversationId, sender_id: userId, content: `[[poll:${pollId}]]` };
  void notifyNewMessage(messageTable, notificationRow).catch((error) => console.error('Poll notification failed:', error));
  // `message` mirrors what the data-API insert path returns so realtime
  // broadcasts carry the same record shape (plaintext marker, as decrypted
  // reads produce for clients).
  return {
    poll_id: pollId,
    message_id: messageId,
    message: { ...notificationRow, table: messageTable },
  };
}

export async function ensureDirectMessage(userId, otherId) {
  if (!otherId || otherId === userId) throw new Error('Choose another user to start a conversation.');
  const [blocked] = await pool.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, otherId, otherId, userId]);
  if (blocked.length) throw new Error('This conversation is unavailable.');
  const [friendship] = await pool.execute("SELECT id FROM friend_requests WHERE status = 'accepted' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)) LIMIT 1", [userId, otherId, otherId, userId]);
  if (!friendship.length) throw new Error('You can only message accepted friends.');
  // Fast path: an existing DM for this pair.
  const [low, high] = [userId, otherId].sort();
  const [existing] = await pool.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
  if (existing.length) return existing[0].conversation_id;
  // Atomic claim: dm_pairs' primary key guarantees exactly one concurrent
  // caller wins the insert; losers read the winner's conversation_id. The
  // conversation must exist before the pair row because dm_pairs has a FK to
  // conversations. Losers roll back their own conversation/members, so no
  // orphan rows remain.
  const id = randomUUID();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO conversations (id, is_group, created_by) VALUES (?, ?, ?)', [id, boolParam(false), userId]);
    await connection.execute('INSERT INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [randomUUID(), id, userId, 'member', randomUUID(), id, otherId, 'member']);
    const [claim] = await connection.execute(
      'INSERT IGNORE INTO dm_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)',
      [low, high, id],
    );
    if (!claim.affectedRows) {
      await connection.rollback();
      const [pair] = await connection.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
      if (!pair.length) throw new Error('Conversation creation conflicted. Please try again.');
      return pair[0].conversation_id;
    }
    await connection.commit();
    return id;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

const getOrCreateDm = ensureDirectMessage;

// --- QR friend codes ---------------------------------------------------------
// A friend code is a bearer credential embedded in the user's profile QR code.
// It is stored plaintext (like a password equivalent) so the owner can re-render
// the QR at any time; rotation and revocation are the mitigation, and redeem is
// rate-limited by the /api/rpc route's shared throttles. Auto-accept is opt-in
// per code and off by default.
const FRIEND_CODE_LENGTH = 10;
const FRIEND_CODE_ROTATE_COOLDOWN_MS = 60_000;
// Unambiguous alphabet: no 0/O, 1/I/L.
const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FRIEND_CODE_COLUMNS = 'id, code, auto_accept, created_at, rotated_at, revoked_at';

function generateFriendCode() {
  return [...randomBytes(FRIEND_CODE_LENGTH)]
    .map((byte) => FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length])
    .join('');
}

async function getOrCreateFriendCode(userId) {
  const [rows] = await pool.execute(`SELECT ${FRIEND_CODE_COLUMNS} FROM profile_friend_codes WHERE user_id = ? LIMIT 1`, [userId]);
  if (rows[0]) {
    if (rows[0].revoked_at) throw new Error('Your friend code was revoked. Generate a new one.');
    return rows[0];
  }
  try {
    await pool.execute('INSERT INTO profile_friend_codes (id, user_id, code) VALUES (?, ?, ?)', [randomUUID(), userId, generateFriendCode()]);
  } catch (error) {
    // Concurrent first-load race: the other request won the unique user_id.
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
  }
  const [created] = await pool.execute(`SELECT ${FRIEND_CODE_COLUMNS} FROM profile_friend_codes WHERE user_id = ? LIMIT 1`, [userId]);
  if (!created[0]) throw new Error('Could not create a friend code.');
  return created[0];
}

async function rotateFriendCode(userId) {
  // DATETIME(3) columns store 'YYYY-MM-DD HH:MM:SS.mmm' — match that format so
  // the comparison works identically on MariaDB and PostgreSQL.
  const cutoff = new Date(Date.now() - FRIEND_CODE_ROTATE_COOLDOWN_MS).toISOString().slice(0, 23).replace('T', ' ');
  const [rows] = await pool.execute(
    `SELECT id, COALESCE(rotated_at, created_at) > ? AS rotated_recently FROM profile_friend_codes WHERE user_id = ? LIMIT 1`,
    [cutoff, userId],
  );
  if (rows[0]?.rotated_recently) {
    throw new Error('Please wait a minute before generating a new friend code.');
  }
  const code = generateFriendCode();
  if (rows[0]) {
    await pool.execute('UPDATE profile_friend_codes SET code = ?, rotated_at = CURRENT_TIMESTAMP(3), revoked_at = NULL WHERE id = ?', [code, rows[0].id]);
  } else {
    try {
      await pool.execute('INSERT INTO profile_friend_codes (id, user_id, code) VALUES (?, ?, ?)', [randomUUID(), userId, code]);
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
      await pool.execute('UPDATE profile_friend_codes SET code = ?, rotated_at = CURRENT_TIMESTAMP(3), revoked_at = NULL WHERE user_id = ?', [code, userId]);
    }
  }
  return { code, rotated_at: new Date().toISOString() };
}

async function setFriendCodeAutoAccept(userId, enabled) {
  const [result] = await pool.execute(
    'UPDATE profile_friend_codes SET auto_accept = ? WHERE user_id = ? AND revoked_at IS NULL',
    [boolParam(enabled === true || enabled === 'true' || enabled === 1 || enabled === '1'), userId],
  );
  if (!result.affectedRows) throw new Error('Generate a friend code first.');
  return { auto_accept: Boolean(enabled === true || enabled === 'true' || enabled === 1 || enabled === '1') };
}

async function revokeFriendCode(userId) {
  const [result] = await pool.execute(
    'UPDATE profile_friend_codes SET revoked_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
  return { revoked: result.affectedRows > 0 };
}

// Redeems a scanned/shared friend code. Auto-accept codes create an accepted
// friendship directly (and the DM, matching the normal accept path); all other
// codes create a normal pending request tagged source='qr'.
async function redeemFriendCode(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!new RegExp(`^[A-Z2-9]{${FRIEND_CODE_LENGTH}}$`).test(code)) throw new Error('Invalid friend code.');
  const [codes] = await pool.execute(
    'SELECT id, user_id, auto_accept FROM profile_friend_codes WHERE code = ? AND revoked_at IS NULL LIMIT 1',
    [code],
  );
  const owner = codes[0];
  if (!owner) throw new Error('This friend code is invalid or has been revoked.');
  if (owner.user_id === userId) throw new Error('This is your own friend code.');
  const [blocked] = await pool.execute(
    'SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
    [userId, owner.user_id, owner.user_id, userId],
  );
  if (blocked.length) throw new Error('This user is unavailable.');

  const [existing] = await pool.execute(
    "SELECT id, status, sender_id, receiver_id FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) LIMIT 1",
    [userId, owner.user_id, owner.user_id, userId],
  );
  const friendship = existing[0];
  if (friendship?.status === 'accepted') {
    return { friend_request_id: friendship.id, status: 'accepted', sender_id: friendship.sender_id, receiver_id: friendship.receiver_id, other_user_id: owner.user_id, already: true };
  }
  if (friendship?.status === 'pending') {
    return { friend_request_id: friendship.id, status: 'pending', sender_id: friendship.sender_id, receiver_id: friendship.receiver_id, other_user_id: owner.user_id, already: true };
  }

  let status = 'pending';
  if (owner.auto_accept) {
    status = 'accepted';
  } else {
    const [profiles] = await pool.execute('SELECT allow_friend_requests FROM profiles WHERE id = ? LIMIT 1', [owner.user_id]);
    if (profiles[0] && !profiles[0].allow_friend_requests) {
      throw new Error('This user is not accepting friend requests.');
    }
  }

  const requestId = randomUUID();
  try {
    await pool.execute(
      "INSERT INTO friend_requests (id, sender_id, receiver_id, status, source) VALUES (?, ?, ?, ?, 'qr')",
      [requestId, userId, owner.user_id, status],
    );
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    const [rows] = await pool.execute('SELECT id, status FROM friend_requests WHERE sender_id = ? AND receiver_id = ? LIMIT 1', [userId, owner.user_id]);
    return { friend_request_id: rows[0]?.id ?? null, status: rows[0]?.status ?? 'pending', sender_id: userId, receiver_id: owner.user_id, other_user_id: owner.user_id, already: true };
  }

  if (status === 'accepted') {
    // Mirror the data-API accept path, which creates the DM on acceptance.
    await ensureDirectMessage(userId, owner.user_id).catch((error) => console.error('Friend-code DM creation failed:', error));
  }
  return { friend_request_id: requestId, status, sender_id: userId, receiver_id: owner.user_id, other_user_id: owner.user_id, already: false };
}

// Groups are capped so fan-out work (notifications, member lists, realtime
// recipient resolution) stays bounded per message.
const MAX_GROUP_MEMBERS = 500;

async function createGroupChat(userId, name, memberIds) {
  if (!String(name || '').trim()) throw new Error('Group name is required.');
  const uniqueIds = [...new Set([userId, ...memberIds])];
  if (uniqueIds.length < 2) throw new Error('A group chat needs at least one other member.');
  if (uniqueIds.length > MAX_GROUP_MEMBERS) throw new Error(`Groups are limited to ${MAX_GROUP_MEMBERS} members.`);
  const connection = await pool.getConnection();
  const id = randomUUID();
  try {
    await connection.beginTransaction();
    const [profiles] = await connection.execute(`SELECT id FROM profiles WHERE id IN (${uniqueIds.map(() => '?').join(',')})`, uniqueIds);
    if (profiles.length !== uniqueIds.length) throw new Error('One or more group members do not exist.');
    for (const memberId of uniqueIds.filter((id) => id !== userId)) {
      const [friendship] = await connection.execute("SELECT 1 FROM friend_requests WHERE status = 'accepted' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)) LIMIT 1", [userId, memberId, memberId, userId]);
      if (!friendship.length) throw new Error('You can only add accepted friends to a group.');
      const [blocked] = await connection.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, memberId, memberId, userId]);
      if (blocked.length) throw new Error('A selected group member is unavailable.');
    }
    await connection.execute('INSERT INTO conversations (id, is_group, name, created_by) VALUES (?, ?, ?, ?)', [id, boolParam(true), String(name).trim(), userId]);
    for (const member of uniqueIds) await connection.execute('INSERT INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), id, member, member === userId ? 'owner' : 'member']);
    await connection.commit();
    return id;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function requireGroupAdmin(userId, conv, connection = pool) {
  const role = await groupRole(userId, conv, connection);
  if (!['owner', 'admin'].includes(role)) throw new Error('Group admin access required.');
  return role;
}

async function renameGroup(userId, conv, name) {
  await requireGroupAdmin(userId, conv);
  await pool.execute('UPDATE conversations SET name = ? WHERE id = ? AND is_group = 1', [String(name).trim(), conv]);
  return null;
}

async function addGroupMembers(userId, conv, userIds) {
  await requireGroupAdmin(userId, conv);
  const [existingRows] = await pool.execute('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [conv]);
  const existing = new Set(existingRows.map((row) => row.user_id));
  const additions = [...new Set(userIds)].filter((id) => id !== userId && !existing.has(id));
  if (existing.size + additions.length > MAX_GROUP_MEMBERS) {
    throw new Error(`Groups are limited to ${MAX_GROUP_MEMBERS} members.`);
  }
  for (const member of additions) {
    const [friendship] = await pool.execute("SELECT 1 FROM friend_requests WHERE status = 'accepted' AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)) LIMIT 1", [userId, member, member, userId]);
    if (!friendship.length) throw new Error('You can only add accepted friends to a group.');
    const [blocked] = await pool.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, member, member, userId]);
    if (blocked.length) throw new Error('A selected group member is unavailable.');
    await pool.execute('INSERT IGNORE INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, \'member\')', [randomUUID(), conv, member]);
  }
  return null;
}

async function removeGroupMember(userId, conv, targetId) {
  const role = await requireGroupAdmin(userId, conv);
  if (targetId === userId && role === 'owner') throw new Error('Transfer ownership before leaving the group.');
  if (await groupRole(targetId, conv) === 'owner') throw new Error('Transfer ownership before removing the owner.');
  await pool.execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conv, targetId]);
  return null;
}

async function setMemberRole(userId, conv, targetId, role) {
  const actorRole = await requireGroupAdmin(userId, conv);
  if (actorRole !== 'owner') throw new Error('Only the group owner can change roles.');
  if (!['admin', 'member'].includes(role)) throw new Error('Invalid group role.');
  await pool.execute('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ? AND role <> \'owner\'', [role, conv, targetId]);
  return null;
}

async function transferOwnership(userId, conv, targetId) {
  const actorRole = await requireGroupAdmin(userId, conv);
  if (actorRole !== 'owner') throw new Error('Only the group owner can transfer ownership.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [target] = await connection.execute('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ? FOR UPDATE', [conv, targetId]);
    if (!target.length) throw new Error('The new owner must be a group member.');
    await connection.execute("UPDATE conversation_members SET role = 'admin' WHERE conversation_id = ? AND user_id = ?", [conv, userId]);
    await connection.execute("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", [conv, targetId]);
    await connection.commit();
    return null;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function leaveGroup(userId, conv) {
  const role = await groupRole(userId, conv);
  if (role === 'owner') {
    // A sole-member group would be orphaned forever — let the owner delete it.
    const [members] = await pool.execute('SELECT COUNT(*) AS total FROM conversation_members WHERE conversation_id = ?', [conv]);
    if (Number(members[0]?.total || 0) > 1) throw new Error('Transfer ownership before leaving the group.');
    await pool.execute('DELETE FROM conversations WHERE id = ?', [conv]);
    return null;
  }
  await pool.execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conv, userId]);
  return null;
}

async function markMessage(userId, messageId, column) {
  const sql = isPostgres
    ? `UPDATE messages m SET ${column} = NOW() FROM conversation_members cm WHERE cm.conversation_id = m.conversation_id AND m.id = ? AND cm.user_id = ? AND m.sender_id <> ?`
    : `UPDATE messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id SET m.${column} = CURRENT_TIMESTAMP(3) WHERE m.id = ? AND cm.user_id = ? AND m.sender_id <> ?`;
  const [result] = await pool.execute(sql, [messageId, userId, userId]);
  return result.affectedRows;
}
