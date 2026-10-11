/*
 * One room order for the workspace sidebar on every page (WORKSPACE_V3.md §3): open rooms
 * before ended ones, then the latest activity, then the newest room. Activity is what the app
 * has already read: the newest message an unread lookup fetched and new messages a rooms-list
 * poll saw (RoomsApp on room pages, the sidebar's own list elsewhere). Both record it here, per
 * workspace and per device, so a page change or a reload keeps the order. No extra requests.
 */

export type ActivityRoom = { id: string; closed: boolean; created_at: string };

/** Rooms kept in the record; the oldest activity is dropped beyond this. */
const MAX_ROOMS = 500;
const key = (workspace: string) => `cc.rooms.activity.${workspace}`;

/** Activity times (ms) per room id, as recorded on this device. */
export function readRoomActivity(workspace: string): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(key(workspace)) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0,
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Records newer activity times (a time only ever moves forward). Returns the merged record, the
 * same object when nothing changed.
 */
export function recordRoomActivity(
  workspace: string,
  seen: Record<string, number>,
  current: Record<string, number> = readRoomActivity(workspace),
): Record<string, number> {
  let next: Record<string, number> | null = null;
  for (const [id, at] of Object.entries(seen)) {
    if (!Number.isSafeInteger(at) || at <= 0 || (current[id] ?? 0) >= at) continue;
    next ??= { ...current };
    next[id] = at;
  }
  if (!next) return current;
  const kept = Object.entries(next)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ROOMS);
  const merged = Object.fromEntries(kept);
  try {
    window.localStorage.setItem(key(workspace), JSON.stringify(merged));
  } catch {
    // Storage unavailable: the order falls back to this session's activity.
  }
  return merged;
}

/** A room's latest activity: the newest of its creation and any recorded time. */
export function roomActivityAt(room: ActivityRoom, ...times: Array<number | null | undefined>) {
  return Math.max(Date.parse(room.created_at) || 0, ...times.map((time) => time ?? 0));
}

/** Open rooms first, then the latest activity, then the newest room (ties by id). */
export function sortRoomsByActivity<T extends ActivityRoom>(
  rooms: readonly T[],
  activity: (room: T) => number,
): T[] {
  return [...rooms].sort(
    (a, b) =>
      Number(a.closed) - Number(b.closed) ||
      activity(b) - activity(a) ||
      (b.created_at ?? '').localeCompare(a.created_at ?? '') ||
      a.id.localeCompare(b.id),
  );
}
