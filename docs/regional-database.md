# Regional database & read replicas

Veyra's primary datastore is a single PostgreSQL 18 primary in Ulaanbaatar,
Mongolia (`mn-uln01.altare.global:25204`, database `veyra`). Two **physical
streaming read replicas** serve user-facing SELECTs from regions closer to
Vercel's edge functions, cutting read latency for non-Mongolia users while
keeping all writes on the primary.

## Topology

| Node | Altare name | Address | Role | Team |
| --- | --- | --- | --- | --- |
| Primary | Postgresql (Misc) | `mn-uln01.altare.global:25204` | Read-write primary | Misc |
| US replica | NA-LAA-PG | `us-lax01.altare.global:25065` | Read-only standby | EU |
| Eurasia replica | AS/EU-KB-PG | `kg-bsz02.altare.global:25093` | Read-only standby | EU |

All three run the same codebase: [`shanbase/postgresql`](https://github.com/shanbase/postgresql)
(`veyra-postgres`), a self-contained Node.js PostgreSQL supervisor. Replicas
run in **replica mode** (`PG_REPLICA_*` env vars) — they never accept writes.

Replication is **physical streaming replication**: the entire cluster
(every database, every role) is copied by `pg_basebackup`, then WAL streams
continuously. There is no logical decoding, no per-table filtering, and no
multi-master — replicas are strictly read-only (`pg_is_in_recovery() = true`).

## Primary-side configuration (already applied)

- Role `veyra_replicator` — `LOGIN REPLICATION` with a scram-sha-256 password
  (stored only in each replica's `.env`, never in git).
- `pg_hba.conf` replication rule for `veyra_replicator`.
- Physical replication slots: `veyra_us_slot`, `veyra_eu_slot` (one slot per
  standby — a slot can only feed one walreceiver at a time).
- `wal_level=replica`, `max_wal_senders=10`, `max_replication_slots=10`.

Primary health check:

```sql
SELECT client_addr, application_name, state, sent_lsn, replay_lsn
FROM pg_stat_replication;
SELECT slot_name, active FROM pg_replication_slots;
```

## Replica provisioning

Each replica is an Altare "Generic - Node.js" server (Debian container,
**non-root** — no systemd, no apt install). The startup command fetches
`shanbase/postgresql@main`, runs `npm install`, then `npm start`.

Replica `.env` essentials:

```bash
PG_PORT=<assigned port>
PG_LISTEN=*
PG_SSL=off
PG_VERSION=18
PG_REPLICA_HOST=mn-uln01.altare.global
PG_REPLICA_PORT=25204
PG_REPLICA_USER=veyra_replicator
PG_REPLICA_PASSWORD=<replicator password>
PG_REPLICA_SLOT=veyra_us_slot   # or veyra_eu_slot
PG_REPLICA_DB=postgres          # maintenance DB only — the whole cluster replicates
```

Notes:

- `PG_REPLICA_DB=postgres` is only the `pg_basebackup` connection doorway;
  the `veyra` database and all roles replicate automatically.
- `PG_VERSION=18` matters: the npm `@embedded-postgres` binaries ship only
  `postgres`/`initdb`/`pg_ctl` — **no `pg_basebackup`**.
- First boot downloads PostgreSQL 18 `.deb`s from PGDG + Debian into
  `.pg-debs/` (unprivileged `apt-get` with private config dirs +
  `dpkg-deb -x`), grafts `pg_basebackup` into the embedded bin dir, and
  persists `LD_LIBRARY_PATH` into `.env`. Subsequent boots reuse the cache.
- Success looks like: `[replica] bootstrapping` → `[basebackup]` →
  `standby.signal + primary_conninfo written` → postgres `entering standby
  mode` → `started streaming WAL from primary`.

### Adding another replica

1. Create a physical replication slot on the primary:
   `SELECT pg_create_physical_replication_slot('<name>');`
2. Provision an Altare Node.js server near the target users.
3. Deploy `shanbase/postgresql` with the `.env` above (new slot name).
4. Verify `pg_stat_replication` shows a second streaming client.

## Application read routing (`server/db.mjs`)

The API creates up to three read pools alongside the primary write pool:

| Env var | Serves |
| --- | --- |
| `POSTGRES_READ_URL` | Default replica for requests without a geo hint |
| `POSTGRES_READ_URL_US` | Americas (US, CA, MX, Central America, Caribbean, South America) |
| `POSTGRES_READ_URL_EU` | Everywhere else (Europe, Asia, Africa, Oceania, Middle East) |

`server/app.mjs` middleware reads Vercel's `x-vercel-ip-country` header and
stores the mapped region in an `AsyncLocalStorage` (`regionStore`).
`readPool()` in `server/db.mjs` resolves per query: region pool → default
replica → primary.

What routes where:

- **Replica-eligible**: user-facing SELECTs in `server/data.mjs` (table
  reads, counts) and read-only RPCs in `server/rpc.mjs` (DM/group lists,
  admin stats).
- **Always primary**: all writes, auth/session checks, membership checks,
  receipt updates, transactions, and anything consistency-sensitive.

### Failure behavior

Each read pool wraps connection errors (ECONNREFUSED, timeouts, terminated
connections) with an automatic retry on the **primary** pool — a dead replica
degrades latency, never availability. Replica lag is sub-second under normal
operation; realtime updates arrive via Supabase broadcast regardless, so
clients don't miss messages during brief lag.

## Which deployment benefits

| Frontend | API location | Read path |
| --- | --- | --- |
| `veyra.go.altare.global` (Altare) | Mongolia, next to primary | Primary directly (~1 ms) — no geo header, default pool |
| `veyra-pink-mu.vercel.app` (Vercel) | Edge function near each user | `x-vercel-ip-country` → nearest replica (~10–30 ms) |

Native Android/desktop apps default to the Vercel deployment
(`capacitor.config.ts`, `desktop/main.cjs` `APP_URLS`), so global users get
the regional path automatically; Altare remains the failover origin.

## Security notes

- Replica `pg_hba.conf` currently allows `0.0.0.0/0` scram-sha-256 (same
  posture as the primary). **TODO:** narrow `PG_ALLOWED_CIDRS` to known API
  egress ranges and/or put replicas behind Altare private networking.
- `PG_SSL=off` matches the primary; all replication traffic is scram-auth
  but unencrypted in transit.
- Replication credentials live only in each replica's `.env` on the server —
  never commit them.
- Replicas hold a full copy of all data — they are production-sensitive.
