import { randomBytes, randomUUID } from 'node:crypto';
import { pool, isPostgres } from './db.mjs';
import {
  SERVER_PERMISSIONS,
  canAssignRole,
  canModerateMember,
  defaultEveryonePermissions,
  getMemberContextById,
  getServerMemberContext,
  hasServerPermission,
  parsePermissions,
  parseServerDate,
  requireServerMembership,
  requireServerPermission,
  serializePermissions,
} from './permissions.mjs';

const boolParam = (value) => (isPostgres ? Boolean(value) : value ? 1 : 0);

function dbDateTime(date = new Date()) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function cleanString(value, max, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return text;
}

function optionalString(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function parsePermissionsInput(value) {
  if (value instanceof Set) return serializePermissions(value);
  if (Array.isArray(value)) return serializePermissions(value);
  if (value && typeof value === 'object') {
    return serializePermissions(Object.keys(value).filter((key) => value[key] === true || value[key] === 'true' || value[key] === 1));
  }
  return serializePermissions([]);
}

function permissionArray(permissions) {
  return permissions instanceof Set ? [...permissions] : SERVER_PERMISSIONS.filter((permission) => permissions?.[permission]);
}

function mentionPredicate(username) {
  const escaped = String(username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(m.preview LIKE '%@everyone%' OR m.preview LIKE '%@here%'${escaped ? ` OR m.preview LIKE '%@${escaped}%'` : ''})`;
}

async function mirrorServerMembersToChannel(connection, serverId, conversationId) {
  const [members] = await connection.execute('SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
  for (const member of members) {
    await connection.execute(
      'INSERT IGNORE INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, \'member\')',
      [randomUUID(), conversationId, member.user_id],
    );
  }
}

async function mirrorMemberToChannels(connection, serverId, userId) {
  const [channels] = await connection.execute('SELECT conversation_id FROM server_channels WHERE server_id = ?', [serverId]);
  for (const channel of channels) {
    await connection.execute(
      'INSERT IGNORE INTO conversation_members (id, conversation_id, user_id, role) VALUES (?, ?, ?, \'member\')',
      [randomUUID(), channel.conversation_id, userId],
    );
  }
}

async function removeMemberFromChannels(connection, serverId, userId) {
  await connection.execute(
    `DELETE FROM conversation_members
     WHERE user_id = ? AND conversation_id IN (SELECT conversation_id FROM server_channels WHERE server_id = ?)`,
    [userId, serverId],
  );
}

async function serverChannelIds(connection, serverId) {
  const [rows] = await connection.execute('SELECT conversation_id FROM server_channels WHERE server_id = ?', [serverId]);
  return rows.map((row) => row.conversation_id);
}

async function createTextChannel(connection, { serverId, name, categoryId = null, position = 0, topic = null, slowModeSeconds = 0, isReadonly = false, createdBy }) {
  const channelId = randomUUID();
  const conversationId = randomUUID();
  const cleanName = cleanString(name, 100, 'Channel name');
  await connection.execute(
    'INSERT INTO conversations (id, is_group, kind, name, created_by) VALUES (?, ?, ?, ?, ?)',
    [conversationId, boolParam(true), 'server', cleanName, createdBy],
  );
  await connection.execute(
    `INSERT INTO server_channels
      (id, server_id, conversation_id, name, type, category_id, position, topic, slow_mode_seconds, is_readonly)
     VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?)`,
    [
      channelId,
      serverId,
      conversationId,
      cleanName,
      categoryId,
      Math.max(0, Math.floor(Number(position) || 0)),
      optionalString(topic, 500),
      Math.max(0, Math.min(21600, Math.floor(Number(slowModeSeconds) || 0))),
      boolParam(isReadonly),
    ],
  );
  await mirrorServerMembersToChannel(connection, serverId, conversationId);
  return { channel_id: channelId, conversation_id: conversationId };
}

async function createCategory(connection, serverId, name, position = 0) {
  const id = randomUUID();
  await connection.execute(
    'INSERT INTO server_categories (id, server_id, name, position) VALUES (?, ?, ?, ?)',
    [id, serverId, cleanString(name, 100, 'Category name'), Math.max(0, Math.floor(Number(position) || 0))],
  );
  return id;
}

const SERVER_TEMPLATES = {
  blank: [{ name: 'Text Channels', channels: [{ name: 'general' }] }],
  community: [
    { name: 'Info', channels: [{ name: 'welcome' }, { name: 'rules' }] },
    { name: 'General', channels: [{ name: 'general' }, { name: 'chat' }] },
  ],
  gaming: [
    { name: 'Community', channels: [{ name: 'general' }, { name: 'clips-and-media' }, { name: 'looking-for-group' }] },
    { name: 'Projects', channels: [{ name: 'ideas' }, { name: 'showcase' }] },
  ],
  study: [
    { name: 'Study Hall', channels: [{ name: 'general' }, { name: 'homework-help' }, { name: 'resources' }] },
  ],
};

async function seedServerTemplate(connection, serverId, template, userId) {
  const groups = SERVER_TEMPLATES[template] || SERVER_TEMPLATES.community;
  let channelPosition = 0;
  for (const [categoryIndex, group] of groups.entries()) {
    const categoryId = await createCategory(connection, serverId, group.name, categoryIndex);
    for (const channel of group.channels) {
      await createTextChannel(connection, {
        serverId,
        name: channel.name,
        categoryId,
        position: channelPosition++,
        createdBy: userId,
      });
    }
  }
}

async function createServer(userId, args = {}) {
  const name = cleanString(args._name, 100, 'Server name');
  const description = optionalString(args._description, 500);
  const iconUrl = optionalString(args._icon_url, 2048);
  const template = String(args._template || 'community');
  if (!SERVER_TEMPLATES[template]) throw new Error('Invalid server template.');
  const serverId = randomUUID();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO servers (id, name, description, icon_url, owner_id) VALUES (?, ?, ?, ?, ?)',
      [serverId, name, description, iconUrl, userId],
    );
    await connection.execute(
      `INSERT INTO server_roles (id, server_id, name, color, position, hoist, mentionable, is_default, administrator, permissions)
       VALUES (?, ?, '@everyone', NULL, 0, ?, ?, ?, ?, ?)`,
      [randomUUID(), serverId, boolParam(false), boolParam(false), boolParam(true), boolParam(false), JSON.stringify(defaultEveryonePermissions())],
    );
    await connection.execute(
      'INSERT INTO server_members (id, server_id, user_id, role_id) VALUES (?, ?, ?, NULL)',
      [randomUUID(), serverId, userId],
    );
    await seedServerTemplate(connection, serverId, template, userId);
    await connection.commit();
    return { server_id: serverId, template };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getMyServers(userId) {
  const [profile] = await pool.execute('SELECT username FROM profiles WHERE id = ? LIMIT 1', [userId]);
  const mention = mentionPredicate(profile[0]?.username);
  const [rows] = await pool.execute(
    `SELECT s.id, s.name, s.icon_url, s.description, s.owner_id, s.verification_level, s.created_at,
       sm.joined_at, sm.nickname, sm.role_id,
       (SELECT COUNT(*) FROM server_channels sc
         JOIN conversation_members cm ON cm.conversation_id = sc.conversation_id AND cm.user_id = ?
         JOIN messages m ON m.conversation_id = sc.conversation_id AND m.sender_id <> ? AND m.read_at IS NULL
         WHERE sc.server_id = s.id AND COALESCE(cm.muted, FALSE) = FALSE) AS unread_count,
       (SELECT COUNT(*) FROM server_channels sc
         JOIN conversation_members cm ON cm.conversation_id = sc.conversation_id AND cm.user_id = ?
         JOIN messages m ON m.conversation_id = sc.conversation_id AND m.sender_id <> ? AND m.read_at IS NULL
         WHERE sc.server_id = s.id AND COALESCE(cm.muted, FALSE) = FALSE AND ${mention}) AS mention_count
     FROM servers s
     JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = ?
     ORDER BY s.name ASC`,
    [userId, userId, userId, userId, userId],
  );
  return Promise.all(rows.map(async (row) => {
    const context = await getServerMemberContext(userId, row.id);
    const canView = Boolean(context?.permissions.has('view_channel'));
    return {
      ...row,
      is_owner: row.owner_id === userId,
      unread_count: canView ? Number(row.unread_count || 0) : 0,
      mention_count: canView ? Number(row.mention_count || 0) : 0,
    };
  }));
}

async function getServerView(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  if (!serverId) throw new Error('Server id is required.');
  const context = await requireServerMembership(userId, serverId);
  const [categories] = await pool.execute('SELECT * FROM server_categories WHERE server_id = ? ORDER BY position ASC, created_at ASC', [serverId]);
  const [channels] = await pool.execute(
    `SELECT sc.*, c.kind AS conversation_kind, c.created_at AS conversation_created_at
     FROM server_channels sc
     JOIN conversations c ON c.id = sc.conversation_id
     WHERE sc.server_id = ?
     ORDER BY sc.category_id IS NULL DESC, sc.position ASC, sc.created_at ASC`,
    [serverId],
  );
  const [roles] = await pool.execute('SELECT * FROM server_roles WHERE server_id = ? ORDER BY position DESC, created_at ASC', [serverId]);
  const [members] = await pool.execute(
    `SELECT sm.id AS membership_id, sm.server_id, sm.user_id, sm.role_id, sm.nickname, sm.timed_out_until, sm.joined_at,
       p.username, p.display_name, p.avatar_url, p.status,
       p.custom_status_text, p.custom_status_emoji, p.custom_status_expires_at,
       r.name AS role_name, r.color AS role_color, r.position AS role_position, r.hoist AS role_hoist, r.mentionable AS role_mentionable
     FROM server_members sm
     JOIN profiles p ON p.id = sm.user_id
     LEFT JOIN server_roles r ON r.id = sm.role_id
     WHERE sm.server_id = ?
     ORDER BY sm.joined_at ASC`,
    [serverId],
  );
  const [profile] = await pool.execute('SELECT username FROM profiles WHERE id = ? LIMIT 1', [userId]);
  const mention = mentionPredicate(profile[0]?.username);
  const [unreadRows] = await pool.execute(
    `SELECT cm.conversation_id,
       COUNT(*) AS unread_count,
       SUM(CASE WHEN ${mention} THEN 1 ELSE 0 END) AS mention_count
     FROM conversation_members cm
     JOIN server_channels sc ON sc.conversation_id = cm.conversation_id AND sc.server_id = ?
     JOIN messages m ON m.conversation_id = cm.conversation_id AND m.sender_id <> ? AND m.read_at IS NULL
     WHERE cm.user_id = ? AND COALESCE(cm.muted, FALSE) = FALSE
     GROUP BY cm.conversation_id`,
    [serverId, userId, userId],
  );
  const unreadByConversation = new Map(unreadRows.map((row) => [row.conversation_id, row]));
  const myPermissions = permissionArray(context.permissions);
  const canViewChannels = context.permissions.has('view_channel');
  return {
    server: context.server,
    membership: context.member,
    categories: canViewChannels ? categories : [],
    channels: canViewChannels ? channels.map((channel) => ({
      ...channel,
      permissions: myPermissions,
      unread_count: Number(unreadByConversation.get(channel.conversation_id)?.unread_count || 0),
      mention_count: Number(unreadByConversation.get(channel.conversation_id)?.mention_count || 0),
    })) : [],
    roles,
    members,
    my_permissions: myPermissions,
    is_owner: context.isOwner,
  };
}

async function updateServer(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerPermission(userId, serverId, 'manage_server');
  const fields = [];
  const values = [];
  if (args._name !== undefined) { fields.push('name = ?'); values.push(cleanString(args._name, 100, 'Server name')); }
  if (args._description !== undefined) { fields.push('description = ?'); values.push(optionalString(args._description, 500)); }
  if (args._icon_url !== undefined) { fields.push('icon_url = ?'); values.push(optionalString(args._icon_url, 2048)); }
  if (args._banner_url !== undefined) { fields.push('banner_url = ?'); values.push(optionalString(args._banner_url, 2048)); }
  if (args._verification_level !== undefined) {
    const level = String(args._verification_level || 'none');
    if (!['none', 'low', 'medium', 'high'].includes(level)) throw new Error('Invalid verification level.');
    fields.push('verification_level = ?'); values.push(level);
  }
  if (!fields.length) return { server_id: serverId };
  values.push(serverId);
  await pool.execute(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`, values);
  return { server_id: serverId };
}

