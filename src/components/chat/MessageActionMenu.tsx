import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Copy,
  Flag,
  Forward,
  Hash,
  Pencil,
  Pin,
  Reply,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// The four quick-react emojis shown at the top of the menu — the most-used
// reactions in the app's emoji set.
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮"] as const;

export interface ActionMenuMessage {
  id: string;
  content: string | null;
  sender_id: string | null;
  is_pinned?: boolean | null;
}

export interface MessageActionMenuState {
  x: number;
  y: number;
  message: ActionMenuMessage;
}

interface MessageActionMenuProps {
  state: MessageActionMenuState | null;
  isOwn: boolean;
  isSuperAdmin: boolean;
  canPost: boolean;
  onAction: (action: string) => void;
  onClose: () => void;
}

function MenuItem({
  icon: Icon,
  label,
  destructive,
  onClick,
}: {
  icon: typeof Reply;
  label: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm outline-none transition-colors",
        "hover:bg-accent focus:bg-accent",
        destructive ? "text-destructive" : "text-popover-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function MessageActionMenu({
  state,
  isOwn,
  isSuperAdmin,
  canPost,
  onAction,
  onClose,
}: MessageActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // Clamp the menu inside the viewport once its real size is known.
  useLayoutEffect(() => {
    if (!state) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = state.x;
    let y = state.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    x = Math.max(8, x);
    y = Math.max(8, y);
    setPos({ x, y });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [state, onClose]);

  if (!state) return null;

  const canModerate = isOwn || isSuperAdmin;
  const run = (action: string) => {
    onAction(action);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-[61] w-60 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
      >
        {/* Quick reactions */}
        <div className="flex items-center justify-center gap-1 px-2 py-2">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              onClick={() => run(`react:${emoji}`)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-xl transition-all hover:scale-110 hover:bg-accent"
            >
              {emoji}
            </button>
          ))}
        </div>
        <div className="mx-2 border-t border-border" />

        {canPost && (
          <MenuItem icon={Reply} label="Reply" onClick={() => run("reply")} />
        )}
        {isOwn && state.message.content && (
          <MenuItem icon={Pencil} label="Edit Message" onClick={() => run("edit")} />
        )}
        <MenuItem icon={SmilePlus} label="React" onClick={() => run("react")} />
        {canModerate && (
          <MenuItem
            icon={Trash2}
            label={isOwn ? "Delete Message" : "Delete Message (Mod)"}
            destructive
            onClick={() => run("delete")}
          />
        )}
        <MenuItem icon={Forward} label="Forward Message" onClick={() => run("forward")} />
        {state.message.content && (
          <MenuItem icon={Copy} label="Copy Text" onClick={() => run("copyText")} />
        )}
        <MenuItem icon={Hash} label="Copy Message ID" onClick={() => run("copyId")} />
        {canModerate && (
          <MenuItem
            icon={Pin}
            label={state.message.is_pinned ? "Unpin Message" : "Pin Message"}
            onClick={() => run("pin")}
          />
        )}
        {!isOwn && (
          <MenuItem
            icon={Flag}
            label="Report Message"
            destructive
            onClick={() => run("report")}
          />
        )}
      </div>
    </>
  );
}
