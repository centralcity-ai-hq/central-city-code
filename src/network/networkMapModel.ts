import type { ConnectionRequest } from '../../shared/assistant';
import type { Agent, Connection } from '../../shared/types';
import {
  relax,
  slideOnRings,
  ringCount,
  ringLayout,
  snapToRings,
  visibleLabels,
  type RingSet,
  type Bounds,
  type Box,
  type Point,
} from './mapGeometry';

/*
 * Network map (Workspace v2): pure layout and route mapping, derived only from the workspace
 * snapshot (agents, same-owner connections) and the approved cross-owner connection requests the
 * Agent permissions page already loads. Nothing here invents a metric.
 */

export type MapAgent = Pick<
  Agent,
  'id' | 'name' | 'capability' | 'mode' | 'status' | 'isDemo' | 'revokedAt'
> &
  Partial<Pick<Agent, 'pausedAt'>>;

/** A one-way route between two of this workspace's agents: `from` can send work to `to`. */
export interface MapRoute {
  id: string;
  from: string;
  to: string;
}

/** An approved route with another owner's agent; only this workspace's end is on the map. */
export interface ExternalRoute {
  id: string;
  /** This workspace's agent. */
  agentId: string;
  /** 'out': agentId can send work to the other agent. 'in': the other agent can send to agentId. */
  direction: 'in' | 'out';
  /** The other agent's name, when the server disclosed it. */
  otherName: string;
  ownerLabel: string;
}

/** A name in an agent's "sends to" / "receives from" routes (popover counts and text list). */
export interface RouteChip {
  key: string;
  label: string;
  /** Set for this workspace's agents, so the chip can select them on the map. */
  agentId?: string;
  ownerLabel?: string;
}

/** The tag on a cross-owner chip when the API does not name the other owner. */
export const OTHER_WORKSPACE = 'Another workspace';

/** Approved cross-owner connections read per direction before the map stops paging. */
export const CROSS_OWNER_CAP = 500;
const CROSS_OWNER_PAGE = 100;

export type ConnectionLists = { incoming: ConnectionRequest[]; outgoing: ConnectionRequest[] };
type ConnectionPage = ConnectionLists & { next_before: string | null };

/**
 * Every approved cross-owner connection, per direction, as the agent inspection tabs read them:
 * status=approved, limit=100, paging with before/next_before, up to `cap` per direction.
 * `capped` is true when a direction had more than the cap.
 */
export async function loadApprovedConnections(
  fetchPage: (query: string) => Promise<ConnectionPage>,
  cap = CROSS_OWNER_CAP,
): Promise<{ lists: ConnectionLists; capped: boolean }> {
  const lists: ConnectionLists = { incoming: [], outgoing: [] };
  let capped = false;
  await Promise.all(
    (['incoming', 'outgoing'] as const).map(async (direction) => {
      const seen = new Map<string, ConnectionRequest>();
      let before: string | null = null;
      for (;;) {
        const query = new URLSearchParams({
          direction,
          status: 'approved',
          limit: String(CROSS_OWNER_PAGE),
        });
        if (before) query.set('before', before);
        const page = await fetchPage(query.toString());
        for (const request of page[direction] ?? [])
          if (request.status === 'approved' && request.direction === direction)
            seen.set(request.id, request);
        before = page.next_before;
        if (!before) break;
        if (seen.size >= cap) {
          capped = true;
          break;
        }
      }
      lists[direction] = [...seen.values()].slice(0, cap);
    }),
  );
  return { lists, capped };
}

/** Above this many agents the map opens as a list first; the map stays one click away. */
export const LIST_FIRST_THRESHOLD = 30;

/** Agents the map shows: every agent that is not revoked, in snapshot order. */
export function mapAgents<T extends MapAgent>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.status !== 'revoked' && !agent.revokedAt);
}

/** Online on the map means the server reports the agent online or working (a recent heartbeat). */
export function isOnline(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'online' || agent.status === 'working';
}

