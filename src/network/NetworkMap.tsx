import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ArrowRight, X } from 'lucide-react';
import { api } from '../api';
import { capabilityLabels } from '../components';
import type { Agent, Connection } from '../../shared/types';
import {
  LIST_FIRST_THRESHOLD,
  CROSS_OWNER_CAP,
  DESKTOP_METRICS,
  PHONE_METRICS,
  loadApprovedConnections,
  routeIndex,
  externalRoutes,
  isOnline,
  labelWidth,
  scaleMetrics,
  mapAgents,
  mapRoutes,
  planMap,
  shortName,
  statusWord,
  type ConnectionLists,
  type RouteChip,
} from './networkMapModel';
import {
  CALM_MOTION,
  clampPoint,
  createBodies,
  curvePath,
  curvePoint,
  edgeCurve,
  hashSeed,
  routeBends,
  stepBodies,
  type Body,
  type Box,
  type Point,
  type Curve,
} from './mapGeometry';
import './network-map.css';

/** Above this many agents on the map, nodes stay still and no particles flow (light mode). */
const MOTION_LIMIT = 60;
/** Below this stage width the map uses phone sizes. */
const PHONE_STAGE = 560;
/** Every agent is a 44 px target (at the workspace's density); the avatar sits in its middle. */
const HIT = 44;
/** Snaps a length to a quarter pixel (exact in the browser's float transform maths). */
const quarter = (value: number) => Math.round(value * 4) / 4;
/**
 * A node's offset for a target of `hit` px (itself a quarter pixel), snapped to a quarter pixel,
 * so a node measures exactly its target size; an offset like 123.45px measured 43.99997.
 */
const nodeOffset = (centre: number, hit: number) => `${quarter(centre - hit / 2)}px`;
/** Space between a node and its popover, and between the popover and the card edge. */
const POP_GAP = 10;
/**
 * On phones the open popover gets its own band: the stage grows by this much at the bottom and
 * the popover sits there, so the agents keep their places and none is hidden under it.
 */
const PHONE_POP_BAND = 126;

type RouteIndex = ReturnType<typeof routeIndex>;

const initial = (name: string) => ([...name.trim()][0] ?? '?').toLocaleUpperCase();

function useReducedMotion(): boolean {
  const query = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [reduced, setReduced] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return reduced;
}

