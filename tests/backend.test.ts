import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { signedHeaders } from '../connector/signing.js';
import type { Agent, Job, Snapshot } from '../shared/types.js';

type App = Awaited<ReturnType<typeof createApp>>;
const browserHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const password = 'correct horse battery staple!';

async function account(app: App, name: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: browserHeaders,
    payload: { name, password },
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 201, response.body);
  const cookies = response.cookies;
  const session = cookies.find((cookie) => cookie.name === 'cc_session');
  assert.ok(session, 'registration sets a session cookie');
  assert.ok(session.httpOnly, 'session cookie cannot be read from browser JavaScript');
  return { cookie: `cc_session=${session.value}`, operator: response.json().operator };
}

async function api(
  app: App,
  cookie: string,
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { ...browserHeaders, cookie },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function runtime(
  app: App,
  token: string,
  now: number,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return app.inject({
    method,
    url,
    headers: signedHeaders(token, method, url, body, String(now)),
    ...(method === 'POST' ? { payload: body } : {}),
  });
}

async function external(
  app: App,
  cookie: string,
  name: string,
  capability: 'research' | 'extract' | 'verify' = 'extract',
) {
  const response = await api(app, cookie, 'POST', '/api/agents', {
    name,
    description: 'Synthetic verification agent',
    capability,
    mode: 'external',
  });
  assert.ok([200, 201].includes(response.statusCode), response.body);
  const value = response.json() as { agent: Agent; token: string };
  assert.equal(typeof value.token, 'string');
  return value;
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  let now = 1_800_000_000_000;
  const app = await createApp({ dataDir: 'memory://', now: () => now, startWorkers: false });
  t.after(() => app.close());
  const owner = await account(app, 'First operator');
  const requester = await external(app, owner.cookie, 'Requester', 'research');
  const provider = await external(app, owner.cookie, 'Provider');
  for (const identity of [requester, provider]) {
    const response = await runtime(app, identity.token, now, 'POST', '/api/runtime/heartbeat', {
      sequence: 1,
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const connection = await api(app, owner.cookie, 'POST', '/api/connections', {
    fromAgentId: requester.agent.id,
    toAgentId: provider.agent.id,
  });
  assert.ok([200, 201].includes(connection.statusCode), connection.body);
  return {
    app,
    owner,
    requester,
    provider,
    connection: connection.json().connection,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    async submit(
      key = randomBytes(8).toString('hex'),
      input = 'Client: Northwind\nRevenue: $123.45\nhttps://example.com/report',
    ) {
      return api(app, owner.cookie, 'POST', '/api/jobs', {
        requesterId: requester.agent.id,
        providerId: provider.agent.id,
        input,
        idempotencyKey: key,
      });
    },
    async snapshot() {
      const response = await api(app, owner.cookie, 'GET', '/api/snapshot');
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as Snapshot;
    },
  };
}

test('each operator sees and mutates only their own workspace', async (t) => {
  const f = await fixture(t);
  const other = await account(f.app, 'Other operator');
  const snapshot = await api(f.app, other.cookie, 'GET', '/api/snapshot');
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.json().agents, []);
  assert.deepEqual(snapshot.json().jobs, []);
  const revoke = await api(
    f.app,
    other.cookie,
    'POST',
    `/api/agents/${f.provider.agent.id}/revoke`,
    {},
  );
  assert.ok([403, 404].includes(revoke.statusCode));
  const connect = await api(f.app, other.cookie, 'POST', '/api/connections', {
    fromAgentId: f.requester.agent.id,
    toAgentId: f.provider.agent.id,
  });
  assert.ok([403, 404].includes(connect.statusCode));
  const created = await f.submit();
  assert.ok([200, 201].includes(created.statusCode));
  const cancel = await api(
    f.app,
    other.cookie,
    'POST',
    `/api/jobs/${created.json().job.id}/cancel`,
    {},
  );
  assert.ok([403, 404].includes(cancel.statusCode));
  const serialized = JSON.stringify(await f.snapshot());
  assert.ok(!serialized.includes(f.provider.token));
  assert.ok(!serialized.includes(password));
  assert.ok(!/password_hash|token_hash|session_hash/.test(serialized));
});

test('a runtime body the JSON parser did not read is refused before its signature is checked', async (t) => {
  const f = await fixture(t);
  const path = '/api/runtime/heartbeat';
  const body = JSON.stringify({ sequence: 2 });
  const nonce = randomBytes(18).toString('hex');
  // Signed over the empty body, sent as text/plain: the body would not be covered.
  const unbound = await f.app.inject({
    method: 'POST',
    url: path,
    headers: {
      ...signedHeaders(f.provider.token, 'POST', path, '', String(f.now()), nonce),
      'Content-Type': 'text/plain',
    },
    payload: body,
  });
  assert.equal(unbound.statusCode, 415, unbound.body);
  // The refusal used no nonce: the same nonce still signs the JSON request.
  const accepted = await f.app.inject({
    method: 'POST',
    url: path,
    headers: signedHeaders(f.provider.token, 'POST', path, body, String(f.now()), nonce),
    payload: body,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
});

test('bad signature, expired timestamp, reused nonce and old sequence never extend presence', async (t) => {
  const f = await fixture(t);
  const path = '/api/runtime/heartbeat';
  const body = JSON.stringify({ sequence: 2 });
  const validHeaders = signedHeaders(f.provider.token, 'POST', path, body, String(f.now()));
  const tampered = await f.app.inject({
    method: 'POST',
    url: path,
    headers: validHeaders,
    payload: JSON.stringify({ sequence: 3 }),
  });
  assert.ok([400, 401, 403].includes(tampered.statusCode));
  const expired = await f.app.inject({
    method: 'POST',
    url: path,
    headers: signedHeaders(f.provider.token, 'POST', path, body, String(f.now() - 61_000)),
    payload: body,
  });
  assert.ok([400, 401, 403].includes(expired.statusCode));
  const accepted = await f.app.inject({
    method: 'POST',
    url: path,
    headers: validHeaders,
    payload: body,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  f.advance(30_000);
  const replayed = await f.app.inject({
    method: 'POST',
    url: path,
    headers: validHeaders,
    payload: body,
  });
  assert.ok([401, 403, 409].includes(replayed.statusCode));
  const oldSequence = await runtime(f.app, f.provider.token, f.now(), 'POST', path, {
    sequence: 1,
  });
  assert.ok([400, 409].includes(oldSequence.statusCode));
  f.advance(61_000);
  await f.app.city.tick();
  const snapshot = await f.snapshot();
  assert.equal(
    snapshot.agents.find((agent) => agent.id === f.provider.agent.id)?.status,
    'offline',
  );
  assert.equal(snapshot.stats.reachable, 0);
  assert.equal(
    snapshot.stats.registered,
    2,
    'multiple sessions cannot inflate registered identities',
  );
});

test('revocation invalidates heartbeat, polling and outstanding result authorization', async (t) => {
  const f = await fixture(t);
  const submitted = await f.submit();
  assert.ok([200, 201].includes(submitted.statusCode));
  const claim = await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs');
  assert.equal(claim.statusCode, 200, claim.body);
  const { job, leaseToken } = claim.json();
  const revoked = await api(
    f.app,
    f.owner.cookie,
    'POST',
    `/api/agents/${f.provider.agent.id}/revoke`,
    {},
  );
  assert.equal(revoked.statusCode, 200);
  const responses = [
    await runtime(f.app, f.provider.token, f.now(), 'POST', '/api/runtime/heartbeat', {
      sequence: 2,
    }),
    await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs'),
    await runtime(f.app, f.provider.token, f.now(), 'POST', `/api/runtime/jobs/${job.id}/result`, {
      leaseToken,
      output: { result: 'forbidden' },
    }),
  ];
  responses.forEach((response) =>
    assert.ok([401, 403].includes(response.statusCode), response.body),
  );
  const snapshot = await f.snapshot();
  assert.equal(
    snapshot.agents.find((agent) => agent.id === f.provider.agent.id)?.status,
    'revoked',
  );
  assert.equal(snapshot.jobs[0]?.output, null);
});

test('input and body limits reject oversized jobs before creating work', async (t) => {
  const f = await fixture(t);
  for (const input of ['', ' '.repeat(20), 'x'.repeat(12_001)]) {
    const response = await f.submit(undefined, input);
    assert.equal(response.statusCode, 400, response.body);
  }
  const huge = await f.submit(undefined, 'x'.repeat(70_000));
  assert.equal(huge.statusCode, 413);
  assert.equal((await f.snapshot()).jobs.length, 0);
});

test('job idempotency returns one job and rejects key reuse with changed work', async (t) => {
  const f = await fixture(t);
  const first = await f.submit('stable-job-key', 'Quarter: Q1');
  assert.ok([200, 201].includes(first.statusCode), first.body);
  const duplicate = await f.submit('stable-job-key', 'Quarter: Q1');
  assert.ok([200, 201].includes(duplicate.statusCode), duplicate.body);
  assert.equal(duplicate.json().job.id, first.json().job.id);
  const changed = await f.submit('stable-job-key', 'Quarter: Q2');
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal((await f.snapshot()).jobs.length, 1);
});

test('directional permission is required, and removal blocks a claimed result', async (t) => {
  const f = await fixture(t);
  const reversed = await api(f.app, f.owner.cookie, 'POST', '/api/jobs', {
    requesterId: f.provider.agent.id,
    providerId: f.requester.agent.id,
    input: 'Reverse direction is not authorized',
    idempotencyKey: 'reverse-direction',
  });
  assert.ok([403, 409].includes(reversed.statusCode), reversed.body);
  await f.submit();
  const claim = await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs');
  const { job, leaseToken } = claim.json();
  assert.ok(job && leaseToken);
  const removed = await api(f.app, f.owner.cookie, 'DELETE', `/api/connections/${f.connection.id}`);
  assert.equal(removed.statusCode, 200, removed.body);
  const result = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${job.id}/result`,
    { leaseToken, output: { text: 'late' } },
  );
  assert.ok([403, 409].includes(result.statusCode), result.body);
  const resubmitted = await f.submit();
  assert.ok([400, 403, 409].includes(resubmitted.statusCode));
  assert.equal((await f.snapshot()).jobs[0]?.output, null);
});

test('a canceled job cannot be overwritten by a late or repeated provider result', async (t) => {
  const f = await fixture(t);
  await f.submit();
  const claim = await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs');
  const { job, leaseToken } = claim.json();
  const canceled = await api(f.app, f.owner.cookie, 'POST', `/api/jobs/${job.id}/cancel`, {});
  assert.equal(canceled.statusCode, 200, canceled.body);
  assert.equal(canceled.json().job.status, 'canceled');
  const result = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${job.id}/result`,
    { leaseToken, output: { text: 'completed too late' } },
  );
  assert.equal(result.statusCode, 409, result.body);
  const stored = (await f.snapshot()).jobs.find((item) => item.id === job.id);
  assert.equal(stored?.status, 'canceled');
  assert.equal(stored?.output, null);
  assert.equal(stored?.acceptance, 'pending');
});

test('completion, result idempotency and explicit acceptance are separate', async (t) => {
  const f = await fixture(t);
  const submitted = await f.submit();
  const id = submitted.json().job.id;
  const earlyAccept = await api(f.app, f.owner.cookie, 'POST', `/api/jobs/${id}/accept`, {});
  assert.equal(earlyAccept.statusCode, 409);
  const wrongAgent = await runtime(f.app, f.requester.token, f.now(), 'GET', '/api/runtime/jobs');
  assert.equal(wrongAgent.json().job, null, 'requester may not claim provider work');
  const claimed = await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs');
  const { leaseToken } = claimed.json();
  const output = { execution: 'test-native', extracted: { client: 'Northwind', amount: 123.45 } };
  const complete = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${id}/result`,
    { leaseToken, output },
  );
  assert.equal(complete.statusCode, 200, complete.body);
  assert.equal(complete.json().job.status, 'completed');
  assert.equal(complete.json().job.acceptance, 'pending');
  // Finished: canceling it is refused rather than reported as done.
  const lateCancel = await api(f.app, f.owner.cookie, 'POST', `/api/jobs/${id}/cancel`, {});
  assert.equal(lateCancel.statusCode, 409, lateCancel.body);
  const duplicate = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${id}/result`,
    { leaseToken, output },
  );
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  const conflict = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${id}/result`,
    { leaseToken, output: { changed: true } },
  );
  assert.equal(conflict.statusCode, 409, conflict.body);
  const accepted = await api(f.app, f.owner.cookie, 'POST', `/api/jobs/${id}/accept`, {});
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().job.acceptance, 'accepted');
  assert.equal(
    accepted.json().job.costCents,
    null,
    'external execution cost is unknown, never fabricated as zero',
  );
});

test('future-dated signatures cannot be replayed at the timestamp tolerance boundary', async (t) => {
  const f = await fixture(t);
  const url = '/api/runtime/jobs';
  const timestamp = String(f.now() + 60_000);
  const headers = signedHeaders(f.provider.token, 'GET', url, '', timestamp);
  const first = await f.app.inject({ method: 'GET', url, headers });
  assert.equal(first.statusCode, 200, first.body);
  f.advance(120_000);
  const heartbeat = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    '/api/runtime/heartbeat',
    { sequence: 2 },
  );
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);
  const replay = await f.app.inject({ method: 'GET', url, headers });
  assert.ok(
    [401, 403, 409].includes(replay.statusCode),
    'a nonce remains protected throughout the inclusive timestamp tolerance window',
  );
  const fresh = await f.app.inject({
    method: 'GET',
    url,
    headers: signedHeaders(f.provider.token, 'GET', url, '', timestamp),
  });
  assert.equal(fresh.statusCode, 200, fresh.body);
});

test('agent-initiated peer requests derive identity, obey grants, and retain explicit acceptance', async (t) => {
  const f = await fixture(t);
  const hostedResponse = await api(f.app, f.owner.cookie, 'POST', '/api/agents', {
    name: 'Hosted extraction peer',
    description: 'Deterministic test peer',
    capability: 'extract',
    mode: 'hosted',
  });
  assert.ok([200, 201].includes(hostedResponse.statusCode), hostedResponse.body);
  const hosted = hostedResponse.json().agent;
  const permission = await api(f.app, f.owner.cookie, 'POST', '/api/connections', {
    fromAgentId: f.requester.agent.id,
    toAgentId: hosted.id,
  });
  assert.ok([200, 201].includes(permission.statusCode));
  await f.app.city.tick();
  const input = {
    providerId: hosted.id,
    input: 'Client: Northwind\nRevenue: $123.45',
    idempotencyKey: 'native-peer-request',
  };
  const impersonation = await runtime(
    f.app,
    f.requester.token,
    f.now(),
    'POST',
    '/api/runtime/requests',
    { ...input, requesterId: f.provider.agent.id },
  );
  assert.equal(impersonation.statusCode, 400, impersonation.body);
  const forbiddenExternal = await runtime(
    f.app,
    f.requester.token,
    f.now(),
    'POST',
    '/api/runtime/requests',
    { ...input, providerId: f.provider.agent.id },
  );
  assert.equal(forbiddenExternal.statusCode, 403, forbiddenExternal.body);
  const created = await runtime(
    f.app,
    f.requester.token,
    f.now(),
    'POST',
    '/api/runtime/requests',
    input,
  );
  assert.ok([200, 201].includes(created.statusCode), created.body);
  assert.equal(created.json().job.requesterId, f.requester.agent.id);
  const id = created.json().job.id;
  const duplicate = await runtime(
    f.app,
    f.requester.token,
    f.now(),
    'POST',
    '/api/runtime/requests',
    input,
  );
  assert.equal(duplicate.json().job.id, id);
  const wrongCredential = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'GET',
    `/api/runtime/requests/${id}`,
  );
  assert.ok([403, 404].includes(wrongCredential.statusCode), wrongCredential.body);
  await f.app.city.tick();
  await f.app.city.tick();
  const result = await runtime(
    f.app,
    f.requester.token,
    f.now(),
    'GET',
    `/api/runtime/requests/${id}`,
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().job.status, 'completed');
  assert.equal(result.json().job.acceptance, 'pending');
  assert.equal(result.json().job.costCents, 0);
  assert.ok(result.json().job.output);
  await api(f.app, f.owner.cookie, 'DELETE', `/api/connections/${permission.json().connection.id}`);
  const revoked = await runtime(
    f.app,
    f.requester.token,
    f.now(),
    'GET',
    `/api/runtime/requests/${id}`,
  );
  assert.ok([403, 404].includes(revoked.statusCode), revoked.body);
});

test('active-job bound, workspace pause and output limits are enforced', async (t) => {
  const f = await fixture(t);
  assert.ok([200, 201].includes((await f.submit()).statusCode));
  assert.ok([200, 201].includes((await f.submit()).statusCode));
  const third = await f.submit();
  assert.ok([409, 429].includes(third.statusCode));
  const pause = await api(f.app, f.owner.cookie, 'POST', '/api/workspace/pause', { paused: true });
  assert.equal(pause.statusCode, 200);
  const pausedClaim = await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs');
  assert.equal(pausedClaim.json().job, null);
  await api(f.app, f.owner.cookie, 'POST', '/api/workspace/pause', { paused: false });
  const claim = await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs');
  const { job, leaseToken } = claim.json();
  const oversized = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${job.id}/result`,
    { leaseToken, output: { text: 'x'.repeat(33 * 1024) } },
  );
  assert.ok([400, 413].includes(oversized.statusCode), oversized.body);
  const arrayOutput = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${job.id}/result`,
    { leaseToken, output: [] },
  );
  assert.equal(arrayOutput.statusCode, 400, arrayOutput.body);
  assert.equal((await f.snapshot()).jobs.find((item) => item.id === job.id)?.output, null);
});

test('expired compute leases can recover but stale lease results cannot commit', async (t) => {
  const f = await fixture(t);
  await f.submit();
  const first = (
    await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs')
  ).json();
  f.advance(61_000);
  await f.app.city.tick();
  const next = (await runtime(f.app, f.provider.token, f.now(), 'GET', '/api/runtime/jobs')).json();
  assert.equal(next.job.id, first.job.id);
  assert.notEqual(next.leaseToken, first.leaseToken);
  const stale = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${first.job.id}/result`,
    { leaseToken: first.leaseToken, output: { stale: true } },
  );
  assert.equal(stale.statusCode, 409, stale.body);
  const fresh = await runtime(
    f.app,
    f.provider.token,
    f.now(),
    'POST',
    `/api/runtime/jobs/${next.job.id}/result`,
    { leaseToken: next.leaseToken, output: { fresh: true } },
  );
  assert.equal(fresh.statusCode, 200, fresh.body);
});

test('unauthenticated reads and cross-origin browser mutations are rejected', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ url: '/api/snapshot' })).statusCode, 401);
  const crossOrigin = await f.app.inject({
    method: 'POST',
    url: '/api/workspace/pause',
    headers: { ...browserHeaders, cookie: f.owner.cookie, origin: 'https://outside.invalid' },
    payload: { paused: true },
  });
  assert.equal(crossOrigin.statusCode, 403);
  const missingHeader = await f.app.inject({
    method: 'POST',
    url: '/api/workspace/pause',
    headers: { cookie: f.owner.cookie },
    payload: { paused: true },
  });
  assert.equal(missingHeader.statusCode, 403);
  assert.equal((await f.snapshot()).paused, false);
});

