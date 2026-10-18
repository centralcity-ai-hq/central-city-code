import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { Database, Transaction as Tx } from '../server/database.js';
import {
  HOSTED_HEARTBEAT_MS,
  HOSTED_PRESENCE_TTL,
  HOSTED_SEEN_WINDOW_MS,
  ownerAgent,
  PRESENCE_TTL,
  publicAgent,
  shownLastSeenAt,
  type StoredAgent,
} from '../server/model.js';
import { signedHeaders } from '../connector/signing.js';
import type { Agent, Snapshot } from '../shared/types.js';

/**
 * Hosted agents' synthetic presence (server/app.ts refreshPresence) without a workspace rewrite on
 * every read: renewed for all hosted agents together once per HOSTED_HEARTBEAT_MS, reachable for
 * HOSTED_PRESENCE_TTL. Synthetic data only; no network.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-hosted-presence-test-root-secret';
type App = Awaited<ReturnType<typeof createApp>>;
const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};
const hosted = {
  databaseUrl: 'postgres://unused.invalid/test',
  publicOrigin: ORIGIN,
  allowedOrigins: [ORIGIN],
};
const POLL_MS = 15_000; // the console's snapshot poll (src/useSnapshot.ts)
const T0 = 1_800_000_000_000;
const workspaceWrites = (sql: string) => /UPDATE\s+workspaces\b/i.test(sql);

/** One database shared by `instances` hosted apps (each with its own clock offset); every
 * statement any of them sends is recorded. */
