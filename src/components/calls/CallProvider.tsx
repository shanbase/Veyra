import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
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
      onError: (message) => toast({ title: "Call", description: message, variant: "destructive" }),
    });
    sessionRef.current = session;
    setActiveCall({
      callId,
      conversationId,
      title,
      connecting: true,
      muted: false,
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
      <ActiveCallPanel call={activeCall} onHangUp={hangUp} onToggleMute={toggleMute} />
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

function ActiveCallPanel({
  call,
  onHangUp,
  onToggleMute,
}: {
  call: ActiveCall | null;
  onHangUp: () => void;
  onToggleMute: () => void;
}) {
  const callId = call?.callId;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!callId) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [callId]);

  if (!call) return null;
  const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const others = call.participants.filter((p) => !p.name || p.name !== "");

  return (
    <div className="fixed bottom-4 right-4 z-[90] w-72 rounded-2xl border border-border bg-card/95 backdrop-blur shadow-2xl p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-600/15">
          <Phone className="h-5 w-5 text-green-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{call.title}</p>
          <p className="text-xs text-muted-foreground">
            {call.connecting ? "Connecting…" : `${mm}:${ss}`}
            {others.length > 0 && ` · ${others.length + 1} in call`}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleMute}
          className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors ${
            call.muted ? "bg-destructive/15 text-destructive" : "bg-muted hover:bg-muted/80"
          }`}
        >
          {call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {call.muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          onClick={onHangUp}
          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-destructive text-destructive-foreground text-sm font-medium transition-colors hover:bg-destructive/90"
        >
          <PhoneOff className="h-4 w-4" />
          End
        </button>
      </div>
    </div>
  );
}
