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

let registered = false;

// Registers for FCM push on native Android (and iOS if added later) and stores
// the device token in native_push_tokens so the API can fan out notifications.
// Safe to call repeatedly — it only registers listeners once.
export async function registerNativePush(userId: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || registered) return;
  registered = true;
  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return;

    await PushNotifications.addListener("registration", ({ value }) => {
      void saveToken(userId, value).catch((error) =>
        console.warn("Failed to store push token:", error),
      );
    });
    await PushNotifications.addListener("registrationError", (error) => {
      console.warn("Push registration failed:", error);
    });
    await PushNotifications.register();
  } catch (error) {
    console.warn("Push notifications unavailable:", error);
  }
}
