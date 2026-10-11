/**
 * Activity log filters (Workspace v2 Settings). Every event type is "<area>.<what>"
 * (eventTypeLabel in src/ui/plainText.ts); each area belongs to one filter. The filters only
 * narrow the events already loaded: the log still shows the latest 100, nothing more is fetched.
 */
export type ActivityArea = 'exchanges' | 'connections' | 'agents' | 'rooms' | 'account' | 'other';

export const ACTIVITY_AREAS: { id: ActivityArea; label: string }[] = [
  { id: 'exchanges', label: 'Exchanges' },
  { id: 'connections', label: 'Connections' },
  { id: 'agents', label: 'Agents' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'account', label: 'Account' },
  { id: 'other', label: 'Other' },
];

const BY_PREFIX: Record<string, ActivityArea> = {
  job: 'exchanges',
  result: 'exchanges',
  workflow: 'exchanges',
  connection: 'connections',
  agent: 'agents',
  responder: 'agents',
  elric: 'agents',
  room: 'rooms',
  operator: 'account',
  assistant: 'account',
  workspace: 'account',
};

/** "job.completed" → "exchanges"; an unknown area → "other". */
export function activityArea(type: string): ActivityArea {
  const prefix = type.split('.', 1)[0] ?? '';
  return Object.hasOwn(BY_PREFIX, prefix) ? BY_PREFIX[prefix]! : 'other';
}

/** The filters that match at least one loaded event, in display order, with their counts. */
export function activityFilters(
  events: readonly { type: string }[],
): { id: ActivityArea; label: string; count: number }[] {
  const counts = new Map<ActivityArea, number>();
  for (const event of events) {
    const area = activityArea(event.type);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return ACTIVITY_AREAS.filter((area) => counts.has(area.id)).map((area) => ({
    ...area,
    count: counts.get(area.id)!,
  }));
}
