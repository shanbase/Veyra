import { randomUUID } from 'node:crypto';
import { pool, isPostgres } from './db.mjs';
import { friendPair } from './dm.mjs';
import { consumeRateLimit } from './redis.mjs';

const boolParam = (value) => (isPostgres ? Boolean(value) : value ? 1 : 0);

function pairArgs(userId, otherId) {
  const [low, high] = friendPair(userId, otherId);
  return [low, high];
}

async function findFriendship(userId, otherId, connection = pool) {
  const [low, high] = pairArgs(userId, otherId);
  const [rows] = await connection.execute(
    'SELECT * FROM friend_requests WHERE user_low = ? AND user_high = ? LIMIT 1',
    [low, high],
  );
  return rows[0] || null;
}

async function findFriendshipById(userId, friendshipId, connection = pool) {
  const [rows] = await connection.execute(
    'SELECT * FROM friend_requests WHERE id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1',
    [friendshipId, userId, userId],
  );
  return rows[0] || null;
}

function otherUserId(row, userId) {
  return row.sender_id === userId ? row.receiver_id : row.sender_id;
}

function resolveTarget(args = {}) {
  const otherId = String(args._other_id || args._other_user_id || '').trim();
  const username = String(args._username || args._other_username || '').trim();
  return { otherId, username };
}

async function targetProfile(userId, args = {}) {
  const { otherId, username } = resolveTarget(args);
  if (otherId) {
    if (otherId === userId) throw new Error("You can't add yourself.");
    const [rows] = await pool.execute('SELECT id, username, display_name, avatar_url, allow_friend_requests FROM profiles WHERE id = ? LIMIT 1', [otherId]);
    if (!rows.length) throw new Error('User not found.');
    return rows[0];
  }
  if (!username) throw new Error('Enter a username or user id.');
  const [rows] = await pool.execute('SELECT id, username, display_name, avatar_url, allow_friend_requests FROM profiles WHERE LOWER(username) = LOWER(?) LIMIT 1', [username]);
  if (!rows.length) throw new Error('User not found.');
  if (rows[0].id === userId) throw new Error("You can't add yourself.");
  return rows[0];
}

export async function getFriends(userId) {
  const [rows] = await pool.execute(
    `SELECT fr.id AS friendship_id,
       p.id AS id, p.id AS user_id, p.username, p.display_name, p.avatar_url, p.status,
       p.custom_status_text, p.custom_status_emoji, p.custom_status_expires_at,
       dp.conversation_id,
       COALESCE((SELECT COUNT(*) FROM messages um
         WHERE um.conversation_id = dp.conversation_id AND um.sender_id <> ? AND um.read_at IS NULL), 0) AS unread_count,
       COALESCE((SELECT MAX(lm.created_at) FROM messages lm WHERE lm.conversation_id = dp.conversation_id), c.created_at) AS last_message_at,
       (SELECT pm.preview FROM messages pm WHERE pm.conversation_id = dp.conversation_id ORDER BY pm.created_at DESC LIMIT 1) AS last_message_preview,
       EXISTS(SELECT 1 FROM pinned_conversations pc WHERE pc.user_id = ? AND pc.conversation_id = dp.conversation_id) AS is_pinned,
       COALESCE(cm.muted, FALSE) AS muted
     FROM friend_requests fr
     JOIN profiles p ON p.id = CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END
     LEFT JOIN dm_pairs dp ON dp.user_low = fr.user_low AND dp.user_high = fr.user_high
     LEFT JOIN conversations c ON c.id = dp.conversation_id
     LEFT JOIN conversation_members cm ON cm.conversation_id = dp.conversation_id AND cm.user_id = ?
     WHERE fr.status = 'accepted' AND (fr.user_low = ? OR fr.user_high = ?)
     ORDER BY COALESCE(NULLIF(p.display_name, ''), p.username) ASC`,
    [userId, userId, userId, userId, userId, userId],
  );
  return rows;
}

export async function getFriendRequests(userId) {
  const [rows] = await pool.execute(
    `SELECT fr.id, fr.sender_id, fr.receiver_id, fr.status, fr.created_at, fr.updated_at,
       CASE WHEN fr.receiver_id = ? THEN 'incoming' ELSE 'outgoing' END AS direction,
       p.id AS other_user_id, p.username AS other_username, p.display_name AS other_display_name,
       p.avatar_url AS other_avatar_url, p.status AS other_status,
       p.custom_status_text AS other_custom_status_text, p.custom_status_emoji AS other_custom_status_emoji,
       p.custom_status_expires_at AS other_custom_status_expires_at
     FROM friend_requests fr
     JOIN profiles p ON p.id = CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END
     WHERE fr.status = 'pending' AND (fr.sender_id = ? OR fr.receiver_id = ?)
     ORDER BY fr.created_at DESC`,
    [userId, userId, userId, userId],
  );
  return rows;
}

