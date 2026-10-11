/*
 * Network map geometry: concentric rings that scale to fit the card, overlap checks, the gentle
 * float that keeps the map alive, and the soft route curves. Pure and deterministic (a seeded
 * random source), no dependencies.
 */

/** A node's collision box relative to its centre (the avatar centre), in px. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A small, fast, seeded random source (mulberry32). Returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from text (FNV-1a), so the same agents always get the same layout. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface Bounds {
  width: number;
  height: number;
  /** Space kept clear between every box and the card edge. */
  padding: number;
}

/** Keeps a node's box inside the bounds. When the box is larger than the space, it is centred. */
export function clampPoint(point: Point, box: Box, bounds: Bounds): void {
  const minX = bounds.padding - box.left;
  const maxX = bounds.width - bounds.padding - box.right;
  const minY = bounds.padding - box.top;
  const maxY = bounds.height - bounds.padding - box.bottom;
  point.x = minX > maxX ? (minX + maxX) / 2 : Math.min(maxX, Math.max(minX, point.x));
  point.y = minY > maxY ? (minY + maxY) / 2 : Math.min(maxY, Math.max(minY, point.y));
}

/** How far two boxes overlap on each axis, counting `gap` as part of each box. */
export function overlap(
  a: Point,
  boxA: Box,
  b: Point,
  boxB: Box,
  gap = 0,
): { x: number; y: number } {
  const x =
    Math.min(a.x + boxA.right, b.x + boxB.right) - Math.max(a.x + boxA.left, b.x + boxB.left) + gap;
  const y =
    Math.min(a.y + boxA.bottom, b.y + boxB.bottom) - Math.max(a.y + boxA.top, b.y + boxB.top) + gap;
  return { x, y };
}

/**
 * One pass of hard collision resolution: every overlapping pair is pushed apart along the axis
 * that needs the smaller move. A pinned node (the one being dragged) never moves; the other takes
 * the whole push. Returns how many pairs overlapped.
 */
export function resolveCollisions(
  points: Point[],
  boxes: Box[],
  bounds: Bounds,
  gap: number,
  pinned = -1,
): number {
  let hits = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const { x, y } = overlap(a, boxes[i], b, boxes[j], gap);
      if (x <= 0 || y <= 0) continue;
      hits++;
      const shareA = i === pinned ? 0 : j === pinned ? 1 : 0.5;
      const shareB = 1 - shareA;
      if (x < y) {
        const sign = a.x < b.x || (a.x === b.x && i < j) ? -1 : 1;
        a.x += sign * x * shareA;
        b.x -= sign * x * shareB;
      } else {
        const sign = a.y < b.y || (a.y === b.y && i < j) ? -1 : 1;
        a.y += sign * y * shareA;
        b.y -= sign * y * shareB;
      }
      if (i !== pinned) clampPoint(a, boxes[i], bounds);
      if (j !== pinned) clampPoint(b, boxes[j], bounds);
    }
  return hits;
}

/** True when no two boxes overlap (with `gap` between them). */
export function isOverlapFree(points: Point[], boxes: Box[], gap = 0): boolean {
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const { x, y } = overlap(points[i], boxes[i], points[j], boxes[j], gap);
      if (x > 1e-6 && y > 1e-6) return false;
    }
  return true;
}

/* ---------- Rings: agents on concentric rings that scale to fit the card ---------- */

/** The ellipse the outermost ring may use, in px. */
export interface RingFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface RingSet {
  center: Point;
  /** Every ring in use, inner first. */
  rings: { rx: number; ry: number }[];
  /** One position per node, in input order (ring -1 is the middle). */
  positions: (Point & { ring: number })[];
}

/**
 * How many rings `count` agents use (from three agents on, the busiest sits in the middle): one
 * up to 8, two up to 14, three up to 40, then four.
 */
export function ringCount(count: number): number {
  if (count <= 0) return 0;
  if (count <= 8) return 1;
  if (count <= 14) return 2;
  if (count <= 40) return 3;
  return 4;
}

/**
 * Places `count` nodes on concentric rings (ellipses, so a wide card is used well), the inner
 * ring at 45% of the outer. With `hub`, the first node sits in the middle (from three nodes on)
 * and the rest go on the rings. Each ring gets nodes in proportion to its length, spread at equal
 * distances along it, starting at the top; every other ring turns half a step so nodes do not
 * line up radially, and two nodes alone on one ring sit side by side. A single node sits in
 * the middle.
 */
