import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import {
  iso,
  ownerAgent,
  publicAgent,
  publicJob,
  publicWorkflow,
  type StoredAgent,
  type Workspace,
} from '../server/model.js';
import { AGENT_PAGES } from '../shared/agent-pages.js';
import type { AgentListPage, Operator, Snapshot } from '../shared/types.js';

/*
 * Paged owner agent lists (shared/agent-pages.ts), Phase 0 of moving agents out of the workspace
 * document. Up to 500 agents the snapshot and city_workspace answer byte for byte as before; above
 * that they answer one page, newest first, with the total, and GET /api/agents pages and searches
 * the whole workspace with a stable cursor. Synthetic agents seeded into the document directly.
 */

type App = Awaited<ReturnType<typeof createApp>>;
const now = 1_800_000_000_000;
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const password = 'Synthetic paged lists password';

/** The snapshot exactly as main computed it before paging (server/model.ts at 492e2934). */
function legacySnapshot(workspace: Workspace, operator: Operator, time: number): Snapshot {
  const agents = workspace.agents.map((agent) => ownerAgent(agent, workspace.jobs, time));
  return {
    operator,
    paused: workspace.paused,
    agents,
    connections: workspace.connections,
    jobs: workspace.jobs.slice(-50).reverse().map(publicJob),
    workflows: (workspace.workflows ?? []).slice().reverse().map(publicWorkflow),
    events: workspace.events.slice(-100).reverse(),
    stats: {
      registered: agents.length,
      reachable: agents.filter((agent) => agent.status === 'online' || agent.status === 'working')
        .length,
      working: agents.filter((agent) => agent.status === 'working').length,
      accepted: workspace.jobs.filter((job) => job.acceptance === 'accepted').length,
      operatorAccounts: 1,
    },
    serverTime: iso(time),
  };
}

