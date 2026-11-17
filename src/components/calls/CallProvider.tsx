import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Phone, PhoneOff, Mic, MicOff, Minus, HeadphoneOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import { subscribeCallSignals } from "@/integrations/supabase/mariadb-realtime";
import {
  CallSession,
  acceptCall,
  callState,
  declineCall,
  endCall,
  startCall as apiStartCall,
  type CallParticipant,
  type CallSignal,
} from "@/lib/calls";

type IncomingCall = {
  callId: string;
  conversationId: string;
  title: string;
  fromName: string;
};

type ActiveCall = {
  callId: string;
  conversationId: string;
  title: string;
  connecting: boolean;
  muted: boolean;
  micDenied: boolean;
  deafened: boolean;
  selfName: string;
  selfAvatarUrl: string;
  startedAt: number;
  participants: CallParticipant[];
};

type CallContextValue = {
  incomingCall: IncomingCall | null;
  activeCall: ActiveCall | null;
  liveCallFor: (conversationId: string) => { callId: string; title: string } | null;
  startCall: (conversationId: string, title?: string) => Promise<void>;
  joinCall: (conversationId: string) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function useCall() {
  return useContext(CallContext);
}

const INCOMING_RING_MS = 60_000;

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  // Calls ringing/active in conversations I'm not in — lets the chat header
  // show "join" instead of "start" and lets members see a call is live.
  const [liveCalls, setLiveCalls] = useState<Record<string, { callId: string; title: string }>>({});
  const sessionRef = useRef<CallSession | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  activeCallRef.current = activeCall;

  const clearIncoming = useCallback(() => {
    setIncomingCall(null);
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
  }, []);

  const teardownSession = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
  }, []);

  const endActiveCall = useCallback((notifyServer = true) => {
    const current = activeCallRef.current;
    if (notifyServer && current) void endCall(current.callId);
    if (current) {
      setLiveCalls((prev) => {
        const next = { ...prev };
        for (const [convId, call] of Object.entries(next)) {
          if (call.callId === current.callId) delete next[convId];
        }
        return next;
      });
    }
    teardownSession();
    setActiveCall(null);
  }, [teardownSession]);

  const beginSession = useCallback(async (callId: string, conversationId: string, title: string) => {
    teardownSession();
    const session = new CallSession(callId, conversationId, {
      onParticipants: (participants) => {
        setActiveCall((prev) => (prev && prev.callId === callId ? { ...prev, participants, connecting: false } : prev));
      },
      onPeerJoin: (userId, name, avatarUrl) => {
        setActiveCall((prev) => {
          if (!prev || prev.callId !== callId) return prev;
          if (prev.participants.some((p) => p.userId === userId)) return prev;
          return { ...prev, participants: [...prev.participants, { userId, name, avatarUrl, muted: false }] };
        });
      },
      onPeerLeave: (userId) => {
        setActiveCall((prev) => (prev && prev.callId === callId
          ? { ...prev, participants: prev.participants.filter((p) => p.userId !== userId) }
          : prev));
      },
      onPeerMute: (userId, muted) => {
        setActiveCall((prev) => (prev && prev.callId === callId
          ? { ...prev, participants: prev.participants.map((p) => (p.userId === userId ? { ...p, muted } : p)) }
          : prev));
      },
      onEnded: () => endActiveCall(false),
      onMicDenied: () => {
        setActiveCall((prev) => (prev && prev.callId === callId ? { ...prev, micDenied: true } : prev));
        toast({ title: "Microphone unavailable", description: "You can hear the call but not speak." });
      },
      onError: (message) => toast({ title: "Call", description: message, variant: "destructive" }),
    });
    sessionRef.current = session;
    setActiveCall({
      callId,
      conversationId,
      title,
      connecting: true,
      muted: false,
      micDenied: false,
      deafened: false,
      selfName: user?.display_name || user?.username || "You",
      selfAvatarUrl: user?.avatar_url || "",
      startedAt: Date.now(),
      participants: [],
    });
    try {
      await session.start();
    } catch (error) {
      session.leave();
      sessionRef.current = null;
      setActiveCall(null);
      throw error;
    }
  }, [endActiveCall, teardownSession, user?.display_name, user?.username, user?.avatar_url]);

  // ---- signalling ----
  useEffect(() => {
    if (!user?.id) return;
    const unsubscribe = subscribeCallSignals((signal: CallSignal) => {
      const myId = user.id;
      switch (signal.type) {
        case "call.invite": {
          if (signal.from?.id === myId) return; // own outgoing invite
          if (activeCallRef.current) {
            // Already in a call — auto-decline so the caller isn't left hanging.
            void declineCall(signal.callId);
            return;
          }
          setLiveCalls((prev) => ({
            ...prev,
            [signal.conversationId]: { callId: signal.callId, title: signal.title || "Voice call" },
          }));
          setIncomingCall({
            callId: signal.callId,
            conversationId: signal.conversationId,
            title: signal.title || "Voice call",
            fromName: signal.from?.display_name || signal.from?.username || "Someone",
          });
          if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
          ringTimerRef.current = setTimeout(() => {
            setIncomingCall((prev) => {
              if (prev?.callId === signal.callId) void declineCall(signal.callId);
              return null;
            });
            ringTimerRef.current = null;
          }, INCOMING_RING_MS);
          break;
        }
        case "call.active": {
          // A participant joined — the call is live even if the invite was missed.
          setLiveCalls((prev) => {
            const existing = Object.entries(prev).find(([, c]) => c.callId === signal.callId);
            if (existing) return prev;
            return { ...prev, [signal.conversationId]: { callId: signal.callId, title: signal.title || "Voice call" } };
          });
          break;
        }
        case "call.ended": {
          setLiveCalls((prev) => {
            const next = { ...prev };
            for (const [convId, call] of Object.entries(next)) {
              if (call.callId === signal.callId) delete next[convId];
            }
            return next;
          });
          setIncomingCall((prev) => {
            if (prev?.callId === signal.callId) {
              if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
              return null;
            }
            return prev;
          });
          if (activeCallRef.current?.callId === signal.callId) endActiveCall(false);
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [user?.id, endActiveCall]);

  const markJoined = useCallback((conversationId: string, callId: string) => {
    setLiveCalls((prev) => {
      const next = { ...prev };
      for (const [convId, call] of Object.entries(next)) {
        if (call.callId === callId || convId === conversationId) delete next[convId];
      }
      return next;
    });
  }, []);

  const startCall = useCallback(async (conversationId: string, title?: string) => {
    const result = await apiStartCall(conversationId);
    await acceptCall(result.callId).catch(() => {});
    markJoined(result.conversationId, result.callId);
    await beginSession(result.callId, result.conversationId, result.title || title || "Voice call");
  }, [beginSession, markJoined]);

  const joinCall = useCallback(async (conversationId: string) => {
    const state = await callState(conversationId);
    const call = state.call;
    if (!call) throw new Error("This call has already ended.");
    await acceptCall(call.callId);
    markJoined(call.conversationId, call.callId);
    await beginSession(call.callId, call.conversationId, call.title || "Voice call");
  }, [beginSession, markJoined]);

  const acceptIncoming = useCallback(async () => {
    const incoming = incomingCall;
    if (!incoming) return;
    clearIncoming();
    try {
      await acceptCall(incoming.callId);
      markJoined(incoming.conversationId, incoming.callId);
      await beginSession(incoming.callId, incoming.conversationId, incoming.title);
    } catch (error) {
      toast({
        title: "Couldn't join the call",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  }, [incomingCall, beginSession, clearIncoming, markJoined]);

  const declineIncoming = useCallback(() => {
    const incoming = incomingCall;
    clearIncoming();
    if (incoming) void declineCall(incoming.callId);
  }, [incomingCall, clearIncoming]);

  const hangUp = useCallback(() => {
    endActiveCall(true);
  }, [endActiveCall]);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = !session.isUserMuted;
    session.setMuted(next);
    setActiveCall((prev) => (prev ? { ...prev, muted: session.isMuted } : prev));
  }, []);

  const toggleDeafen = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const next = !session.isDeafened;
    session.setDeafened(next);
    setActiveCall((prev) => (prev ? { ...prev, deafened: next, muted: session.isMuted } : prev));
    toast({
      title: next ? "Deafened" : "Deafen off",
      description: next ? "You can't hear or be heard." : "Audio restored.",
    });
  }, []);

  // Leave the call if the tab/app is closed or the user signs out.
  useEffect(() => {
    if (user?.id) return;
    endActiveCall(false);
    clearIncoming();
  }, [user?.id, endActiveCall, clearIncoming]);

  return (
    <CallContext.Provider
      value={{
        incomingCall,
        activeCall,
        liveCallFor: (conversationId) => liveCalls[conversationId] || null,
        startCall,
        joinCall,
        acceptCall: acceptIncoming,
        declineCall: declineIncoming,
        hangUp,
        toggleMute,
        toggleDeafen,
      }}
    >
      {children}
      <IncomingCallDialog call={incomingCall} onAccept={acceptIncoming} onDecline={declineIncoming} />
      <CallOverlay
        call={activeCall}
        selfId={user?.id}
        onHangUp={hangUp}
        onToggleMute={toggleMute}
        onToggleDeafen={toggleDeafen}
      />
    </CallContext.Provider>
  );
}

function IncomingCallDialog({
  call,
  onAccept,
  onDecline,
}: {
  call: IncomingCall | null;
  onAccept: () => void;
  onDecline: () => void;
}) {
  // Soft two-tone ring while the invite is up — WebAudio so no asset needed.
  useEffect(() => {
    if (!call) return;
    const ctx = new AudioContext();
    let stopped = false;
    let ringTimer: ReturnType<typeof setInterval> | null = null;
    const beep = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.05);
    };
    const ring = () => { if (!stopped) { beep(440, 0, 0.35); beep(480, 0.4, 0.35); beep(440, 0.8, 0.35); } };
    ring();
    ringTimer = setInterval(ring, 2400);
    return () => {
      stopped = true;
      if (ringTimer) clearInterval(ringTimer);
      void ctx.close().catch(() => {});
    };
  }, [call?.callId]);

  if (!call) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl text-center animate-in fade-in zoom-in-95 duration-200">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/15">
          <Phone className="h-7 w-7 text-primary animate-pulse" />
        </div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Incoming voice call</p>
        <p className="mt-1 text-lg font-semibold truncate">{call.title}</p>
        <p className="text-sm text-muted-foreground truncate">{call.fromName}</p>
        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={onDecline}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
            aria-label="Decline call"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-green-600 text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
            aria-label="Accept call"
          >
            <Phone className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
}

const WIDGET_POS_KEY = "veyra-call-widget-pos";
const WIDGET_W = 260;
const WIDGET_H = 84;

function loadWidgetPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(WIDGET_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos?.x === "number" && typeof pos?.y === "number") return pos;
  } catch { /* ignore */ }
  return null;
}

