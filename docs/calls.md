# Voice Calls

Veyra supports self-hosted audio calls in 1:1 and group conversations. There is no external service — audio and signalling all run on Veyra's own Node server.

## How it works

- **Signalling** — invite / accept / decline / end events are broadcast over Supabase Realtime as `call-signal` messages on each member's user topic (`server/realtime.mjs` → `publishCallSignal`). This is why ringing works even when the conversation isn't open.
- **Audio** — a WebSocket at `/api/calls/ws` (`server/calls.mjs`) carries raw PCM16 audio: 16 kHz mono, 20 ms frames (640 bytes). The server mixes all speakers each tick and sends every participant a single stream with their own voice subtracted.
- **Client** — `src/lib/calls.ts` captures the mic via `AudioWorklet` (`public/call-capture-worklet.js`), downsamples to 16 kHz, and streams frames over the socket. `src/components/calls/CallProvider.tsx` owns call state, the incoming-call dialog, and the in-call panel.
- **Closed-app ringing** � `POST /api/calls/start` also fires a high-priority FCM push (`sendCallInvitePush` in `server/notifications.mjs`) to every member's `native_push_tokens` devices with `{type:'call.invite', call_id, conversation_id, title, from_name, avatar_url}`. Requires `FCM_SERVICE_ACCOUNT_JSON` on whichever server handles `/start` (the call server) plus registered device tokens. The push targets the `veyra_calls` Android channel (IMPORTANCE_HIGH, default sound + vibration, created client-side via `PushNotifications.createChannel`). Tapping the notification dispatches `veyra:call-invite` in the WebView; `CallProvider` re-checks `/api/calls/state` before ringing so stale pushes don't ghost-ring. Call invites ignore ntfy/DM notification preferences � a ringing call always notifies.
- **Full-screen incoming call (Android)** — the manifest script (`scripts/configure-android-permissions.mjs`) adds `USE_FULL_SCREEN_INTENT`, `android:showWhenLocked`, and `android:turnScreenOn` so a call invite can cover the screen/lock screen like Messenger. The in-app `IncomingCallDialog` is a full-screen opaque caller screen (avatar, name, decline/accept) shown for both realtime invites and push-tap cold starts.

## Deployment requirements

Calls need a **long-running Node server** — the same process that serves the API on Altare (`server/index.mjs` / `server/start.mjs`). WebSockets share the app's HTTPS port, which Altare supports.

### Dedicated call server (recommended for Vercel frontends)

`server/call-server.mjs` runs ONLY the call API + audio socket, packaged as `ghcr.io/<owner>/veyra-call-server` by `.github/workflows/call-server-image.yml` and deployed as the Altare Docker app **veyra-calls** (Secondary team, `https://veyra-calls.go.altare.global`, 200% CPU / 3 GB / 5 GB, auto-updates on new `:latest` images).

Cross-origin auth uses **60-second HMAC tickets**: the main API exposes `POST /api/calls/ticket` (normal session auth) and the call server verifies `CALL_TICKET_SECRET` — no cookies cross sites.

**Call rooms are in-memory per process, so every client must use the SAME call backend.** `GET /api/calls/config` returns `CALL_SERVER_URL` from the API's env; clients prefer `VITE_CALL_SERVER_URL` (build-time) then fall back to that runtime value, then to same-origin embedded calls. Set on the API serving the frontend:

- `CALL_SERVER_URL=https://veyra-calls.go.altare.global` (runtime)
- `CALL_TICKET_SECRET=<same value on both the API and call server>` (runtime)
- `VITE_CALL_SERVER_URL` — optional build-time override; the runtime config makes it unnecessary

The call server env needs: `CALL_TICKET_SECRET`, `USE_MARIADB=false` + `POSTGRES_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (signalling), `NODE_ENV=production`.

**Vercel cannot host calls itself**: serverless functions have no persistent process and cannot accept WebSocket upgrades. Without `VITE_CALL_SERVER_URL`, the Vercel deployment's call button fails with a toast and everything else keeps working. With it, Vercel frontends use the Altare call server.

The Altare-hosted app (`veyra.go.altare.global`) works either way: embedded calls via session cookie by default, or the dedicated server when `VITE_CALL_SERVER_URL` is set at build time (then `CALL_TICKET_SECRET` must also be in its runtime env).

## Limits (v1)

- Audio only — no video, screen share, or call history.
- Max 12 participants per call (`MAX_PARTICIPANTS` in `server/calls.mjs`).
- PCM16 ≈ 256 kbps per speaker upstream — noticeably heavier than Opus but codec-free and works in every browser/WebView. Opus via WebCodecs is a possible v2 optimization.
- Call state is in-memory: a server restart drops active calls (clients see "disconnected"). Ringing calls time out after 90 s; empty calls are cleaned up after 30 s. Clients auto-reconnect the audio socket up to 3 times on drops and re-apply mute state on rejoin.
