# File storage providers

Veyra stores avatars, banners, and chat media (images, videos, voice notes,
files) in object storage. Two providers are supported:

- **Supabase Storage** (default) — `USE_SUPABASESTORAGE` unset or `true`.
- **Altare U3** (S3-compatible) — `USE_SUPABASESTORAGE=false`.

Supabase is **always** still required for Realtime broadcasts and presence;
this switch only moves object storage. Existing objects are never moved
automatically — see [Migrating to U3](#migrating-to-u3) below.

## Altare U3 setup

Buckets live in the `asia` location (Bangkok/Jakarta — closest U3 region to
the Mongolia-hosted stack). One bucket per logical bucket, created on the
team that hosts the app:

```sh
altr u3 create veyra-avatars   --location asia --team Secondary
altr u3 create veyra-banners   --location asia --team Secondary
altr u3 create veyra-chat-images --location asia --team Secondary
altr u3 create veyra-chat-videos --location asia --team Secondary
altr u3 create veyra-chat-voice  --location asia --team Secondary
```

Attach each bucket to the app — this creates a bucket-scoped access key and
injects the env vars, then redeploys:

```sh
altr u3 attach veyra-avatars     Veyra --prefix AVATARS     --team Secondary
altr u3 attach veyra-banners     Veyra --prefix BANNERS     --team Secondary
altr u3 attach veyra-chat-images Veyra --prefix CHAT_IMAGES --team Secondary
altr u3 attach veyra-chat-videos Veyra --prefix CHAT_VIDEOS --team Secondary
altr u3 attach veyra-chat-voice  Veyra --prefix CHAT_VOICE  --team Secondary
```

Each attach sets `<PREFIX>_ENDPOINT`, `<PREFIX>_REGION`, `<PREFIX>_BUCKET`,
`<PREFIX>_ACCESS_KEY_ID`, and `<PREFIX>_SECRET_ACCESS_KEY`.

### Console-only settings (per bucket)

The `altr` CLI cannot change these — do them once in the Altare console
(**Storage → U3 → bucket → Settings**):

- **CORS rule** — required for browser uploads. Allowed origins: your app
  origins (`https://veyra.go.altare.global`, `https://veyra-pink-mu.vercel.app`,
  `http://localhost:8080` for dev); methods `GET`, `PUT`, `HEAD`; allowed
  headers `*`; expose `ETag`.
- **Public access** — turn ON only for `veyra-avatars` and `veyra-banners`
  (profile media is public anyway). Keep the three `veyra-chat-*` buckets
  **private**: chat media stays membership-gated through
  `/api/storage/chat-read`, which mints short-lived presigned GETs.
- **Lifecycle rule (recommended)** — "Cancel unfinished uploads after 7
  days" on each chat bucket; optional "Delete files after N days" if the
  10 GB free-plan cap becomes a concern.

## How it works at runtime

- `USE_SUPABASESTORAGE=false` → `/api/storage/profile-upload` and
  `/api/storage/chat-upload` return `{ mode: 'u3', uploadUrl, publicUrl }`
  where `uploadUrl` is a presigned S3 PUT (SigV4, ~15 min expiry). Clients
  `PUT` the file directly — no SDK needed.
- `publicUrl` for avatars/banners is the U3 public address
  (`https://<bucket>.u3.altare.global/<key>`), served directly.
- For chat buckets the stored `publicUrl` is a canonical object URL; reads
  go through `/api/storage/chat-read`, which enforces the same
  conversation-membership checks as Supabase mode and returns presigned GETs
  (cached in Redis for 50 of the 60-minute lifetime).
- Old Supabase URLs keep working as long as the Supabase project exists —
  the two providers can coexist indefinitely.

## Migrating to U3

`npm run SS:migrate:ALTR` copies every object from each Supabase bucket into
its U3 counterpart using the `altr` CLI (uses your `altr login` session — no
S3 keys needed). Requires `altr login` and `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

```sh
npm run SS:migrate:ALTR -- --dry-run          # list what would copy
npm run SS:migrate:ALTR                       # copy files
npm run SS:migrate:ALTR -- --rewrite-urls     # copy + rewrite DB URLs
```

`--rewrite-urls` updates `profiles.avatar_url`, `profiles.banner_url`, and
the serialized `image_url` columns on `messages`, `global_messages`, and
`announcement_messages` (including `video:`/`audio:`/`file:`/`music:`
encoded items) from Supabase public URLs to U3 URLs. It is idempotent —
rows already pointing at U3 are untouched. Run it only after the file copy
succeeds, and only once `USE_SUPABASESTORAGE=false` is live (or keep
Supabase storage enabled until you're confident).

Env knobs: `ALTR_TEAM` (default `Secondary`), `--dry-run`.

## Limits

U3 free plan: **10 GB storage, 5 buckets, no egress fees**. Chat video is
the growth risk — keep an eye on bucket usage in the console, and use the
lifecycle rules above if needed.
