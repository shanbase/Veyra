// Same unambiguous alphabet the server generates codes from (no 0/O, 1/I/L).
const FRIEND_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/i;

// Extracts a friend code from a scanned QR payload. Accepts the canonical
// /add-friend?code=… link plus bare codes and veyra:// deep links.
export function extractFriendCode(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  try {
    const url = new URL(value, base);
    const code = url.searchParams.get("code") || url.searchParams.get("friend");
    if (code) return code.trim().toUpperCase();
    // veyra://user/<name>?friend=<code> style payloads land here too.
    const match = value.match(/[?&](?:code|friend)=([A-Za-z0-9]+)/);
    if (match) return match[1].toUpperCase();
  } catch {
    /* not a URL — fall through to bare-code check */
  }
  const bare = value.replace(/[\s-]/g, "").toUpperCase();
  return FRIEND_CODE_PATTERN.test(bare) ? bare : null;
}
