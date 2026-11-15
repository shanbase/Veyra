import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useGlobalPresence } from "@/hooks/usePresence";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import {
  BellOff,
  Check,
  Globe,
  Loader2,
  Megaphone,
  MoreVertical,
  Pin,
  Plus,
  Settings,
  Shield,
  ShieldAlert,
  UserMinus,
  UserPlus,
  UserX,
  Users,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { UserProfileDialog } from "@/components/profile/UserProfileDialog";
import { markAnnouncementsRead } from "@/lib/announcements";
import { isStatusActive } from "@/lib/customStatus";
import { CreateGroupDialog } from "@/components/chat/CreateGroupDialog";
import { GroupAvatar, type GroupAvatarMember } from "@/components/chat/GroupAvatar";

type FriendTab = "online" | "all" | "pending" | "blocked" | "add";

interface ProfileLike {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status?: string | null;
  custom_status_text?: string | null;
  custom_status_emoji?: string | null;
  custom_status_expires_at?: string | null;
}

interface Friend extends ProfileLike {
  friendship_id: string;
  conversation_id: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  is_pinned: boolean;
  muted: boolean;
}

interface FriendRequestRow {
  id: string;
  direction: "incoming" | "outgoing";
  sender_id: string;
  receiver_id: string;
  other_user_id: string;
  other_username: string;
  other_display_name: string | null;
  other_avatar_url: string | null;
  other_status: string | null;
  other_custom_status_text: string | null;
  other_custom_status_emoji: string | null;
  other_custom_status_expires_at: string | null;
}

type BlockedUser = ProfileLike;

interface GroupEntry {
  id: string;
  name: string | null;
  member_count: number;
  my_role: "owner" | "admin" | "member";
  unread_count: number;
  last_message_at: string | null;
  is_pinned: boolean;
  muted?: boolean;
  member_previews: GroupAvatarMember[];
}

interface FriendsListProps {
  onSelectConversation: (conversationId: string) => void;
  selectedConversationId: string | null;
}

const TABS: { id: FriendTab; label: string }[] = [
  { id: "online", label: "Online" },
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "blocked", label: "Blocked" },
  { id: "add", label: "Add Friend" },
];

