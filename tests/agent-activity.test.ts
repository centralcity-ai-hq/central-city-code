import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { runStatus } from '../server/activity.js';

/**
 * My agents' Activity feed (GET /api/agents/:id/activity): one agent's events and runs, newest
 * first and paged, plus a line per confirmed Base registration. Owner only, co-owned AI workspaces
 * via X-City-Workspace. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic activity owner password';
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return app;
}
async function account(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name, password: PASSWORD }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((cookie) => cookie.name === 'cc_session')!.value}`;
}
function call(
  app: App,
  cookie: string,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  workspace?: string,
) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie, ...(workspace ? { 'x-city-workspace': workspace } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function agent(app: App, cookie: string, name: string) {
  const res = await call(app, cookie, 'POST', '/api/agents', {
    name,
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().agent.id as string;
}
const operatorOf = async (app: App, cookie: string) =>
  (await call(app, cookie, 'GET', '/api/snapshot')).json().operator.id as string;
function job(
  requesterId: string,
  providerId: string,
  status: string,
  minutes: number,
  id = randomUUID(),
) {
  return {
    id,
    requesterId,
    providerId,
    capability: 'research',
    input: 'Synthetic input',
    status,
    acceptance: 'pending',
    output: null,
    createdAt: at(minutes),
    updatedAt: at(minutes + 1),
    completedAt: status === 'completed' ? at(minutes + 1) : null,
    acceptedAt: null,
    costCents: 0,
    error: status === 'failed' ? 'Synthetic failure' : null,
    isDemo: false,
    idempotencyKey: randomUUID(),
    requestHash: 'h',
    attempts: 0,
    leaseHash: null,
    leaseExpiresAt: null,
    outputHash: null,
  };
}
const cityEvent = (agentId: string | null, minutes: number, type = 'agent.note') => ({
  id: randomUUID(),
  type,
  message: `Synthetic ${type} at ${minutes}`,
  agentId,
  jobId: null,
  createdAt: at(minutes),
});
/** Replaces the document's jobs and events (synthetic history with known times). */
async function seed(app: App, operatorId: string, jobs: unknown[], events: unknown[]) {
  await app.city.db.query(
    `UPDATE workspaces SET data = jsonb_set(jsonb_set(data, '{jobs}', $2::jsonb), '{events}', $3::jsonb)
      WHERE operator_id=$1`,
    [operatorId, JSON.stringify(jobs), JSON.stringify(events)],
  );
}
async function allPages(app: App, cookie: string, agentId: string, limit: number, ws?: string) {
  const items: any[] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const query = `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const res = await call(
      app,
      cookie,
      'GET',
      `/api/agents/${agentId}/activity?${query}`,
      undefined,
      ws,
    );
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json();
    assert.ok(page.items.length <= limit);
    items.push(...page.items);
    before = page.nextBefore;
    pages++;
  } while (before && pages < 1000);
  return { items, pages };
}

test('run status maps to done / running / failed', () => {
  assert.equal(runStatus('queued'), 'running');
  assert.equal(runStatus('running'), 'running');
  assert.equal(runStatus('completed'), 'done');
  assert.equal(runStatus('failed'), 'failed');
  assert.equal(runStatus('canceled'), 'failed');
});

test('activity: own agent only, newest first, runs with status, role and counterpart', async (t) => {
  const app = await fixture(t);
  const cookie = await account(app, 'Activity owner');
  const scout = await agent(app, cookie, 'Scout');
  const helper = await agent(app, cookie, 'Helper');
  const other = await agent(app, cookie, 'Bystander');
  const operatorId = await operatorOf(app, cookie);
  const done = job(helper, scout, 'completed', 10);
  const queued = job(scout, helper, 'queued', 20);
  const running = job(helper, scout, 'running', 30);
  const failed = job(helper, scout, 'failed', 40);
  const canceled = job(scout, helper, 'canceled', 50);
  const unrelated = job(helper, other, 'completed', 60);
  const note = cityEvent(scout, 5);
  await seed(
    app,
    operatorId,
    [done, queued, running, failed, canceled, unrelated],
    [note, cityEvent(other, 6), cityEvent(null, 7)],
  );

  const res = await call(app, cookie, 'GET', `/api/agents/${scout}/activity`);
  assert.equal(res.statusCode, 200, res.body);
  const page = res.json();
  assert.equal(page.nextBefore, null);
  assert.deepEqual(
    page.items.map((item: any) => [item.kind, item.id, item.status ?? item.type]),
    [
      ['run', canceled.id, 'failed'],
      ['run', failed.id, 'failed'],
      ['run', running.id, 'running'],
      ['run', queued.id, 'running'],
      ['run', done.id, 'done'],
      ['event', note.id, 'agent.note'],
    ],
  );
  assert.deepEqual(page.items[1], {
    kind: 'run',
    id: failed.id,
    at: failed.createdAt,
    updatedAt: failed.updatedAt,
    completedAt: null,
    status: 'failed',
    capability: 'research',
    role: 'provider',
    counterpart: { id: helper, name: 'Helper' },
    error: 'Synthetic failure',
  });
  assert.equal(page.items[0].role, 'requester');
  assert.deepEqual(page.items[5], {
    kind: 'event',
    id: note.id,
    at: note.createdAt,
    type: 'agent.note',
    text: note.message,
    jobId: null,
  });

  // Unknown agent, another workspace, bad input.
  assert.equal(
    (await call(app, cookie, 'GET', `/api/agents/${randomUUID()}/activity`)).statusCode,
    404,
  );
  const stranger = await account(app, 'Activity stranger');
  assert.equal((await call(app, stranger, 'GET', `/api/agents/${scout}/activity`)).statusCode, 404);
  assert.equal(
    (await call(app, cookie, 'GET', `/api/agents/${scout}/activity?before=nonsense`)).statusCode,
    400,
  );
  assert.equal(
    (await call(app, cookie, 'GET', `/api/agents/${scout}/activity?limit=abc`)).statusCode,
    400,
  );
  assert.equal(
    (await call(app, cookie, 'GET', `/api/agents/${scout}/activity?other=1`)).statusCode,
    400,
  );
  const signedOut = await app.inject({
    method: 'GET',
    url: `/api/agents/${scout}/activity`,
    headers: jsonHeaders,
  });
  assert.equal(signedOut.statusCode, 401);
});

test('activity pages with before and reaches past the snapshot window', async (t) => {
  const app = await fixture(t);
  const cookie = await account(app, 'Busy owner');
  const scout = await agent(app, cookie, 'Scout');
  const helper = await agent(app, cookie, 'Helper');
  const operatorId = await operatorOf(app, cookie);
  // 300 events from a busy neighbour after the scout's 120 events: the snapshot's latest 100 hold
  // none of the scout's, the document (1000 kept) holds all of them.
  const own = Array.from({ length: 120 }, (_, i) => cityEvent(scout, i));
  const busy = Array.from({ length: 300 }, (_, i) => cityEvent(helper, 1000 + i));
  // Runs share minutes with events, and three share one time exactly: the order stays total.
  const jobs = [
    ...Array.from({ length: 30 }, (_, i) => job(helper, scout, 'completed', i * 4)),
    ...Array.from({ length: 3 }, () => job(scout, helper, 'running', 200)),
  ];
  await seed(app, operatorId, jobs, [...own, ...busy]);
  const snapshot = (await call(app, cookie, 'GET', '/api/snapshot')).json();
  assert.equal(
    snapshot.events.filter((item: any) => item.agentId === scout).length,
    0,
    'the snapshot window has none of them',
  );

  const { items, pages } = await allPages(app, cookie, scout, 40);
  assert.equal(items.length, 153);
  assert.equal(pages, 4);
  assert.equal(new Set(items.map((item) => `${item.kind}:${item.id}`)).size, 153, 'no duplicates');
  const times = items.map((item) => Date.parse(item.at));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
    'newest first across pages',
  );
  const single = await call(app, cookie, 'GET', `/api/agents/${scout}/activity?limit=100`);
  assert.equal(single.json().items.length, 100, 'a full page of 100');
  const capped = await call(app, cookie, 'GET', `/api/agents/${scout}/activity?limit=500`);
  assert.equal(capped.json().items.length, 100, 'a larger limit is capped at 100');
  const refused = await call(app, cookie, 'GET', `/api/agents/${scout}/activity?limit=1000`);
  assert.equal(refused.statusCode, 400, 'more than three digits is refused');
  const def = await call(app, cookie, 'GET', `/api/agents/${scout}/activity`);
  assert.equal(def.json().items.length, 50, 'default page size');
  // A page boundary inside the three equal-time runs splits them without loss.
  const { items: small } = await allPages(app, cookie, scout, 1);
  assert.deepEqual(
    small.map((item) => item.id),
    items.map((item) => item.id),
  );
});

test('activity in a co-owned AI workspace via X-City-Workspace', async (t) => {
  const app = await fixture(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Activity AI', idempotency_key: randomUUID() }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const { workspace_id: aiId, workspace_key: key, claim_token: claim } = created.json();
  const made = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_create_agent',
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      name: 'AI scout',
      capability: 'research',
      mode: 'hosted',
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(made.statusCode, 200, made.body);
  const scout = made.json().agent.id as string;
  const person = await account(app, 'Co-owner');
  const stranger = await account(app, 'Not a co-owner');
  const url = `/api/agents/${scout}/activity`;
  assert.equal((await call(app, person, 'GET', url, undefined, aiId)).statusCode, 404);
  assert.equal(
    (await call(app, person, 'POST', '/api/workspaces/claim', { claim_token: claim })).statusCode,
    200,
  );
  const res = await call(app, person, 'GET', url, undefined, aiId);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().items.every((item: any) => item.kind === 'event'));
  assert.ok(res.json().items.length > 0, 'the agent creation event is there');
  // Without the header the person acts in their own workspace, which does not hold the agent.
  assert.equal((await call(app, person, 'GET', url)).statusCode, 404);
  assert.equal((await call(app, stranger, 'GET', url, undefined, aiId)).statusCode, 404);
});

test('a confirmed Base registration adds one base.registered line, not before', async (t) => {
  const app = await fixture(t);
  const cookie = await account(app, 'Base owner');
  const scout = await agent(app, cookie, 'Scout');
  const operatorId = await operatorOf(app, cookie);
  await seed(app, operatorId, [], [cityEvent(scout, 0), cityEvent(scout, 100)]);
  const types = async () =>
    (await call(app, cookie, 'GET', `/api/agents/${scout}/activity`))
      .json()
      .items.map((item: any) => item.type);
  await app.city.db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ($1, 84532, $2, '0x8004A818BFB912233c491871b3d84c89A494BD9e', 'u', '0x1', 'pending', $3)`,
    [scout, operatorId, T0 + 10 * 60_000],
  );
  assert.deepEqual(await types(), ['agent.note', 'agent.note'], 'pending is not registered');
  await app.city.db.query(
    `UPDATE base_identities SET state='submitted', provisional_agent_id=4711, updated_at=$2
      WHERE agent_id=$1`,
    [scout, T0 + 20 * 60_000],
  );
  assert.deepEqual(
    await types(),
    ['agent.note', 'agent.note'],
    'a provisional id is not confirmed',
  );
  await app.city.db.query(
    `UPDATE base_identities SET state='confirmed', erc8004_agent_id=4711, handover_id=4711,
       transfer_op_id='identity:transfer:84532:' || agent_id, updated_at=$2 WHERE agent_id=$1`,
    [scout, T0 + 50 * 60_000],
  );
  const items = (await call(app, cookie, 'GET', `/api/agents/${scout}/activity`)).json().items;
  assert.deepEqual(
    items.map((item: any) => item.type),
    ['agent.note', 'base.registered', 'agent.note'],
  );
  assert.deepEqual(items[1], {
    kind: 'event',
    id: 'base.registered:84532',
    at: at(50),
    type: 'base.registered',
    text: 'Registered on Base Sepolia as agent #4711.',
    jobId: null,
  });
  // Another owner's row for the same agent id is never shown.
  const stranger = await account(app, 'Base stranger');
  const strangerId = await operatorOf(app, stranger);
  await app.city.db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, provisional_agent_id, handover_id, transfer_op_id,
       agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ($1, 8453, $2, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', 9, 9, 9,
       'identity:transfer:8453:x', 'u', '0x1', 'confirmed', $3)`,
    [scout, strangerId, T0],
  );
  assert.equal((await types()).filter((type: string) => type === 'base.registered').length, 1);
});
