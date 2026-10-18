import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { NEEDS_YOU_UNCLAIMED_MS, needsYouDismissedMigration } from '../server/rooms/overview.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-needs-you-dismiss-root-not-a-real-secret';

/**
 * Dismissing "Needs you" items (migration 71, POST /api/rooms/:room/needs-you/dismiss) and the
 * person read mark (POST /api/rooms/:room/read): dismissed items leave the queue for that person
 * only, `all` covers the current items and not later ones, nobody dismisses another person's
 * items, a changed task is due again, and mentions a person saw clear. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const MIN = 60_000;
const T0 = Date.now();

let addressCounter = 31;
async function setup(t: { after(fn: () => unknown): void }) {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const time = T0;
  const app: App = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => time });
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
      payload: JSON.stringify({ name: `Rin ${addressCounter}`, password: 'Synthetic password 1' }),
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
      payload: JSON.stringify({ label: 'dismiss tester', scopes: [...ASSISTANT_SCOPES] }),
    });
    assert.equal(minted.statusCode, 201, minted.body);
    const key = minted.json().workspace_key as string;
    /** MCP tool calls with a credential: the workspace key, or an assistant grant. */
    const toolsOf =
      (credential: string) =>
      async (tool: string, args: unknown = {}) => {
        const r = await app.inject({
          method: 'POST',
          url: `/api/assistant/tools/${tool}`,
          headers: { ...jsonHeaders, authorization: `Bearer ${credential}` },
          payload: JSON.stringify(args),
        });
        assert.equal(r.statusCode, 200, `${tool}: ${r.body}`);
        return r.json() as any;
      };
    const ok = toolsOf(key);
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
    return { id, ok, rest, self, agent, toolsOf };
  };
  return { app, tasks, owner, now: () => time };
}
type Owner = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['owner']>>;

async function room(host: Owner, hostAgent: string, name: string) {
  const created = await host.ok('city_create_room', {
    agent_id: hostAgent,
    name,
    history: 'full',
    idempotency_key: randomUUID(),
  });
  return { id: created.room.id as string, link: created.link.link as string };
}
const join = (o: Owner, link: string, agentId: string) =>
  o.ok('city_join_room', { link, agent_id: agentId, idempotency_key: randomUUID() });
const post = async (o: Owner, roomId: string, text: string) =>
  (await o.ok('city_room_post', { room_id: roomId, text, idempotency_key: randomUUID() })).message
    .seq as number;
const queue = async (o: Owner, roomId: string) => {
  const res = await o.rest('GET', `/api/rooms/${roomId}/needs-you`);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { items: any[] }).items;
};
const dismiss = (o: Owner, roomId: string, body: unknown) =>
  o.rest('POST', `/api/rooms/${roomId}/needs-you/dismiss`, body);

test('migration 71 creates needs_you_dismissed with its unique key and index, idempotently', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const versions = listMigrations().map((m) => m.version);
  assert.ok(listMigrations().some((m) => m.version === 71 && m.name === 'needs_you_dismissed'));
  assert.ok(versions.indexOf(64) < versions.indexOf(71));
  const db = app.city.db;
  const indexes = async () =>
    (
      await db.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='needs_you_dismissed' ORDER BY indexname",
      )
    ).rows;
  const before = await indexes();
  assert.deepEqual(
    before.map((row) => row.indexname),
    ['needs_you_dismissed_item', 'needs_you_dismissed_owner'],
  );
  assert.match(before[0]!.indexdef, /UNIQUE.*\(room_id, owner_id, kind, item_id\)/);
  assert.match(before[1]!.indexdef, /\(room_id, owner_id\)/);
  // The SQL is safe to run again (IF NOT EXISTS), and the runner re-applies it after a rollback.
  await db.exec(needsYouDismissedMigration.sql);
  await db.exec('DELETE FROM schema_migrations WHERE version=71');
  assert.deepEqual((await runMigrations(db)).applied, [71]);
  assert.deepEqual(await indexes(), before);
});

