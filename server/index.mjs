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
//
// Zero-downtime platforms (Altare) start the new version while the old one
// still holds the port, so EADDRINUSE is expected during deploy handoff —
// retry the bind instead of exiting and failing the deploy.
const MAX_BIND_RETRIES = 120; // ~2 minutes at 1s intervals
let bindAttempts = 0;
let server = null;

function startListening() {
  server = app.listen(port, '0.0.0.0', () => {
    console.log(`Veyra API listening on 0.0.0.0:${port}.`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && bindAttempts < MAX_BIND_RETRIES) {
      bindAttempts += 1;
      if (bindAttempts === 1 || bindAttempts % 10 === 0) {
        console.log(`Port ${port} still held by previous version, retrying bind (${bindAttempts}/${MAX_BIND_RETRIES})`);
      }
      setTimeout(startListening, 1000);
      return;
    }
    console.error('Veyra API failed to listen:', error);
    process.exit(1);
  });
}

startListening();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (server?.listening) server.close();
    await Promise.allSettled([pool.end(), closeRedis()]);
    process.exit(0);
  });
}

export default app;
