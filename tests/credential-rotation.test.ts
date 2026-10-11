import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction as Tx } from '../server/database.js';
import { createApp } from '../server/app.js';
import { publicAgent, type Workspace } from '../server/model.js';
import { signedHeaders } from '../connector/signing.js';
import type { Agent, Job, Snapshot } from '../shared/types.js';

// Hosted apps refuse to start without a shared secret; this one is synthetic and test-only.
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

type App = Awaited<ReturnType<typeof createApp>>;
const now = 1_800_000_000_000;
const password = 'Synthetic rotation test password';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function api(app: App, cookie: string, url: string, body?: unknown) {
  return app.inject({
    method: body === undefined ? 'GET' : 'POST',
    url,
    headers: { ...headers, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function account(app: App, name = 'Credential owner') {
  const response = await api(app, '', '/api/auth/register', { name, password });
  assert.equal(response.statusCode, 201, response.body);
  return `cc_session=${response.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
}
async function register(app: App, cookie: string, name: string, mode = 'external') {
  const response = await api(app, cookie, '/api/agents', {
    name,
    mode,
    capability: 'extract',
    description: 'Synthetic credential verification',
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { agent: Agent; token: string };
}
function runtime(app: App, token: string, url: string, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const method = body === undefined ? 'GET' : 'POST';
  return app.inject({
    method,
    url,
    headers: signedHeaders(token, method, url, text, String(now)),
    ...(body === undefined ? {} : { payload: text }),
  });
}
async function rotate(app: App, cookie: string, id: string) {
  const response = await api(app, cookie, `/api/agents/${id}/rotate-credential`, {});
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { agent: Agent; token: string };
}
async function heartbeat(app: App, token: string, sequence = 10) {
  const response = await runtime(app, token, '/api/runtime/heartbeat', { sequence });
  assert.equal(response.statusCode, 200, response.body);
}
async function connect(app: App, cookie: string, from: string, to: string) {
  const response = await api(app, cookie, '/api/connections', { fromAgentId: from, toAgentId: to });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().connection;
}
async function submit(app: App, cookie: string, from: string, to: string) {
  const response = await api(app, cookie, '/api/jobs', {
    requesterId: from,
    providerId: to,
    input: 'Synthetic amount: 42',
    idempotencyKey: randomUUID(),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().job as Job;
}
async function snapshot(app: App, cookie: string) {
  const response = await api(app, cookie, '/api/snapshot');
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Snapshot;
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: 'memory://', now: () => now, startWorkers: false });
  t.after(() => app.close());
  const cookie = await account(app);
  const external = await register(app, cookie, 'Rotating runtime');
  const peer = await register(app, cookie, 'Hosted peer', 'hosted');
  await heartbeat(app, external.token);
  await app.city.tick();
  const inbound = await connect(app, cookie, peer.agent.id, external.agent.id);
  const outbound = await connect(app, cookie, external.agent.id, peer.agent.id);
  return { app, cookie, external, peer, inbound, outbound };
}

test('rotation preserves stable identity and accepted history, cancels active work and resets presence', async (t) => {
  const f = await fixture(t);
  const completed = await submit(f.app, f.cookie, f.external.agent.id, f.peer.agent.id);
  await f.app.city.tick();
  await f.app.city.tick();
  assert.equal(
    (await api(f.app, f.cookie, `/api/jobs/${completed.id}/accept`, {})).statusCode,
    200,
  );
  const inboundJob = await submit(f.app, f.cookie, f.peer.agent.id, f.external.agent.id);
  const lease = await runtime(f.app, f.external.token, '/api/runtime/jobs');
  assert.equal(lease.statusCode, 200, lease.body);
  const outboundJob = await submit(f.app, f.cookie, f.external.agent.id, f.peer.agent.id);
  const before = await snapshot(f.app, f.cookie);
  const rotated = await rotate(f.app, f.cookie, f.external.agent.id);
  assert.notEqual(rotated.token, f.external.token);
  assert.equal(rotated.agent.id, f.external.agent.id);
  assert.equal(rotated.agent.createdAt, f.external.agent.createdAt);
  assert.equal(rotated.agent.status, 'offline');
  assert.equal(rotated.agent.lastSeenAt, null);
  const after = await snapshot(f.app, f.cookie);
  assert.deepEqual(after.connections, before.connections);
  assert.equal(after.stats.registered, before.stats.registered);
  assert.equal(after.jobs.find((job) => job.id === completed.id)?.acceptance, 'accepted');
  for (const id of [inboundJob.id, outboundJob.id]) {
    assert.equal(after.jobs.find((job) => job.id === id)?.status, 'canceled');
  }
  for (const [url, body] of [
    ['/api/runtime/heartbeat', { sequence: 11 }],
    ['/api/runtime/jobs', undefined],
    [`/api/runtime/requests/${completed.id}`, undefined],
    [
      '/api/runtime/requests',
      { providerId: f.peer.agent.id, input: 'Old request', idempotencyKey: randomUUID() },
    ],
    [
      `/api/runtime/jobs/${inboundJob.id}/result`,
      { leaseToken: lease.json().leaseToken, output: { late: true } },
    ],
  ] as const) {
    const denied = await runtime(f.app, f.external.token, url, body);
    assert.equal(denied.statusCode, 401, `${url}: ${denied.body}`);
  }
  await heartbeat(f.app, rotated.token, 0);
  const late = await runtime(f.app, rotated.token, `/api/runtime/jobs/${inboundJob.id}/result`, {
    leaseToken: lease.json().leaseToken,
    output: { late: true },
  });
  assert.equal(late.statusCode, 409, late.body);
  const newJob = await submit(f.app, f.cookie, f.peer.agent.id, f.external.agent.id);
  const newLease = await runtime(f.app, rotated.token, '/api/runtime/jobs');
  assert.equal(newLease.json().job.id, newJob.id);
  assert.equal(
    (
      await runtime(f.app, rotated.token, `/api/runtime/jobs/${newJob.id}/result`, {
        leaseToken: newLease.json().leaseToken,
        output: { value: 42 },
      })
    ).statusCode,
    200,
  );
  const second = await rotate(f.app, f.cookie, f.external.agent.id);
  assert.equal((await runtime(f.app, rotated.token, '/api/runtime/jobs')).statusCode, 401);
  await heartbeat(f.app, second.token, 0);
  const state = await snapshot(f.app, f.cookie);
  const audit = state.events.filter((entry) => entry.type === 'agent.credential_rotated');
  assert.equal(audit.length, 2);
  assert.ok(audit.every((entry) => entry.agentId === f.external.agent.id));
  const serialized = JSON.stringify(state);
  for (const secret of [f.external.token, rotated.token, second.token]) {
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(hash(secret)));
  }
});

test('rotation requires the owner and rejects hosted, revoked or malformed targets', async (t) => {
  const f = await fixture(t);
  const other = await account(f.app, 'Different owner');
  const path = `/api/agents/${f.external.agent.id}/rotate-credential`;
  assert.equal((await api(f.app, '', path, {})).statusCode, 401);
  assert.equal((await api(f.app, other, path, {})).statusCode, 404);
  assert.equal(
    (await api(f.app, f.cookie, path, { token: 'client-chosen-secret' })).statusCode,
    400,
  );
  assert.equal(
    (await api(f.app, f.cookie, `/api/agents/${f.peer.agent.id}/rotate-credential`, {})).statusCode,
    409,
  );
  await heartbeat(f.app, f.external.token, 11);
  assert.equal(
    (await api(f.app, f.cookie, `/api/agents/${f.external.agent.id}/revoke`, {})).statusCode,
    200,
  );
  assert.equal((await api(f.app, f.cookie, path, {})).statusCode, 409);
  assert.equal((await f.app.city.db.query('SELECT agent_id FROM credentials')).rows.length, 0);
});

test('the owner sees a masked credential hint that follows create and rotation, nobody else does', async (t) => {
  const f = await fixture(t);
  const id = f.external.agent.id;
  const hintOf = (token: string) => `…${token.slice(-4)}`;
  const mine = async (agentId = id) =>
    (await snapshot(f.app, f.cookie)).agents.find((agent) => agent.id === agentId)!;
  // Set on create, shown in the create answer and the owner's snapshot; hosted agents have none.
  assert.equal(f.external.agent.credentialHint, hintOf(f.external.token));
  assert.equal((await mine()).credentialHint, hintOf(f.external.token));
  assert.equal(f.peer.agent.credentialHint, null);
  assert.equal((await mine(f.peer.agent.id)).credentialHint, null);
  // Rotation replaces it with the new credential's last 4 characters.
  const rotated = await rotate(f.app, f.cookie, id);
  assert.equal(rotated.agent.credentialHint, hintOf(rotated.token));
  assert.equal((await mine()).credentialHint, hintOf(rotated.token));
  // Only the last 4 characters are stored, never the credential itself.
  const workspaces = (
    await f.app.city.db.query<{ data: Workspace }>('SELECT data FROM workspaces')
  ).rows.map((row) => row.data);
  const stored = JSON.stringify(workspaces);
  assert.ok(!stored.includes(rotated.token));
  assert.ok(!stored.includes(f.external.token));
  // The shared shape (assistant, runtime and MCP views) never carries it.
  const storedAgent = workspaces
    .flatMap((workspace) => workspace.agents)
    .find((agent) => agent.id === id)!;
  assert.equal(storedAgent.credentialHint, rotated.token.slice(-4));
  assert.equal('credentialHint' in publicAgent(storedAgent, [], now), false);
  // Another workspace never sees it.
  const other = await account(f.app, 'Another owner');
  const theirs = await snapshot(f.app, other);
  assert.ok(!JSON.stringify(theirs).includes(hintOf(rotated.token)));
  // Agents from before hints were kept show null until their next rotation.
  await f.app.city.db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}',
       (SELECT jsonb_agg(a - 'credentialHint') FROM jsonb_array_elements(data->'agents') a))
     WHERE jsonb_array_length(data->'agents') > 0`,
  );
  assert.equal((await mine()).credentialHint, null);
  const again = await rotate(f.app, f.cookie, id);
  assert.equal((await mine()).credentialHint, hintOf(again.token));
  // Revocation deletes the credential and its hint.
  assert.equal((await api(f.app, f.cookie, `/api/agents/${id}/revoke`, {})).statusCode, 200);
  assert.equal((await mine()).credentialHint, null);
});

test('a persistence failure rolls back the secret replacement, cancellation, presence and audit together', async (t) => {
  const f = await fixture(t);
  await submit(f.app, f.cookie, f.peer.agent.id, f.external.agent.id);
  await runtime(f.app, f.external.token, '/api/runtime/jobs');
  const before = await snapshot(f.app, f.cookie);
  const original = f.app.city.db.transaction.bind(f.app.city.db);
  const mock = t.mock.method(
    f.app.city.db,
    'transaction',
    async <T>(callback: (tx: Tx) => Promise<T>) => {
      return original((tx) =>
        callback(
          new Proxy(tx, {
            get(target, property) {
              if (property === 'query')
                return (...args: Parameters<Tx['query']>) => {
                  if (args[0].startsWith('UPDATE workspaces SET data='))
                    throw new Error('Synthetic storage failure');
                  return target.query(...args);
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      );
    },
  );
  const response = await api(
    f.app,
    f.cookie,
    `/api/agents/${f.external.agent.id}/rotate-credential`,
    {},
  );
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(response.json(), { error: 'The operation could not be completed.' });
  mock.mock.restore();
  assert.deepEqual(await snapshot(f.app, f.cookie), before);
  const stored = (
    await f.app.city.db.query<{ token_hash: string }>('SELECT token_hash FROM credentials')
  ).rows;
  assert.deepEqual(stored, [{ token_hash: hash(f.external.token) }]);
  await heartbeat(f.app, f.external.token, 11);
});

test('a credential captured before rotation cannot pass the nonce authentication transaction', async (t) => {
  const f = await fixture(t);
  const observed = deferred();
  const release = deferred();
  t.after(() => {
    release.resolve();
  });
  const original = f.app.city.db.query.bind(f.app.city.db);
  let armed = true;
  const mock = t.mock.method(
    f.app.city.db,
    'query',
    async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (armed && args[0].startsWith('SELECT operator_id,agent_id,token_hash FROM credentials')) {
        armed = false;
        observed.resolve();
        await release.promise;
      }
      return result;
    },
  );
  const stale = Promise.resolve(
    runtime(f.app, f.external.token, '/api/runtime/heartbeat', { sequence: 99 }),
  );
  await observed.promise;
  await rotate(f.app, f.cookie, f.external.agent.id);
  release.resolve();
  assert.equal((await stale).statusCode, 401);
  mock.mock.restore();
  assert.equal(
    (await snapshot(f.app, f.cookie)).agents.find((agent) => agent.id === f.external.agent.id)
      ?.status,
    'offline',
  );
});

test('every runtime operation rechecks a credential rotated after authentication', async (t) => {
  for (const operation of ['heartbeat', 'claim', 'result', 'request', 'retrieve'] as const) {
    await t.test(operation, async (subtest) => {
      const f = await fixture(subtest);
      const inbound = await submit(f.app, f.cookie, f.peer.agent.id, f.external.agent.id);
      const claim = await runtime(f.app, f.external.token, '/api/runtime/jobs');
      assert.equal(claim.statusCode, 200, claim.body);
      const outbound = await submit(f.app, f.cookie, f.external.agent.id, f.peer.agent.id);
      const calls = {
        heartbeat: ['/api/runtime/heartbeat', { sequence: 100 }],
        claim: ['/api/runtime/jobs', undefined],
        result: [
          `/api/runtime/jobs/${inbound.id}/result`,
          { leaseToken: claim.json().leaseToken, output: { stale: true } },
        ],
        request: [
          '/api/runtime/requests',
          { providerId: f.peer.agent.id, input: 'Stale request', idempotencyKey: randomUUID() },
        ],
        retrieve: [`/api/runtime/requests/${outbound.id}`, undefined],
      } as const;
      const observed = deferred();
      const release = deferred();
      subtest.after(() => {
        release.resolve();
      });
      const original = f.app.city.db.transaction.bind(f.app.city.db);
      let armed = true;
      const mock = subtest.mock.method(
        f.app.city.db,
        'transaction',
        async <T>(callback: (tx: Tx) => Promise<T>) => {
          const pause = armed;
          armed = false;
          const result = await original(callback);
          if (pause) {
            observed.resolve();
            await release.promise;
          }
          return result;
        },
      );
      const [url, body] = calls[operation];
      const stale = Promise.resolve(runtime(f.app, f.external.token, url, body));
      await observed.promise;
      const rotated = await rotate(f.app, f.cookie, f.external.agent.id);
      release.resolve();
      const response = await stale;
      assert.equal(response.statusCode, 401, response.body);
      mock.mock.restore();
      const state = await snapshot(f.app, f.cookie);
      assert.equal(
        state.agents.find((agent) => agent.id === f.external.agent.id)?.status,
        'offline',
      );
      assert.ok(state.jobs.every((job) => job.status === 'canceled' && job.output === null));
      await heartbeat(f.app, rotated.token, 0);
    });
  }
});

test('the legacy credential schema remains usable and rotation survives persistent restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'central-city-rotation-'));
  let app: App | undefined;
  try {
    const dataDir = join(directory, 'database');
    const db = await PGlite.create(dataDir);
    const operatorId = randomUUID();
    const agentId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const date = new Date(now).toISOString();
    // An existing v0.1 database: unchanged credential columns and agent fields.
    await db.exec(`
      CREATE TABLE operators (id text PRIMARY KEY, name text NOT NULL, name_key text NOT NULL UNIQUE, password_hash text NOT NULL, salt text NOT NULL);
      CREATE TABLE workspaces (operator_id text PRIMARY KEY REFERENCES operators(id), data jsonb NOT NULL);
      CREATE TABLE credentials (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), agent_id text NOT NULL UNIQUE);
    `);
    await db.query('INSERT INTO operators VALUES($1,$2,$3,$4,$5)', [
      operatorId,
      'Legacy owner',
      'legacy owner',
      scryptSync(password, salt, 64).toString('hex'),
      salt,
    ]);
    await db.query('INSERT INTO credentials VALUES($1,$2,$3)', [hash(token), operatorId, agentId]);
    await db.query('INSERT INTO workspaces VALUES($1,$2::jsonb)', [
      operatorId,
      JSON.stringify({
        paused: false,
        connections: [],
        jobs: [],
        events: [],
        agents: [
          {
            id: agentId,
            name: 'Legacy runtime',
            description: '',
            capability: 'extract',
            mode: 'external',
            isDemo: false,
            createdAt: date,
            lastSeenAt: date,
            revokedAt: null,
            lastSequence: 8,
            announcedOnline: true,
          },
        ],
      }),
    ]);
    await db.close();
    app = await createApp({ dataDir, now: () => now, startWorkers: false });
    const login = await api(app, '', '/api/auth/login', { name: 'Legacy owner', password });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = `cc_session=${login.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
    await heartbeat(app, token, 9);
    const rotated = await rotate(app, cookie, agentId);
    await app.close();
    app = await createApp({ dataDir, now: () => now, startWorkers: false });
    assert.equal(
      (await runtime(app, token, '/api/runtime/heartbeat', { sequence: 10 })).statusCode,
      401,
    );
    await heartbeat(app, rotated.token, 0);
    assert.equal((await snapshot(app, cookie)).agents[0]?.id, agentId);
    const rows = (
      await app.city.db.query<{ token_hash: string }>('SELECT token_hash FROM credentials')
    ).rows;
    assert.deepEqual(rows, [{ token_hash: hash(rotated.token) }]);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
