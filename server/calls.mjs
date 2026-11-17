import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { pool } from './db.mjs';
import { publishCallSignal, publishMariaDbChanges } from './realtime.mjs';
import { encryptRowForTable, decryptRowsForTable } from './encryption.mjs';
import { resolveSessionUser } from './auth.mjs';
import { verifyCallTicket } from './call-tickets.mjs';
import { sendCallInvitePush } from './notifications.mjs';

// Voice calls carry raw PCM16 audio (16 kHz mono, 20 ms frames = 320 samples =
// 640 bytes) over a WebSocket. The server keeps one pending frame per speaker
// and, on a 20 ms tick, mixes all pending frames and sends each participant a
// single stream with their own contribution subtracted — so every client only
// ever schedules one playback stream regardless of group size.
//
// Signalling (invite/accept/decline/end) does NOT go over this socket — it is
// broadcast through Supabase Realtime 'call-signal' events on each member's
// user topic, so ringing works even when the conversation isn't open. The WS
// only handles audio plus in-call peer join/leave/mute events.
//
// This only works on the long-running Node server (Altare/self-hosted). On
// Vercel's serverless functions the REST endpoints work but the WS upgrade
// never happens, so clients degrade gracefully.

const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;
const TICK_MS = 20;
const MAX_PARTICIPANTS = 12;
const RING_TIMEOUT_MS = 90_000;
const EMPTY_GRACE_MS = 30_000;
const STALE_FRAME_MS = 80;
const MAX_AUDIO_PAYLOAD = 16 * 1024;

const calls = new Map(); // callId -> call record
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_PAYLOAD });
let mixTimer = null;

// In-memory fixed-window limit for call creation (broadcasts fan out to every
// member, so unbounded starts would be an abuse vector).
const startBuckets = new Map();
function allowCallStart(userId) {
  const now = Date.now();
  const bucket = startBuckets.get(userId);
  if (!bucket || bucket.until <= now) {
    startBuckets.set(userId, { count: 1, until: now + 60_000 });
    return true;
  }
  if (startBuckets.size > 10000) {
    for (const [key, entry] of startBuckets) if (entry.until <= now) startBuckets.delete(key);
  }
  bucket.count++;
  return bucket.count <= 10;
}

function memberIdsQuery(conversationId) {
  return pool.execute(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
    [conversationId],
  ).then(([rows]) => rows.map((row) => row.user_id));
}

async function isMember(conversationId, userId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1',
    [conversationId, userId],
  );
  return rows.length > 0;
}

async function conversationTitle(conversationId, excludeUserId) {
  const [convs] = await pool.execute(
    'SELECT is_group, name FROM conversations WHERE id = ? LIMIT 1',
    [conversationId],
  );
  const conv = convs[0];
  if (!conv) return 'Chat';
  if (conv.is_group) return (conv.name && conv.name.trim()) || 'Group chat';
  const [members] = await pool.execute(
    'SELECT cm.user_id, p.username, p.display_name FROM conversation_members cm JOIN profiles p ON p.id = cm.user_id WHERE cm.conversation_id = ?',
    [conversationId],
  );
  const other = members.find((m) => m.user_id !== excludeUserId) || members[0];
  return other?.display_name || other?.username || 'Chat';
}

function getCall(callId) {
  return calls.get(callId) || null;
}

async function broadcastToMembers(call, type, extra = {}) {
  const userIds = await memberIdsQuery(call.conversationId).catch(() => []);
  await publishCallSignal({
    type,
    callId: call.id,
    conversationId: call.conversationId,
    title: call.title,
    ...extra,
  }, userIds).catch((error) => console.warn('Call signal broadcast failed:', error?.message || error));
}

function endCall(call, reason) {
  if (call.state === 'ended') return;
  call.state = 'ended';
  call.endedAt = Date.now();
  call.endReason = reason || '';
  void writeCallLog(call).catch((error) => console.warn('Call log write failed:', error?.message || error));
  if (call.ringTimer) clearTimeout(call.ringTimer);
  if (call.emptyTimer) clearTimeout(call.emptyTimer);
  for (const socket of call.sockets.values()) {
    try { socket.close(1000, reason || 'call ended'); } catch { /* ignore */ }
  }
  call.sockets.clear();
  call.audio.clear();
  // Keep the record briefly so late REST polls see 'ended' rather than 404.
  setTimeout(() => calls.delete(call.id), 60_000).unref?.();
}

