import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface PresenceState {
  odataclause: string;
  user_id: string;
  online_at: string;
}

export function usePresence(conversationId: string | null) {
  const { user } = useAuth();
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const typingExpiryRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (!user || !conversationId) return;

    const channel = supabase.channel(`presence:${conversationId}`);
    channelRef.current = channel;

    channel
      // Typing uses broadcast, not presence state: it's fire-and-forget
      // pub/sub (~100-300ms) instead of the slower track→sync→diff path,
      // and receivers self-expire entries so no stop event or clock sync
      // is needed.
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const typerId = (payload as { user_id?: string } | undefined)?.user_id;
        if (!typerId || typerId === user.id) return;
        const until = Date.now() + 3000;
        typingExpiryRef.current.set(typerId, Math.max(typingExpiryRef.current.get(typerId) || 0, until));
        setTypingUsers((previous) => {
          if (previous.has(typerId)) return previous;
          const next = new Set(previous);
          next.add(typerId);
          return next;
        });
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const online = new Set<string>();

        Object.values(state).forEach((presences: any) => {
          presences.forEach((presence: PresenceState) => {
            if (presence.user_id !== user.id) online.add(presence.user_id);
          });
        });

        setOnlineUsers(online);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            user_id: user.id,
            online_at: new Date().toISOString(),
          });
        }
      });

    // Refresh presence periodically so other clients see a live online_at
    // instead of a stale entry.
    const heartbeat = window.setInterval(() => {
      void channel.track({
        user_id: user.id,
        online_at: new Date().toISOString(),
      }).catch(() => undefined);
    }, 30000);

    const expiryTimer = window.setInterval(() => {
      const now = Date.now();
      setTypingUsers((previous) => {
        const current = new Set([...previous].filter((id) => (typingExpiryRef.current.get(id) || 0) > now));
        if (current.size !== previous.size) return current;
        return previous;
      });
    }, 1000);

    return () => {
      window.clearInterval(expiryTimer);
      window.clearInterval(heartbeat);
      typingExpiryRef.current.clear();
      if (channelRef.current === channel) channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [user, conversationId]);

  const setTyping = useCallback(
    (isTyping: boolean) => {
      const channel = channelRef.current;
      if (!user || !conversationId || !channel || !isTyping) return;
      void channel
        .send({ type: "broadcast", event: "typing", payload: { user_id: user.id } })
        .catch(() => undefined);
    },
    [user, conversationId]
  );

  return { onlineUsers, typingUsers, setTyping };
}

let globalPresenceChannel: ReturnType<typeof supabase.channel> | null = null;
let globalOnlineUsersSet = new Set<string>();
const globalPresenceListeners = new Set<(users: Set<string>) => void>();
let globalPresenceUserId: string | null = null;
let globalHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function useGlobalPresence() {
  const { user } = useAuth();
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(globalOnlineUsersSet);

  useEffect(() => {
    if (!user) return;
    const listener = (users: Set<string>) => setOnlineUsers(new Set(users));
    globalPresenceListeners.add(listener);
    if (!globalPresenceChannel) {
      globalPresenceChannel = supabase.channel("global-presence");
      globalPresenceUserId = user.id;

      globalPresenceChannel
        .on("presence", { event: "sync" }, () => {
          const state = globalPresenceChannel!.presenceState();
          const online = new Set<string>();

          Object.values(state).forEach((presences: any) => {
            presences.forEach((presence: { user_id: string }) => {
              online.add(presence.user_id);
            });
          });

          globalOnlineUsersSet = online;
          globalPresenceListeners.forEach((l) => l(online));
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            await globalPresenceChannel!.track({
              user_id: user.id,
              online_at: new Date().toISOString(),
            });
          }
        });

      // Keep online_at fresh so peers do not see a stale presence entry.
      globalHeartbeatTimer = setInterval(() => {
        const currentUserId = globalPresenceUserId;
        if (!currentUserId || !globalPresenceChannel) return;
        void globalPresenceChannel.track({
          user_id: currentUserId,
          online_at: new Date().toISOString(),
        }).catch(() => undefined);
      }, 60000);
    } else {
      globalPresenceUserId = user.id;
      void globalPresenceChannel.track({
        user_id: user.id,
        online_at: new Date().toISOString(),
      }).catch(() => undefined);
    }

    setOnlineUsers(new Set(globalOnlineUsersSet));

    return () => {
      globalPresenceListeners.delete(listener);
      // Tear the shared channel down once the last consumer unmounts so a
      // signed-out or idle client does not linger as "online".
      if (globalPresenceListeners.size === 0 && globalPresenceChannel) {
        const channel = globalPresenceChannel;
        globalPresenceChannel = null;
        globalPresenceUserId = null;
        globalOnlineUsersSet = new Set();
        if (globalHeartbeatTimer) {
          clearInterval(globalHeartbeatTimer);
          globalHeartbeatTimer = null;
        }
        void supabase.removeChannel(channel);
      }
    };
  }, [user]);

  return { onlineUsers };
}