test(
  'live stream sends only invalidations and closes on logout and application shutdown',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const baseUrl = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { cookie: f.owner.cookie },
      signal: AbortSignal.timeout(8_000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value!).toString(), /event: invalidate/);
    const paused = await api(f.app, f.owner.cookie, 'POST', '/api/workspace/pause', {
      paused: true,
    });
    assert.equal(paused.statusCode, 200);
    const update = Buffer.from((await reader.read()).value!).toString();
    assert.match(update, /event: invalidate/);
    assert.ok(!update.includes(f.provider.token));
    assert.ok(!update.includes('input'));
    const logout = await api(f.app, f.owner.cookie, 'POST', '/api/auth/logout', {});
    assert.equal(logout.statusCode, 200);
    assert.equal((await reader.read()).done, true, 'logout closes the authenticated stream');
    reader.releaseLock();
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: browserHeaders,
      payload: { name: 'First operator', password },
    });
    assert.equal(login.statusCode, 200);
    const cookie = `cc_session=${login.cookies.find((item) => item.name === 'cc_session')?.value}`;
    const next = await fetch(`${baseUrl}/api/events`, {
      headers: { cookie },
      signal: AbortSignal.timeout(8_000),
    });
    const nextReader = next.body!.getReader();
    await nextReader.read();
    await f.app.close();
    assert.equal(
      (await nextReader.read()).done,
      true,
      'server shutdown closes active streams rather than hanging',
    );
    nextReader.releaseLock();
  },
);

