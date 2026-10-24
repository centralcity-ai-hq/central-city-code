import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import type { Transaction as Tx } from '../server/database.js';
import { signedHeaders } from '../connector/signing.js';
import type { Agent, Snapshot } from '../shared/types.js';

type App = Awaited<ReturnType<typeof createApp>>;
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const password = 'Synthetic presence test password';

async function api(app: App, cookie: string, url: string, body?: unknown) {
  return app.inject({
    method: body === undefined ? 'GET' : 'POST',
    url,
    headers: { ...headers, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  limits?: Parameters<typeof createApp>[0] extends infer O
    ? O extends { limits?: infer L }
      ? L
      : never
    : never,
) {
  const clock = { now: 1_800_000_000_000 };
  const app = await createApp({
    dataDir: 'memory://',
    now: () => clock.now,
    startWorkers: false,
    ...(limits ? { limits } : {}),
  });
  t.after(() => app.close());
  const registered = await api(app, '', '/api/auth/register', { name: 'Presence owner', password });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  const created = await api(app, cookie, '/api/agents', {
    name: 'Runtime',
    mode: 'external',
    capability: 'extract',
    description: 'Synthetic presence verification',
  });
  assert.equal(created.statusCode, 201, created.body);
  const { agent, token } = created.json() as { agent: Agent; token: string };
  const runtime = (url: string, body?: unknown, nonce?: string) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const method = body === undefined ? 'GET' : 'POST';
    return app.inject({
      method,
      url,
      headers: signedHeaders(token, method, url, text, String(clock.now), nonce),
      ...(body === undefined ? {} : { payload: text }),
    });
  };
  const heartbeat = (sequence: number, nonce?: string) =>
    runtime('/api/runtime/heartbeat', { sequence }, nonce);
  const snapshot = async () => {
    const response = await api(app, cookie, '/api/snapshot');
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Snapshot;
  };
  const stored = async () =>
    (
      await app.city.db.query<{ data: unknown }>(
        'SELECT data::text AS data FROM workspaces WHERE operator_id=(SELECT id FROM operators)',
      )
    ).rows[0]!.data as string;
  return { app, clock, cookie, agent, token, runtime, heartbeat, snapshot, stored };
}

test('a pure heartbeat never locks or rewrites the workspace row', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.heartbeat(1)).statusCode, 200);
  const before = await f.stored();
  const statements: string[] = [];
  const original = f.app.city.db.transaction.bind(f.app.city.db);
  const originalQuery = f.app.city.db.query.bind(f.app.city.db);
  const transactions = t.mock.method(
    f.app.city.db,
    'transaction',
    async <T>(callback: (tx: Tx) => Promise<T>) =>
      original((tx) =>
        callback({
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
  const queries = t.mock.method(
    f.app.city.db,
    'query',
    async (...args: Parameters<typeof originalQuery>) => {
      statements.push(args[0]);
      return originalQuery(...args);
    },
  );
  f.clock.now += 30_000;
  for (const sequence of [2, 3, 4]) assert.equal((await f.heartbeat(sequence)).statusCode, 200);
  transactions.mock.restore();
  queries.mock.restore();
  assert.ok(statements.length > 0);
  for (const sql of statements) {
    assert.doesNotMatch(sql, /UPDATE workspaces/i, sql);
    assert.doesNotMatch(sql, /FROM workspaces.*FOR UPDATE/is, sql);
  }
  assert.equal(await f.stored(), before, 'workspace JSON is byte-for-byte unchanged');
  const state = await f.snapshot();
  const agent = state.agents.find((item) => item.id === f.agent.id)!;
  assert.equal(agent.status, 'online');
  assert.equal(agent.lastSeenAt, new Date(f.clock.now).toISOString());
});

test('an idle job poll never locks or rewrites the workspace row', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.heartbeat(1)).statusCode, 200);
  const before = await f.stored();
  const statements: string[] = [];
  const original = f.app.city.db.transaction.bind(f.app.city.db);
  const originalQuery = f.app.city.db.query.bind(f.app.city.db);
  const transactions = t.mock.method(
    f.app.city.db,
    'transaction',
    async <T>(callback: (tx: Tx) => Promise<T>) =>
      original((tx) =>
        callback({
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
  const queries = t.mock.method(
    f.app.city.db,
    'query',
    async (...args: Parameters<typeof originalQuery>) => {
      statements.push(args[0]);
      return originalQuery(...args);
    },
  );
  const idle = await f.runtime('/api/runtime/jobs');
  assert.equal(idle.statusCode, 200, idle.body);
  assert.deepEqual(idle.json(), { job: null });
  // Without a fresh heartbeat the answer is the locked poll's: 409, still without the lock.
  f.clock.now += 10 * 60_000;
  const stale = await f.runtime('/api/runtime/jobs');
  assert.equal(stale.statusCode, 409, stale.body);
  transactions.mock.restore();
  queries.mock.restore();
  assert.ok(statements.length > 0);
  for (const sql of statements) {
    assert.doesNotMatch(sql, /UPDATE workspaces/i, sql);
    assert.doesNotMatch(sql, /FROM workspaces.*FOR UPDATE/is, sql);
  }
  assert.equal(await f.stored(), before, 'workspace JSON is byte-for-byte unchanged');
});

test('only online and offline transitions are recorded as events', async (t) => {
  const f = await fixture(t);
  const presenceEvents = async () =>
    (await f.snapshot()).events
      .filter((event) => event.agentId === f.agent.id && event.type !== 'agent.registered')
      .map((event) => event.type)
      .reverse();
  for (let sequence = 1; sequence <= 5; sequence++) {
    assert.equal((await f.heartbeat(sequence)).statusCode, 200);
    f.clock.now += 20_000;
  }
  assert.deepEqual(await presenceEvents(), ['agent.online']);
  f.clock.now += 91_000;
  await f.app.city.tick();
  assert.equal((await f.snapshot()).agents[0]!.status, 'offline');
  assert.deepEqual(await presenceEvents(), ['agent.online', 'agent.offline']);
  assert.equal((await f.heartbeat(6)).statusCode, 200);
  assert.equal((await f.heartbeat(7)).statusCode, 200);
  assert.deepEqual(await presenceEvents(), ['agent.online', 'agent.offline', 'agent.online']);
});

test('sequence and nonce replay remain rejected', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.heartbeat(5, 'nonce-aaaaaaaaaaaaaaaa')).statusCode, 200);
  assert.equal((await f.heartbeat(6, 'nonce-aaaaaaaaaaaaaaaa')).statusCode, 409);
  assert.equal((await f.heartbeat(5)).statusCode, 409);
  assert.equal((await f.heartbeat(4)).statusCode, 409);
  assert.equal((await f.heartbeat(6)).statusCode, 200);
  // A replayed nonce on a different route is also rejected.
  assert.equal(
    (await f.runtime('/api/runtime/jobs', undefined, 'nonce-aaaaaaaaaaaaaaaa')).statusCode,
    409,
  );
});

test('concurrent heartbeats accept each sequence once and never move backwards', async (t) => {
  const f = await fixture(t);
  const same = await Promise.all(Array.from({ length: 8 }, () => f.heartbeat(3)));
  assert.deepEqual(
    same.map((response) => response.statusCode).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
  );
  const mixed = await Promise.all([10, 7, 12, 8, 11, 9].map((sequence) => f.heartbeat(sequence)));
  assert.ok(mixed.every((response) => [200, 409].includes(response.statusCode)));
  assert.ok(mixed.some((response) => response.statusCode === 200));
  const row = (
    await f.app.city.db.query<{ sequence: number | string }>(
      'SELECT sequence FROM agent_presence WHERE agent_id=$1',
      [f.agent.id],
    )
  ).rows[0]!;
  assert.equal(Number(row.sequence), 12, 'the highest submitted sequence always wins');
  assert.equal((await f.heartbeat(12)).statusCode, 409);
  const nonce = 'shared-concurrent-nonce';
  const replays = await Promise.all(
    Array.from({ length: 6 }, (_, index) => f.heartbeat(20 + index, nonce)),
  );
  assert.equal(replays.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(replays.filter((response) => response.statusCode === 409).length, 5);
});

test('the per-agent live nonce cap holds under concurrency and recovers after expiry', async (t) => {
  const f = await fixture(t, { replayNoncesPerAgent: 3 });
  const burst = await Promise.all([1, 2, 3, 4, 5].map((sequence) => f.heartbeat(sequence)));
  const codes = burst.map((response) => response.statusCode);
  assert.equal(codes.filter((code) => code === 429).length, 2, codes.join());
  const live = (
    await f.app.city.db.query<{ count: number | string }>(
      'SELECT count(*) AS count FROM replay_nonces WHERE agent_id=$1',
      [f.agent.id],
    )
  ).rows[0]!;
  assert.equal(Number(live.count), 3);
  f.clock.now += 131_000;
  assert.equal((await f.heartbeat(100)).statusCode, 200);
  const after = (
    await f.app.city.db.query<{ count: number | string }>(
      'SELECT count(*) AS count FROM replay_nonces WHERE agent_id=$1',
      [f.agent.id],
    )
  ).rows[0]!;
  assert.equal(Number(after.count), 1, 'expired nonces for this agent were removed');
});

test('an upgraded workspace keeps its accepted heartbeat sequence baseline', async (t) => {
  const f = await fixture(t);
  await f.app.city.db.query(
    `UPDATE workspaces SET data=jsonb_set(data,'{agents,0,lastSequence}','50'::jsonb)`,
  );
  assert.equal((await f.heartbeat(50)).statusCode, 409);
  assert.equal((await f.heartbeat(51)).statusCode, 200);
});

test('a presence row written under another credential does not carry its sequence over', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.heartbeat(50)).statusCode, 200);
  // Simulates a racing old-credential request, or a rotation by an older build, that left the
  // row stamped with a different credential.
  await f.app.city.db.query(
    "UPDATE agent_presence SET credential_hash='previous-credential' WHERE agent_id=$1",
    [f.agent.id],
  );
  f.clock.now += 1_000;
  assert.equal((await f.heartbeat(1)).statusCode, 200);
  assert.equal((await f.heartbeat(1)).statusCode, 409);
  // A row with no recorded credential adopts the current one and keeps its baseline.
  await f.app.city.db.query('UPDATE agent_presence SET credential_hash=NULL WHERE agent_id=$1', [
    f.agent.id,
  ]);
  f.clock.now += 1_000;
  assert.equal((await f.heartbeat(1)).statusCode, 409);
  assert.equal((await f.heartbeat(2)).statusCode, 200);
});
