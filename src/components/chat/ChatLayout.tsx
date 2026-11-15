import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { FriendsList } from "@/components/chat/FriendsList";
import { ChatView } from "@/components/chat/ChatView";
import { UserProfileDialog } from "@/components/profile/UserProfileDialog";
import { ServerRail } from "@/components/server/ServerRail";
import { ChannelSidebar } from "@/components/server/ChannelSidebar";
import { MemberList } from "@/components/server/MemberList";
import { ServerSettingsDialog } from "@/components/server/ServerSettingsDialog";
import { rpc, type ServerSummary, type ServerView } from "@/components/server/api";
import { supabase } from "@/integrations/supabase/client";
import { registerNativePush } from "@/lib/pushNotifications";
import { Button } from "@/components/ui/button";

type ActivePane = "global" | "announcements" | "dm" | "server" | "list";

export default function ChatLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();

  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [serverView, setServerView] = useState<ServerView | null>(null);
  const [serverViewError, setServerViewError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("overview");
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate("/auth");
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user?.id) void registerNativePush(user.id);
  }, [user?.id]);

  useEffect(() => {
    document.body.classList.add("chat-locked");
    return () => document.body.classList.remove("chat-locked");
  }, []);

  const path = location.pathname;
  const conversationId = searchParams.get("c");
  const serverIdParam = searchParams.get("s");
  const joinCode = searchParams.get("join");

  const active: ActivePane = path.startsWith("/global-chat")
    ? "global"
    : path.startsWith("/announcements")
      ? "announcements"
      : serverIdParam
        ? "server"
        : conversationId
          ? "dm"
          : "list";

  const [activeConversationId, setActiveConversationId] = useState<string | null>(conversationId);
  useEffect(() => {
    if (conversationId && conversationId !== activeConversationId) setActiveConversationId(conversationId);
  }, [conversationId, activeConversationId]);

  const loadServers = useCallback(async () => {
    if (!user) return;
    try {
      const data = await rpc<ServerSummary[]>("get_my_servers");
      setServers(data || []);
    } catch {
      setServers([]);
    }
  }, [user]);

  const loadServerView = useCallback(async (id: string | null) => {
    setServerViewError(null);
    if (!id) {
      setServerView(null);
      return;
    }
    try {
      const data = await rpc<ServerView>("get_server_view", { _server_id: id });
      setServerView(data);
    } catch (error) {
      setServerView(null);
      setServerViewError(error instanceof Error ? error.message : "Could not load this server.");
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  useEffect(() => {
    void loadServerView(serverIdParam);
  }, [serverIdParam, loadServerView]);

  useEffect(() => {
    if (serverIdParam && servers.length > 0 && !servers.some((server) => server.id === serverIdParam)) {
      setSearchParams({}, { replace: true });
    }
  }, [serverIdParam, servers, setSearchParams]);

  useEffect(() => {
    if (!user || !joinCode) return;
    void (async () => {
      try {
        const result = await rpc<{ server_id: string }>("join_server_by_code", { _code: joinCode });
        await loadServers();
        if (path !== "/chat") navigate(`/chat?s=${result.server_id}`);
        else setSearchParams({ s: result.server_id }, { replace: true });
      } catch {
        // Invalid/expired invite — stay on the current screen.
      }
    })();
  }, [joinCode, user, loadServers, setSearchParams, path, navigate]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void loadServers();
      void loadServerView(serverIdParam);
    }, 200);
  }, [loadServers, loadServerView, serverIdParam]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`server-shell:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "servers" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "server_members" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "server_channels" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "server_roles" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "server_categories" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, scheduleRefresh)
      .subscribe();
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [user, scheduleRefresh]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const removedConvId = detail.conversationId as string | null | undefined;
      if (removedConvId && removedConvId === activeConversationId) {
        setActiveConversationId(null);
        if (path === "/chat") setSearchParams({}, { replace: true });
        else navigate("/chat");
      }
      void loadServers();
    };
    window.addEventListener("friend-removed", handler);
    return () => window.removeEventListener("friend-removed", handler);
  }, [activeConversationId, path, navigate, setSearchParams, loadServers]);

  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id);
    if (path !== "/chat") navigate(`/chat?c=${id}`);
    else setSearchParams({ c: id }, { replace: true });
  };

  const handleSelectServer = (id: string | null) => {
    setActiveConversationId(null);
    if (path !== "/chat") {
      if (id) navigate(`/chat?s=${id}`);
      else navigate("/chat");
      return;
    }
    if (id) setSearchParams({ s: id }, { replace: true });
    else setSearchParams({}, { replace: true });
  };

  const handleSelectChannel = (id: string) => {
    setActiveConversationId(id);
    if (serverIdParam) setSearchParams({ s: serverIdParam, c: id }, { replace: true });
  };

  const handleBack = () => {
    if (serverIdParam) setSearchParams({ s: serverIdParam }, { replace: true });
    else if (path === "/chat") setSearchParams({}, { replace: true });
    else navigate("/chat");
  };

  const serverLoadError = serverViewError ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <p className="text-sm">{serverViewError}</p>
      <Button variant="outline" onClick={() => handleSelectServer(null)}>Back to messages</Button>
    </div>
  ) : null;

  const selectedChannel = useMemo(() => {
    if (!serverView || !conversationId) return null;
    return serverView.channels.find((channel) => channel.conversation_id === conversationId) || null;
  }, [serverView, conversationId]);

  const serverChannelProp = useMemo(() => {
    if (!serverView || !selectedChannel) return null;
    const permissions = new Set(selectedChannel.permissions || serverView.my_permissions || []);
    const canPost = permissions.has("send_messages") && (!selectedChannel.is_readonly || permissions.has("manage_messages"));
    const canMentionEveryone = permissions.has("mention_everyone");
    return {
      serverId: serverView.server.id,
      channelId: selectedChannel.id,
      name: selectedChannel.name,
      topic: selectedChannel.topic || null,
      isReadonly: !!selectedChannel.is_readonly,
      canPost,
      canMentionEveryone,
      serverName: serverView.server.name,
    };
  }, [serverView, selectedChannel]);

  const mentionContext = useMemo(() => {
    if (!serverView) return null;
    const canMentionRoles = (serverView.my_permissions || []).includes("manage_roles");
    return {
      roles: canMentionRoles
        ? Object.fromEntries((serverView.roles || []).filter((role) => !role.is_default).map((role) => [role.id, { name: role.name, color: role.color }]))
        : {},
      channels: Object.fromEntries((serverView.channels || []).map((channel) => [channel.id, channel.name])),
    };
  }, [serverView]);

  if (loading || !user) {
    return <div className="flex h-screen items-center justify-center"><p className="text-muted-foreground">Loading...</p></div>;
  }

  const channelPanes = (
    <>
      <div className={`h-full ${active === "global" ? "block" : "hidden"}`}>
        <ChatView channel="global" isActive={active === "global"} isMobile={isMobile} onBack={isMobile ? handleBack : undefined} />
      </div>
      <div className={`h-full ${active === "announcements" ? "block" : "hidden"}`}>
        <ChatView channel="announcements" isActive={active === "announcements"} isMobile={isMobile} onBack={isMobile ? handleBack : undefined} />
      </div>
      {activeConversationId && (
        <div className={`h-full ${active === "dm" || active === "server" ? "block" : "hidden"}`}>
          <ChatView
            key={`${active === "server" ? `server:${serverIdParam}` : "dm"}:${activeConversationId}`}
            conversationId={activeConversationId}
            isActive={active === "dm" || active === "server"}
            isMobile={isMobile}
            onBack={isMobile ? handleBack : undefined}
            serverChannel={serverChannelProp}
            mentionContext={mentionContext}
          />
        </div>
      )}
    </>
  );

  const serverPane = serverIdParam ? (
    <>
      <ChannelSidebar
        view={serverView!}
        selectedChannelId={selectedChannel?.conversation_id || null}
        onSelectChannel={handleSelectChannel}
        onChanged={() => { void loadServers(); void loadServerView(serverIdParam); }}
        onOpenSettings={(tab) => { setSettingsTab(tab || "overview"); setSettingsOpen(true); }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {activeConversationId && selectedChannel ? channelPanes : (
          <div className="flex h-full items-center justify-center text-muted-foreground">Select a channel</div>
        )}
      </div>
      {!isMobile && serverView && <MemberList view={serverView} onOpenProfile={setProfileUserId} />}
    </>
  ) : null;

  if (isMobile) {
    return (
      <div className="flex h-[100dvh] flex-col">
        <ServerRail servers={servers} selectedServerId={serverIdParam} onSelectServer={handleSelectServer} onChanged={() => void loadServers()} mobile />
        <div className="min-h-0 flex-1">
          {active === "server" ? (
            serverView ? (
              conversationId && selectedChannel ? (
                <div className="h-full">{channelPanes}</div>
              ) : (
                <ChannelSidebar
                  view={serverView}
                  selectedChannelId={null}
                  onSelectChannel={handleSelectChannel}
                  onChanged={() => { void loadServers(); void loadServerView(serverIdParam); }}
                  onOpenSettings={(tab) => { setSettingsTab(tab || "overview"); setSettingsOpen(true); }}
                />
              )
            ) : serverViewError ? serverLoadError : <div className="flex h-full items-center justify-center text-muted-foreground">Loading server…</div>
          ) : active === "list" ? (
            <FriendsList onSelectConversation={handleSelectConversation} selectedConversationId={active === "dm" ? activeConversationId : null} />
          ) : (
            channelPanes
          )}
        </div>
        {serverView && <ServerSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} view={serverView} initialTab={settingsTab} onChanged={() => { void loadServers(); void loadServerView(serverIdParam); }} />}
        <UserProfileDialog userId={profileUserId} onOpenChange={(open) => !open && setProfileUserId(null)} />
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] gap-0 bg-background">
      <ServerRail servers={servers} selectedServerId={serverIdParam} onSelectServer={handleSelectServer} onChanged={() => void loadServers()} />
      {serverIdParam ? (
        serverView ? serverPane : serverViewError ? serverLoadError : <div className="flex flex-1 items-center justify-center text-muted-foreground">Loading server…</div>
      ) : (
        <>
          <div className="w-80 flex-shrink-0 border-r bg-sidebar">
            <FriendsList onSelectConversation={handleSelectConversation} selectedConversationId={active === "dm" ? activeConversationId : null} />
          </div>
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {active === "list" && (
              <div className="flex h-full items-center justify-center">
                <p className="text-lg text-muted-foreground">Select a conversation to start chatting</p>
              </div>
            )}
            {channelPanes}
          </div>
        </>
      )}
      {serverView && <ServerSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} view={serverView} initialTab={settingsTab} onChanged={() => { void loadServers(); void loadServerView(serverIdParam); }} />}
      <UserProfileDialog userId={profileUserId} onOpenChange={(open) => !open && setProfileUserId(null)} />
    </div>
  );
}