export async function getBlockedUsers(userId) {
  const [rows] = await pool.execute(
    `SELECT b.id AS block_id, b.blocked_id AS id, b.blocked_id AS user_id, b.created_at,
       p.username, p.display_name, p.avatar_url, p.status,
       p.custom_status_text, p.custom_status_emoji, p.custom_status_expires_at
     FROM blocked_users b
     JOIN profiles p ON p.id = b.blocked_id
     WHERE b.blocker_id = ?
     ORDER BY COALESCE(NULLIF(p.display_name, ''), p.username) ASC`,
    [userId],
  );
  return rows;
}

export async function sendFriendRequest(userId, args = {}) {
  const limited = await consumeRateLimit(`friend-request:${userId}`, 20, 60 * 60 * 1000);
  if (limited && !limited.allowed) throw new Error('Too many friend requests. Please try again later.');
  const target = await targetProfile(userId, args);
  const [low, high] = pairArgs(userId, target.id);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      'SELECT * FROM friend_requests WHERE user_low = ? AND user_high = ? LIMIT 1',
      [low, high],
    );
    let row = existingRows[0];
    if (row?.status === 'accepted') {
      await connection.commit();
      return { status: 'already_friends', friendship_id: row.id, user: target };
    }
    if (row?.status === 'pending') {
      await connection.commit();
      return {
        status: row.sender_id === userId ? 'pending_outgoing' : 'pending_incoming',
        friendship_id: row.id,
        user: target,
      };
    }

    const [recipient] = await connection.execute('SELECT allow_friend_requests FROM profiles WHERE id = ? LIMIT 1', [target.id]);
    if (!recipient[0]?.allow_friend_requests) throw new Error(`${target.username} isn't accepting friend requests.`);
    const [blocked] = await connection.execute(
      'SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
      [userId, target.id, target.id, userId],
    );
    if (blocked.length) throw new Error("You can't add this user.");

    if (!row) {
      await connection.execute(
        'INSERT IGNORE INTO friend_requests (id, sender_id, receiver_id, user_low, user_high, status) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), userId, target.id, low, high, 'pending'],
      );
      const [inserted] = await connection.execute(
        'SELECT * FROM friend_requests WHERE user_low = ? AND user_high = ? LIMIT 1',
        [low, high],
      );
      row = inserted[0];
      if (!row) throw new Error('Could not create the friend request.');
      if (row.status === 'accepted') {
        await connection.commit();
        return { status: 'already_friends', friendship_id: row.id, user: target };
      }
      if (row.status === 'pending') {
        await connection.commit();
        return { status: row.sender_id === userId ? 'pending_outgoing' : 'pending_incoming', friendship_id: row.id, user: target };
      }
    } else {
      await connection.execute(
        "UPDATE friend_requests SET sender_id = ?, receiver_id = ?, status = 'pending', created_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [userId, target.id, row.id],
      );
    }
    await connection.commit();
    return { status: 'sent', friendship_id: row.id, user: target };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureDirectMessageInTransaction(connection, userId, otherId) {
  const [low, high] = pairArgs(userId, otherId);
  const [existing] = await connection.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
  if (existing.length) {
    const conversationId = existing[0].conversation_id;
    await connection.execute(
      'INSERT IGNORE INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [randomUUID(), conversationId, userId, 'member', randomUUID(), conversationId, otherId, 'member'],
    );
    return conversationId;
  }
  const id = randomUUID();
  await connection.execute('INSERT INTO dm_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)', [low, high, id]);
  await connection.execute('INSERT INTO conversations (id, is_group, kind, created_by) VALUES (?, ?, ?, ?)', [id, boolParam(false), 'dm', userId]);
  await connection.execute(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    [randomUUID(), id, userId, 'member', randomUUID(), id, otherId, 'member'],
  );
  return id;
}

