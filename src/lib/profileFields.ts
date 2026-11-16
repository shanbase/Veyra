import type { Json } from "@/integrations/supabase/types";

// Client-side mirrors of the server-side validation in server/data.mjs
// (sanitizeProfileFields). The API remains the trust boundary — these helpers
// only shape what the editors send and how stored JSON is read back. MariaDB
// JSON columns can arrive as either parsed objects or raw strings depending on
// the driver, so every reader goes through parseJsonValue.

export type StatusMode = "online" | "idle" | "do_not_disturb";

export const STATUS_MODES: { value: StatusMode; label: string; description: string }[] = [
  { value: "online", label: "Online", description: "Appear available and notify normally." },
  { value: "idle", label: "Idle", description: "Appear away while still receiving notifications." },
  { value: "do_not_disturb", label: "Do not disturb", description: "Stay online but silence message notifications (mentions still get through)." },
];

export function parseJsonValue(value: Json | string | null | undefined): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

export function parseStringArray(value: Json | string | null | undefined): string[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export interface ProfileLanguage {
  code: string;
  label: string;
}

export function parseLanguages(value: Json | string | null | undefined): ProfileLanguage[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => {
      if (typeof entry === "string") return { code: "", label: entry };
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return { code: String(record.code ?? ""), label: String(record.label ?? "") };
      }
      return null;
    })
    .filter((entry): entry is ProfileLanguage => !!entry?.label);
}

export interface ProfileSong {
  title: string;
  artist: string;
  url: string;
  artwork_url?: string;
}

export function parseProfileSong(value: Json | string | null | undefined): ProfileSong | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const title = String(record.title ?? "").trim();
  const url = String(record.url ?? "").trim();
  if (!title || !/^https:\/\//i.test(url)) return null;
  const song: ProfileSong = {
    title,
    artist: String(record.artist ?? "").trim(),
    url,
  };
  const artwork = String(record.artwork_url ?? "").trim();
  if (artwork && /^https:\/\//i.test(artwork)) song.artwork_url = artwork;
  return song;
}

export type ProfileLayoutSection =
  | "bio"
  | "banner"
  | "links"
  | "interests"
  | "languages"
  | "song"
  | "custom_status"
  | "badges";

export const PROFILE_LAYOUT_SECTIONS: { key: ProfileLayoutSection; label: string }[] = [
  { key: "bio", label: "Bio" },
  { key: "links", label: "Links" },
  { key: "interests", label: "Interests" },
  { key: "languages", label: "Languages" },
  { key: "song", label: "Profile song" },
  { key: "custom_status", label: "Custom status" },
  { key: "badges", label: "Badges" },
];

// Sections the profile dialog renders in the user's chosen order. 'banner' is
// fixed at the top and 'custom_status'/'badges' have dedicated placement, so
// they are excluded from reordering.
export const ORDERED_LAYOUT_SECTIONS: ProfileLayoutSection[] = ["bio", "links", "interests", "languages", "song"];

export const DEFAULT_PROFILE_LAYOUT: ProfileLayoutSection[] = [...ORDERED_LAYOUT_SECTIONS];

export function parseProfileLayout(value: Json | string | null | undefined): ProfileLayoutSection[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return DEFAULT_PROFILE_LAYOUT;
  const known = new Set<ProfileLayoutSection>(ORDERED_LAYOUT_SECTIONS);
  const sections = parsed
    .map((entry) => String(entry))
    .filter((entry): entry is ProfileLayoutSection => known.has(entry as ProfileLayoutSection));
  // Fill in any sections the user has not ordered yet, preserving defaults.
  for (const section of ORDERED_LAYOUT_SECTIONS) {
    if (!sections.includes(section)) sections.push(section);
  }
  return sections;
}
