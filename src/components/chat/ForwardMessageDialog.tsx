import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Loader2, Users, User } from "lucide-react";
import type { ActionMenuMessage } from "./MessageActionMenu";

interface ForwardTarget {
  id: string;
  label: string;
  avatarUrl?: string | null;
  isGroup: boolean;
}

interface ForwardMessageDialogProps {
  message: (ActionMenuMessage & { image_url?: string | null }) | null;
  excludeConversationId?: string | null;
  onClose: () => void;
}

export function ForwardMessageDialog({
  message,
  excludeConversationId,
  onClose,
}: ForwardMessageDialogProps) {
  const { user } = useAuth();
  const [targets, setTargets] = useState<ForwardTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  useEffect(() => {
    if (!message) return;
    let cancelled = false;
    setLoading(true);
    setTargets([]);
    void (async () => {
      try {
        const [dms, groups] = await Promise.all([
          supabase.rpc("get_user_dm_list"),
          supabase.rpc("get_user_group_list"),
        ]);
        if (cancelled) return;
        const dmTargets: ForwardTarget[] = (dms.data || [])
          .filter((row: any) => row.conversation_id !== excludeConversationId)
          .map((row: any) => ({
            id: row.conversation_id,
            label: row.other_display_name || row.other_username || "Chat",
            avatarUrl: row.other_avatar_url ?? null,
            isGroup: false,
          }));
        const groupTargets: ForwardTarget[] = (groups.data || [])
          .filter((row: any) => row.conversation_id !== excludeConversationId)
          .map((row: any) => ({
            id: row.conversation_id,
            label: row.name || "Group chat",
            avatarUrl: null,
            isGroup: true,
          }));
        setTargets([...dmTargets, ...groupTargets]);
      } catch (error) {
        console.error("Error loading forward targets:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [message, excludeConversationId]);

  const forward = async (target: ForwardTarget) => {
    if (!user || !message || sendingId) return;
    setSendingId(target.id);
    const { error } = await supabase.from("messages").insert({
      id: crypto.randomUUID(),
      sender_id: user.id,
      conversation_id: target.id,
      content: message.content ?? "",
      image_url: message.image_url ?? null,
      reply_to_id: null,
    });
    setSendingId(null);
    if (error) {
      toast({ title: "Forward failed", description: "Could not send the message.", variant: "destructive" });
      return;
    }
    toast({ title: "Message forwarded", description: `Sent to ${target.label}.` });
    onClose();
  };

  return (
    <Dialog open={!!message} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>Choose a chat to send this message to.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto -mx-2 px-2">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {!loading && targets.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No chats available.</p>
          )}
          {!loading && targets.map((target) => (
            <button
              key={target.id}
              type="button"
              disabled={sendingId !== null}
              onClick={() => void forward(target)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Avatar className="h-9 w-9">
                <AvatarImage src={target.avatarUrl || undefined} />
                <AvatarFallback>
                  {target.isGroup
                    ? <Users className="h-4 w-4" />
                    : <User className="h-4 w-4" />}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{target.label}</span>
              {sendingId === target.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
