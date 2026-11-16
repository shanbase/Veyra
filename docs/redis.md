# Redis in Veyra

Redis is an optional acceleration and retry layer. MariaDB remains the durable source of truth for accounts, conversations, messages, and history. Supabase Realtime remains the browser WebSocket transport; Redis credentials are never sent to clients.

## Configuration

Set `REDIS_URL` on the API server and in local `.env.local` when developing against Redis:

```dotenv
REDIS_URL=redis://:password@redis-host:6379/0
```

For a server that has no TLS, use `redis://`. Veyra does not require TLS in its Redis client configuration. Keep this variable server-only; do not use a `VITE_` prefix. If unset or unreachable, Veyra continues to use MariaDB and Supabase Realtime without Redis acceleration.

## Integrations

- **Read cache:** authenticated SELECT responses are keyed by user ID and the full table/query payload. Entries expire after two seconds and results larger than 256 KB are not cached. A table generation value changes after writes through data and RPC routes, making previous entries unreachable.
- **Singleflight:** identical reads within one warm Node/Vercel function instance share the same in-flight database query. Keys include the user and full query, including filters, ordering, offset, and limit.
- **Realtime outbox:** after MariaDB commits a change, the API appends a compact recipient-scoped broadcast batch to a Redis Stream. The API publishes batches to Supabase Realtime and removes them after successful delivery. Failed batches remain bounded in the stream and are retried on later changes. Clients deduplicate message inserts by their MariaDB message ID and recover history from MariaDB after reconnects.
- **Rate limiting:** when Redis is configured, auth endpoint limits (login, signup, password reset, Google OAuth) and a generous per-user `/api/data` ceiling are enforced through shared fixed-window counters under `veyra:v1:ratelimit:*`. The increment and expiry are a single atomic Lua script, so a crash cannot leave a counter without a TTL (which would lock the key out permanently), and legacy TTL-less keys self-heal on the next hit. Counters survive restarts and are shared across API instances. If Redis is unavailable or rejects a command, callers fall back to their in-memory buckets (auth) or skip the optional data ceiling, so availability is never affected.
- **Auxiliary caches:** schema metadata, conversation member lists, signed media URLs, and admin/super-admin role flags are cached as short-lived JSON (`veyra:v1:*`). Role flags expire after 60 seconds and are also invalidated immediately on `user_roles` writes, so out-of-band role edits propagate quickly. Session cache entries are invalidated on logout, password change, and revocation.
- **EZMSG write-behind (opt-in, `REDIS_EZMSG=true`):** message inserts can queue in Redis and drain to MariaDB asynchronously. The queue is a FIFO list (`LPUSH` + `RPOPLPUSH` into a processing list) so messages persist in send order; items moved to processing by a crash are recovered on the next drain. Inserts are idempotent on the client-generated message `id` — a duplicate-key error means the row already landed, so the item is acked without re-publishing realtime events or re-sending notifications. Transient failures (connection loss, deadlocks, pool exhaustion, timeouts) retry with exponential backoff (1s → 2s → 5s → 15s → 60s cap, max 8 attempts) via a delayed-retry sorted set; permanent failures (constraint violations, bad payloads) dead-letter immediately into `veyra:v1:ezmsg:failed` (capped at the newest 1,000). Queue depth, in-flight, retrying, and dead-letter counts are visible to admins at `GET /api/admin/ezmsg-stats`. EZMSG is disabled on Vercel and requires a **single** self-hosted Node replica — the drain flags and recovery scan are per-process.
- **Temporary typing/presence:** online status remains on Supabase Realtime presence; typing indicators use Supabase Realtime broadcast with a ~3s client-side expiry (no stop event needed). Its connection lifecycle already removes departed clients, and putting browser presence in Redis would require exposing a new authenticated websocket gateway and would duplicate working functionality.

## Capacity and operations

Veyra uses one lazy Redis connection per warm API instance, short-lived cached values, a 256 KB per-value cap, a stream trimmed approximately to 10,000 batches, and the EZMSG dead-letter list capped at the newest 1,000 entries. Redis command or connection failures are logged and fall back to MariaDB/direct Realtime delivery. A missed live event never removes or replaces its MariaDB row; chat history requests continue to read MariaDB.

Use a Redis persistence configuration appropriate for your deployment if you want the outbox to survive Redis process restarts. The outbox is an at-least-once retry aid, not a transaction log: MariaDB is authoritative, clients deduplicate repeated event IDs, and reconnect/history loading repairs missed events.

Avoid eviction configurations that discard outbox entries under memory pressure. Monitor connected clients, stream length, memory, cache hit rates, and API latency before scaling Redis resources. Do not store attachments, media, passwords, session tokens, or other large/permanent data in Redis.
