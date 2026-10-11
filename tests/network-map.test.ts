import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, Connection } from '../shared/types';
import {
  CROSS_OWNER_CAP,
  DESKTOP_METRICS,
  PHONE_METRICS,
  agentRoutes,
  loadApprovedConnections,
  routeIndex,
  externalRoutes,
  isOnline,
  labelWidth,
  mapAgents,
  mapRoutes,
  planMap,
  scaleMetrics,
  shortName,
  statusWord,
} from '../src/network/networkMapModel';
import {
  CALM_MOTION,
  createBodies,
  curvePath,
  curvePoint,
  edgeCurve,
  routeBends,
  snapToRings,
  slideOnRings,
  hashSeed,
  isOverlapFree,
  overlap,
  resolveCollisions,
  ringCount,
  ringLayout,
  seededRandom,
  spreadOnEllipse,
  stepBodies,
} from '../src/network/mapGeometry';

const at = '2026-10-04T12:00:00.000Z';

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
    description: '',
    capability: 'research',
    mode: 'hosted',
    isDemo: false,
    status: 'online',
    lastSeenAt: at,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

function connection(id: string, fromAgentId: string, toAgentId: string): Connection {
  return { id, fromAgentId, toAgentId, createdAt: at };
}

function request(
  id: string,
  direction: 'incoming' | 'outgoing',
  overrides: Partial<ConnectionRequest>,
): ConnectionRequest {
  return {
    id,
    direction,
    status: 'approved',
    from_agent_id: 'x',
    from_agent_name: 'Remote helper',
    from_owner_label: 'Other workspace',
    to_agent_id: 'y',
    to_agent_name: 'Remote reviewer',
    note: '',
    requested_at: at,
    expires_at: at,
    decided_at: at,
    revoked_at: null,
    ...overrides,
  };
}

test('the map shows every agent that is not revoked, in snapshot order', () => {
  const agents = [
    agent('a'),
    agent('b', { status: 'revoked', revokedAt: at }),
    agent('c', { status: 'offline' }),
  ];
  assert.deepEqual(
    mapAgents(agents).map((item) => item.id),
    ['a', 'c'],
  );
});

test('online follows the server status; paused wins in the status word', () => {
  assert.equal(isOnline(agent('a', { status: 'working' })), true);
  assert.equal(isOnline(agent('a', { status: 'offline' })), false);
  assert.equal(statusWord(agent('a')), 'Online');
  assert.equal(statusWord(agent('a', { status: 'offline' })), 'Offline');
  assert.equal(statusWord(agent('a', { status: 'working' })), 'Working');
  assert.equal(statusWord(agent('a', { pausedAt: at })), 'Paused');
});

test('routes keep one edge per direction between visible agents', () => {
  const agents = [agent('a'), agent('b'), agent('c')];
  const routes = mapRoutes(agents, [
    connection('1', 'a', 'b'),
    connection('2', 'a', 'b'), // duplicate direction
    connection('3', 'b', 'a'), // the other direction is its own route
    connection('4', 'a', 'a'), // self
    connection('5', 'a', 'gone'), // removed agent
    connection('6', 'b', 'c'),
  ]);
  assert.deepEqual(
    routes.map((route) => `${route.from}>${route.to}`),
    ['a>b', 'b>a', 'b>c'],
  );
});

test('approved cross-owner requests become routes for this workspace’s agents only', () => {
  const agents = [agent('a'), agent('b')];
  const external = externalRoutes(agents, {
    incoming: [
      request('in-1', 'incoming', { to_agent_id: 'a' }),
      request('in-2', 'incoming', { to_agent_id: 'a', status: 'pending' }),
      request('in-3', 'incoming', { to_agent_id: 'removed' }),
    ],
    outgoing: [
      request('out-1', 'outgoing', { from_agent_id: 'b', to_agent_name: null }),
      request('out-2', 'outgoing', { from_agent_id: 'b', status: 'revoked' }),
    ],
  });
  assert.deepEqual(external, [
    {
      id: 'in-1',
      agentId: 'a',
      direction: 'in',
      otherName: 'Remote helper',
      ownerLabel: 'Other workspace',
    },
    {
      id: 'out-1',
      agentId: 'b',
      direction: 'out',
      otherName: 'An agent',
      ownerLabel: 'Another workspace',
    },
  ]);
  assert.deepEqual(externalRoutes(agents, null), []);
});