export function FriendsList({ onSelectConversation, selectedConversationId }: FriendsListProps) {
  const { user } = useAuth();
  const { isAdmin, isSuperAdmin } = useUserRole();
  const navigate = useNavigate();
  const { onlineUsers } = useGlobalPresence();
  const [tab, setTab] = useState<FriendTab>("online");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequestRow[]>([]);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [myProfile, setMyProfile] = useState<ProfileLike | null>(null);
  const [searchUsername, setSearchUsername] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unfriendTarget, setUnfriendTarget] = useState<Friend | null>(null);
  const [profileOpenUserId, setProfileOpenUserId] = useState<string | null>(null);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [unreadAnnouncementCount, setUnreadAnnouncementCount] = useState(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshSocial = async () => {
    if (!user) return;
    const [friendResult, requestResult, blockedResult, groupResult] = await Promise.allSettled([
      supabase.rpc("get_friends"),
      supabase.rpc("get_friend_requests"),
      supabase.rpc("get_blocked_users"),
      supabase.rpc("get_user_group_list"),
    ]);
    if (friendResult.status === "fulfilled" && !friendResult.value.error) {
      setFriends((friendResult.value.data || []) as Friend[]);
    }
    if (requestResult.status === "fulfilled" && !requestResult.value.error) {
      setRequests((requestResult.value.data || []) as FriendRequestRow[]);
    }
    if (blockedResult.status === "fulfilled" && !blockedResult.value.error) {
      setBlocked((blockedResult.value.data || []) as BlockedUser[]);
    }
    if (groupResult.status === "fulfilled" && !groupResult.value.error) {
      setGroups(((groupResult.value.data || []) as any[]).map((row) => ({
        id: row.conversation_id,
        name: row.name ?? null,
        member_count: Number(row.member_count ?? 0),
        my_role: row.my_role,
        unread_count: Number(row.unread_count ?? 0),
        last_message_at: row.last_message_at ?? null,
        is_pinned: !!row.is_pinned,
        muted: !!row.muted,
        member_previews: Array.isArray(row.member_previews) ? row.member_previews : [],
      })));
    }
  };

  const scheduleRefresh = () => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshSocial();
    }, 150);
  };

  useEffect(() => {
    if (!user) return;
    void refreshSocial();
    supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url, status, custom_status_text, custom_status_emoji, custom_status_expires_at, global_muted")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => data && setMyProfile(data as ProfileLike));

    const social = supabase
      .channel(`social-sidebar:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "friend_requests" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "blocked_users" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" }, scheduleRefresh)
      .subscribe();
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      supabase.removeChannel(social);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const removedUserId = detail.otherUserId as string | undefined;
      if (removedUserId) {
        setFriends((prev) => prev.filter((friend) => friend.id !== removedUserId));
      }
      void refreshSocial();
    };
    window.addEventListener("friend-removed", handler);
    return () => window.removeEventListener("friend-removed", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const loadAnnouncements = async () => {
      const { data: profile } = await supabase
        .from("profiles")
        .select("announcements_last_read_at")
        .eq("id", user.id)
        .maybeSingle();
      let query = supabase.from("announcement_messages").select("*", { count: "exact", head: true });
      if (profile?.announcements_last_read_at) query = query.gt("created_at", profile.announcements_last_read_at);
      const { count } = await query;
      setUnreadAnnouncementCount(count || 0);
    };
    void loadAnnouncements();
    const channel = supabase
      .channel("announcements-unread")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "announcement_messages" }, () => void loadAnnouncements())
      .subscribe();
    const readHandler = () => setUnreadAnnouncementCount(0);
    window.addEventListener("announcements-read", readHandler);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener("announcements-read", readHandler);
    };
  }, [user]);

  const visibleFriends = useMemo(() => {
    if (tab === "online") return friends.filter((friend) => onlineUsers.has(friend.id));
    return friends;
  }, [friends, onlineUsers, tab]);

  const isOnline = (userId: string) => onlineUsers.has(userId);
  const displayName = (profile: ProfileLike | null | undefined) => profile?.display_name || profile?.username || "Unknown";

  const openFriend = async (friend: Friend) => {
    if (friend.conversation_id) {
      onSelectConversation(friend.conversation_id);
      return;
    }
    setBusyId(friend.id);
    try {
      const { data, error } = await supabase.rpc("get_or_create_dm", { _other_user_id: friend.id });
      if (error) throw error;
      const conversationId = data as unknown as string;
      await refreshSocial();
      onSelectConversation(conversationId);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const sendRequest = async () => {
    const username = searchUsername.trim();
    if (!user || !username) return;
    setBusyId("add-friend");
    try {
      const { data, error } = await supabase.rpc("send_friend_request", { _username: username });
      if (error) throw error;
      const status = (data as any)?.status;
      toast({
        title: status === "already_friends" ? "You're already friends" : status?.startsWith("pending") ? "Request already pending" : "Friend request sent!",
      });
      setSearchUsername("");
      await refreshSocial();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const respondRequest = async (request: FriendRequestRow, accept: boolean) => {
    setBusyId(request.id);
    try {
      const { error } = await supabase.rpc("respond_friend_request", { _friendship_id: request.id, _accept: accept });
      if (error) throw error;
      toast({ title: accept ? "Friend added!" : "Request declined" });
      await refreshSocial();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const cancelRequest = async (request: FriendRequestRow) => {
    setBusyId(request.id);
    try {
      const { error } = await supabase.rpc("cancel_friend_request", { _friendship_id: request.id });
      if (error) throw error;
      await refreshSocial();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const unfriend = async () => {
    if (!unfriendTarget) return;
    setBusyId(unfriendTarget.id);
    try {
      const { data, error } = await supabase.rpc("unfriend", { _friendship_id: unfriendTarget.friendship_id });
      if (error) throw error;
      const result = data as any;
      window.dispatchEvent(new CustomEvent("friend-removed", {
        detail: { otherUserId: result?.other_user_id || unfriendTarget.id, conversationId: result?.conversation_id || unfriendTarget.conversation_id },
      }));
      toast({ title: "Unfriended" });
      setUnfriendTarget(null);
      await refreshSocial();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const blockUser = async (target: ProfileLike) => {
    setBusyId(target.id);
    try {
      const { data, error } = await supabase.rpc("block_user", { _other_id: target.id });
      if (error) throw error;
      window.dispatchEvent(new CustomEvent("friend-removed", { detail: { otherUserId: target.id, conversationId: (data as any)?.conversation_id || null } }));
      window.dispatchEvent(new CustomEvent("user-blocked", { detail: { userId: target.id } }));
      toast({ title: "User blocked" });
      await refreshSocial();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const unblockUser = async (target: BlockedUser) => {
    setBusyId(target.id);
    try {
      const { error } = await supabase.rpc("unblock_user", { _other_id: target.id });
      if (error) throw error;
      window.dispatchEvent(new CustomEvent("user-unblocked", { detail: { userId: target.id } }));
      await refreshSocial();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const friendRow = (friend: Friend) => {
    const online = isOnline(friend.id);
    return (
      <div
        key={friend.id}
        className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${
          friend.conversation_id === selectedConversationId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
        }`}
      >
        <button type="button" onClick={() => void openFriend(friend)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <div className="relative flex-shrink-0">
            <Avatar className="h-10 w-10">
              <AvatarImage src={friend.avatar_url || undefined} />
              <AvatarFallback>{friend.username?.[0]?.toUpperCase() || "?"}</AvatarFallback>
            </Avatar>
            <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-sidebar ${online ? "bg-green-500" : "bg-muted-foreground"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="font-medium text-sidebar-foreground truncate">{displayName(friend)}</p>
              {friend.is_pinned && <Pin className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
              {friend.muted && <BellOff className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {online ? "Online" : friend.last_message_preview || "Offline"}
            </p>
          </div>
        </button>
        {friend.unread_count > 0 && (
          <Badge variant="default" className="h-5 min-w-5 flex items-center justify-center rounded-full px-1.5 text-xs flex-shrink-0">
            {friend.unread_count > 99 ? "99+" : friend.unread_count}
          </Badge>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={(event) => event.stopPropagation()}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="end">
            <Button variant="outline" className="w-full justify-start mb-2" onClick={() => setProfileOpenUserId(friend.id)}>View profile</Button>
            <Button variant="outline" className="w-full justify-start mb-2" onClick={() => void openFriend(friend)}>Message</Button>
            <Button variant="outline" className="w-full justify-start mb-2" onClick={() => void blockUser(friend)}>Block</Button>
            <Button variant="destructive" className="w-full justify-start" onClick={() => setUnfriendTarget(friend)}>
              <UserMinus className="h-4 w-4 mr-2" /> Unfriend
            </Button>
          </PopoverContent>
        </Popover>
      </div>
    );
  };

  const requestRow = (request: FriendRequestRow) => (
    <div key={request.id} className="flex items-center gap-3 p-2 rounded-lg bg-sidebar-accent/60">
      <button type="button" onClick={() => setProfileOpenUserId(request.other_user_id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
        <Avatar className="h-10 w-10">
          <AvatarImage src={request.other_avatar_url || undefined} />
          <AvatarFallback>{request.other_username?.[0]?.toUpperCase() || "?"}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="font-medium text-sidebar-foreground truncate">{request.other_display_name || request.other_username}</p>
          <p className="text-xs text-muted-foreground">{request.direction === "incoming" ? "Incoming request" : "Outgoing request"}</p>
        </div>
      </button>
      {request.direction === "incoming" ? (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busyId === request.id} onClick={() => void respondRequest(request, true)} aria-label="Accept friend request">
            <Check className="h-4 w-4 text-green-500" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busyId === request.id} onClick={() => void respondRequest(request, false)} aria-label="Decline friend request">
            <X className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" disabled={busyId === request.id} onClick={() => void cancelRequest(request)}>Cancel</Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-transparent">
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-sidebar-foreground">Veyra</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/settings")} aria-label="Settings">
            <Settings className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors ${
                tab === item.id ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground hover:bg-sidebar-accent/50"
              }`}
            >
              {item.label}
              {item.id === "pending" && requests.length > 0 ? ` (${requests.length})` : ""}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-2 space-y-2">
        <Button variant="outline" className="w-full justify-between" onClick={() => { setUnreadAnnouncementCount(0); if (user?.id) void markAnnouncementsRead(user.id).catch(() => {}); navigate("/announcements"); }}>
          <span className="flex items-center gap-2"><Megaphone className="h-4 w-4" /> Announcements</span>
          {unreadAnnouncementCount > 0 && <Badge className="h-5 min-w-5 rounded-full px-1.5 text-xs">{unreadAnnouncementCount > 99 ? "99+" : unreadAnnouncementCount}</Badge>}
        </Button>
        <Button variant="outline" className="w-full justify-between" onClick={() => navigate("/global-chat")}>
          <span className="flex items-center gap-2"><Globe className="h-4 w-4" /> Global Chat</span>
          {(myProfile as any)?.global_muted && <BellOff className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 pb-2">
          {tab === "add" ? (
            <div className="p-3 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-sidebar-foreground">Add Friend</h3>
                <p className="text-xs text-muted-foreground mt-1">Enter a username to send a friend request.</p>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Username"
                  value={searchUsername}
                  onChange={(event) => setSearchUsername(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void sendRequest()}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <Button size="icon" onClick={() => void sendRequest()} disabled={busyId === "add-friend"} aria-label="Send friend request">
                  {busyId === "add-friend" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          ) : tab === "pending" ? (
            <div className="space-y-2 p-1">
              <h3 className="text-sm font-medium text-sidebar-foreground px-2 pt-2">Friend Requests</h3>
              {requests.length === 0 ? <p className="text-xs text-muted-foreground text-center py-6">No pending requests.</p> : requests.map(requestRow)}
            </div>
          ) : tab === "blocked" ? (
            <div className="space-y-2 p-1">
              <h3 className="text-sm font-medium text-sidebar-foreground px-2 pt-2">Blocked Users</h3>
              {blocked.length === 0 ? <p className="text-xs text-muted-foreground text-center py-6">No blocked users.</p> : blocked.map((target) => (
                <div key={target.id} className="flex items-center gap-3 p-2 rounded-lg bg-sidebar-accent/60">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar className="h-10 w-10"><AvatarImage src={target.avatar_url || undefined} /><AvatarFallback>{target.username?.[0]?.toUpperCase() || "?"}</AvatarFallback></Avatar>
                    <div className="min-w-0"><p className="font-medium text-sidebar-foreground truncate">{displayName(target)}</p><p className="text-xs text-muted-foreground">@{target.username}</p></div>
                  </div>
                  <Button size="sm" variant="outline" disabled={busyId === target.id} onClick={() => void unblockUser(target)}>Unblock</Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1 p-1">
              <h3 className="text-sm font-medium text-sidebar-foreground px-2 pt-2">{tab === "online" ? "Online" : "All Friends"}</h3>
              {visibleFriends.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6 px-3">{tab === "online" ? "No friends online." : "No friends yet. Use Add Friend to get started."}</p>
              ) : visibleFriends.map(friendRow)}
            </div>
          )}

          <div className="flex items-center justify-between px-2 pt-4 pb-1">
            <h3 className="text-sm font-medium text-sidebar-foreground">Groups</h3>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowCreateGroup(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New
            </Button>
          </div>
          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2 px-3">No groups yet.</p>
          ) : groups.map((group) => {
            const name = group.name?.trim() || group.member_previews.map((member) => member.display_name || member.username || "Member").slice(0, 3).join(", ");
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => onSelectConversation(group.id)}
                className={`flex items-center gap-3 p-2 rounded-lg transition-colors w-full text-left ${group.id === selectedConversationId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"}`}
              >
                <GroupAvatar members={group.member_previews} name={group.name} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <p className="font-medium text-sidebar-foreground truncate">{name}</p>
                    {group.is_pinned && <Pin className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                    {group.muted && <BellOff className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" />{group.member_count} members</p>
                </div>
                {group.unread_count > 0 && <Badge className="h-5 min-w-5 rounded-full px-1.5 text-xs flex-shrink-0">{group.unread_count > 99 ? "99+" : group.unread_count}</Badge>}
              </button>
            );
          })}
        </div>
      </ScrollArea>

      {isAdmin && (
        <div className="px-4 py-2">
          <Button variant="outline" className="w-full justify-start gap-2" onClick={() => navigate("/admin")}>
            {isSuperAdmin ? <ShieldAlert className="h-4 w-4 text-destructive" /> : <Shield className="h-4 w-4" />}
            Admin Dashboard
            {isSuperAdmin && <Badge variant="destructive" className="ml-auto text-[10px]">Super</Badge>}
          </Button>
        </div>
      )}

      <div className="p-3">
        <div className="flex items-center gap-2 rounded-2xl border border-sidebar-border bg-sidebar-accent/60 backdrop-blur p-2 shadow-sm">
          <button type="button" onClick={() => user && setProfileOpenUserId(user.id)} className="block rounded-full focus:outline-none flex-shrink-0" aria-label="Open profile">
            <Avatar className="h-8 w-8"><AvatarImage src={(myProfile as any)?.avatar_url || undefined} /><AvatarFallback>{(myProfile as any)?.username?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || "?"}</AvatarFallback></Avatar>
          </button>
          <button type="button" onClick={() => user && setProfileOpenUserId(user.id)} className="flex flex-col flex-1 min-w-0 rounded-xl px-1 py-1 hover:bg-sidebar-accent transition-colors text-left">
            <span className="text-sm font-medium text-sidebar-foreground truncate">{displayName(myProfile)}</span>
            {isStatusActive(myProfile as any) && <span className="text-xs text-muted-foreground truncate">{(myProfile as any)?.custom_status_emoji ? `${(myProfile as any).custom_status_emoji} ` : ""}{(myProfile as any)?.custom_status_text}</span>}
          </button>
        </div>
      </div>

      <UserProfileDialog userId={profileOpenUserId} onOpenChange={(open) => !open && setProfileOpenUserId(null)} />

      <AlertDialog open={!!unfriendTarget} onOpenChange={(open) => !open && setUnfriendTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unfriend {unfriendTarget ? displayName(unfriendTarget) : "user"}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the friendship. Existing direct-message history is preserved for both people.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busyId}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void unfriend()} disabled={!!busyId} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {busyId ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserX className="h-4 w-4 mr-2" />} Unfriend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateGroupDialog
        open={showCreateGroup}
        onOpenChange={setShowCreateGroup}
        onCreated={(id) => {
          void refreshSocial();
          onSelectConversation(id);
        }}
      />
    </div>
  );
}
