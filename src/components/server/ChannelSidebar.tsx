import { useEffect, useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/hooks/use-toast";
import { Hash, Loader2, Lock, Plus, Settings, Trash2, UserMinus, Users } from "lucide-react";
import { rpc, type ServerView } from "./api";

interface ChannelSidebarProps {
  view: ServerView;
  selectedChannelId: string | null;
  onSelectChannel: (conversationId: string) => void;
  onChanged: () => void;
  onOpenSettings: (tab?: string) => void;
}

export function ChannelSidebar({ view, selectedChannelId, onSelectChannel, onChanged, onOpenSettings }: ChannelSidebarProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const server = view.server;
  const canManageChannels = view.my_permissions?.includes("manage_channels");
  const canManageServer = view.my_permissions?.includes("manage_server") || view.is_owner;

  const grouped = useMemo(() => {
    const categories = [...(view.categories || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const channels = [...(view.channels || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const byCategory = new Map<string | null, any[]>();
    for (const channel of channels) {
      const key = channel.category_id || null;
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key)!.push(channel);
    }
    const uncategorized = byCategory.get(null) || [];
    return { categories, uncategorized, byCategory };
  }, [view.categories, view.channels]);

  const channelButton = (channel: any) => {
    const selected = channel.conversation_id === selectedChannelId;
    const mentions = Number(channel.mention_count || 0);
    const unread = Number(channel.unread_count || 0);
    return (
      <button
        key={channel.id}
        type="button"
        onClick={() => onSelectChannel(channel.conversation_id)}
        className={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
          selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        }`}
        title={channel.topic || channel.name}
      >
        {channel.is_readonly ? <Lock className="h-4 w-4 flex-shrink-0" /> : <Hash className="h-4 w-4 flex-shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        {mentions > 0 ? (
          <Badge variant="destructive" className="h-5 min-w-5 justify-center rounded-full px-1 text-[10px]">{mentions > 99 ? "99+" : mentions}</Badge>
        ) : unread > 0 ? (
          <span className="h-2 w-2 rounded-full bg-white" />
        ) : null}
      </button>
    );
  };

  return (
    <aside className="flex h-full w-60 flex-shrink-0 flex-col border-r bg-sidebar">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex h-14 w-full items-center justify-between border-b px-4 font-semibold text-sidebar-foreground hover:bg-sidebar-accent/60">
            <span className="min-w-0 truncate">{server.name}</span>
            <Settings className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => setInviteOpen(true)}>Invite people</DropdownMenuItem>
          {canManageChannels && <DropdownMenuItem onClick={() => onOpenSettings("channels")}>Create Channel</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onOpenSettings("overview")}>Server Settings</DropdownMenuItem>
          {canManageServer && <DropdownMenuItem onClick={() => onOpenSettings("roles")}>Roles</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => onOpenSettings("members")}>Members</DropdownMenuItem>
          <DropdownMenuSeparator />
          {view.is_owner ? (
            <DropdownMenuItem
              className="text-destructive"
              onClick={async () => {
                if (!window.confirm(`Delete ${server.name}? This cannot be undone.`)) return;
                try {
                  await rpc("delete_server", { _server_id: server.id });
                  toast({ title: "Server deleted" });
                  onChanged();
                } catch (error: any) {
                  toast({ title: "Error", description: error.message, variant: "destructive" });
                }
              }}
            >
              <UserMinus className="mr-2 h-4 w-4" /> Delete Server
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className="text-destructive"
              onClick={async () => {
                try {
                  await rpc("leave_server", { _server_id: server.id });
                  toast({ title: "Left server" });
                  onChanged();
                } catch (error: any) {
                  toast({ title: "Error", description: error.message, variant: "destructive" });
                }
              }}
            >
              <UserMinus className="mr-2 h-4 w-4" /> Leave Server
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-2">
          {grouped.uncategorized.length > 0 && (
            <div className="space-y-0.5">
              {grouped.uncategorized.map(channelButton)}
            </div>
          )}
          {grouped.categories.map((category) => (
            <div key={category.id} className="space-y-0.5">
              <div className="flex items-center justify-between px-2 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span className="truncate">{category.name}</span>
                {canManageChannels && (
                  <button type="button" onClick={() => onOpenSettings("channels")} className="rounded p-0.5 hover:bg-sidebar-accent" title="Manage channels">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {(grouped.byCategory.get(category.id) || []).map(channelButton)}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="flex h-12 items-center gap-2 border-t px-3 text-xs text-muted-foreground">
        <Users className="h-4 w-4" />
        {view.members?.length || 0} members
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} serverId={server.id} view={view} />
    </aside>
  );
}

function InviteDialog({ open, onOpenChange, serverId, view }: { open: boolean; onOpenChange: (open: boolean) => void; serverId: string; view: ServerView }) {
  const canRevokeAny = view.is_owner || view.my_permissions?.includes("manage_server");
  const [invites, setInvites] = useState<any[]>([]);
  const [maxUses, setMaxUses] = useState("");
  const [expiresHours, setExpiresHours] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const data = await rpc<any[]>("list_invites", { _server_id: serverId });
      setInvites(data || []);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  const create = async () => {
    setBusy(true);
    try {
      await rpc("create_invite", {
        _server_id: serverId,
        _max_uses: maxUses ? Number(maxUses) : null,
        _expires_in_hours: expiresHours ? Number(expiresHours) : null,
      });
      toast({ title: "Invite created" });
      await load();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId: string) => {
    try {
      await rpc("revoke_invite", { _invite_id: inviteId });
      await load();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Invite people</DialogTitle><DialogDescription>Share a code or link with people who should join.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>Max uses</Label><Input type="number" min="1" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="Unlimited" /></div>
          <div className="space-y-1"><Label>Expires in hours</Label><Input type="number" min="1" value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)} placeholder="Never" /></div>
        </div>
        <Button onClick={() => void create()} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create invite</Button>
        <div className="max-h-56 space-y-2 overflow-y-auto">
          {invites.map((invite) => (
            <div key={invite.id} className="flex items-center gap-2 rounded-md border p-2">
              <code className="flex-1 truncate text-sm">{invite.code}</code>
              <span className="text-xs text-muted-foreground">{invite.uses || 0}{invite.max_uses ? `/${invite.max_uses}` : ""}</span>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/chat?join=${invite.code}`).then(() => toast({ title: "Invite copied" }))}>Copy</Button>
              {!invite.revoked_at && (canRevokeAny || invite.created_by === view.membership?.user_id) && <Button size="icon" variant="ghost" onClick={() => void revoke(invite.id)}><Trash2 className="h-4 w-4" /></Button>}
            </div>
          ))}
          {invites.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No invites yet.</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