/** The status word the map and popover show. Paused wins over the presence status. */
export function statusWord(agent: Pick<Agent, 'status'> & Partial<Pick<Agent, 'pausedAt'>>) {
  if (agent.pausedAt) return 'Paused';
  if (agent.status === 'working') return 'Working';
  if (agent.status === 'online') return 'Online';
  if (agent.status === 'revoked') return 'Removed';
  return 'Offline';
}

/**
 * Same-owner routes between visible agents: one per direction, no self routes, and none that
 * point at a removed or unknown agent.
 */
export function mapRoutes(
  agents: readonly Pick<Agent, 'id'>[],
  connections: readonly Pick<Connection, 'id' | 'fromAgentId' | 'toAgentId'>[],
): MapRoute[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const seen = new Set<string>();
  const routes: MapRoute[] = [];
  for (const connection of connections) {
    const { fromAgentId: from, toAgentId: to } = connection;
    if (from === to || !ids.has(from) || !ids.has(to)) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ id: connection.id, from, to });
  }
  return routes;
}

/**
 * Approved cross-owner requests as routes for this workspace's visible agents. An incoming
 * request lets the other owner's agent send work to ours; an outgoing one lets ours send to theirs.
 */
export function externalRoutes(
  agents: readonly Pick<Agent, 'id'>[],
  lists: { incoming: ConnectionRequest[]; outgoing: ConnectionRequest[] } | null,
): ExternalRoute[] {
  if (!lists) return [];
  const ids = new Set(agents.map((agent) => agent.id));
  const routes: ExternalRoute[] = [];
  for (const request of lists.incoming ?? []) {
    if (request.status !== 'approved' || !ids.has(request.to_agent_id)) continue;
    routes.push({
      id: request.id,
      agentId: request.to_agent_id,
      direction: 'in',
      otherName: request.from_agent_name || 'An agent',
      ownerLabel: request.from_owner_label,
    });
  }
  for (const request of lists.outgoing ?? []) {
    if (request.status !== 'approved' || !ids.has(request.from_agent_id)) continue;
    routes.push({
      id: request.id,
      agentId: request.from_agent_id,
      direction: 'out',
      otherName: request.to_agent_name || 'An agent',
      // The API names the other owner only on incoming requests.
      ownerLabel: OTHER_WORKSPACE,
    });
  }
  return routes;
}

/** Who every agent can send work to and receive work from, built once per snapshot. */
export function routeIndex(
  agents: readonly Pick<Agent, 'id'>[],
  routes: readonly MapRoute[],
  external: readonly ExternalRoute[],
  nameOf: (id: string) => string,
): Map<string, { sendsTo: RouteChip[]; receivesFrom: RouteChip[] }> {
  const index = new Map(
    agents.map((agent) => [
      agent.id,
      { sendsTo: [] as RouteChip[], receivesFrom: [] as RouteChip[] },
    ]),
  );
  for (const route of routes) {
    index
      .get(route.from)
      ?.sendsTo.push({ key: route.id, label: nameOf(route.to), agentId: route.to });
    index
      .get(route.to)
      ?.receivesFrom.push({ key: route.id, label: nameOf(route.from), agentId: route.from });
  }
  for (const route of external) {
    const entry = index.get(route.agentId);
    if (!entry) continue;
    const chip = {
      key: route.id,
      label: route.otherName,
      ownerLabel: route.ownerLabel || undefined,
    };
    (route.direction === 'out' ? entry.sendsTo : entry.receivesFrom).push(chip);
  }
  return index;
}