test('an agent’s panel lists who it can send work to and receive work from', () => {
  const agents = [agent('a'), agent('b'), agent('c')];
  const routes = mapRoutes(agents, [
    connection('1', 'a', 'b'),
    connection('2', 'c', 'a'),
    connection('3', 'b', 'c'),
  ]);
  const external = externalRoutes(agents, {
    incoming: [request('in-1', 'incoming', { to_agent_id: 'a' })],
    outgoing: [],
  });
  const nameOf = (id: string) => `Agent ${id}`;
  const { sendsTo, receivesFrom } = agentRoutes('a', routes, external, nameOf);
  assert.deepEqual(
    sendsTo.map((chip) => chip.label),
    ['Agent b'],
  );
  assert.deepEqual(
    receivesFrom.map((chip) => [chip.label, chip.ownerLabel]),
    [
      ['Agent c', undefined],
      ['Remote helper', 'Other workspace'],
    ],
  );
  assert.deepEqual(agentRoutes('b', routes, [], nameOf), {
    sendsTo: [{ key: '3', label: 'Agent c', agentId: 'c' }],
    receivesFrom: [{ key: '1', label: 'Agent a', agentId: 'a' }],
  });
});

/* ---------- The force layout and motion ---------- */

const NAMES = [
  'Summary writer',
  'Source reader',
  'Fact checker',
  'Citation finder',
  'Draft editor',
  'Table extractor',
  'Claim reviewer',
  'Outline planner',
  'Quote collector',
  'Style checker',
  'Quarterly report consolidation assistant',
  'Glossary builder',
  'Data cleaner',
  'Link verifier',
  'Topic scout',
  'Figure reader',
  'Tone reviewer',
  'Index maker',
  'Note taker',
  'Final proofreader',
];

function workspace(count: number) {
  const id = (i: number) => `agent-${String(i + 1).padStart(2, '0')}`;
  const agents = Array.from({ length: count }, (_, i) => ({ id: id(i), name: NAMES[i % 20] }));
  const routes =
    count < 2
      ? []
      : [
          ...Array.from({ length: count - 1 }, (_, i) => ({
            id: `r${i}`,
            from: id(i + 1),
            to: id((i + 2) % count),
          })),
          { id: 'x1', from: id(1), to: id(0) },
          { id: 'x2', from: id(0), to: id(2 % count) },
        ].filter((route) => route.from !== route.to);
  return { agents, routes };
}

/** The stage inside the 448 px desktop card and the 376 px phone card. */
const CARDS = [
  { name: 'desktop', width: 1100, height: 390, metrics: DESKTOP_METRICS },
  { name: 'phone', width: 356, height: 318, metrics: PHONE_METRICS },
];

test('the seeded random source and the seed hash are deterministic', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const first = Array.from({ length: 5 }, () => a());
  assert.deepEqual(
    first,
    Array.from({ length: 5 }, () => b()),
  );
  assert.ok(first.every((value) => value >= 0 && value < 1));
  const other = seededRandom(43);
  assert.notDeepEqual(
    first,
    Array.from({ length: 5 }, () => other()),
  );
  assert.equal(hashSeed('agent-01|agent-02'), hashSeed('agent-01|agent-02'));
  assert.notEqual(hashSeed('agent-01|agent-02'), hashSeed('agent-02|agent-01'));
});

test('the layout is deterministic for the same agents and card', () => {
  for (const card of CARDS)
    for (const count of [3, 8, 20]) {
      const { agents, routes } = workspace(count);
      const one = planMap(agents, routes, card.width, card.height, card.metrics);
      const two = planMap(agents, routes, card.width, card.height, card.metrics);
      assert.deepEqual(one, two, `${card.name}, ${count} agents`);
    }
  // The float is seeded too: the same agents drift the same way.
  const homes = [
    { x: 10, y: 10 },
    { x: 90, y: 40 },
  ];
  const a = createBodies(homes, 7);
  const b = createBodies(homes, 7);
  for (let frame = 0; frame < 30; frame++) {
    stepBodies(a, frame / 60, 1 / 60);
    stepBodies(b, frame / 60, 1 / 60);
  }
  assert.deepEqual(a, b);
  assert.notDeepEqual(createBodies(homes, 7), createBodies(homes, 8));
});

