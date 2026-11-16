import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import type { ActionMenuMessage } from "./MessageActionMenu";

interface ReportMessageDialogProps {
  message: ActionMenuMessage | null;
  messageTable: string;
  onClose: () => void;
}

export function ReportMessageDialog({ message, messageTable, onClose }: ReportMessageDialogProps) {
  const { user } = useAuth();
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!user || !message || sending) return;
    setSending(true);
    const { error } = await supabase.from("message_reports").insert({
      id: crypto.randomUUID(),
      message_table: messageTable,
      message_id: message.id,
      reporter_id: user.id,
      reason: reason.trim() || null,
    });
    setSending(false);
    if (error) {
      toast({ title: "Report failed", description: "Could not submit the report.", variant: "destructive" });
      return;
    }
    toast({ title: "Report submitted", description: "Thanks — our moderators will review it." });
    setReason("");
    onClose();
  };

  return (
    <Dialog open={!!message} onOpenChange={(open) => { if (!open) { setReason(""); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report message</DialogTitle>
          <DialogDescription>
            Tell the moderators what is wrong with this message. Reports are reviewed by admins.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          maxLength={2000}
          rows={4}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => { setReason(""); onClose(); }}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={sending}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit report
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
