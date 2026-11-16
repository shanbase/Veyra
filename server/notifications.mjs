import { randomUUID, createSign } from 'node:crypto';
import { pool } from './db.mjs';
import { enqueueJob } from './queues.mjs';

const DEFAULT_SERVER = process.env.NTFY_SERVER_URL || 'https://ntfy.chat-amani.xyz';
const ALLOWED_HOSTS = ['ntfy.sh', 'ntfy.chat-amani.xyz'];
const templates = {
  dm: { title: 'New message from {user}', body: '{message}' },
  global: { title: '{user} in Global Chat', body: '{message}' },
  announcement: { title: 'Announcement from {user}', body: '{message}' },
};

function safeServer(value) {
  try {
    const url = new URL((value || DEFAULT_SERVER).replace(/\/+$/, ''));
    return ['https:', 'http:'].includes(url.protocol) && ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function render(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_match, key) => vars[key] ?? '');
}

async function publish(server, topic, title, message) {
  if (!safeServer(server) || !topic?.trim()) return false;
  try {
    const response = await fetch(server.replace(/\/+$/, ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic.trim(), title, message }),
    });
    return response.ok;
  } catch { return false; }
}

// Direct ntfy delivery used both inline and by the queue worker endpoint.
export async function deliverPushNotification({ server, topic, title, message }) {
  return publish(server, topic, title, message);
}

// ---------------------------------------------------------------------------
// Firebase Cloud Messaging (Android/iOS native push)
// ---------------------------------------------------------------------------
// Set FCM_SERVICE_ACCOUNT_JSON to the full service-account JSON downloaded
// from Firebase Console → Project settings → Service accounts. When unset,
// FCM delivery is silently skipped.

const b64url = (value) => Buffer.from(value).toString('base64url');
let fcmConfig;
let fcmAccessToken;
let fcmAccessTokenExpiry = 0;

function fcmServiceAccount() {
  if (fcmConfig !== undefined) return fcmConfig;
  try {
    const raw = String(process.env.FCM_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) { fcmConfig = null; return null; }
    const parsed = JSON.parse(raw);
    fcmConfig = {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: String(parsed.private_key || '').replace(/\\n/g, '\n'),
    };
    if (!fcmConfig.projectId || !fcmConfig.clientEmail || !fcmConfig.privateKey) fcmConfig = null;
  } catch {
    fcmConfig = null;
  }
  return fcmConfig;
}

async function getFcmAccessToken() {
  if (fcmAccessToken && Date.now() < fcmAccessTokenExpiry) return fcmAccessToken;
  const account = fcmServiceAccount();
  if (!account) return null;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: account.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.privateKey, 'base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`FCM auth failed: ${data.error || response.status}`);
  fcmAccessToken = data.access_token;
  fcmAccessTokenExpiry = Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 120) * 1000;
  return fcmAccessToken;
}