export function ringLayout(
  count: number,
  frame: RingFrame,
  ringTotal?: number,
  hub = false,
): RingSet {
  const center = { x: frame.cx, y: frame.cy };
  const all = Math.max(0, Math.floor(count));
  if (all === 0) return { center, rings: [], positions: [] };
  if (all === 1) return { center, rings: [], positions: [{ x: frame.cx, y: frame.cy, ring: 0 }] };
  const middle = hub && all >= 3;
  const n = middle ? all - 1 : all;
  const k = Math.max(1, Math.min(ringTotal ?? ringCount(all), Math.floor(n / 2)));
  // Around a hub the inner ring is wider (55%), so its agents clear the one in the middle.
  const inner = middle ? 0.55 : 0.45;
  const scales = Array.from({ length: k }, (_, i) =>
    k === 1 ? 1 : inner + ((1 - inner) * i) / (k - 1),
  );
  const rings = scales.map((scale) => ({ rx: frame.rx * scale, ry: frame.ry * scale }));
  // Nodes per ring by length (largest remainder), at least two per ring.
  const total = scales.reduce((sum, scale) => sum + scale, 0);
  const exact = scales.map((scale) => (n * scale) / total);
  const counts = exact.map((value) => Math.max(2, Math.floor(value)));
  let left = n - counts.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, i) => ({ i, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || b.i - a.i);
  for (let step = 0; left > 0; step++, left--) counts[order[step % k].i]++;
  for (let i = 0; left < 0; i = (i + 1) % k)
    if (counts[i] > 2) {
      counts[i]--;
      left++;
    }
  const positions: RingSet['positions'] = middle ? [{ x: frame.cx, y: frame.cy, ring: -1 }] : [];
  rings.forEach((ring, index) => {
    // Two nodes alone on a ring sit left and right on a wide ring, above and below on a tall one.
    if (k === 1 && counts[index] === 2) {
      const wide = ring.rx >= ring.ry;
      for (const side of [1, -1])
        positions.push({
          x: round(center.x + (wide ? side * ring.rx : 0)),
          y: round(center.y + (wide ? 0 : -side * ring.ry)),
          ring: index,
        });
      return;
    }
    const turn = index % 2 ? 0.5 : 0;
    for (const point of spreadOnEllipse(center, ring.rx, ring.ry, counts[index], turn))
      positions.push({ ...point, ring: index });
  });
  return { center, rings, positions };
}

/** `count` points at equal distances along an ellipse, the first at the top (shifted by `turn` steps). */
export function spreadOnEllipse(
  center: Point,
  rx: number,
  ry: number,
  count: number,
  turn = 0,
): Point[] {
  const samples = 720;
  const lengths = new Float64Array(samples + 1);
  const at = (i: number) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / samples;
    return { x: center.x + Math.cos(angle) * rx, y: center.y + Math.sin(angle) * ry };
  };
  let previous = at(0);
  for (let i = 1; i <= samples; i++) {
    const point = at(i);
    lengths[i] = lengths[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  const total = lengths[samples] || 1;
  const points: Point[] = [];
  let cursor = 0;
  for (let j = 0; j < count; j++) {
    const target = (((j + turn) / count) % 1) * total;
    while (cursor < samples && lengths[cursor + 1] < target) cursor++;
    if (lengths[cursor] > target) cursor = 0;
    while (cursor < samples && lengths[cursor + 1] < target) cursor++;
    const span = lengths[cursor + 1] - lengths[cursor] || 1;
    const t = (target - lengths[cursor]) / span;
    const a = at(cursor);
    const b = at(cursor + 1);
    points.push({ x: round(a.x + (b.x - a.x) * t), y: round(a.y + (b.y - a.y) * t) });
  }
  return points;
}

/**
 * Nudges nodes apart until no two boxes overlap (with `gap`), keeping them inside the bounds.
 * Ring positions move only where they would otherwise touch. Returns true when overlap-free.
 */
export function relax(points: Point[], boxes: Box[], bounds: Bounds, gap: number): boolean {
  for (let pass = 0; pass < 240; pass++)
    if (!resolveCollisions(points, boxes, bounds, gap)) return true;
  return isOverlapFree(points, boxes, gap);
}

/**
 * Which name pills to show when not all fit: in priority order, a pill shows when it stays inside
 * the card and clear of every avatar and every pill already shown. Returns one flag per node.
 */
export function visibleLabels(
  points: Point[],
  avatars: Box[],
  labels: Box[],
  bounds: Bounds,
  priority: readonly number[],
  gap = 4,
): boolean[] {
  const shown = new Array<boolean>(points.length).fill(false);
  const placed: number[] = [];
  for (const node of priority) {
    const point = points[node];
    const box = labels[node];
    if (
      point.x + box.left < 0 ||
      point.x + box.right > bounds.width ||
      point.y + box.top < 0 ||
      point.y + box.bottom > bounds.height
    )
      continue;
    let clear = true;
    for (let other = 0; other < points.length && clear; other++) {
      if (other === node) continue;
      const hit = overlap(point, box, points[other], avatars[other], gap);
      if (hit.x > 0 && hit.y > 0) clear = false;
    }
    for (const other of placed) {
      if (!clear) break;
      const hit = overlap(point, box, points[other], labels[other], gap);
      if (hit.x > 0 && hit.y > 0) clear = false;
    }
    if (clear) {
      shown[node] = true;
      placed.push(node);
    }
  }
  return shown;
}

/* ---------- Motion: a slow float around each home, springy after a drag ---------- */

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Home position on its ring. */
  hx: number;
  hy: number;
  /** Float phase and pace, seeded per node. */
  phase: number;
  pace: number;
  /** 0 keeps the node still (offline agents); 1 floats it fully. */
  float: number;
  dragging: boolean;
}

