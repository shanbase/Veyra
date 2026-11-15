import express from 'express';
import { fileURLToPath } from 'node:url';
import { pool } from './db.mjs';
import { createApp } from './app.mjs';
import { closeRedis } from './redis.mjs';

const isProduction = process.env.NODE_ENV === 'production';
// Altare/other PaaS inject PORT automatically; 3001 is the local default.
const port = Number(process.env.PORT || process.env.APP_PORT || 3001);

const app = createApp();

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
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Veyra API listening on 0.0.0.0:${port}.`);
});

server.on('error', (error) => {
  console.error('Veyra API failed to listen:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await Promise.allSettled([pool.end(), closeRedis()]);
    process.exit(0);
  });
}

export default app;
