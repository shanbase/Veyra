# Database replication & backup strategy

Veyra runs on **either** MariaDB or PostgreSQL — `server/db.mjs` creates exactly
one connection pool, selected by `USE_MARIADB`. There is no live replication,
dual-write, or CDC between the two dialects, and the schemas are not identical
(`database/schema.sql` vs `database/schema.postgres.sql`), so symmetric
replication is not possible today.

## Decision for 1.2.8

The actual requirement is **disaster recovery**, not a queryable live replica.
For 1.2.8 we adopt:

- **Option A — independent environments + planned cutover tooling**
  (`server/migrate-to-postgres.mjs`, `npm run db:migrate:postgres`) for
  MariaDB ↔ PostgreSQL migrations.
- **Option D — managed backups / point-in-time recovery** for DR.

A live replica (dual-write shim or CDC) is explicitly **deferred**: it would
need ciphertext-identical writes for encrypted message fields, conflict
resolution for divergent writes, and roughly double pool pressure — none of
which is justified by the current scale targets.

## What "backup" means per dialect

### PostgreSQL

- Enable WAL archiving or use a managed/self-hosted provider with
  point-in-time recovery. Target RPO ≤ 5 minutes, RTO ≤ 1 hour.
- `pg_dump` remains the portable fallback for planned snapshots.

### MariaDB

- Use the host's snapshot/backup automation (e.g. managed MariaDB snapshots,
  `mariabackup`, or `mysqldump` on a schedule). `mysqldump --single-transaction`
  is consistent for InnoDB without locking writes.
- Retain at least 7 daily + 4 weekly snapshots; verify one restore per quarter.

## Restore drill (run before relying on backups)

1. Restore the latest dump/snapshot into a scratch database.
2. `USE_MARIADB=<dialect> npm run db:migrate` — the schema files are
   idempotent, so this is safe on a restored database.
3. Point a staging API at the restored DB (`MARIADB_*`/`POSTGRES_*`) and run
   `npm run dev`; verify login, DM history, and global chat load.
4. Record the drill date and outcome in the release notes.

## If a live replica is ever required

Do **not** scatter second-pool calls through `server/*.mjs`. The only viable
shape is a write fan-out inside the `pool` abstraction in `server/db.mjs`:

- Route every write to both pools; read from primary.
- Encrypt once in `server/data.mjs`/`server/encryption.mjs` before fan-out so
  both sides store identical AES-256-GCM ciphertext (ciphertext is portable
  across dialects — it is just bytes in a column).
- Message IDs are client-generated UUIDs, so no sequence/ID synchronization is
  needed; `ON DUPLICATE KEY UPDATE`/`ON CONFLICT` upserts already translate.
- Define conflict resolution for direct writes to the secondary (recommend:
  secondary is read-only replica, writes rejected at the DB role level).
- Cover dual-write behavior with tests before enabling in production.

Until then, treat the secondary database as a migration target and backup
store, not a replica.
