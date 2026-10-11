import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHostedRequest, loadHostedConfig } from '../server/hosted.js';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { Snapshot } from '../shared/types.js';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createHostedHandler } from '../server/vercel-handler.js';
import { signedHeaders } from '../connector/signing.js';
import type { Workspace } from '../server/model.js';
import { randomUUID } from 'node:crypto';

// Hosted apps refuse to start without a shared secret; this one is synthetic and test-only.
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

test('hosted configuration requires explicit mode and durable database', () => {
  assert.throws(() => loadHostedConfig({}), /CITY_HOSTED/);
  assert.throws(() => loadHostedConfig({ CITY_HOSTED: '1' }), /DATABASE_URL/);
});

test('a configured hosted process cannot fall back to PGlite when DATABASE_URL is missing', async (t) => {
  const saved = { CITY_HOSTED: process.env.CITY_HOSTED, DATABASE_URL: process.env.DATABASE_URL };
  process.env.CITY_HOSTED = '1';
  delete process.env.DATABASE_URL;
  const create = t.mock.method(PGlite, 'create', async () => {
    throw new Error('Unexpected embedded database');
  });
  try {
    await assert.rejects(createApp({ dataDir: 'memory://' }), /DATABASE_URL/);
    assert.equal(create.mock.callCount(), 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Node function preserves API paths, JSON request bodies and session cookies', async (t) => {
  const app = await createApp({ hosted, database: await PGlite.create('memory://') });
  t.after(() => app.close());
  let starts = 0;
  const server = createServer(
    createHostedHandler(async () => {
      starts++;
      return app;
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const send = (
    path: string,
    method: string,
    requestHeaders: Record<string, string>,
    body?: string,
  ) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${base}${path}`,
          { method, headers: requestHeaders },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () =>
              resolve({ status: response.statusCode!, headers: response.headers, body: text }),
            );
          },
        );
        request.on('error', reject);
        request.end(body);
      },
    );
  const registration = await send(
    '/api/auth/register',
    'POST',
    headers,
    JSON.stringify({ name: 'Function owner', password: 'a synthetic long password' }),
  );
  assert.equal(registration.status, 201, registration.body);
  const cookie = registration.headers['set-cookie']![0]!.split(';')[0]!;
  const snapshot = await send('/api/snapshot', 'GET', { ...headers, cookie });
  assert.equal(snapshot.status, 200);
  assert.equal(JSON.parse(snapshot.body).operator.name, 'Function owner');
  assert.equal(starts, 1, 'function reuses initialized application');
});

const hosted = loadHostedConfig({
  CITY_HOSTED: '1',
  DATABASE_URL: 'postgresql://db.example.com/staging',
  CITY_PUBLIC_ORIGIN: 'https://city.example.com',
});
const headers = {
  host: 'city.example.com',
  origin: 'https://city.example.com',
  'x-city-request': '1',
  'content-type': 'application/json',
};

test('hosted app enforces host, origin, request protection and secure sessions', async (t) => {
  const app = await createApp({ hosted, database: await PGlite.create('memory://') });
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { host: 'localhost' } })).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/session',
        headers: { ...headers, origin: 'https://evil.example.com' },
      })
    ).statusCode,
    403,
  );
  const payload = { name: 'Hosted owner', password: 'a synthetic long password' };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { ...headers, 'x-city-request': '' },
        payload,
      })
    ).statusCode,
    403,
  );
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload,
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const session = registration.cookies.find((cookie) => cookie.name === 'cc_session')!;
  assert.equal(session.secure, true);
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, 'Strict');
  const cookie = `cc_session=${session.value}`;
  assert.equal(
    (await app.inject({ url: '/api/events', headers: { ...headers, cookie } })).statusCode,
    204,
  );
  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { ...headers, cookie },
    payload: {},
  });
  assert.equal(logout.cookies[0]?.secure, true);
  assert.equal(
    (await app.inject({ url: '/api/snapshot', headers: { ...headers, cookie } })).statusCode,
    401,
  );
});

test('hosted deterministic jobs advance on owner polling without an interval', async (t) => {
  const app = await createApp({ hosted, database: await PGlite.create('memory://') });
  t.after(() => app.close());
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Hosted worker', password: 'a synthetic long password' },
  });
  const cookie = `cc_session=${registration.cookies[0]!.value}`;
  const authenticated = { ...headers, cookie };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/demo/start',
        headers: authenticated,
        payload: {},
      })
    ).statusCode,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const stored = (
    await app.city.db.query<{ data: { agents: { lastSeenAt: string | null }[] } }>(
      'SELECT data FROM workspaces',
    )
  ).rows[0]!;
  assert.ok(
    stored.data.agents.every((agent) => agent.lastSeenAt === null),
    'no interval has emitted a heartbeat',
  );
  const snapshot = (
    await app.inject({ url: '/api/snapshot', headers: authenticated })
  ).json<Snapshot>();
  const requester = snapshot.agents.find((agent) => agent.name === 'Atlas')!;
  const provider = snapshot.agents.find((agent) => agent.name === 'Relay')!;
  const job = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: authenticated,
    payload: {
      requesterId: requester.id,
      providerId: provider.id,
      input: 'Contact synthetic@example.com',
      idempotencyKey: 'hosted-job-example',
    },
  });
  assert.equal(job.statusCode, 201, job.body);
  assert.equal(
    (await app.inject({ url: '/api/snapshot', headers: authenticated })).json<Snapshot>().jobs[0]
      ?.status,
    'running',
  );
  assert.equal(
    (await app.inject({ url: '/api/snapshot', headers: authenticated })).json<Snapshot>().jobs[0]
      ?.status,
    'completed',
  );
});

test('hosted sign-up has no site-wide account ceiling: accounts 51 and 52 register concurrently', async (t) => {
  const app = await createApp({ hosted, database: await PGlite.create('memory://') });
  t.after(() => app.close());
  await app.city.db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt) SELECT 'seed-'||i, 'seed-'||i, 'seed-'||i, 'unused', 'unused' FROM generate_series(1,50) AS i",
  );
  const registrations = await Promise.all(
    ['Final one', 'Final two'].map((name) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers,
        payload: { name, password: 'a synthetic long password' },
      }),
    ),
  );
  assert.deepEqual(
    registrations.map((result) => result.statusCode),
    [201, 201],
  );
  assert.equal(
    Number(
      (await app.city.db.query<{ count: string }>('SELECT count(*) FROM operators')).rows[0]?.count,
    ),
    52,
  );
});

test('hosted cancel, pause and revoke apply before a running demonstration can complete', async (t) => {
  const app = await createApp({ hosted, database: await PGlite.create('memory://') });
  t.after(() => app.close());
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Controls owner', password: 'a synthetic long password' },
  });
  const authenticated = { ...headers, cookie: `cc_session=${registration.cookies[0]!.value}` };
  const post = (url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: authenticated, payload: JSON.stringify(payload) });
  const poll = async () =>
    (await app.inject({ url: '/api/snapshot', headers: authenticated })).json<Snapshot>();
  await post('/api/demo/start');
  const initial = await poll();
  const requester = initial.agents.find((agent) => agent.name === 'Atlas')!;
  const provider = initial.agents.find((agent) => agent.name === 'Relay')!;
  const runningJob = async (key: string) => {
    const result = await post('/api/jobs', {
      requesterId: requester.id,
      providerId: provider.id,
      input: 'Synthetic text',
      idempotencyKey: key,
    });
    assert.equal(result.statusCode, 201, result.body);
    const id = result.json().job.id as string;
    assert.equal((await poll()).jobs.find((job) => job.id === id)?.status, 'running');
    return id;
  };
  const canceled = await runningJob('hosted-cancel-example');
  const cancel = await post(`/api/jobs/${canceled}/cancel`);
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().job.status, 'canceled');
  assert.equal((await poll()).jobs.find((job) => job.id === canceled)?.status, 'canceled');
  const paused = await runningJob('hosted-pause-example');
  assert.equal((await post('/api/workspace/pause', { paused: true })).statusCode, 200);
  const waiting = (await poll()).jobs.find((job) => job.id === paused)!;
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.output, null);
  await post('/api/workspace/pause', { paused: false });
  assert.equal((await poll()).jobs.find((job) => job.id === paused)?.status, 'completed');
  const revoked = await runningJob('hosted-revoke-example');
  assert.equal((await post(`/api/agents/${provider.id}/revoke`)).statusCode, 200);
  assert.equal((await poll()).jobs.find((job) => job.id === revoked)?.status, 'canceled');
});
test('hosted configuration accepts only exact HTTPS origins and host matches', () => {
  const env = {
    CITY_HOSTED: '1',
    DATABASE_URL: 'postgresql://db.example.com/staging',
    CITY_PUBLIC_ORIGIN: 'https://city.example.com',
  };
  const config = loadHostedConfig(env);
  assert.equal(checkHostedRequest(config, 'city.example.com', 'https://city.example.com'), true);
  assert.equal(checkHostedRequest(config, 'attacker.example.com', undefined), false);
  assert.equal(checkHostedRequest(config, 'city.example.com', 'http://city.example.com'), false);
  const aliases = loadHostedConfig({
    ...env,
    VERCEL_PROJECT_PRODUCTION_URL: 'city-project.vercel.app',
  });
  assert.equal(
    checkHostedRequest(aliases, 'city-project.vercel.app', 'https://city-project.vercel.app'),
    true,
  );
  assert.equal(checkHostedRequest(aliases, 'other-project.vercel.app', undefined), false);
  assert.throws(
    () => loadHostedConfig({ ...env, CITY_PUBLIC_ORIGIN: 'http://city.example.com' }),
    /HTTPS/,
  );
  assert.throws(
    () => loadHostedConfig({ ...env, CITY_PUBLIC_ORIGIN: 'https://city.example.com/path' }),
    /HTTPS/,
  );
});

async function headlessFixture(t: { after(fn: () => Promise<unknown>): void }) {
  let time = 1_800_000_000_000;
  const app = await createApp({
    hosted,
    database: await PGlite.create('memory://'),
    now: () => time,
  });
  t.after(() => app.close());
  const register = async (name: string) => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: { name, password: 'Synthetic headless account password' },
    });
    assert.equal(result.statusCode, 201, result.body);
    return {
      cookie: `cc_session=${result.cookies[0]!.value}`,
      id: result.json().operator.id as string,
    };
  };
  const owner = await register('Headless owner');
  const post = (url: string, payload: unknown = {}, cookie = owner.cookie) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, cookie },
      payload: JSON.stringify(payload),
    });
  assert.equal((await post('/api/demo/start')).statusCode, 200);
  const stored = async (id = owner.id) =>
    (
      await app.city.db.query<{ data: Workspace }>(
        'SELECT data FROM workspaces WHERE operator_id=$1',
        [id],
      )
    ).rows[0]!.data;
  const access = await post('/api/assistant-access', {
    label: 'Headless fixture',
    scopes: ['workspace:read', 'jobs:create', 'jobs:cancel'],
    expiresInDays: 1,
  });
  assert.equal(access.statusCode, 201, access.body);
  const { token, grant } = access.json();
  const tool = (name: string, payload: unknown = {}, credential = token) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: { ...headers, authorization: `Bearer ${credential}` },
      payload: JSON.stringify(payload),
    });
  const initial = await stored();
  assert.ok(initial.agents.every((agent) => agent.lastSeenAt === null));
  const requester = initial.agents.find((agent) => agent.name === 'Atlas')!;
  const provider = initial.agents.find((agent) => agent.name === 'Relay')!;
  const submit = async () => {
    const result = await tool('city_create_job', {
      requesterId: requester.id,
      providerId: provider.id,
      input: 'Synthetic contact hello@example.test',
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().job.status, 'queued');
    return result.json().job.id as string;
  };
  return {
    app,
    owner,
    post,
    stored,
    token,
    grant,
    tool,
    submit,
    register,
    requester,
    provider,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('hosted assistant completes work headlessly with fresh presence, no duplicate completion and explicit acceptance', async (t) => {
  const f = await headlessFixture(t);
  // Neither setup nor execution uses /api/snapshot or the manual worker tick.
  const view = await f.tool('city_workspace');
  assert.equal(view.statusCode, 200, view.body);
  assert.ok((await f.stored()).agents.every((agent) => agent.lastSeenAt !== null));
  f.advance(95_000);
  const id = await f.submit(); // Admission refreshes demo presence without executing jobs.
  const poll = () => f.tool('city_get_job', { id });
  assert.equal((await poll()).json().job.status, 'running');
  f.advance(95_000); // A quiet headless client must not consume an external lease retry.
  const concurrent = await Promise.all([poll(), poll(), poll()]);
  for (const result of concurrent) {
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().job.status, 'completed');
    assert.equal(result.json().job.acceptance, 'pending');
    assert.equal(result.json().job.costCents, 0);
    assert.ok(result.json().job.output);
  }
  const state = await f.stored();
  assert.equal(state.jobs[0]!.attempts, 1);
  assert.equal(
    state.events.filter((event) => event.type === 'job.completed' && event.jobId === id).length,
    1,
  );
});

test('headless reads require current owner, scope and grant; controls precede execution', async (t) => {
  const f = await headlessFixture(t);
  const id = await f.submit();
  const read = await f.post('/api/assistant-access', {
    label: 'Read only',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(read.statusCode, 201, read.body);
  const readToken = read.json().token;
  assert.equal((await f.tool('city_create_job', {}, readToken)).statusCode, 403);
  assert.equal((await f.tool('city_get_job', { id: randomUUID() })).statusCode, 404);
  assert.equal((await f.tool('city_workspace', { unexpected: true })).statusCode, 400);
  assert.equal((await f.tool('city_get_job', { id }, 'a'.repeat(43))).statusCode, 401);
  const other = await f.register('Other headless owner');
  const otherGrant = await f.post(
    '/api/assistant-access',
    { label: 'Other', scopes: ['workspace:read'], expiresInDays: 1 },
    other.cookie,
  );
  assert.equal(otherGrant.statusCode, 201, otherGrant.body);
  assert.equal((await f.tool('city_get_job', { id }, otherGrant.json().token)).statusCode, 404);
  assert.equal(
    (await f.stored()).jobs[0]!.status,
    'queued',
    'denied calls do not advance the owner workspace',
  );
  assert.equal((await f.tool('city_get_job', { id }, readToken)).json().job.status, 'running');
  assert.equal((await f.post('/api/workspace/pause', { paused: true })).statusCode, 200);
  f.advance(95_000);
  assert.equal((await f.tool('city_get_job', { id })).json().job.status, 'running');
  assert.equal((await f.stored()).jobs[0]!.output, null);
  assert.equal((await f.tool('city_cancel_job', { id })).statusCode, 200);
  assert.equal((await f.post('/api/workspace/pause', { paused: false })).statusCode, 200);
  assert.equal((await f.tool('city_get_job', { id })).json().job.status, 'canceled');
  const revokedJob = await f.submit();
  assert.equal((await f.tool('city_get_job', { id: revokedJob })).json().job.status, 'running');
  assert.equal((await f.post(`/api/agents/${f.provider.id}/revoke`)).statusCode, 200);
  assert.equal((await f.tool('city_get_job', { id: revokedJob })).json().job.status, 'canceled');
  const before = JSON.stringify(await f.stored());
  await f.app.city.db.query('UPDATE assistant_grants SET expires_at=$2 WHERE id=$1', [
    f.grant.id,
    f.now(),
  ]);
  assert.equal((await f.tool('city_workspace')).statusCode, 401);
  assert.equal(JSON.stringify(await f.stored()), before);
  const revoke = await f.app.inject({
    method: 'DELETE',
    url: `/api/assistant-access/${read.json().grant.id}`,
    headers: { ...headers, cookie: f.owner.cookie },
  });
  assert.equal(revoke.statusCode, 200, revoke.body);
  const afterRevoke = JSON.stringify(await f.stored());
  assert.equal((await f.tool('city_workspace', {}, readToken)).statusCode, 401);
  assert.equal(JSON.stringify(await f.stored()), afterRevoke);
});

test('signed native requester starts from cold demo presence and polls to completion without owner reads', async (t) => {
  const f = await headlessFixture(t);
  const external = await f.post('/api/agents', {
    name: 'Headless native requester',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(external.statusCode, 201, external.body);
  const { agent, token } = external.json();
  const connection = await f.post('/api/connections', {
    fromAgentId: agent.id,
    toAgentId: f.provider.id,
  });
  assert.equal(connection.statusCode, 201, connection.body);
  const runtime = (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return f.app.inject({
      method,
      url,
      headers: {
        host: 'city.example.com',
        ...signedHeaders(token, method, url, body, String(f.now())),
      },
      ...(payload === undefined ? {} : { payload: body }),
    });
  };
  f.advance(95_000);
  assert.equal((await runtime('POST', '/api/runtime/heartbeat', { sequence: 1 })).statusCode, 200);
  const created = await runtime('POST', '/api/runtime/requests', {
    providerId: f.provider.id,
    input: 'Synthetic contact hello@example.test',
    idempotencyKey: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().job.id;
  assert.equal(created.json().job.status, 'queued');
  const url = `/api/runtime/requests/${id}`;
  const invalid = await f.app.inject({
    url,
    headers: { host: 'city.example.com', authorization: `Bearer ${token}` },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal((await f.stored()).jobs[0]!.status, 'queued');
  assert.equal((await runtime('GET', url)).json().job.status, 'running');
  const result = await runtime('GET', url);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().job.status, 'completed');
  assert.equal(result.json().job.acceptance, 'pending');
  const a2aPath = `/api/runtime/a2a/${f.provider.id}`;
  const rpc = (method: string, params: unknown) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
    return f.app.inject({
      method: 'POST',
      url: a2aPath,
      payload: body,
      headers: {
        host: 'city.example.com',
        ...signedHeaders(token, 'POST', a2aPath, body, String(f.now())),
        'a2a-version': '1.0',
        'a2a-extensions': 'urn:central-city:a2a:native-auth:1',
      },
    });
  };
  const send = () =>
    rpc('SendMessage', {
      message: {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: 'Synthetic amount 42' }],
      },
      configuration: { returnImmediately: true },
    });
  const sent = await send();
  assert.equal(sent.statusCode, 200, sent.body);
  const taskId = sent.json().result.task.id;
  assert.equal(
    (await rpc('GetTask', { id: taskId })).json().result.status.state,
    'TASK_STATE_WORKING',
  );
  assert.equal(
    (await rpc('GetTask', { id: taskId })).json().result.status.state,
    'TASK_STATE_COMPLETED',
  );
  const canceledTask = (await send()).json().result.task.id;
  assert.equal(
    (await rpc('GetTask', { id: canceledTask })).json().result.status.state,
    'TASK_STATE_WORKING',
  );
  assert.equal(
    (await rpc('CancelTask', { id: canceledTask })).json().result.status.state,
    'TASK_STATE_CANCELED',
  );
  assert.equal(
    (await rpc('GetTask', { id: canceledTask })).json().result.status.state,
    'TASK_STATE_CANCELED',
  );
  await f.app.inject({
    method: 'DELETE',
    url: `/api/connections/${connection.json().connection.id}`,
    headers: { ...headers, cookie: f.owner.cookie },
  });
  assert.equal((await runtime('GET', url)).statusCode, 403);
});
