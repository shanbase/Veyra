import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
const { cachedRead, coalesce, normalizeUserRoles, isTransientQueueError } = await import('./redis.mjs');

test('identical in-flight operations share one result', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = coalesce('same', async () => { calls++; await gate; return 'done'; });
  const second = coalesce('same', async () => { calls++; return 'wrong'; });
  release();
  assert.deepEqual(await Promise.all([first, second]), ['done', 'done']);
  assert.equal(calls, 1);
});

test('different keys do not share work', async () => {
  let calls = 0;
  const result = await Promise.all([
    coalesce('user-a:conversation-a:page-1', async () => ++calls),
    coalesce('user-a:conversation-a:page-2', async () => ++calls),
    coalesce('user-b:conversation-a:page-1', async () => ++calls),
  ]);
  assert.equal(new Set(result).size, 3);
});

test('super admin role implies admin access', () => {
  assert.deepEqual(normalizeUserRoles([{ role: 'super_admin' }]), { admin: true, super: true });
});

test('EZMSG error classification retries transient failures only', () => {
  // Transient: connection loss, deadlocks, pool exhaustion, timeouts.
  for (const error of [
    { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3306' },
    { code: 'ER_LOCK_DEADLOCK', message: 'Deadlock found when trying to get lock' },
    { code: 'ER_LOCK_WAIT_TIMEOUT', message: 'Lock wait timeout exceeded' },
    { code: 'ER_CON_COUNT_ERROR', message: 'Too many connections' },
    { code: 'PROTOCOL_CONNECTION_LOST', message: 'Connection lost' },
    { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' },
    { code: 'ER_PG_40001', message: 'could not serialize access' },
    { code: 'ER_PG_57P01', message: 'terminating connection' },
    { code: 'ER_PG_08006', message: 'connection failure' },
    new Error('Query read timeout'),
  ]) {
    assert.equal(isTransientQueueError(error), true, JSON.stringify(error));
  }
  // Permanent: constraint violations, bad payloads, unknown tables.
  for (const error of [
    { code: 'ER_DUP_ENTRY', message: "Duplicate entry 'x' for key 'PRIMARY'" },
    { code: 'ER_NO_REFERENCED_ROW_2', message: 'Cannot add or update a child row' },
    { code: 'ER_BAD_NULL_ERROR', message: 'Column cannot be null' },
    { code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'foo'" },
    { code: 'ER_NO_SUCH_TABLE', message: "Table 'x' doesn't exist" },
    new Error('Queued message row is empty.'),
    new Error('Unknown table.'),
  ]) {
    assert.equal(isTransientQueueError(error), false, JSON.stringify(error));
  }
});

test('reads fall back to MariaDB when Redis is not configured', async () => {
  let queries = 0;
  const query = () => { queries++; return Promise.resolve({ rows: [1, 2], next: null }); };
  const key = { user: 'same-user', conversation: 'room-a', limit: 50, cursor: null };
  const results = await Promise.all([
    cachedRead('same-user', 'messages', key, query),
    cachedRead('same-user', 'messages', key, query),
  ]);
  assert.deepEqual(results[0], { rows: [1, 2], next: null });
  assert.deepEqual(results[1], results[0]);
  assert.equal(queries, 1);
});
