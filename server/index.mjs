
import express from 'express';
import { fileURLToPath } from 'node:url';
import { pool } from './db.mjs';
import { createApp } from './app.mjs';
import { closeRedis } from './redis.mjs';

const isProduction = process.env.NODE_ENV === 'production';
const isVercel = Boolean(process.env.VERCEL);
const port = Number(process.env.PORT || 3001);

const app = createApp();

if (isProduction && !isVercel) {
  const distPath = fileURLToPath(new URL('../dist', import.meta.url));
  const indexPath = fileURLToPath(new URL('../dist/index.html', import.meta.url));

  app.use(express.static(distPath));

  app.get(/.*/, (_req, res) => {
    res.sendFile(indexPath);
  });
}

if (!isVercel) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Veyra API listening on port ${port}.`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      server.close();
      await Promise.allSettled([
        pool.end(),
        closeRedis()
      ]);
      process.exit(0);
    });
  }
}

export default app;