/** Who one agent can send work to and receive work from, for the popover and the text list. */
export function agentRoutes(
  agentId: string,
  routes: readonly MapRoute[],
  external: readonly ExternalRoute[],
  nameOf: (id: string) => string,
): { sendsTo: RouteChip[]; receivesFrom: RouteChip[] } {
  const sendsTo: RouteChip[] = routes
    .filter((route) => route.from === agentId)
    .map((route) => ({ key: route.id, label: nameOf(route.to), agentId: route.to }));
  const receivesFrom: RouteChip[] = routes
    .filter((route) => route.to === agentId)
    .map((route) => ({ key: route.id, label: nameOf(route.from), agentId: route.from }));
  for (const route of external) {
    if (route.agentId !== agentId) continue;
    const chip = {
      key: route.id,
      label: route.otherName,
      ownerLabel: route.ownerLabel || undefined,
    };
    (route.direction === 'out' ? sendsTo : receivesFrom).push(chip);
  }
  return { sendsTo, receivesFrom };
}

/* ---------- Layout: concentric rings that scale to fit the card ---------- */

/** Node sizes for the map: avatars and name pills, desktop and phone. */
export interface NodeMetrics {
  avatar: number;
  labelGap: number;
  labelHeight: number;
  maxLabel: number;
  maxChars: number;
  charWidth: number;
  /** Left plus right padding inside a name pill (16 px at full size). */
  labelPad?: number;
  /** Space kept between settled boxes: more than twice the float radius. */
  gap: number;
}

export const DESKTOP_METRICS: NodeMetrics = {
  avatar: 36,
  labelGap: 6,
  labelHeight: 20,
  maxLabel: 140,
  maxChars: 18,
  charWidth: 7.1,
  gap: 10,
};

export const PHONE_METRICS: NodeMetrics = {
  avatar: 32,
  labelGap: 4,
  labelHeight: 18,
  maxLabel: 116,
  maxChars: 14,
  charWidth: 6.6,
  gap: 7,
};

/**
 * The metrics at the workspace's density: the signed-in workspace draws everything at `unit`
 * (0.9 on desktop, 1 on phones; --ws-px in src/shell/tokens.css). Name text never goes below
 * 12 px, so its width shrinks less.
 */
export function scaleMetrics(metrics: NodeMetrics, unit: number): NodeMetrics {
  if (!(unit > 0) || unit === 1) return metrics;
  const scale = (value: number) => Math.round(value * unit * 10) / 10;
  return {
    avatar: scale(metrics.avatar),
    labelGap: scale(metrics.labelGap),
    labelHeight: scale(metrics.labelHeight),
    maxLabel: scale(metrics.maxLabel),
    maxChars: metrics.maxChars,
    charWidth: (metrics.charWidth * Math.max(12, 13 * unit)) / 13,
    labelPad: scale(metrics.labelPad ?? 16),
    gap: scale(metrics.gap),
  };
}

/** The width a name pill may take (an upper bound; the pill's CSS max-width is the same). */
export function labelWidth(text: string, metrics: NodeMetrics): number {
  return Math.min(
    metrics.maxLabel,
    Math.ceil([...text].length * metrics.charWidth + (metrics.labelPad ?? 16)),
  );
}

/** The avatar box, the name pill box (under the avatar) and both together, around the centre. */
export function nodeBoxes(label: string, metrics: NodeMetrics) {
  const r = metrics.avatar / 2;
  const half = labelWidth(label, metrics) / 2;
  const top = r + metrics.labelGap;
  const avatar: Box = { left: -r, right: r, top: -r, bottom: r };
  const pill: Box = { left: -half, right: half, top, bottom: top + metrics.labelHeight };
  const full: Box = {
    left: Math.min(-r, -half),
    right: Math.max(r, half),
    top: -r,
    bottom: pill.bottom,
  };
  return { avatar, pill, full };
}

export interface MapPlan {
  homes: Point[];
  /** True when not every name fits and only `labels[i]` names show (all show on hover). */
  compact: boolean;
  /** True when every agent sits on its ring (the middle one in the middle), evenly spaced. */
  onRings: boolean;
  labels: boolean[];
  avatars: Box[];
  pills: Box[];
  /** Names longer than this end in an ellipsis on the map. */
  maxChars: number;
  /** The rings to draw (inner first) around `center`. */
  center: Point;
  rings: { rx: number; ry: number }[];
}

