# Veyra Releases

GitHub Releases are the public update source for the Windows desktop and Android apps. A release is created by pushing a semantic version tag in the form `vMAJOR.MINOR.PATCH`, for example `v1.2.0`. The release workflow builds both apps, attaches their installers, generates `latest.json`, and publishes the release. Pull request and branch builds do not publish releases.

Both apps are web shells around the deployed site, so `latest.json` carries a `min_app_version` field (sourced from `minAppVersion` in `package.json`): apps only prompt for a native update when the installed shell is older than that floor. Bump `minAppVersion` only when the native shell itself changes (plugins, permissions, updater, failover) — website-only releases do not require an app update.

## Veyra 1.2.8

Reliability and profile-customization release on top of 1.2.7.

### Reliability

- **Per-bucket upload limits:** chat media now enforces the real Supabase bucket caps instead of one flat 25 MB — `chat-images`/`chat-videos` 50 MB, `chat-voice` 45 MB — mirrored client-side in `src/lib/uploadLimits.ts`. Profile images/banners keep the 25 MB cap.
- **EZMSG write-behind hardened (`REDIS_EZMSG=true`):** the Redis queue is now FIFO (was LIFO), inserts are idempotent on the client-generated message ID (duplicate keys ack without re-publishing realtime or re-sending notifications), transient failures retry with exponential backoff, and permanent failures dead-letter immediately. Queue depth/retry/dead-letter stats are exposed to admins at `GET /api/admin/ezmsg-stats`.
- **Animated profile banners:** banners accept MP4/WebM videos up to 5 seconds (muted, looping) in addition to images and GIFs; `banner_media_kind`/`banner_media_duration_ms` track which renderer to use.

### Profile customization

- **Presence modes:** profiles get `status_mode` — online, idle, or do-not-disturb. Do-not-disturb suppresses push/ntfy delivery (direct @mentions still get through) while the user remains online.
- **Richer profiles:** interests tags, languages, social links (`profile_links` table), and a profile song (HTTPS audio URL with optional artwork) are editable in Settings and rendered on the profile dialog in the owner's chosen section order (`profile_layout`).
- **QR friend codes:** every user gets a friend code (`profile_friend_codes` table) rendered as a QR in Settings at `/settings`. Codes rotate (60s cooldown), revoke, and support opt-in auto-accept. Friends scan the QR or open `/add-friend?code=…` to send a friend request — or be added instantly when auto-accept is on. Camera scanning uses the browser `BarcodeDetector` API with a manual-entry fallback.

### Operations

- **Database strategy documented:** [docs/database-replication.md](docs/database-replication.md) records the decision — MariaDB and PostgreSQL remain alternative primary databases (no live replication), with `db:migrate:postgres` for planned cutovers and managed backups/PITR for disaster recovery.
- **Load-test harness:** `node scripts/load-test.mjs --url <staging> --users email:pass,...` measures login/send/history p50/p95/p99 under concurrent load.

Requires `npm run db:migrate` for the new profile columns and tables (`profile_links`, `profile_friend_codes`, `friend_requests.source`, profile JSON fields).

### Downloads (once published)

- Windows: `Veyra1.2.8.exe`
- Android: `AndroidVeyra1.2.8.apk`
- Update metadata: `latest.json`

## Veyra 1.2.7

Security-hardening, scale, and UX release on top of 1.2.6. Everything below shipped after the 1.2.6 tag.

### Security & integrity

- **Write-path lockdown:** the generic data API no longer lets users forge receipt timestamps (`read_at`/`delivered_at`), rewrite reply links, backdate messages, or flip server-managed flags like `is_forwarded`; bulk inserts/updates/deletes are capped at 200 rows and filter/`in`/`OR` clause sizes are bounded.
- **Rate limits everywhere:** `/api/data`, profile uploads, chat uploads, pairing, email-verify, and password-reset endpoints are all limited — shared Redis counters when `REDIS_URL` is set, in-memory fallback otherwise. Auth limiter maps are cleaned up so they can't grow unbounded.
- **Infra errors don't leak:** database/network failures return a generic `503` instead of raw driver messages.
- **Content-Security-Policy** header on all responses.
- **Push token ownership:** an FCM token binds to the newest account that registers it — fixes push delivery when two accounts share one device.
- **Message reports:** new `message_reports` table; users can report any visible message but can only file their own reports and can't read them back — admins can review all reports.

### Scale & reliability

