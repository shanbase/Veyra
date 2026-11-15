import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Home, Link2, Loader2, Plus, Server as ServerIcon, Settings } from "lucide-react";
import { rpc, type ServerSummary } from "./api";

interface ServerRailProps {
  servers: ServerSummary[];
  selectedServerId: string | null;
  onSelectServer: (serverId: string | null) => void;
  onChanged: () => void;
  mobile?: boolean;
}

const TEMPLATES = [
  { id: "community", label: "Community" },
  { id: "gaming", label: "Gaming" },
  { id: "study", label: "Study" },
  { id: "blank", label: "Blank" },
];

export function ServerRail({ servers, selectedServerId, onSelectServer, onChanged, mobile = false }: ServerRailProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  return (
    <>
      <nav
        className={mobile
          ? "flex h-16 flex-shrink-0 items-center gap-2 overflow-x-auto border-b bg-sidebar px-2"
          : "flex w-[72px] flex-shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-sidebar py-3"}
        aria-label="Servers"
      >
        <button
          type="button"
          onClick={() => onSelectServer(null)}
          className={`group relative flex items-center justify-center rounded-2xl transition-all ${
            mobile ? "h-11 w-11" : "h-12 w-12"
          } ${selectedServerId === null ? "bg-primary text-primary-foreground" : "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-primary hover:text-primary-foreground"}`}
          title="Direct messages"
        >
          <Home className="h-6 w-6" />
        </button>
        <div className={mobile ? "h-8 w-px bg-border" : "h-0.5 w-8 bg-border"} />
        {servers.map((server) => {
          const mentions = Number(server.mention_count || 0);
          const unread = Number(server.unread_count || 0);
          return (
            <button
              key={server.id}
              type="button"
              onClick={() => onSelectServer(server.id)}
              className={`group relative flex items-center justify-center rounded-2xl transition-all ${
                mobile ? "h-11 w-11" : "h-12 w-12"
              } ${selectedServerId === server.id ? "bg-primary text-primary-foreground" : "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-primary hover:text-primary-foreground"}`}
              title={server.name}
            >
              {server.icon_url ? (
                <img src={server.icon_url} alt="" className="h-full w-full rounded-2xl object-cover" />
              ) : (
                <span className="text-sm font-bold">{server.name.slice(0, 1).toUpperCase()}</span>
              )}
              {mentions > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                  {mentions > 99 ? "99+" : mentions}
                </span>
              )}
              {mentions === 0 && unread > 0 && selectedServerId !== server.id && (
                <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-white" />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className={`flex items-center justify-center rounded-2xl bg-sidebar-accent text-sidebar-accent-foreground transition-all hover:bg-primary hover:text-primary-foreground ${mobile ? "h-11 w-11" : "h-12 w-12"}`}
          title="Create server"
        >
          <Plus className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={() => setJoinOpen(true)}
          className={`flex items-center justify-center rounded-2xl bg-sidebar-accent text-sidebar-accent-foreground transition-all hover:bg-primary hover:text-primary-foreground ${mobile ? "h-11 w-11" : "h-12 w-12"}`}
          title="Join server"
        >
          <Link2 className="h-6 w-6" />
        </button>
        {!mobile && user && (
          <div className="mt-auto flex flex-col items-center gap-2">
            <button type="button" onClick={() => navigate("/settings")} className="rounded-full" title="Settings">
              <Avatar className="h-9 w-9"><AvatarImage src={(user as any).avatar_url || undefined} /><AvatarFallback>{(user as any).username?.[0]?.toUpperCase() || "?"}</AvatarFallback></Avatar>
            </button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/settings")} title="Settings">
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        )}
      </nav>
      <CreateServerDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => { setCreateOpen(false); onChanged(); onSelectServer(id); }} />
      <JoinServerDialog open={joinOpen} onOpenChange={setJoinOpen} onJoined={(id) => { setJoinOpen(false); onChanged(); onSelectServer(id); }} />
    </>
  );
}

function CreateServerDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (serverId: string) => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("community");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const result = await rpc<{ server_id: string }>("create_server", { _name: name.trim(), _template: template });
      toast({ title: "Server created" });
      onCreated(result.server_id);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create your server</DialogTitle><DialogDescription>Servers are private communities with channels, roles, and invites.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Server name</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="My community" /></div>
          <div className="space-y-2"><Label>Template</Label><Select value={template} onValueChange={setTemplate}>{TEMPLATES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</Select></div>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => void submit()} disabled={busy || !name.trim()}>{busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Create</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JoinServerDialog({ open, onOpenChange, onJoined }: { open: boolean; onOpenChange: (open: boolean) => void; onJoined: (serverId: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      const result = await rpc<{ server_id: string }>("join_server_by_code", { _code: code.trim() });
      toast({ title: result.status === "already_member" ? "Already a member" : "Joined server" });
      onJoined(result.server_id);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Join a server</DialogTitle><DialogDescription>Paste an invite code from a server member.</DialogDescription></DialogHeader>
        <div className="space-y-2"><Label>Invite code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="abc123" /></div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => void submit()} disabled={busy || !code.trim()}>{busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Join</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
