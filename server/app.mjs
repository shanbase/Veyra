import express from 'express';
import { createHash } from 'node:crypto';
import { pool, isPostgres } from './db.mjs';
import { queryData } from './data.mjs';
import { callRpc } from './rpc.mjs';
import { sendTestNotification, deliverPushNotification } from './notifications.mjs';
import { purgeExpiredAttachments, cleanupExpiredAuthArtifacts } from './maintenance.mjs';
import { authenticateRequest, registerAuthRoutes } from './auth.mjs';
import { changesFromRpc, changeFromDataRequest, mariaDbRealtimeTopic, mariaDbConversationTopic, publishMariaDbChanges } from './realtime.mjs';
import { getSupabaseAdmin } from './supabase-admin.mjs';
import { invalidateReadCache, consumeRateLimit, redisGetJson, redisSetJson, ezmsgStats } from './redis.mjs';
import { assertEncryptionConfig, encryptionEnabled } from './encryption.mjs';
import { u3StorageEnabled, u3Config, u3ObjectUrl, u3PresignUpload, u3PresignDownload } from './storage.mjs';
import { assertQueuesConfig } from './queues.mjs';

const MAX_PROFILE_IMAGE_BYTES = 25 * 1024 * 1024;

// Maintenance mode: env MAINTENANCE_MODE=true forces it on, =false forces it
// off; otherwise a Redis flag (veyra:v1:maintenance = 1) toggles it at runtime
// without a redeploy. Redis is best-effort — unreachable means "off".
const MAINTENANCE_REDIS_KEY = 'veyra:v1:maintenance';
async function isMaintenanceMode() {
  const env = String(process.env.MAINTENANCE_MODE || '').trim().toLowerCase();
  if (env === 'true' || env === '1' || env === 'yes') return true;
  if (env === 'false' || env === '0' || env === 'no') return false;
  try {
    const flag = await redisGetJson(MAINTENANCE_REDIS_KEY);
    return flag === 1 || flag === '1' || flag === true;
  } catch {
    return false;
  }
}
const PROFILE_UPLOAD_TYPES = new Set(['image/jpeg', 'image/gif']);
// Banners additionally accept short muted video (clients enforce the 5s cap);
// avatars stay image-only.
const BANNER_UPLOAD_TYPES = new Set([...PROFILE_UPLOAD_TYPES, 'video/mp4', 'video/webm']);
const CHAT_UPLOAD_BUCKETS = new Set(['chat-images', 'chat-videos', 'chat-voice']);
// Per-bucket caps mirror the Supabase bucket file-size limits: images and
// videos get 50 MB, voice notes 45 MB. MAX_CHAT_UPLOAD_BYTES is a hard global
// ceiling regardless of bucket so a misconfigured map can never exceed it.
const CHAT_UPLOAD_LIMITS = {
  'chat-images': 50 * 1024 * 1024,
  'chat-videos': 50 * 1024 * 1024,
  'chat-voice': 45 * 1024 * 1024,
};
const MAX_CHAT_UPLOAD_BYTES = Math.max(...Object.values(CHAT_UPLOAD_LIMITS));

function chatUploadLimitLabel(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// In-memory fixed-window fallback for rate limits when Redis is not
// configured, mirroring auth.mjs's allowRequest buckets.
const localRateBuckets = new Map();
function consumeLocalRateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (localRateBuckets.size > 10000) {
    for (const [bucketKey, bucket] of localRateBuckets) {
      if (bucket.until <= now) localRateBuckets.delete(bucketKey);
    }
  }
  const bucket = localRateBuckets.get(key);
  if (!bucket || bucket.until <= now) {
    localRateBuckets.set(key, { count: 1, until: now + windowMs });
    return { allowed: true };
  }
  bucket.count++;
  return { allowed: bucket.count <= limit };
}

async function consumeRequestRateLimit(key, limit, windowMs) {
  const shared = await consumeRateLimit(key, limit, windowMs);
  if (shared) return shared;
  return consumeLocalRateLimit(key, limit, windowMs);
}