- **Realtime past 200 members:** conversation-scoped tables broadcast on per-conversation HMAC topics instead of fanning out to every member; group membership and recipient fan-out are capped, and groups are limited to 500 members.
- **Optional Redis write-behind (`REDIS_EZMSG=true`):** message inserts can queue in Redis and drain to MariaDB asynchronously with pending-read merging — off by default, disabled on Vercel, falls back to direct writes on Redis failure.
- **Redis hardening:** rate-limit counters are atomic Lua (`INCR`+`PEXPIRE`, crash-safe, self-healing TTLs); admin-role cache TTL is 60s so role changes propagate fast; EZMSG dead-letter list capped at 1,000 entries.
- **Clients resync on reconnect:** conversation history refetches when the realtime channel recovers; native API `401`s emit auth-state events so apps re-authenticate instead of failing silently.
- **Dead code cleanup:** unsupported RPCs and unused paths removed.

### Chat UX

- **Message chaining:** consecutive messages from the same sender within 5 minutes group visually — avatar/name/time once at the top, compact continuations, per-message timestamp on hover at the end of the text (or bottom-right for media).
- **Icon receipts:** outgoing status is clock while sending, single check sent, double check delivered, green double check read — no more text labels; ticks show at the end of your chain.
- **Attachment cap:** up to 10 files per message across picker, paste, and drag/drop.
- **Discord-style message menu:** right-click (desktop) or the hover "…" button opens quick reactions plus reply, edit (own messages), react, delete, forward, copy text, copy message ID, pin, and report. The menu anchors at the cursor, flips at screen edges, stays inside the chat area, and the mobile long-press sheet mirrors the same actions.
- **Forwarding:** sends a copy (text + media) to any DM or group, rendered with a "Forwarded" label and accent line via the new `is_forwarded` flag.
- **Typing indicator:** moved to Supabase Realtime broadcast — near-instant, works in group chats (was DM-only), receivers self-expire after ~3s.
- **Stick-to-bottom:** the chat stays pinned to the latest message on send/receive unless you scroll up; it re-engages at the bottom and a resize observer keeps it pinned through media loads, edits, and reactions — applied before paint.
- **Flicker-free media sends:** image/video/voice/file previews stay visible until signed remote URLs are cached, then swap seamlessly.
- **Client spam brake:** too many sends in a short window shows a blocking "Take a rest" notice until acknowledged.

### Android

- **In-app self-update:** downloads the APK natively with live progress, then hands off to the system installer automatically — no more browser hand-off.
- **Native failover:** the app loads `https://veyra.go.altare.global` and automatically retries `https://veyra-pink-mu.vercel.app` if the primary host fails.
- **Permissions:** generated manifest now declares `REQUEST_INSTALL_PACKAGES`, `POST_NOTIFICATIONS`, and microphone permissions via configure scripts (generated `android/` stays gitignored).

### Desktop

- **Native failover:** same primary/secondary pair — the window hops to Vercel on load failure, retries the primary after 30s if both are down, and update checks try both origins.
- **Update UX:** dedicated update window with download progress, integrity-checked installers, and restart-to-update flow (carried from earlier work).

### Downloads (once published)

- Windows: `Veyra1.2.7.exe`
- Android: `AndroidVeyra1.2.7.apk`
- Update metadata: `latest.json`

## Veyra 1.2.6

Fixes and hardening release on top of 1.2.5:

- **Notifications actually deliver:** push no longer requires an ntfy topic — FCM device tokens receive notifications independently. Users without saved preferences now get sensible defaults (DMs and announcements immediate, Global Chat off), and `@mention`/`@everyone` overrides channel settings so mentions always push.
- **Pair-device auth bounce fixed:** after signing in on Android/desktop (or password login), the app navigated before the session resolved and bounced back to the auth page — it only worked on the second attempt. The user is now resolved synchronously before navigation on every auth path.
- **Auth UX:** "check your spam or junk folder" hint, a Resend confirmation email button (new rate-limited, captcha-protected endpoint), and signup switches straight to the login form.
- **Friend requests are live:** incoming requests appear instantly via realtime instead of only after restarting the app, and accepting one shows the new DM in the sidebar within ~150ms. Friend-request profile lookups are batched.
- **Blocking enforced everywhere:** blocked users can no longer send messages in existing DMs or be added to groups — previously blocking only prevented *creating* a new conversation.
- **Upload scope hardening:** chat uploads now verify the target conversation/scope and are rate-limited; message content is capped server-side; LIKE wildcards are escaped.
- **Desktop notifications respect settings:** the tray now honors off/digest modes and @mention overrides instead of pinging on every message.
- **Correctness fixes:** poll votes are atomic (no double-voting races), digest cooldowns can't double-fire, deletes work on composite-key tables, sole-member groups can be left, and markdown parsing is depth-capped.
- **Faster uploads:** multiple attachments upload in parallel instead of one-by-one.
- **Database:** new `messages(conversation_id, read_at)` index for unread counts/receipts.

### Downloads (once published)

- Windows: `Veyra1.2.6.exe`
- Android: `AndroidVeyra1.2.6.apk`
- Update metadata: `latest.json`

