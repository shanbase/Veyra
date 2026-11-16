import { useCallback, useEffect, useState } from "react";
import { PROFILE_SONG_AUTOPLAY_KEY, profileSongAutoplayEnabled } from "@/lib/profileFields";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Link2, ListMusic, Loader2, Music, Plus, Tags, Trash2, Users, X } from "lucide-react";
import {
  PROFILE_LAYOUT_SECTIONS,
  STATUS_MODES,
  parseLanguages,
  parseProfileLayout,
  parseProfileSong,
  parseStringArray,
  type ProfileLayoutSection,
  type ProfileSong,
  type StatusMode,
} from "@/lib/profileFields";

const MAX_INTERESTS = 10;
const MAX_INTEREST_LENGTH = 32;
const MAX_LANGUAGES = 10;
const MAX_LINKS = 10;

interface ProfileLinkRow {
  id: string;
  label: string;
  url: string;
  position: number;
}

interface LinkDraft {
  label: string;
  url: string;
}

interface LanguageDraft {
  code: string;
  label: string;
}

interface SongResult {
  trackId: number;
  trackName: string;
  artistName: string;
  previewUrl?: string;
  artworkUrl100?: string;
}

export function ProfileDetailsEditor() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);

  const [statusMode, setStatusMode] = useState<StatusMode>("online");
  const [savedStatusMode, setSavedStatusMode] = useState<StatusMode>("online");
  const [savingStatus, setSavingStatus] = useState(false);

  const [interests, setInterests] = useState<string[]>([]);
  const [interestInput, setInterestInput] = useState("");
  const [savedInterests, setSavedInterests] = useState<string[]>([]);
  const [savingInterests, setSavingInterests] = useState(false);

  const [languages, setLanguages] = useState<LanguageDraft[]>([]);
  const [savedLanguages, setSavedLanguages] = useState<LanguageDraft[]>([]);
  const [savingLanguages, setSavingLanguages] = useState(false);

  const [links, setLinks] = useState<ProfileLinkRow[]>([]);
  const [linkDraft, setLinkDraft] = useState<LinkDraft>({ label: "", url: "" });
  const [savingLink, setSavingLink] = useState(false);

  const [song, setSong] = useState<ProfileSong | null>(null);
  const [songDraft, setSongDraft] = useState({ title: "", artist: "", url: "", artwork_url: "" });
  const [savingSong, setSavingSong] = useState(false);
  const [songQuery, setSongQuery] = useState("");
  const [songResults, setSongResults] = useState<SongResult[] | null>(null);
  const [songSearching, setSongSearching] = useState(false);
  const [autoplaySongs, setAutoplaySongs] = useState(() => profileSongAutoplayEnabled());

  const [layout, setLayout] = useState<ProfileLayoutSection[]>([]);
  const [savedLayout, setSavedLayout] = useState<ProfileLayoutSection[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: profile }, { data: linkRows }] = await Promise.all([
      supabase
        .from("profiles")
        .select("status_mode, interests, languages_spoken, profile_song, profile_layout")
        .eq("id", user.id)
        .maybeSingle(),
      supabase.from("profile_links").select("id, label, url, position").eq("user_id", user.id).order("position", { ascending: true }),
    ]);
    if (profile) {
      const mode = (profile.status_mode as StatusMode) || "online";
      setStatusMode(mode);
      setSavedStatusMode(mode);
      const tags = parseStringArray(profile.interests);
      setInterests(tags);
      setSavedInterests(tags);
      const langs = parseLanguages(profile.languages_spoken).map((entry) => ({ code: entry.code, label: entry.label }));
      setLanguages(langs);
      setSavedLanguages(langs);
      const storedSong = parseProfileSong(profile.profile_song);
      setSong(storedSong);
      setSongDraft(storedSong
        ? { title: storedSong.title, artist: storedSong.artist, url: storedSong.url, artwork_url: storedSong.artwork_url ?? "" }
        : { title: "", artist: "", url: "", artwork_url: "" });
      const order = parseProfileLayout(profile.profile_layout);
      setLayout(order);
      setSavedLayout(order);
    }
    setLinks((linkRows as ProfileLinkRow[]) || []);
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const updateProfile = async (values: Record<string, any>, successMessage: string) => {
    if (!user) return false;
    const { error } = await supabase.from("profiles").update(values as any).eq("id", user.id);
    if (error) {
      toast.error(error.message || "Could not save profile");
      return false;
    }
    toast.success(successMessage);
    return true;
  };

  const saveStatusMode = async () => {
    setSavingStatus(true);
    if (await updateProfile({ status_mode: statusMode }, "Status mode updated")) setSavedStatusMode(statusMode);
    setSavingStatus(false);
  };

  const addInterest = () => {
    const tag = interestInput.trim().toLowerCase();
    if (!tag) return;
    if (tag.length > MAX_INTEREST_LENGTH) {
      toast.error(`Interests must be ${MAX_INTEREST_LENGTH} characters or fewer.`);
      return;
    }
    if (interests.includes(tag)) { setInterestInput(""); return; }
    if (interests.length >= MAX_INTERESTS) {
      toast.error(`You can add up to ${MAX_INTERESTS} interests.`);
      return;
    }
    setInterests((prev) => [...prev, tag]);
    setInterestInput("");
  };

  const saveInterests = async () => {
    setSavingInterests(true);
    if (await updateProfile({ interests }, "Interests updated")) setSavedInterests(interests);
    setSavingInterests(false);
  };

  const saveLanguages = async () => {
    const cleaned = languages
      .map((entry) => ({ code: entry.code.trim().toLowerCase(), label: entry.label.trim() }))
      .filter((entry) => entry.label);
    if (cleaned.length > MAX_LANGUAGES) {
      toast.error(`You can add up to ${MAX_LANGUAGES} languages.`);
      return;
    }
    setSavingLanguages(true);
    if (await updateProfile({ languages_spoken: cleaned }, "Languages updated")) setSavedLanguages(cleaned);
    setSavingLanguages(false);
  };

  const addLink = async () => {
    if (!user) return;
    const label = linkDraft.label.trim();
    const url = linkDraft.url.trim();
    if (!label || label.length > 80) { toast.error("Link label is required (80 characters max)."); return; }
    if (!/^https?:\/\//i.test(url) || url.length > 2048) { toast.error("Link must be a valid http(s) URL."); return; }
    if (links.length >= MAX_LINKS) { toast.error(`You can add up to ${MAX_LINKS} links.`); return; }
    setSavingLink(true);
    const { data, error } = await supabase
      .from("profile_links")
      .insert({ user_id: user.id, label, url, position: links.length } as any)
      .select("id, label, url, position")
      .single();
    setSavingLink(false);
    if (error) { toast.error(error.message || "Could not add link"); return; }
    setLinks((prev) => [...prev, data as ProfileLinkRow]);
    setLinkDraft({ label: "", url: "" });
    toast.success("Link added");
  };

  const removeLink = async (id: string) => {
    const { error } = await supabase.from("profile_links").delete().eq("id", id);
    if (error) { toast.error(error.message || "Could not remove link"); return; }
    setLinks((prev) => prev.filter((link) => link.id !== id));
  };

  const saveSong = async () => {
    const title = songDraft.title.trim();
    const artist = songDraft.artist.trim();
    const url = songDraft.url.trim();
    const artwork = songDraft.artwork_url.trim();
    if (!title || !url) { toast.error("Song title and URL are required."); return; }
    if (!/^https:\/\//i.test(url)) { toast.error("Song URL must be https."); return; }
    if (artwork && !/^https:\/\//i.test(artwork)) { toast.error("Artwork URL must be https."); return; }
    const value: ProfileSong = { title, artist, url, ...(artwork ? { artwork_url: artwork } : {}) };
    setSavingSong(true);
    if (await updateProfile({ profile_song: value }, "Profile song saved")) setSong(value);
    setSavingSong(false);
  };

  // Free catalog search via the iTunes Search API — no key required. Returns
  // ~30s preview MP3s plus artwork, which is what profile_song stores.
  const searchSongs = async () => {
    const term = songQuery.trim();
    if (!term) return;
    setSongSearching(true);
    try {
      const response = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=10`,
      );
      const data = await response.json();
      setSongResults(((data?.results || []) as SongResult[]).filter((entry) => entry.previewUrl));
    } catch {
      toast.error("Song search failed — check your connection.");
      setSongResults([]);
    }
    setSongSearching(false);
  };

  const pickSong = (result: SongResult) => {
    setSongDraft({
      title: result.trackName.slice(0, 200),
      artist: result.artistName.slice(0, 200),
      url: result.previewUrl!,
      artwork_url: result.artworkUrl100?.replace("100x100bb", "600x600bb") ?? "",
    });
    setSongResults(null);
    setSongQuery("");
  };

  const clearSong = async () => {
    setSavingSong(true);
    if (await updateProfile({ profile_song: null }, "Profile song removed")) {
      setSong(null);
      setSongDraft({ title: "", artist: "", url: "", artwork_url: "" });
    }
    setSavingSong(false);
  };

  const moveSection = (index: number, direction: -1 | 1) => {
    setLayout((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveLayout = async () => {
    setSavingLayout(true);
    if (await updateProfile({ profile_layout: layout }, "Profile layout saved")) setSavedLayout(layout);
    setSavingLayout(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const interestsDirty = JSON.stringify(interests) !== JSON.stringify(savedInterests);
  const languagesDirty = JSON.stringify(languages) !== JSON.stringify(savedLanguages);
  const layoutDirty = JSON.stringify(layout) !== JSON.stringify(savedLayout);

  return (
    <div className="space-y-6">
      {/* Status mode */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" />Presence mode</CardTitle>
          <CardDescription>Manually set how you appear to friends. Do not disturb also silences notifications (mentions still get through).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {STATUS_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setStatusMode(mode.value)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  statusMode === mode.value ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"
                }`}
              >
                <p className="text-sm font-medium">{mode.label}</p>
                <p className="text-xs text-muted-foreground">{mode.description}</p>
              </button>
            ))}
          </div>
          <div className="flex justify-end">
            <Button onClick={saveStatusMode} disabled={savingStatus || statusMode === savedStatusMode}>
              {savingStatus ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Interests */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Tags className="h-5 w-5" />Interests</CardTitle>
          <CardDescription>Short tags shown on your profile (max {MAX_INTERESTS}).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {interests.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs">
                {tag}
                <button type="button" onClick={() => setInterests((prev) => prev.filter((t) => t !== tag))} className="hover:text-destructive" aria-label={`Remove ${tag}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={interestInput}
              onChange={(e) => setInterestInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addInterest(); } }}
              placeholder="Add an interest and press Enter"
              maxLength={MAX_INTEREST_LENGTH + 1}
            />
            <Button variant="outline" onClick={addInterest} disabled={!interestInput.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={saveInterests} disabled={savingInterests || !interestsDirty}>
              {savingInterests ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Languages */}
      <Card>
        <CardHeader>
          <CardTitle>Languages</CardTitle>
          <CardDescription>Languages you speak, shown on your profile (max {MAX_LANGUAGES}).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {languages.map((entry, index) => (
            <div key={index} className="flex gap-2">
              <Input
                value={entry.code}
                onChange={(e) => setLanguages((prev) => prev.map((l, i) => i === index ? { ...l, code: e.target.value } : l))}
                placeholder="Code (e.g. en)"
                className="w-28 font-mono text-xs"
                maxLength={8}
              />
              <Input
                value={entry.label}
                onChange={(e) => setLanguages((prev) => prev.map((l, i) => i === index ? { ...l, label: e.target.value } : l))}
                placeholder="Language name"
                className="flex-1"
                maxLength={40}
              />
              <Button variant="ghost" size="icon" onClick={() => setLanguages((prev) => prev.filter((_, i) => i !== index))} aria-label="Remove language">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLanguages((prev) => prev.length < MAX_LANGUAGES ? [...prev, { code: "", label: "" }] : prev)}
            disabled={languages.length >= MAX_LANGUAGES}
          >
            <Plus className="h-4 w-4" /> Add language
          </Button>
          <div className="flex justify-end">
            <Button onClick={saveLanguages} disabled={savingLanguages || !languagesDirty}>
              {savingLanguages ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Social links */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Link2 className="h-5 w-5" />Links</CardTitle>
          <CardDescription>Social and personal links shown on your profile (max {MAX_LINKS}).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {links.map((link) => (
            <div key={link.id} className="flex items-center gap-2">
              <span className="w-32 truncate text-sm font-medium">{link.label}</span>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-xs text-primary hover:underline">
                {link.url}
              </a>
              <Button variant="ghost" size="icon" onClick={() => removeLink(link.id)} aria-label={`Remove ${link.label}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {links.length < MAX_LINKS && (
            <div className="flex gap-2">
              <Input
                value={linkDraft.label}
                onChange={(e) => setLinkDraft((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="Label"
                className="w-36"
                maxLength={80}
              />
              <Input
                value={linkDraft.url}
                onChange={(e) => setLinkDraft((prev) => ({ ...prev, url: e.target.value }))}
                placeholder="https://…"
                className="flex-1"
                maxLength={2048}
              />
              <Button variant="outline" onClick={addLink} disabled={savingLink || !linkDraft.label.trim() || !linkDraft.url.trim()}>
                {savingLink ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Profile song */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Music className="h-5 w-5" />Profile song</CardTitle>
          <CardDescription>Search for a song — others hear a ~30s preview on your profile. You can also paste any HTTPS audio URL manually.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={songQuery}
              onChange={(e) => setSongQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void searchSongs(); } }}
              placeholder="Search songs or artists (e.g. Nirvana)"
            />
            <Button variant="outline" onClick={searchSongs} disabled={songSearching || !songQuery.trim()}>
              {songSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
            </Button>
          </div>
          {songResults && (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border">
              {songResults.length === 0 && (
                <p className="px-3 py-2 text-sm text-muted-foreground">No songs with previews found.</p>
              )}
              {songResults.map((result) => (
                <button
                  key={result.trackId}
                  type="button"
                  onClick={() => pickSong(result)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60"
                >
                  {result.artworkUrl100 && (
                    <img src={result.artworkUrl100} alt="" className="h-9 w-9 rounded object-cover" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{result.trackName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{result.artistName}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Autoplay profile songs</p>
              <p className="text-xs text-muted-foreground">Start playing a profile's song automatically when you open it. Applies to profiles you view.</p>
            </div>
            <Switch
              checked={autoplaySongs}
              onCheckedChange={(value) => {
                setAutoplaySongs(value);
                try { localStorage.setItem(PROFILE_SONG_AUTOPLAY_KEY, value ? "1" : "0"); } catch { /* ignore */ }
              }}
            />
          </div>
          {song && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">{song.title}{song.artist ? ` — ${song.artist}` : ""}</p>
              <audio controls preload="none" src={song.url} className="mt-2 w-full" />
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={songDraft.title} onChange={(e) => setSongDraft((prev) => ({ ...prev, title: e.target.value }))} placeholder="Title" maxLength={200} />
            <Input value={songDraft.artist} onChange={(e) => setSongDraft((prev) => ({ ...prev, artist: e.target.value }))} placeholder="Artist" maxLength={200} />
            <Input value={songDraft.url} onChange={(e) => setSongDraft((prev) => ({ ...prev, url: e.target.value }))} placeholder="Audio URL (https)" className="sm:col-span-2" maxLength={2048} />
            <Input value={songDraft.artwork_url} onChange={(e) => setSongDraft((prev) => ({ ...prev, artwork_url: e.target.value }))} placeholder="Artwork URL (optional, https)" className="sm:col-span-2" maxLength={2048} />
          </div>
          <div className="flex justify-end gap-2">
            {song && (
              <Button variant="ghost" onClick={clearSong} disabled={savingSong}>Remove</Button>
            )}
            <Button onClick={saveSong} disabled={savingSong}>
              {savingSong ? "Saving…" : song ? "Update" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Layout order */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ListMusic className="h-5 w-5" />Profile layout</CardTitle>
          <CardDescription>Choose the order profile sections appear in for people viewing your profile.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {layout.map((section, index) => {
            const meta = PROFILE_LAYOUT_SECTIONS.find((entry) => entry.key === section);
            if (!meta) return null;
            return (
              <div key={section} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <span className="text-sm">{meta.label}</span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveSection(index, -1)} disabled={index === 0} aria-label="Move up">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveSection(index, 1)} disabled={index === layout.length - 1} aria-label="Move down">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button onClick={saveLayout} disabled={savingLayout || !layoutDirty}>
              {savingLayout ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