test('agents take one ring up to 8, two up to 14 and three up to 40', () => {
  assert.deepEqual(
    [0, 1, 3, 8, 9, 14, 15, 20, 40, 41].map(ringCount),
    [0, 1, 1, 1, 2, 2, 3, 3, 3, 4],
  );
  const frame = { cx: 500, cy: 180, rx: 450, ry: 140 };
  const three = ringLayout(3, frame);
  assert.equal(three.rings.length, 1);
  // The first agent sits at the top of the ring.
  assert.deepEqual([three.positions[0].x, three.positions[0].y], [500, 40]);
  const twenty = ringLayout(20, frame, 2);
  assert.equal(twenty.rings.length, 2);
  assert.equal(twenty.positions.length, 20);
  // The outer ring is the frame; the inner ring is 45% of it and holds fewer agents.
  assert.deepEqual(twenty.rings[1], { rx: 450, ry: 140 });
  assert.ok(Math.abs(twenty.rings[0].rx - 202.5) < 0.01);
  const inner = twenty.positions.filter((position) => position.ring === 0).length;
  assert.ok(inner >= 2 && inner < 10, `${inner} on the inner ring`);
  // Every position lies on its ellipse.
  for (const position of twenty.positions) {
    const ring = twenty.rings[position.ring];
    const value = ((position.x - 500) / ring.rx) ** 2 + ((position.y - 180) / ring.ry) ** 2;
    assert.ok(Math.abs(value - 1) < 0.02, `off its ring: ${value}`);
  }
  assert.equal(ringLayout(30, frame).rings.length, 3);
  assert.deepEqual(ringLayout(1, frame).positions, [{ x: 500, y: 180, ring: 0 }]);
  assert.deepEqual(ringLayout(0, frame).positions, []);
});

test('with a hub the first agent sits in the middle and the rest on three rings', () => {
  const frame = { cx: 500, cy: 180, rx: 450, ry: 140 };
  const twenty = ringLayout(20, frame, undefined, true);
  assert.equal(twenty.rings.length, 3);
  assert.deepEqual(twenty.positions[0], { x: 500, y: 180, ring: -1 });
  const perRing = [0, 1, 2].map((ring) => twenty.positions.filter((p) => p.ring === ring).length);
  assert.equal(
    perRing.reduce((sum, value) => sum + value, 0),
    19,
  );
  assert.ok(perRing[0] < perRing[1] && perRing[1] < perRing[2], perRing.join(', '));
  // Three agents: the hub in the middle, the other two left and right on a wide ring...
  const three = ringLayout(3, frame, undefined, true);
  assert.deepEqual(
    three.positions.map((p) => [p.x, p.y]),
    [
      [500, 180],
      [950, 180],
      [50, 180],
    ],
  );
  // ...and above and below on a tall one (a phone card).
  const tall = ringLayout(3, { cx: 178, cy: 159, rx: 110, ry: 122 }, undefined, true);
  assert.deepEqual(
    tall.positions.map((p) => [p.x, p.y]),
    [
      [178, 159],
      [178, 37],
      [178, 281],
    ],
  );
});

test('the busiest agent takes the middle of the map', () => {
  for (const card of CARDS) {
    const { agents, routes } = workspace(20);
    const plan = planMap(agents, routes, card.width, card.height, card.metrics);
    // Summary writer (agent 1) has the most routes.
    const home = plan.homes[0];
    assert.ok(
      Math.hypot(home.x - plan.center.x, home.y - plan.center.y) < 30,
      `${card.name}: ${home.x},${home.y} vs ${plan.center.x},${plan.center.y}`,
    );
    // Three rings where the names fit on them, else two (a 390 px stage holds few rows).
    assert.ok(plan.rings.length >= 2 && plan.rings.length <= 3, card.name);
  }
});