## Veyra 1.2.5

Feature release on top of 1.2.4:

- **Reactions on every surface:** emoji reactions now work on Global Chat and Announcements, not just DMs and groups. `message_reactions` supports all three message tables and live updates broadcast correctly.
- **Duplicate DM fix:** accepting a friend request (or opening `get_or_create_dm`) can no longer create two conversations for the same pair — a new `dm_pairs` table makes conversation creation atomic.
- **Mute any chat:** per-conversation mute for DMs and groups, plus a Global Chat mute toggle. Muted chats stay visible but stop all notifications. Bell-off indicators appear in the sidebar; toggles live in the chat header and DM menu.
- **Push notifications without extra apps:** Android registers for Firebase Cloud Messaging automatically (`@capacitor/push-notifications` + `FCM_SERVICE_ACCOUNT_JSON` server-side; dead tokens are retired automatically). The Windows desktop app shows native OS notifications for incoming messages while unfocused — click to jump back in.
- **Redis does more heavy lifting:** auth sessions are cached (60s, instant invalidation on logout/password change/revoke), admin role flags are cached per user, schema metadata and conversation member lists are shared across serverless instances, and signed media URLs are cached for 50 minutes — fewer round-trips to the database on every request.
- **Performance:** new indexes on `message_reactions(message_id)` and `messages(reply_to_id)`; message history loading is unchanged.
- **Attachments are permanent:** the 14-day attachment expiry is removed. Images, videos, voice notes, and files are kept forever unless `ATTACHMENT_RETENTION_DAYS` is explicitly set.
- **PostgreSQL fixes:** the `client.query() already executing` deprecation warning is resolved, and the PostgreSQL schema gained the new tables/columns (`dm_pairs`, `muted`, `global_muted`).

### Downloads (once published)

- Windows: `Veyra1.2.5.exe`
- Android: `AndroidVeyra1.2.5.apk`
- Update metadata: `latest.json`

## Veyra 1.2.4

Hotfix release on top of 1.2.3:

- **Android update loop fix:** the update checker now reads the installed version from the native package (`App.getInfo()`) instead of the web build's `VITE_APP_VERSION`, which was unset on the deployed web app and made every 1.2.3 install believe an update was available. Versions are normalized (`v` prefix stripped) and compared numerically.
- **Android microphone permission:** the generated Android manifest now declares `RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS`, so voice-message recording triggers the real Android runtime prompt instead of failing silently. The recorder no longer trusts the WebView Permissions API on native (which misreports `denied`) and shows actionable Settings instructions when permission is refused.
- **Instant media sends:** images, videos, files, GIFs, and voice messages now render immediately as optimistic messages backed by local blob previews, then swap to signed remote URLs when the upload and insert finish. Failed uploads remove the optimistic message and restore the composer draft.
- **GIF picker upgrade:** new Favorites tab (per-device, persisted in localStorage), press-and-hold or star-button favoriting with a hollow/filled yellow star, sharper `fixed_width` previews, larger mobile-friendly tiles, and improved search layout.
- **PostgreSQL support:** setting `USE_MARIADB=false` switches the API to PostgreSQL (`POSTGRES_*` env vars, plain TCP, no TLS). `database/schema.postgres.sql` mirrors the MariaDB schema and `npm run db:migrate` picks it automatically. See `docs/postgres.md`.
- **Reliability fixes:** reaction add/remove now rolls back the optimistic state on failure and scopes deletes to the current user; Google sign-in tolerates a concurrent first-login profile race.

### Downloads (once published)

- Windows: `Veyra1.2.4.exe`
- Android: `AndroidVeyra1.2.4.apk`
- Update metadata: `latest.json`

## Veyra 1.2.1 (upcoming)

Hotfix release on top of 1.2.0:

- **Android update checker:** release metadata is now fetched through the Veyra API (`GET /api/app-version`) instead of directly from GitHub, fixing "Veyra could not reach the release server" caused by CORS-blocked release download redirects in the Android WebView. The desktop updater uses the same endpoint.
- **Announcement polls:** fixed poll creation in Announcements (channel naming mismatch rejected by the backend) and polls now update live for all viewers.
- **Poll display:** hardened date parsing so polls and messages no longer show "Invalid Date", and polls that cannot be loaded show a clear unavailable state instead of loading forever.
- **Faster polls:** poll creation is a single transactional API call instead of 4–5 sequential requests.
- **Faster chat loading:** media URLs in a message page are signed with one batched request instead of one request per message.
- **Desktop updater:** updates now download automatically with live progress (Discord-style), re-prompt if the window was closed mid-download, and re-check every 6 hours.

### Downloads (once published)

- Windows: `Veyra1.2.1.exe`
- Android: `AndroidVeyra1.2.1.apk`
- Update metadata: `latest.json`