/** A soft glowing dot, drawn once per colour and stamped for every particle. */
function glowSprite(color: string): HTMLCanvasElement {
  const size = 24;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const context = sprite.getContext('2d');
  if (!context) return sprite;
  // The canvas normalises any CSS colour to #rrggbb, which gives the channels for the glow.
  context.fillStyle = '#2563eb';
  context.fillStyle = color;
  const hex = String(context.fillStyle);
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) || 0;
  const rgb =
    hex.startsWith('#') && hex.length === 7
      ? `${channel(1)}, ${channel(3)}, ${channel(5)}`
      : '37, 99, 235';
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, `rgba(${rgb}, 1)`);
  gradient.addColorStop(0.2, `rgba(${rgb}, 0.95)`);
  gradient.addColorStop(0.45, `rgba(${rgb}, 0.32)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return sprite;
}

/** Where a name pill sits relative to its avatar: below it by default, or a placed spot. */
function labelStyle(
  place: { x: number; y: number; anchor: 'center' | 'start' | 'end' } | null,
  maxWidth: number,
  metrics: { avatar: number; labelGap: number },
): CSSProperties {
  if (!place) return { maxWidth, top: metrics.avatar + metrics.labelGap };
  return {
    maxWidth,
    top: place.y,
    left: place.x,
    transform:
      place.anchor === 'center'
        ? 'translateX(-50%)'
        : place.anchor === 'end'
          ? 'translateX(-100%)'
          : 'none',
  };
}

/** A rectangle in stage px. */
type Rect = { left: number; top: number; right: number; bottom: number };

const area = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * Where the popover goes, beside its agent: directly below it first, then to the right, the left
 * and above, each side also tried slid along it. Covering its own agent is ruled out and covering
 * any other agent's avatar is ruled out whenever some spot avoids it; then the fewest names and
 * highlighted routes covered win, and the least slid spot. Clamped inside the stage.
 */
function popoverSpot(
  node: { x: number; y: number },
  pop: { width: number; height: number },
  stage: { width: number; height: number },
  reach: { top: number; bottom: number; side: number },
  avatars: Rect[],
  labels: Rect[],
  routePoints: { x: number; y: number }[],
) {
  const clampTop = (top: number) =>
    Math.max(POP_GAP, Math.min(stage.height - pop.height - POP_GAP, top));
  const clampLeft = (left: number) =>
    Math.max(POP_GAP, Math.min(stage.width - pop.width - POP_GAP, left));
  const own: Rect = {
    left: node.x - reach.side,
    right: node.x + reach.side,
    top: node.y - reach.top,
    bottom: node.y + reach.bottom,
  };
  const below = node.y + reach.bottom + POP_GAP;
  const above = node.y - reach.top - POP_GAP - pop.height;
  const right = node.x + reach.side + POP_GAP;
  const left = node.x - reach.side - POP_GAP - pop.width;
  const middleX = node.x - pop.width / 2;
  const middleY = node.y - pop.height / 2;
  const slides = (half: number, step: number) => {
    const list = [0];
    for (let at = step; at <= half; at += step) list.push(at, -at);
    return list;
  };
  const candidates: { x: number; y: number; slid: number; side: number }[] = [];
  for (const slide of slides(pop.width / 2 + reach.side, 16)) {
    candidates.push({ x: middleX + slide, y: below, slid: Math.abs(slide), side: 0 });
    candidates.push({ x: middleX + slide, y: above, slid: Math.abs(slide), side: 3 });
  }
  for (const slide of slides(pop.height / 2 + reach.top, 12)) {
    candidates.push({ x: right, y: middleY + slide, slid: Math.abs(slide), side: 1 });
    candidates.push({ x: left, y: middleY + slide, slid: Math.abs(slide), side: 2 });
  }
  let best: { spot: { left: number; top: number }; rect: Rect; cost: number } | null = null;
  for (const candidate of candidates) {
    const spot = { left: clampLeft(candidate.x), top: clampTop(candidate.y) };
    const rect = {
      left: spot.left,
      top: spot.top,
      right: spot.left + pop.width,
      bottom: spot.top + pop.height,
    };
    let cost = area(rect, own) * 1e9;
    for (const avatar of avatars) {
      const hit = area(rect, avatar);
      if (hit > 0) cost += 1e7 + hit * 1e3;
    }
    for (const label of labels) cost += area(rect, label);
    for (const point of routePoints)
      if (
        point.x > rect.left &&
        point.x < rect.right &&
        point.y > rect.top &&
        point.y < rect.bottom
      )
        cost += 40;
    cost += candidate.slid * 0.5 + candidate.side * 0.25;
    if (!best || cost < best.cost) best = { spot, rect, cost };
  }
  return best!;
}

/**
 * Network map (Workspace v2 → Advanced workspace → Network map): this workspace's agents on
 * concentric rings that scale to fit a compact card, soft curves for who can send work to whom.
 * Hovering or selecting an agent highlights its routes (particles flow along them), fades the
 * rest and shows a small popover with its routes and two actions. Agents breathe gently and
 * online ones pulse; under prefers-reduced-motion the map is still. Data comes only from the
 * workspace snapshot and the approved cross-owner connections.
 */
export function NetworkMap({
  agents: allAgents,
  connections,
  onOpenAgent,
  onOpenPermissions,
  onOpenAgents,
}: {
  agents: Agent[];
  connections: Connection[];
  onOpenAgent: (id: string) => void;
  onOpenPermissions: () => void;
  onOpenAgents: () => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const agents = useMemo(() => mapAgents(allAgents), [allAgents]);
  const routes = useMemo(() => mapRoutes(agents, connections), [agents, connections]);
  const [lists, setLists] = useState<ConnectionLists | null>(null);
  const [capped, setCapped] = useState(false);
  /** 'failed' shows a small note with Retry instead of silently leaving those routes out. */
  const [crossState, setCrossState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [crossAttempt, setCrossAttempt] = useState(0);
  const external = useMemo(() => externalRoutes(agents, lists), [agents, lists]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mode, setMode] = useState<'map' | 'list'>(
    agents.length > LIST_FIRST_THRESHOLD ? 'list' : 'map',
  );
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** The workspace's density (--ws-px: 0.9 on desktop, 1 on phones), read from the card. */
  const [unit, setUnit] = useState(1);
  const bandRef = useRef(0);
  const reduced = useReducedMotion();
  const light = agents.length > MOTION_LIMIT;
  const animate = !reduced && !light;

  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const popHeading = useRef<HTMLHeadingElement>(null);

  // Approved connections with other owners' agents, paged per direction as the agent
  // inspection tabs read them. Without them the map still shows same-owner routes, and says so.
  useEffect(() => {
    const abort = new AbortController();
    setCrossState('loading');
    loadApprovedConnections((query) =>
      api(`/api/v2/connections/requests?${query}`, undefined, 'GET', abort.signal),
    )
      .then((value) => {
        if (abort.signal.aborted) return;
        setLists(value.lists);
        setCapped(value.capped);
        setCrossState('ready');
      })
      .catch(() => {
        if (!abort.signal.aborted) setCrossState('failed');
      });
    return () => abort.abort();
  }, [crossAttempt]);

  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const indexOf = useMemo(() => new Map(agents.map((agent, i) => [agent.id, i])), [agents]);
  const routesBy = useMemo(
    () => routeIndex(agents, routes, external, (id) => byId.get(id)?.name ?? 'Agent'),
    [agents, routes, external, byId],
  );

  // The stage's size drives the layout; its height is fixed in CSS (taller on desktop).
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || mode !== 'map') return;
    const measure = () => {
      const density = parseFloat(getComputedStyle(element).getPropertyValue('--ws-px'));
      setUnit(density > 0 && density <= 2 ? density : 1);
      setSize((current) => {
        const width = Math.round(element.clientWidth);
        // The map's own height, without a popover band below it.
        const height = Math.round(element.clientHeight) - bandRef.current;
        return current.width === width && current.height === height ? current : { width, height };
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [mode, agents.length > 0]);

  const phone = size.width > 0 && size.width < PHONE_STAGE;
  const metrics = useMemo(
    () => scaleMetrics(phone ? PHONE_METRICS : DESKTOP_METRICS, unit),
    [phone, unit],
  );
  // The target at the workspace's density, on a quarter pixel (39.5 px on desktop, 44 on phones).
  const hit = quarter(HIT * unit);
  const radius = metrics.avatar / 2;
  // On a phone an open popover takes a band added below the map (see PHONE_POP_BAND).
  const band = phone && selectedId ? PHONE_POP_BAND : 0;
  bandRef.current = band;
  const plan = useMemo(
    () =>
      size.width && size.height ? planMap(agents, routes, size.width, size.height, metrics) : null,
    [agents, routes, size.width, size.height, metrics],
  );

  const edges = useMemo(
    () =>
      routes
        .map((route) => ({ route, from: indexOf.get(route.from)!, to: indexOf.get(route.to)! }))
        .filter((edge) => edge.from !== undefined && edge.to !== undefined),
    [routes, indexOf],
  );

  // How far each route bends so it passes no other agent; a two-way pair curves apart.
  const bends = useMemo(() => {
    if (!plan) return [];
    const pairs = new Set(edges.map((edge) => `${edge.from}>${edge.to}`));
    return routeBends(
      plan.homes,
      edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        pair: pairs.has(`${edge.to}>${edge.from}`),
      })),
      radius + 5,
      radius + 8,
      plan.center,
    );
  }, [plan, edges, radius]);

  // Hover previews an agent; a selection holds it. The popover follows the selection first.
  const focusId = hoverId ?? selectedId;
  const popId = selectedId ?? hoverId;
  const related = useMemo(() => {
    if (!focusId) return null;
    const ids = new Set([focusId]);
    const entry = routesBy.get(focusId);
    for (const chip of [...(entry?.sendsTo ?? []), ...(entry?.receivesFrom ?? [])])
      if (chip.agentId) ids.add(chip.agentId);
    return ids;
  }, [focusId, routesBy]);

  // With an agent in focus, its name and the names of the agents it works with show in full
  // (moved sideways to stay inside the card); other names that would touch them step aside.
  const focusLabels = useMemo(() => {
    if (!related || !plan) return null;
    const names = agents.map((agent) =>
      related.has(agent.id) ? agent.name.trim() : shortName(agent.name, plan.maxChars),
    );
    const maxWidth = Math.max(60, size.width - 2 * POP_GAP);
    const r = metrics.avatar / 2;
    const h = metrics.labelHeight;
    const g = metrics.labelGap;
    type Place = { box: Box; x: number; y: number; anchor: 'center' | 'start' | 'end' };
    const absolute = (i: number, box: Box) => ({
      left: plan.homes[i].x + box.left,
      right: plan.homes[i].x + box.right,
      top: plan.homes[i].y + box.top,
      bottom: plan.homes[i].y + box.bottom,
    });
    const avatarRect = (i: number) => absolute(i, plan.avatars[i]);
    // A related name tries below its avatar, then above, right and left, keeping inside the card
    // and clear of the other related names and of every avatar.
    const placeFor = (i: number, width: number): Place[] => {
      const x = plan.homes[i].x;
      const sideways = (left: number) =>
        left < 4 ? 4 - left : left + width > size.width - 4 ? size.width - 4 - (left + width) : 0;
      const places: Place[] = [];
      // Centred below, then above; then beside; then the same, nudged along.
      for (const nudge of [0, width / 2 - r, -(width / 2 - r)]) {
        const shift = sideways(x - width / 2 + nudge) + nudge;
        for (const [top, y] of [
          [r + g, r + r + g],
          [-r - g - h, -g - h],
        ])
          places.push({
            box: { left: -width / 2 + shift, right: width / 2 + shift, top, bottom: top + h },
            x: r + shift,
            y,
            anchor: 'center',
          });
      }
      for (const lift of [0, -h * 0.75, h * 0.75]) {
        places.push({
          box: { left: r + 4, right: r + 4 + width, top: -h / 2 + lift, bottom: h / 2 + lift },
          x: r + r + 4,
          y: r - h / 2 + lift,
          anchor: 'start',
        });
        places.push({
          box: { left: -r - 4 - width, right: -r - 4, top: -h / 2 + lift, bottom: h / 2 + lift },
          x: -4,
          y: r - h / 2 + lift,
          anchor: 'end',
        });
      }
      return places;
    };
    const places: (Place | null)[] = agents.map(() => null);
    const taken: { left: number; right: number; top: number; bottom: number }[] = [];
    const order = agents
      .map((agent, i) => i)
      .filter((i) => related.has(agents[i].id))
      .sort((x, y) => (agents[x].id === focusId ? -1 : agents[y].id === focusId ? 1 : x - y));
    for (const i of order) {
      const width = Math.min(maxWidth, labelWidth(names[i], { ...metrics, maxLabel: maxWidth }));
      let best: Place | null = null;
      let bestCost = Infinity;
      placeFor(i, width).forEach((place, rank) => {
        const at = absolute(i, place.box);
        let cost = rank * 0.1;
        if (at.top < 2 || at.bottom > size.height - 2 || at.left < 2 || at.right > size.width - 2)
          cost += 1e6;
        for (const other of taken) cost += area(at, other) * 10;
        agents.forEach((_, j) => {
          if (j !== i) cost += area(at, avatarRect(j)) * 5;
        });
        if (cost < bestCost) {
          bestCost = cost;
          best = place;
        }
      });
      places[i] = best;
      if (best) taken.push(absolute(i, (best as Place).box));
    }
    const boxes = agents.map((_, i) => places[i]?.box ?? plan.pills[i]);
    // Other names step aside where they would touch a related name or avatar.
    const shown = agents.map((agent, i) => related.has(agent.id) || plan.labels[i]);
    agents.forEach((agent, i) => {
      if (related.has(agent.id) || !shown[i]) return;
      const mine = absolute(i, boxes[i]);
      for (let j = 0; j < agents.length && shown[i]; j++) {
        if (j === i || !related.has(agents[j].id)) continue;
        if (area(mine, absolute(j, boxes[j])) > 0 || area(mine, avatarRect(j)) > 0)
          shown[i] = false;
      }
    });
    return { names, shown, boxes, places, maxWidth };
  }, [related, plan, agents, size.width, size.height, metrics, focusId]);

  /* ---------- The motion engine: refs only, so a frame never re-renders React ---------- */

  const engine = useRef({
    bodies: [] as Body[],
    ids: [] as string[],
    curves: [] as Curve[],
    running: false,
    raf: 0,
    t: 0,
    last: 0,
    inView: true,
    dragging: -1,
    settling: false,
    sprite: null as HTMLCanvasElement | null,
    dpr: 1,
  });
  const live = useRef({
    animate,
    edges,
    bends,
    focusId,
    radius,
    plan,
    size,
    hit,
    shown: mode === 'map',
  });
  live.current = {
    animate,
    edges,
    bends,
    focusId,
    radius,
    plan,
    size,
    hit,
    shown: mode === 'map',
  };

  const draw = useCallback(() => {
    const e = engine.current;
    const {
      edges: list,
      bends: offsets,
      radius: r,
      focusId: focus,
      size: box,
      plan: current,
    } = live.current;
    e.bodies.forEach((body, i) => {
      const element = nodeRefs.current[i];
      if (element)
        element.style.transform = `translate3d(${nodeOffset(body.x, live.current.hit)}, ${nodeOffset(body.y, live.current.hit)}, 0)`;
    });
    if (list.some((edge) => !e.bodies[edge.from] || !e.bodies[edge.to])) return;
    e.curves = list.map((edge, i) => {
      const curve = edgeCurve(
        e.bodies[edge.from],
        e.bodies[edge.to],
        r + 5,
        {
          from: current?.labels[edge.from] ? current.pills[edge.from] : undefined,
          to: current?.labels[edge.to] ? current.pills[edge.to] : undefined,
        },
        current?.center,
        offsets[i] ?? 0,
      );
      pathRefs.current[i]?.setAttribute('d', curvePath(curve));
      return curve;
    });
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    context.setTransform(e.dpr, 0, 0, e.dpr, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    // Particles flow only along the hovered or selected agent's routes, in their direction.
    const sprite = e.sprite;
    if (!live.current.animate || !focus || !sprite) return;
    list.forEach((edge, i) => {
      if (edge.route.from !== focus && edge.route.to !== focus) return;
      const curve = e.curves[i];
      const seed = hashSeed(edge.route.id);
      const duration = 2.4 + ((seed % 1000) / 1000) * 1.2;
      if (Math.hypot(curve.ex - curve.sx, curve.ey - curve.sy) < 8) return;
      for (let k = 0; k < 2; k++) {
        const t = (e.t / duration + k / 2 + (seed % 97) / 97) % 1;
        const point = curvePoint(curve, t);
        context.globalAlpha = Math.sin(Math.PI * t);
        context.drawImage(sprite, point.x - 7, point.y - 7, 14, 14);
      }
    });
    context.globalAlpha = 1;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const e = engine.current;
      if (!live.current.shown) {
        e.running = false;
        section.current?.classList.add('is-paused');
        return;
      }
      const moving = live.current.animate;
      const dt = Math.min(0.05, Math.max(0, (now - e.last) / 1000));
      e.last = now;
      e.t += dt;
      const speed = stepBodies(e.bodies, e.t, dt, {
        ...CALM_MOTION,
        amplitude: moving ? CALM_MOTION.amplitude : 0,
      });
      draw();
      const away = e.bodies.some(
        (body) => Math.abs(body.x - body.hx) > 0.3 || Math.abs(body.y - body.hy) > 0.3,
      );
      e.settling = away || speed > 0.5;
      if (moving || e.dragging >= 0 || e.settling) e.raf = requestAnimationFrame(tick);
      else {
        e.running = false;
        section.current?.classList.add('is-paused');
      }
    },
    [draw],
  );

  const kick = useCallback(() => {
    const e = engine.current;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const wanted = live.current.animate || e.dragging >= 0 || e.settling;
    // Only the map view animates: the list view (and a hidden map) never runs a frame.
    if (!live.current.shown) return;
    if (e.running || !e.inView || hidden || !wanted || !e.bodies.length) return;
    e.running = true;
    e.last = performance.now();
    section.current?.classList.remove('is-paused');
    e.raf = requestAnimationFrame(tick);
  }, [tick]);

  const halt = useCallback(() => {
    const e = engine.current;
    if (e.running) cancelAnimationFrame(e.raf);
    e.running = false;
    section.current?.classList.add('is-paused');
  }, []);

  // New homes (first layout or resize): bodies glide there, or jump when motion is reduced.
  useLayoutEffect(() => {
    const e = engine.current;
    if (!plan) return;
    const ids = agents.map((agent) => agent.id);
    const same = e.ids.length === ids.length && e.ids.every((id, i) => id === ids[i]);
    if (!same) {
      e.bodies = createBodies(
        plan.homes,
        hashSeed(ids.join('|')),
        agents.map((agent) => !isOnline(agent) || Boolean(agent.pausedAt)),
      );
      e.ids = ids;
    } else
      e.bodies.forEach((body, i) => {
        body.hx = plan.homes[i].x;
        body.hy = plan.homes[i].y;
        if (!live.current.animate) {
          body.x = body.hx;
          body.y = body.hy;
          body.vx = 0;
          body.vy = 0;
        }
      });
    e.settling = live.current.animate;
    draw();
    kick();
  }, [plan, agents, draw, kick]);

  // A new focus redraws at once (particles appear or go) even while the loop is paused.
  useEffect(() => {
    if (!engine.current.running) draw();
  }, [focusId, draw]);

  // Theme: the particle colour follows the accent token, in light and dark.
  useEffect(() => {
    const paint = () => {
      const element = section.current;
      if (!element) return;
      const accent = getComputedStyle(element).getPropertyValue('--accent').trim() || '#2563eb';
      engine.current.sprite = glowSprite(accent);
      if (!engine.current.running) draw();
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', paint);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', paint);
    };
  }, [draw]);

  // The canvas matches the stage at the screen's pixel density (at most 2x); it is redrawn when
  // the map view comes back from the list.
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || !size.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    engine.current.dpr = dpr;
    element.width = Math.round(size.width * dpr);
    element.height = Math.round(size.height * dpr);
    draw();
  }, [size, draw, animate, mode]);

  // Pause when the card is offscreen or the tab is hidden; resume when it is back.
  useEffect(() => {
    const element = section.current;
    const onVisibility = () => (document.hidden ? halt() : kick());
    document.addEventListener('visibilitychange', onVisibility);
    const observer =
      element && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            engine.current.inView = entry.isIntersecting;
            if (entry.isIntersecting) kick();
            else halt();
          })
        : null;
    if (element) observer?.observe(element);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      halt();
    };
  }, [kick, halt, mode]);

  // Leaving the map for the list stops the loop and cancels its frame; coming back restarts it.
  useEffect(() => {
    if (mode !== 'map') halt();
  }, [mode, halt]);

  // Motion allowed again (or not): start or stop the loop.
  useEffect(() => {
    if (animate) kick();
    else if (engine.current.dragging < 0) {
      halt();
      const e = engine.current;
      e.bodies.forEach((body) => {
        body.x = body.hx;
        body.y = body.hy;
        body.vx = 0;
        body.vy = 0;
      });
      e.settling = false;
      draw();
    }
  }, [animate, kick, halt, draw]);

  /* ---------- Popover, selection, keyboard and drag ---------- */

  // The popover sits beside its agent, never over another agent when there is room (on a phone
  // the open popover takes the bottom band the map left free); anything still under it is
  // dimmed so it reads as layered, not broken.
  const [underPop, setUnderPop] = useState<string>('');
  const restHomes = useRef<Point[] | null>(null);
  useLayoutEffect(() => {
    const element = popover.current;
    const index = popId ? indexOf.get(popId) : undefined;
    // Homes go back to the plan; an open popover may move a few agents aside below.
    const e = engine.current;
    // Without a plan (no size yet, or the list view) the last plan's homes still undo any move.
    if (plan) restHomes.current = plan.homes;
    const homesMoved = (moved: Map<number, Point>) => {
      const homes = restHomes.current;
      if (!homes || e.bodies.length !== homes.length) return;
      let changed = false;
      e.bodies.forEach((body, i) => {
        const home = moved.get(i) ?? homes[i];
        if (body.hx === home.x && body.hy === home.y) return;
        changed = true;
        body.hx = home.x;
        body.hy = home.y;
        if (!live.current.animate) {
          body.x = home.x;
          body.y = home.y;
          body.vx = 0;
          body.vy = 0;
        }
      });
      if (!changed) return;
      e.settling = live.current.animate;
      if (e.running) return;
      draw();
      kick();
    };
    if (!element || index === undefined || !plan) {
      homesMoved(new Map());
      setUnderPop('');
      return;
    }
    const pad = hit / 2 + CALM_MOTION.amplitude;
    const avatarOf = (i: number): Rect => ({
      left: plan.homes[i].x - pad,
      right: plan.homes[i].x + pad,
      top: plan.homes[i].y - pad,
      bottom: plan.homes[i].y + pad,
    });
    const named = (i: number) => (focusLabels ? focusLabels.shown[i] : plan.labels[i]);
    const labelOf = (i: number): Rect | null => {
      if (!named(i)) return null;
      const pill = plan.pills[i];
      const box = focusLabels?.boxes[i] ?? pill;
      return {
        left: plan.homes[i].x + box.left,
        right: plan.homes[i].x + box.right,
        top: plan.homes[i].y + pill.top,
        bottom: plan.homes[i].y + pill.bottom,
      };
    };
    const others = plan.homes.map((_, i) => i).filter((i) => i !== index);
    const home = plan.homes[index];
    const pop = { width: element.offsetWidth, height: element.offsetHeight };
    let spot: { left: number; top: number };
    let rect: Rect;
    if (phone && popId === selectedId) {
      spot = { left: POP_GAP, top: size.height + band - pop.height - POP_GAP };
      rect = {
        left: spot.left,
        top: spot.top,
        right: spot.left + pop.width,
        bottom: spot.top + pop.height,
      };
    } else {
      // The highlighted routes, sampled, so the popover keeps off them where it can.
      const routePoints = edges.flatMap((edge, i) => {
        if (edge.from !== index && edge.to !== index) return [];
        const curve = edgeCurve(
          plan.homes[edge.from],
          plan.homes[edge.to],
          radius + 5,
          {},
          plan.center,
          bends[i] ?? 0,
        );
        return Array.from({ length: 9 }, (_, k) => curvePoint(curve, (k + 1) / 10));
      });
      ({ spot, rect } = popoverSpot(
        home,
        pop,
        size,
        {
          top: hit / 2,
          bottom: named(index) ? plan.pills[index].bottom : hit / 2,
          side: Math.max(hit / 2, named(index) ? plan.pills[index].right : 0),
        },
        others.map(avatarOf),
        others.map(labelOf).filter((label): label is Rect => label !== null),
        routePoints,
      ));
    }
    element.style.left = `${spot.left}px`;
    element.style.top = `${spot.top}px`;
    // An open popover never hides an agent: one it would still cover steps just outside it (up,
    // down, left or right, whichever is the shortest move that stays in the card) and goes back
    // when the popover closes. A hover preview only dims what is under it.
    const moved = new Map<number, Point>();
    if (popId === selectedId) {
      const grow = (box: Rect, by: number): Rect => ({
        left: box.left - by,
        right: box.right + by,
        top: box.top - by,
        bottom: box.bottom + by,
      });
      const room = grow(rect, 6);
      // Each agent's avatar and shown name around its home.
      const boxOf = (i: number) => {
        const home = plan.homes[i];
        const label = labelOf(i);
        return {
          left: Math.min(-pad, label ? label.left - home.x : -pad),
          right: Math.max(pad, label ? label.right - home.x : pad),
          top: Math.min(-pad, label ? label.top - home.y : -pad),
          bottom: Math.max(pad, label ? label.bottom - home.y : pad),
        };
      };
      const at = (point: Point, box: Rect): Rect => ({
        left: point.x + box.left,
        right: point.x + box.right,
        top: point.y + box.top,
        bottom: point.y + box.bottom,
      });
      const under = others.filter((i) => area(room, at(plan.homes[i], boxOf(i))) > 0);
      const occupied = plan.homes
        .map((home, i) => (under.includes(i) ? null : grow(at(home, boxOf(i)), 3)))
        .filter((box): box is Rect => box !== null);
      for (const i of under) {
        const home = plan.homes[i];
        const box = boxOf(i);
        // Just outside the popover (up, down, left or right), then a little further out, until
        // the spot is clear of every other agent and inside the card.
        let best: { point: Point; cost: number; clash: number } | null = null;
        for (let extra = 0; extra <= 96; extra += 12) {
          for (const point of [
            { x: home.x, y: room.top - box.bottom - extra },
            { x: home.x, y: room.bottom - box.top + extra },
            { x: room.left - box.right - extra, y: home.y },
            { x: room.right - box.left + extra, y: home.y },
          ]) {
            const spot = at(point, box);
            if (
              spot.left < 4 ||
              spot.right > size.width - 4 ||
              spot.top < 4 ||
              spot.bottom > size.height - 4
            )
              continue;
            const clash = occupied.reduce((sum, other) => sum + area(spot, other), 0);
            const cost = clash * 100 + Math.hypot(point.x - home.x, point.y - home.y);
            if (!best || cost < best.cost) best = { point, cost, clash };
          }
          if (best && best.clash === 0) break;
        }
        if (!best) continue;
        moved.set(i, best.point);
        occupied.push(grow(at(best.point, box), 3));
      }
    }
    homesMoved(moved);
    const covered = others
      .filter((i) => {
        if (moved.has(i)) return false;
        return area(rect, avatarOf(i)) > 0 || area(rect, labelOf(i) ?? avatarOf(i)) > 0;
      })
      .map((i) => agents[i].id)
      .join('|');
    setUnderPop(covered);
  }, [
    popId,
    selectedId,
    phone,
    plan,
    size,
    indexOf,
    radius,
    agents,
    edges,
    bends,
    focusLabels,
    draw,
    kick,
    hit,
    band,
  ]);

  useEffect(() => {
    if (selectedId) popHeading.current?.focus({ preventScroll: true });
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && !byId.has(selectedId)) setSelectedId(null);
  }, [byId, selectedId]);

  const close = () => {
    const index = selectedId ? indexOf.get(selectedId) : undefined;
    setSelectedId(null);
    if (index !== undefined) nodeRefs.current[index]?.focus();
  };

  // Esc closes the popover, unless a modal dialog above the page has it.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const select = (id: string) => {
    setHoverId(null);
    setSelectedId((current) => (current === id ? null : id));
  };

  const onNodeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = agents.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    nodeRefs.current[next]?.focus();
  };

  const drag = useRef<{
    index: number;
    pointer: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const stagePoint = (event: ReactPointerEvent) => {
    const rect = stage.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    const body = engine.current.bodies[index];
    if (!body) return;
    const point = stagePoint(event);
    drag.current = {
      index,
      pointer: event.pointerId,
      startX: point.x,
      startY: point.y,
      dx: body.x - point.x,
      dy: body.y - point.y,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const point = stagePoint(event);
    const e = engine.current;
    if (!state.moved) {
      if (Math.hypot(point.x - state.startX, point.y - state.startY) < 5) return;
      state.moved = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      e.dragging = state.index;
      e.bodies[state.index].dragging = true;
      section.current?.classList.add('is-dragging');
    }
    const body = e.bodies[state.index];
    const target = { x: point.x + state.dx, y: point.y + state.dy };
    clampPoint(
      target,
      { left: -radius, right: radius, top: -radius, bottom: radius },
      { width: size.width, height: size.height, padding: 4 },
    );
    body.x = target.x;
    body.y = target.y;
    if (!e.running) {
      kick();
      if (!e.running) draw();
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    if (!state.moved) return;
    suppressClick.current = true;
    const e = engine.current;
    const body = e.bodies[state.index];
    body.dragging = false;
    e.dragging = -1;
    section.current?.classList.remove('is-dragging');
    if (live.current.animate) {
      // It settles back onto its ring softly.
      e.settling = true;
      kick();
    } else {
      // Without motion it simply goes back.
      body.x = body.hx;
      body.y = body.hy;
      draw();
    }
  };

  if (!agents.length)
    return (
      <section className="nm" aria-labelledby={`${uid}-title`}>
        <h2 id={`${uid}-title`} className="visually-hidden">
          Agent map
        </h2>
        <div className="nm-empty" role="status">
          <p className="nm-empty-title">No agents yet.</p>
          <p>Add an agent and it appears here with the agents it can send work to.</p>
          <button type="button" className="button secondary" onClick={onOpenAgents}>
            Go to My agents
          </button>
        </div>
      </section>
    );

  const onlineCount = agents.filter(isOnline).length;
  const routeCount = routes.length + external.length;
  const countText = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} · ${routeCount} ${routeCount === 1 ? 'route' : 'routes'}`;
  const groupLabel = `Agent map: ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}, ${routeCount} ${routeCount === 1 ? 'route' : 'routes'}`;
  const popAgent = popId ? byId.get(popId) : undefined;
  const popRoutes = popAgent ? routesBy.get(popAgent.id) : undefined;
  const interactive = Boolean(popAgent && popAgent.id === selectedId);

  return (
    <section
      ref={section}
      className={`nm${animate ? ' is-animated' : ''} is-paused`}
      aria-labelledby={`${uid}-title`}
      data-agents={agents.length}
      data-motion={animate ? 'on' : 'off'}
    >
      <div className="nm-head">
        <div className="nm-heading">
          <h2 id={`${uid}-title`}>Agent map</h2>
          <p className="nm-meta">
            <span className="nm-count">{countText}</span>{' '}
            <span className="nm-sep" aria-hidden="true">
              ·
            </span>{' '}
            <span
              className="nm-online"
              title="Online means the agent checked in during the last 90 seconds."
            >
              <span className="nm-online-dot" aria-hidden="true" />
              {onlineCount} online
              <span className="visually-hidden"> (checked in during the last 90 seconds)</span>
            </span>
            {capped ? <span className="nm-capped">First {CROSS_OWNER_CAP} connections</span> : null}
          </p>
        </div>
        <div className="nm-actions">
          {agents.length > LIST_FIRST_THRESHOLD ? (
            <div className="nm-segmented" role="group" aria-label="Show agents as">
              {(['map', 'list'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {value === 'map' ? 'Map' : 'List'}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="nm-pill-button"
            aria-label="Agent permissions"
            onClick={onOpenPermissions}
          >
            <span aria-hidden="true">
              <span className="nm-pill-long">Agent permissions</span>
              <span className="nm-pill-short">Permissions</span>
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="nm-body">
        {mode === 'map' ? (
          <div
            ref={stage}
            className={`nm-stage${focusId ? ' has-focus' : ''}`}
            style={
              {
                '--nm-avatar': `${metrics.avatar}px`,
                '--nm-hit': `${hit}px`,
                height: band ? `calc(var(--nm-stage-h) + ${band}px)` : undefined,
              } as CSSProperties
            }
            role="group"
            aria-label={groupLabel}
            data-compact={plan?.compact ? 'true' : 'false'}
            onClick={(event) => {
              if (event.target === event.currentTarget && selectedId) setSelectedId(null);
            }}
          >
            <svg
              className="nm-edges"
              width={size.width}
              height={size.height}
              style={{ height: size.height || undefined }}
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                {(['base', 'hot', 'dim'] as const).map((kind) => (
                  <marker
                    key={kind}
                    id={`${uid}-tip-${kind}`}
                    className={`nm-tip nm-tip-${kind}`}
                    markerWidth="8"
                    markerHeight="8"
                    refX="6"
                    refY="4"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M1,1.2 L6,4 L1,6.8" />
                  </marker>
                ))}
              </defs>
              <g className="nm-rings">
                {plan?.rings.map((ring) => (
                  <ellipse
                    key={`${ring.rx}-${ring.ry}`}
                    cx={plan.center.x}
                    cy={plan.center.y}
                    rx={ring.rx}
                    ry={ring.ry}
                  />
                ))}
              </g>
              {edges.map((edge, i) => {
                const kind = !focusId
                  ? 'base'
                  : edge.route.from === focusId || edge.route.to === focusId
                    ? 'hot'
                    : 'dim';
                return (
                  <path
                    key={edge.route.id}
                    ref={(element) => {
                      pathRefs.current[i] = element;
                    }}
                    className={`nm-route nm-route-${kind}`}
                    data-from={edge.route.from}
                    data-to={edge.route.to}
                    markerEnd={`url(#${uid}-tip-${kind})`}
                  />
                );
              })}
            </svg>
            <canvas
              ref={canvas}
              className="nm-particles"
              aria-hidden="true"
              style={{ height: size.height || undefined }}
            />
            {agents.map((agent, index) => {
              const sends = routesBy.get(agent.id)?.sendsTo.length ?? 0;
              const receives = routesBy.get(agent.id)?.receivesFrom.length ?? 0;
              const state = statusWord(agent);
              const status = agent.pausedAt ? 'paused' : agent.status;
              const home = plan?.homes[index];
              const named = focusLabels ? focusLabels.shown[index] : (plan?.labels[index] ?? true);
              const full = Boolean(focusLabels?.places[index]);
              const label = focusLabels
                ? focusLabels.names[index]
                : shortName(agent.name, plan?.maxChars ?? metrics.maxChars);
              return (
                <button
                  key={agent.id}
                  ref={(element) => {
                    nodeRefs.current[index] = element;
                  }}
                  type="button"
                  className={`nm-node${selectedId === agent.id ? ' is-selected' : ''}${hoverId === agent.id ? ' is-hover' : ''}${related && !related.has(agent.id) ? ' is-dim' : ''}${related?.has(agent.id) ? ' is-related' : ''}${named ? '' : ' is-unnamed'}${underPop && underPop.split('|').includes(agent.id) ? ' is-under-pop' : ''}`}
                  data-agent-id={agent.id}
                  data-status={status}
                  data-capability={agent.capability}
                  data-online={isOnline(agent) && !agent.pausedAt ? 'true' : undefined}
                  style={{
                    width: hit,
                    height: hit,
                    transform: home
                      ? `translate3d(${nodeOffset(home.x, hit)}, ${nodeOffset(home.y, hit)}, 0)`
                      : undefined,
                    visibility: home ? undefined : 'hidden',
                  }}
                  title={agent.name}
                  aria-label={`${agent.name}, ${state}, ${capabilityLabels[agent.capability]}. Can send work to ${sends}, can receive work from ${receives}.`}
                  aria-pressed={selectedId === agent.id}
                  aria-haspopup="dialog"
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    select(agent.id);
                  }}
                  onKeyDown={(event) => onNodeKey(event, index)}
                  onPointerDown={(event) => onPointerDown(event, index)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') setHoverId(agent.id);
                  }}
                  onPointerLeave={() =>
                    setHoverId((current) => (current === agent.id ? null : current))
                  }
                >
                  <span className="nm-lift" aria-hidden="true">
                    <span className="nm-avatar">{initial(agent.name)}</span>
                    <span className="nm-dot" />
                    <span
                      className="nm-label"
                      style={labelStyle(
                        full ? focusLabels!.places[index] : null,
                        full ? focusLabels!.maxWidth : metrics.maxLabel,
                        metrics,
                      )}
                    >
                      <span className="nm-name">{label}</span>
                    </span>
                  </span>
                </button>
              );
            })}
            {popAgent ? (
              <div
                ref={popover}
                key={popAgent.id}
                className={`nm-pop${interactive ? ' is-open' : ''}`}
                role={interactive ? 'dialog' : undefined}
                aria-labelledby={interactive ? `${uid}-pop-name` : undefined}
                aria-hidden={interactive ? undefined : true}
              >
                <div className="nm-pop-head">
                  <div className="nm-pop-title">
                    <h3
                      id={`${uid}-pop-name`}
                      ref={interactive ? popHeading : undefined}
                      tabIndex={-1}
                      title={popAgent.name}
                    >
                      {popAgent.name}
                    </h3>
                    <p className="nm-pop-meta">
                      <span
                        className="nm-status"
                        data-status={popAgent.pausedAt ? 'paused' : popAgent.status}
                      >
                        <span className="nm-status-dot" aria-hidden="true" />
                        {statusWord(popAgent)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{popAgent.mode === 'external' ? 'Connected' : 'Hosted'}</span>
                      <span aria-hidden="true">·</span>
                      <span>{capabilityLabels[popAgent.capability]}</span>
                    </p>
                  </div>
                  {interactive ? (
                    <button
                      type="button"
                      className="nm-pop-close"
                      aria-label={`Close ${popAgent.name}`}
                      onClick={close}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <p className="nm-pop-routes">
                  <span>
                    sends to <strong>{popRoutes?.sendsTo.length ?? 0}</strong>
                  </span>
                  <span aria-hidden="true"> · </span>
                  <span>
                    receives from <strong>{popRoutes?.receivesFrom.length ?? 0}</strong>
                  </span>
                </p>
                {interactive ? (
                  <div className="nm-pop-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => onOpenAgent(popAgent.id)}
                    >
                      Open agent
                    </button>
                    <button type="button" className="button primary" onClick={onOpenPermissions}>
                      Permissions
                    </button>
                  </div>
                ) : (
                  <p className="nm-pop-hint">Click for actions</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {crossState === 'failed' ? (
          <p className={`nm-note${mode === 'map' ? ' is-floating' : ''}`} role="status">
            <span>Couldn't load connections with other workspaces</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => setCrossAttempt((value) => value + 1)}>
              Retry
            </button>
          </p>
        ) : null}

        <AgentRouteList
          agents={agents}
          routesBy={routesBy}
          visible={mode === 'list'}
          onSelect={(id) => {
            setMode('map');
            setSelectedId(id);
          }}
        />
      </div>
    </section>
  );
}

/**
 * The map as text: every agent with its status and routes. Visually hidden under the map (the
 * graph's text alternative); shown as the list view for large workspaces.
 */
function AgentRouteList({
  agents,
  routesBy,
  visible,
  onSelect,
}: {
  agents: Agent[];
  routesBy: RouteIndex;
  visible: boolean;
  onSelect: (id: string) => void;
}) {
  const names = (chips: RouteChip[]) =>
    chips.length
      ? chips
          .map((chip) => (chip.ownerLabel ? `${chip.label} (${chip.ownerLabel})` : chip.label))
          .join(', ')
      : 'none';
  return (
    <div className={visible ? 'nm-list' : 'visually-hidden'}>
      <h3 className={visible ? 'nm-list-title' : undefined}>Agents and routes</h3>
      <ul aria-label="Agents and routes">
        {agents.map((agent) => {
          const { sendsTo, receivesFrom } = routesBy.get(agent.id) ?? {
            sendsTo: [],
            receivesFrom: [],
          };
          const text = `${agent.name}, ${statusWord(agent)}, ${capabilityLabels[agent.capability]}. Can send work to: ${names(sendsTo)}. Can receive work from: ${names(receivesFrom)}.`;
          return (
            <li key={agent.id} data-agent-id={agent.id}>
              {visible ? (
                <button type="button" className="nm-list-row" onClick={() => onSelect(agent.id)}>
                  <span className="nm-list-name">{agent.name}</span>
                  <span className="nm-list-detail">
                    {statusWord(agent)} · {capabilityLabels[agent.capability]} · sends to{' '}
                    {sendsTo.length}, receives from {receivesFrom.length}
                  </span>
                </button>
              ) : (
                text
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