export function createBodies(
  homes: readonly Point[],
  seed: number,
  still: readonly boolean[] = [],
) {
  const random = seededRandom(seed ^ 0x9e3779b9);
  return homes.map<Body>((home, index) => ({
    x: home.x,
    y: home.y,
    vx: 0,
    vy: 0,
    hx: home.x,
    hy: home.y,
    phase: random() * Math.PI * 2,
    pace: 0.75 + random() * 0.5,
    float: still[index] ? 0 : 1,
    dragging: false,
  }));
}

export interface MotionOptions {
  /** Float radius in px. */
  amplitude: number;
  /** Spring stiffness (1/s²) and damping (1/s). */
  stiffness: number;
  damping: number;
}

export const CALM_MOTION: MotionOptions = { amplitude: 2.5, stiffness: 9, damping: 4.2 };

/**
 * Advances every body by `dt` seconds at time `t`: each one follows a slow Lissajous drift around
 * its home on a damped spring (low velocity, no bounce), dragged bodies stay under the pointer.
 * Returns the largest speed, so a caller can stop animating once everything rests.
 */
export function stepBodies(bodies: Body[], t: number, dt: number, options = CALM_MOTION): number {
  let fastest = 0;
  for (const body of bodies) {
    if (body.dragging) {
      body.vx = 0;
      body.vy = 0;
      continue;
    }
    const a = options.amplitude * body.float;
    const tx = body.hx + a * Math.sin(t * 0.55 * body.pace + body.phase);
    const ty = body.hy + a * Math.cos(t * 0.42 * body.pace + body.phase * 1.7);
    const ax = options.stiffness * (tx - body.x) - options.damping * body.vx;
    const ay = options.stiffness * (ty - body.y) - options.damping * body.vy;
    body.vx += ax * dt;
    body.vy += ay * dt;
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    fastest = Math.max(fastest, Math.hypot(body.vx, body.vy));
  }
  return fastest;
}

/* ---------- Edges: soft curves between avatar edges ---------- */

export interface Curve {
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  ex: number;
  ey: number;
}

/**
 * A gentle quadratic curve from `a` to `b`, trimmed to start and end `trim` px from the centres
 * (and clear of name pills). With a `center` it bows towards it, as routes across rings do. It
 * always leans to the left of its direction, so the two routes of a two-way pair never overlap.
 */
export function edgeCurve(
  a: Point,
  b: Point,
  trim: number,
  pills: { from?: Box; to?: Box } = {},
  center?: Point,
  offset = 0,
): Curve {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  // On rings the curve bows towards the centre; a small lean to the left keeps a two-way pair apart.
  // `offset` adds a bend (px, to the left of the direction) that keeps the route off other agents.
  const lean = (center ? Math.min(14, length * 0.06) : Math.min(48, length * 0.14)) + offset;
  const bx = center ? center.x + (mx - center.x) * 0.55 : mx;
  const by = center ? center.y + (my - center.y) * 0.55 : my;
  const cx = bx + (dy / length) * lean;
  const cy = by - (dx / length) * lean;
  const d1 = Math.hypot(cx - a.x, cy - a.y) || 1;
  const d2 = Math.hypot(b.x - cx, b.y - cy) || 1;
  // A route that would leave or arrive under a name pill stops clear of it.
  const s1 = pills.from ? clearance(cx - a.x, cy - a.y, pills.from, trim) : trim;
  const s2 = pills.to ? clearance(cx - b.x, cy - b.y, pills.to, trim) : trim;
  const t1 = Math.min(s1, d1 * 0.45);
  const t2 = Math.min(s2, d2 * 0.45);
  return {
    sx: a.x + ((cx - a.x) / d1) * t1,
    sy: a.y + ((cy - a.y) / d1) * t1,
    cx,
    cy,
    ex: b.x - ((b.x - cx) / d2) * t2,
    ey: b.y - ((b.y - cy) / d2) * t2,
  };
}

