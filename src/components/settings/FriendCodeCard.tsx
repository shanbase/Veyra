import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2, QrCode, RefreshCw, ShieldOff } from "lucide-react";

interface FriendCodeRow {
  id: string;
  code: string;
  auto_accept: boolean;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

const ROTATE_COOLDOWN_MS = 60_000;

function friendCodeUrl(code: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/add-friend?code=${encodeURIComponent(code)}`;
}

export function FriendCodeCard() {
  const { user } = useAuth();
  const [row, setRow] = useState<FriendCodeRow | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"rotate" | "revoke" | "auto" | null>(null);
  const [rotateNextAt, setRotateNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!rotateNextAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rotateNextAt]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("get_my_friend_code");
    if (error) {
      // A revoked code surfaces as an error — show the regenerate state.
      if (/revoked/i.test(error.message || "")) {
        setRevoked(true);
        setRow(null);
      } else {
        toast.error(error.message || "Could not load your friend code");
      }
      setQrUrl(null);
    } else {
      const record = data as FriendCodeRow;
      setRow(record);
      setRevoked(false);
      setQrUrl(await QRCode.toDataURL(friendCodeUrl(record.code), { margin: 1, width: 320 }));
      const lastChange = new Date(record.rotated_at || record.created_at).getTime();
      const next = lastChange + ROTATE_COOLDOWN_MS;
      setRotateNextAt(next > Date.now() ? next : null);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const rotate = async () => {
    setBusy("rotate");
    const { data, error } = await supabase.rpc("rotate_friend_code");
    setBusy(null);
    if (error) { toast.error(error.message || "Could not generate a new code"); return; }
    const record = data as { code: string; rotated_at: string };
    setRow((prev) => prev ? { ...prev, code: record.code, rotated_at: record.rotated_at, revoked_at: null } : prev);
    setRevoked(false);
    setQrUrl(await QRCode.toDataURL(friendCodeUrl(record.code), { margin: 1, width: 320 }));
    setRotateNextAt(Date.now() + ROTATE_COOLDOWN_MS);
    toast.success("New friend code generated — the old QR no longer works");
  };

  const revoke = async () => {
    setBusy("revoke");
    const { data, error } = await supabase.rpc("revoke_friend_code");
    setBusy(null);
    if (error) { toast.error(error.message || "Could not revoke the code"); return; }
    if ((data as { revoked: boolean })?.revoked) {
      setRevoked(true);
      setQrUrl(null);
      toast.success("Friend code revoked");
    }
  };

  const toggleAutoAccept = async (enabled: boolean) => {
    setBusy("auto");
    const { data, error } = await supabase.rpc("set_friend_code_auto_accept", { _enabled: enabled });
    setBusy(null);
    if (error) { toast.error(error.message || "Could not update auto-accept"); return; }
    setRow((prev) => prev ? { ...prev, auto_accept: (data as { auto_accept: boolean }).auto_accept } : prev);
    toast.success(enabled ? "People who scan your code are added automatically" : "Scanned codes now send a friend request");
  };

  const cooldownLeft = rotateNextAt ? Math.max(0, rotateNextAt - now) : 0;
  const cooldownLabel = cooldownLeft > 0
    ? `${Math.ceil(cooldownLeft / 1000)}s`
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><QrCode className="h-5 w-5" />Friend QR code</CardTitle>
        <CardDescription>
          Anyone who scans this code can add you as a friend. Treat it like a password — regenerate it if it leaks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : revoked || !row ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Your friend code is revoked. Generate a new one to share a fresh QR code.</p>
            <Button onClick={rotate} disabled={busy !== null || cooldownLeft > 0}>
              {busy === "rotate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Generate friend code
              {cooldownLabel ? ` (${cooldownLabel})` : ""}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              {qrUrl && (
                <img src={qrUrl} alt="Your friend QR code" className="h-40 w-40 rounded-lg border border-border bg-white p-2" />
              )}
              <div className="flex-1 space-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Your code</p>
                  <p className="font-mono text-lg tracking-widest">{row.code}</p>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Auto-accept scans</p>
                    <p className="text-xs text-muted-foreground">Skip the friend request and add scanners instantly.</p>
                  </div>
                  <Switch
                    checked={row.auto_accept}
                    onCheckedChange={toggleAutoAccept}
                    disabled={busy !== null}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={rotate} disabled={busy !== null || cooldownLeft > 0}>
                    {busy === "rotate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Regenerate{cooldownLabel ? ` (${cooldownLabel})` : ""}
                  </Button>
                  <Button variant="outline" size="sm" onClick={revoke} disabled={busy !== null} className="text-destructive">
                    {busy === "revoke" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
                    Revoke
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