// Posts a Messenger-style call entry into the conversation's message history:
// a normal `messages` row whose content is a JSON marker the client renders as
// a call card (duration, outcome, "call again"). Content goes through the same
// AES-256-GCM encryption as chat messages.
async function writeCallLog(call) {
  const connected = Boolean(call.activeAt);
  const someoneDeclined = call.declined.size > 0;
  const rangOut = call.endReason === 'ring-timeout';
  // Skip pure caller-cancels before anyone interacted — no noise in chat.
  if (!connected && !someoneDeclined && !rangOut) return;

  const durationSec = connected ? Math.max(0, Math.round(((call.endedAt || Date.now()) - call.activeAt) / 1000)) : 0;
  const content = JSON.stringify({
    v: 1,
    kind: 'voice_call',
    callId: call.id,
    outcome: connected ? 'completed' : 'missed',
    durationSec,
    participants: Math.max(1, call.peakParticipants || 1),
  });

  const id = randomUUID();
  const row = {
    id,
    conversation_id: call.conversationId,
    sender_id: call.startedBy,
    content,
  };
  const stored = encryptRowForTable('messages', row);
  await pool.execute(
    'INSERT INTO messages (id, conversation_id, sender_id, content) VALUES (?, ?, ?, ?)',
    [id, call.conversationId, call.startedBy, stored.content],
  );
  const [rows] = await pool.execute('SELECT * FROM messages WHERE id = ? LIMIT 1', [id]);
  const plain = decryptRowsForTable('messages', rows)[0] || null;
  await publishMariaDbChanges([{
    table: 'messages',
    operation: 'insert',
    eventType: 'INSERT',
    values: row,
    data: plain ? [plain] : rows,
  }], call.startedBy).catch((error) => console.warn('Call log broadcast failed:', error?.message || error));
}

function scheduleEmptyCleanup(call) {
  if (call.emptyTimer) clearTimeout(call.emptyTimer);
  call.emptyTimer = setTimeout(() => {
    if (call.sockets.size === 0 && call.state !== 'ended') {
      endCall(call, 'empty');
      broadcastToMembers(call, 'call.ended', { reason: 'empty' }).catch(() => {});
    }
  }, EMPTY_GRACE_MS);
  call.emptyTimer.unref?.();
}

function ensureMixTimer() {
  if (mixTimer) return;
  mixTimer = setInterval(mixTick, TICK_MS);
  mixTimer.unref?.();
}

function mixTick() {
  const now = Date.now();
  for (const call of calls.values()) {
    try {
      mixCall(call, now);
    } catch (error) {
      // One bad room must never kill the mixer for everyone else.
      console.warn('Call mix failed:', error?.message || error);
    }
  }
}

function mixCall(call, now) {
    if (call.state === 'ended' || call.sockets.size === 0) return;
    // Consume each speaker's pending frame exactly once per tick.
    const speakers = [];
    for (const [userId, entry] of call.audio) {
      if (now - entry.at > STALE_FRAME_MS || entry.muted) {
        call.audio.delete(userId);
        continue;
      }
      speakers.push([userId, entry.frame]);
    }
    if (!speakers.length) return;

    const total = new Int32Array(FRAME_SAMPLES);
    for (const [, frame] of speakers) {
      for (let i = 0; i < FRAME_SAMPLES; i++) total[i] += frame[i];
    }

    for (const [userId, socket] of call.sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      // Fresh buffer per recipient — reusing one Buffer across socket.send()
      // calls lets later writes corrupt frames still queued for earlier
      // recipients, which is what made audio arrive silent/garbled.
      const own = call.audio.get(userId);
      const view = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const sample = total[i] - (own ? own.frame[i] : 0);
        view[i] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
      }
      if (socket.bufferedAmount > 256 * 1024) continue; // slow consumer — drop
      try { socket.send(Buffer.from(view.buffer, view.byteOffset, FRAME_BYTES)); } catch { /* socket closing */ }
    }
    call.audio.clear();
}

