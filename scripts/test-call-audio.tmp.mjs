import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });
const { signCallTicket } = await import('../server/call-tickets.mjs');
const { default: WS } = await import('ws');

const BASE = 'https://veyra-calls.go.altare.global';
const CONV = 'd86b8765-a864-48c5-af60-aeba730cfc37';
const USER_A = '08980b50-2c57-42f4-9a2b-045d17094702'; // speaker
const USER_B = '671f4504-72c7-433b-9407-328ebcb117cf'; // listener

const ticketA = signCallTicket(USER_A);
const ticketB = signCallTicket(USER_B);

// 1. Start call as A
const start = await fetch(`${BASE}/api/calls/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticketA}` },
  body: JSON.stringify({ conversation_id: CONV }),
});
const startBody = await start.json();
console.log('start:', start.status, JSON.stringify(startBody));
if (!start.ok) process.exit(1);
const callId = startBody.callId;

function connect(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WS(`${BASE.replace('https', 'wss')}/api/calls/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 8000);
  });
}

const wsA = await connect(ticketA);
const wsB = await connect(ticketB);
wsA.send(JSON.stringify({ type: 'join', callId }));
wsB.send(JSON.stringify({ type: 'join', callId }));
await new Promise((r) => setTimeout(r, 500));

// 2. A streams a 440 Hz sine at 16 kHz, 20 ms frames, for ~2 s
const FRAME = 320;
let phase = 0;
const amp = 12000;
const framesSent = [];
const interval = setInterval(() => {
  const buf = Buffer.allocUnsafe(FRAME * 2);
  const view = new Int16Array(buf.buffer, buf.byteOffset, FRAME);
  for (let i = 0; i < FRAME; i++) {
    phase += (2 * Math.PI * 440) / 16000;
    view[i] = Math.round(Math.sin(phase) * amp);
  }
  framesSent.push(view[0]);
  wsA.send(buf);
}, 20);

// 3. B collects received PCM and measures RMS
let received = 0;
let sumSq = 0;
let maxAbs = 0;
const chunks = [];
wsB.on('message', (data, isBinary) => {
  if (!isBinary) { console.log('B json:', data.toString()); return; }
  const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  received++;
  chunks.push(data.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
    if (Math.abs(s) > maxAbs) maxAbs = Math.abs(s);
  }
});
wsA.on('message', (data, isBinary) => { if (!isBinary) console.log('A json:', data.toString()); });

await new Promise((r) => setTimeout(r, 2500));
clearInterval(interval);

const rms = received ? Math.sqrt(sumSq / (received * 320)) : 0;
console.log(`RESULT: framesReceived=${received} rms=${rms.toFixed(1)} maxAbs=${maxAbs} chunkSizes=${[...new Set(chunks)].join(',')}`);
console.log(received > 50 && rms > 1000 ? 'AUDIO PATH: OK' : 'AUDIO PATH: BROKEN');

// 4. Cleanup
wsA.close(); wsB.close();
await fetch(`${BASE}/api/calls/${callId}/end`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticketA}` },
  body: '{}',
});
process.exit(0);
