import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import {
  NEEDS_YOU_UNCLAIMED_MS,
  checkRoomCounts,
  dayOf,
  decodeNeedsYouCursor,
} from '../server/rooms/overview.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-overview-root-not-a-real-secret';

/**
 * Room overview, messages today and the "Needs you" queue (server/rooms/overview.ts, migration
 * 64): counts equal a scan through joins, leaves, removals and task moves; unread follows the
 * read cursor; the queue holds only the caller's own items in that room; non-members get the
 * uniform 404. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const MIN = 60_000;
// The task service stamps rows with the real clock, so the app clock starts there too.
const T0 = Date.now();

let addressCounter = 11;
async function setup(t: { after(fn: () => unknown): void }) {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  let time = T0;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => time });
  t.after(() => app.close());
  const tasks = createRoomTasks({
    db: app.city.db,
    clock: () => time,
    limit: async () => {},
    secret: 'test-rooms-secret',
  });
  /** An AI workspace with a full-scope key and a signed-in co-owner (console). */
  const owner = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
      remoteAddress: `198.51.${addressCounter++}.20`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().workspace_id as string;
    const person = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: jsonHeaders,
      payload: JSON.stringify({ name: `Dana ${addressCounter}`, password: 'Synthetic password 1' }),
      remoteAddress: `198.51.${addressCounter++}.21`,
    });
    assert.equal(person.statusCode, 201, person.body);
    const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/workspaces/claim',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ claim_token: res.json().claim_token }),
    });
    assert.equal(claimed.statusCode, 200, claimed.body);
    const minted = await app.inject({
      method: 'POST',
      url: '/api/workspace-keys',
      headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
      payload: JSON.stringify({ label: 'overview tester', scopes: [...ASSISTANT_SCOPES] }),
    });
    assert.equal(minted.statusCode, 201, minted.body);
    const key = minted.json().workspace_key as string;
    const tool = (name: string, args: unknown = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/assistant/tools/${name}`,
        headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
        payload: JSON.stringify(args),
      });
    const ok = async (name: string, args: unknown = {}) => {
      const r = await tool(name, args);
      assert.equal(r.statusCode, 200, `${name}: ${r.body}`);
      return r.json() as any;
    };
    const rest = (method: 'GET' | 'POST', url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    /** The signed-in co-owner in their own account (no workspace selected): a person. */
    const self = (method: 'GET' | 'POST', url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { ...jsonHeaders, cookie },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const agent = async (agentName: string) =>
      (
        await ok('city_create_agent', {
          name: agentName,
          description: 'Synthetic member',
          capability: 'research',
          mode: 'external',
          idempotencyKey: randomUUID(),
        })
      ).agent.id as string;
    return { id, tool, ok, rest, self, agent };
  };
  return {
    app,
    tasks,
    owner,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}
const principal = (operatorId: string) => ({
  operatorId,
  actor: 'the test owner',
  origin: 'http://localhost',
});

async function room(
  f: Awaited<ReturnType<typeof setup>>,
  host: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['owner']>>,
  hostAgent: string,
  name: string,
  history: 'full' | 'from_join' = 'full',
) {
  const created = await host.ok('city_create_room', {
    agent_id: hostAgent,
    name,
    history,
    idempotency_key: randomUUID(),
  });
  return { id: created.room.id as string, link: created.link.link as string };
}
const join = (o: { ok: (n: string, a: unknown) => Promise<any> }, link: string, agentId: string) =>
  o.ok('city_join_room', { link, agent_id: agentId, idempotency_key: randomUUID() });
/**
 * `o`'s co-owner joins as a person from their own account. The same join from the AI workspace's
 * console is refused first: an invite never adds an AI workspace as a person (404 room_not_found).
 */
async function joinAsPerson(
  o: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['owner']>>,
  link: string,
  name: string,
) {
  const body = () => ({ link, name, idempotency_key: randomUUID() });
  const fromWorkspace = await o.rest('POST', '/api/rooms/join', body());
  assert.equal(fromWorkspace.statusCode, 404, fromWorkspace.body);
  assert.equal(fromWorkspace.json().code, 'room_not_found');
  const person = await o.self('POST', '/api/rooms/join', body());
  assert.equal(person.statusCode, 200, person.body);
}
const post = (
  o: { ok: (n: string, a: unknown) => Promise<any> },
  roomId: string,
  text: string,
  agentId?: string,
) =>
  o.ok('city_room_post', {
    room_id: roomId,
    text,
    idempotency_key: randomUUID(),
    ...(agentId ? { agent_id: agentId } : {}),
  });

test('overview: kept counts equal a scan through joins, leaves, removals and task moves', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Overview host');
  const b = await f.owner('Overview member');
  const c = await f.owner('Overview third');
  const hostAgent = await a.agent('Host desk');
  const bAgent = await b.agent('Member desk');
  const cAgent = await c.agent('Third desk');
  const r = await room(f, a, hostAgent, 'Overview room');
  await join(b, r.link, bAgent);
  await join(c, r.link, cAgent);
  // A person joins as themselves from the console, in their own account.
  await joinAsPerson(b, r.link, 'Dana');

  let o = await b.ok('city_room_overview', { room_id: r.id });
  assert.deepEqual(o.members, {
    total: 4,
    people: 1,
    ais: 3,
    ais_active_15m: 3,
    ais_active_now: 3,
  });
  assert.deepEqual(o.tasks, { open: 0, claimed: 0, in_review: 0, done: 0 });

  // Tasks: 3 open, one claimed, one in review, one done; one cancelled (not shown).
  const made = [];
  for (const title of ['One', 'Two', 'Three', 'Four', 'Five'])
    made.push(
      (
        await f.tasks.create(principal(a.id), {
          room_id: r.id,
          title,
          idempotency_key: randomUUID(),
        })
      ).task.id as string,
    );
  const claim = async (taskId: string) =>
    (
      await f.tasks.claim(principal(b.id), {
        room_id: r.id,
        task_id: taskId,
        agent_id: bAgent,
        idempotency_key: randomUUID(),
      })
    ).claim_token as string;
  const evidence = { kind: 'proposal', ref: 'proposal-1', revision: 'rev-1' };
  await claim(made[0]!);
  const t2 = await claim(made[1]!);
  await f.tasks.result(principal(b.id), {
    room_id: r.id,
    task_id: made[1]!,
    claim_token: t2,
    evidence,
  });
  const t3 = await claim(made[2]!);
  await f.tasks.result(principal(b.id), {
    room_id: r.id,
    task_id: made[2]!,
    claim_token: t3,
    evidence,
  });
  await f.tasks.update(principal(a.id), { room_id: r.id, task_id: made[2]!, decision: 'approve' });
  await f.tasks.update(principal(a.id), { room_id: r.id, task_id: made[4]!, decision: 'cancel' });
  o = await a.ok('city_room_overview', { room_id: r.id });
  assert.deepEqual(o.tasks, { open: 1, claimed: 1, in_review: 1, done: 1 });

  // Leave and host removal both count down; the counters still equal the scan.
  await c.ok('city_room_leave', { room_id: r.id });
  o = await a.ok('city_room_overview', { room_id: r.id });
  assert.deepEqual(o.members, {
    total: 3,
    people: 1,
    ais: 2,
    ais_active_15m: 2,
    ais_active_now: 2,
  });
  assert.deepEqual(await checkRoomCounts(f.app.city.db), {
    rooms: 0,
    repaired: 0,
    complete: true,
    stopped: null,
  });

  // AIs active in the last 15 minutes: a read keeps one active, the others age out.
  f.advance(16 * MIN);
  await b.ok('city_room_read', { room_id: r.id });
  o = await a.ok('city_room_overview', { room_id: r.id });
  assert.equal(o.members.ais_active_15m, 1);

  // Bounded: with no budget left nothing runs and the result says so.
  assert.deepEqual(await checkRoomCounts(f.app.city.db, { budgetMs: 0 }), {
    rooms: 0,
    repaired: 0,
    complete: false,
    stopped: 'budget_exhausted',
  });
  // Drift is detected and repaired.
  await f.app.city.db.query('UPDATE room_counts SET agents = agents + 5 WHERE room_id=$1', [r.id]);
  assert.deepEqual(await checkRoomCounts(f.app.city.db), {
    rooms: 1,
    repaired: 0,
    complete: false,
    stopped: null,
  });
  assert.deepEqual(await checkRoomCounts(f.app.city.db, { repair: true }), {
    rooms: 1,
    repaired: 1,
    complete: true,
    stopped: null,
  });
  assert.deepEqual(await checkRoomCounts(f.app.city.db), {
    rooms: 0,
    repaired: 0,
    complete: true,
    stopped: null,
  });
});

test('active now: the overview count equals the active entries of the member list', async (t) => {
  // Fixture: Elric, the host's agent, an online AI, an idle AI, a departed AI and a revoked AI,
  // plus a person (people never count as AIs active now).
  const f = await setup(t);
  const a = await f.owner('Active host');
  const b = await f.owner('Active member');
  const c = await f.owner('Active Elric owner');
  const d = await f.owner('Active revoked owner');
  const hostAgent = await a.agent('Host desk');
  const online = await b.agent('Online desk');
  const idle = await b.agent('Idle desk');
  const departed = await b.agent('Departed desk');
  const revoked = await d.agent('Revoked desk');
  const elric = await c.agent('Elric');
  const r = await room(f, a, hostAgent, 'Active room');
  for (const id of [online, idle, departed]) await join(b, r.link, id);
  await join(d, r.link, revoked);
  await join(c, r.link, elric);
  // Elric: the server-set first-party marker, as the Elric service writes it.
  await f.app.city.db.query(
    `INSERT INTO elric_agents(agent_id,owner_id,status,created_at,updated_at,updated_by)
     VALUES($1,$2,'active',$3,$3,'test')`,
    [elric, c.id, f.now()],
  );
  await joinAsPerson(a, r.link, 'Dana');

  // Ten minutes on, every AI reads but the host's and Elric. Ten more minutes:
  // the idle AI is inside the old 15-minute window but not active now; the departed AI leaves
  // and the revoked AI is revoked.
  f.advance(10 * MIN);
  await b.ok('city_room_read', { room_id: r.id });
  await d.ok('city_room_read', { room_id: r.id });
  f.advance(10 * MIN);
  await b.ok('city_room_leave', { room_id: r.id, agent_id: departed });
  assert.equal((await d.rest('POST', `/api/agents/${revoked}/revoke`, {})).statusCode, 200);
  // Connected now: the host's agent and Elric read the room, the online AI posts.
  await a.ok('city_room_read', { room_id: r.id });
  await c.ok('city_room_read', { room_id: r.id });
  await post(b, r.id, 'Still here', online);
  f.advance(4 * MIN); // still inside the 5-minute window for all three

  type Listed = {
    id: string;
    kind: string;
    status: string;
    active_now: boolean;
    auto_reply: { provider: string } | null;
  };
  const listed = async (o: typeof a) => {
    const res = await o.rest('GET', `/api/rooms/${r.id}/members`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().members as Listed[];
  };
  // The host (exact times) and another member (coarse status) see the same entries.
  for (const viewer of [a, b]) {
    const members = await listed(viewer);
    const active = members.filter((m) => m.active_now).map((m) => m.id);
    assert.deepEqual(active.sort(), [hostAgent, online, elric].sort());
    // An AI's status says "active" exactly when it is active now.
    for (const m of members.filter((item) => item.kind !== 'person'))
      assert.equal(m.status === 'active', m.active_now, `${m.id}: ${m.status}`);
    assert.equal(members.find((m) => m.id === idle)?.active_now, false);
    assert.equal(members.find((m) => m.id === elric)?.auto_reply?.provider, 'elric');
    assert.equal(members.filter((m) => m.kind === 'person' && m.active_now).length, 0);
    // Departed and revoked AIs are not listed, and not counted.
    assert.equal(
      members.some((m) => m.id === departed || m.id === revoked),
      false,
    );
    const o = await viewer.ok('city_room_overview', { room_id: r.id });
    assert.equal(o.members.ais_active_now, active.length);
    // The 15-minute count: the three plus the idle AI, without the revoked one.
    assert.equal(o.members.ais_active_15m, active.length + 1);
  }

  // Past the window, all three age out together: count and list.
  f.advance(6 * MIN);
  assert.equal((await listed(a)).filter((m) => m.active_now).length, 0);
  assert.equal((await a.ok('city_room_overview', { room_id: r.id })).members.ais_active_now, 0);
});

test('overview: unread follows the read cursor; mentions until read; console has no cursor', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Unread host');
  const b = await f.owner('Unread member');
  const hostAgent = await a.agent('Host desk');
  const bAgent = await b.agent('Reader desk');
  const r = await room(f, a, hostAgent, 'Unread room');
  await join(b, r.link, bAgent);
  await b.ok('city_room_read', { room_id: r.id });
  let o = await b.ok('city_room_overview', { room_id: r.id });
  assert.equal(o.unread.messages, 0);
  await post(a, r.id, 'First news');
  await post(a, r.id, 'Second news @"Reader desk"');
  await post(a, r.id, 'Third news');
  o = await b.ok('city_room_overview', { room_id: r.id });
  assert.equal(o.unread.messages, 3);
  assert.equal(o.unread.mentions, 1);
  assert.equal(o.unread.mentions_capped, false);
  // The overview marks nothing read.
  assert.equal((await b.ok('city_room_overview', { room_id: r.id })).unread.messages, 3);
  await b.ok('city_room_read', { room_id: r.id });
  o = await b.ok('city_room_overview', { room_id: r.id });
  assert.equal(o.unread.messages, 0);
  // The console keeps no read cursor: null, never a made-up number.
  const consoleView = await b.rest('GET', `/api/rooms/${r.id}/overview`);
  assert.equal(consoleView.statusCode, 200, consoleView.body);
  assert.equal(consoleView.json().unread.messages, null);
  assert.equal(consoleView.json().unread.mentions, 1);
});

test('members: messages today per member, reset on a new UTC day; hidden from others with from_join', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Today host');
  const b = await f.owner('Today member');
  const c = await f.owner('Today late');
  const hostAgent = await a.agent('Host desk');
  const bAgent = await b.agent('Poster desk');
  const cAgent = await c.agent('Late desk');
  const r = await room(f, a, hostAgent, 'Today room', 'from_join');
  await join(b, r.link, bAgent);
  for (let i = 0; i < 3; i++) await post(b, r.id, `Post ${i}`);
  await join(c, r.link, cAgent);
  const members = async (o: { ok: (n: string, a: unknown) => Promise<any> }) =>
    new Map(
      ((await o.ok('city_room_members', { room_id: r.id })).members as any[]).map((m) => [m.id, m]),
    );
  // Host and the member's own owner see the count and the time; a later member sees neither.
  assert.equal((await members(a)).get(bAgent).messages_today, 3);
  assert.equal((await members(b)).get(bAgent).messages_today, 3);
  assert.notEqual((await members(b)).get(bAgent).last_active_at, null);
  assert.equal((await members(c)).get(bAgent).messages_today, null);
  assert.equal((await members(c)).get(bAgent).last_active_at, null);
  assert.equal((await members(a)).get(hostAgent).messages_today, 0);
  // Posts within the throttle window still count (the count is exact; the time is throttled).
  const row = await f.app.city.db.query<{ posts_day: number; posts_today: number }>(
    'SELECT posts_day, posts_today FROM room_members WHERE room_id=$1 AND agent_id=$2',
    [r.id, bAgent],
  );
  assert.deepEqual(row.rows[0], { posts_day: dayOf(f.now()), posts_today: 3 });
  // Next UTC day: 0 until it posts again, then 1.
  f.advance(24 * 60 * MIN);
  assert.equal((await members(a)).get(bAgent).messages_today, 0);
  await post(b, r.id, 'Tomorrow');
  assert.equal((await members(a)).get(bAgent).messages_today, 1);

  // With full history every member sees the count.
  const full = await room(f, a, hostAgent, 'Full room', 'full');
  await join(b, full.link, bAgent);
  await join(c, full.link, cAgent);
  await post(b, full.id, 'Hello');
  const seen = (await c.ok('city_room_members', { room_id: full.id })).members as any[];
  assert.equal(seen.find((m) => m.id === bAgent).messages_today, 1);
});

test('needs you: own reviews, mentions, host approvals and stale tasks, paged; nothing leaks', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Queue host');
  const b = await f.owner('Queue claimer');
  const c = await f.owner('Queue reviewer');
  const x = await f.owner('Queue outsider');
  const hostAgent = await a.agent('Host desk');
  const bAgent = await b.agent('Claimer desk');
  const cAgent = await c.agent('Reviewer desk');
  const xAgent = await x.agent('Outsider desk');
  const r = await room(f, a, hostAgent, 'Queue room');
  const other = await room(f, a, hostAgent, 'Other room');
  await join(b, r.link, bAgent);
  await join(c, r.link, cAgent);
  await join(x, other.link, xAgent);
  await join(c, other.link, cAgent);

  const create = async (roomId: string, title: string) =>
    (
      await f.tasks.create(principal(a.id), {
        room_id: roomId,
        title,
        idempotency_key: randomUUID(),
      })
    ).task.id as string;
  const stale = await create(r.id, 'Nobody took this');
  // Open and untouched for longer than the threshold, on the app clock (backdated directly:
  // console sessions follow the app clock, so the clock itself is not advanced).
  await f.app.city.db.query('UPDATE room_tasks SET created_at=$2, updated_at=$2 WHERE id=$1', [
    stale,
    f.now() - NEEDS_YOU_UNCLAIMED_MS - MIN,
  ]);
  await create(r.id, 'Recent open task');
  const reviewed = await create(r.id, 'Check the totals');
  const token = (
    await f.tasks.claim(principal(b.id), {
      room_id: r.id,
      task_id: reviewed,
      idempotency_key: randomUUID(),
    })
  ).claim_token as string;
  // The reviewer is asked (and @mentioned by that line).
  await f.tasks.requestReview(principal(b.id), {
    room_id: r.id,
    task_id: reviewed,
    reviewer_agent_id: cAgent,
  });
  await f.tasks.result(principal(b.id), {
    room_id: r.id,
    task_id: reviewed,
    claim_token: token,
    evidence: { kind: 'proposal', ref: 'proposal-2', revision: 'rev-2' },
  });
  await post(b, r.id, '@"Reviewer desk" please look');
  // Activity in the other room must never show up here.
  await post(x, other.id, '@"Reviewer desk" other room');
  await create(other.id, 'Other room task');

  const page = async (o: typeof a, query = '') => {
    const res = await o.rest('GET', `/api/rooms/${r.id}/needs-you${query}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { room_id: string; items: any[]; next_cursor?: string };
  };
  // Elric approvals waiting on the host owner: this room's, unexpired, pending only.
  const pending = (id: string, roomId: string, status: string, expires: number) =>
    f.app.city.db.query(
      `INSERT INTO elric_pending_actions(id,owner_id,agent_id,room_id,tool,args,args_hash,status,expires_at,created_at)
       VALUES($1,$2,$3,$4,'room_task_create',$5::jsonb,'hash-0001',$6,$7,$8)`,
      [
        id,
        a.id,
        hostAgent,
        roomId,
        JSON.stringify({ title: 'Draft plan' }),
        status,
        expires,
        f.now(),
      ],
    );
  await pending('pending-1', r.id, 'pending', f.now() + 60 * MIN);
  await pending('pending-2', other.id, 'pending', f.now() + 60 * MIN);
  await pending('pending-3', r.id, 'approved', f.now() + 60 * MIN);
  await pending('pending-4', r.id, 'pending', f.now() - 1);
  const host = await page(a);
  assert.deepEqual(host.items[0], {
    kind: 'approval',
    id: 'pending-1',
    since: new Date(f.now()).toISOString(),
    approval: {
      tool: 'room_task_create',
      summary: 'Draft plan',
      args_hash: 'hash-0001',
      expires_at: new Date(f.now() + 60 * MIN).toISOString(),
    },
  });
  host.items.shift();
  assert.deepEqual(
    host.items.map((i) => [i.kind, i.task?.id]),
    [
      ['task_to_review', reviewed],
      ['task_unclaimed', stale],
    ],
  );
  const reviewer = await page(c);
  assert.deepEqual(
    reviewer.items.map((i) => i.kind),
    ['review_request', 'mention', 'mention'],
  );
  assert.equal(reviewer.items[0].task.id, reviewed);
  assert.equal(reviewer.items[0].agent_id, cAgent);
  assert.ok(reviewer.items.every((i) => i.kind !== 'mention' || i.agent_id === cAgent));
  assert.ok(!JSON.stringify(reviewer).includes('other room'));
  // The claimer has nothing waiting on it.
  assert.deepEqual((await page(b)).items, []);

  // Paging: one item per page, in the same order, then no cursor.
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const next = await page(c, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    assert.ok(next.items.length <= 1);
    seen.push(...next.items.map((i) => i.id));
    cursor = next.next_cursor;
    if (cursor) assert.ok(decodeNeedsYouCursor(cursor));
  } while (cursor);
  assert.deepEqual(
    seen,
    reviewer.items.map((i) => i.id),
  );
  assert.equal(
    (await c.rest('GET', `/api/rooms/${r.id}/needs-you?cursor=AAAAAAAAAAAA`)).statusCode,
    400,
  );

  // A muted member gets no review requests (it cannot review); mentions stay.
  const muted = await a.rest('POST', `/api/rooms/${r.id}/mute`, { agent_id: cAgent, muted: true });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.deepEqual(
    (await page(c)).items.map((i) => i.kind),
    ['mention', 'mention'],
  );
});

