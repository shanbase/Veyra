import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { supabase } from "@/integrations/supabase/client";

const DEVICE_KEY = "veyra-push-device-id";

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// The user the push listeners are currently bound to. FCM delivers to the
// token, not the account, so the API reassigns a token to the newest account
// that registers it (see native_push_tokens handling in server/data.mjs).
let boundUserId: string | null = null;
let listenersRegistered = false;

async function saveToken(userId: string, token: string) {
  const platform = Capacitor.getPlatform();
  const { data: existing } = await supabase
    .from("native_push_tokens")
    .select("id")
    .eq("user_id", userId)
    .eq("token", token)
    .maybeSingle();
  if (existing?.id) {
    await supabase
      .from("native_push_tokens")
      .update({ enabled: true, last_seen_at: new Date().toISOString(), device_id: deviceId() })
      .eq("id", existing.id);
  } else {
    await supabase.from("native_push_tokens").insert({
      user_id: userId,
      token,
      platform,
      device_id: deviceId(),
      enabled: true,
    });
  }
}

// Registers for FCM push on native Android (and iOS if added later) and stores
// the device token in native_push_tokens so the API can fan out notifications.
// Safe to call repeatedly — listeners are attached once and always resolve the
// CURRENT user, so signing in as a different account rebinds delivery.
export type CallInvitePush = {
  callId: string;
  conversationId: string;
  title: string;
  fromName: string;
};

// FCM call invites can arrive before CallProvider mounts (cold start from a
// notification tap) — buffer the newest one for it to consume.
let pendingCallInvite: CallInvitePush | null = null;

export function consumePendingCallInvite(): CallInvitePush | null {
  const invite = pendingCallInvite;
  pendingCallInvite = null;
  return invite;
}

function handleCallInviteData(data: Record<string, string> | undefined) {
  if (data?.type !== "call.invite" || !data.call_id || !data.conversation_id) return;
  const invite: CallInvitePush = {
    callId: data.call_id,
    conversationId: data.conversation_id,
    title: data.title || "Voice call",
    fromName: data.from_name || "Someone",
  };
  pendingCallInvite = invite;
  window.dispatchEvent(new CustomEvent("veyra:call-invite", { detail: invite }));
}

export async function registerNativePush(userId: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || !userId) return;

  boundUserId = userId;

  if (listenersRegistered) {
    // Re-register so FCM re-emits the token and it is stored under the new
    // account (the 'registration' listener resolves boundUserId at call time).
    try { await PushNotifications.register(); } catch { /* already registered */ }
    return;
  }
  listenersRegistered = true;

  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return;

    await PushNotifications.addListener("registration", ({ value }) => {
      const target = boundUserId;
      if (!target) return;
      void saveToken(target, value).catch((error) =>
        console.warn("Failed to store push token:", error),
      );
    });
    await PushNotifications.addListener("registrationError", (error) => {
      console.warn("Push registration failed:", error);
    });
    // Call invites: tap-to-answer payloads (cold start) and foreground pushes.
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      handleCallInviteData(action.notification?.data as Record<string, string> | undefined);
    });
    await PushNotifications.addListener("pushNotificationReceived", (notification) => {
      handleCallInviteData(notification.data as Record<string, string> | undefined);
    });
    await PushNotifications.register();
  } catch (error) {
    console.warn("Push notifications unavailable:", error);
  }
}
