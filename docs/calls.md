# Voice Calls

Veyra supports self-hosted audio calls in 1:1 and group conversations. There is no external service — audio and signalling all run on Veyra's own Node server.

## How it works

- **Signalling** — invite / accept / decline / end events are broadcast over Supabase Realtime as `call-signal` messages on each member's user topic (`server/realtime.mjs` → `publishCallSignal`). This is why ringing works even when the conversation isn't open.
- **Audio** — a WebSocket at `/api/calls/ws` (`server/calls.mjs`) carries raw PCM16 audio: 16 kHz mono, 20 ms frames (640 bytes). The server mixes all speakers each tick and sends every participant a single stream with their own voice subtracted.
- **Client** — `src/lib/calls.ts` captures the mic via `AudioWorklet` (`public/call-capture-worklet.js`), downsamples to 16 kHz, and streams frames over the socket. `src/components/calls/CallProvider.tsx` owns call state, the incoming-call dialog, and the in-call panel.

## Deployment requirements

Calls need a **long-running Node server** — the same process that serves the API on Altare (`server/index.mjs` / `server/start.mjs`). WebSockets share the app's HTTPS port, which Altare supports.

**Vercel cannot host calls**: serverless functions have no persistent process and cannot accept WebSocket upgrades. On the Vercel deployment the call button fails with a toast and everything else keeps working.

No extra environment variables are required. The WS authenticates with the same session cookie as the web app, or `?token=` for native clients (Electron/Android send their Bearer session token).

## Limits (v1)

- Audio only — no video, screen share, or call history.
- Max 12 participants per call (`MAX_PARTICIPANTS` in `server/calls.mjs`).
- PCM16 ≈ 256 kbps per speaker upstream — noticeably heavier than Opus but codec-free and works in every browser/WebView. Opus via WebCodecs is a possible v2 optimization.
- Call state is in-memory: a server restart drops active calls (clients see "disconnected"). Ringing calls time out after 90 s; empty calls are cleaned up after 30 s.