function parseAudioFrame(data) {
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 2) return null;
  // Int16Array views require 2-byte alignment; copy when the underlying
  // ArrayBuffer slice isn't aligned.
  if (buf.byteOffset % 2 !== 0) buf = Buffer.from(buf);
  const samples = Math.min(FRAME_SAMPLES, Math.floor(buf.length / 2));
  const frame = new Int16Array(FRAME_SAMPLES);
  frame.set(new Int16Array(buf.buffer, buf.byteOffset, samples));
  return frame;
}

function participantList(call) {
  return [...call.sockets.entries()].map(([userId, socket]) => ({
    userId,
    name: socket.displayName || '',
    avatarUrl: socket.avatarUrl || '',
    muted: socket.muted === true,
  }));
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

function broadcastRoom(call, payload, exceptUserId) {
  for (const [userId, socket] of call.sockets) {
    if (userId !== exceptUserId) sendJson(socket, payload);
  }
}

async function handleJoin(socket, call, user) {
  if (call.sockets.size >= MAX_PARTICIPANTS) {
    sendJson(socket, { type: 'error', message: 'Call is full.' });
    return;
  }
  const becameActive = call.state === 'ringing';
  // Same user in two tabs: keep only the newest socket so a stale tab's
  // close event can't unregister the live one.
  const previous = call.sockets.get(user.id);
  if (previous && previous !== socket) {
    previous.callId = null;
    try { previous.close(1000, 'replaced'); } catch { /* ignore */ }
  }
  call.sockets.set(user.id, socket);
  socket.callId = call.id;
  socket.userId = user.id;
  socket.muted = false;
  socket.displayName = user.display_name || user.username || '';
  socket.avatarUrl = user.avatar_url || '';
  call.accepted.add(user.id);
  call.declined.delete(user.id);
  if (becameActive) call.state = 'active';
  // First real audio connection starts the call clock — covers both the
  // ringing→active WS path and REST-accept-then-join.
  if (!call.activeAt) call.activeAt = Date.now();
  call.peakParticipants = Math.max(call.peakParticipants || 1, call.sockets.size);
  if (call.emptyTimer) { clearTimeout(call.emptyTimer); call.emptyTimer = null; }
  if (call.ringTimer) { clearTimeout(call.ringTimer); call.ringTimer = null; }
  ensureMixTimer();

  sendJson(socket, {
    type: 'welcome',
    callId: call.id,
    conversationId: call.conversationId,
    state: call.state,
    participants: participantList(call),
  });
  broadcastRoom(call, { type: 'peer-joined', userId: user.id, name: socket.displayName, avatarUrl: socket.avatarUrl }, user.id);
  if (becameActive) {
    // Notify members who haven't joined that the call just went live.
    broadcastToMembers(call, 'call.active', { userId: user.id }).catch(() => {});
  }
}

function handleLeave(socket) {
  const callId = socket.callId;
  if (!callId) return;
  const call = getCall(callId);
  socket.callId = null;
  if (!call) return;
  const userId = socket.userId;
  if (call.sockets.get(userId) !== socket) return; // superseded by a newer socket
  call.sockets.delete(userId);
  call.audio.delete(userId);
  broadcastRoom(call, { type: 'peer-left', userId });
  if (call.sockets.size === 0) {
    if (call.state === 'ringing') {
      // Everyone hung up before anyone joined — end immediately.
      endCall(call, 'empty');
      broadcastToMembers(call, 'call.ended', { reason: 'empty' }).catch(() => {});
    } else {
      scheduleEmptyCleanup(call);
    }
  }
}

wss.on('connection', (socket) => {
  socket.on('message', async (data, isBinary) => {
    if (isBinary) {
      const call = socket.callId ? getCall(socket.callId) : null;
      if (!call || call.state !== 'active' || socket.muted) return;
      const frame = parseAudioFrame(data);
      if (!frame) return;
      call.audio.set(socket.userId, { frame, at: Date.now(), muted: false });
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.type === 'join' && typeof msg.callId === 'string') {
      const call = getCall(msg.callId);
      if (!call || call.state === 'ended') {
        sendJson(socket, { type: 'error', message: 'Call is no longer active.' });
        return;
      }
      const user = socket.user || null;
      if (!user || !(await isMember(call.conversationId, user.id))) {
        sendJson(socket, { type: 'error', message: 'You are not allowed to join this call.' });
        return;
      }
      await handleJoin(socket, call, user);
      return;
    }
    if (msg?.type === 'mute' && typeof msg.muted === 'boolean') {
      socket.muted = msg.muted;
      const call = socket.callId ? getCall(socket.callId) : null;
      if (call) {
        call.audio.delete(socket.userId);
        broadcastRoom(call, { type: 'muted', userId: socket.userId, muted: msg.muted }, socket.userId);
      }
      return;
    }
    if (msg?.type === 'leave') {
      handleLeave(socket);
    }
  });
  socket.on('close', () => handleLeave(socket));
  socket.on('error', () => handleLeave(socket));
});

// Reap dead sockets: proxies can hold a TCP connection open long after the
// client is gone, so ping every 30 s and terminate sockets that miss a pong.
const heartbeat = setInterval(() => {
  for (const call of calls.values()) {
    for (const socket of call.sockets.values()) {
      if (socket.isAlive === false) {
        try { socket.terminate(); } catch { /* ignore */ }
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch { /* ignore */ }
    }
  }
}, 30_000);
heartbeat.unref?.();
wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
});

