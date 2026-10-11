import { createContext, useContext, useMemo, type CSSProperties } from 'react';

/**
 * Avatar colours (docs/design/WORKSPACE_V3.md §2): every agent and person gets a colour from a
 * 16-colour palette, chosen by a stable unique id (agent id, room member id, account or workspace
 * id), never by the display name, so two members called the same still look different.
 *
 * - `avatarColor(id)` is the id's home colour (FNV-1a hash slot): steady between visits, devices
 *   and pages, used wherever no list context exists.
 * - `assignAvatarColors(members)` gives every member of one room (or one list: My agents, the
 *   Messages inbox) a different colour while there are at most 16 of them: members are taken in
 *   join order (then id), each starts at its home slot and steps to the next free one. Earlier
 *   members keep their colour when someone new joins; only the newcomer moves on.
 * - Room surfaces (messages, Members, tasks, the top bar) read one shared assignment through
 *   `AvatarColorsContext`, so they always agree.
 *
 * Each colour carries white initials at a contrast of at least 4.5:1 (WCAG AA for normal text),
 * no two are near-duplicates, and none is close to Elric's accent blue (`--primary`, #2563eb),
 * which stays Elric's own mark; tests/avatar-color.test.ts checks all three. The order spreads
 * hues apart, so a member that steps to the next slot lands on a clearly different colour. The
 * colours stay the same in light and dark themes.
 */
export const AVATAR_PALETTE = [
  '#dc2626', // red
  '#15803d', // green
  '#6d28d9', // violet
  '#475569', // slate
  '#4d7c0f', // olive
  '#1e3a8a', // navy
  '#881337', // wine
  '#a16207', // ochre
  '#0369a1', // sky
  '#be185d', // pink
  '#92400e', // brown
  '#0e7490', // cyan
  '#701a75', // plum
  '#c2410c', // orange
  '#0f766e', // teal
  '#c026d3', // fuchsia
] as const;

/** White initials on every palette colour. */
export const AVATAR_TEXT = '#ffffff';

/** The id's home slot in the palette: FNV-1a over the trimmed key. */
export function avatarSlot(key: string): number {
  const text = key.trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % AVATAR_PALETTE.length;
}

/** The id's home colour (no list context): steady per id. Pass an id, not a display name. */
export function avatarColor(key: string): string {
  return AVATAR_PALETTE[avatarSlot(key)];
}

/** One entry to colour: an id, or an id with its join (or creation) time for a stable order. */
export type AvatarEntry = string | { id: string; joinedAt?: string | null };

/**
 * A different palette colour for every id in one room or list (id → colour). Order: join time
 * (entries without one keep their given order, after those with one), then id; each id takes its
 * home slot or the next free one. Past 16 ids a new round starts, so colours repeat only then.
 * Duplicate ids keep their first colour.
 */
export function assignAvatarColors(entries: readonly AvatarEntry[]): Map<string, string> {
  const listed = entries
    .map((entry, index) => {
      const item = typeof entry === 'string' ? { id: entry } : entry;
      return { id: item.id, joinedAt: item.joinedAt ?? null, index };
    })
    .filter((entry) => entry.id);
  const timed = listed
    .filter((entry) => entry.joinedAt)
    .sort((a, b) =>
      a.joinedAt! < b.joinedAt!
        ? -1
        : a.joinedAt! > b.joinedAt!
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
  const untimed = listed.filter((entry) => !entry.joinedAt);
  const colours = new Map<string, string>();
  const taken = new Set<number>();
  for (const { id } of [...timed, ...untimed]) {
    if (colours.has(id)) continue;
    if (taken.size === AVATAR_PALETTE.length) taken.clear();
    let slot = avatarSlot(id);
    while (taken.has(slot)) slot = (slot + 1) % AVATAR_PALETTE.length;
    taken.add(slot);
    colours.set(id, AVATAR_PALETTE[slot]);
  }
  return colours;
}

/** The colours of the room or list being shown (empty outside one: home colours apply). */
export const AvatarColorsContext = createContext<ReadonlyMap<string, string>>(new Map());

/** `assignAvatarColors`, memoised on the ids and join times, for a provider of the context. */
export function useAvatarColors(entries: readonly AvatarEntry[]): ReadonlyMap<string, string> {
  const key = entries
    .map((entry) =>
      typeof entry === 'string' ? entry : `${entry.id}\u0000${entry.joinedAt ?? ''}`,
    )
    .join('\u0001');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key covers every input
  return useMemo(() => assignAvatarColors(entries), [key]);
}

/** One id's colour: its room or list colour when one is provided, else its home colour. */
export function useAvatarColor(id: string): string {
  return useContext(AvatarColorsContext).get(id) ?? avatarColor(id);
}

/** Inline style for an avatar element: the given (or the id's home) colour and white initials. */
export function avatarStyle(key: string, colour = avatarColor(key)): CSSProperties {
  return { backgroundColor: colour, color: AVATAR_TEXT };
}

/** Inline style for an avatar inside a room or list: `avatarStyle` with the shared colour. */
export function useAvatarStyle(id: string): CSSProperties {
  return avatarStyle(id, useAvatarColor(id));
}
