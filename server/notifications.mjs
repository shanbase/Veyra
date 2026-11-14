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

export async function notifyNewMessage(table, row) {
  const channel = table === 'messages' ? 'dm' : table === 'global_messages' ? 'global' : table === 'announcement_messages' ? 'announcement' : null;
  if (!channel || !row?.sender_id) return;
  const [senderRows] = await pool.execute('SELECT username, display_name FROM profiles WHERE id = ? LIMIT 1', [row.sender_id]);
  const sender = senderRows[0]?.display_name || senderRows[0]?.username || 'Someone';
  const [recipients] = channel === 'dm'
    ? await pool.execute('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? AND muted = FALSE', [row.conversation_id, row.sender_id])
    : channel === 'global'
      ? await pool.execute('SELECT np.user_id FROM notification_preferences np JOIN profiles p ON p.id = np.user_id WHERE np.user_id <> ? AND p.global_muted = FALSE', [row.sender_id])
      : await pool.execute('SELECT user_id FROM notification_preferences WHERE user_id <> ?', [row.sender_id]);
  const ids = [...new Set(recipients.map((r) => r.user_id))];
  if (!ids.length) return;
  const [prefs] = await pool.execute(`SELECT * FROM notification_preferences WHERE user_id IN (${ids.map(() => '?').join(',')})`, ids);
  // FCM device tokens for the same recipient set (empty when FCM isn't used).
  const [tokenRows] = await pool.execute(`SELECT user_id, token FROM native_push_tokens WHERE user_id IN (${ids.map(() => '?').join(',')}) AND enabled = TRUE`, ids);
  const tokensByUser = new Map();
  for (const row of tokenRows) {
    if (!tokensByUser.has(row.user_id)) tokensByUser.set(row.user_id, []);
    tokensByUser.get(row.user_id).push(row.token);
  }
  const fcmData = {
    channel,
    conversation_id: row.conversation_id || '',
    sender_id: row.sender_id,
  };
  const sent = new Set();
  const channelKey = channel === 'dm' ? `dm:${row.conversation_id}` : channel;

  for (const pref of prefs) {
    if (!pref.ntfy_topic) continue;
    const server = pref.ntfy_server || DEFAULT_SERVER;
    const topic = pref.ntfy_topic.trim();
    const dedupeKey = `${server.replace(/\/+$/, '')}|${topic}`;
    if (sent.has(dedupeKey)) continue;
    const mode = pref[`${channel}_mode`] || 'off';
    if (mode === 'off') continue;
    let title;
    let message;
    if (mode === 'digest') {
      const [state] = await pool.execute('SELECT last_notified_at FROM notification_digest_state WHERE user_id = ? AND channel_key = ? LIMIT 1', [pref.user_id, channelKey]);
      const cooldownMs = Number(pref.digest_cooldown_minutes || 10) * 60_000;
      if (state[0] && Date.now() - new Date(state[0].last_notified_at).getTime() < cooldownMs) continue;
      await pool.execute(`INSERT INTO notification_digest_state (user_id, channel_key, last_notified_at) VALUES (?, ?, CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE last_notified_at = CURRENT_TIMESTAMP(3)`, [pref.user_id, channelKey]);
      title = channel === 'dm' ? 'New messages' : channel === 'global' ? 'New global chat messages' : 'New announcements';
      message = channel === 'dm' ? 'You have new direct messages.' : channel === 'global' ? "There's new activity in Global Chat." : 'There are new announcements.';
    } else {
      const custom = !!pref[`${channel}_custom_enabled`];
      const titleTemplate = custom ? pref[`${channel}_title_template`] : templates[channel].title;
      const bodyTemplate = custom ? pref[`${channel}_body_template`] : templates[channel].body;
      title = render(titleTemplate, { user: sender, message: row.content || '(no text)' });
      message = render(bodyTemplate, { user: sender, message: row.content || '(no text)' });
    }
    const job = { server, topic, title, message };
    const { delivered, result } = await enqueueJob('notifications.deliver', job, {
      idempotencyKey: `veyra-notify-${randomUUID()}`,
      fallback: () => deliverPushNotification(job),
    });
    const accepted = delivered === 'queued' || (delivered !== 'unavailable' && Boolean(result));
    if (accepted) sent.add(dedupeKey);
    // Native push goes to every registered device for this user, independent
    // of their ntfy topic configuration.
    for (const token of tokensByUser.get(pref.user_id) || []) {
      void sendFcmNotification(token, title, message, fcmData);
    }
  }
}
