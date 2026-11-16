import { createHash } from 'node:crypto';
import { createClient } from 'redis';

const redisUrl = String(process.env.REDIS_URL || '').trim();
const inFlight = new Map();
const MAX_IN_FLIGHT = 500;
let client;
let connectPromise;
let redisDisabledUntil = 0;

function getClient() {
  if (!redisUrl || Date.now() < redisDisabledUntil) return null;
  if (!client) {
    client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 1500,
        reconnectStrategy: (retries) => (retries > 2 ? false : Math.min(250 * 2 ** retries, 1000)),
      },
    });
    client.on('error', (error) => console.warn('Redis unavailable; using MariaDB path:', error.message));
    client.on('end', () => { redisDisabledUntil = Date.now() + 2000; });
  }
  return client;
}

async function readyClient() {
  const current = getClient();
  if (!current) return null;
  if (current.isReady) return current;
  if (!connectPromise) {
    connectPromise = current.connect().catch((error) => {
      redisDisabledUntil = Date.now() + 5000;
      console.warn('Redis connection failed; using MariaDB path:', error.message);
      return null;
    }).finally(() => { connectPromise = undefined; });
  }
  return connectPromise;
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function coalesce(key, operation) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  if (inFlight.size >= MAX_IN_FLIGHT) inFlight.delete(inFlight.keys().next().value);
  const pending = Promise.resolve().then(operation).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

export async function cachedRead(userId, table, payload, operation) {
  const requestKey = digest(JSON.stringify([userId, table, payload]));
  return coalesce(requestKey, async () => {
    const redis = await readyClient();
    if (!redis) return operation();
    const epochKey = `veyra:v1:epoch:${table}`;
    let valueKey;
    let cached;
    try {
      const epoch = await redis.get(epochKey) || '0';
      valueKey = `veyra:v1:read:${table}:${epoch}:${requestKey}`;
      cached = await redis.get(valueKey);
      if (cached) return JSON.parse(cached);
    } catch (error) {
      console.warn('Redis read cache failed; using MariaDB:', error.message);
      redisDisabledUntil = Date.now() + 2000;
      return operation();
    }

    // Keep database failures outside the Redis fallback catch so a failed
    // MariaDB query is never accidentally issued a second time.
    const value = await operation();
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) <= 256 * 1024) {
      try { await redis.set(valueKey, serialized, { EX: 2 }); }
      catch (error) {
        console.warn('Redis cache write failed; returning MariaDB result:', error.message);
        redisDisabledUntil = Date.now() + 2000;
      }
    }
    return value;
  });
}

const RATE_LIMIT_PREFIX = 'veyra:v1:ratelimit:';

// Atomic INCR+PEXPIRE: a crash between separate commands could leave a
// counter with no TTL (permanent lockout), and legacy no-TTL keys are
// healed on the next hit. EVAL keeps it to a single roundtrip.
const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