function CallAvatar({ name, avatarUrl, size = "md", muted }: {
  name: string;
  avatarUrl?: string;
  size?: "sm" | "md" | "lg" | "xl";
  muted?: boolean;
}) {
  const sizes = {
    sm: "h-9 w-9 text-xs",
    md: "h-16 w-16 text-lg",
    lg: "h-24 w-24 text-2xl",
    xl: "h-32 w-32 text-4xl sm:h-40 sm:w-40",
  };
  return (
    <div className="relative">
      <Avatar className={`${sizes[size]} border-2 border-white/20`}>
        <AvatarImage src={avatarUrl || undefined} />
        <AvatarFallback className="bg-zinc-700 font-semibold text-white">
          {(name || "?")[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      {muted && (
        <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 ring-2 ring-black">
          <MicOff className="h-3.5 w-3.5 text-white" />
        </span>
      )}
    </div>
  );
}

function CallOverlay({
  call,
  selfId,
  onHangUp,
  onToggleMute,
  onToggleDeafen,
}: {
  call: ActiveCall | null;
  selfId?: string;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean; last?: { x: number; y: number } } | null>(null);
  const callId = call?.callId;
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!callId) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [callId]);

  // New call always opens full-screen; reset when the call ends.
  useEffect(() => {
    if (callId) {
      setExpanded(true);
      setPos(loadWidgetPos());
    }
  }, [callId]);

  if (!call) return null;
  const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const duration = `${mm}:${ss}`;
  const remotes = call.participants.filter((p) => p.userId !== selfId && p.name);
  const selfTile = { name: call.selfName || "You", avatarUrl: call.selfAvatarUrl };
  // Widget preview: your avatar + first remote (or call icon for empty calls).
  const widgetAvatars = [selfTile, ...remotes.slice(0, 2)];

  const dragHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, moved: false };
      el.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved) {
        const next = {
          x: Math.min(Math.max(drag.origX + dx, 0), window.innerWidth - WIDGET_W),
          y: Math.min(Math.max(drag.origY + dy, 0), window.innerHeight - WIDGET_H),
        };
        drag.last = next;
        setPos(next);
      }
    },
    onPointerUp: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.moved) {
        if (drag.last) localStorage.setItem(WIDGET_POS_KEY, JSON.stringify(drag.last));
      } else {
        setExpanded(true); // tap to restore
      }
    },
  };

  // ---- minimized floating widget (Messenger-style PiP card) ----
  if (!expanded) {
    const widgetPos = pos || {
      x: Math.max(12, window.innerWidth - WIDGET_W - 12),
      y: Math.max(12, window.innerHeight - WIDGET_H - 170),
    };
    return (
      <div
        className="fixed z-[95] flex cursor-grab items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/95 py-2.5 pl-3 pr-2 shadow-2xl backdrop-blur active:cursor-grabbing select-none"
        style={{ left: widgetPos.x, top: widgetPos.y, width: WIDGET_W, height: WIDGET_H, touchAction: "none", color: "#fff" }}
        {...dragHandlers}
        role="button"
        aria-label="Restore call"
        title="Voice call — tap to expand"
      >
        {/* overlapping avatars */}
        <div className="flex -space-x-2.5">
          {widgetAvatars.map((p, i) => (
            <CallAvatar key={i} name={p.name} avatarUrl={p.avatarUrl} size="sm" muted={i === 0 ? call.muted : undefined} />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{call.title}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span className={`h-1.5 w-1.5 rounded-full ${call.connecting ? "bg-amber-400" : "bg-green-400 animate-pulse"}`} />
            {call.connecting ? "Connecting…" : `Voice call · ${duration}`}
            {remotes.length > 0 && ` · ${remotes.length + 1}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleMute(); }}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
              call.muted ? "bg-red-500 text-white" : "bg-white/10 text-white hover:bg-white/20"
            }`}
            aria-label={call.muted ? "Unmute" : "Mute"}
          >
            {call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onHangUp(); }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white transition-transform hover:scale-105"
            aria-label="End call"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // ---- full-screen call view (Messenger-style: you on top, them below) ----
  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-white">
      <div className="flex items-center justify-between px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold sm:text-xl">{call.title}</p>
          <p className="text-sm text-zinc-400">
            {call.connecting ? "Connecting…" : `Voice call · ${duration}`}
            {call.micDenied && " · no mic"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          aria-label="Minimize call"
          title="Minimize"
        >
          <Minus className="h-5 w-5" />
        </button>
      </div>

      {/* YOU — pinned strip at the top, Messenger-style */}
      <div className="mx-auto mt-3 flex w-full max-w-lg items-center gap-3 rounded-2xl bg-white/5 px-4 py-3">
        <CallAvatar name={selfTile.name} avatarUrl={selfTile.avatarUrl} size="sm" muted={call.muted || call.deafened} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">You</p>
          <p className="truncate text-xs text-zinc-400">{selfTile.name}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {call.deafened && <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-300">Deafened</span>}
          {call.micDenied && <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">No mic</span>}
        </div>
      </div>

      {/* THEM — main stage below */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-6">
        {remotes.length > 0 ? (
          remotes.length === 1 ? (
            <div className="flex flex-col items-center gap-3">
              <CallAvatar name={remotes[0].name} avatarUrl={remotes[0].avatarUrl} size="xl" muted={remotes[0].muted} />
              <div className="text-center">
                <p className="text-xl font-semibold">{remotes[0].name}</p>
                <p className="text-sm text-zinc-400">{remotes[0].muted ? "Muted" : "Speaking"}</p>
              </div>
            </div>
          ) : (
            <>
              <div className={`grid w-full max-w-2xl gap-4 ${remotes.length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"}`}>
                {remotes.map((p) => (
                  <div key={p.userId} className="flex flex-col items-center gap-2">
                    <CallAvatar name={p.name} avatarUrl={p.avatarUrl} size="lg" muted={p.muted} />
                    <p className="max-w-full truncate text-sm font-medium text-zinc-200">{p.name}</p>
                  </div>
                ))}
              </div>
              <p className="text-sm text-zinc-400">{remotes.length + 1} in call</p>
            </>
          )
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-28 w-28 items-center justify-center rounded-full bg-green-600/20">
              <Phone className="h-12 w-12 text-green-400" />
            </div>
            <p className="text-sm text-zinc-400">
              {call.connecting ? "Connecting…" : "Waiting for others to join…"}
            </p>
          </div>
        )}
      </div>

      {/* controls */}
      <div className="flex items-center justify-center gap-6 px-6 pb-10 sm:gap-10 sm:pb-14">
        <button
          type="button"
          onClick={onToggleMute}
          disabled={call.micDenied}
          className={`flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-full text-xs font-medium transition-colors disabled:opacity-40 ${
            call.muted && !call.deafened ? "bg-red-500 text-white" : "bg-white/10 text-white hover:bg-white/20"
          }`}
        >
          {call.muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
          {call.muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          onClick={onToggleDeafen}
          className={`flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-full text-xs font-medium transition-colors ${
            call.deafened ? "bg-red-500 text-white" : "bg-white/10 text-white hover:bg-white/20"
          }`}
        >
          <HeadphoneOff className="h-6 w-6" />
          {call.deafened ? "Undeafen" : "Deafen"}
        </button>
        <button
          type="button"
          onClick={onHangUp}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
          aria-label="End call"
        >
          <PhoneOff className="h-7 w-7" />
        </button>
      </div>
    </div>
  );
}
