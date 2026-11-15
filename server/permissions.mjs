import { pool, isPostgres } from './db.mjs';

export const SERVER_PERMISSIONS = [
  'view_channel',
  'send_messages',
  'attach_files',
  'add_reactions',
  'create_poll',
  'embed_links',
  'mention_everyone',
  'manage_messages',
  'manage_channels',
  'manage_roles',
  'kick_members',
  'ban_members',
  'manage_nicknames',
  'manage_server',
];

const TIMEOUT_RESTRICTED = new Set([
  'send_messages',
  'attach_files',
  'add_reactions',
  'create_poll',
  'embed_links',
  'mention_everyone',
]);

const DEFAULT_EVERYONE_PERMISSIONS = {
  view_channel: true,
  send_messages: true,
  attach_files: true,
  add_reactions: true,
  create_poll: true,
  embed_links: true,
};

export function parsePermissions(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  const permissions = new Set();
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const permission of SERVER_PERMISSIONS) {
      if (parsed[permission] === true) permissions.add(permission);
    }
  }
  return permissions;
}

export function serializePermissions(permissions) {
  const input = permissions instanceof Set ? [...permissions] : Object.keys(permissions || {});
  return Object.fromEntries(SERVER_PERMISSIONS.map((permission) => [permission, input.includes(permission)]));
}

export function defaultEveryonePermissions() {
  return { ...DEFAULT_EVERYONE_PERMISSIONS };
}

function isTimedOut(member, now = new Date()) {
  const until = parseServerDate(member?.timed_out_until);
  return Boolean(until && until.getTime() > now.getTime());
}

export async function getServerMemberContext(userId, serverId, connection = pool) {
  const [servers] = await connection.execute('SELECT * FROM servers WHERE id = ? LIMIT 1', [serverId]);
  const server = servers[0];
  if (!server) return null;
  const [members] = await connection.execute('SELECT * FROM server_members WHERE server_id = ? AND user_id = ? LIMIT 1', [serverId, userId]);
  const member = members[0] || null;
  if (!member) return { server, member: null, roles: [], permissions: new Set(), isOwner: false, highestPosition: -1, timedOut: false };

  const [roles] = await connection.execute(
    `SELECT * FROM server_roles
     WHERE server_id = ? AND (is_default = ? OR id = ?)
     ORDER BY position ASC`,
    [serverId, isPostgres ? true : 1, member.role_id || ''],
  );
  const isOwner = server.owner_id === userId;
  const administrator = isOwner || roles.some((role) => role.administrator);
  const permissions = new Set();
  if (administrator) {
    for (const permission of SERVER_PERMISSIONS) permissions.add(permission);
  } else {
    for (const role of roles) {
      for (const permission of parsePermissions(role.permissions)) permissions.add(permission);
    }
  }
  const timedOut = isTimedOut(member);
  if (timedOut) {
    for (const permission of TIMEOUT_RESTRICTED) permissions.delete(permission);
  }
  const highestPosition = isOwner ? Number.MAX_SAFE_INTEGER : Math.max(0, ...roles.map((role) => Number(role.position || 0)));
  return { server, member, roles, permissions, isOwner, highestPosition, timedOut, administrator };
}

export async function hasServerPermission(userId, serverId, permission, connection = pool) {
  const context = await getServerMemberContext(userId, serverId, connection);
  return Boolean(context?.member && context.permissions.has(permission));
}

export async function requireServerPermission(userId, serverId, permission, connection = pool) {
  const context = await getServerMemberContext(userId, serverId, connection);
  if (!context?.member) throw new Error('You are not a member of this server.');
  if (!context.permissions.has(permission)) throw new Error(`Missing server permission: ${permission}.`);
  return context;
}

export async function requireServerMembership(userId, serverId, connection = pool) {
  const context = await getServerMemberContext(userId, serverId, connection);
  if (!context?.member) throw new Error('You are not a member of this server.');
  return context;
}