test('agents sit on their rings: the middle one in the middle, the rest on an ellipse', () => {
  for (const card of CARDS)
    for (const count of [3, 8, 12, 20]) {
      const { agents, routes } = workspace(count);
      const plan = planMap(agents, routes, card.width, card.height, card.metrics);
      const where = `${card.name}, ${count} agents`;
      assert.equal(plan.onRings, true, where);
      plan.homes.forEach((home, i) => {
        const dx = home.x - plan.center.x;
        const dy = home.y - plan.center.y;
        if (Math.hypot(dx, dy) < 0.5) return;
        const fit = plan.rings.some(
          (ring) => Math.abs(Math.hypot(dx / ring.rx, dy / ring.ry) - 1) < 0.02,
        );
        assert.ok(fit, `${where}: node ${i} at ${home.x},${home.y} is on no ring`);
      });
    }
  // On a wide card, a few agents are spaced evenly around their ring.
  const { agents, routes } = workspace(8);
  const plan = planMap(agents, routes, 1100, 390, DESKTOP_METRICS);
  const around = plan.homes
    .filter((home) => Math.hypot(home.x - plan.center.x, home.y - plan.center.y) > 1)
    .map((home) =>
      Math.atan2(
        (home.y - plan.center.y) / plan.rings[0].ry,
        (home.x - plan.center.x) / plan.rings[0].rx,
      ),
    )
    .sort((a, b) => a - b);
  assert.equal(around.length, 7);
});

test('ring snapping turns a ring until its boxes clear the middle node', () => {
  const frame = { cx: 300, cy: 150, rx: 260, ry: 90 };
  const set = ringLayout(5, frame, 1, true);
  const box = { left: -50, right: 50, top: -18, bottom: 40 };
  const boxes = set.positions.map(() => box);
  const bounds = { width: 600, height: 300, padding: 4 };
  const points = snapToRings(set, boxes, bounds, 6);
  assert.ok(points, 'found a turn');
  assert.ok(isOverlapFree(points!, boxes, 6));
  for (const point of points!.slice(1))
    assert.ok(Math.abs(Math.hypot((point.x - 300) / 260, (point.y - 150) / 90) - 1) < 0.02);
  // Too crowded for even spacing: sliding along the ring still keeps every node on it.
  const tight = ringLayout(9, { cx: 300, cy: 150, rx: 260, ry: 100 }, 2, true);
  const slid = slideOnRings(
    tight,
    tight.positions.map(() => ({ left: -40, right: 40, top: -16, bottom: 34 })),
    bounds,
    6,
  );
  if (slid)
    slid.forEach((point, i) => {
      const ring = tight.positions[i].ring;
      if (ring < 0) return;
      const { rx, ry } = tight.rings[ring];
      assert.ok(Math.abs(Math.hypot((point.x - 300) / rx, (point.y - 150) / ry) - 1) < 0.03);
    });
});

test('a route between two agents on the same spot stays a finite path', () => {
  const spot = { x: 120, y: 80 };
  for (const center of [undefined, spot, { x: 0, y: 0 }]) {
    const curve = edgeCurve(spot, { ...spot }, 20, {}, center, 18);
    for (const value of Object.values(curve)) assert.ok(Number.isFinite(value), `${value}`);
    assert.doesNotMatch(curvePath(curve), /NaN/);
  }
  const bends = routeBends([spot, { ...spot }, { x: 300, y: 80 }], [{ from: 0, to: 1 }], 20, 26);
  assert.ok(bends.every(Number.isFinite));
});

test('routes bend around agents in their way, and a two-way pair curves apart', () => {
  // A blocks the straight line from the first node to the second.
  const points = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 200, y: -22 },
  ];
  const [bend] = routeBends(points, [{ from: 0, to: 1 }], 20, 26);
  assert.notEqual(bend, 0);
  const curve = edgeCurve(points[0], points[1], 20, {}, undefined, bend);
  for (let k = 1; k < 16; k++) {
    const at = curvePoint(curve, k / 16);
    assert.ok(Math.hypot(at.x - 200, at.y + 22) >= 26, `passes the agent at t=${k / 16}`);
  }
  // Nothing in the way: no extra bend.
  assert.deepEqual(routeBends(points.slice(0, 2), [{ from: 0, to: 1 }], 20, 26), [0]);
  // A two-way pair bends to the left of each direction, so the two curves sit on opposite sides.
  const pair = routeBends(
    points.slice(0, 2),
    [
      { from: 0, to: 1, pair: true },
      { from: 1, to: 0, pair: true },
    ],
    20,
    26,
  );
  const there = curvePoint(edgeCurve(points[0], points[1], 20, {}, undefined, pair[0]), 0.5);
  const back = curvePoint(edgeCurve(points[1], points[0], 20, {}, undefined, pair[1]), 0.5);
  assert.ok(Math.sign(there.y) !== Math.sign(back.y) && Math.abs(there.y - back.y) > 20);
});

