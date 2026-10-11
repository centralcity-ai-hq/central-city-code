import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Agent } from '../shared/types.js';
import type { ProviderRequest } from '../server/responder/providers.js';

/**
 * Hosted responder console routes, wired in server/app.ts behind CITY_RESPONDER=1: only the signed-in owner,
 * write-only keys over HTTP, the flag, and the 502/503 pass-through. A fake provider transport
 * (no network); low-entropy placeholder keys only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const FAKE_OPENAI = 'sk-proj-test-openai-placeholder-0000';
const FAKE_ANTHROPIC = 'sk-ant-api03-test-anthropic-placeholder-0000';
const SONNET = 'claude-sonnet-5';

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { enabled?: boolean; env?: Record<string, string> } = {},
) {
  const calls: ProviderRequest[] = [];
  const state = { status: 200, fail: false };
  const lines: string[] = [];
  const app: App = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    logLine: (line) => lines.push(line),
    responder: {
      enabled: options.enabled ?? true,
      env: options.env ?? { CITY_RESPONDER_KEK: randomBytes(32).toString('base64') },
      transport: async (request) => {
        calls.push(request);
        if (state.fail) throw new Error(`network ${JSON.stringify(request.headers)}`);
        return { status: state.status };
      },
    },
  });
  t.after(() => app.close());
  const bodies: string[] = [];
  const register = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password: `Synthetic route password ${name}` }),
    });
    assert.equal(res.statusCode, 201, res.body);
    return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  };
  const cookie = await register('Route owner');
  const call = async (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    body?: unknown,
    as: string = cookie,
    extra: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...jsonHeaders, ...(as ? { cookie: as } : {}), ...extra },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    bodies.push(res.body);
    return res;
  };
  const agentRes = await call('POST', '/api/agents', {
    name: 'Route agent',
    description: 'Synthetic responder agent',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(agentRes.statusCode, 201, agentRes.body);
  const agent = (agentRes.json() as { agent: Agent }).agent;
  return { app, agent, call, register, calls, bodies, lines, state };
}

function assertNeverShown(haystacks: string[], secret: string) {
  for (const text of haystacks)
    for (const part of [secret, secret.slice(0, 16), secret.slice(-8)])
      assert.equal(text.includes(part), false, `found key material: ${text.slice(0, 120)}`);
}

test('the owner sets a key and turns auto-reply on over HTTP; the key is never returned', async (t) => {
  const { agent, call, calls, bodies, lines } = await setup(t);
  const url = `/api/agents/${agent.id}/responder`;
  const models = await call('GET', '/api/responder/models?provider=anthropic');
  assert.equal(models.statusCode, 200, models.body);
  assert.equal(
    models.json().models.find((model: { default: boolean }) => model.default).id,
    SONNET,
  );
  const saved = await call('POST', `${url}/key`, { provider: 'anthropic', key: FAKE_ANTHROPIC });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(Object.keys(saved.json().key).sort(), [
    'added_at',
    'provider',
    'status',
    'validated_at',
  ]);
  assert.equal(calls[0]!.url, `https://api.anthropic.com/v1/models/${SONNET}`);
  const on = await call('PUT', url, { enabled: true, daily_reply_cap: 1000 });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().status, 'active');
  assert.equal(on.json().replies_available, true);
  // Unknown fields and out-of-range caps are refused by the route schema.
  assert.equal((await call('PUT', url, { daily_reply_cap: 1001 })).statusCode, 400);
  assert.equal((await call('PUT', url, { provider: 'openai' })).statusCode, 400);
  const bad = await call('POST', `${url}/key`, {
    provider: 'anthropic',
    key: FAKE_ANTHROPIC,
    extra: 1,
  });
  assert.equal(bad.statusCode, 400);
  const off = await call('DELETE', `${url}/key`, {});
  assert.deepEqual(off.json(), { agent_id: agent.id, removed: true });
  const events = (await call('GET', '/api/snapshot')).json().events as { type: string }[];
  for (const type of ['responder.key_set', 'responder.enabled', 'responder.key_removed'])
    assert.ok(
      events.some((item) => item.type === type),
      type,
    );
  assertNeverShown([...bodies, ...lines], FAKE_ANTHROPIC);
});

test('provider answers map to fixed codes; unreachable is a 502 that passes the error handler', async (t) => {
  const { agent, call, bodies, state } = await setup(t);
  const url = `/api/agents/${agent.id}/responder/key`;
  state.status = 401;
  let res = await call('POST', url, { provider: 'openai', key: FAKE_OPENAI });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'invalid_key');
  state.fail = true;
  res = await call('POST', url, { provider: 'openai', key: FAKE_OPENAI });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, 'provider_unreachable');
  res = await call('POST', url, { provider: 'openai', key: `sk-admin-test-placeholder-0000` });
  assert.equal(res.json().code, 'unsupported_key');
  assertNeverShown(bodies, FAKE_OPENAI);
});

test('only the signed-in owner: no session, another owner and bearer credentials are refused', async (t) => {
  const { agent, call, register } = await setup(t);
  const url = `/api/agents/${agent.id}/responder`;
  assert.equal((await call('GET', url, undefined, '')).statusCode, 401);
  assert.equal((await call('GET', '/api/responder/models', undefined, '')).statusCode, 401);
  const other = await register('Someone else');
  assert.equal((await call('GET', url, undefined, other)).statusCode, 404);
  assert.equal(
    (await call('POST', `${url}/key`, { provider: 'openai', key: FAKE_OPENAI }, other)).statusCode,
    404,
  );
  // OAuth grants and workspace keys authenticate with bearer tokens, never a console session.
  const bearer = await call('POST', `${url}/key`, { provider: 'openai', key: FAKE_OPENAI }, '', {
    authorization: 'Bearer ccw_placeholder',
  });
  assert.equal(bearer.statusCode, 401);
  // Console mutations still need the request protection header.
  const unprotected = await call('PUT', url, { enabled: false }, undefined, {
    'x-city-request': '0',
  });
  assert.equal(unprotected.statusCode, 403);
});

test('key saves are rate limited per owner through the shared limiter', async (t) => {
  const { agent, call, state } = await setup(t);
  state.status = 401;
  for (let index = 0; index < 10; index++)
    assert.equal(
      (
        await call('POST', `/api/agents/${agent.id}/responder/key`, {
          provider: 'openai',
          key: FAKE_OPENAI,
        })
      ).json().code,
      'invalid_key',
    );
  const res = await call('POST', `/api/agents/${agent.id}/responder/key`, {
    provider: 'openai',
    key: FAKE_OPENAI,
  });
  assert.equal(res.statusCode, 429);
});

test('off by default: no routes without CITY_RESPONDER=1', async (t) => {
  const { agent, call } = await setup(t, { enabled: false });
  assert.equal((await call('GET', `/api/agents/${agent.id}/responder`)).statusCode, 404);
  assert.equal((await call('GET', '/api/responder/models')).statusCode, 404);
});

test('without a valid root key the routes answer 503 and log the reason, not the value', async (t) => {
  const { agent, call, lines } = await setup(t, { env: { CITY_RESPONDER_KEK: 'not-32-bytes' } });
  const res = await call('POST', `/api/agents/${agent.id}/responder/key`, {
    provider: 'openai',
    key: FAKE_OPENAI,
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'responder_unavailable');
  assert.ok(lines.includes('responder.unavailable reason=invalid'));
  assert.equal(lines.join('\n').includes('not-32-bytes'), false);
});

test("answering: Auto-reply on with a working key, or a connected runtime; another owner's agent is refused", async (t) => {
  const { app, agent, call, register } = await setup(t);
  const url = `/api/agents/${agent.id}/answering`;
  const read = async () => {
    const res = await call('GET', url);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  // A new external agent: no Auto-reply, never connected.
  assert.deepEqual(await read(), {
    agent_id: agent.id,
    can: false,
    by: null,
    auto_reply: 'none',
    runtime_connected: false,
    scripted: false,
  });
  // A working key, then on: it answers through Auto-reply.
  const key = await call('POST', `/api/agents/${agent.id}/responder/key`, {
    provider: 'anthropic',
    key: FAKE_ANTHROPIC,
  });
  assert.equal(key.statusCode, 200, key.body);
  assert.equal((await read()).auto_reply, 'off');
  assert.equal(
    (await call('PUT', `/api/agents/${agent.id}/responder`, { enabled: true })).statusCode,
    200,
  );
  assert.deepEqual(await read(), {
    agent_id: agent.id,
    can: true,
    by: 'auto_reply',
    auto_reply: 'on',
    runtime_connected: false,
    scripted: false,
  });
  // A key the provider no longer accepts leaves Auto-reply on but not answering: paused.
  await app.city.db.query("UPDATE responder_credentials SET status='invalid' WHERE agent_id=$1", [
    agent.id,
  ]);
  assert.deepEqual(
    { can: (await read()).can, auto_reply: (await read()).auto_reply },
    { can: false, auto_reply: 'paused' },
  );
  // Its runtime connected (seen just now): it answers itself.
  const seen = (at: number) =>
    app.city.db.query(
      `INSERT INTO agent_presence(agent_id, operator_id, last_seen_at, sequence, updated_at)
       SELECT $1, operator_id, $2, 1, $2 FROM workspaces
        WHERE data->'agents' @> jsonb_build_array(jsonb_build_object('id', $1::text))
       ON CONFLICT (agent_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,
      [agent.id, at],
    );
  await seen(Date.now());
  const live = await read();
  assert.equal(live.runtime_connected, true, JSON.stringify(live));
  assert.deepEqual(
    { can: live.can, by: live.by, scripted: live.scripted },
    { can: true, by: 'runtime', scripted: false },
  );
  // Seen longer ago than the presence window: not connected any more.
  await seen(Date.now() - 10 * 60_000);
  assert.equal((await read()).runtime_connected, false);
  // Only the owner: another owner gets the uniform 404, no session is refused.
  const other = await register('Other answering owner');
  assert.equal((await call('GET', url, undefined, other)).statusCode, 404);
  assert.ok((await call('GET', url, undefined, '')).statusCode >= 401);
});

/*
 * Regression (live, 11 Oct): the owner's room host "Lion", a CC agent (hosted, isDemo: "Create a
 * CC agent", or the host New room makes), answered can:true by:'runtime' once its synthetic
 * heartbeat was fresh, so "Lion can't reply here yet" was hidden under "hey @Lion", although its
 * scripted runtime never posts in a room or a chat. Its heartbeat is reported, never counted.
 */