/**
 * How far from a node centre a line along (dx, dy) must start so it clears both the avatar
 * (`radius`) and the name pill `box` (relative to the centre).
 */
export function clearance(dx: number, dy: number, box: Box, radius: number): number {
  const length = Math.hypot(dx, dy);
  if (!length) return radius;
  const ux = dx / length;
  const uy = dy / length;
  const slab = (u: number, low: number, high: number): [number, number] => {
    if (Math.abs(u) < 1e-9) return low <= 0 && high >= 0 ? [-Infinity, Infinity] : [1, 0];
    const p = low / u;
    const q = high / u;
    return p < q ? [p, q] : [q, p];
  };
  const [x0, x1] = slab(ux, box.left, box.right);
  const [y0, y1] = slab(uy, box.top, box.bottom);
  const enter = Math.max(x0, y0);
  const exit = Math.min(x1, y1);
  if (exit < Math.max(enter, 0)) return radius;
  return Math.max(radius, exit + 4);
}

/**
 * The extra bend for every route (see `edgeCurve`'s `offset`) so it passes no other agent within
 * `clear` px of its centre. Routes that have a return route bend at least `pairBend` to their
 * left, so the two directions curve apart; other routes try no bend first, then growing bends to
 * either side, and keep the one that stays furthest from other agents if none is clear.
 */
export function routeBends(
  points: readonly Point[],
  edges: readonly { from: number; to: number; pair?: boolean }[],
  trim: number,
  clear: number,
  center?: Point,
  pairBend = 18,
): number[] {
  const steps = [0, 14, 28, 44, 62, 84, 110, 140];
  return edges.map((edge) => {
    const a = points[edge.from];
    const b = points[edge.to];
    if (!a || !b) return 0;
    const tries = edge.pair
      ? steps.map((step) => pairBend + step)
      : steps.flatMap((step) => (step ? [step, -step] : [0]));
    let best = tries[0];
    let bestGap = -Infinity;
    for (const offset of tries) {
      const curve = edgeCurve(a, b, trim, {}, center, offset);
      let gap = Infinity;
      for (let k = 1; k < 16; k++) {
        const at = curvePoint(curve, k / 16);
        points.forEach((point, i) => {
          if (i === edge.from || i === edge.to) return;
          gap = Math.min(gap, Math.hypot(point.x - at.x, point.y - at.y));
        });
      }
      if (gap >= clear) return offset;
      if (gap > bestGap) {
        bestGap = gap;
        best = offset;
      }
    }
    return best;
  });
}

/**
 * Puts the nodes back onto their rings, evenly spaced, turning each ring (inner first) until no
 * box overlaps another (with `gap`) and all stay inside the bounds. `boxes` follow the order of
 * `set.positions`. Returns null when some ring finds no clear turn.
 */
export function snapToRings(
  set: RingSet,
  boxes: readonly Box[],
  bounds: Bounds,
  gap: number,
  phases = 24,
): Point[] | null {
  const points: Point[] = set.positions.map((position) => ({ x: position.x, y: position.y }));
  const inside = (point: Point, box: Box) =>
    point.x + box.left >= bounds.padding - 1e-6 &&
    point.x + box.right <= bounds.width - bounds.padding + 1e-6 &&
    point.y + box.top >= bounds.padding - 1e-6 &&
    point.y + box.bottom <= bounds.height - bounds.padding + 1e-6;
  const hub = set.positions.flatMap((position, i) => (position.ring < 0 ? [i] : []));
  const rings = set.rings.map((_, ring) =>
    set.positions.flatMap((position, i) => (position.ring === ring ? [i] : [])),
  );
  // Every turn a ring may take: the usual one first, then the ones nearest to it.
  const options = rings.map((members, ring) => {
    const { rx, ry } = set.rings[ring];
    const base = ring % 2 ? 0.5 : 0;
    return Array.from({ length: members.length ? phases : 0 }, (_, step) => {
      if (step === 0) return members.map((i) => set.positions[i]);
      const shift = (step % 2 ? 1 : -1) * Math.ceil(step / 2);
      return spreadOnEllipse(set.center, rx, ry, members.length, base + shift / phases);
    });
  });
  let budget = 1500;
  const placed = [...hub];
  // Rings inner first; a ring that finds no clear turn sends the one inside it to its next turn.
  const solve = (ring: number): boolean => {
    if (ring === rings.length) return true;
    const members = rings[ring];
    if (!members.length) return solve(ring + 1);
    for (const candidate of options[ring]) {
      if (--budget < 0) return false;
      const ok = members.every((index, k) => {
        const point = candidate[k];
        if (!inside(point, boxes[index])) return false;
        for (const other of placed)
          if (isOverlapPair(point, boxes[index], points[other], boxes[other], gap)) return false;
        for (let j = 0; j < k; j++)
          if (isOverlapPair(point, boxes[index], candidate[j], boxes[members[j]], gap))
            return false;
        return true;
      });
      if (!ok) continue;
      members.forEach((index, k) => {
        points[index] = { x: candidate[k].x, y: candidate[k].y };
      });
      placed.push(...members);
      if (solve(ring + 1)) return true;
      placed.length -= members.length;
    }
    return false;
  };
  return solve(0) ? points : null;
}

