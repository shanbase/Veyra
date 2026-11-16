import express from 'express';
import { fileURLToPath } from 'node:url';
import { pool } from './db.mjs';
import { createApp } from './app.mjs';
import { closeRedis } from './redis.mjs';

const isProduction = process.env.NODE_ENV === 'production';
// Altare/other PaaS inject PORT automatically; 3001 is the local default.
const port = Number(process.env.PORT || process.env.APP_PORT || 3001);

// Startup diagnostics — env VALUES are never logged, only presence, so the
// deploy console shows what is configured without leaking secrets.
console.log('Veyra starting:', JSON.stringify({
  node: process.version,
  nodeEnv: process.env.NODE_ENV || '(unset)',
  port,
  useMariadb: process.env.USE_MARIADB ?? '(default true)',
  hasMariadbConfig: Boolean(process.env.MARIADB_USER && process.env.MARIADB_DATABASE),
  hasPostgresConfig: Boolean(process.env.POSTGRES_USER && process.env.POSTGRES_DATABASE),
  hasSupabaseUrl: Boolean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL),
  hasServiceKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  hasEncryptionKey: Boolean(process.env.MESSAGE_ENCRYPTION_KEY),
  hasAppUrl: Boolean(process.env.APP_URL),
}));

let app;
try {
  app = createApp();
} catch (error) {
  console.error('Veyra failed to initialize:', error);
  process.exit(1);
}

if (isProduction) {
  const distPath = fileURLToPath(new URL('../dist', import.meta.url));
  const indexPath = fileURLToPath(new URL('../dist/index.html', import.meta.url));

  app.use(express.static(distPath));

  app.get(/.*/, (_req, res) => {
    res.sendFile(indexPath);
  });
}

// This file is only the standalone/self-hosted entrypoint — Vercel uses
// server/vercel-handler.mjs instead, so it always listens. Binding 0.0.0.0 is
// required on container platforms (Altare allocates the port, not the host).
// On EADDRINUSE we retry for a bounded window: zero-downtime platforms keep
// the old version on the port until the new one is healthy, then release it —
// exiting immediately just forces a failed deploy record and a restart.
const EADDRINUSE_RETRY_MS = 90_000;
const bindDeadline = Date.now() + EADDRINUSE_RETRY_MS;
const server = app.listen(port, '0.0.0.0');

server.once('listening', () => {
  console.log(`Veyra API listening on 0.0.0.0:${port}.`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE' && Date.now() < bindDeadline) {
    console.warn(`Port ${port} still held by previous version; retrying bind…`);
    // Not unref'd: the retry timer is what keeps the process alive while the
    // platform finishes the zero-downtime handoff.
    setTimeout(() => server.listen(port, '0.0.0.0'), 1000);
    return;
  }
  console.error('Veyra API failed to listen:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (server?.listening) server.close();
    await Promise.allSettled([pool.end(), closeRedis()]);
    process.exit(0);
  });
}

export default app;
