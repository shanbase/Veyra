#!/usr/bin/env node
// Veyra load-test harness (plans/1.2.8.md — scalability workstream).
//
// Covers the API side of the concurrency ladder: N users logging in, sending
// messages, and reading history against a staging deployment. Realtime
// websocket fan-out should be measured separately with a Supabase Realtime
// client; this script stays dependency-free (global fetch, Node 20+).
//
// Usage:
//   node scripts/load-test.mjs --url https://staging.example.com \
//     --users user1@example.com:pass1,user2@example.com:pass2 \
//     --channel global --messages 20 --concurrency 10
//
// Options:
//   --url          API origin (default http://127.0.0.1:3001)
//   --users        comma-separated email:password pairs
//                  (or VEYRA_LOAD_USERS env). NOTE: /api/auth/login enforces
//                  hCaptcha when HCAPTCHA_SECRET is configured — point this at
//                  a staging env with captcha disabled, or it will 400.
//   --messages     messages per user (default 10)
//   --concurrency  max users in flight (default = all users at once = burst)
//   --channel      'global' (default), 'announcements', or a DM conversation_id
//   --ramp-ms      delay between starting each user (default 0 = burst)
//   --warmup       run one untimed send+read first (default on; --warmup=false off)
//
// Auth is cookie-based (veyra_session), captured from the login Set-Cookie.
// Prints p50/p95/p99 for login, send, and history read.

const bool = (value) => value !== 'false' && value !== '0';
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const BASE = String(args.url || process.env.VEYRA_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const MESSAGES_PER_USER = Number(args.messages || 10);
const CONCURRENCY = Number(args.concurrency || 0) || Infinity;
const CHANNEL = String(args.channel || 'global');
const RAMP_MS = Number(args['ramp-ms'] || 0);
const WARMUP = bool(String(args.warmup ?? 'true'));

const usersArg = String(args.users || process.env.VEYRA_LOAD_USERS || '');
const USERS = usersArg.split(',').map((pair) => {
  const idx = pair.indexOf(':');
  return idx > 0 ? { email: pair.slice(0, idx), password: pair.slice(idx + 1) } : null;
}).filter(Boolean);

if (!USERS.length) {
  console.error('Provide --users email:pass,email:pass (or VEYRA_LOAD_USERS).');
  process.exit(1);
}

const stats = { login: [], send: [], read: [] };
const record = (bucket, ms) => stats[bucket].push(ms);

async function api(cookie, path, body, { timed = null, method = 'POST' } = {}) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const elapsed = performance.now() - started;
  const json = await response.json().catch(() => ({}));
  if (timed) record(timed, elapsed);
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${json.error || 'request failed'}`);
  return { json, elapsed, headers: response.headers };
}

function sessionCookie(headers) {
  const cookies = headers.getSetCookie?.() || [];
  const match = cookies.map((c) => c.match(/^veyra_session=([^;]+)/)).find(Boolean);
  return match ? `veyra_session=${match[1]}` : null;
}

async function login(user, { timed = null } = {}) {
  const { json, headers } = await api(null, '/api/auth/login', { email: user.email, password: user.password }, { timed });
  const cookie = sessionCookie(headers);
  if (!cookie) throw new Error(`Login for ${user.email} returned no session cookie (captcha enabled?).`);
  const me = await api(cookie, '/api/auth/me', undefined, { method: 'GET' });
  user.id = me.json?.user?.id;
  if (!user.id) throw new Error(`Could not resolve user id for ${user.email}.`);
  return cookie;
}

function tableForChannel() {
  return CHANNEL === 'announcements' ? 'announcement_messages' : CHANNEL === 'global' ? 'global_messages' : 'messages';
}

async function sendMessage(cookie, user, index) {
  const table = tableForChannel();
  const isPublic = table !== 'messages';
  const row = isPublic
    ? { sender_id: user.id, content: `[loadtest] ${user.email} #${index}` }
    : { conversation_id: CHANNEL, sender_id: user.id, content: `[loadtest] ${user.email} #${index}` };
  await api(cookie, '/api/data', { table, operation: 'insert', values: row }, { timed: 'send' });
}

async function readHistory(cookie) {
  const table = tableForChannel();
  await api(cookie, '/api/data', {
    table,
    operation: 'select',
    filters: table === 'messages' ? [{ column: 'conversation_id', op: 'eq', value: CHANNEL }] : [],
    order: [{ column: 'created_at', ascending: false }],
    limit: 50,
  }, { timed: 'read' });
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function report(name) {
  const values = stats[name];
  console.log(
    `${name.padEnd(6)} n=${String(values.length).padEnd(5)} ` +
    `p50=${percentile(values, 50).toFixed(1)}ms ` +
    `p95=${percentile(values, 95).toFixed(1)}ms ` +
    `p99=${percentile(values, 99).toFixed(1)}ms ` +
    `max=${(values.length ? Math.max(...values) : 0).toFixed(1)}ms`,
  );
}

async function runUser(user, index) {
  if (RAMP_MS) await new Promise((resolve) => setTimeout(resolve, index * RAMP_MS));
  const cookie = await login(user, { timed: 'login' });
  for (let i = 0; i < MESSAGES_PER_USER; i++) await sendMessage(cookie, user, i);
  await readHistory(cookie);
}

async function main() {
  console.log(`Load test: ${USERS.length} users x ${MESSAGES_PER_USER} msgs -> ${BASE}`);
  console.log(`channel=${CHANNEL} concurrency=${CONCURRENCY === Infinity ? 'burst' : CONCURRENCY} warmup=${WARMUP}`);

  if (WARMUP && USERS.length) {
    // One untimed user warms connection pools, schema cache, and read cache.
    try { await runUser(USERS[0], 0); } catch (error) { console.warn('warmup failed:', error.message); }
    stats.login = []; stats.send = []; stats.read = [];
    console.log('warmup done, starting timed run');
  }

  let cursor = 0;
  let failures = 0;
  const worker = async () => {
    while (cursor < USERS.length) {
      const user = USERS[cursor++];
      try {
        await runUser(user, cursor - 1);
      } catch (error) {
        failures++;
        console.error(`user ${user.email} failed:`, error.message);
      }
    }
  };
  const started = performance.now();
  const lanes = Math.min(CONCURRENCY, USERS.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  const elapsed = (performance.now() - started) / 1000;

  console.log(`done in ${elapsed.toFixed(1)}s (${failures} user failures)`);
  report('login');
  report('send');
  report('read');
  if (failures) process.exitCode = 2;
}

main().catch((error) => {
  console.error('Load test failed:', error);
  process.exit(1);
});
