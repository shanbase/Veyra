import { Phone, PhoneMissed } from "lucide-react";
import { useCall } from "@/components/calls/CallProvider";

// Call entries are stored as ordinary (encrypted) messages whose content is a
// JSON marker written by server/calls.mjs when a call ends — same trick as
// [[poll:id]] markers, so no schema change was needed.
export type CallLogPayload = {
  v: number;
  kind: "voice_call";
  callId: string;
  outcome: "completed" | "missed";
  durationSec: number;
  participants: number;
};

export function parseCallLog(content: string | null | undefined): CallLogPayload | null {
  if (!content || content.length > 2000) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{"v":1,"kind":"voice_call"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as CallLogPayload;
    if (parsed?.kind === "voice_call" && (parsed.outcome === "completed" || parsed.outcome === "missed")) {
      return parsed;
    }
  } catch { /* not JSON */ }
  return null;
}

function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function CallLogCard({ payload, conversationId }: { payload: CallLogPayload; conversationId?: string | null }) {
  const call = useCall();
  const missed = payload.outcome === "missed";
  const Icon = missed ? PhoneMissed : Phone;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 min-w-[220px] max-w-sm">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${missed ? "bg-red-500/15 text-red-500" : "bg-green-500/15 text-green-600"}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-tight">
          {missed ? "Missed voice call" : "Voice call"}
        </p>
        <p className="text-xs text-muted-foreground">
          {missed
            ? "No answer"
            : `${formatDuration(payload.durationSec)}${payload.participants > 2 ? ` · ${payload.participants} people` : ""}`}
        </p>
      </div>
      {conversationId && call?.startCall && (
        <button
          type="button"
          onClick={() => void call.startCall(conversationId).catch(() => {})}
          className="shrink-0 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
        >
          Call again
        </button>
      )}
    </div>
  );
}