/**
 * The agents on concentric rings that scale to fit a card of `width` x `height`. From three
 * agents on, the busiest one sits in the middle and the next busiest take the inner ring. Names shorten (down to 8 characters) before any is hidden; on a
 * crowded card only the names that fit show, busiest first, and the rest on hover or selection.
 * Avatars and shown names never overlap, with room left for the gentle float.
 */
export function planMap(
  agents: readonly Pick<Agent, 'id' | 'name'>[],
  routes: readonly MapRoute[],
  width: number,
  height: number,
  metrics: NodeMetrics,
): MapPlan {
  const bounds: Bounds = { width, height, padding: 10 };
  const text = (agent: Pick<Agent, 'name'>, maxChars: number) => shortName(agent.name, maxChars);
  const index = new Map(agents.map((agent, i) => [agent.id, i]));
  const degree = agents.map(() => 0);
  for (const route of routes) {
    const a = index.get(route.from);
    const b = index.get(route.to);
    if (a === undefined || b === undefined) continue;
    degree[a]++;
    degree[b]++;
  }
  // Busiest first: they fill the inner ring and keep their names longest.
  const priority = [...degree.keys()].sort((a, b) => degree[b] - degree[a] || a - b);
  const r = metrics.avatar / 2;

  const place = (boxes: Box[], ringTotal = ringCount(agents.length)) => {
    const half = Math.max(r, ...boxes.map((box) => Math.max(-box.left, box.right)));
    const bottom = Math.max(r, ...boxes.map((box) => box.bottom));
    const top = bounds.padding + r;
    const usable = height - top - bottom - bounds.padding;
    const ry = Math.max(0, usable / 2);
    const fit = Math.max(0, width / 2 - half - bounds.padding);
    // A ring of a few agents stays round-ish; more agents use the card's width (at most 3.6:1).
    const aspect = agents.length <= 4 ? 1.7 : agents.length <= 8 ? 2.4 : 3.6;
    const rx = Math.min(fit, Math.max(ry, ry * aspect));
    const set = ringLayout(agents.length, { cx: width / 2, cy: top + ry, rx, ry }, ringTotal, true);
    const homes: Point[] = new Array(agents.length);
    priority.forEach((node, rank) => {
      const { x, y } = set.positions[rank];
      homes[node] = { x, y };
    });
    return { homes, set };
  };

  // Evenly spaced on the rings when the boxes fit there (turning a ring if needed); otherwise
  // nudged apart off the rings, when `loose` allows it.
  const settle = (homes: Point[], set: RingSet, boxes: Box[], loose: boolean) => {
    // Boxes that together need more than the card holds never fit; skip the search.
    const need = boxes.reduce(
      (sum, box) =>
        sum + (box.right - box.left + metrics.gap) * (box.bottom - box.top + metrics.gap),
      0,
    );
    if (need > width * height * 0.75) return null;
    const ranked = priority.map((node) => boxes[node]);
    const snapped =
      snapToRings(set, ranked, bounds, metrics.gap) ??
      slideOnRings(set, ranked, bounds, metrics.gap);
    if (snapped) {
      priority.forEach((node, rank) => {
        homes[node] = snapped[rank];
      });
      return 'rings' as const;
    }
    return loose && relax(homes, boxes, bounds, metrics.gap) ? ('loose' as const) : null;
  };

  const plan = (
    homes: Point[],
    set: RingSet,
    boxes: ReturnType<typeof nodeBoxes>[],
    maxChars: number,
    fit: 'rings' | 'loose',
    labels: boolean[] | null,
  ): MapPlan => ({
    homes: homes.map(rounded),
    compact: labels !== null,
    onRings: fit === 'rings',
    labels: labels ?? agents.map(() => true),
    avatars: boxes.map((box) => box.avatar),
    pills: boxes.map((box) => box.pill),
    maxChars,
    center: set.center,
    rings: set.rings,
  });
  const rings = ringCount(agents.length);
  // Fewer rings only when the agents do not fit on all of them (a short card holds fewer rows).
  const ringChoices = rings > 1 ? [rings, rings - 1] : [rings];
  const allNamed = (maxChars: number, loose: boolean, ringTotal = rings) => {
    const boxes = agents.map((agent) => nodeBoxes(text(agent, maxChars), metrics));
    const full = boxes.map((box) => box.full);
    const { homes, set } = place(full, ringTotal);
    const fit = settle(homes, set, full, loose);
    return fit ? plan(homes, set, boxes, maxChars, fit, null) : null;
  };
  const lengths = (values: number[]) => values.filter((value) => value <= metrics.maxChars);

  // 1. Every name shown and every agent on its ring, names as long as possible (down to 8
  // characters); a long name keeps its length on one ring fewer before it is shortened.
  for (const maxChars of lengths([metrics.maxChars, 16, 14, 12, 10, 8]))
    for (const ringTotal of ringChoices) {
      const found = allNamed(maxChars, false, ringTotal);
      if (found) return found;
    }

  // 2. Crowded: every agent on its ring with as many of the busiest names as fit there, then any
  // other name that is clear; off the rings only when even the avatars do not fit on them.
  const maxChars = Math.min(metrics.maxChars, 10);
  const boxes = agents.map((agent) => nodeBoxes(text(agent, maxChars), metrics));
  const avatars = boxes.map((box) => box.avatar);
  const pills = boxes.map((box) => box.pill);
  const spaced = avatars.map((box) => ({
    left: box.left - 3,
    right: box.right + 3,
    top: box.top - 3,
    bottom: box.bottom + 3,
  }));
  const roomy = pills.map((box) => ({
    left: box.left - 3,
    right: box.right + 3,
    top: box.top - 3,
    bottom: box.bottom + 3,
  }));
  const rank = new Map(priority.map((node, index) => [node, index]));
  const withNames = (named: number, ringTotal: number) => {
    const mixed = boxes.map((box, i) => (rank.get(i)! < named ? box.full : spaced[i]));
    const { homes, set } = place(mixed, ringTotal);
    return settle(homes, set, mixed, false) ? { homes, set } : null;
  };
  for (const ringTotal of ringChoices) {
    // The most busiest-first names that fit on the rings (a binary search; 0 means avatars only).
    let best = withNames(0, ringTotal);
    if (!best) continue;
    let low = 0;
    let high = Math.min(agents.length - 1, 12);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const found = withNames(middle, ringTotal);
      if (found) {
        best = found;
        low = middle;
      } else high = middle - 1;
    }
    const labels = visibleLabels(best.homes, avatars, roomy, bounds, priority, 0);
    return plan(best.homes, best.set, boxes, maxChars, 'rings', labels);
  }
  // 3. Off the rings only when the agents do not fit on them: every name nudged into place,
  // else the avatars nudged apart and the names that fit.
  for (const maxChars of lengths([metrics.maxChars, 16, 14, 12, 10, 8])) {
    const found = allNamed(maxChars, true);
    if (found) return found;
  }
  let { homes, set } = place(spaced);
  let fit = settle(homes, set, spaced, true);
  if (!fit) {
    ({ homes, set } = place(avatars));
    fit = settle(homes, set, avatars, true);
  }
  const labels = visibleLabels(homes, avatars, roomy, bounds, priority, 0);
  return plan(homes, set, boxes, maxChars, fit ?? 'loose', labels);
}

const rounded = (point: Point): Point => ({
  x: Math.round(point.x * 10) / 10,
  y: Math.round(point.y * 10) / 10,
});

/** The node label: names past `max` characters end in an ellipsis (the full name is the title). */
export function shortName(name: string, max = 18): string {
  const chars = [...name.trim()];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : name.trim();
}