test('operator, agents, authorization and pending jobs persist across application restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'central-city-persistence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const first = await createApp({ dataDir: directory, now: () => now, startWorkers: false });
  const owner = await account(first, 'Persistent operator');
  const requester = await external(first, owner.cookie, 'Persistent requester');
  const provider = await external(first, owner.cookie, 'Persistent provider');
  for (const agent of [requester, provider])
    assert.equal(
      (await runtime(first, agent.token, now, 'POST', '/api/runtime/heartbeat', { sequence: 1 }))
        .statusCode,
      200,
    );
  await api(first, owner.cookie, 'POST', '/api/connections', {
    fromAgentId: requester.agent.id,
    toAgentId: provider.agent.id,
  });
  const created = await api(first, owner.cookie, 'POST', '/api/jobs', {
    requesterId: requester.agent.id,
    providerId: provider.agent.id,
    input: 'Persist this work',
    idempotencyKey: 'restart-job',
  });
  assert.ok([200, 201].includes(created.statusCode), created.body);
  const id = created.json().job.id;
  await first.close();
  const second = await createApp({
    dataDir: directory,
    now: () => now + 1_000,
    startWorkers: false,
  });
  t.after(() => second.close());
  const login = await second.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: browserHeaders,
    payload: { name: 'Persistent operator', password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = `cc_session=${login.cookies.find((item) => item.name === 'cc_session')?.value}`;
  const snapshot = await api(second, cookie, 'GET', '/api/snapshot');
  assert.equal(snapshot.json().agents.length, 2);
  assert.equal(snapshot.json().jobs[0].id, id);
  const oldSequence = await runtime(
    second,
    provider.token,
    now + 1_000,
    'POST',
    '/api/runtime/heartbeat',
    { sequence: 1 },
  );
  assert.equal(oldSequence.statusCode, 409, oldSequence.body);
  const heartbeat = await runtime(
    second,
    provider.token,
    now + 1_000,
    'POST',
    '/api/runtime/heartbeat',
    { sequence: 2 },
  );
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);
  const claim = await runtime(second, provider.token, now + 1_000, 'GET', '/api/runtime/jobs');
  assert.equal(claim.json().job.id, id);
});