interface Fixture {
  app: App;
  cookie: string;
  operator: Operator;
  token: string;
  stored: () => Promise<Workspace>;
  /** Replaces the agents after the three example agents with `size` synthetic ones. */
  seed: (size: number) => Promise<StoredAgent[]>;
  get: (url: string) => Promise<{ statusCode: number; body: string; json: () => any }>;
  tool: (name: string, body?: unknown) => Promise<{ statusCode: number; json: () => any }>;
  /** Moves the app clock (it starts at `now`). */
  setTime: (time: number) => void;
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }): Promise<Fixture> {
  let time = now;
  const app = await createApp({
    dataDir: ':memory:',
    now: () => time,
    startWorkers: false,
    limits: { agentsPerWorkspace: 100_000, apiRequestsPerMinute: 100_000 },
  });
  t.after(() => app.close());
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Paged owner', password }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const operator = registered.json().operator as Operator;
  const post = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, cookie },
      payload: JSON.stringify(body),
    });
  const grant = await post('/api/assistant-access', {
    label: 'Synthetic client',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(grant.statusCode, 201, grant.body);
  // Three example agents with a connection, a job and events, so the snapshot has all of it.
  assert.equal((await post('/api/demo/start', {})).statusCode, 200);
  await app.city.tick();
  const created = await post('/api/agents', {
    name: 'Template agent',
    description: 'Synthetic template.',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(created.statusCode, 201, created.body);
  const db = app.city.db;
  const stored = async () =>
    (
      await db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operator.id,
      ])
    ).rows[0]!.data;
  const base = await stored();
  const examples = base.agents.filter((agent) => agent.mode === 'hosted');
  const template = base.agents.find((agent) => agent.mode === 'external')!;
  async function seed(size: number) {
    const data = await stored();
    const made: StoredAgent[] = [];
    for (let index = 0; index < size; index++) {
      // Every third pair shares a createdAt, so ties are ordered by id.
      const createdAt = iso(now - 10_000_000 + Math.floor(index / 2) * 1000);
      made.push({
        ...template,
        id: randomUUID(),
        name: `Synthetic agent ${String(index).padStart(5, '0')}`,
        description: index % 97 === 0 ? 'Reads harbour filings.' : 'Synthetic agent.',
        createdAt,
        // Some checked in during the presence window (online), the rest never did.
        lastSeenAt: index % 5 === 0 ? iso(now - 10_000) : null,
        revokedAt: index % 41 === 0 ? iso(now - 1000) : null,
        pausedAt: index % 13 === 0 ? iso(now - 1000) : null,
        parentAgentId: index > 0 && index % 50 === 0 ? made[index - 50]!.id : null,
        depth: index > 0 && index % 50 === 0 ? 1 : 0,
      });
    }
    data.agents = [...examples, ...made];
    await db.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
      operator.id,
      JSON.stringify(data),
    ]);
    return made;
  }
  return {
    app,
    cookie,
    operator: { id: operator.id, name: operator.name },
    token: grant.json().token as string,
    stored,
    seed,
    setTime: (next) => {
      time = next;
    },
    get: (url) => app.inject({ method: 'GET', url, headers: { cookie } }),
    tool: (name, body = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/assistant/tools/${name}`,
        headers: { ...headers, authorization: `Bearer ${grant.json().token as string}` },
        payload: JSON.stringify(body),
      }),
  };
}

/** Newest first: createdAt, then id, both descending. */
const newestFirst = (a: StoredAgent, b: StoredAgent) =>
  a.createdAt !== b.createdAt
    ? a.createdAt < b.createdAt
      ? 1
      : -1
    : a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0;

test('up to 500 agents the snapshot and city_workspace answer byte for byte as before', async (t) => {
  const f = await fixture(t);
  await f.seed(AGENT_PAGES.threshold - 3);
  const workspace = await f.stored();
  assert.equal(workspace.agents.length, AGENT_PAGES.threshold);
  const expected = JSON.stringify(legacySnapshot(workspace, f.operator, now));
  const plain = await f.get('/api/snapshot');
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal(plain.body, expected);
  // include= changes nothing for a workspace the snapshot carries whole.
  const included = await f.get(`/api/snapshot?include=${workspace.agents[7]!.id}`);
  assert.equal(included.body, expected);
  assert.equal('agentsPage' in plain.json(), false);

  const read = await f.tool('city_workspace');
  assert.equal(read.statusCode, 200);
  const after = await f.stored();
  assert.deepEqual(read.json(), {
    operator: f.operator,
    agents: after.agents.map((agent) => publicAgent(agent, after.jobs, now)),
    connections: after.connections.map(({ id, fromAgentId, toAgentId, createdAt }) => ({
      id,
      fromAgentId,
      toAgentId,
      createdAt,
    })),
    paused: false,
  });
  assert.equal(
    JSON.stringify(Object.keys(read.json())),
    JSON.stringify(['operator', 'agents', 'connections', 'paused']),
  );
});

test('above 500 agents the snapshot carries one page, newest first, with totals over all agents', async (t) => {
  const f = await fixture(t);
  await f.seed(1234);
  const workspace = await f.stored();
  const all = workspace.agents;
  const res = await f.get('/api/snapshot');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as Snapshot;
  const legacy = legacySnapshot(workspace, f.operator, now);
  const page = body.agentsPage!;
  assert.deepEqual(
    { ...page, nextCursor: typeof page.nextCursor },
    {
      total: all.length,
      live: legacy.agents.filter((agent) => !agent.revokedAt).length,
      online: legacy.agents.filter(
        (agent) =>
          !agent.revokedAt &&
          !agent.pausedAt &&
          (agent.status === 'online' || agent.status === 'working'),
      ).length,
      limit: AGENT_PAGES.size,
      count: AGENT_PAGES.size,
      nextCursor: 'string',
    },
  );
  // The page: the 100 newest, exactly as the full snapshot shows each of them.
  const newest = [...all].sort(newestFirst).slice(0, AGENT_PAGES.size);
  const byId = new Map(legacy.agents.map((agent) => [agent.id, agent]));
  assert.deepEqual(
    body.agents.slice(0, page.count),
    newest.map((agent) => byId.get(agent.id)),
  );
  // The rest are agents the snapshot names (the examples' job, connection and events), never
  // more than the related bound, and never one of the page again.
  const rest = body.agents.slice(page.count);
  assert.ok(rest.length <= AGENT_PAGES.related);
  const pageIds = new Set(newest.map((agent) => agent.id));
  for (const agent of rest) {
    assert.equal(pageIds.has(agent.id), false);
    assert.deepEqual(agent, byId.get(agent.id));
  }
  for (const job of body.jobs) {
    assert.ok(body.agents.some((agent) => agent.id === job.requesterId));
    assert.ok(body.agents.some((agent) => agent.id === job.providerId));
  }
  for (const connection of body.connections) {
    assert.ok(body.agents.some((agent) => agent.id === connection.fromAgentId));
    assert.ok(body.agents.some((agent) => agent.id === connection.toAgentId));
  }
  // Everything else is the full snapshot's, and the stats still count every agent.
  const { agents: _a, agentsPage: _p, ...others } = body;
  const { agents: _b, ...expectedOthers } = legacy;
  assert.deepEqual(others, expectedOthers);
  assert.equal(body.stats.registered, all.length);
  // Far smaller than the whole list.
  assert.ok(res.body.length * 5 < JSON.stringify(legacy).length);
});

test('include= puts an older agent, its parent, its sub-agents and its connections in a paged snapshot', async (t) => {
  const f = await fixture(t);
  const made = await f.seed(1200);
  // Agent 50 is under agent 0, agent 100 under 50, … (all old: off the first page).
  const target = made[50]!;
  const parent = made[0]!;
  const child = made[100]!;
  const body = (await f.get(`/api/snapshot?include=${target.id}`)).json() as Snapshot;
  const ids = new Set(body.agents.map((agent) => agent.id));
  for (const agent of [target, parent, child]) assert.ok(ids.has(agent.id), agent.name);
  assert.equal(body.agentsPage!.count, AGENT_PAGES.size);
  assert.equal(
    body.agents.slice(0, body.agentsPage!.count).some((agent) => agent.id === target.id),
    false,
  );
  assert.equal((await f.get('/api/snapshot?include=not-an-id')).statusCode, 400);
  const many = Array.from({ length: AGENT_PAGES.include + 1 }, () => randomUUID()).join(',');
  assert.equal((await f.get(`/api/snapshot?include=${many}`)).statusCode, 400);
});

test('GET /api/agents pages through every agent once, and a new agent never shifts a later page', async (t) => {
  const f = await fixture(t);
  await f.seed(1100);
  const expected = [...(await f.stored()).agents].sort(newestFirst).map((agent) => agent.id);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await f.get(`/api/agents?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json() as AgentListPage;
    assert.equal(page.total, expected.length + (pages > 1 ? 1 : 0));
    assert.equal(page.limit, 200);
    seen.push(...page.agents.map((agent) => agent.id));
    cursor = page.nextCursor;
    pages += 1;
    if (pages === 2) {
      f.setTime(now + 60_000);
      // An agent created between two pages is newer than every page: the next pages do not move.
      const created = await f.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: { ...headers, cookie: f.cookie },
        payload: JSON.stringify({
          name: 'Late agent',
          description: 'Synthetic.',
          capability: 'verify',
          mode: 'external',
        }),
      });
      assert.equal(created.statusCode, 201, created.body);
    }
  } while (cursor);
  assert.equal(pages, Math.ceil(expected.length / 200));
  assert.deepEqual(seen, expected);
  // The default page and the bounds.
  const first = (await f.get('/api/agents')).json() as AgentListPage;
  assert.equal(first.agents.length, AGENT_PAGES.size);
  assert.equal(first.agents[0]!.name, 'Late agent');
  assert.equal(first.agents[0]!.credentialHint !== undefined, true);
  for (const url of [
    '/api/agents?limit=0',
    `/api/agents?limit=${AGENT_PAGES.max + 1}`,
    '/api/agents?cursor=bm90LWEtY3Vyc29y',
    '/api/agents?unknown=1',
  ])
    assert.equal((await f.get(url)).statusCode, 400, url);
  // Owner only.
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/agents' })).statusCode, 401);
});

