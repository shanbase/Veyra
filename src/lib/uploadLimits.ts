// Profile images (avatars/banners) stay capped at 25 MB — that is the
// Supabase bucket limit for those buckets and the /api/storage/profile-upload
// endpoint enforces the same value server-side.
export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_LABEL = "25 MB";

export function exceedsMaxUploadSize(file: Pick<File, "size"> | Blob): boolean {
  return file.size > MAX_UPLOAD_SIZE_BYTES;
}

// Chat media buckets have their own Supabase limits, mirrored by
// CHAT_UPLOAD_LIMITS in server/app.mjs — keep both sides in sync.
export type ChatUploadBucket = "chat-images" | "chat-videos" | "chat-voice";

export const CHAT_UPLOAD_LIMITS: Record<ChatUploadBucket, number> = {
  "chat-images": 50 * 1024 * 1024,
  "chat-videos": 50 * 1024 * 1024,
  "chat-voice": 45 * 1024 * 1024,
};

export function chatUploadLimitLabel(bucket: ChatUploadBucket): string {
  return `${Math.round(CHAT_UPLOAD_LIMITS[bucket] / (1024 * 1024))} MB`;
}

export function exceedsChatUploadSize(
  file: Pick<File, "size"> | Blob,
  bucket: ChatUploadBucket,
): boolean {
  return file.size > CHAT_UPLOAD_LIMITS[bucket];
}
