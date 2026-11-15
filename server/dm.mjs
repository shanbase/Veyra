import { randomUUID } from 'node:crypto';
import { pool, isPostgres } from './db.mjs';

const boolParam = (value) => (isPostgres ? Boolean(value) : value ? 1 : 0);

export function friendPair(userId, otherId) {
  return [userId, otherId].sort();
}

export async function ensureDirectMessage(userId, otherId) {
  if (!otherId || otherId === userId) throw new Error('Choose another user to start a conversation.');
  const [blocked] = await pool.execute('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [userId, otherId, otherId, userId]);
  if (blocked.length) throw new Error('This conversation is unavailable.');
  const [low, high] = friendPair(userId, otherId);
  const [friendship] = await pool.execute("SELECT id FROM friend_requests WHERE status = 'accepted' AND user_low = ? AND user_high = ? LIMIT 1", [low, high]);
  if (!friendship.length) throw new Error('You can only message accepted friends.');
  const [existing] = await pool.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
  if (existing.length) {
    const conversationId = existing[0].conversation_id;
    await pool.execute(
      'INSERT IGNORE INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [randomUUID(), conversationId, userId, 'member', randomUUID(), conversationId, otherId, 'member'],
    );
    return conversationId;
  }
  const id = randomUUID();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [claim] = await connection.execute(
      'INSERT IGNORE INTO dm_pairs (user_low, user_high, conversation_id) VALUES (?, ?, ?)',
      [low, high, id],
    );
    if (!claim.affectedRows) {
      const [pair] = await connection.execute('SELECT conversation_id FROM dm_pairs WHERE user_low = ? AND user_high = ?', [low, high]);
      await connection.commit();
      return pair[0].conversation_id;
    }
    await connection.execute('INSERT INTO conversations (id, is_group, kind, created_by) VALUES (?, ?, ?, ?)', [id, boolParam(false), 'dm', userId]);
    await connection.execute('INSERT INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [randomUUID(), id, userId, 'member', randomUUID(), id, otherId, 'member']);
    await connection.commit();
    return id;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
