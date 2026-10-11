import type { CSSProperties } from 'react';
import { avatarStyle, useAvatarColor, type AvatarEntry } from '../shell/avatarColor';

/*
 * Workspace v3 avatars (docs/design/WORKSPACE_V3.md §2): one palette colour per member id,
 * different for every member of the room (src/shell/avatarColor.ts), white initials; people are
 * round, AIs a rounded square, Elric the accent. Decorative: the name is always next to it (or in
 * the control's accessible name).
 */

export type AvatarKind = 'person' | 'agent' | 'elric';

/** The first letter of a name, for an avatar. */
export function initialOf(name: string) {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/**
 * The avatar's inline colours for a member id: Elric uses the accent (CSS), everyone else the
 * room's colour for that id (AvatarColorsContext; the id's home colour outside a room).
 */
export function useAvatarColours(id: string, kind: AvatarKind | null): CSSProperties | undefined {
  const colour = useAvatarColor(id);
  return kind === null || kind === 'elric' ? undefined : avatarStyle(id, colour);
}

export function Avatar({
  id = '',
  name,
  kind,
  size = 'md',
  className = '',
  hidden,
}: {
  /** The member (agent) id that picks the colour; Elric's avatar needs none. */
  id?: string;
  name: string;
  kind: AvatarKind;
  /** md 40 px (messages), sm 28 px (the room pill), xs 24 px (pills, Post as). */
  size?: 'md' | 'sm' | 'xs';
  className?: string;
  hidden?: boolean;
}) {
  const colours = useAvatarColours(id, kind);
  return (
    <span
      className={`rm-avatar rm3-av rm3-av-${size}${className ? ` ${className}` : ''}`}
      data-kind={kind}
      style={colours}
      aria-hidden="true"
      hidden={hidden}
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * The ids a room colours, in the order that keeps colours steady (src/shell/avatarColor.ts):
 * current members by join time, then senders who have left, in order of their first message.
 * Elric keeps its own mark, so it takes no palette colour.
 */
export function roomAvatarEntries(
  members: readonly {
    id: string;
    joined_at?: string;
    auto_reply?: { provider: string } | null;
  }[],
  messages: readonly {
    sender_agent_id: string;
    sender_kind?: string;
    auto_reply?: { provider: string } | null;
  }[],
): AvatarEntry[] {
  const entries: AvatarEntry[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (member.auto_reply?.provider === 'elric' || seen.has(member.id)) continue;
    seen.add(member.id);
    entries.push({ id: member.id, joinedAt: member.joined_at ?? null });
  }
  const departed: string[] = [];
  for (const message of messages) {
    const id = message.sender_agent_id;
    if (!id || seen.has(id) || message.auto_reply?.provider === 'elric') continue;
    if (message.sender_kind === 'system') continue;
    seen.add(id);
    departed.push(id);
  }
  return [...entries, ...departed];
}
