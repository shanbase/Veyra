import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Boot wrapper for hosted platforms (Altare etc.) whose deploy console does
// not reliably stream app stdout. Diagnostics go to stderr AND
// startup-debug.log in the app root so they can be read via the file manager.
const logFile = fileURLToPath(new URL('../startup-debug.log', import.meta.url));

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' ')}`;
  try { appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
  console.log(line);
}

process.on('uncaughtException', (error) => {
  log('UNCAUGHT_EXCEPTION', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('UNHANDLED_REJECTION', reason);
});

log('boot', JSON.stringify({
  node: process.version,
  platform: process.platform,
  nodeEnv: process.env.NODE_ENV || '(unset)',
  port: process.env.PORT || process.env.APP_PORT || '(unset -> 3001)',
  useMariadb: process.env.USE_MARIADB ?? '(unset -> mariadb)',
  hasPostgresConfig: Boolean(process.env.POSTGRES_USER && process.env.POSTGRES_DATABASE),
  hasMariadbConfig: Boolean(process.env.MARIADB_USER && process.env.MARIADB_DATABASE),
  hasSupabaseUrl: Boolean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL),
  hasAppUrl: Boolean(process.env.APP_URL),
}));

try {
  await import('./index.mjs');
  log('index.mjs loaded');
} catch (error) {
  log('IMPORT_FAILED', error);
  process.exit(1);
}
