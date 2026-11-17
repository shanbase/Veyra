// GIF favorites for the picker. localStorage is the instant-read cache; the
// server (gif_favorites table, AES-256-GCM encrypted payload) is the source of
// truth so favorites follow the account across devices. hydrateGifFavorites()
// merges the two once per session — local-only entries are pushed up, server
// entries fill the cache.
import { apiFetch } from "@/lib/nativeSession";
import type { GifItem } from "./giphy";

const STORAGE_KEY = "veyra:gif-favorites:v1";
const MAX_FAVORITES = 100;
const listeners = new Set<() => void>();
let hydratePromise: Promise<void> | null = null;

function read(): GifItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isGifItem) : [];
  } catch {
    return [];
  }
}

function isGifItem(value: unknown): value is GifItem {
  const item = value as GifItem | null;
  return Boolean(item && typeof item.id === "string" && item.id && typeof item.sendUrl === "string" && item.sendUrl);
}

function write(items: GifItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_FAVORITES)));
  } catch {
    // Storage full or unavailable — favorites just won't persist locally.
  }
  listeners.forEach((listener) => listener());
}

export function getFavoriteGifs(): GifItem[] {
  return read();
}

export function isFavoriteGif(id: string): boolean {
  return read().some((item) => item.id === id);
}

function persistRemote(gif: GifItem, favorite: boolean) {
  const request = favorite
    ? apiFetch("/api/gif-favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gif }),
      })
    : apiFetch(`/api/gif-favorites/${encodeURIComponent(gif.id)}`, { method: "DELETE" });
  void request.catch(() => hydrateGifFavorites()); // resync on failure
}

export function toggleFavoriteGif(gif: GifItem): boolean {
  const items = read();
  const index = items.findIndex((item) => item.id === gif.id);
  if (index >= 0) {
    items.splice(index, 1);
    write(items);
    persistRemote(gif, false);
    return false;
  }
  write([gif, ...items]);
  persistRemote(gif, true);
  return true;
}

/** Pulls server favorites into the cache and uploads any local-only ones. */
export function hydrateGifFavorites(): Promise<void> {
  hydratePromise ??= (async () => {
    try {
      const response = await apiFetch("/api/gif-favorites");
      if (!response.ok) return;
      const body = (await response.json()) as { favorites?: GifItem[] };
      const remote = (body.favorites || []).filter(isGifItem);
      const remoteIds = new Set(remote.map((gif) => gif.id));
      const localOnly = read().filter((gif) => !remoteIds.has(gif.id));
      // Push local-only favorites up (covers favorites made before sync
      // existed or while offline). Sequential is fine — at most ~100 small POSTs.
      for (const gif of localOnly.slice(0, MAX_FAVORITES)) {
        try {
          await apiFetch("/api/gif-favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gif }),
          });
        } catch { /* keep going — next hydrate retries */ }
      }
      const merged = [...remote, ...localOnly].slice(0, MAX_FAVORITES);
      // Only rewrite + notify when the merged set actually differs.
      const current = read();
      const same =
        current.length === merged.length &&
        current.every((gif, i) => gif.id === merged[i]?.id);
      if (!same) write(merged);
    } catch {
      // Offline or endpoint missing — local cache stays authoritative.
    }
  })();
  return hydratePromise;
}

export function subscribeGifFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