test('points spread evenly along an ellipse', () => {
  const points = spreadOnEllipse({ x: 0, y: 0 }, 300, 100, 8);
  const gaps = points.map((point, i) => {
    const next = points[(i + 1) % points.length];
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
  // Equal arc lengths: neighbouring chords are within a few px of each other.
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 30, gaps.join(', '));
});

test('the rings scale to fit the card and the busiest agents take the inner ring', () => {
  for (const card of CARDS)
    for (const count of [3, 8, 20]) {
      const { agents, routes } = workspace(count);
      const plan = planMap(agents, routes, card.width, card.height, card.metrics);
      const outer = plan.rings[plan.rings.length - 1];
      assert.ok(plan.center.x - outer.rx >= 0 && plan.center.x + outer.rx <= card.width);
      assert.ok(plan.center.y - outer.ry >= 0 && plan.center.y + outer.ry <= card.height);
    }
  const { agents, routes } = workspace(20);
  const plan = planMap(agents, routes, 1100, 390, DESKTOP_METRICS);
  // Summary writer (4 routes) is nearer the centre than a one-route agent on the outer ring.
  const distance = (i: number) =>
    Math.hypot(
      (plan.homes[i].x - plan.center.x) / plan.rings[1].rx,
      (plan.homes[i].y - plan.center.y) / plan.rings[1].ry,
    );
  assert.ok(distance(0) < 0.7, `${distance(0)}`);
});

test('every agent stays inside the card with its avatar and its name', () => {
  for (const card of CARDS)
    for (const count of [1, 2, 3, 8, 12, 20, 30]) {
      const { agents, routes } = workspace(count);
      const plan = planMap(agents, routes, card.width, card.height, card.metrics);
      assert.equal(plan.homes.length, count);
      plan.homes.forEach((home, i) => {
        const box = plan.labels[i]
          ? {
              left: Math.min(plan.avatars[i].left, plan.pills[i].left),
              right: Math.max(plan.avatars[i].right, plan.pills[i].right),
              top: plan.avatars[i].top,
              bottom: plan.pills[i].bottom,
            }
          : plan.avatars[i];
        const where = `${card.name}, ${count} agents, node ${i} at ${home.x},${home.y}`;
        assert.ok(home.x + box.left >= 0 && home.x + box.right <= card.width, where);
        assert.ok(home.y + box.top >= 0 && home.y + box.bottom <= card.height, where);
      });
    }
});

test('no avatars or shown names overlap, with room left for the float', () => {
  for (const card of CARDS)
    for (const count of [2, 3, 8, 12, 20, 30]) {
      const { agents, routes } = workspace(count);
      const plan = planMap(agents, routes, card.width, card.height, card.metrics);
      const where = `${card.name}, ${count} agents`;
      // Avatars (circles) keep apart by more than twice the float radius.
      for (let i = 0; i < count; i++)
        for (let j = i + 1; j < count; j++) {
          const apart = Math.hypot(
            plan.homes[i].x - plan.homes[j].x,
            plan.homes[i].y - plan.homes[j].y,
          );
          assert.ok(
            apart >= card.metrics.avatar + 2 * CALM_MOTION.amplitude,
            `${where}: avatars ${i} and ${j} are ${apart} apart`,
          );
        }
      // Shown names touch neither another name nor another avatar.
      const shown = plan.homes.flatMap((_, i) => (plan.labels[i] ? [i] : []));
      for (const i of shown)
        for (let j = 0; j < count; j++) {
          if (i === j) continue;
          const pill = overlap(plan.homes[i], plan.pills[i], plan.homes[j], plan.avatars[j]);
          assert.ok(pill.x <= 0 || pill.y <= 0, `${where}: name ${i} over avatar ${j}`);
          if (!plan.labels[j]) continue;
          const both = overlap(plan.homes[i], plan.pills[i], plan.homes[j], plan.pills[j]);
          assert.ok(both.x <= 0 || both.y <= 0, `${where}: names ${i} and ${j}`);
        }
    }
});

test('a desktop card shows every name; a crowded phone card shows the names that fit', () => {
  for (const count of [3, 8, 20]) {
    const { agents, routes } = workspace(count);
    const plan = planMap(agents, routes, 1100, 390, DESKTOP_METRICS);
    assert.equal(plan.compact, false);
    assert.ok(plan.labels.every(Boolean));
  }
  const three = workspace(3);
  assert.ok(planMap(three.agents, three.routes, 356, 318, PHONE_METRICS).labels.every(Boolean));
  // A crowded phone card shortens names, then shows only those that fit (all on selection).
  const crowded = workspace(20);
  const plan = planMap(crowded.agents, crowded.routes, 356, 318, PHONE_METRICS);
  assert.equal(plan.compact, true);
  assert.ok(plan.maxChars <= 10);
});

test('collision resolution pushes overlapping boxes apart and keeps a pinned one still', () => {
  const boxes = [
    { left: -10, right: 10, top: -10, bottom: 10 },
    { left: -10, right: 10, top: -10, bottom: 10 },
  ];
  const bounds = { width: 200, height: 200, padding: 0 };
  const points = [
    { x: 100, y: 100 },
    { x: 105, y: 100 },
  ];
  for (let pass = 0; pass < 5; pass++) resolveCollisions(points, boxes, bounds, 4, 0);
  assert.deepEqual(points[0], { x: 100, y: 100 });
  assert.ok(isOverlapFree(points, boxes, 4));
  const loose = [
    { x: 100, y: 100 },
    { x: 100, y: 100 },
  ];
  resolveCollisions(loose, boxes, bounds, 0);
  assert.ok(isOverlapFree(loose, boxes));
});

test('nodes float gently around their homes and spring back after a drag', () => {
  const homes = [
    { x: 100, y: 100 },
    { x: 300, y: 120 },
  ];
  const bodies = createBodies(homes, 1, [false, true]);
  let fastest = 0;
  for (let frame = 0; frame < 600; frame++) {
    fastest = Math.max(fastest, stepBodies(bodies, frame / 60, 1 / 60));
    // The float stays within its radius (plus a little spring lag).
    assert.ok(Math.hypot(bodies[0].x - 100, bodies[0].y - 100) <= CALM_MOTION.amplitude * 1.5);
  }
  // Slow: never faster than a few px per second.
  assert.ok(fastest < 12, `fastest ${fastest}`);
  // The still (offline) node did not move.
  assert.deepEqual([bodies[1].x, bodies[1].y], [300, 120]);
  // Dragged away, it settles back home softly without the float.
  bodies[1].x = 380;
  bodies[1].y = 40;
  const distances: number[] = [];
  for (let frame = 0; frame < 360; frame++) {
    stepBodies(bodies, frame / 60, 1 / 60);
    distances.push(Math.hypot(bodies[1].x - 300, bodies[1].y - 120));
  }
  assert.ok(distances[distances.length - 1] < 1, `${distances[distances.length - 1]} px away`);
  assert.ok(distances[10] > 20, 'it glides, it does not jump');
  // A dragged body stays where the pointer holds it.
  bodies[0].dragging = true;
  bodies[0].x = 10;
  stepBodies(bodies, 0, 1 / 60);
  assert.equal(bodies[0].x, 10);
});

test('an edge curve starts and ends at the avatar edges and bends to its left', () => {
  const curve = edgeCurve({ x: 0, y: 0 }, { x: 200, y: 0 }, 20);
  assert.ok(Math.abs(Math.hypot(curve.sx, curve.sy) - 20) < 0.1);
  assert.ok(Math.abs(Math.hypot(curve.ex - 200, curve.ey) - 20) < 0.1);
  // The reverse route bends the other way, so a two-way pair never overlaps.
  const back = edgeCurve({ x: 200, y: 0 }, { x: 0, y: 0 }, 20);
  assert.ok(curve.cy * back.cy < 0);
  assert.match(curvePath(curve), /^M[\d.-]+ [\d.-]+ Q[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);
  const mid = curvePoint(curve, 0.5);
  assert.ok(mid.x > 99 && mid.x < 101);
});

test('long names end in an ellipsis; short names stay whole', () => {
  assert.equal(shortName('Summary writer'), 'Summary writer');
  const long = shortName('An unusually long agent name for the map');
  assert.equal([...long].length, 18);
  assert.ok(long.endsWith('…'));
  assert.ok(labelWidth(long, DESKTOP_METRICS) <= DESKTOP_METRICS.maxLabel);
});

test('approved connections are paged per direction past pages of pending requests', async () => {
  const queries: string[] = [];
  const pending = Array.from({ length: 100 }, (_, i) =>
    request(`pending-${i}`, 'incoming', { status: 'pending', to_agent_id: 'a' }),
  );
  const { lists, capped } = await loadApprovedConnections(async (query) => {
    queries.push(query);
    const params = new URLSearchParams(query);
    assert.equal(params.get('status'), 'approved');
    assert.equal(params.get('limit'), '100');
    if (params.get('direction') === 'outgoing')
      return { incoming: [], outgoing: [request('out-1', 'outgoing', {})], next_before: null };
    // First page: full of pending requests (an older server ignoring the filter); then approved.
    return params.get('before')
      ? {
          incoming: [request('in-1', 'incoming', { to_agent_id: 'a' })],
          outgoing: [],
          next_before: null,
        }
      : { incoming: pending, outgoing: [], next_before: 'cursor-1' };
  });
  assert.equal(capped, false);
  assert.deepEqual(
    lists.incoming.map((item) => item.id),
    ['in-1'],
  );
  assert.deepEqual(
    lists.outgoing.map((item) => item.id),
    ['out-1'],
  );
  assert.ok(queries.some((query) => query.includes('before=cursor-1')));
});

test('paging stops at the cap and says so', async () => {
  let calls = 0;
  const { lists, capped } = await loadApprovedConnections(async (query) => {
    calls++;
    const direction = new URLSearchParams(query).get('direction') as 'incoming' | 'outgoing';
    const page = Array.from({ length: 100 }, (_, i) =>
      request(`${direction}-${calls}-${i}`, direction, {}),
    );
    return direction === 'incoming'
      ? { incoming: page, outgoing: [], next_before: `c${calls}` }
      : { incoming: [], outgoing: [], next_before: null };
  });
  assert.equal(capped, true);
  assert.equal(lists.incoming.length, CROSS_OWNER_CAP);
  assert.ok(calls <= CROSS_OWNER_CAP / 100 + 1);
});

test('the route index matches the per-agent routes', () => {
  const agents = [agent('a'), agent('b'), agent('c')];
  const routes = mapRoutes(agents, [connection('1', 'a', 'b'), connection('2', 'c', 'a')]);
  const external = externalRoutes(agents, {
    incoming: [],
    outgoing: [request('out-1', 'outgoing', { from_agent_id: 'a' })],
  });
  const nameOf = (id: string) => `Agent ${id}`;
  const index = routeIndex(agents, routes, external, nameOf);
  for (const item of agents)
    assert.deepEqual(index.get(item.id), agentRoutes(item.id, routes, external, nameOf));
  assert.deepEqual(index.get('a')?.sendsTo.at(-1), {
    key: 'out-1',
    label: 'Remote reviewer',
    ownerLabel: 'Another workspace',
  });
});

test('the map scales with the workspace density, names never below 12 px', () => {
  assert.equal(scaleMetrics(DESKTOP_METRICS, 1), DESKTOP_METRICS);
  const small = scaleMetrics(DESKTOP_METRICS, 0.9);
  assert.equal(small.avatar, 32.4);
  assert.equal(small.labelHeight, 18);
  assert.equal(small.maxChars, DESKTOP_METRICS.maxChars);
  // 13 px names become 12 px (not 11.7), so their width shrinks by 12/13.
  assert.ok(Math.abs(small.charWidth - (DESKTOP_METRICS.charWidth * 12) / 13) < 1e-9);
  // A 90% desktop card still fits every name of 20 agents, on rings.
  const { agents, routes } = workspace(20);
  const plan = planMap(agents, routes, 990, 351, small);
  assert.equal(plan.compact, false);
  assert.equal(plan.onRings, true);
});