const INFRA_ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'ECONNABORTED']);
function isInfraError(error) {
  return INFRA_ERROR_CODES.has(error?.code)
    || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|pool|timeout|connect/i.test(String(error?.message || ''));
}

export function createApp() {
  const app = express();
  const missingDbConfig = isPostgres
    ? !process.env.POSTGRES_USER || !process.env.POSTGRES_DATABASE
    : !process.env.MARIADB_USER || !process.env.MARIADB_DATABASE;
  if (missingDbConfig) {
    throw new Error(isPostgres
      ? 'POSTGRES_USER and POSTGRES_DATABASE are required when USE_MARIADB=false.'
      : 'MARIADB_USER and MARIADB_DATABASE are required.');
  }
  assertEncryptionConfig();
  if (!encryptionEnabled()) {
    console.warn('MESSAGE_ENCRYPTION_KEY is not set; message content will be stored without database encryption.');
  }
  assertQueuesConfig();
  app.disable('x-powered-by');
  // Vercel/other reverse proxies append the real client IP to X-Forwarded-For;
  // trusting one hop makes req.ip (used by auth rate limits) the client IP.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Voice messages need the microphone; nothing else is required.
    res.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    // Broad-by-design CSP: the app talks to Supabase (realtime/storage),
    // GIPHY, hCaptcha, and the configured API origin, so connect/img/media
    // stay permissive while scripts and frames are locked down.
    res.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' https://js.hcaptcha.com https://*.hcaptcha.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-src https://*.hcaptcha.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    if (process.env.NODE_ENV === 'production' && String(process.env.APP_URL || '').startsWith('https://')) {
      res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    next();
  });
  app.use((req, _res, next) => {
    const requestUrl = new URL(req.url || '/', 'http://veyra.local');
    const apiPath = requestUrl.searchParams.get('apiPath') || requestUrl.searchParams.get('__api_path');
    if (apiPath) {
      requestUrl.searchParams.delete('apiPath');
      requestUrl.searchParams.delete('__api_path');
      req.url = `/api/${apiPath.replace(/^\/+/, '')}${requestUrl.search}`;
    }
    next();
  });
  registerAuthRoutes(app);
  app.get('/api/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
    catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
  });
  // Public release-metadata proxy. Clients (Android WebView, desktop, web)
  // cannot always fetch GitHub release downloads directly — redirects to asset
  // hosts break CORS — so the API fetches latest.json server-side and caches it.
  // Configurable so forks/renames don't need a code change; falls back to the
  // canonical repo's latest.json.
  const RELEASE_METADATA_URL = process.env.RELEASE_METADATA_URL
    || `https://github.com/${process.env.GITHUB_REPOSITORY || 'ShanLim655/Veyra'}/releases/latest/download/latest.json`;
  let releaseCache = { at: 0, body: null };
  app.get('/api/maintenance', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ maintenance: await isMaintenanceMode() });
  });
  // Admin-only runtime toggle. Registered before the /api auth middleware so
  // it stays reachable while maintenance is on (otherwise you could never
  // turn maintenance off through the API). Requires Redis — without it, use
  // the MAINTENANCE_MODE env var instead.
  app.post('/api/maintenance', (req, res) => {
    authenticateRequest(req, res, async () => {
      try {
        const [rows] = await pool.execute("SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('admin','super_admin') LIMIT 1", [req.user.id]);
        if (!rows.length) return res.status(403).json({ error: 'Admin access required.' });
        const enabled = req.body?.enabled === true || req.body?.enabled === 'true' || req.body?.enabled === 1 || req.body?.enabled === '1';
        await redisSetJson(MAINTENANCE_REDIS_KEY, enabled ? 1 : 0);
        const confirmed = await isMaintenanceMode();
        if (confirmed !== enabled) {
          return res.status(503).json({ error: 'Redis is unavailable — set MAINTENANCE_MODE env var instead.' });
        }
        res.json({ maintenance: enabled });
      } catch {
        res.status(500).json({ error: 'Could not update maintenance mode.' });
      }
    });
  });
  app.get('/api/app-version', async (_req, res) => {
    try {
      if (releaseCache.body && Date.now() - releaseCache.at < 5 * 60_000) {
        return res.json(releaseCache.body);
      }
      const response = await fetch(RELEASE_METADATA_URL, {
        signal: AbortSignal.timeout(6000),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        // Keep serving a stale copy rather than flapping between "no release"
        // and an error when GitHub hiccups.
        if (releaseCache.body) return res.json(releaseCache.body);
        return res.status(404).json({ error: 'no_release' });
      }
      const body = await response.json();
      releaseCache = { at: Date.now(), body };
      res.json(body);
    } catch {
      if (releaseCache.body) return res.json(releaseCache.body);
      res.status(503).json({ error: 'release_unavailable' });
    }
  });
  app.use('/api', async (req, res, next) => {
    if (req.path === '/health') return next();
    if (req.path === '/maintenance/purge-expired-attachments' && process.env.PURGE_CRON_SECRET && req.get('x-cron-secret') === process.env.PURGE_CRON_SECRET) {
      req.cronAuthorized = true;
      return next();
    }
    if (req.path === '/queues/deliver' && process.env.QUEUES_WORKER_SECRET && req.get('x-queue-worker-secret') === process.env.QUEUES_WORKER_SECRET) {
      req.queueWorkerAuthorized = true;
      return next();
    }
    // Maintenance mode locks down every API route except the public status
    // probe itself (registered above, so it never reaches this middleware).
    if (await isMaintenanceMode()) {
      return res.status(503).json({ error: 'maintenance' });
    }
    authenticateRequest(req, res, next);
  });
  app.post('/api/data', async (req, res) => {
    try {
      // Generous per-user ceiling; Redis-backed when configured, in-memory
      // otherwise so the query engine always has a throughput bound.
      const limited = await consumeRequestRateLimit(`data:${req.user.id}`, 600, 60_000);
      if (limited && !limited.allowed) {
        return res.status(429).json({ error: 'Too many requests. Please slow down and try again.' });
      }
      const result = await queryData(req.user.id, req.body);
      const change = changeFromDataRequest(req.body, result);
      // EZMSG-queued inserts are published by the drain worker once the row
      // is actually persisted — broadcasting now would point clients at a
      // message that does not exist in MariaDB yet.
      if (change && !result.queued) await publishMariaDbChanges([change], req.user.id);
      const response = { ...result };
      delete response.realtimeRows;
      delete response.queued;
      res.json(response);
    }
    catch (error) {
      // Never leak driver/internal error details to clients.
      if (typeof error?.code === 'string' && error.code.startsWith('ER_')) {
        console.error('Data request failed:', error);
        return res.status(500).json({ error: 'The server could not complete the request.' });
      }
      if (isInfraError(error)) {
        console.error('Data request infrastructure failure:', error);
        return res.status(503).json({ error: 'The service is temporarily unavailable. Please try again.' });
      }
      const status = /not allowed|unknown table|unsupported|too many/i.test(error.message) ? 403 : 400;
      res.status(status).json({ error: error.message || 'Database request failed.' });
    }
  });
  app.post('/api/rpc', async (req, res) => {
    try {
      const name = req.body?.name;
      const args = req.body?.args || {};
      const data = await callRpc(req.user.id, name, args);
      const changes = changesFromRpc(name, args, data);
      if (changes.length) {
        await Promise.all([...new Set(changes.map((change) => change.table))].map(invalidateReadCache));
        await publishMariaDbChanges(changes, req.user.id);
      }
      res.json({ data });
    }
    catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('ER_')) {
        console.error('RPC request failed:', error);
        return res.status(500).json({ error: 'The server could not complete the request.' });
      }
      if (isInfraError(error)) {
        console.error('RPC request infrastructure failure:', error);
        return res.status(503).json({ error: 'The service is temporarily unavailable. Please try again.' });
      }
      const status = /not allowed|admin access|unsupported|only the|must be|access required/i.test(error.message) ? 403 : 400;
      res.status(status).json({ error: error.message || 'Database action failed.' });
    }
  });
  // Admin-only EZMSG write-behind diagnostics: queue depth, in-flight
  // processing items, parked retries, and dead-letter count. Returns nulls
  // when Redis is not configured (EZMSG is off in that case anyway).
  app.get('/api/admin/ezmsg-stats', async (req, res) => {
    try {
      const [rows] = await pool.execute("SELECT 1 FROM user_roles WHERE user_id = ? AND role IN ('admin','super_admin') LIMIT 1", [req.user.id]);
      if (!rows.length) return res.status(403).json({ error: 'Admin access required.' });
      res.json({ ezmsg: await ezmsgStats(), enabled: process.env.REDIS_EZMSG === 'true' && !process.env.VERCEL });
    } catch {
      res.status(500).json({ error: 'Could not read queue stats.' });
    }
  });
  app.post('/api/notifications/test', async (req, res) => {
    try { res.json(await sendTestNotification(req.user.id)); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.get('/api/realtime/topic', async (req, res) => {
    try {
      const conversationId = String(req.query.conversation_id || '');
      if (conversationId) {
        // Conversation topics are only handed to actual members — the topic
        // name itself is an HMAC, but membership is still verified so a leaked
        // id cannot subscribe a non-member to live message traffic.
        const [members] = await pool.execute(
          'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1',
          [conversationId, req.user.id],
        );
        if (!members.length) return res.status(403).json({ error: 'Not a member of this conversation.' });
        return res.json({ topic: mariaDbConversationTopic(conversationId) });
      }
      res.json({ topic: mariaDbRealtimeTopic(req.user.id) });
    } catch (error) { res.status(503).json({ error: error.message || 'Live updates are not configured.' }); }
  });
  app.post('/api/storage/profile-upload', async (req, res) => {
    const { bucket, contentType, size } = req.body || {};
    if (!['avatars', 'banners'].includes(bucket)) return res.status(400).json({ error: 'Unsupported profile image bucket.' });
    const allowedTypes = bucket === 'banners' ? BANNER_UPLOAD_TYPES : PROFILE_UPLOAD_TYPES;
    if (!allowedTypes.has(contentType)) {
      return res.status(400).json({ error: bucket === 'banners' ? 'Only JPEG, GIF, and MP4/WebM banner media are supported.' : 'Only JPEG and GIF profile images are supported.' });
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_PROFILE_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Maximum file size is 25 MB.' });
    }

    const limited = await consumeRequestRateLimit(`profile-upload:${req.user.id}`, 60, 60_000);
    if (limited && !limited.allowed) {
      return res.status(429).json({ error: 'Too many uploads. Please slow down and try again.' });
    }
    if (u3StorageEnabled()) {
      const cfg = u3Config(bucket);
      if (!cfg) return res.status(503).json({ error: 'Profile image storage is not configured.' });
      try {
        const path = `${req.user.id}/${bucket === 'avatars' ? 'avatar' : 'banner'}`;
        const uploadUrl = await u3PresignUpload(bucket, path);
        res.json({ mode: 'u3', path, uploadUrl, publicUrl: u3ObjectUrl(bucket, path), contentType });
      } catch (error) {
        console.error('Profile image upload link failed:', error);
        res.status(503).json({ error: 'Profile image storage is not configured.' });
      }
      return;
    }
    try {
      const path = `${req.user.id}/${bucket === 'avatars' ? 'avatar' : 'banner'}`;
      const { data, error } = await getSupabaseAdmin().storage.from(bucket).createSignedUploadUrl(path, { upsert: true });
      if (error || !data?.token) throw error || new Error('Could not create a secure upload link.');
      const { data: publicData } = getSupabaseAdmin().storage.from(bucket).getPublicUrl(path);
      res.json({ path, token: data.token, publicUrl: publicData.publicUrl });
    } catch (error) {
      console.error('Profile image upload link failed:', error);
      res.status(503).json({ error: 'Profile image storage is not configured.' });
    }
  });
  app.post('/api/storage/chat-upload', async (req, res) => {
    const { bucket, path, contentType, size } = req.body || {};
    const pathParts = typeof path === 'string' ? path.split('/') : [];
    if (!CHAT_UPLOAD_BUCKETS.has(bucket) || typeof path !== 'string' || path.length > 512
      || pathParts[0] !== req.user.id || pathParts.length < 3 || pathParts.length > 8
      || pathParts.some((part) => !part || part === '.' || part === '..')) {
      return res.status(400).json({ error: 'Invalid chat upload path.' });
    }
    // The folder segment scopes who can later read the file via chat-read:
    // 'global'/'announcements' are world-readable, anything else must be a
    // conversation the uploader actually belongs to.
    const scope = pathParts[1];
    if (scope !== 'global' && scope !== 'announcements') {
      const [members] = await pool.execute(
        'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1',
        [scope, req.user.id],
      );
      if (!members.length) return res.status(403).json({ error: 'You cannot upload media to this conversation.' });
    }
    const limited = await consumeRequestRateLimit(`chat-upload:${req.user.id}`, 120, 60_000);
    if (limited && !limited.allowed) {
      return res.status(429).json({ error: 'Too many uploads. Please slow down and try again.' });
    }
    const maxBytes = Math.min(CHAT_UPLOAD_LIMITS[bucket] ?? MAX_CHAT_UPLOAD_BYTES, MAX_CHAT_UPLOAD_BYTES);
    if (!Number.isFinite(size) || size <= 0 || size > maxBytes) {
      return res.status(413).json({ error: `Maximum file size is ${chatUploadLimitLabel(maxBytes)}.` });
    }
    if (u3StorageEnabled()) {
      if (!u3Config(bucket)) return res.status(503).json({ error: 'Chat media storage is not configured.' });
      try {
        const uploadUrl = await u3PresignUpload(bucket, path);
        res.json({ mode: 'u3', path, uploadUrl, publicUrl: u3ObjectUrl(bucket, path), contentType });
      } catch (error) {
        console.error('Chat media upload link failed:', error);
        res.status(503).json({ error: 'Chat media storage is not configured.' });
      }
      return;
    }
    try {
      const { data, error } = await getSupabaseAdmin().storage.from(bucket).createSignedUploadUrl(path);
      if (error || !data?.token) throw error || new Error('Could not create upload link.');
      const { data: publicData } = getSupabaseAdmin().storage.from(bucket).getPublicUrl(path);
      res.json({ path, token: data.token, publicUrl: publicData.publicUrl, contentType });
    } catch (error) {
      console.error('Chat media upload link failed:', error);
      res.status(503).json({ error: 'Chat media storage is not configured.' });
    }
  });
  app.post('/api/storage/chat-read', async (req, res) => {
    const storage = getSupabaseAdmin();
    const batch = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : null;
    const items = batch || [req.body || {}];
    const validated = [];
    for (const item of items) {
      const { bucket, path } = item || {};
      const parts = typeof path === 'string' ? path.split('/') : [];
      if (!CHAT_UPLOAD_BUCKETS.has(bucket) || parts.length < 3 || parts.length > 8
        || parts.some((part) => !part || part === '.' || part === '..') || path.length > 512) {
        return res.status(400).json({ error: 'Invalid media path.' });
      }
      validated.push({ bucket, path, scope: parts[1] });
    }
    try {
      // One membership lookup per conversation scope covers every item in the batch.
      const scopes = [...new Set(validated.map((item) => item.scope))]
        .filter((scope) => scope !== 'global' && scope !== 'announcements');
      for (const scope of scopes) {
        const [members] = await pool.execute(
          'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1',
          [scope, req.user.id],
        );
        if (!members.length) return res.status(403).json({ error: 'You cannot access this conversation media.' });
      }
      if (u3StorageEnabled()) {
        // U3 mode: chat buckets stay private — membership was verified above,
        // now mint short-lived presigned GETs. Cache them like the Supabase
        // signed URLs (50 min of a 60 min lifetime).
        const u3SignCacheKey = ({ bucket, path }) =>
          `veyra:v1:sign:u3:${bucket}:${createHash('sha256').update(path).digest('hex').slice(0, 32)}`;
        const signed = await Promise.all(validated.map(async ({ bucket, path }) => {
          const key = u3SignCacheKey({ bucket, path });
          const cached = await redisGetJson(key);
          if (cached) return { key: `${bucket}/${path}`, url: cached };
          const url = await u3PresignDownload(bucket, path).catch(() => null);
          if (url) await redisSetJson(key, url, 3000);
          return { key: `${bucket}/${path}`, url };
        }));
        if (batch) {
          const urls = {};
          for (const entry of signed) if (entry.url) urls[entry.key] = entry.url;
          res.set('Cache-Control', 'private, max-age=300').json({ urls, expiresIn: 3600 });
          return;
        }
        const url = signed[0]?.url;
        if (!url) return res.status(404).json({ error: 'Media is missing or unavailable.' });
        res.set('Cache-Control', 'private, max-age=300').json({ url, expiresIn: 3600 });
        return;
      }
      // Signed URLs are bearer credentials but identical for every authorized
      // viewer of the same object — cache them in Redis for 50 minutes (the
      // URLs themselves live 60) to avoid a Supabase round-trip per view.
      const signCacheKey = ({ bucket, path }) =>
        `veyra:v1:sign:${bucket}:${createHash('sha256').update(path).digest('hex').slice(0, 32)}`;
      const signed = await Promise.all(validated.map(async ({ bucket, path }) => {
        const key = signCacheKey({ bucket, path });
        const cached = await redisGetJson(key);
        if (cached) return { key: `${bucket}/${path}`, url: cached };
        const { data, error } = await storage.storage.from(bucket).createSignedUrl(path, 3600);
        const url = error ? null : data?.signedUrl || null;
        if (url) await redisSetJson(key, url, 3000);
        return { key: `${bucket}/${path}`, url };
      }));
      if (batch) {
        const urls = {};
        for (const entry of signed) if (entry.url) urls[entry.key] = entry.url;
        res.set('Cache-Control', 'private, max-age=300').json({ urls, expiresIn: 3600 });
        return;
      }
      const url = signed[0]?.url;
      if (!url) return res.status(404).json({ error: 'Media is missing or unavailable.' });
      res.set('Cache-Control', 'private, max-age=300').json({ url, expiresIn: 3600 });
    } catch (error) {
      console.error('Chat media read signing failed:', error);
      res.status(503).json({ error: 'Chat media storage is unavailable.' });
    }
  });
  // Worker endpoint for optional Altare Queues consumers. A queue worker posts
  // jobs of type "notifications.deliver" here to perform the actual ntfy send.
  app.post('/api/queues/deliver', async (req, res) => {
    if (!req.queueWorkerAuthorized) return res.status(403).json({ error: 'Queue worker authorization required.' });
    const { server, topic, title, message } = req.body || {};
    try {
      const ok = await deliverPushNotification({ server, topic, title, message });
      res.json({ ok });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Notification delivery failed.' });
    }
  });
  app.post('/api/maintenance/purge-expired-attachments', async (req, res) => {
    if (!req.cronAuthorized) {
      const [rows] = await pool.execute("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'super_admin' LIMIT 1", [req.user.id]);
      if (!rows.length) return res.status(403).json({ error: 'Super admin access required.' });
    }
    try {
      const attachments = await purgeExpiredAttachments();
      const authCleanup = await cleanupExpiredAuthArtifacts();
      res.json({ ...attachments, authCleanup });
    }
    catch (error) { res.status(500).json({ error: error.message || 'Attachment cleanup failed.' }); }
  });
  app.use((error, _req, res, _next) => {
    console.error('API request failed:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'The server could not complete the request.' });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  return app;
}