export function parseServerDate(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function verificationLevelAllows(level, userId, connection = pool) {
  if (!level || level === 'none') return true;
  const [rows] = await connection.execute('SELECT created_at, email_verified_at FROM auth_users WHERE id = ? LIMIT 1', [userId]);
  const account = rows[0];
  if (!account) return false;
  if (level === 'low') return Boolean(account.email_verified_at);
  const created = parseServerDate(account.created_at);
  if (!created) return false;
  const ageDays = (Date.now() - created.getTime()) / 86_400_000;
  if (level === 'medium') return ageDays >= 1;
  if (level === 'high') return ageDays >= 7;
  return true;
}

export async function serverChannelForConversation(conversationId, connection = pool) {
  const [rows] = await connection.execute(
    `SELECT sc.*, c.kind AS conversation_kind, s.verification_level, s.owner_id AS server_owner_id
     FROM server_channels sc
     JOIN conversations c ON c.id = sc.conversation_id
     JOIN servers s ON s.id = sc.server_id
     WHERE sc.conversation_id = ? LIMIT 1`,
    [conversationId],
  );
  return rows[0] || null;
}

export async function canPostInServerChannel(userId, conversationId, content = '', connection = pool, hasMedia = false) {
  const channel = await serverChannelForConversation(conversationId, connection);
  if (!channel) return { allowed: false, reason: 'not_server_channel', channel: null, context: null };
  const context = await getServerMemberContext(userId, channel.server_id, connection);
  if (!context?.member) return { allowed: false, reason: 'not_member', channel, context };
  if (!context.permissions.has('view_channel')) return { allowed: false, reason: 'missing_view_channel', channel, context };
  if (!context.permissions.has('send_messages')) return { allowed: false, reason: 'missing_send_messages', channel, context };
  if (hasMedia && !context.permissions.has('attach_files')) return { allowed: false, reason: 'missing_attach_files', channel, context };
  if (channel.is_readonly && !context.permissions.has('manage_messages')) return { allowed: false, reason: 'readonly', channel, context };
  const slowMode = Math.max(0, Number(channel.slow_mode_seconds || 0));
  if (slowMode > 0) {
    const [last] = await connection.execute('SELECT created_at FROM messages WHERE conversation_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1', [conversationId, userId]);
    const lastAt = parseServerDate(last[0]?.created_at);
    if (lastAt && Date.now() - lastAt.getTime() < slowMode * 1000) return { allowed: false, reason: 'slow_mode', channel, context };
  }
  if (!(await verificationLevelAllows(channel.verification_level, userId, connection))) return { allowed: false, reason: 'verification_level', channel, context };
  if (/(^|\s)@(everyone|here)(?=$|[^A-Za-z0-9_])/i.test(String(content || '')) && !context.permissions.has('mention_everyone')) {
    return { allowed: false, reason: 'mention_everyone', channel, context };
  }
  if (/<@&[0-9a-f-]{36}>/i.test(String(content || '')) && !context.permissions.has('manage_roles')) {
    return { allowed: false, reason: 'mention_role', channel, context };
  }
  return { allowed: true, reason: null, channel, context };
}

export async function getMemberContextById(serverId, targetUserId, connection = pool) {
  const [members] = await connection.execute('SELECT * FROM server_members WHERE server_id = ? AND user_id = ? LIMIT 1', [serverId, targetUserId]);
  const member = members[0];
  if (!member) return null;
  const [servers] = await connection.execute('SELECT owner_id FROM servers WHERE id = ? LIMIT 1', [serverId]);
  const [roles] = await connection.execute(
    'SELECT * FROM server_roles WHERE server_id = ? AND (is_default = ? OR id = ?) ORDER BY position ASC',
    [serverId, isPostgres ? true : 1, member.role_id || ''],
  );
  const highestPosition = servers[0]?.owner_id === targetUserId
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, ...roles.map((role) => Number(role.position || 0)));
  return { member, roles, highestPosition, isOwner: servers[0]?.owner_id === targetUserId };
}

export function canModerateMember(actor, target) {
  if (!actor?.member || !target?.member) return false;
  if (actor.isOwner) return target.member.user_id !== actor.member.user_id;
  if (target.member.user_id === actor.member.user_id) return false;
  return target.highestPosition < actor.highestPosition;
}

export function canAssignRole(actor, role) {
  if (!actor?.member || !role) return false;
  if (actor.isOwner) return true;
  if (Number(role.position || 0) >= actor.highestPosition) return false;
  const rolePermissions = parsePermissions(role.permissions);
  if (role.administrator) return actor.isOwner;
  for (const permission of rolePermissions) {
    if (!actor.permissions.has(permission)) return false;
  }
  return true;
}