// ---- REST endpoints ----
// `authenticate` is injected so the same routes serve two deployments:
// the main API passes authenticateRequest (session cookie/Bearer), while the
// standalone call server passes callTicketAuth (short-lived HMAC tickets).

export function registerCallRoutes(app, authenticate) {
  app.use('/api/calls', authenticate);
  app.post('/api/calls/start', async (req, res) => {
    const conversationId = String(req.body?.conversation_id || '');
    if (!conversationId) return res.status(400).json({ error: 'conversation_id is required.' });
    if (!allowCallStart(req.user.id)) {
      return res.status(429).json({ error: 'Too many calls. Please wait a minute and try again.' });
    }
    if (!(await isMember(conversationId, req.user.id))) {
      return res.status(403).json({ error: 'You are not a member of this conversation.' });
    }
    // One call per conversation — return the existing one instead of erroring
    // so double-taps and races converge on the same call.
    for (const call of calls.values()) {
      if (call.conversationId === conversationId && call.state !== 'ended') {
        return res.json({ callId: call.id, conversationId, state: call.state, existing: true });
      }
    }
    const title = await conversationTitle(conversationId, req.user.id);
    const call = {
      id: randomUUID(),
      conversationId,
      title,
      startedBy: req.user.id,
      state: 'ringing',
      createdAt: Date.now(),
      accepted: new Set([req.user.id]),
      declined: new Set(),
      sockets: new Map(),
      audio: new Map(),
      ringTimer: null,
      emptyTimer: null,
      activeAt: null,
      endedAt: null,
      endReason: '',
      peakParticipants: 1,
    };
    call.ringTimer = setTimeout(() => {
      const c = getCall(call.id);
      if (c && c.state === 'ringing') {
        endCall(c, 'ring-timeout');
        broadcastToMembers(c, 'call.ended', { reason: 'timeout' }).catch(() => {});
      }
    }, RING_TIMEOUT_MS);
    call.ringTimer.unref?.();
    calls.set(call.id, call);
    await broadcastToMembers(call, 'call.invite', {
      from: { id: req.user.id, username: req.user.username, display_name: req.user.display_name, avatar_url: req.user.avatar_url || '' },
    });
    // FCM push so the phone rings even with the app closed — realtime only
    // reaches running apps.
    memberIdsQuery(conversationId).then((ids) =>
      sendCallInvitePush(ids.filter((id) => id !== req.user.id), {
        callId: call.id,
        conversationId,
        title,
        fromName: req.user.display_name || req.user.username || 'Someone',
        fromAvatar: req.user.avatar_url || '',
      }),
    ).catch(() => {});
    res.json({ callId: call.id, conversationId, state: call.state, title });
  });

  app.post('/api/calls/:callId/accept', async (req, res) => {
    const call = getCall(req.params.callId);
    if (!call || call.state === 'ended') return res.status(404).json({ error: 'Call not found.' });
    if (!(await isMember(call.conversationId, req.user.id))) {
      return res.status(403).json({ error: 'You are not a member of this conversation.' });
    }
    call.accepted.add(req.user.id);
    call.declined.delete(req.user.id);
    if (call.state === 'ringing' && call.sockets.size === 0) {
      call.state = 'active';
      // Accepted but nobody has opened the audio socket yet — don't let the
      // call linger forever if they never connect.
      scheduleEmptyCleanup(call);
    }
    await broadcastToMembers(call, 'call.accepted', { userId: req.user.id });
    res.json({ ok: true, callId: call.id, conversationId: call.conversationId, title: call.title });
  });

  app.post('/api/calls/:callId/decline', async (req, res) => {
    const call = getCall(req.params.callId);
    if (!call || call.state === 'ended') return res.status(404).json({ error: 'Call not found.' });
    if (!(await isMember(call.conversationId, req.user.id))) {
      return res.status(403).json({ error: 'You are not a member of this conversation.' });
    }
    call.declined.add(req.user.id);
    await broadcastToMembers(call, 'call.declined', { userId: req.user.id });
    // If nobody is left who could still pick up, end the ring.
    const members = await memberIdsQuery(call.conversationId).catch(() => []);
    const possible = members.filter((id) => !call.declined.has(id) || id === call.startedBy);
    const joined = call.sockets.size > 0 || [...call.accepted].some((id) => id !== call.startedBy);
    if (call.state === 'ringing' && !joined && possible.every((id) => call.declined.has(id))) {
      endCall(call, 'declined');
      await broadcastToMembers(call, 'call.ended', { reason: 'declined' });
    }
    res.json({ ok: true });
  });

  app.post('/api/calls/:callId/end', async (req, res) => {
    const call = getCall(req.params.callId);
    if (!call || call.state === 'ended') return res.status(404).json({ error: 'Call not found.' });
    if (!(await isMember(call.conversationId, req.user.id))) {
      return res.status(403).json({ error: 'You are not a member of this conversation.' });
    }
    endCall(call, 'ended');
    await broadcastToMembers(call, 'call.ended', { reason: 'ended', by: req.user.id });
    res.json({ ok: true });
  });

  app.get('/api/calls/state', async (req, res) => {
    const conversationId = String(req.query.conversation_id || '');
    if (!conversationId) return res.status(400).json({ error: 'conversation_id is required.' });
    if (!(await isMember(conversationId, req.user.id))) {
      return res.status(403).json({ error: 'You are not a member of this conversation.' });
    }
    for (const call of calls.values()) {
      if (call.conversationId === conversationId && call.state !== 'ended') {
        return res.json({
          call: {
            callId: call.id,
            conversationId,
            state: call.state,
            title: call.title,
            participants: participantList(call),
          },
        });
      }
    }
    res.json({ call: null });
  });
}

