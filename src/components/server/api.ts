import { supabase } from "@/integrations/supabase/client";
import { apiFetch } from "@/lib/nativeSession";

export interface ServerSummary {
  id: string;
  name: string;
  icon_url: string | null;
  description: string | null;
  owner_id: string;
  verification_level: string;
  created_at: string;
  joined_at: string;
  nickname: string | null;
  role_id: string | null;
  is_owner: boolean;
  unread_count: number;
  mention_count: number;
}

export interface ServerView {
  server: any;
  membership: any;
  categories: any[];
  channels: any[];
  roles: any[];
  members: any[];
  my_permissions: string[];
  is_owner: boolean;
}

export async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || "Server action failed.");
  return data as T;
}

export async function uploadServerImage(serverId: string, image: "icon" | "banner", file: Blob) {
  const response = await apiFetch("/api/storage/server-image-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, image, contentType: file.type || "application/octet-stream", size: file.size }),
  });
  const signed = await response.json() as { path?: string; token?: string; publicUrl?: string; error?: string };
  if (!response.ok || !signed.path || !signed.token || !signed.publicUrl) {
    throw new Error(signed.error || "Could not prepare the server image upload.");
  }
  const { error } = await supabase.storage.from("avatars").uploadToSignedUrl(signed.path, signed.token, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: "31536000, immutable",
  });
  if (error) throw error;
  return `${signed.publicUrl}?t=${Date.now()}`;
}