## Veyra 1.2.0 (upcoming)

Reliability, security, and experience update. Highlights:

- **Message encryption at rest:** message content in DMs, group chats, Global Chat, and announcements is encrypted with AES-256-GCM before storage in MariaDB (`MESSAGE_ENCRYPTION_KEY`). This is not end-to-end encryption; see `docs/message-encryption.md`.
- **Redis rate limiting:** auth endpoint limits are shared across API instances when `REDIS_URL` is configured, with in-memory fallback.
- **Session management:** users can list and revoke sessions (`GET /api/auth/sessions`, `POST /api/auth/sessions/revoke`); password changes now revoke all sessions.
- **Optional Altare Queues:** environment-gated background job publishing for notifications, disabled by default with inline fallback (`docs/queues.md`).
- **Realtime resilience:** clients resync conversation history when the realtime channel recovers, and presence heartbeats keep online/typing state fresh.
- **Desktop updater:** non-blocking update check with a dedicated progress window, download status, and retry/failure handling instead of a silent startup install.
- **Android updater:** update prompt now shows release details and surfaces check/download failures.
- **CI:** pull requests run lint, server tests, and a production build.

### Downloads (once published)

- Windows: `Veyra1.2.0.exe`
- Android: `AndroidVeyra1.2.0.apk`
- Update metadata: `latest.json`

## Veyra 1.1.8

This is a maintenance release that fixes Google OAuth callback error handling.

### Authentication

- Fix the callback's `returnTo` variable scope so database, token-exchange, and profile errors can reach the intended OAuth error handler without triggering `ReferenceError: returnTo is not defined`.
- Preserve the original destination when Google sign-in rejects an unsupported email address.

The reported `ECONNREFUSED` error was caused by the MariaDB service being offline, not by the OAuth callback. MariaDB must be running and reachable for account creation and session operations to succeed.

### Downloads

- Windows: `Veyra1.1.8.exe`
- Android: `AndroidVeyra1.1.8.apk`
- Update metadata: `latest.json`


## Release prerequisites

1. In GitHub repository settings, add these Actions secrets from the same Android release keystore: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Create the keystore once and back it up securely; never regenerate it for subsequent releases or commit it to Git. Android only accepts an update when the APK is signed by the same key as the installed app.
2. Make the repository public so installed apps can fetch release metadata and assets without credentials.
3. Confirm the release workflow passes before publishing a version tag. Keep using the same Android release keystore for every version so existing installations can update in place.

## Publish a release

1. Merge the desired code to `main`.
2. Create and push the next unused semantic version tag, such as `v1.1.8`. Tags must increase monotonically; never reuse a published version.
3. Wait for **Publish Veyra release** to finish on GitHub Actions.
4. Open the GitHub Release and confirm it contains exactly the versioned Windows installer, Android APK, and `latest.json`.
5. Install the APK on an Android device and run the Windows installer on a test machine before announcing the release.

```sh
git switch main
git pull
git tag v1.1.8
git push origin v1.1.8
```

## Required assets and metadata

For version `1.1.8`, the release workflow produces:

- `Veyra1.1.8.exe` — Windows x64 NSIS installer.
- `AndroidVeyra1.1.8.apk` — release-signed Android APK.
- `latest.json` — update metadata downloaded by both apps.

Metadata shape:

```json
{
  "version": "1.1.8",
  "tag": "v1.1.8",
  "windows": {
    "file": "Veyra1.1.8.exe",
    "url": "https://github.com/OWNER/REPO/releases/download/v1.1.8/Veyra1.1.8.exe"
  },
  "android": {
    "file": "AndroidVeyra1.1.8.apk",
    "url": "https://github.com/OWNER/REPO/releases/download/v1.1.8/AndroidVeyra1.1.8.apk"
  }
}
```

The workflow generates the metadata URLs from the repository and tag. Do not hand-edit `latest.json` or upload a different asset name. Desktop shows a dedicated update window after launch: it reports the available version, downloads with live progress, and only installs after the user chooses **Restart to update**; failures offer retry or defer to the next launch. Android shows release details and opens the APK download after confirmation; the user then confirms installation in Android. Choosing **Later** dismisses the prompt; both apps check again on the next launch.

## Troubleshooting

- If a release build fails before Android signing, verify all four Android signing secrets are present and match the backed-up keystore.
- If Android reports that the update cannot be installed, verify the package ID is unchanged and that the APK uses the original release signing key. A debug APK cannot update a release-signed installation.
- If an app reports no update, verify the GitHub Release is published (not draft), `latest.json` is attached, and both versioned files match its URLs.
- Windows installers are currently unsigned. Windows may show SmartScreen or publisher warnings; code-signing certificates are a separate release prerequisite for trusted publisher presentation.
