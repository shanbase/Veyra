import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Camera, Loader2, QrCode, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { extractFriendCode } from "@/lib/friendCode";

interface RedeemResult {
  friend_request_id: string | null;
  status: string;
  other_user_id: string;
  already: boolean;
}

type Stage = "idle" | "working" | "done" | "error";

export function FriendCodeScanner({ onCode, onCancel }: { onCode: (code: string) => void; onCancel?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const Detector = (window as any).BarcodeDetector;
    if (!Detector) {
      setSupported(false);
      setError("Camera scanning is not supported in this browser — enter the code manually instead.");
      return;
    }

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
        const detector = new Detector({ formats: ["qr_code"] });
        timer = setInterval(async () => {
          const video = videoRef.current;
          if (!video || video.readyState < 2) return;
          try {
            const codes = await detector.detect(video);
            const raw = codes?.[0]?.rawValue;
            if (raw) {
              const code = extractFriendCode(raw);
              if (code) onCodeRef.current(code);
            }
          } catch {
            /* detection frame failed — keep scanning */
          }
        }, 400);
      } catch {
        if (!cancelled) setError("Camera access was denied — enter the code manually instead.");
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="space-y-3">
      {supported ? (
        <div className="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        </div>
      ) : null}
      {error && <p className="text-center text-sm text-muted-foreground">{error}</p>}
      {onCancel && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={onCancel}>Enter code manually</Button>
        </div>
      )}
    </div>
  );
}

export default function AddFriend() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [scanning, setScanning] = useState(false);
  const [messagePending, setMessagePending] = useState(false);
  const attemptedRef = useRef<string | null>(null);

  const redeem = useCallback(async (rawCode: string) => {
    const normalized = extractFriendCode(rawCode) || rawCode.trim().toUpperCase();
    if (!normalized) {
      setErrorMessage("Enter a valid friend code.");
      setStage("error");
      return;
    }
    setStage("working");
    setErrorMessage("");
    const { data, error } = await supabase.rpc("redeem_friend_code", { _code: normalized });
    if (error) {
      setStage("error");
      setErrorMessage(error.message || "Could not redeem that code.");
      return;
    }
    const record = data as RedeemResult;
    setResult(record);
    setStage("done");
    if (record.status === "accepted") {
      toast.success(record.already ? "You are already friends" : "Friend added — QR auto-accept was on");
    } else {
      toast.success(record.already ? "Friend request already pending" : "Friend request sent");
    }
  }, []);

  // Auto-redeem when arriving via a QR link (?code=… or ?friend=…).
  useEffect(() => {
    if (authLoading || !user) return;
    const fromUrl = params.get("code") || params.get("friend");
    if (!fromUrl || attemptedRef.current === fromUrl) return;
    attemptedRef.current = fromUrl;
    setCode(fromUrl);
    void redeem(fromUrl);
  }, [authLoading, user, params, redeem]);

  const openDm = async () => {
    if (!user || !result) return;
    setMessagePending(true);
    try {
      const { data: list, error: listErr } = await supabase.rpc("get_user_dm_list");
      if (listErr) throw listErr;
      const existing = (list || []).find((row: any) => row.other_user_id === result.other_user_id);
      let convId: string | null = existing?.conversation_id ?? null;
      if (!convId) {
        const { data: newConvId, error: rpcErr } = await supabase.rpc("get_or_create_dm", { _other_user_id: result.other_user_id });
        if (rpcErr) throw rpcErr;
        convId = newConvId as unknown as string;
      }
      navigate(`/chat?c=${convId}`);
    } catch (error: any) {
      toast.error(error?.message || "Could not open conversation");
      setMessagePending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-md p-4 sm:p-6">
        <Button variant="ghost" onClick={() => navigate("/")} className="mb-4 gap-2">
          <ArrowLeft className="h-4 w-4" /> Back to Chat
        </Button>
        <h1 className="mb-6 text-2xl font-bold">Add friend</h1>

        {authLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !user ? (
          <Card>
            <CardHeader>
              <CardTitle>Sign in required</CardTitle>
              <CardDescription>You need an account to add friends.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => navigate("/auth")}>Sign in</Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><QrCode className="h-5 w-5" />Friend code</CardTitle>
              <CardDescription>Enter a code from someone's QR card, or scan it with your camera.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {stage === "done" && result ? (
                <div className="space-y-3 text-center">
                  <p className="text-sm">
                    {result.status === "accepted"
                      ? "You are now friends."
                      : "Friend request sent — they'll need to accept it."}
                  </p>
                  <div className="flex justify-center gap-2">
                    {result.status === "accepted" && (
                      <Button onClick={openDm} disabled={messagePending}>
                        {messagePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                        Message
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => { setStage("idle"); setResult(null); setCode(""); attemptedRef.current = null; }}>
                      Add another
                    </Button>
                  </div>
                </div>
              ) : scanning ? (
                <FriendCodeScanner
                  onCode={(scanned) => { setScanning(false); void redeem(scanned); }}
                  onCancel={() => setScanning(false)}
                />
              ) : (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                      placeholder="Friend code (e.g. K7M2P9QX4T)"
                      className="font-mono tracking-widest"
                      maxLength={12}
                      onKeyDown={(e) => { if (e.key === "Enter" && stage !== "working") void redeem(code); }}
                    />
                    <Button onClick={() => void redeem(code)} disabled={stage === "working" || !code.trim()}>
                      {stage === "working" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                    </Button>
                  </div>
                  {stage === "error" && errorMessage && (
                    <p className="text-sm text-destructive">{errorMessage}</p>
                  )}
                  <Button variant="outline" className="w-full gap-2" onClick={() => setScanning(true)}>
                    <Camera className="h-4 w-4" /> Scan QR code instead
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Know their username? <Link to="/" className="text-primary hover:underline">Find them in chat</Link>.
        </p>
      </div>
    </div>
  );
}