test('dismiss: by ids, then all current items; later items still come; per person only', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Dismiss host');
  const b = await f.owner('Dismiss member');
  const x = await f.owner('Dismiss outsider');
  const hostAgent = await a.agent('Host desk');
  const bAgent = await b.agent('Member desk');
  const xAgent = await x.agent('Outsider desk');
  const r = await room(a, hostAgent, 'Dismiss room');
  await join(b, r.link, bAgent);
  for (const n of [1, 2, 3]) await post(b, r.id, `@"Host desk" question ${n}`);
  // The member is asked too, so both have items in the same room.
  await post(a, r.id, '@"Member desk" can you check?');
  let host = await queue(a, r.id);
  assert.deepEqual(
    host.map((i) => i.kind),
    ['mention', 'mention', 'mention'],
  );
  const memberItems = await queue(b, r.id);
  assert.equal(memberItems.length, 1);

  // By id: one goes, two stay.
  const one = await dismiss(a, r.id, { ids: [host[0].id] });
  assert.equal(one.statusCode, 200, one.body);
  assert.deepEqual(one.json(), { room_id: r.id, dismissed: 1, more: false });
  const after = await queue(a, r.id);
  assert.deepEqual(
    after.map((i) => i.id),
    host.slice(1).map((i) => i.id),
  );
  // Again: idempotent, nothing new.
  assert.equal((await dismiss(a, r.id, { ids: [host[0].id] })).json().dismissed, 0);

  // Another person can't dismiss the host's items: they are not in their queue.
  const foreign = await dismiss(b, r.id, { ids: after.map((i) => i.id) });
  assert.equal(foreign.statusCode, 200, foreign.body);
  assert.equal(foreign.json().dismissed, 0);
  assert.equal((await queue(a, r.id)).length, 2);
  // An outsider gets the uniform 404; the member's own item is untouched by the host's calls.
  await join(x, (await room(a, hostAgent, 'Elsewhere')).link, xAgent);
  assert.equal((await dismiss(x, r.id, { all: true })).statusCode, 404);
  assert.deepEqual(
    (await queue(b, r.id)).map((i) => i.id),
    memberItems.map((i) => i.id),
  );

  // Validation: ids or all (not both, not neither), well-formed ids, at most 100.
  for (const body of [
    {},
    { ids: [] },
    { all: false },
    { ids: [host[1].id], all: true },
    { ids: ['<script>'] },
    { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) },
    { ids: 'x' },
  ])
    assert.equal((await dismiss(a, r.id, body)).statusCode, 400, JSON.stringify(body));

  // All: every current item goes; a later mention still shows.
  const all = await dismiss(a, r.id, { all: true });
  assert.equal(all.statusCode, 200, all.body);
  assert.deepEqual(all.json(), { room_id: r.id, dismissed: 2, more: false });
  assert.deepEqual(await queue(a, r.id), []);
  await post(b, r.id, '@"Host desk" one more thing');
  host = await queue(a, r.id);
  assert.equal(host.length, 1);
  assert.match(host[0].excerpt, /one more thing/);
  // The member's queue was never touched.
  assert.equal((await queue(b, r.id)).length, 1);
  // One stored row per dismissed item, for the host only.
  const rows = await f.app.city.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM needs_you_dismissed WHERE room_id=$1 AND owner_id=$2',
    [r.id, a.id],
  );
  assert.equal(rows.rows[0]!.n, 3);
});

test('dismiss: a dismissed task is due again once it changes', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Task host');
  const hostAgent = await a.agent('Host desk');
  const r = await room(a, hostAgent, 'Task room');
  const task = (
    await f.tasks.create(
      { operatorId: a.id, actor: 'the test owner', origin: 'http://localhost' },
      { room_id: r.id, title: 'Nobody took this', idempotency_key: randomUUID() },
    )
  ).task.id as string;
  const backdate = (at: number) =>
    f.app.city.db.query('UPDATE room_tasks SET created_at=$2, updated_at=$2 WHERE id=$1', [
      task,
      at,
    ]);
  await backdate(f.now() - NEEDS_YOU_UNCLAIMED_MS - 10 * MIN);
  const items = await queue(a, r.id);
  assert.deepEqual(
    items.map((i) => [i.kind, i.id]),
    [['task_unclaimed', task]],
  );
  assert.equal((await dismiss(a, r.id, { ids: [task] })).json().dismissed, 1);
  assert.deepEqual(await queue(a, r.id), []);
  // The task changed (and is stale again): it is a new item.
  await backdate(f.now() - NEEDS_YOU_UNCLAIMED_MS - 5 * MIN);
  assert.deepEqual(
    (await queue(a, r.id)).map((i) => i.id),
    [task],
  );
});

