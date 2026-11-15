import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ServerView } from "./api";

interface MemberListProps {
  view: ServerView;
  onOpenProfile: (userId: string) => void;
}

export function MemberList({ view, onOpenProfile }: MemberListProps) {
  const roles = [...(view.roles || [])].sort((a, b) => Number(b.position || 0) - Number(a.position || 0));
  const everyone = roles.find((role) => role.is_default);
  const namedRoles = roles.filter((role) => !role.is_default);
  const members = view.members || [];
  const owner = members.find((member) => member.user_id === view.server?.owner_id);
  const memberForRole = (roleId: string | null) => members.filter((member) => (member.role_id || null) === roleId && member.user_id !== view.server?.owner_id);
  const everyoneMembers = members.filter((member) => (!member.role_id || member.role_id === everyone?.id) && member.user_id !== view.server?.owner_id);

  const row = (member: any) => {
    const name = member.nickname || member.display_name || member.username;
    return (
      <button
        key={member.membership_id || member.user_id}
        type="button"
        onClick={() => onOpenProfile(member.user_id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent/60"
      >
        <div className="relative">
          <Avatar className="h-8 w-8"><AvatarImage src={member.avatar_url || undefined} /><AvatarFallback>{String(name || "?")[0]?.toUpperCase()}</AvatarFallback></Avatar>
          {member.status === "online" && <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-sidebar" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-sidebar-foreground">{name}</p>
          {member.nickname && member.display_name && <p className="truncate text-xs text-muted-foreground">{member.display_name}</p>}
        </div>
      </button>
    );
  };

  const section = (title: string, color: string | null, items: any[]) => items.length ? (
    <div key={title} className="space-y-0.5">
      <h4 className="px-2 pt-3 text-[11px] font-semibold uppercase tracking-wide" style={color ? { color } : undefined}>{title}</h4>
      {items.map(row)}
    </div>
  ) : null;

  return (
    <aside className="hidden h-full w-60 flex-shrink-0 flex-col border-l bg-sidebar lg:flex">
      <ScrollArea className="flex-1">
        <div className="p-2">
          {owner && section("Owner", "#f0b232", [owner])}
          {namedRoles.map((role) => section(role.name, role.color, memberForRole(role.id)))}
          {section("Online", null, everyoneMembers.filter((member) => member.status === "online"))}
          {section("Offline", null, everyoneMembers.filter((member) => member.status !== "online"))}
        </div>
      </ScrollArea>
    </aside>
  );
}