export async function respondFriendRequest(userId, args = {}) {
  const friendshipId = String(args._friendship_id || args._id || '').trim();
  const accept = args._accept !== false && args._accept !== 0 && String(args._accept ?? 'true').toLowerCase() !== 'false';
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const row = friendshipId
      ? await findFriendshipById(userId, friendshipId, connection)
      : await (async () => {
          const otherId = String(args._other_id || args._other_user_id || '').trim();
          if (!otherId) throw new Error('Friend request not found.');
          return findFriendship(userId, otherId, connection);
        })();
    if (!row || row.status !== 'pending') throw new Error('Friend request not found.');
    if (row.receiver_id !== userId) throw new Error('Only the recipient can respond to this request.');
    const otherId = otherUserId(row, userId);
    let conversationId = null;
    if (accept) {
      const [blocked] = await connection.execute(
        'SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
        [userId, otherId, otherId, userId],
      );
      if (blocked.length) throw new Error('This user is unavailable.');
      await connection.execute("UPDATE friend_requests SET status = 'accepted' WHERE id = ?", [row.id]);
      conversationId = await ensureDirectMessageInTransaction(connection, userId, otherId);
    } else {
      await connection.execute("UPDATE friend_requests SET status = 'rejected' WHERE id = ?", [row.id]);
    }
    await connection.commit();
    return { status: accept ? 'accepted' : 'rejected', friendship_id: row.id, conversation_id: conversationId, other_user_id: otherId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function cancelFriendRequest(userId, args = {}) {
  const friendshipId = String(args._friendship_id || args._id || '').trim();
  const otherId = String(args._other_id || args._other_user_id || '').trim();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const row = friendshipId
      ? await findFriendshipById(userId, friendshipId, connection)
      : otherId
        ? await findFriendship(userId, otherId, connection)
        : null;
    if (!row || row.status !== 'pending' || row.sender_id !== userId) throw new Error('Friend request not found.');
    await connection.execute("UPDATE friend_requests SET status = 'cancelled' WHERE id = ?", [row.id]);
    await connection.commit();
    return { status: 'cancelled', friendship_id: row.id, other_user_id: otherUserId(row, userId) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function unfriend(userId, args = {}) {
  const friendshipId = String(args._friendship_id || args._id || '').trim();
  const otherId = String(args._other_id || args._other_user_id || '').trim();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const row = friendshipId
      ? await findFriendshipById(userId, friendshipId, connection)
      : otherId
        ? await findFriendship(userId, otherId, connection)
        : null;
    if (!row || row.status !== 'accepted') throw new Error('Friend not found.');
    const [low, high] = pairArgs(userId, otherUserId(row, userId));
    const [dm] = await connection.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ? LIMIT 1', [low, high]);
    await connection.execute('DELETE FROM friend_requests WHERE id = ?', [row.id]);
    if (dm[0]?.conversation_id) {
      await connection.execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id IN (?, ?)', [dm[0].conversation_id, userId, otherUserId(row, userId)]);
    }
    await connection.commit();
    return { status: 'unfriended', friendship_id: row.id, conversation_id: dm[0]?.conversation_id || null, other_user_id: otherUserId(row, userId) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function blockUser(userId, args = {}) {
  const otherId = String(args._other_id || args._other_user_id || '').trim();
  if (!otherId || otherId === userId) throw new Error('Choose another user.');
  const [target] = await pool.execute('SELECT id FROM profiles WHERE id = ? LIMIT 1', [otherId]);
  if (!target.length) throw new Error('User not found.');
  const [low, high] = pairArgs(userId, otherId);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT IGNORE INTO blocked_users (id, blocker_id, blocked_id) VALUES (?, ?, ?)',
      [randomUUID(), userId, otherId],
    );
    const [friendship] = await connection.execute('SELECT id FROM friend_requests WHERE user_low = ? AND user_high = ? LIMIT 1', [low, high]);
    await connection.execute('DELETE FROM friend_requests WHERE user_low = ? AND user_high = ?', [low, high]);
    const [dm] = await connection.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ? LIMIT 1', [low, high]);
    if (dm[0]?.conversation_id) {
      await connection.execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id IN (?, ?)', [dm[0].conversation_id, userId, otherId]);
    }
    await connection.commit();
    return { status: 'blocked', user_id: otherId, friendship_id: friendship[0]?.id || null, conversation_id: dm[0]?.conversation_id || null };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function unblockUser(userId, args = {}) {
  const otherId = String(args._other_id || args._other_user_id || '').trim();
  if (!otherId) throw new Error('Choose another user.');
  await pool.execute('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?', [userId, otherId]);
  return { status: 'unblocked', user_id: otherId };
}
