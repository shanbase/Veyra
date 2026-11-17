import express from 'express';
import { pool } from './db.mjs';
import { registerCallRoutes, callTicketAuth, handleCallUpgrade, isCallUpgradePath } from './calls.mjs';

// Standalone voice-call server for the dedicated Altare Docker app
// (veyra-calls). It runs ONLY the call REST API + audio WebSocket — no chat,
// no static files — so it can be sized and scaled independently of the main
// API. Cross-origin browsers authenticate with short-lived HMAC tickets
// minted by the main API (POST /api/calls/ticket), so no session cookies or
// CORS credentials are involved.
//
// Required env: CALL_TICKET_SECRET, database config (POSTGRES_* or
// MARIADB_*), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for call signalling.
// PORT is injected by the platform.

const port = Number(process.env.PORT || process.env.APP_PORT || 3001);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Bearer-ticket API: no cookies are ever accepted, so a wildcard origin is
// safe — the ticket itself is the credential and expires in 60 s.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'authorization, content-type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'veyra-calls', database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, service: 'veyra-calls', database: 'unavailable' });
  }
});

registerCallRoutes(app, callTicketAuth);
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

const server = app.listen(port, '0.0.0.0');

server.on('upgrade', (req, socket, head) => {
  if (isCallUpgradePath(req)) {
    handleCallUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.once('listening', () => {
  console.log(`Veyra call server listening on 0.0.0.0:${port}.`);
});

server.on('error', (error) => {
  console.error('Veyra call server failed to listen:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (server?.listening) server.close();
    await Promise.allSettled([pool.end()]);
    process.exit(0);
  });
}