test('GET /api/agents searches the whole workspace and reads named agents and sub-agents', async (t) => {
  const f = await fixture(t);
  const made = await f.seed(1000);
  const matches = made.filter((agent) => agent.description === 'Reads harbour filings.');
  const found = (await f.get('/api/agents?q=HARBOUR%20filings')).json() as AgentListPage;
  assert.equal(found.matched, matches.length);
  assert.deepEqual(
    found.agents.map((agent) => agent.id),
    [...matches].sort(newestFirst).map((agent) => agent.id),
  );
  // Paged search keeps its own cursor.
  const one = (await f.get('/api/agents?q=harbour&limit=1')).json() as AgentListPage;
  const two = (await f.get(`/api/agents?q=harbour&limit=1&cursor=${one.nextCursor}`)).json();
  assert.equal(two.agents[0].id, [...matches].sort(newestFirst)[1]!.id);
  // ids= returns just those (an unknown id is left out).
  const named = (await f.get(`/api/agents?ids=${made[3]!.id},${randomUUID()}`)).json();
  assert.deepEqual(
    named.agents.map((agent: { id: string }) => agent.id),
    [made[3]!.id],
  );
  assert.equal(named.matched, 1);
  // One call may name up to AGENT_PAGES.ids (200) agents, so a reader by id needs few calls.
  const twoHundred = made.slice(0, AGENT_PAGES.ids).map((agent) => agent.id);
  const byIds = await f.get(`/api/agents?ids=${twoHundred.join(',')}&limit=${AGENT_PAGES.ids}`);
  assert.equal(byIds.statusCode, 200, byIds.body);
  assert.deepEqual(
    new Set((byIds.json() as AgentListPage).agents.map((agent) => agent.id)),
    new Set(twoHundred),
  );
  const tooMany = [...twoHundred, made[AGENT_PAGES.ids]!.id].join(',');
  assert.equal((await f.get(`/api/agents?ids=${tooMany}`)).statusCode, 400);
  // under= lists the live agents removing made[0] would take: 50, 100, 150, … while live.
  const under = (await f.get(`/api/agents?under=${made[0]!.id}&limit=200`)).json();
  const lineage: string[] = [];
  for (let index = 50; index < made.length; index += 50) {
    if (made[index]!.revokedAt) break;
    lineage.push(made[index]!.id);
  }
  assert.deepEqual(
    new Set(under.agents.map((agent: { id: string }) => agent.id)),
    new Set(lineage),
  );
  // live=1 (the pickers of an agent to act as) leaves removed agents out of the list and the
  // search; any other value is refused.
  const liveMatches = matches.filter((agent) => !agent.revokedAt);
  assert.ok(liveMatches.length < matches.length, 'the seed has a removed harbour agent');
  const live = (await f.get('/api/agents?q=harbour&live=1&limit=200')).json() as AgentListPage;
  assert.equal(live.matched, liveMatches.length);
  assert.deepEqual(
    live.agents.map((agent) => agent.id),
    [...liveMatches].sort(newestFirst).map((agent) => agent.id),
  );
  const all = (await f.get('/api/agents?live=1&limit=1')).json() as AgentListPage;
  assert.equal(all.matched, (await f.stored()).agents.filter((agent) => !agent.revokedAt).length);
  assert.equal((await f.get('/api/agents?live=0')).statusCode, 400);
});

