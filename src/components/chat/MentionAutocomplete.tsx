import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";
import { AtSign, Hash, Users } from "lucide-react";

export interface MentionCandidate {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface MentionAutocompleteProps {
  /** Current query, e.g. user typed `@al` => query is "al" (lowercased). */
  query: string;
  /** Scope determines candidate source. */
  scope: "dm" | "global" | "announcements" | "server";
  /** For dm/server scope: members of the conversation (excluding viewer). */
  dmMembers?: MentionCandidate[];
  /** Server roles/channels that can be mentioned with structured tokens. */
  serverMentions?: {
    roles: { id: string; name: string; color?: string | null }[];
    channels: { id: string; name: string }[];
  };
  /** Show the @everyone option (admins/permission holders only). */
  allowEveryone: boolean;
  /** Show the @here option for server channels. */
  allowHere?: boolean;
  /** Anchor element for positioning the floating panel. */
  anchorEl: HTMLElement | null;
  /** Called when the user picks an option (username or "everyone"). */
  onSelect: (value: string) => void;
  /** Called when the user dismisses (Escape). */
  onDismiss: () => void;
  /** Externally driven keyboard nav (arrow keys + enter from the textarea). */
  registerKeyHandler?: (handler: (e: KeyboardEvent) => boolean) => void;
}

const PAGE = 8;

export function MentionAutocomplete({
  query,
  scope,
  dmMembers = [],
  serverMentions,
  allowEveryone,
  allowHere = false,
  anchorEl,
  onSelect,
  onDismiss,
  registerKeyHandler,
}: MentionAutocompleteProps) {
  const [results, setResults] = useState<MentionCandidate[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Build the candidate list
  useEffect(() => {
    let cancelled = false;
    const q = query.trim().toLowerCase();
    if (scope === "dm" || scope === "server") {
      const filtered = dmMembers.filter(
        (m) =>
          !q ||
          m.username.toLowerCase().includes(q) ||
          (m.display_name?.toLowerCase().includes(q) ?? false),
      );
      setResults(filtered.slice(0, PAGE));
      setActiveIdx(0);
      return;
    }
    // global / announcements: live profile search
    const run = async () => {
      let query = supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .order("username", { ascending: true })
        .limit(PAGE);
      if (q) {
        query = query.or(`username.ilike.${q}%,display_name.ilike.${q}%`);
      }
      const { data } = await query;
      if (cancelled) return;
      setResults((data || []) as MentionCandidate[]);
      setActiveIdx(0);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [query, scope, dmMembers]);

  const showEveryone = useMemo(() => {
    if (!allowEveryone) return false;
    const q = query.trim().toLowerCase();
    return !q || "everyone".startsWith(q);
  }, [allowEveryone, query]);

  const showHere = useMemo(() => {
    if (!allowHere) return false;
    const q = query.trim().toLowerCase();
    return !q || "here".startsWith(q);
  }, [allowHere, query]);

  const serverItems = useMemo(() => {
    if (scope !== "server" || !serverMentions) return { roles: [], channels: [] };
    const q = query.trim().toLowerCase();
    return {
      roles: serverMentions.roles.filter((role) => !q || role.name.toLowerCase().includes(q)).slice(0, 4),
      channels: serverMentions.channels.filter((channel) => !q || channel.name.toLowerCase().includes(q)).slice(0, 4),
    };
  }, [scope, serverMentions, query]);

  // Total items including special rows at the top
  const items = useMemo(() => {
    const arr: Array<
      | { kind: "everyone" }
      | { kind: "here" }
      | { kind: "role"; id: string; name: string; color?: string | null }
      | { kind: "channel"; id: string; name: string }
      | { kind: "user"; user: MentionCandidate }
    > = [];
    if (showEveryone) arr.push({ kind: "everyone" });
    if (showHere) arr.push({ kind: "here" });
    serverItems.roles.forEach((role) => arr.push({ kind: "role", ...role }));
    serverItems.channels.forEach((channel) => arr.push({ kind: "channel", ...channel }));
    results.forEach((u) => arr.push({ kind: "user", user: u }));
    return arr;
  }, [showEveryone, showHere, serverItems, results]);

  useEffect(() => {
    setActiveIdx((idx) => Math.min(idx, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Keyboard nav
  useEffect(() => {
    if (!registerKeyHandler) return;
    const handler = (e: KeyboardEvent): boolean => {
      if (items.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % items.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const it = items[activeIdx];
        if (it?.kind === "everyone") onSelect("everyone");
        else if (it?.kind === "here") onSelect("here");
        else if (it?.kind === "role") onSelect(`role:${it.id}`);
        else if (it?.kind === "channel") onSelect(`channel:${it.id}`);
        else if (it?.kind === "user") onSelect(it.user.username);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return true;
      }
      return false;
    };
    registerKeyHandler(handler);
    return () => registerKeyHandler(() => false);
  }, [items, activeIdx, onSelect, onDismiss, registerKeyHandler]);

  // Compute position above the anchor (textarea)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!anchorEl) return;
    const update = () => {
      const r = anchorEl.getBoundingClientRect();
      setPos({
        left: r.left,
        bottom: window.innerHeight - r.top + 6,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorEl]);

  if (!pos || items.length === 0) return null;

  return (
    <div
      ref={panelRef}
      style={{ position: "fixed", left: pos.left, bottom: pos.bottom, zIndex: 60 }}
      className="w-72 max-w-[90vw] rounded-lg border border-border bg-popover shadow-lg overflow-hidden"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border flex items-center gap-1.5">
        <AtSign className="h-3 w-3" /> Members matching “{query}”
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {items.map((it, idx) => {
          const isActive = idx === activeIdx;
          if (it.kind === "everyone") {
            return (
              <button
                key="everyone"
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => onSelect("everyone")}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
                  isActive ? "bg-accent" : ""
                }`}
              >
                <div className="h-7 w-7 rounded-full bg-destructive/20 text-destructive flex items-center justify-center">
                  <Users className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-destructive">@everyone</div>
                  <div className="text-xs text-muted-foreground truncate">
                    Notify everyone in this channel
                  </div>
                </div>
              </button>
            );
          }
          if (it.kind === "here") {
            return (
              <button key="here" type="button" onMouseEnter={() => setActiveIdx(idx)} onClick={() => onSelect("here")} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${isActive ? "bg-accent" : ""}`}>
                <div className="h-7 w-7 rounded-full bg-primary/20 text-primary flex items-center justify-center"><AtSign className="h-3.5 w-3.5" /></div>
                <div className="flex-1 min-w-0"><div className="font-medium text-primary">@here</div><div className="text-xs text-muted-foreground truncate">Notify online members</div></div>
              </button>
            );
          }
          if (it.kind === "role") {
            return (
              <button key={`role-${it.id}`} type="button" onMouseEnter={() => setActiveIdx(idx)} onClick={() => onSelect(`role:${it.id}`)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${isActive ? "bg-accent" : ""}`}>
                <div className="h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ backgroundColor: it.color ? `${it.color}33` : "rgba(88,101,242,0.2)", color: it.color || "#5865f2" }}>@</div>
                <div className="flex-1 min-w-0"><div className="font-medium truncate" style={{ color: it.color || undefined }}>@{it.name}</div><div className="text-xs text-muted-foreground truncate">Role mention</div></div>
              </button>
            );
          }
          if (it.kind === "channel") {
            return (
              <button key={`channel-${it.id}`} type="button" onMouseEnter={() => setActiveIdx(idx)} onClick={() => onSelect(`channel:${it.id}`)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${isActive ? "bg-accent" : ""}`}>
                <div className="h-7 w-7 rounded-full bg-primary/20 text-primary flex items-center justify-center"><Hash className="h-3.5 w-3.5" /></div>
                <div className="flex-1 min-w-0"><div className="font-medium text-primary truncate">#{it.name}</div><div className="text-xs text-muted-foreground truncate">Channel mention</div></div>
              </button>
            );
          }
          const u = it.user;
          return (
            <button
              key={u.id}
              type="button"
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => onSelect(u.username)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
                isActive ? "bg-accent" : ""
              }`}
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={u.avatar_url || undefined} />
                <AvatarFallback className="text-[10px]">
                  {u.username[0]?.toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {u.display_name || u.username}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  @{u.username}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
