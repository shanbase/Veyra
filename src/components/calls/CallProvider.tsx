import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Minus } from "lucide-react";
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
      onPeerJoin: (userId, name) => {
        setActiveCall((prev) => {
          if (!prev || prev.callId !== callId) return prev;
          if (prev.participants.some((p) => p.userId === userId)) return prev;
          return { ...prev, participants: [...prev.participants, { userId, name, muted: false }] };
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
  }, [endActiveCall, teardownSession]);

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
    const next = !session.isMuted;
    session.setMuted(next);
    setActiveCall((prev) => (prev ? { ...prev, muted: next } : prev));
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
      }}
    >
      {children}
      <IncomingCallDialog call={incomingCall} onAccept={acceptIncoming} onDecline={declineIncoming} />
      <CallOverlay call={activeCall} onHangUp={hangUp} onToggleMute={toggleMute} />
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
const WIDGET_W = 64;
const WIDGET_H = 96;

function loadWidgetPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(WIDGET_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos?.x === "number" && typeof pos?.y === "number") return pos;
  } catch { /* ignore */ }
  return null;
}

function CallOverlay({
  call,
  onHangUp,
  onToggleMute,
}: {
  call: ActiveCall | null;
  onHangUp: () => void;
  onToggleMute: () => void;
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
  const others = call.participants.filter((p) => p.name);

  // ---- minimized floating widget ----
  if (!expanded) {
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(0, max));
    const widgetPos = pos || {
      x: clamp(window.innerWidth - WIDGET_W - 16, 0, window.innerWidth),
      y: clamp(window.innerHeight - WIDGET_H - 90, 0, window.innerHeight),
    };
    return (
      <div
        className="fixed z-[95] flex cursor-grab flex-col items-center justify-between rounded-3xl border border-border bg-card/95 px-2 py-3 shadow-2xl backdrop-blur active:cursor-grabbing select-none"
        style={{ left: widgetPos.x, top: widgetPos.y, width: WIDGET_W, height: WIDGET_H, touchAction: "none" }}
        onPointerDown={(e) => {
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: widgetPos.x, origY: widgetPos.y, moved: false };
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          const dx = e.clientX - drag.startX;
          const dy = e.clientY - drag.startY;
          if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
          if (drag.moved) {
            const next = {
              x: clamp(drag.origX + dx, window.innerWidth - WIDGET_W),
              y: clamp(drag.origY + dy, window.innerHeight - WIDGET_H),
            };
            drag.last = next;
            setPos(next);
          }
        }}
        onPointerUp={() => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (drag?.moved) {
            if (drag.last) localStorage.setItem(WIDGET_POS_KEY, JSON.stringify(drag.last));
          } else {
            setExpanded(true); // tap to restore
          }
        }}
        role="button"
        aria-label="Restore call"
        title="Voice call — tap to expand"
      >
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-green-600/15">
          <Phone className="h-4 w-4 text-green-600" />
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-green-500" />
        </span>
        <span className="text-[10px] font-semibold tracking-tight text-foreground [writing-mode:vertical-rl] rotate-180">
          {call.connecting ? "connecting" : duration}
        </span>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onHangUp(); }}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          aria-label="End call"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // ---- full-screen call view ----
  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
      <div className="flex items-center justify-between px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold sm:text-xl">{call.title}</p>
          <p className="text-sm text-muted-foreground">
            {call.connecting ? "Connecting…" : `Voice call · ${duration}`}
            {call.micDenied && " · no mic"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/60 text-foreground transition-colors hover:bg-muted"
          aria-label="Minimize call"
          title="Minimize"
        >
          <Minus className="h-5 w-5" />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="relative">
          <div className="flex h-28 w-28 items-center justify-center rounded-full bg-green-600/15 sm:h-36 sm:w-36">
            <Phone className="h-12 w-12 text-green-600 sm:h-16 sm:w-16" />
          </div>
          <span className="absolute bottom-1 right-1 h-4 w-4 animate-pulse rounded-full bg-green-500 ring-4 ring-background" />
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold tracking-tight">{call.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {others.length === 0
              ? call.connecting ? "Waiting for others to join…" : "Just you so far"
              : `${others.length + 1} participant${others.length === 0 ? "" : "s"}`}
          </p>
        </div>
        {others.length > 0 && (
          <div className="w-full max-w-xs space-y-1.5">
            {others.slice(0, 8).map((p) => (
              <div key={p.userId} className="flex items-center justify-between rounded-xl bg-muted/50 px-4 py-2.5">
                <span className="truncate text-sm font-medium">{p.name || "Participant"}</span>
                {p.muted && <MicOff className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
              </div>
            ))}
            {others.length > 8 && (
              <p className="px-4 text-xs text-muted-foreground">+{others.length - 8} more</p>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-6 px-6 pb-10 sm:gap-10 sm:pb-14">
        <button
          type="button"
          onClick={onToggleMute}
          disabled={call.micDenied}
          className={`flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-full text-xs font-medium transition-colors disabled:opacity-40 ${
            call.muted ? "bg-destructive text-destructive-foreground" : "bg-muted hover:bg-muted/80"
          }`}
        >
          {call.muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
          {call.muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          onClick={onHangUp}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
          aria-label="End call"
        >
          <PhoneOff className="h-7 w-7" />
        </button>
      </div>
    </div>
  );
}
