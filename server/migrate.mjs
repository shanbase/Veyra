import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dialect, pool } from './db.mjs';
import { redisDeletePattern, closeRedis } from './redis.mjs';

const schemaFile = dialect === 'postgres' ? 'schema.postgres.sql' : 'schema.sql';
const schemaPath = new URL(`../database/${schemaFile}`, import.meta.url);
const schema = await readFile(fileURLToPath(schemaPath), 'utf8');

try {
  if (dialect === 'postgres') {
    // node-postgres executes multi-statement scripts in one simple query,
    // which also keeps dollar-quoted function bodies intact.
    await pool.query(schema);
    console.log('Applied PostgreSQL schema (database/schema.postgres.sql).');
  } else {
    const statements = schema
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.replace(/^\s*(?:--[^\r\n]*\r?\n\s*)*/g, '').trim())
      .filter(Boolean);
    for (const statement of statements) await pool.query(statement);
    console.log(`Applied ${statements.length} MariaDB schema statements.`);
  }
  // Schema may have gained/changed columns — drop cached column maps so API
  // instances don't keep rejecting new columns until the 1h Redis TTL expires.
  const dropped = await redisDeletePattern('veyra:v1:cols:*');
  if (dropped) console.log(`Invalidated ${dropped} cached table schema entries.`);
} finally {
  await pool.end();
  await closeRedis();
}