async function deleteServer(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const context = await requireServerMembership(userId, serverId);
  if (!context.isOwner) throw new Error('Only the server owner can delete this server.');
  const [members] = await pool.execute('SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
  const memberIds = members.map((member) => member.user_id);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const conversationIds = await serverChannelIds(connection, serverId);
    for (const conversationId of conversationIds) {
      await connection.execute('DELETE FROM conversations WHERE id = ?', [conversationId]);
    }
    await connection.execute('DELETE FROM servers WHERE id = ?', [serverId]);
    await connection.commit();
    return { server_id: serverId, deleted: true, member_ids: memberIds };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function leaveServer(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const context = await requireServerMembership(userId, serverId);
  if (context.isOwner) throw new Error('Server owners must delete the server instead of leaving.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await removeMemberFromChannels(connection, serverId, userId);
    await connection.execute('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
    await connection.commit();
    return { server_id: serverId, user_id: userId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function kickMember(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const targetId = String(args._user_id || args._member_id || '').trim();
  const actor = await requireServerPermission(userId, serverId, 'kick_members');
  if (!targetId || targetId === userId) throw new Error('Choose another member to remove.');
  const target = await getMemberContextById(serverId, targetId);
  if (!target) throw new Error('Member not found.');
  if (!canModerateMember(actor, target)) throw new Error('You cannot remove this member.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await removeMemberFromChannels(connection, serverId, targetId);
    await connection.execute('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    await connection.commit();
    return { server_id: serverId, user_id: targetId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function banMember(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const targetId = String(args._user_id || args._member_id || '').trim();
  const actor = await requireServerPermission(userId, serverId, 'ban_members');
  if (!targetId || targetId === userId) throw new Error('Choose another member to ban.');
  const target = await getMemberContextById(serverId, targetId);
  if (!target) throw new Error('Member not found.');
  if (!canModerateMember(actor, target)) throw new Error('You cannot ban this member.');
  const reason = optionalString(args._reason, 300);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT IGNORE INTO server_bans (id, server_id, user_id, banned_by, reason) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), serverId, targetId, userId, reason],
    );
    await removeMemberFromChannels(connection, serverId, targetId);
    await connection.execute('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
    await connection.commit();
    return { server_id: serverId, user_id: targetId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function unbanMember(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const targetId = String(args._user_id || args._member_id || '').trim();
  await requireServerPermission(userId, serverId, 'ban_members');
  if (!targetId) throw new Error('Member id is required.');
  await pool.execute('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
  return { server_id: serverId, user_id: targetId };
}

async function listBans(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerPermission(userId, serverId, 'ban_members');
  const [rows] = await pool.execute(
    `SELECT sb.id, sb.user_id, sb.reason, sb.created_at, p.username, p.display_name, p.avatar_url
     FROM server_bans sb JOIN profiles p ON p.id = sb.user_id
     WHERE sb.server_id = ? ORDER BY sb.created_at DESC`,
    [serverId],
  );
  return rows;
}

async function setMemberRole(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const targetId = String(args._user_id || args._member_id || '').trim();
  const roleId = args._role_id === null || args._role_id === '' ? null : String(args._role_id || '').trim() || null;
  const actor = await requireServerPermission(userId, serverId, 'manage_roles');
  if (!targetId) throw new Error('Member id is required.');
  const target = await getMemberContextById(serverId, targetId);
  if (!target) throw new Error('Member not found.');
  if (actor.server.owner_id === targetId) {
    throw new Error('The server owner role cannot be changed.');
  }
  if (!actor.isOwner && target.highestPosition >= actor.highestPosition) {
    throw new Error('You cannot modify a member at or above your role.');
  }
  if (roleId) {
    const [roles] = await pool.execute('SELECT * FROM server_roles WHERE id = ? AND server_id = ? LIMIT 1', [roleId, serverId]);
    const role = roles[0];
    if (!role) throw new Error('Role not found.');
    if (role.is_default) throw new Error('Use null to assign @everyone.');
    if (!canAssignRole(actor, role)) throw new Error('You cannot assign this role.');
  } else if (!actor.isOwner && target.highestPosition >= actor.highestPosition) {
    throw new Error('You cannot modify a member at or above your role.');
  }
  await pool.execute('UPDATE server_members SET role_id = ? WHERE server_id = ? AND user_id = ?', [roleId, serverId, targetId]);
  return { server_id: serverId, user_id: targetId, role_id: roleId };
}

async function setMemberNickname(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const targetId = String(args._user_id || args._member_id || '').trim();
  const nickname = optionalString(args._nickname, 80);
  const context = await requireServerMembership(userId, serverId);
  if (!targetId) throw new Error('Member id is required.');
  if (targetId !== userId) {
    if (!context.permissions.has('manage_nicknames')) throw new Error('Missing permission to change this nickname.');
    const target = await getMemberContextById(serverId, targetId);
    if (!target) throw new Error('Member not found.');
    if (!canModerateMember(context, target)) throw new Error('You cannot change this member\'s nickname.');
  }
  const [server] = await pool.execute('SELECT owner_id FROM servers WHERE id = ? LIMIT 1', [serverId]);
  if (server[0]?.owner_id === targetId && targetId !== userId) throw new Error('The owner nickname cannot be changed.');
  await pool.execute('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?', [nickname, serverId, targetId]);
  return { server_id: serverId, user_id: targetId, nickname };
}

async function timeoutMember(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const targetId = String(args._user_id || args._member_id || '').trim();
  const minutes = Math.max(0, Math.min(40320, Math.floor(Number(args._minutes ?? args._duration_minutes ?? 0) || 0)));
  const actor = await requireServerPermission(userId, serverId, 'kick_members');
  if (!targetId || targetId === userId) throw new Error('Choose another member to time out.');
  const target = await getMemberContextById(serverId, targetId);
  if (!target) throw new Error('Member not found.');
  if (!canModerateMember(actor, target)) throw new Error('You cannot time out this member.');
  const until = minutes > 0 ? dbDateTime(new Date(Date.now() + minutes * 60_000)) : null;
  await pool.execute('UPDATE server_members SET timed_out_until = ? WHERE server_id = ? AND user_id = ?', [until, serverId, targetId]);
  return { server_id: serverId, user_id: targetId, timed_out_until: until };
}

async function createChannel(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerPermission(userId, serverId, 'manage_channels');
  const categoryId = args._category_id ? String(args._category_id) : null;
  if (categoryId) {
    const [categories] = await pool.execute('SELECT id FROM server_categories WHERE id = ? AND server_id = ? LIMIT 1', [categoryId, serverId]);
    if (!categories.length) throw new Error('Category not found.');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [positions] = await connection.execute('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM server_channels WHERE server_id = ?', [serverId]);
    const created = await createTextChannel(connection, {
      serverId,
      name: args._name,
      categoryId,
      position: args._position ?? positions[0].next_position,
      topic: args._topic,
      slowModeSeconds: args._slow_mode_seconds,
      isReadonly: args._is_readonly,
      createdBy: userId,
    });
    await connection.commit();
    return { ...created, server_id: serverId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function channelForUpdate(userId, channelId, permission = 'manage_channels') {
  const [rows] = await pool.execute('SELECT * FROM server_channels WHERE id = ? LIMIT 1', [channelId]);
  const channel = rows[0];
  if (!channel) throw new Error('Channel not found.');
  await requireServerPermission(userId, channel.server_id, permission);
  return channel;
}

async function updateChannel(userId, args = {}) {
  const channelId = String(args._channel_id || args._id || '').trim();
  const channel = await channelForUpdate(userId, channelId);
  const fields = [];
  const values = [];
  let nextName = null;
  if (args._name !== undefined) {
    nextName = cleanString(args._name, 100, 'Channel name');
    fields.push('name = ?'); values.push(nextName);
  }
  if (args._topic !== undefined) { fields.push('topic = ?'); values.push(optionalString(args._topic, 500)); }
  if (args._category_id !== undefined) {
    const categoryId = args._category_id ? String(args._category_id) : null;
    if (categoryId) {
      const [categories] = await pool.execute('SELECT id FROM server_categories WHERE id = ? AND server_id = ? LIMIT 1', [categoryId, channel.server_id]);
      if (!categories.length) throw new Error('Category not found.');
    }
    fields.push('category_id = ?'); values.push(categoryId);
  }
  if (args._position !== undefined) { fields.push('position = ?'); values.push(Math.max(0, Math.floor(Number(args._position) || 0))); }
  if (args._slow_mode_seconds !== undefined) { fields.push('slow_mode_seconds = ?'); values.push(Math.max(0, Math.min(21600, Math.floor(Number(args._slow_mode_seconds) || 0)))); }
  if (args._is_readonly !== undefined) { fields.push('is_readonly = ?'); values.push(boolParam(args._is_readonly)); }
  if (!fields.length) return { channel_id: channelId };
  values.push(channelId);
  await pool.execute(`UPDATE server_channels SET ${fields.join(', ')} WHERE id = ?`, values);
  if (nextName) await pool.execute('UPDATE conversations SET name = ? WHERE id = ?', [nextName, channel.conversation_id]);
  return { channel_id: channelId, server_id: channel.server_id, conversation_id: channel.conversation_id };
}

async function deleteChannel(userId, args = {}) {
  const channelId = String(args._channel_id || args._id || '').trim();
  const channel = await channelForUpdate(userId, channelId);
  await pool.execute('DELETE FROM conversations WHERE id = ?', [channel.conversation_id]);
  return { channel_id: channelId, server_id: channel.server_id, conversation_id: channel.conversation_id };
}

async function reorderChannels(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerPermission(userId, serverId, 'manage_channels');
  const ids = Array.isArray(args._channel_ids) ? args._channel_ids.map(String) : [];
  if (!ids.length) return { server_id: serverId };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, channelId] of ids.entries()) {
      await connection.execute('UPDATE server_channels SET position = ? WHERE id = ? AND server_id = ?', [index, channelId, serverId]);
    }
    await connection.commit();
    return { server_id: serverId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createCategoryRpc(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerPermission(userId, serverId, 'manage_channels');
  const [positions] = await pool.execute('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM server_categories WHERE server_id = ?', [serverId]);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const id = await createCategory(connection, serverId, args._name, args._position ?? positions[0].next_position);
    await connection.commit();
    return { category_id: id, server_id: serverId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function updateCategory(userId, args = {}) {
  const categoryId = String(args._category_id || args._id || '').trim();
  const [rows] = await pool.execute('SELECT * FROM server_categories WHERE id = ? LIMIT 1', [categoryId]);
  const category = rows[0];
  if (!category) throw new Error('Category not found.');
  await requireServerPermission(userId, category.server_id, 'manage_channels');
  const fields = [];
  const values = [];
  if (args._name !== undefined) { fields.push('name = ?'); values.push(cleanString(args._name, 100, 'Category name')); }
  if (args._position !== undefined) { fields.push('position = ?'); values.push(Math.max(0, Math.floor(Number(args._position) || 0))); }
  if (!fields.length) return { category_id: categoryId };
  values.push(categoryId);
  await pool.execute(`UPDATE server_categories SET ${fields.join(', ')} WHERE id = ?`, values);
  return { category_id: categoryId, server_id: category.server_id };
}

async function deleteCategory(userId, args = {}) {
  const categoryId = String(args._category_id || args._id || '').trim();
  const [rows] = await pool.execute('SELECT * FROM server_categories WHERE id = ? LIMIT 1', [categoryId]);
  const category = rows[0];
  if (!category) throw new Error('Category not found.');
  await requireServerPermission(userId, category.server_id, 'manage_channels');
  await pool.execute('UPDATE server_channels SET category_id = NULL WHERE category_id = ?', [categoryId]);
  await pool.execute('DELETE FROM server_categories WHERE id = ?', [categoryId]);
  return { category_id: categoryId, server_id: category.server_id };
}

async function createRole(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const actor = await requireServerPermission(userId, serverId, 'manage_roles');
  const name = cleanString(args._name, 100, 'Role name');
  const permissions = parsePermissionsInput(args._permissions);
  const administrator = Boolean(args._administrator);
  if (administrator && !actor.isOwner) throw new Error('Only the server owner can grant administrator.');
  if (!administrator) {
    const actorPermissions = actor.permissions;
    for (const permission of Object.keys(permissions)) {
      if (permissions[permission] && !actorPermissions.has(permission)) throw new Error('You cannot grant permissions you do not have.');
    }
  }
  const [positions] = await pool.execute('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM server_roles WHERE server_id = ? AND is_default = ?', [serverId, isPostgres ? false : 0]);
  const requestedPosition = args._position !== undefined ? Math.max(1, Math.floor(Number(args._position) || 1)) : positions[0].next_position;
  if (!actor.isOwner && requestedPosition >= actor.highestPosition) throw new Error('You cannot create a role at or above yours.');
  const id = randomUUID();
  await pool.execute(
    `INSERT INTO server_roles (id, server_id, name, color, position, hoist, mentionable, is_default, administrator, permissions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      serverId,
      name,
      optionalString(args._color, 9),
      requestedPosition,
      boolParam(args._hoist),
      boolParam(args._mentionable),
      boolParam(false),
      boolParam(administrator),
      JSON.stringify(permissions),
    ],
  );
  return { role_id: id, server_id: serverId };
}

async function updateRole(userId, args = {}) {
  const roleId = String(args._role_id || args._id || '').trim();
  const [rows] = await pool.execute('SELECT * FROM server_roles WHERE id = ? LIMIT 1', [roleId]);
  const role = rows[0];
  if (!role) throw new Error('Role not found.');
  const actor = await requireServerPermission(userId, role.server_id, 'manage_roles');
  if (role.is_default && args._name !== undefined && String(args._name).trim() !== role.name) {
    throw new Error("@everyone's name cannot be changed.");
  }
  if (role.is_default && args._administrator) throw new Error('@everyone cannot be an administrator role.');
  if (!actor.isOwner && Number(role.position || 0) >= actor.highestPosition) throw new Error('You cannot edit a role at or above yours.');
  const fields = [];
  const values = [];
  if (args._name !== undefined) { fields.push('name = ?'); values.push(cleanString(args._name, 100, 'Role name')); }
  if (args._color !== undefined) { fields.push('color = ?'); values.push(optionalString(args._color, 9)); }
  if (args._hoist !== undefined) { fields.push('hoist = ?'); values.push(boolParam(args._hoist)); }
  if (args._mentionable !== undefined) { fields.push('mentionable = ?'); values.push(boolParam(args._mentionable)); }
  if (args._position !== undefined) {
    const requestedPosition = Math.max(role.is_default ? 0 : 1, Math.floor(Number(args._position) || 0));
    if (!actor.isOwner && requestedPosition >= actor.highestPosition) throw new Error('You cannot move a role to or above yours.');
    fields.push('position = ?'); values.push(requestedPosition);
  }
  if (args._permissions !== undefined) {
    const permissions = parsePermissionsInput(args._permissions);
    for (const permission of Object.keys(permissions)) {
      if (permissions[permission] && !actor.isOwner && !actor.permissions.has(permission)) throw new Error('You cannot grant permissions you do not have.');
    }
    fields.push('permissions = ?'); values.push(JSON.stringify(permissions));
  }
  if (args._administrator !== undefined) {
    if (args._administrator && !actor.isOwner) throw new Error('Only the server owner can grant administrator.');
    fields.push('administrator = ?'); values.push(boolParam(args._administrator));
  }
  if (!fields.length) return { role_id: roleId, server_id: role.server_id };
  values.push(roleId);
  await pool.execute(`UPDATE server_roles SET ${fields.join(', ')} WHERE id = ?`, values);
  return { role_id: roleId, server_id: role.server_id };
}

async function deleteRole(userId, args = {}) {
  const roleId = String(args._role_id || args._id || '').trim();
  const [rows] = await pool.execute('SELECT * FROM server_roles WHERE id = ? LIMIT 1', [roleId]);
  const role = rows[0];
  if (!role) throw new Error('Role not found.');
  const actor = await requireServerPermission(userId, role.server_id, 'manage_roles');
  if (role.is_default) throw new Error('@everyone cannot be deleted.');
  if (!actor.isOwner && Number(role.position || 0) >= actor.highestPosition) throw new Error('You cannot delete a role at or above yours.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE server_members SET role_id = NULL WHERE server_id = ? AND role_id = ?', [role.server_id, roleId]);
    await connection.execute('DELETE FROM server_roles WHERE id = ?', [roleId]);
    await connection.commit();
    return { role_id: roleId, server_id: role.server_id };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function reorderRoles(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  const actor = await requireServerPermission(userId, serverId, 'manage_roles');
  const ids = Array.isArray(args._role_ids) ? args._role_ids.map(String) : [];
  if (!ids.length) return { server_id: serverId };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, roleId] of ids.entries()) {
      const [rows] = await connection.execute('SELECT position, is_default FROM server_roles WHERE id = ? AND server_id = ? LIMIT 1', [roleId, serverId]);
      if (!rows.length) throw new Error('Role not found.');
      if (rows[0].is_default) {
        await connection.execute('UPDATE server_roles SET position = 0 WHERE id = ?', [roleId]);
        continue;
      }
      const position = ids.length - index;
      if (!actor.isOwner && (Number(rows[0].position || 0) >= actor.highestPosition || position >= actor.highestPosition)) throw new Error('You cannot reorder a role to or above yours.');
      await connection.execute('UPDATE server_roles SET position = ? WHERE id = ?', [position, roleId]);
    }
    await connection.commit();
    return { server_id: serverId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function inviteCode() {
  return randomBytes(6).toString('hex');
}

async function createInvite(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerMembership(userId, serverId);
  const maxUses = args._max_uses === null || args._max_uses === undefined || args._max_uses === '' ? null : Math.max(1, Math.floor(Number(args._max_uses) || 0));
  const expiresHours = args._expires_in_hours === null || args._expires_in_hours === undefined || args._expires_in_hours === '' ? null : Math.max(1, Math.min(8760, Math.floor(Number(args._expires_in_hours) || 0)));
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let code = inviteCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const [existing] = await connection.execute('SELECT id FROM server_invites WHERE code = ? LIMIT 1', [code]);
      if (!existing.length) break;
      code = inviteCode();
    }
    const id = randomUUID();
    const expiresAt = expiresHours ? dbDateTime(new Date(Date.now() + expiresHours * 60 * 60 * 1000)) : null;
    await connection.execute(
      'INSERT INTO server_invites (id, server_id, code, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, serverId, code, userId, maxUses, expiresAt],
    );
    await connection.commit();
    return { invite_id: id, server_id: serverId, code, max_uses: maxUses, expires_at: expiresAt };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function listInvites(userId, args = {}) {
  const serverId = String(args._server_id || args._id || '').trim();
  await requireServerMembership(userId, serverId);
  const [rows] = await pool.execute('SELECT * FROM server_invites WHERE server_id = ? ORDER BY created_at DESC', [serverId]);
  return rows;
}

async function revokeInvite(userId, args = {}) {
  const inviteId = String(args._invite_id || args._id || '').trim();
  const [rows] = await pool.execute('SELECT * FROM server_invites WHERE id = ? LIMIT 1', [inviteId]);
  const invite = rows[0];
  if (!invite) throw new Error('Invite not found.');
  const context = await requireServerMembership(userId, invite.server_id);
  if (invite.created_by !== userId && !context.isOwner && !context.permissions.has('manage_server')) {
    throw new Error('You cannot revoke this invite.');
  }
  await pool.execute('UPDATE server_invites SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3)) WHERE id = ?', [inviteId]);
  return { invite_id: inviteId, server_id: invite.server_id };
}

async function joinServerByCode(userId, args = {}) {
  const code = String(args._code || args._invite_code || '').trim().toLowerCase();
  if (!code) throw new Error('Invite code is required.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [invites] = await connection.execute('SELECT * FROM server_invites WHERE code = ? LIMIT 1 FOR UPDATE', [code]);
    const invite = invites[0];
    if (!invite || invite.revoked_at) throw new Error('Invite not found or revoked.');
    const expiresAt = parseServerDate(invite.expires_at);
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new Error('This invite has expired.');
    if (invite.max_uses !== null && Number(invite.uses || 0) >= Number(invite.max_uses)) throw new Error('This invite has reached its use limit.');
    const [banned] = await connection.execute('SELECT id FROM server_bans WHERE server_id = ? AND user_id = ? LIMIT 1', [invite.server_id, userId]);
    if (banned.length) throw new Error('You are banned from this server.');
    const [existing] = await connection.execute('SELECT id FROM server_members WHERE server_id = ? AND user_id = ? LIMIT 1', [invite.server_id, userId]);
    if (existing.length) {
      await connection.commit();
      return { status: 'already_member', server_id: invite.server_id };
    }
    const [updated] = await connection.execute(
      `UPDATE server_invites SET uses = uses + 1
       WHERE id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))
         AND (max_uses IS NULL OR uses < max_uses)`,
      [invite.id],
    );
    if (!updated.affectedRows) throw new Error('This invite is no longer valid.');
    await connection.execute('INSERT INTO server_members (id, server_id, user_id, role_id) VALUES (?, ?, ?, NULL)', [randomUUID(), invite.server_id, userId]);
    await mirrorMemberToChannels(connection, invite.server_id, userId);
    await connection.commit();
    return { status: 'joined', server_id: invite.server_id, invite_id: invite.id };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const handlers = {
  create_server: createServer,
  get_my_servers: getMyServers,
  get_server_view: getServerView,
  update_server: updateServer,
  delete_server: deleteServer,
  leave_server: leaveServer,
  kick_member: kickMember,
  ban_member: banMember,
  unban_member: unbanMember,
  list_bans: listBans,
  set_member_role: setMemberRole,
  set_server_member_role: setMemberRole,
  set_member_nickname: setMemberNickname,
  timeout_member: timeoutMember,
  create_channel: createChannel,
  update_channel: updateChannel,
  delete_channel: deleteChannel,
  reorder_channels: reorderChannels,
  create_category: createCategoryRpc,
  update_category: updateCategory,
  delete_category: deleteCategory,
  create_role: createRole,
  update_role: updateRole,
  delete_role: deleteRole,
  reorder_roles: reorderRoles,
  create_invite: createInvite,
  list_invites: listInvites,
  revoke_invite: revokeInvite,
  join_server_by_code: joinServerByCode,
};

export async function callServerRpc(userId, name, args = {}) {
  const handler = handlers[name];
  if (!handler) return { handled: false };
  return { handled: true, data: await handler(userId, args) };
}