// Fixed-window rate limit backed by Redis so limits hold across serverless
// instances and restarts. Returns null when Redis is unavailable so callers
// can fall back to their local in-memory limiter.
export async function consumeRateLimit(key, limit, windowMs) {
  const redis = await readyClient();
  if (!redis) return null;
  try {
    const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
    const count = await redis.sendCommand(['EVAL', RATE_LIMIT_LUA, '1', fullKey, String(windowMs)]);
    return { allowed: count <= limit, count, limit };
  } catch (error) {
    console.warn('Redis rate limit failed; caller should use its fallback:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return null;
  }
}

const REALTIME_STREAM = 'veyra:v1:realtime-outbox';

export async function enqueueRealtimeBatch(messages) {
  const redis = await readyClient();
  if (!redis) return null;
  try {
    return await redis.sendCommand([
      'XADD', REALTIME_STREAM, 'MAXLEN', '~', '10000', '*', 'batch', JSON.stringify(messages),
    ]);
  } catch (error) {
    console.warn('Redis realtime queue unavailable; broadcasting directly:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return null;
  }
}

export async function pendingRealtimeBatches(limit = 20) {
  const redis = await readyClient();
  if (!redis) return [];
  try {
    const entries = await redis.xRange(REALTIME_STREAM, '-', '+', { COUNT: limit });
    return entries.map(({ id, message }) => ({
      id,
      messages: JSON.parse(message.batch || '[]'),
    }));
  } catch (error) {
    console.warn('Redis realtime queue read failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return [];
  }
}

export async function acknowledgeRealtimeBatch(id) {
  const redis = await readyClient();
  if (!redis) return;
  try { await redis.xDel(REALTIME_STREAM, id); }
  catch (error) { console.warn('Redis realtime acknowledgement failed:', error.message); }
}

// Generic JSON helpers for small auxiliary caches (schema metadata, admin
// flags, member lists, signed URLs, sessions). Every helper degrades to a
// no-op/null when Redis is unavailable so callers always have a DB fallback.
export async function redisGetJson(key) {
  const redis = await readyClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('Redis get failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return null;
  }
}

export async function redisSetJson(key, value, ttlSeconds) {
  const redis = await readyClient();
  if (!redis) return;
  try { await redis.set(key, JSON.stringify(value), { EX: ttlSeconds }); }
  catch (error) {
    console.warn('Redis set failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
  }
}

export async function redisDel(...keys) {
  const redis = await readyClient();
  if (!redis || !keys.length) return;
  try { await redis.del(keys); }
  catch (error) {
    console.warn('Redis delete failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
  }
}

// EZMSG write-behind queue (REDIS_EZMSG=true only): message inserts are
// RPUSHed here and a drain worker persists them to MariaDB. Items move through
// a processing list so a crash mid-drain does not silently drop messages —
// ezmsgRecover() returns them to the queue on the next drain.
const EZMSG_QUEUE = 'veyra:v1:ezmsg:queue';
const EZMSG_PROCESSING = 'veyra:v1:ezmsg:processing';
const EZMSG_FAILED = 'veyra:v1:ezmsg:failed';

export async function ezmsgPush(item) {
  const redis = await readyClient();
  if (!redis) return false;
  try {
    await redis.rPush(EZMSG_QUEUE, JSON.stringify(item));
    return true;
  } catch (error) {
    console.warn('EZMSG enqueue failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return false;
  }
}

export async function ezmsgPop() {
  const redis = await readyClient();
  if (!redis) return null;
  try { return await redis.sendCommand(['RPOPLPUSH', EZMSG_QUEUE, EZMSG_PROCESSING]); }
  catch (error) {
    console.warn('EZMSG dequeue failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return null;
  }
}

export async function ezmsgAck(raw) {
  const redis = await readyClient();
  if (!redis || !raw) return;
  try { await redis.lRem(EZMSG_PROCESSING, 1, raw); }
  catch (error) { console.warn('EZMSG acknowledge failed:', error.message); }
}

export async function ezmsgRecover() {
  const redis = await readyClient();
  if (!redis) return;
  try {
    const items = await redis.lRange(EZMSG_PROCESSING, 0, -1);
    if (!items.length) return;
    await redis.rPush(EZMSG_QUEUE, items);
    await redis.del(EZMSG_PROCESSING);
  } catch (error) { console.warn('EZMSG recovery failed:', error.message); }
}

export async function ezmsgPending(limit = 500) {
  const redis = await readyClient();
  if (!redis) return [];
  try {
    const items = await redis.lRange(EZMSG_QUEUE, 0, Math.max(0, limit - 1));
    return items
      .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(Boolean);
  } catch (error) {
    console.warn('EZMSG pending scan failed:', error.message);
    redisDisabledUntil = Date.now() + 2000;
    return [];
  }
}

export async function ezmsgMarkFailed(item, error) {
  const redis = await readyClient();
  if (!redis) return;
  try {
    await redis.rPush(EZMSG_FAILED, JSON.stringify({
      item,
      error: String(error?.message || error),
      at: new Date().toISOString(),
    }));
    // Cap the dead-letter list so a sustained drain failure cannot grow it
    // without bound — keep the newest 1000 entries.
    await redis.lTrim(EZMSG_FAILED, -1000, -1);
  } catch (redisError) { console.warn('EZMSG failure recording failed:', redisError.message); }
}

// Short TTL: role changes are security-sensitive, so out-of-band edits
// (direct SQL, another admin path) propagate within a minute even if the
// explicit invalidation on user_roles writes is somehow bypassed.
const ROLE_TTL_SECONDS = 60;

// Admin/super-admin flags are read on nearly every API request. Cache them
// per user; writes to user_roles invalidate the specific users' keys (see
// invalidateUserRole) so changes propagate immediately.
export async function cachedUserRoles(userId) {
  const key = `veyra:v1:roles:${userId}`;
  const cached = await redisGetJson(key);
  if (cached && typeof cached.admin === 'boolean' && typeof cached.super === 'boolean') return cached;
  // Lazy import: pulling db.mjs in at module load would keep scripts/tests
  // that only need Redis helpers alive on an open DB pool.
  const { pool } = await import('./db.mjs');
  const [rows] = await pool.execute('SELECT role FROM user_roles WHERE user_id = ?', [userId]);
  const roles = { admin: false, super: false };
  for (const row of rows) {
    if (row.role === 'admin') roles.admin = true;
    if (row.role === 'super_admin') roles.super = true;
  }
  await redisSetJson(key, roles, ROLE_TTL_SECONDS);
  return roles;
}

export async function invalidateUserRole(...userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length) await redisDel(...ids.map((id) => `veyra:v1:roles:${id}`));
}

export async function invalidateReadCache(table) {
  const redis = await readyClient();
  if (!redis) return;
  const affectedTables = table === 'conversation_members'
    ? ['conversation_members', 'messages', 'conversations']
    : table === 'user_roles'
      ? ['user_roles', 'messages', 'conversations', 'profiles', 'global_messages', 'announcement_messages']
      : [table];
  try {
    await Promise.all(affectedTables.map((affected) => redis.incr(`veyra:v1:epoch:${affected}`)));
  } catch (error) {
    console.warn('Redis cache invalidation failed; short cache TTL remains:', error.message);
    redisDisabledUntil = Date.now() + 2000;
  }
}

export async function closeRedis() {
  if (client?.isOpen) await client.quit();
}
