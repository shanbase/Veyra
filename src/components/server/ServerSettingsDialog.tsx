import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { Clock, Hash, ImagePlus, Loader2, Pencil, Trash2, UserMinus } from "lucide-react";
import { rpc, uploadServerImage, type ServerView } from "./api";

const PERMISSIONS = [
  "view_channel", "send_messages", "attach_files", "add_reactions", "create_poll", "embed_links",
  "mention_everyone", "manage_messages", "manage_channels", "manage_roles", "kick_members", "ban_members", "manage_nicknames", "manage_server",
];

interface ServerSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ServerView;
  initialTab?: string;
  onChanged: () => void;
}

export function ServerSettingsDialog({ open, onOpenChange, view, initialTab = "overview", onChanged }: ServerSettingsDialogProps) {
  const server = view.server;
  const can = (permission: string) => view.is_owner || view.my_permissions?.includes(permission);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Server Settings</DialogTitle>
          <DialogDescription>{server.name}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={initialTab} key={initialTab} className="min-h-[420px]">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-4"><OverviewTab view={view} can={can} onChanged={onChanged} /></TabsContent>
          <TabsContent value="channels" className="pt-4"><ChannelsTab view={view} can={can} onChanged={onChanged} /></TabsContent>
          <TabsContent value="roles" className="pt-4"><RolesTab view={view} can={can} onChanged={onChanged} /></TabsContent>
          <TabsContent value="members" className="pt-4"><MembersTab view={view} can={can} onChanged={onChanged} /></TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function OverviewTab({ view, can, onChanged }: { view: ServerView; can: (p: string) => boolean; onChanged: () => void }) {
  const server = view.server;
  const [name, setName] = useState(server.name || "");
  const [description, setDescription] = useState(server.description || "");
  const [verification, setVerification] = useState(server.verification_level || "none");
  const [busy, setBusy] = useState(false);
  const iconRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(server.name || "");
    setDescription(server.description || "");
    setVerification(server.verification_level || "none");
  }, [server.id, server.name, server.description, server.verification_level]);

  const save = async () => {
    setBusy(true);
    try {
      await rpc("update_server", { _server_id: server.id, _name: name, _description: description, _verification_level: verification });
      toast({ title: "Server updated" });
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const upload = async (image: "icon" | "banner", file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadServerImage(server.id, image, file);
      await rpc("update_server", { _server_id: server.id, [image === "icon" ? "_icon_url" : "_banner_url"]: url });
      toast({ title: image === "icon" ? "Icon updated" : "Banner updated" });
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <div className="relative">
          <Avatar className="h-20 w-20 rounded-2xl"><AvatarImage src={server.icon_url || undefined} /><AvatarFallback className="rounded-2xl text-xl">{server.name?.[0]?.toUpperCase()}</AvatarFallback></Avatar>
          {can("manage_server") && <button type="button" onClick={() => iconRef.current?.click()} className="absolute -bottom-2 -right-2 rounded-full bg-primary p-1.5 text-primary-foreground"><ImagePlus className="h-4 w-4" /></button>}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Server icon</p>
          <p className="text-xs text-muted-foreground">PNG, JPEG, WebP, GIF, or AVIF up to 25 MB.</p>
        </div>
        <input ref={iconRef} type="file" accept="image/*" className="hidden" onChange={(e) => void upload("icon", e.target.files?.[0])} />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Server banner</Label>
          {can("manage_server") && <Button size="sm" variant="outline" onClick={() => bannerRef.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />Upload</Button>}
        </div>
        {server.banner_url ? <img src={server.banner_url} alt="" className="h-24 w-full rounded-lg object-cover" /> : <div className="h-24 rounded-lg border border-dashed bg-muted/40" />}
        <input ref={bannerRef} type="file" accept="image/*" className="hidden" onChange={(e) => void upload("banner", e.target.files?.[0])} />
      </div>
      <div className="space-y-2"><Label>Server name</Label><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!can("manage_server")} /></div>
      <div className="space-y-2"><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={!can("manage_server")} /></div>
      <div className="space-y-2">
        <Label>Verification level</Label>
        <Select value={verification} onValueChange={setVerification} disabled={!can("manage_server")}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="low">Low — verified email</SelectItem>
            <SelectItem value="medium">Medium — account older than 1 day</SelectItem>
            <SelectItem value="high">High — account older than 7 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {can("manage_server") && <Button onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save changes</Button>}
    </div>
  );
}

function ChannelsTab({ view, can, onChanged }: { view: ServerView; can: (p: string) => boolean; onChanged: () => void }) {
  const serverId = view.server.id;
  const [channelName, setChannelName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can("manage_channels");

  const createChannel = async () => {
    if (!channelName.trim()) return;
    setBusy(true);
    try {
      await rpc("create_channel", { _server_id: serverId, _name: channelName.trim() });
      setChannelName("");
      toast({ title: "Channel created" });
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const createCategory = async () => {
    if (!categoryName.trim()) return;
    setBusy(true);
    try {
      await rpc("create_category", { _server_id: serverId, _name: categoryName.trim() });
      setCategoryName("");
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const saveChannel = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await rpc("update_channel", { _channel_id: editing.id, _name: editing.name, _topic: editing.topic, _category_id: editing.category_id || null, _slow_mode_seconds: Number(editing.slow_mode_seconds || 0), _is_readonly: !!editing.is_readonly });
      setEditing(null);
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const deleteChannel = async (channel: any) => {
    try {
      await rpc("delete_channel", { _channel_id: channel.id });
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {manage && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2"><Label>New channel</Label><div className="flex gap-2"><Input value={channelName} onChange={(e) => setChannelName(e.target.value)} placeholder="general" /><Button onClick={() => void createChannel()} disabled={busy}>Add</Button></div></div>
          <div className="space-y-2"><Label>New category</Label><div className="flex gap-2"><Input value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="Community" /><Button variant="outline" onClick={() => void createCategory()} disabled={busy}>Add</Button></div></div>
        </div>
      )}
      <ScrollArea className="h-80">
        <div className="space-y-2 pr-3">
          {(view.channels || []).map((channel) => (
            <div key={channel.id} className="rounded-lg border p-3">
              {editing?.id === channel.id ? (
                <div className="space-y-3">
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  <Input value={editing.topic || ""} onChange={(e) => setEditing({ ...editing, topic: e.target.value })} placeholder="Topic" />
                  <Select value={editing.category_id || "none"} onValueChange={(value) => setEditing({ ...editing, category_id: value === "none" ? null : value })}>
                    <SelectTrigger><SelectValue placeholder="Category" /></SelectTrigger>
                    <SelectContent><SelectItem value="none">No category</SelectItem>{(view.categories || []).map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <div className="grid grid-cols-2 gap-3">
                    <Input type="number" min="0" value={editing.slow_mode_seconds || 0} onChange={(e) => setEditing({ ...editing, slow_mode_seconds: e.target.value })} placeholder="Slow mode seconds" />
                    <label className="flex items-center gap-2 text-sm"><Checkbox checked={!!editing.is_readonly} onCheckedChange={(checked) => setEditing({ ...editing, is_readonly: checked })} /> Read-only</label>
                  </div>
                  <div className="flex gap-2"><Button size="sm" onClick={() => void saveChannel()} disabled={busy}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{channel.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{channel.topic || "No topic"}{channel.is_readonly ? " · read-only" : ""}{channel.slow_mode_seconds ? ` · slow ${channel.slow_mode_seconds}s` : ""}</p>
                  </div>
                  {manage && <>
                    <Button size="icon" variant="ghost" onClick={() => setEditing({ ...channel })}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => void deleteChannel(channel)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </>}
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
      {(view.categories || []).length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Categories</h4>
          {(view.categories || []).map((category) => (
            <div key={category.id} className="flex items-center gap-2 rounded-md border p-2">
              <span className="flex-1 truncate text-sm">{category.name}</span>
              {manage && <Button size="icon" variant="ghost" onClick={async () => { try { await rpc("delete_category", { _category_id: category.id }); onChanged(); } catch (error: any) { toast({ title: "Error", description: error.message, variant: "destructive" }); } }}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RolesTab({ view, can, onChanged }: { view: ServerView; can: (p: string) => boolean; onChanged: () => void }) {
  const serverId = view.server.id;
  const [name, setName] = useState("");
  const [color, setColor] = useState("#5865f2");
  const [permissions, setPermissions] = useState<Set<string>>(new Set(PERMISSIONS.slice(0, 6)));
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can("manage_roles");

  const togglePermission = (permission: string) => {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission); else next.add(permission);
      return next;
    });
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await rpc("create_role", { _server_id: serverId, _name: name.trim(), _color: color, _permissions: Object.fromEntries([...permissions].map((p) => [p, true])) });
      setName("");
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await rpc("update_role", { _role_id: editing.id, _name: editing.name, _color: editing.color || null, _permissions: editing.permissions || {} });
      setEditing(null);
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: any) => {
    try {
      await rpc("delete_role", { _role_id: role.id });
      onChanged();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {manage && (
        <div className="rounded-lg border p-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_120px_auto]">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Role name" />
            <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <Button onClick={() => void create()} disabled={busy || !name.trim()}>Add role</Button>
          </div>
          <div className="grid max-h-32 grid-cols-2 gap-2 overflow-y-auto md:grid-cols-3">
            {PERMISSIONS.map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-xs">
                <Checkbox checked={permissions.has(permission)} onCheckedChange={() => togglePermission(permission)} />
                {permission.replace(/_/g, " ")}
              </label>
            ))}
          </div>
        </div>
      )}
      <ScrollArea className="h-80">
        <div className="space-y-2 pr-3">
          {(view.roles || []).map((role) => (
            <div key={role.id} className="rounded-lg border p-3">
              {editing?.id === role.id ? (
                <div className="space-y-3">
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} disabled={role.is_default} />
                  <Input type="color" value={editing.color || "#5865f2"} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
                  <div className="grid max-h-32 grid-cols-2 gap-2 overflow-y-auto md:grid-cols-3">
                    {PERMISSIONS.map((permission) => {
                      const current = typeof editing.permissions === "string" ? JSON.parse(editing.permissions || "{}") : editing.permissions || {};
                      return <label key={permission} className="flex items-center gap-2 text-xs"><Checkbox checked={!!current[permission]} onCheckedChange={(checked) => setEditing({ ...editing, permissions: { ...current, [permission]: !!checked } })} />{permission.replace(/_/g, " ")}</label>;
                    })}
                  </div>
                  <div className="flex gap-2"><Button size="sm" onClick={() => void save()} disabled={busy}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="h-3 w-3 rounded-full" style={{ background: role.color || "#5865f2" }} />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{role.name}</p><p className="text-xs text-muted-foreground">Position {role.position}{role.is_default ? " · default" : ""}{role.administrator ? " · admin" : ""}</p></div>
                  {manage && <Button size="icon" variant="ghost" onClick={() => setEditing({ ...role, permissions: typeof role.permissions === "string" ? JSON.parse(role.permissions || "{}") : role.permissions || {} })}><Pencil className="h-4 w-4" /></Button>}
                  {manage && !role.is_default && <Button size="icon" variant="ghost" onClick={() => void remove(role)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function MembersTab({ view, can, onChanged }: { view: ServerView; can: (p: string) => boolean; onChanged: () => void }) {
  const serverId = view.server.id;
  const [query, setQuery] = useState("");
  const [bans, setBans] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const roles = (view.roles || []).filter((role) => !role.is_default);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (view.members || []).filter((member) => !q || [member.nickname, member.display_name, member.username].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [view.members, query]);

  const act = async (userId: string, fn: () => Promise<unknown>) => {
    setBusyId(userId);
    try { await fn(); onChanged(); } catch (error: any) { toast({ title: "Error", description: error.message, variant: "destructive" }); } finally { setBusyId(null); }
  };

  const loadBans = async () => {
    try {
      const data = await rpc<any[]>("list_bans", { _server_id: serverId });
      setBans(data || []);
    } catch {
      setBans([]);
    }
  };

  useEffect(() => {
    if (can("ban_members")) void loadBans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, view.members?.length]);

  const banMember = async (member: any) => {
    const reason = window.prompt(`Ban ${member.display_name || member.username}? Optional reason:`) ?? null;
    if (reason === null) return;
    await act(member.user_id, () => rpc("ban_member", { _server_id: serverId, _user_id: member.user_id, _reason: reason || null }));
    await loadBans();
  };

  const timeoutMember = async (member: any) => {
    const minutes = window.prompt(`Timeout ${member.display_name || member.username} for how many minutes? (0 clears)`);
    if (minutes === null) return;
    const value = Math.floor(Number(minutes) || 0);
    await act(member.user_id, () => rpc("timeout_member", { _server_id: serverId, _user_id: member.user_id, _minutes: value }));
  };

  const unbanMember = async (userId: string) => {
    await act(userId, () => rpc("unban_member", { _server_id: serverId, _user_id: userId }));
    await loadBans();
  };

  return (
    <div className="space-y-3">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search members" />
      <ScrollArea className="h-96">
        <div className="space-y-2 pr-3">
          {filtered.map((member) => {
            const isOwner = member.user_id === view.server.owner_id;
            const isSelf = member.user_id === view.membership?.user_id;
            return (
              <div key={member.user_id} className="flex items-center gap-3 rounded-lg border p-3">
                <Avatar className="h-10 w-10"><AvatarImage src={member.avatar_url || undefined} /><AvatarFallback>{(member.display_name || member.username || "?")[0]?.toUpperCase()}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{member.nickname || member.display_name || member.username}{isOwner && <Badge variant="secondary" className="ml-2">Owner</Badge>}</p>
                  <p className="truncate text-xs text-muted-foreground">@{member.username}</p>
                </div>
                {!isOwner && can("manage_roles") && (
                  <Select
                    value={member.role_id || "none"}
                    onValueChange={(value) => void act(member.user_id, () => rpc("set_server_member_role", { _server_id: serverId, _user_id: member.user_id, _role_id: value === "none" ? null : value }))}
                    disabled={busyId === member.user_id}
                  >
                    <SelectTrigger className="w-36"><SelectValue placeholder="Role" /></SelectTrigger>
                    <SelectContent><SelectItem value="none">@everyone</SelectItem>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                {(isSelf || (!isOwner && can("manage_nicknames"))) && (
                  <Button size="sm" variant="outline" disabled={busyId === member.user_id} onClick={() => {
                    const nickname = window.prompt("Nickname", member.nickname || "");
                    if (nickname !== null) void act(member.user_id, () => rpc("set_member_nickname", { _server_id: serverId, _user_id: member.user_id, _nickname: nickname || null }));
                  }}>Nick</Button>
                )}
                {!isOwner && !isSelf && can("kick_members") && (
                  <Button size="icon" variant="ghost" title="Timeout" disabled={busyId === member.user_id} onClick={() => void timeoutMember(member)}><Clock className="h-4 w-4" /></Button>
                )}
                {!isOwner && !isSelf && can("kick_members") && (
                  <Button size="icon" variant="ghost" title="Kick" disabled={busyId === member.user_id} onClick={() => void act(member.user_id, () => rpc("kick_member", { _server_id: serverId, _user_id: member.user_id }))}><UserMinus className="h-4 w-4 text-destructive" /></Button>
                )}
                {!isOwner && !isSelf && can("ban_members") && (
                  <Button size="sm" variant="destructive" disabled={busyId === member.user_id} onClick={() => void banMember(member)}>Ban</Button>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {can("ban_members") && bans.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Banned users</h4>
          {bans.map((ban) => (
            <div key={ban.id} className="flex items-center gap-3 rounded-lg border p-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{ban.display_name || ban.username}</p>
                <p className="truncate text-xs text-muted-foreground">@{ban.username}{ban.reason ? ` · ${ban.reason}` : ""}</p>
              </div>
              <Button size="sm" variant="outline" disabled={busyId === ban.user_id} onClick={() => void unbanMember(ban.user_id)}>Unban</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