/**
 * When even spacing does not fit: every node stays on its ring but may slide along it, up to half
 * the space between neighbours, to the nearest spot where its box is clear (rings inner first,
 * each ring tried at a few turns). `boxes` follow the order of `set.positions`. Returns the
 * points, or null when some node finds no clear spot.
 */
export function slideOnRings(
  set: RingSet,
  boxes: readonly Box[],
  bounds: Bounds,
  gap: number,
  phases = 12,
): Point[] | null {
  const points: Point[] = set.positions.map((position) => ({ x: position.x, y: position.y }));
  const inside = (point: Point, box: Box) =>
    point.x + box.left >= bounds.padding - 1e-6 &&
    point.x + box.right <= bounds.width - bounds.padding + 1e-6 &&
    point.y + box.top >= bounds.padding - 1e-6 &&
    point.y + box.bottom <= bounds.height - bounds.padding + 1e-6;
  const placed = set.positions.flatMap((position, i) => (position.ring < 0 ? [i] : []));
  for (let ring = 0; ring < set.rings.length; ring++) {
    const members = set.positions.flatMap((position, i) => (position.ring === ring ? [i] : []));
    const n = members.length;
    if (!n) continue;
    const { rx, ry } = set.rings[ring];
    // A fine table of points along the ring by arc length.
    const fine = 48 * n;
    const table = spreadOnEllipse(set.center, rx, ry, fine, 0);
    const base = ring % 2 ? 0.5 : 0;
    let found: Point[] | null = null;
    for (let step = 0; step < phases && !found; step++) {
      const turn = base + step / phases;
      const spots: Point[] = [];
      for (let k = 0; k < n && spots.length === k; k++) {
        const index = members[k];
        const home = Math.round((k + turn) * 48);
        for (let slide = 0; slide <= 24; slide++) {
          let hit: Point | null = null;
          for (const sign of slide ? [1, -1] : [1]) {
            const point = table[(((home + sign * slide) % fine) + fine) % fine];
            if (!inside(point, boxes[index])) continue;
            let clear = true;
            for (const other of placed)
              if (isOverlapPair(point, boxes[index], points[other], boxes[other], gap)) {
                clear = false;
                break;
              }
            for (let j = 0; j < k && clear; j++)
              if (isOverlapPair(point, boxes[index], spots[j], boxes[members[j]], gap))
                clear = false;
            if (clear) {
              hit = point;
              break;
            }
          }
          if (hit) {
            spots.push(hit);
            break;
          }
        }
      }
      if (spots.length === n) found = spots;
    }
    if (!found) return null;
    members.forEach((index, k) => {
      points[index] = { x: found![k].x, y: found![k].y };
      placed.push(index);
    });
  }
  return points;
}

function isOverlapPair(a: Point, boxA: Box, b: Point, boxB: Box, gap: number) {
  const { x, y } = overlap(a, boxA, b, boxB, gap);
  return x > 1e-6 && y > 1e-6;
}

export function curvePath(curve: Curve): string {
  return `M${round(curve.sx)} ${round(curve.sy)} Q${round(curve.cx)} ${round(curve.cy)} ${round(curve.ex)} ${round(curve.ey)}`;
}

/** The point at `t` (0..1) along a curve. */
export function curvePoint(curve: Curve, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * curve.sx + 2 * u * t * curve.cx + t * t * curve.ex,
    y: u * u * curve.sy + 2 * u * t * curve.cy + t * t * curve.ey,
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