// ---- WebSocket upgrade (wired in server/index.mjs) ----

// Auth for the standalone call server: callers present a short-lived HMAC
// ticket minted by the main API (POST /api/calls/ticket). The ticket only
// proves userId — the profile row supplies the display fields calls need.
export function callTicketAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const userId = verifyCallTicket(token);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired call ticket.' });
  pool.execute('SELECT id, username, display_name, avatar_url FROM profiles WHERE id = ? LIMIT 1', [userId])
    .then(([rows]) => {
      if (!rows.length) return res.status(401).json({ error: 'Unknown user.' });
      req.user = rows[0];
      next();
    })
    .catch(next);
}

async function resolveUpgradeUser(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const ticket = url.searchParams.get('ticket');
  if (ticket) {
    const userId = verifyCallTicket(ticket);
    if (!userId) return null;
    const [rows] = await pool.execute(
      'SELECT id, username, display_name, avatar_url FROM profiles WHERE id = ? LIMIT 1',
      [userId],
    );
    return rows[0] || null;
  }
  const token = url.searchParams.get('token')
    || String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('veyra_session='))?.slice('veyra_session='.length);
  if (!token) return null;
  return resolveSessionUser(decodeURIComponent(token)).catch(() => null);
}

export function handleCallUpgrade(req, socket, head) {
  resolveUpgradeUser(req).then((user) => {
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url };
      ws.binaryType = 'nodebuffer';
      wss.emit('connection', ws, req);
    });
  }).catch(() => {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  });
}

export function isCallUpgradePath(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname === '/api/calls/ws';
  } catch {
    return false;
  }
}