test('permissions: non-members get the uniform 404; an invite guest sees members but has no overview tool', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Perm host');
  const b = await f.owner('Perm member');
  const x = await f.owner('Perm outsider');
  const hostAgent = await a.agent('Host desk');
  const bAgent = await b.agent('Member desk');
  await x.agent('Outsider desk');
  const r = await room(f, a, hostAgent, 'Perm room');
  await join(b, r.link, bAgent);
  for (const path of ['overview', 'needs-you']) {
    const outsider = await x.rest('GET', `/api/rooms/${r.id}/${path}`);
    assert.equal(outsider.statusCode, 404, outsider.body);
    assert.match(outsider.body, /room_not_found/);
  }
  const tool = await x.tool('city_room_overview', { room_id: r.id });
  assert.notEqual(tool.statusCode, 200);
  assert.match(tool.body, /room_not_found/);
  // After leaving, the member is out too.
  await b.ok('city_room_leave', { room_id: r.id });
  assert.equal((await b.rest('GET', `/api/rooms/${r.id}/overview`)).statusCode, 404);
  // An unknown room id answers the same.
  assert.equal((await a.rest('GET', `/api/rooms/${randomUUID()}/overview`)).statusCode, 404);

  // An AI invited without an account (room credential): members with messages_today as the
  // members rule allows; the overview is not one of its tools.
  const link = await a.rest('POST', '/api/links', { target: 'room', room_id: r.id });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const anon = (url: string, body: unknown, extra = {}) =>
    f.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: '203.0.113.77',
    });
  const start = await anon('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const redeemed = await anon('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name: 'Invited desk',
  });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  const bearer = { authorization: `Bearer ${redeemed.json().credential}` };
  await post(a, r.id, 'Hello invited desk');
  const listed = await anon('/api/public/invites/tools/city_room_members', {}, bearer);
  assert.equal(listed.statusCode, 200, listed.body);
  const hostRow = (listed.json().members as any[]).find((m) => m.id === hostAgent);
  assert.equal(hostRow.messages_today, 1); // history 'full'
  assert.equal(hostRow.last_active_at, null);
  const refused = await anon('/api/public/invites/tools/city_room_overview', {}, bearer);
  assert.notEqual(refused.statusCode, 200);
});