test("answering: a CC agent's scripted runtime never answers; only its Auto-reply does", async (t) => {
  const { app, call } = await setup(t);
  const created = await call('POST', '/api/agents', {
    name: 'Lion',
    description: 'Synthetic CC agent',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(created.statusCode, 201, created.body);
  const lion = (created.json() as { agent: Agent }).agent;
  assert.deepEqual({ mode: lion.mode, isDemo: lion.isDemo }, { mode: 'hosted', isDemo: true });
  const url = `/api/agents/${lion.id}/answering`;
  const read = async () => {
    const res = await call('GET', url);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  // The platform's own tick refreshes the hosted heartbeat (server/app.ts refreshPresence).
  await app.city.tick();
  const snapshot = await call('GET', '/api/snapshot');
  const stored = (snapshot.json() as { agents: Agent[] }).agents.find((a) => a.id === lion.id)!;
  assert.ok(stored.lastSeenAt, 'the scripted runtime has a fresh heartbeat');
  // Connected, truthfully, but it can't answer: the exact shape the console now gets.
  assert.deepEqual(await read(), {
    agent_id: lion.id,
    can: false,
    by: null,
    auto_reply: 'none',
    runtime_connected: true,
    scripted: true,
  });
  // A key, Auto-reply still off: it still can't answer.
  const key = await call('POST', `/api/agents/${lion.id}/responder/key`, {
    provider: 'anthropic',
    key: FAKE_ANTHROPIC,
  });
  assert.equal(key.statusCode, 200, key.body);
  assert.deepEqual(
    { can: (await read()).can, auto_reply: (await read()).auto_reply },
    { can: false, auto_reply: 'off' },
  );
  // Auto-reply on and working: it answers, through Auto-reply.
  assert.equal(
    (await call('PUT', `/api/agents/${lion.id}/responder`, { enabled: true })).statusCode,
    200,
  );
  assert.deepEqual(await read(), {
    agent_id: lion.id,
    can: true,
    by: 'auto_reply',
    auto_reply: 'on',
    runtime_connected: true,
    scripted: true,
  });
});