async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  offsets: number[] = [0],
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  const statements: string[] = [];
  const recorded = (tx: Tx): Tx => ({
    query: (sql, params) => {
      statements.push(sql);
      return tx.query(sql, params);
    },
    exec: (sql) => {
      statements.push(sql);
      return tx.exec(sql);
    },
  });
  // Function instances share one database; each app closing must not close it for the others.
  const database: Database = {
    ...recorded(pg),
    transaction: (action) => pg.transaction((tx) => action(recorded(tx))),
    close: async () => {},
  };
  const clock = { now: T0 };
  const apps: App[] = [];
  for (const offset of offsets)
    apps.push(
      await createApp({
        hosted,
        database,
        now: () => clock.now + offset,
        startWorkers: false,
        responder: { enabled: true, env: {} },
        logLine: () => undefined,
      }),
    );
  t.after(() => Promise.all(apps.map((app) => app.close())));
  let address = 10;
  const call = (app: App, method: string, url: string, cookie: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${(address++ % 200) + 1}`,
    });
  const registered = await call(apps[0]!, 'POST', '/api/auth/register', '', {
    name: 'Hosted presence owner',
    password: 'Synthetic hosted presence test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const agent = async (name: string, mode: 'hosted' | 'external' = 'hosted') => {
    const created = await call(apps[0]!, 'POST', '/api/agents', cookie, {
      name,
      mode,
      capability: 'research',
      description: 'Synthetic hosted presence agent',
    });
    assert.equal(created.statusCode, 201, created.body);
    return created.json() as { agent: Agent; token?: string };
  };
  const poll = async (index = 0) => {
    const response = await call(apps[index]!, 'GET', '/api/snapshot', cookie);
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Snapshot;
  };
  const writes = () => statements.filter(workspaceWrites).length;
  const stored = async () =>
    (
      await pg.query<{ data: { agents: { id: string; lastSeenAt: string | null }[] } }>(
        'SELECT data FROM workspaces WHERE operator_id=(SELECT id FROM operators LIMIT 1)',
      )
    ).rows[0]!.data;
  return { apps, clock, call, cookie, agent, poll, writes, stored, statements };
}

const online = (snapshot: Snapshot, ids: string[]) =>
  ids.map((id) => snapshot.agents.find((agent) => agent.id === id)!.status);

test('snapshot polls rewrite the workspace for hosted presence at most once per interval', async (t) => {
  const f = await fixture(t);
  // Hosted agents created and first seen at different moments: under the old per-agent 30 s rule
  // their phases differed, so nearly every poll found one of them due and rewrote the document.
  const ids: string[] = [];
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    ids.push((await f.agent(name)).agent.id);
    await f.poll();
    f.clock.now += 7_000;
  }
  const first = await f.poll();
  assert.deepEqual(online(first, ids), ['online', 'online', 'online', 'online']);
  const announced = first.events.filter((event) => event.type === 'agent.online');
  assert.equal(announced.length, 4, 'each hosted agent is announced online once');

  const base = f.writes();
  const duration = 3 * HOSTED_HEARTBEAT_MS;
  const polls = duration / POLL_MS;
  for (let index = 0; index < polls; index++) {
    f.clock.now += POLL_MS;
    const snapshot = await f.poll();
    assert.deepEqual(online(snapshot, ids), ['online', 'online', 'online', 'online']);
    for (const item of snapshot.agents)
      assert.ok(
        f.clock.now - Date.parse(item.lastSeenAt!) < HOSTED_HEARTBEAT_MS + POLL_MS,
        'a hosted heartbeat is never older than the interval plus one poll',
      );
  }
  const renewals = f.writes() - base;
  t.diagnostic(`${renewals} workspace rewrites in ${polls} polls of one session`);
  // Before: at least one rewrite per 30 s per phase (>= polls / 2 = 180 here). Now: one per interval.
  assert.ok(renewals >= 1, 'the coarse renewal is still written through');
  assert.ok(renewals <= duration / HOSTED_HEARTBEAT_MS, `${renewals} rewrites in ${polls} polls`);
  // One renewal brings every hosted agent onto the same heartbeat, so they stay in phase.
  const seen = new Set((await f.stored()).agents.map((item) => item.lastSeenAt));
  assert.equal(seen.size, 1, 'all hosted heartbeats renewed together');
  // Presence refreshes stay silent: still exactly one online announcement per agent.
  assert.equal((await f.poll()).events.filter((event) => event.type === 'agent.online').length, 4);
});

test('a poll between renewals sends no workspace UPDATE (db.query and transactions spied)', async (t) => {
  const f = await fixture(t);
  const id = (await f.agent('Quiet')).agent.id;
  await f.poll();
  f.statements.length = 0;
  for (let index = 0; index < 20; index++) {
    f.clock.now += POLL_MS;
    assert.deepEqual(online(await f.poll(), [id]), ['online']);
  }
  assert.ok(f.statements.length > 0, 'the polls were observed');
  assert.deepEqual(f.statements.filter(workspaceWrites), [], 'no rewrite within the interval');
  assert.equal(
    f.statements.filter((sql) => /FROM workspaces.*FOR UPDATE/is.test(sql)).length,
    0,
    'no workspace row lock either',
  );
});

test('presence answers stay the same within the documented windows', async (t) => {
  const f = await fixture(t);
  const scripted = (await f.agent('Scripted')).agent.id;
  const peer = (await f.agent('Peer')).agent.id;
  const external = await f.agent('Runtime', 'external');
  const runtimeId = external.agent.id;
  const heartbeat = (sequence: number) => {
    const url = '/api/runtime/heartbeat';
    const body = JSON.stringify({ sequence });
    return f.apps[0]!.inject({
      method: 'POST',
      url,
      headers: {
        ...signedHeaders(external.token!, 'POST', url, body, String(f.clock.now)),
        host: 'centralcity.ai',
      },
      payload: body,
    });
  };
  assert.equal((await heartbeat(1)).statusCode, 200);
  const renewed = await f.poll();
  assert.deepEqual(online(renewed, [scripted, peer, runtimeId]), ['online', 'online', 'online']);
  const answering = async () => {
    const response = await f.call(f.apps[0]!, 'GET', `/api/agents/${scripted}/answering`, f.cookie);
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { runtime_connected: boolean }).runtime_connected;
  };
  assert.equal(await answering(), true);

  // External presence is unchanged: 90 s after its last signed heartbeat it is offline.
  f.clock.now += PRESENCE_TTL + 1_000;
  assert.deepEqual(online(await f.poll(), [scripted, peer, runtimeId]), [
    'online',
    'online',
    'offline',
  ]);

  // Reads that do not advance the workspace (the responder's raw read) see the stored synthetic
  // heartbeat: connected until HOSTED_PRESENCE_TTL after the last renewal, with no poll between.
  const last = Date.parse(
    (await f.stored()).agents.find((item) => item.id === scripted)!.lastSeenAt!,
  );
  f.clock.now = last + HOSTED_PRESENCE_TTL - 1_000;
  assert.equal(await answering(), true);
  f.clock.now = last + HOSTED_PRESENCE_TTL + 1_000;
  assert.equal(await answering(), false, 'no read for the whole window: not connected');
  // The next read renews it, as before.
  assert.deepEqual(online(await f.poll(), [scripted, peer]), ['online', 'online']);
  assert.equal(await answering(), true);

  // A hosted agent between renewals is reachable for admission and completes deterministic work.
  f.clock.now += HOSTED_HEARTBEAT_MS - 60_000;
  const connected = await f.call(f.apps[0]!, 'POST', '/api/connections', f.cookie, {
    fromAgentId: peer,
    toAgentId: scripted,
  });
  assert.ok([200, 201].includes(connected.statusCode), connected.body);
  const job = await f.call(f.apps[0]!, 'POST', '/api/jobs', f.cookie, {
    requesterId: peer,
    providerId: scripted,
    input: 'Synthetic text for hosted presence',
    idempotencyKey: 'hosted-presence-job',
  });
  assert.equal(job.statusCode, 201, job.body);
  const jobId = (job.json() as { job: { id: string } }).job.id;
  let status = '';
  for (let index = 0; index < 3 && status !== 'completed'; index++) {
    f.clock.now += 1_000;
    status = (await f.poll()).jobs.find((item) => item.id === jobId)!.status;
  }
  assert.equal(status, 'completed');
});

test('two instances polling one workspace: one renewal per interval, never backwards', async (t) => {
  // The second instance's clock runs 2 s ahead, as function instances may.
  const f = await fixture(t, [0, 2_000]);
  const ids = [(await f.agent('One')).agent.id, (await f.agent('Two')).agent.id];
  await f.poll(0);
  const base = f.writes();
  let previous = 0;
  const duration = 3 * HOSTED_HEARTBEAT_MS;
  for (let elapsed = 0; elapsed < duration; elapsed += POLL_MS) {
    f.clock.now += POLL_MS;
    // Both instances read at the same moment; the database serializes their locked ticks.
    const [a, b] = await Promise.all([f.poll(0), f.poll(1)]);
    for (const snapshot of [a, b]) assert.deepEqual(online(snapshot, ids), ['online', 'online']);
    const stamp = Math.max(
      ...(await f.stored()).agents.map((item) => Date.parse(item.lastSeenAt!)),
    );
    assert.ok(stamp >= previous, 'a stored heartbeat never moves backwards');
    previous = stamp;
  }
  const renewals = f.writes() - base;
  t.diagnostic(`${renewals} workspace rewrites for two instances polling every 15 s`);
  assert.ok(renewals >= 1);
  assert.ok(
    renewals <= duration / HOSTED_HEARTBEAT_MS,
    `${renewals} rewrites for two instances polling every 15 s`,
  );
});

test('the local worker tick does not rewrite the workspace on every tick', async (t) => {
  const clock = { now: T0 };
  const app = await createApp({ dataDir: 'memory://', now: () => clock.now, startWorkers: false });
  t.after(() => app.close());
  const local = { 'content-type': 'application/json', 'x-city-request': '1' };
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: local,
    payload: JSON.stringify({ name: 'Worker owner', password: 'Synthetic worker tick password' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  for (const name of ['North', 'South']) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...local, cookie },
      payload: JSON.stringify({ name, mode: 'hosted', capability: 'research' }),
    });
    assert.equal(created.statusCode, 201, created.body);
    await app.city.tick();
    clock.now += 11_000;
  }
  const statements: string[] = [];
  const db = app.city.db;
  const transaction = db.transaction.bind(db),
    query = db.query.bind(db);
  t.mock.method(db, 'transaction', <T>(action: (tx: Tx) => Promise<T>) =>
    transaction((tx) =>
      action({
        query: (sql, params) => {
          statements.push(sql);
          return tx.query(sql, params);
        },
        exec: (sql) => {
          statements.push(sql);
          return tx.exec(sql);
        },
      }),
    ),
  );
  t.mock.method(db, 'query', (...args: Parameters<typeof query>) => {
    statements.push(args[0]);
    return query(...args);
  });
  const ticks = (2 * HOSTED_HEARTBEAT_MS) / 10_000;
  for (let index = 0; index < ticks; index++) {
    clock.now += 10_000;
    await app.city.tick();
  }
  const rewrites = statements.filter(workspaceWrites).length;
  t.diagnostic(`${rewrites} workspace rewrites in ${ticks} worker ticks`);
  assert.ok(statements.length > ticks, 'the ticks were observed');
  assert.ok(rewrites >= 1 && rewrites <= 2, `${rewrites} rewrites in ${ticks} ticks`);
  const snapshot = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { cookie } });
  assert.deepEqual(
    (snapshot.json() as Snapshot).agents.map((agent) => agent.status),
    ['online', 'online'],
  );
});

test('a reachable hosted agent shows lastSeenAt as the current 30 s window, read only', async (t) => {
  const f = await fixture(t);
  const window = (time: number) => new Date(time - (time % HOSTED_SEEN_WINDOW_MS)).toISOString();
  const id = (await f.agent('Windowed')).agent.id;
  const external = (await f.agent('Outside', 'external')).agent.id;
  await f.poll();
  f.statements.length = 0;
  for (let index = 0; index < 20; index++) {
    f.clock.now += 13_000;
    const snapshot = await f.poll();
    const shown = snapshot.agents.find((item) => item.id === id)!;
    assert.equal(shown.status, 'online');
    assert.equal(shown.lastSeenAt, window(f.clock.now), 'the start of the current 30 s window');
    // The external agent never sent a heartbeat: its stored value is shown unchanged.
    assert.equal(snapshot.agents.find((item) => item.id === external)!.lastSeenAt, null);
  }
  assert.deepEqual(f.statements.filter(workspaceWrites), [], 'no write for the shown value');
  const stored = (await f.stored()).agents.find((item) => item.id === id)!.lastSeenAt!;
  assert.notEqual(stored, window(f.clock.now), 'the stored heartbeat is not the shown window');

  // The owner view of a single agent (rename) reports the same window.
  const renamed = await f.call(f.apps[0]!, 'PATCH', `/api/agents/${id}`, f.cookie, {
    name: 'Windowed again',
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((renamed.json() as { agent: Agent }).agent.lastSeenAt, window(f.clock.now));
});

test('shownLastSeenAt: hosted and reachable gives the window start, otherwise the stored value', () => {
  const time = T0 + 47_123;
  const seen = new Date(time - 5 * 60_000).toISOString();
  const base = {
    id: 'agent',
    name: 'Synthetic',
    description: '',
    capability: 'research',
    isDemo: true,
    createdAt: new Date(T0).toISOString(),
    revokedAt: null,
    lastSequence: 1,
    announcedOnline: true,
    lastSeenAt: seen,
  } as unknown as StoredAgent;
  const hostedAgent = { ...base, mode: 'hosted' } as StoredAgent;
  const start = new Date(time - (time % HOSTED_SEEN_WINDOW_MS)).toISOString();
  assert.equal(shownLastSeenAt(hostedAgent, time), start);
  assert.equal(publicAgent(hostedAgent, [], time).lastSeenAt, start);
  assert.equal(ownerAgent(hostedAgent, [], time).lastSeenAt, start);
  // Past HOSTED_PRESENCE_TTL it is offline and shows its stored heartbeat.
  const late = Date.parse(seen) + HOSTED_PRESENCE_TTL + 1_000;
  assert.equal(publicAgent(hostedAgent, [], late).status, 'offline');
  assert.equal(shownLastSeenAt(hostedAgent, late), seen);
  // Revoked: the stored value.
  const revoked = { ...hostedAgent, revokedAt: new Date(time).toISOString() } as StoredAgent;
  assert.equal(shownLastSeenAt(revoked, time), seen);
  // External agents keep their signed heartbeat time.
  const externalAgent = {
    ...base,
    mode: 'external',
    lastSeenAt: new Date(time - 10_000).toISOString(),
  } as StoredAgent;
  assert.equal(publicAgent(externalAgent, [], time).lastSeenAt, externalAgent.lastSeenAt);
  assert.equal(hostedAgent.lastSeenAt, seen, 'the stored agent is not modified');
});