test('read mark: a person who saw the room clears the mentions they saw, and only those', async (t) => {
  const f = await setup(t);
  const a = await f.owner('Read host');
  const b = await f.owner('Read person');
  const c = await f.owner('Read agent owner');
  const hostAgent = await a.agent('Host desk');
  const cAgent = await c.agent('Agent desk');
  const r = await room(a, hostAgent, 'Read room');
  await join(c, r.link, cAgent);
  // The person joins from their own account; the same join from the AI workspace's console is
  // refused (404 room_not_found): an invite never adds an AI workspace as a person.
  const mira = { ...b, rest: b.self };
  const fromWorkspace = await b.rest('POST', '/api/rooms/join', {
    link: r.link,
    name: 'Mira',
    idempotency_key: randomUUID(),
  });
  assert.equal(fromWorkspace.statusCode, 404, fromWorkspace.body);
  assert.equal(fromWorkspace.json().code, 'room_not_found');
  const person = await mira.rest('POST', '/api/rooms/join', {
    link: r.link,
    name: 'Mira',
    idempotency_key: randomUUID(),
  });
  assert.equal(person.statusCode, 200, person.body);
  const first = await post(a, r.id, '@Mira welcome');
  const second = await post(a, r.id, '@Mira and the agenda');
  const mentions = await queue(mira, r.id);
  assert.deepEqual(
    mentions.map((i) => [i.kind, i.message_seq]),
    [
      ['mention', first],
      ['mention', second],
    ],
  );

  // The person's wake cursor: the backlog count must fall with every read mark, or it fills.
  const cursor = async () => {
    const row = (
      await f.app.city.db.query<{ unread_count: number; acked_mention_seq: string | number }>(
        `SELECT c.unread_count, c.acked_mention_seq FROM wake_cursors c
           JOIN room_members m ON m.agent_id=c.agent_id
          WHERE m.room_id=$1 AND m.kind='person' AND m.removed_at IS NULL`,
        [r.id],
      )
    ).rows[0]!;
    return [Number(row.unread_count), Number(row.acked_mention_seq)];
  };
  assert.deepEqual(await cursor(), [2, 0]);

  // Seen up to the first: that mention clears, the second still waits.
  const seen = await mira.rest('POST', `/api/rooms/${r.id}/read`, { seq: first });
  assert.equal(seen.statusCode, 200, seen.body);
  assert.deepEqual(seen.json(), { room_id: r.id, last_read_seq: first, mentions_read: 1 });
  assert.deepEqual(await cursor(), [1, 1]);
  assert.deepEqual(
    (await queue(mira, r.id)).map((i) => i.message_seq),
    [second],
  );
  // Never backwards; never past the latest message.
  const back = await mira.rest('POST', `/api/rooms/${r.id}/read`, { seq: 0 });
  assert.equal(back.json().last_read_seq, first);
  const far = await mira.rest('POST', `/api/rooms/${r.id}/read`, { seq: 1_000_000 });
  assert.deepEqual(far.json(), { room_id: r.id, last_read_seq: second, mentions_read: 1 });
  assert.deepEqual(await queue(mira, r.id), []);
  assert.deepEqual(await cursor(), [0, 2]);
  // A repeat mark changes nothing.
  await mira.rest('POST', `/api/rooms/${r.id}/read`, { seq: 1_000_000 });
  assert.deepEqual(await cursor(), [0, 2]);

  // Only the person's own mentions: an AI owner's console has no person row here, and its AI's
  // mention stays for the AI (its wake queue is not touched).
  await post(a, r.id, '@"Agent desk" ping');
  const none = await c.rest('POST', `/api/rooms/${r.id}/read`, { seq: 1_000_000 });
  assert.deepEqual(none.json(), { room_id: r.id, last_read_seq: null, mentions_read: 0 });
  assert.equal((await queue(c, r.id)).length, 1);

  // A new AI the person brings (from her own account, the owner of her person row) still starts
  // at its history start, not at the person's mark.
  const granted = await mira.rest('POST', '/api/assistant-access', {
    label: 'Mira assistant',
    scopes: [...ASSISTANT_SCOPES],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const own = b.toolsOf(granted.json().token as string);
  const bAgent = (
    await own('city_create_agent', {
      name: 'Brought desk',
      description: 'Synthetic member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  await own('city_join_room', { link: r.link, agent_id: bAgent, idempotency_key: randomUUID() });
  const read = await own('city_room_read', { room_id: r.id });
  assert.ok(
    (read.messages as Array<{ seq: number }>).some((m) => m.seq === first),
    'the first read returns the whole visible conversation',
  );

  // Validation and membership.
  assert.equal((await mira.rest('POST', `/api/rooms/${r.id}/read`, { seq: -1 })).statusCode, 400);
  assert.equal((await mira.rest('POST', `/api/rooms/${r.id}/read`, {})).statusCode, 400);
  const x = await f.owner('Read outsider');
  assert.equal((await x.rest('POST', `/api/rooms/${r.id}/read`, { seq: 1 })).statusCode, 404);
});