async function sendFcmNotification(token, title, body, data = {}) {
  const account = fcmServiceAccount();
  if (!account || !token) return false;
  try {
    const accessToken = await getFcmAccessToken();
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value ?? '')])),
          android: { priority: 'HIGH' },
        },
      }),
    });
    if (response.ok) return true;
    const errorBody = await response.json().catch(() => ({}));
    const code = errorBody?.error?.details?.[0]?.errorCode || '';
    // Retire dead tokens so we stop paying for failed sends.
    if (response.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') {
      await pool.execute('UPDATE native_push_tokens SET enabled = FALSE WHERE token = ?', [token]);
    }
    console.warn('FCM send failed:', response.status, code || errorBody?.error?.message || 'unknown');
    return false;
  } catch (error) {
    console.warn('FCM send error:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendTestNotification(userId) {
  const [rows] = await pool.execute('SELECT ntfy_server, ntfy_topic FROM notification_preferences WHERE user_id = ? LIMIT 1', [userId]);
  const topic = rows[0]?.ntfy_topic?.trim();
  if (!topic) return { ok: false, error: 'Set a topic first' };
  const ok = await publish(rows[0].ntfy_server, topic, 'Test notification', 'If you can see this, ntfy is set up correctly!');
  return { ok, error: ok ? null : 'The ntfy server is currently unavailable.' };
}

// Users without a notification_preferences row still get sane defaults that
// mirror the schema: DMs and announcements notify immediately, Global Chat
// stays off unless they opt in.
const DEFAULT_PREF = {
  ntfy_server: DEFAULT_SERVER,
  ntfy_topic: null,
  dm_mode: 'every',
  dm_custom_enabled: false,
  dm_title_template: templates.dm.title,
  dm_body_template: templates.dm.body,
  global_mode: 'off',
  global_custom_enabled: false,
  global_title_template: templates.global.title,
  global_body_template: templates.global.body,
  announcement_mode: 'every',
  announcement_custom_enabled: false,
  announcement_title_template: templates.announcement.title,
  announcement_body_template: templates.announcement.body,
  digest_cooldown_minutes: 15,
};

function mentionsUser(content, username) {
  if (!content || !username) return false;
  const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${escaped}(?=$|[^A-Za-z0-9_])`, 'i').test(content);
}

export async function notifyNewMessage(table, row) {
  const channel = table === 'messages' ? 'dm' : table === 'global_messages' ? 'global' : table === 'announcement_messages' ? 'announcement' : null;
  if (!channel || !row?.sender_id) return;
  const content = typeof row.content === 'string' ? row.content : '';
  const [senderRows] = await pool.execute('SELECT username, display_name FROM profiles WHERE id = ? LIMIT 1', [row.sender_id]);
  const sender = senderRows[0]?.display_name || senderRows[0]?.username || 'Someone';
  const [recipients] = channel === 'dm'
    ? await pool.execute('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? AND muted = FALSE', [row.conversation_id, row.sender_id])
    : channel === 'global'
      ? await pool.execute('SELECT id AS user_id FROM profiles WHERE id <> ? AND global_muted = FALSE', [row.sender_id])
      : await pool.execute('SELECT id AS user_id FROM profiles WHERE id <> ?', [row.sender_id]);
  const ids = [...new Set(recipients.map((r) => r.user_id))];
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const [prefs] = await pool.execute(`SELECT * FROM notification_preferences WHERE user_id IN (${placeholders})`, ids);
  const [profiles] = await pool.execute(`SELECT id, username FROM profiles WHERE id IN (${placeholders})`, ids);
  // status_mode is a 1.2.8 column — query it defensively so notifications keep
  // working if the API deploys ahead of the schema migration.
  const statusModeById = new Map();
  try {
    const [modes] = await pool.execute(`SELECT id, status_mode FROM profiles WHERE id IN (${placeholders})`, ids);
    for (const row of modes) statusModeById.set(row.id, row.status_mode);
  } catch { /* column not migrated yet */ }
  const usernameById = new Map(profiles.map((p) => [p.id, p.username]));
  // FCM device tokens for the same recipient set (empty when FCM isn't used).
  const [tokenRows] = await pool.execute(`SELECT user_id, token FROM native_push_tokens WHERE user_id IN (${placeholders}) AND enabled = TRUE`, ids);
  const tokensByUser = new Map();
  for (const row of tokenRows) {
    if (!tokensByUser.has(row.user_id)) tokensByUser.set(row.user_id, []);
    tokensByUser.get(row.user_id).push(row.token);
  }
  const prefByUser = new Map(prefs.map((pref) => [pref.user_id, pref]));
  const fcmData = {
    channel,
    conversation_id: row.conversation_id || '',
    sender_id: row.sender_id,
  };
  const sent = new Set();
  const channelKey = channel === 'dm' ? `dm:${row.conversation_id}` : channel;
  const mentionAll = /(^|\s)@everyone(?=$|[^A-Za-z0-9_])/i.test(content);

  for (const userId of ids) {
    const pref = { ...DEFAULT_PREF, ...(prefByUser.get(userId) || {}) };
    let mode = pref[`${channel}_mode`] || 'off';
    if (mode === 'off') continue;
    // A direct @mention (or @everyone) overrides the channel's default mode so
    // people actually see they were called out.
    const mentioned = channel !== 'dm' && (mentionAll || mentionsUser(content, usernameById.get(userId)));
    // do_not_disturb suppresses push/ntfy delivery but the user still shows as
    // online; direct @mentions break through since they are explicit calls.
    if (statusModeById.get(userId) === 'do_not_disturb' && !mentioned) continue;
    if (mentioned) mode = 'every';
    let title;
    let message;
    if (mode === 'digest' && !mentioned) {
      // Atomically claim the digest slot: the conditional UPDATE wins for
      // stale rows and INSERT IGNORE wins for first-time rows. Concurrent
      // senders serialize on the row so only one notification goes out.
      const cooldownSec = Math.max(1, Math.round(Number(pref.digest_cooldown_minutes || 10) * 60));
      const [updated] = await pool.execute(
        `UPDATE notification_digest_state SET last_notified_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND channel_key = ? AND last_notified_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${cooldownSec} SECOND)`,
        [userId, channelKey],
      );
      let claimed = updated.affectedRows > 0;
      if (!claimed) {
        const [inserted] = await pool.execute(
          'INSERT IGNORE INTO notification_digest_state (user_id, channel_key, last_notified_at) VALUES (?, ?, UTC_TIMESTAMP(3))',
          [userId, channelKey],
        );
        claimed = inserted.affectedRows > 0;
      }
      if (!claimed) continue;
      title = channel === 'dm' ? 'New messages' : channel === 'global' ? 'New global chat messages' : 'New announcements';
      message = channel === 'dm' ? 'You have new direct messages.' : channel === 'global' ? "There's new activity in Global Chat." : 'There are new announcements.';
    } else {
      const custom = !!pref[`${channel}_custom_enabled`];
      const titleTemplate = custom ? pref[`${channel}_title_template`] : templates[channel].title;
      const bodyTemplate = custom ? pref[`${channel}_body_template`] : templates[channel].body;
      title = render(titleTemplate, { user: sender, message: content || '(no text)' });
      message = render(bodyTemplate, { user: sender, message: content || '(no text)' });
    }
    // Native push goes to every registered device for this user — it does not
    // require an ntfy topic.
    for (const token of tokensByUser.get(userId) || []) {
      void sendFcmNotification(token, title, message, fcmData);
    }
    const topic = String(pref.ntfy_topic || '').trim();
    if (!topic) continue;
    const server = pref.ntfy_server || DEFAULT_SERVER;
    const dedupeKey = `${server.replace(/\/+$/, '')}|${topic}`;
    if (sent.has(dedupeKey)) continue;
    const job = { server, topic, title, message };
    const { delivered, result } = await enqueueJob('notifications.deliver', job, {
      idempotencyKey: `veyra-notify-${randomUUID()}`,
      fallback: () => deliverPushNotification(job),
    });
    const accepted = delivered === 'queued' || (delivered !== 'unavailable' && Boolean(result));
    if (accepted) sent.add(dedupeKey);
  }
}
