# Services & infrastructure

Everything Veyra depends on, what each service is used for, and where it runs.

## Self-hosted on Altare

| Service | Used for | Notes |
| --- | --- | --- |
| **Altare App Hosting** | Hosts the production web app + Node API. Auto-deploys from `shanbase/Veyra@main`. | Primary deployment; Vercel remains a working alternate. |
| **PostgreSQL** | Application datastore — auth users/sessions, profiles, conversations, messages, polls, etc. | Currently active (`USE_MARIADB=false`). `database/schema.postgres.sql`. |
| **MariaDB** | Same schema, alternate dialect — `USE_MARIADB=true` switches back. | `database/schema.sql`. `npm run db:migrate` picks the schema by dialect; `npm run db:migrate:postgres` copies MariaDB → PostgreSQL. |
| **Redis / Valkey** | Read cache, request coalescing, shared rate limits, EZMSG write-behind queue (`REDIS_EZMSG=true`), realtime outbox, maintenance flag. | Optional/best-effort — MariaDB stays authoritative; `docs/redis.md`. |
| **U3 object storage** (`u3-asia.altare.global`, team **Secondary**) | Avatars, banners, chat images/videos/voice/files when `USE_SUPABASESTORAGE=false`. | 5 buckets: `veyra-avatars`, `veyra-banners`, `veyra-chat-images`, `veyra-chat-videos`, `veyra-chat-voice`. See [storage.md](storage.md). |
| **Altare Queues** | Optional background jobs (notification delivery) via `ALTARE_QUEUE_URL`/`ALTARE_QUEUE_TOKEN`. | Disabled-by-default fallback runs inline; `docs/queues.md`. |
| **ntfy** | Self-hosted push notifications for web/desktop users (`NTFY_SERVER_URL`). | Per-user topics, per-chat muting respected. |

## External services

| Service | Used for | Env vars |
| --- | --- | --- |
| **Supabase** | **Realtime transport + presence** (always required) — scoped database change notices, typing indicators, online status. **Storage** only when `USE_SUPABASESTORAGE` is not `false`. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |
| **Sequenzy** | Transactional email — verification and password reset (`transactional:send`). | `SEQUENZY_API_KEY` |
| **Google OAuth** | "Sign in with Google" — Web application client, redirect `APP_URL/api/auth/google/callback`. Identities stored in MariaDB/PG by Google `sub`. | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Firebase Cloud Messaging** | Native Android push (`FCM_SERVICE_ACCOUNT_JSON` + `google-services.json` in CI). | `FCM_SERVICE_ACCOUNT_JSON` |
| **hCaptcha** | Bot protection on auth forms. | `VITE_HCAPTCHA_SITE_KEY`, `HCAPTCHA_SECRET` |
| **GIPHY** | GIF picker in chat (`VITE_GIPHY_API_KEY`; public beta fallback). | `VITE_GIPHY_API_KEY` |

## Data flow cheat-sheet

- **Message send:** client → `/api/data` insert → MariaDB/PG write (+ EZMSG queue when enabled) → scoped Supabase Realtime broadcast → recipients. Media bytes go browser → object storage (Supabase or U3 presigned PUT) in parallel.
- **Media read:** stored canonical URL → `/api/storage/chat-read` verifies conversation membership → presigned GET (Supabase signed URL or U3 SigV4). Avatars/banners are public URLs on both providers.
- **Push:** message insert → notification fan-out → ntfy topic / FCM token / desktop OS notification, filtered by per-user `*_mode` preferences and per-chat muting.

## Secrets rule

Everything in the "External services" and database rows is server-side only. Only `VITE_*`
variables (`VITE_SUPABASE_*`, `VITE_HCAPTCHA_SITE_KEY`, `VITE_GIPHY_API_KEY`) ship to the
browser. U3 access keys are injected by `altr u3 attach` — never commit them.