test('city_workspace pages a large workspace, and a small one only when it asks', async (t) => {
  const f = await fixture(t);
  // Small: limit pages it, newest first, with the total.
  const small = (await f.tool('city_workspace', { limit: 2 })).json();
  assert.equal(small.agents.length, 2);
  assert.equal(small.agents_total, 4);
  assert.equal(typeof small.next_cursor, 'string');
  const rest = (await f.tool('city_workspace', { limit: 2, cursor: small.next_cursor })).json();
  assert.equal(rest.agents.length, 2);
  assert.equal(rest.next_cursor, null);
  assert.equal(
    new Set([...small.agents, ...rest.agents].map((agent: { id: string }) => agent.id)).size,
    4,
  );
  assert.equal((await f.tool('city_workspace', { cursor: 'bm9wZQ' })).statusCode, 400);
  assert.equal((await f.tool('city_workspace', { limit: 201 })).statusCode, 400);
  assert.equal((await f.tool('city_workspace', { unexpected: true })).statusCode, 400);

  await f.seed(2000);
  const expected = [...(await f.stored()).agents].sort(newestFirst).map((agent) => agent.id);
  const first = (await f.tool('city_workspace')).json();
  assert.equal(first.agents.length, AGENT_PAGES.size);
  assert.equal(first.agents_total, expected.length);
  assert.deepEqual(
    first.agents.map((agent: { id: string }) => agent.id),
    expected.slice(0, AGENT_PAGES.size),
  );
  // Public fields only, as before (no key hint).
  assert.equal('credentialHint' in first.agents[0], false);
  let cursor: string | null = first.next_cursor;
  const seen = first.agents.map((agent: { id: string }) => agent.id);
  while (cursor) {
    const page = (await f.tool('city_workspace', { limit: AGENT_PAGES.max, cursor })).json();
    seen.push(...page.agents.map((agent: { id: string }) => agent.id));
    cursor = page.next_cursor;
  }
  assert.deepEqual(seen, expected);
});
