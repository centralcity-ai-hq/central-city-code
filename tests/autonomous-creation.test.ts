import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assertHostedSecret, createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import { verifyAgentCard, type AgentCard } from '../server/manifest/agent-card.js';
import type { Jwks } from '../server/manifest/keys.js';
import { loadPlatformSigner, parseSigningKey } from '../server/autonomy/signing.js';
import { highEntropyKey, UNCLAIMED_HOLD_TTL_MS } from '../server/autonomy/index.js';
import { listTop, parseAdminArgs, purge, reconcile } from '../server/autonomy/admin.js';
import { clientAddressKey } from '../server/rate-limit.js';
import { signedHeaders } from '../connector/signing.js';
import type { Snapshot } from '../shared/types.js';
import {
  consent,
  fixture,
  fullFlow,
  mcpCall,
  OWNER,
  ownerApi,
  PASSWORD,
  rpcResult,
  TestProvider,
  type App,
} from './oauth-helpers.js';

const SCOPES = [
  'workspace:read',
  'agents:create',
  'jobs:create',
  'jobs:cancel',
  'connections:create',
  'agents:control',
];
const TEAM = 'template:research-team@1.0.0';
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

type ToolResult = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
async function tool(
  app: App,
  token: string | null,
  name: string,
  args: unknown,
  remoteAddress = '127.0.0.1',
): Promise<ToolResult> {
  const res = await app.inject({
    method: 'POST',
    // Anonymous calls use the open endpoint; /mcp requires OAuth for everything.
    url: token ? '/mcp' : '/mcp/open',
    remoteAddress,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return rpcResult(res.body).result as ToolResult;
}
const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0]!.text).error as {
    code: string;
    message: string;
    issues?: { code: string; path: string }[];
  };
};
const ok = (result: ToolResult) => {
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
};
async function ownerGrant(app: App, scopes = SCOPES) {
  const { tokens } = await fullFlow(app, {
    scope: scopes.join(' '),
    scopes: scopes.filter((scope) => scope !== 'workspace:read'),
  });
  return tokens.access_token;
}
async function snapshot(app: App, cookie: string): Promise<Snapshot> {
  const res = await ownerApi(app, cookie, '/api/snapshot');
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Snapshot;
}
async function register(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name, password: PASSWORD }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
}
async function count(app: App, sql: string, params: unknown[] = []): Promise<number> {
  return Number(
    (await app.city.db.query<{ n: string }>(`SELECT (${sql})::text AS n`, params)).rows[0]!.n,
  );
}
const path = (url: string) => new URL(url).pathname;
async function limitedApp(
  t: { after: (fn: () => Promise<unknown>) => void },
  limits: Partial<CityLimits>,
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, limits });
  t.after(() => app.close());
  return app;
}

test('official SDK client creates agents from manifests end to end over OAuth', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(registered.status, 201);
  const provider = new TestProvider();
  const endpoint = new URL(`${base}/mcp`);
  const client = new Client({ name: 'autonomy-test', version: '1.0.0' });
  await client
    .connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }))
    .catch(() => undefined);
  assert.ok(provider.authorizationUrl);
  // The SDK follows the 401 challenge's minimal default scope set; this test needs team
  // connections too, so it asks for the wider set a client would request on step-up.
  assert.equal(
    provider.authorizationUrl.searchParams.get('scope'),
    'workspace:read agents:create rooms:join rooms:host messages:read messages:send',
  );
  provider.authorizationUrl.searchParams.set('scope', SCOPES.join(' '));
  const callback = await consent(
    provider.authorizationUrl,
    SCOPES.filter((scope) => scope !== 'workspace:read'),
  );
  await new StreamableHTTPClientTransport(endpoint, { authProvider: provider }).finishAuth(
    callback.searchParams,
  );
  const connected = new Client({ name: 'autonomy-test', version: '1.0.0' });
  await connected.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
  t.after(() => connected.close());
  const names = (await connected.listTools()).tools.map((item) => item.name);
  for (const name of ['city_list_templates', 'city_plan_team', 'city_apply_team', 'city_control'])
    assert.ok(names.includes(name), name);

  const templates = await connected.callTool({ name: 'city_list_templates', arguments: {} });
  assert.ok((templates.structuredContent as any).templates.some((item: any) => item.ref === TEAM));
  const created = await connected.callTool({
    name: 'city_create_agent',
    arguments: {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'invoice-reader', displayName: 'Invoice reader' },
        spec: { extends: 'template:extractor@1.0.0', visibility: 'public' },
      },
      idempotency_key: randomUUID(),
    },
  });
  assert.ok(!created.isError, JSON.stringify(created));
  const result = created.structuredContent as any;
  assert.equal(result.agent.name, 'Invoice reader');
  assert.equal(result.agent.manifestName, 'invoice-reader');
  assert.equal(result.agent.revision, 1);
  assert.equal(result.agent.createdBy.kind, 'oauth-client');
  assert.match(result.agent.createdBy.clientId, /^ccc_/);
  assert.equal(result.enrollment, null, 'hosted agents need no enrollment');
  // Public cards need no session and verify against the published JWKS.
  const card = (await (await fetch(result.agent_card_url)).json()) as AgentCard;
  const jwks = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as Jwks;
  assert.equal(card.supportedInterfaces[0]!.url, `${base}/api/runtime/a2a/${result.agent.id}`);
  assert.equal(verifyAgentCard(card, jwks).valid, true);

  const planned = await connected.callTool({
    name: 'city_plan_team',
    arguments: { template: TEAM },
  });
  const teamHash = (planned.structuredContent as any).team_hash;
  assert.match(teamHash, /^sha256:/);
  const applied = await connected.callTool({
    name: 'city_apply_team',
    arguments: { template: TEAM, idempotency_key: randomUUID(), expected_team_hash: teamHash },
  });
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.equal((applied.structuredContent as any).agents.length, 3);
  assert.equal((applied.structuredContent as any).connections.length, 2);
});

test('dry runs create nothing and plans report errors with paths and hints', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const dry = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:extractor@1.0.0',
      dry_run: true,
    }),
  );
  assert.equal(dry.dry_run, true);
  assert.equal(dry.agent, null);
  assert.equal(dry.plan.ok, true);
  assert.equal(dry.plan.summary.create, 1);
  const plan = ok(await tool(app, token, 'city_plan_team', { template: TEAM }));
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.summary.create, 3);
  assert.equal(plan.plan.summary.connectionsToCreate, 2);
  assert.equal((await snapshot(app, cookie)).agents.length, 0);
  assert.equal(await count(app, 'SELECT count(*) FROM agent_manifests'), 0);
  const invalid = ok(
    await tool(app, token, 'city_plan_team', {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'Bad Name' },
        spec: { capabilities: ['research'], runtime: { mode: 'hosted' }, surprise: true },
      },
    }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.team_hash, null);
  const codes = invalid.plan.errors.map((issue: any) => `${issue.code}@${issue.path}`);
  assert.ok(codes.includes('UNKNOWN_KEY@spec.surprise'), codes.join());
  assert.ok(invalid.plan.errors.every((issue: any) => issue.hint));
  // A failed create returns the same issues in the tool error.
  const refused = errorOf(
    await tool(app, token, 'city_create_agent', {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'ok-name' },
        spec: {
          capabilities: ['research'],
          runtime: { mode: 'a2a', endpoint: 'https://agents.example.org/a2a' },
        },
      },
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(refused.code, 'invalid_arguments');
  assert.ok(refused.issues!.some((issue) => issue.code === 'RUNTIME_NOT_APPLICABLE'));
  assert.equal((await snapshot(app, cookie)).agents.length, 0);
});

test('apply_team creates members, connections, lineage and cards, and is idempotent', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const key = randomUUID();
  const first = ok(
    await tool(app, token, 'city_apply_team', { template: TEAM, idempotency_key: key }),
  );
  assert.equal(first.mode, 'owned');
  assert.equal(first.claim, null);
  const byName = Object.fromEntries(first.agents.map((agent: any) => [agent.name, agent]));
  assert.deepEqual(Object.keys(byName).sort(), ['checker', 'requester', 'researcher']);
  assert.equal(byName.requester.runtime_mode, 'external');
  assert.match(byName.requester.enrollment.enrollment_code, /^cce_/);
  assert.equal(byName.researcher.enrollment, null);
  assert.equal(byName.researcher.parent_agent_id, byName.requester.agent_id);
  assert.equal(byName.checker.parent_agent_id, byName.researcher.agent_id);
  assert.deepEqual(
    [byName.requester.depth, byName.researcher.depth, byName.checker.depth],
    [0, 1, 2],
  );
  assert.ok(first.next_actions.some((line: string) => /enrollment_code/.test(line)));

  const state = await snapshot(app, cookie);
  assert.equal(state.agents.length, 3);
  assert.deepEqual(
    state.connections.map((edge) => [edge.fromAgentId, edge.toAgentId]).sort(),
    [
      [byName.requester.agent_id, byName.researcher.agent_id],
      [byName.researcher.agent_id, byName.checker.agent_id],
    ].sort(),
  );
  assert.equal(await count(app, 'SELECT count(*) FROM agent_manifests'), 3);

  // Private cards are owner-only (404 otherwise, not 403).
  const cardPath = path(byName.researcher.agent_card_url);
  assert.equal((await app.inject({ method: 'GET', url: cardPath })).statusCode, 404);
  const card = await app.inject({ method: 'GET', url: cardPath, headers: { cookie } });
  assert.equal(card.statusCode, 200, card.body);
  assert.equal(card.headers['cache-control'], 'private, no-store');
  const jwks = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json() as Jwks;
  assert.equal(verifyAgentCard(card.json() as AgentCard, jwks).valid, true);

  // Same key and arguments: same resources. Same key, other arguments: conflict.
  const replay = ok(
    await tool(app, token, 'city_apply_team', { template: TEAM, idempotency_key: key }),
  );
  assert.deepEqual(
    replay.agents.map((agent: any) => agent.agent_id),
    first.agents.map((agent: any) => agent.agent_id),
  );
  const conflict = errorOf(
    await tool(app, token, 'city_apply_team', {
      template: TEAM,
      idempotency_key: key,
      expected_team_hash: first.team_hash,
    }),
  );
  assert.equal(conflict.code, 'conflict');
  // A new key re-plans to no-ops: nothing is duplicated.
  const again = ok(
    await tool(app, token, 'city_apply_team', { template: TEAM, idempotency_key: randomUUID() }),
  );
  assert.deepEqual(
    again.agents.map((agent: any) => agent.action),
    ['noop', 'noop', 'noop'],
  );
  assert.deepEqual(
    again.connections.map((edge: any) => edge.action),
    ['noop', 'noop'],
  );
  assert.equal((await snapshot(app, cookie)).agents.length, 3);
  assert.equal((await snapshot(app, cookie)).connections.length, 2);
});

test('a changed plan is refused by expected_team_hash and nothing is written', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const refused = errorOf(
    await tool(app, token, 'city_apply_team', {
      template: TEAM,
      idempotency_key: randomUUID(),
      expected_team_hash: `sha256:${'0'.repeat(64)}`,
    }),
  );
  assert.equal(refused.code, 'conflict');
  assert.equal(refused.issues![0]!.code, 'TEAM_HASH_MISMATCH');
  assert.equal((await snapshot(app, cookie)).agents.length, 0);
  assert.equal(await count(app, 'SELECT count(*) FROM agent_manifests'), 0);
  // The plan's own hash is accepted.
  const plan = ok(await tool(app, token, 'city_plan_team', { template: TEAM }));
  ok(
    await tool(app, token, 'city_apply_team', {
      template: TEAM,
      idempotency_key: randomUUID(),
      expected_team_hash: plan.team_hash,
    }),
  );
});

test('connections:create and agents:control scopes are enforced; spend needs the owner', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app, ['workspace:read', 'agents:create']);
  const plan = ok(await tool(app, token, 'city_plan_team', { template: TEAM }));
  assert.ok(plan.plan.warnings.some((issue: any) => issue.code === 'SCOPE_REQUIRED'));
  const refused = errorOf(
    await tool(app, token, 'city_apply_team', { template: TEAM, idempotency_key: randomUUID() }),
  );
  assert.equal(refused.code, 'forbidden');
  assert.match(refused.message, /connections:create/);
  assert.equal((await snapshot(app, cookie)).agents.length, 0);
  // Single agents need no connection scope.
  const single = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:fact-checker@1.0.0',
      overrides: { spec: { visibility: 'public' } },
      idempotency_key: randomUUID(),
    }),
  );
  // city_control is outside the grant: the HTTP layer answers with an insufficient_scope challenge.
  const control = await mcpCall(app, token, 'tools/call', {
    name: 'city_control',
    arguments: { agent_id: single.agent.id, action: 'pause' },
  });
  assert.equal(control.statusCode, 403, control.body);
  assert.match(String(control.headers['www-authenticate']), /insufficient_scope/);
  // Non-zero budgets and paid models are refused for AI-applied manifests.
  const spend = errorOf(
    await tool(app, token, 'city_create_agent', {
      template: 'template:extractor@1.0.0',
      overrides: { metadata: { name: 'spender' }, spec: { policy: { budgetUsd: 5 } } },
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(spend.code, 'forbidden');
  assert.ok(spend.issues!.some((issue) => issue.code === 'OWNER_APPROVAL_REQUIRED'));
});

test('city_control pauses, resumes and revokes with cascade down the lineage', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const team = ok(
    await tool(app, token, 'city_apply_team', { template: TEAM, idempotency_key: randomUUID() }),
  );
  const id = (name: string) => team.agents.find((agent: any) => agent.name === name).agent_id;
  // A child created under the checker extends the lineage below the team.
  const child = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:extractor@1.0.0',
      parent_agent_id: id('checker'),
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(child.agent.parentAgentId, id('checker'));
  assert.equal(child.agent.depth, 3);

  const paused = ok(
    await tool(app, token, 'city_control', { agent_id: id('researcher'), action: 'pause' }),
  );
  assert.deepEqual(
    paused.affected.map((item: any) => [item.agent_id, item.paused]),
    [
      [id('researcher'), true],
      [id('checker'), true],
      [child.agent.id, true],
    ],
  );
  let state = await snapshot(app, cookie);
  assert.ok(state.agents.find((agent) => agent.id === id('requester'))!.pausedAt === undefined);
  // Paused agents cannot receive work.
  const job = errorOf(
    await tool(app, token, 'city_create_job', {
      requesterId: id('researcher'),
      providerId: id('checker'),
      input: 'Synthetic brief',
      idempotencyKey: randomUUID(),
    }),
  );
  assert.equal(job.code, 'forbidden');
  const resumed = ok(
    await tool(app, token, 'city_control', {
      agent_id: id('researcher'),
      action: 'resume',
      cascade: false,
    }),
  );
  assert.deepEqual(
    resumed.affected.map((item: any) => item.agent_id),
    [id('researcher')],
  );
  assert.equal(
    errorOf(
      await tool(app, token, 'city_control', {
        agent_id: id('requester'),
        action: 'revoke',
        cascade: false,
      }),
    ).code,
    'invalid_arguments',
  );
  const revoked = ok(
    await tool(app, token, 'city_control', { agent_id: id('requester'), action: 'revoke' }),
  );
  assert.equal(revoked.affected.length, 4);
  assert.ok(revoked.affected.every((item: any) => item.revoked));
  state = await snapshot(app, cookie);
  assert.ok(state.agents.every((agent) => agent.status === 'revoked'));
  assert.equal(await count(app, 'SELECT count(*) FROM runtime_enrollments'), 0);
  assert.ok(state.events.some((item) => /revoked .* because its parent agent/.test(item.message)));
});

test('external runtimes enroll once with a short-lived code; owner rotation still works', async (t) => {
  let now = Date.parse('2026-09-26T12:00:00Z');
  const { app, cookie } = await fixture(t, { clock: () => now });
  const token = await ownerGrant(app);
  const externalArgs = (name: string, key = randomUUID()) => ({
    manifest: {
      apiVersion: 'centralcity.agent/v1',
      kind: 'Agent',
      metadata: { name },
      spec: { capabilities: ['research'], runtime: { mode: 'external' } },
    },
    idempotency_key: key,
  });
  const firstKey = randomUUID();
  const first = ok(
    await tool(app, token, 'city_create_agent', externalArgs('runtime-one', firstKey)),
  );
  const second = ok(await tool(app, token, 'city_create_agent', externalArgs('runtime-two')));
  assert.equal(first.runtimeSetupRequired, true);
  const enroll = (agentId: string, code: string) =>
    app.inject({
      method: 'POST',
      url: '/api/runtime/enroll',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ agent_id: agentId, enrollment_code: code }),
    });
  // Wrong agent: refused and not consumed.
  assert.equal((await enroll(second.agent.id, first.enrollment.enrollment_code)).statusCode, 401);
  const enrolled = await enroll(first.agent.id, first.enrollment.enrollment_code);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  const credential = enrolled.json().token as string;
  assert.match(credential, /^[A-Za-z0-9_-]{43}$/);
  // Single use.
  assert.equal((await enroll(first.agent.id, first.enrollment.enrollment_code)).statusCode, 401);
  // The credential authenticates the native runtime protocol.
  const body = JSON.stringify({ sequence: 1 });
  const beat = await app.inject({
    method: 'POST',
    url: '/api/runtime/heartbeat',
    headers: signedHeaders(credential, 'POST', '/api/runtime/heartbeat', body, String(now)),
    payload: body,
  });
  assert.equal(beat.statusCode, 200, beat.body);
  // A retried create returns the same agent; once enrolled it is offered no new code.
  const retried = ok(
    await tool(app, token, 'city_create_agent', externalArgs('runtime-one', firstKey)),
  );
  assert.equal(retried.agent.id, first.agent.id);
  assert.equal(retried.enrollment, null);
  // Expiry after 15 minutes.
  now += 15 * 60_000 + 1;
  assert.equal((await enroll(second.agent.id, second.enrollment.enrollment_code)).statusCode, 401);
  // Owner rotation remains available and replaces the enrolled credential.
  const rotated = await ownerApi(
    app,
    cookie,
    `/api/agents/${first.agent.id}/rotate-credential`,
    {},
  );
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.notEqual(rotated.json().token, credential);
  assert.equal(await count(app, 'SELECT count(*) FROM credentials'), 1);
  // The masked credential hint is the owner's only: not in the runtime's enrollment answer, the
  // Agent Card or the assistant's workspace view.
  const hint = `…${(rotated.json().token as string).slice(-4)}`;
  assert.equal(rotated.json().agent.credentialHint, hint);
  const owned = (await snapshot(app, cookie)).agents.find((agent) => agent.id === first.agent.id);
  assert.equal(owned?.credentialHint, hint);
  assert.equal('credentialHint' in enrolled.json().agent, false);
  const card = await app.inject({
    method: 'GET',
    url: path(first.agent_card_url),
    headers: { cookie },
  });
  assert.equal(card.statusCode, 200, card.body);
  assert.ok(!card.body.includes('credentialHint') && !card.body.includes(hint));
  const assistantView = JSON.stringify(ok(await tool(app, token, 'city_workspace', {})));
  assert.ok(!assistantView.includes('credentialHint') && !assistantView.includes(hint));
});

test('anonymous clients create unclaimed agents that an owner claims once', async (t) => {
  let now = Date.parse('2026-09-26T12:00:00Z');
  const { app, cookie } = await fixture(t, { clock: () => now });
  const address = '203.0.113.10';
  // /mcp requires OAuth for every request, including the anonymous tools; only /mcp/open is open.
  assert.equal(
    (await mcpCall(app, undefined, 'tools/call', { name: 'city_list_templates', arguments: {} }))
      .statusCode,
    401,
  );
  for (const method of ['initialize', 'tools/list']) {
    const res = await mcpCall(app, undefined, method, {});
    assert.equal(res.statusCode, 401);
    assert.match(String(res.headers['www-authenticate']), /resource_metadata=/);
  }
  assert.equal(
    (await mcpCall(app, undefined, 'tools/call', { name: 'city_workspace', arguments: {} }))
      .statusCode,
    401,
  );
  ok(await tool(app, null, 'city_list_templates', {}, address));
  const plan = ok(await tool(app, null, 'city_plan_team', { template: TEAM }, address));
  assert.equal(plan.mode, 'unclaimed');
  const team = ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      address,
    ),
  );
  assert.equal(team.mode, 'unclaimed');
  assert.match(team.claim.claim_token, /^ccclaim_/);
  assert.equal(team.claim.claim_url, `http://localhost/#claim=${team.claim.claim_token}`);
  const ids = team.agents.map((agent: any) => agent.agent_id).sort();
  assert.deepEqual(team.claim.agent_ids, ids);
  // Private-visibility cards are not served while unclaimed (there is no owner to show them to).
  const card = await app.inject({ method: 'GET', url: path(team.agents[1].agent_card_url) });
  assert.equal(card.statusCode, 404);
  // Anonymous creators are never identified, not even by a hash.
  const bucketAgents = (
    await app.city.db.query<{ agents: any[] }>(
      "SELECT w.data->'agents' AS agents FROM workspaces w JOIN operators o ON o.id=w.operator_id WHERE o.kind='unclaimed'",
    )
  ).rows[0]!.agents;
  for (const agent of bucketAgents) {
    assert.deepEqual(agent.createdBy, { kind: 'anonymous-client' });
    assert.equal(agent.rootSponsor, 'unclaimed');
  }
  // Unclaimed partitions are not accounts.
  assert.equal(await count(app, "SELECT count(*) FROM operators WHERE kind='unclaimed'"), 1);
  const session = (await app.inject({ method: 'GET', url: '/api/session' })).json();
  assert.equal(session.setupRequired, false);
  const metrics = (await ownerApi(app, cookie, '/api/metrics/agents')).json();
  assert.deepEqual(
    [metrics.owned.agents, metrics.unclaimed.agents, metrics.unclaimed.sources],
    [0, 3, 1],
  );

  // REST creation works the same way and returns its own claim token.
  const rest = await app.inject({
    method: 'POST',
    url: '/api/public/agents',
    remoteAddress: address,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      template: 'template:extractor@1.0.0',
      idempotency_key: randomUUID(),
    }),
  });
  assert.equal(rest.statusCode, 201, rest.body);
  assert.equal(rest.json().agent.createdBy.kind, 'anonymous-client');

  // A guessed token and a malformed token are both refused identically.
  for (const guess of [`ccclaim_${'A'.repeat(43)}`, 'nope'])
    assert.equal(
      (await ownerApi(app, cookie, '/api/agents/claim', { claim_token: guess })).statusCode,
      404,
    );
  const claimed = await ownerApi(app, cookie, '/api/agents/claim', {
    claim_token: team.claim.claim_token,
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.equal(claimed.json().connections, 2);
  assert.equal(claimed.json().jobs_dropped, 0);
  assert.deepEqual(claimed.json().credentials_rotated, []);
  const state = await snapshot(app, cookie);
  assert.deepEqual(state.agents.map((agent) => agent.id).sort(), ids);
  const byName = Object.fromEntries(state.agents.map((agent) => [agent.manifestName, agent]));
  assert.equal(byName.researcher!.parentAgentId, byName.requester!.id);
  assert.equal(byName.checker!.parentAgentId, byName.researcher!.id);
  assert.equal(byName.requester!.createdBy!.kind, 'anonymous-client');
  assert.ok(byName.requester!.claimedAt);
  assert.equal(state.connections.length, 2);
  // Single use.
  const other = await register(app, 'Second owner');
  assert.equal(
    (await ownerApi(app, other, '/api/agents/claim', { claim_token: team.claim.claim_token }))
      .statusCode,
    404,
  );
  // Claimed private cards become owner-only; the anonymous creator's enrollment code died with
  // the claim (the owner issues a credential with Rotate token instead).
  assert.equal(
    (await app.inject({ method: 'GET', url: path(team.agents[1].agent_card_url) })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: path(team.agents[1].agent_card_url),
        headers: { cookie },
      })
    ).statusCode,
    200,
  );
  const requester = team.agents.find((agent: any) => agent.name === 'requester');
  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/runtime/enroll',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      agent_id: requester.agent_id,
      enrollment_code: requester.enrollment.enrollment_code,
    }),
  });
  assert.equal(enrolled.statusCode, 401, enrolled.body);
  const rotated = await ownerApi(
    app,
    cookie,
    `/api/agents/${requester.agent_id}/rotate-credential`,
    {},
  );
  assert.equal(rotated.statusCode, 200, rotated.body);
  const owner = (
    await app.city.db.query<{ operator_id: string }>(
      'SELECT operator_id FROM credentials WHERE agent_id=$1',
      [requester.agent_id],
    )
  ).rows[0]!.operator_id;
  assert.equal(owner, (await snapshot(app, cookie)).operator.id);
  // Metrics are cached for 60 seconds per instance.
  const cached = (await ownerApi(app, cookie, '/api/metrics/agents')).json();
  assert.deepEqual(cached, metrics);
  now += 61_000;
  const after = (await ownerApi(app, cookie, '/api/metrics/agents')).json();
  assert.deepEqual(
    [after.owned.agents, after.owned.claimedFromUnclaimed, after.unclaimed.agents],
    [3, 3, 1],
  );
});

test('anonymous creation is rate limited, capped per source and globally, and zero-cost only', async (t) => {
  const app = await limitedApp(t, {
    unclaimedAgentsPerSource: 4,
    unclaimedAgentsGlobal: 7,
    unclaimedCreatesPerSourcePerHour: 3,
  });
  const single = (name: string) => ({
    template: 'template:extractor@1.0.0',
    overrides: { metadata: { name } },
    idempotency_key: randomUUID(),
  });
  const a = '198.51.100.1';
  ok(
    await tool(app, null, 'city_apply_team', { template: TEAM, idempotency_key: randomUUID() }, a),
  );
  ok(await tool(app, null, 'city_create_agent', single('fourth'), a));
  const capped = errorOf(await tool(app, null, 'city_create_agent', single('fifth'), a));
  assert.equal(capped.code, 'conflict');
  assert.ok(capped.issues!.some((issue) => issue.code === 'QUOTA_EXCEEDED'));
  const limited = errorOf(await tool(app, null, 'city_create_agent', single('sixth'), a));
  assert.equal(limited.code, 'rate_limited');
  // IPv6 addresses in one /64 share a bucket; another source has its own.
  const b = '2001:db8:1:2::10';
  ok(
    await tool(app, null, 'city_apply_team', { template: TEAM, idempotency_key: randomUUID() }, b),
  );
  const global = errorOf(
    await tool(app, null, 'city_create_agent', single('overflow'), '2001:db8:1:2::99'),
  );
  assert.equal(global.code, 'conflict');
  assert.match(global.message, /capacity is currently unavailable/);
  // Which cap was hit is not disclosed: the per-source cap reads the same.
  assert.equal(capped.message, global.message);
  assert.equal(await count(app, "SELECT count(*) FROM operators WHERE kind='unclaimed'"), 2);

  const c = '192.0.2.77';
  const budget = errorOf(
    await tool(
      app,
      null,
      'city_create_agent',
      {
        template: 'template:extractor@1.0.0',
        overrides: { spec: { policy: { budgetUsd: 1 } } },
        idempotency_key: randomUUID(),
      },
      c,
    ),
  );
  assert.equal(budget.code, 'forbidden');
  assert.ok(budget.issues!.some((issue) => issue.code === 'UNCLAIMED_ZERO_COST_ONLY'));
  const paid = errorOf(
    await tool(
      app,
      null,
      'city_create_agent',
      {
        manifest: {
          apiVersion: 'centralcity.agent/v1',
          kind: 'Agent',
          metadata: { name: 'paid' },
          spec: {
            capabilities: ['research'],
            runtime: { mode: 'external', model: { provider: 'anthropic' } },
          },
        },
        idempotency_key: randomUUID(),
      },
      c,
    ),
  );
  assert.equal(paid.code, 'forbidden');
  const legacy = errorOf(
    await tool(
      app,
      null,
      'city_create_agent',
      {
        name: 'Legacy',
        capability: 'extract',
        mode: 'hosted',
        idempotencyKey: randomUUID(),
      },
      c,
    ),
  );
  assert.equal(legacy.code, 'invalid_arguments');
  const tooLarge = errorOf(
    await tool(
      app,
      null,
      'city_create_agent',
      {
        template: 'template:extractor@1.0.0',
        overrides: { spec: { instructions: 'x'.repeat(40_000) } },
        idempotency_key: randomUUID(),
      },
      c,
    ),
  );
  assert.equal(tooLarge.code, 'invalid_arguments');
  const huge = await app.inject({
    method: 'POST',
    url: '/api/public/agents',
    remoteAddress: c,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ template: 'template:extractor@1.0.0', pad: 'x'.repeat(60_000) }),
  });
  assert.equal(huge.statusCode, 413);
  // Nothing from the refused requests was stored for source c, and every reservation hold,
  // including those of the creates refused under the partition lock, was released.
  assert.equal(await count(app, "SELECT count(*) FROM operators WHERE kind='unclaimed'"), 2);
  assert.equal(
    await count(app, "SELECT count(*) FROM unclaimed_stats WHERE scope_key LIKE 'hold:%'"),
    0,
  );
  assert.deepEqual((await reconcile(app.city.db, { confirm: false })).agents, []);
});

test('unclaimed and owned partitions stay isolated', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const intruder = await register(app, 'Other owner');
  const mine = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:research-analyst@1.0.0',
      idempotency_key: randomUUID(),
    }),
  );
  // Another owner cannot see a private card; an anonymous caller cannot fork a private agent.
  const cardPath = path(mine.agent_card_url);
  assert.equal(
    (await app.inject({ method: 'GET', url: cardPath, headers: { cookie: intruder } })).statusCode,
    404,
  );
  const fork = ok(
    await tool(
      app,
      null,
      'city_plan_team',
      {
        manifest: {
          apiVersion: 'centralcity.agent/v1',
          kind: 'Agent',
          metadata: { name: 'copycat' },
          spec: { extends: `agent:${mine.agent.id}@1` },
        },
      },
      '203.0.113.50',
    ),
  );
  assert.ok(fork.plan.errors.some((issue: any) => issue.code === 'AGENT_NOT_FOUND'));
  // Anonymous callers cannot attach agents under existing ones.
  const parent = ok(
    await tool(
      app,
      null,
      'city_plan_team',
      {
        template: 'template:extractor@1.0.0',
        parent_agent_id: mine.agent.id,
      },
      '203.0.113.50',
    ),
  );
  assert.ok(parent.plan.errors.some((issue: any) => issue.code === 'PARENT_NOT_ALLOWED'));
  // Two anonymous applies of the same template never share or reuse agents.
  const twoKey = randomUUID();
  const one = ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      '203.0.113.50',
    ),
  );
  const two = ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: twoKey },
      '203.0.113.50',
    ),
  );
  assert.ok(two.agents.every((agent: any) => agent.action === 'create'));
  const overlap = one.agents.filter((agent: any) =>
    two.agents.some((other: any) => other.agent_id === agent.agent_id),
  );
  assert.equal(overlap.length, 0);
  assert.notEqual(one.claim.claim_token, two.claim.claim_token);
  // Owners never see unclaimed agents until they claim them.
  assert.deepEqual(
    (await snapshot(app, cookie)).agents.map((agent) => agent.id),
    [mine.agent.id],
  );
  assert.equal((await snapshot(app, intruder)).agents.length, 0);
  const workspace = ok(await tool(app, token, 'city_workspace', {}));
  assert.equal(workspace.agents.length, 1);
  // The second owner claims one team; the first team stays unclaimed.
  assert.equal(
    (await ownerApi(app, intruder, '/api/agents/claim', { claim_token: two.claim.claim_token }))
      .statusCode,
    200,
  );
  assert.deepEqual(
    (await snapshot(app, intruder)).agents.map((agent) => agent.id).sort(),
    two.agents.map((agent: any) => agent.agent_id).sort(),
  );
  // Retrying the claimed team's creation cannot hand its agents or a new claim token out again.
  const retry = errorOf(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: twoKey },
      '203.0.113.50',
    ),
  );
  assert.equal(retry.code, 'not_found');
  assert.equal(retry.issues, undefined);
  assert.equal((await snapshot(app, cookie)).agents.length, 1);
});

test('Agent Card signatures verify against the JWKS and CITY_SIGNING_KEY formats load', async (t) => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const jwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
  const fromPkcs8 = parseSigningKey(pkcs8);
  const fromJwk = parseSigningKey(jwk);
  assert.equal(fromPkcs8.kid, fromJwk.kid);
  assert.throws(
    () => parseSigningKey('not a key'),
    (error: Error) => !error.message.includes('not a key'),
  );

  const app = await createApp({ dataDir: ':memory:', startWorkers: false, signingKey: fromJwk });
  t.after(() => app.close());
  const created = ok(
    await tool(
      app,
      null,
      'city_create_agent',
      {
        template: 'template:fact-checker@1.0.0',
        overrides: { spec: { visibility: 'public' } },
        idempotency_key: randomUUID(),
      },
      '198.51.100.200',
    ),
  );
  const res = await app.inject({ method: 'GET', url: path(created.agent_card_url) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-central-city-card-signed'], 'true');
  const card = res.json() as AgentCard;
  const jwksRes = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  assert.equal(jwksRes.headers['access-control-allow-origin'], '*');
  const jwks = jwksRes.json() as Jwks;
  assert.deepEqual(
    jwks.keys.map((key) => key.kid),
    [fromJwk.kid],
  );
  const verified = verifyAgentCard(card, jwks);
  assert.equal(verified.valid, true);
  const header = JSON.parse(Buffer.from(card.signatures![0]!.protected, 'base64url').toString());
  assert.equal(header.jku, 'http://localhost/.well-known/jwks.json');
  assert.equal(verifyAgentCard({ ...card, name: 'Tampered' }, jwks).valid, false);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/a2a/${randomUUID()}/.well-known/agent-card.json` }))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/a2a/not-a-uuid/.well-known/agent-card.json' }))
      .statusCode,
    404,
  );

  // Without a key cards are served unsigned and flagged.
  const unsigned = await createApp({ dataDir: ':memory:', startWorkers: false, signingKey: null });
  t.after(() => unsigned.close());
  const bare = ok(
    await tool(
      unsigned,
      null,
      'city_create_agent',
      {
        template: 'template:fact-checker@1.0.0',
        overrides: { spec: { visibility: 'public' } },
        idempotency_key: randomUUID(),
      },
      '198.51.100.201',
    ),
  );
  const plain = await unsigned.inject({ method: 'GET', url: path(bare.agent_card_url) });
  assert.equal(plain.headers['x-central-city-card-signed'], 'false');
  assert.equal((plain.json() as AgentCard).signatures, undefined);
  assert.deepEqual(
    (await unsigned.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json(),
    { keys: [] },
  );
});

test('B1: a same-source replay never mints or rotates claim tokens or enrollment codes', async (t) => {
  const { app, cookie } = await fixture(t);
  const creator = '2001:db8:5:6::1';
  const neighbour = '2001:db8:5:6::2'; // same /64, so the same partition
  const key = randomUUID();
  const args = { template: TEAM, idempotency_key: key };
  const first = ok(await tool(app, null, 'city_apply_team', args, creator));
  assert.equal(first.secrets_already_issued, false);
  const requester = first.agents.find((agent: any) => agent.name === 'requester');
  assert.match(requester.enrollment.enrollment_code, /^cce_/);

  const replay = ok(await tool(app, null, 'city_apply_team', args, neighbour));
  assert.equal(replay.secrets_already_issued, true);
  assert.equal(replay.claim, null);
  assert.ok(replay.agents.every((agent: any) => agent.enrollment === null));
  assert.deepEqual(
    replay.agents.map((agent: any) => agent.agent_id),
    first.agents.map((agent: any) => agent.agent_id),
  );
  // The receipt is bound to the request: the same key with other arguments is refused.
  assert.equal(
    errorOf(
      await tool(
        app,
        null,
        'city_apply_team',
        { ...args, expected_team_hash: first.team_hash },
        neighbour,
      ),
    ).code,
    'conflict',
  );
  // Guessable keys are refused before anything is stored.
  for (const weak of ['retry-001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0000000000000000000000000'])
    assert.equal(
      errorOf(
        await tool(
          app,
          null,
          'city_apply_team',
          { template: TEAM, idempotency_key: weak },
          creator,
        ),
      ).code,
      'invalid_arguments',
    );
  assert.ok(highEntropyKey(randomBytes(24).toString('base64url')));

  // The original caller's secrets still work after the neighbour's replay.
  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/runtime/enroll',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      agent_id: requester.agent_id,
      enrollment_code: requester.enrollment.enrollment_code,
    }),
  });
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  const oldCredential = enrolled.json().token as string;

  // N2: claiming rotates the credential the anonymous creator obtained.
  const claimed = await ownerApi(app, cookie, '/api/agents/claim', {
    claim_token: first.claim.claim_token,
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const rotated = claimed.json().credentials_rotated as { agent_id: string; token: string }[];
  assert.deepEqual(
    rotated.map((item) => item.agent_id),
    [requester.agent_id],
  );
  const beat = (credential: string, sequence: number) => {
    const body = JSON.stringify({ sequence });
    return app.inject({
      method: 'POST',
      url: '/api/runtime/heartbeat',
      headers: signedHeaders(credential, 'POST', '/api/runtime/heartbeat', body),
      payload: body,
    });
  };
  assert.equal((await beat(oldCredential, 1)).statusCode, 401);
  assert.equal((await beat(rotated[0]!.token, 1)).statusCode, 200);
});

test('B2: site and network prefixes are capped and rate limited beyond each /64', async (t) => {
  const app = await limitedApp(t, {
    unclaimedAgentsPerSite: 3,
    unclaimedAgentsPerNetwork: 4,
    unclaimedCreatesPerSitePerHour: 2,
  });
  const single = () => ({
    template: 'template:extractor@1.0.0',
    overrides: { metadata: { name: `x-${randomUUID().slice(0, 8)}` } },
    idempotency_key: randomUUID(),
  });
  // Three /64s inside one /56 (2001:db8:7:100::/56) share the site cap of 3 agents.
  ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      '2001:db8:7:100::1',
    ),
  );
  const site = errorOf(await tool(app, null, 'city_create_agent', single(), '2001:db8:7:1ff::1'));
  assert.equal(site.code, 'conflict');
  assert.match(site.message, /capacity is currently unavailable/);
  // Another /56 in the same /48 has room for one more before the network cap of 4.
  ok(await tool(app, null, 'city_create_agent', single(), '2001:db8:7:200::1'));
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '2001:db8:7:300::1')).code,
    'conflict',
  );
  // A different /48 is unaffected.
  ok(await tool(app, null, 'city_create_agent', single(), '2001:db8:8:100::1'));
  // Site rate: 2 creates per hour across the /56 (the refused one above also counted).
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '2001:db8:7:1aa::1')).code,
    'rate_limited',
  );
  assert.equal(await count(app, "SELECT agents FROM unclaimed_stats WHERE scope_key='global'"), 5);
});

test('B2: the partition bound evicts only empty, idle partitions and never agents', async (t) => {
  let now = Date.parse('2026-09-26T12:00:00Z');
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    limits: { unclaimedBucketsGlobal: 2 },
  });
  t.after(() => app.close());
  const cookie = await register(app, 'Evicting owner');
  const single = () => ({ template: 'template:extractor@1.0.0', idempotency_key: randomUUID() });
  const x = ok(await tool(app, null, 'city_create_agent', single(), '192.0.2.1'));
  ok(await tool(app, null, 'city_create_agent', single(), '198.51.100.9'));
  // Emptied by a claim: agents move to the owner, the partition stays until evicted.
  assert.equal(
    (await ownerApi(app, cookie, '/api/agents/claim', { claim_token: x.claim.claim_token }))
      .statusCode,
    200,
  );
  // At the bound, a recently used empty partition is not evicted yet.
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '203.0.113.9')).code,
    'conflict',
  );
  now += 11 * 60_000;
  ok(await tool(app, null, 'city_create_agent', single(), '203.0.113.9'));
  assert.equal(await count(app, "SELECT count(*) FROM operators WHERE kind='unclaimed'"), 2);
  assert.equal(await count(app, "SELECT buckets FROM unclaimed_stats WHERE scope_key='global'"), 2);
  // The claimed agent survived eviction of its old partition.
  assert.deepEqual(
    (await snapshot(app, cookie)).agents.map((agent) => agent.id),
    [x.agent.id],
  );
  // Partitions that still hold agents are never evicted.
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '203.0.113.200')).code,
    'conflict',
  );
  assert.equal(await count(app, "SELECT agents FROM unclaimed_stats WHERE scope_key='global'"), 2);
});

test('N6: the JWKS also publishes CITY_SIGNING_KEY_PREVIOUS for verification', () => {
  const current = JSON.stringify(
    generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  );
  const previous = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  const signer = loadPlatformSigner(
    { CITY_SIGNING_KEY: current, CITY_SIGNING_KEY_PREVIOUS: previous },
    true,
    () => {},
  );
  assert.deepEqual(
    signer.jwks().keys.map((key) => key.kid),
    [signer.key!.kid, signer.previous!.kid],
  );
  assert.throws(
    () => loadPlatformSigner({ CITY_SIGNING_KEY: current, CITY_SIGNING_KEY_PREVIOUS: 'x' }, true),
    /CITY_SIGNING_KEY_PREVIOUS/,
  );
});

test('open endpoint: an official MCP client with no auth creates a team an owner claims', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'open-endpoint-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/open`)));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((item) => item.name).sort(), [
    'city_apply_team',
    'city_create_agent',
    'city_create_workspace',
    'city_list_templates',
    'city_plan_team',
  ]);
  const templates = await client.callTool({ name: 'city_list_templates', arguments: {} });
  assert.ok((templates.structuredContent as any).templates.some((item: any) => item.ref === TEAM));
  const applied = await client.callTool({
    name: 'city_apply_team',
    arguments: { template: TEAM, idempotency_key: randomUUID() },
  });
  assert.ok(!applied.isError, JSON.stringify(applied));
  const result = applied.structuredContent as any;
  assert.equal(result.mode, 'unclaimed');
  assert.equal(result.claim.claim_url, `${base}/#claim=${result.claim.claim_token}`);
  // Tools outside the anonymous set do not exist on the open endpoint.
  const hidden = await client
    .callTool({ name: 'city_workspace', arguments: {} })
    .catch((error: unknown) => ({ isError: true, error }));
  assert.equal(hidden.isError, true);
  // /mcp itself stays OAuth-protected for discovery.
  const protectedRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(protectedRes.status, 401);

  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(registered.status, 201);
  const session = registered.headers.getSetCookie()[0]!.split(';')[0]!;
  const claimed = await fetch(`${base}/api/agents/claim`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie: session },
    body: JSON.stringify({
      claim_token: new URL(result.claim.claim_url).hash.slice('#claim='.length),
    }),
  });
  const body = (await claimed.json()) as any;
  assert.equal(claimed.status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.agents.map((agent: any) => agent.id).sort(),
    result.agents.map((agent: any) => agent.agent_id).sort(),
  );
});

test('region scope (IPv6 /32, IPv4 /8) caps and rate-limits unclaimed creation', async (t) => {
  const app = await limitedApp(t, {
    unclaimedAgentsPerRegion: 2,
    unclaimedCreatesPerRegionPerHour: 4,
  });
  const single = () => ({
    template: 'template:extractor@1.0.0',
    idempotency_key: randomUUID(),
  });
  // Two different /48s inside 2001:db8::/32 share the region cap of 2.
  ok(await tool(app, null, 'city_create_agent', single(), '2001:db8:10::1'));
  ok(await tool(app, null, 'city_create_agent', single(), '2001:db8:20::1'));
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '2001:db8:30::1')).code,
    'conflict',
  );
  // Hex IPv4-mapped IPv6 is the IPv4 address, so it falls in 192.0.0.0/8 with 192.0.2.1.
  assert.equal(clientAddressKey('::ffff:c000:201'), '192.0.2.1');
  ok(await tool(app, null, 'city_create_agent', single(), '192.0.2.1'));
  ok(await tool(app, null, 'city_create_agent', single(), '::ffff:c000:202'));
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '192.1.1.1')).code,
    'conflict',
  );
  // Rate: the refused request counted, so the region's fifth request per hour is refused.
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '2001:db8:40::1')).code,
    'conflict',
  );
  assert.equal(
    errorOf(await tool(app, null, 'city_create_agent', single(), '2001:db8:50::1')).code,
    'rate_limited',
  );
  // Refused and rolled-back reservations were released: only the four agents count.
  assert.equal(await count(app, "SELECT agents FROM unclaimed_stats WHERE scope_key='global'"), 4);
});

test('metrics report unclaimed capacity pressure and log capacity.pressure once a minute', async (t) => {
  let now = Date.parse('2026-09-26T12:00:00Z');
  const lines: string[] = [];
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    limits: { unclaimedAgentsGlobal: 5 },
    logLine: (line) => lines.push(line),
  });
  t.after(() => app.close());
  const cookie = await register(app, 'Capacity owner');
  const metrics = async () => (await ownerApi(app, cookie, '/api/metrics/agents')).json();
  assert.deepEqual((await metrics()).unclaimed_capacity, {
    agents_used: 0,
    agents_cap: 5,
    partitions_used: 0,
    partitions_cap: 200_000,
    pressure: 'ok',
  });
  ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      '192.0.2.10',
    ),
  );
  assert.deepEqual(lines, []);
  ok(
    await tool(
      app,
      null,
      'city_create_agent',
      { template: 'template:extractor@1.0.0', idempotency_key: randomUUID() },
      '192.0.2.11',
    ),
  );
  now += 61_000;
  ok(
    await tool(
      app,
      null,
      'city_create_agent',
      { template: 'template:extractor@1.0.0', idempotency_key: randomUUID() },
      '192.0.2.12',
    ),
  );
  // 5 of 5 agents: critical. One structured line per instance per minute.
  now += 1_000;
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]!);
  assert.equal(line.event, 'capacity.pressure');
  assert.equal(line.pressure, 'critical');
  assert.equal(line.agents_used, 5);
  now += 60_000;
  const capacity = (await metrics()).unclaimed_capacity;
  assert.equal(capacity.pressure, 'critical');
  assert.equal(capacity.partitions_used, 3);
});

test('operators list and purge unclaimed partitions deliberately; owned workspaces are untouched', async (t) => {
  const saved = process.env.CITY_RATE_LIMIT_KEY;
  process.env.CITY_RATE_LIMIT_KEY = 'synthetic-test-only-rate-limit-secret-0000';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_RATE_LIMIT_KEY;
    else process.env.CITY_RATE_LIMIT_KEY = saved;
  });
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const owned = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:extractor@1.0.0',
      idempotency_key: randomUUID(),
    }),
  );
  ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      '2001:db8:aa:1::1',
    ),
  );
  ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      '2001:db8:bb:1::1',
    ),
  );
  const other = ok(
    await tool(
      app,
      null,
      'city_create_agent',
      { template: 'template:extractor@1.0.0', idempotency_key: randomUUID() },
      '198.51.100.77',
    ),
  );

  assert.throws(() => parseAdminArgs(['purge', '--partition', 'x']), /--confirm/);
  assert.throws(() => parseAdminArgs(['list-top', '--by', '/64']), /--by/);
  assert.deepEqual(parseAdminArgs(['--', 'list-top', '--by', '/32']), {
    command: 'list-top',
    by: '/32',
    limit: 20,
  });
  const regions = await listTop(app.city.db, '/32');
  assert.equal(regions[0]!.agents, 6);
  const partitions = await listTop(app.city.db, 'partition');
  assert.deepEqual(
    partitions.map((row) => row.agents),
    [3, 3, 1],
  );

  // Purge one /48 by its literal prefix: only that partition goes.
  const byPrefix = await purge(
    app.city.db,
    { prefix: '2001:db8:aa::/48' },
    process.env.CITY_RATE_LIMIT_KEY!,
  );
  assert.equal(byPrefix.partitions, 1);
  assert.equal(byPrefix.agents, 3);
  assert.equal(await count(app, "SELECT agents FROM unclaimed_stats WHERE scope_key='global'"), 4);
  assert.equal((await listTop(app.city.db, '/32'))[0]!.agents, 3);
  // Purge a partition by id; an owner's operator id is refused (not unclaimed).
  const ownerId = (await snapshot(app, cookie)).operator.id;
  assert.deepEqual(await purge(app.city.db, { partition: ownerId }, ''), {
    partitions: 0,
    agents: 0,
  });
  const partition = (await listTop(app.city.db, 'partition')).find((row) => row.agents === 1)!;
  assert.deepEqual(
    await purge(app.city.db, { partition: (partition as { partition: string }).partition }, ''),
    {
      partitions: 1,
      agents: 1,
    },
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: path(other.agent_card_url) })).statusCode,
    404,
  );
  assert.equal(await count(app, "SELECT buckets FROM unclaimed_stats WHERE scope_key='global'"), 1);
  // The owner's workspace and agent are untouched.
  assert.deepEqual(
    (await snapshot(app, cookie)).agents.map((agent) => agent.id),
    [owned.agent.id],
  );
  assert.equal(
    await count(app, 'SELECT count(*) FROM agent_manifests WHERE operator_id=$1', [ownerId]),
    1,
  );
});

test('reconcile rebuilds unclaimed counters from rows, keeping in-flight reservations', async (t) => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const db = app.city.db;
  ok(
    await tool(
      app,
      null,
      'city_apply_team',
      { template: TEAM, idempotency_key: randomUUID() },
      '2001:db8:aa:1::1',
    ),
  );
  ok(
    await tool(
      app,
      null,
      'city_create_agent',
      { template: 'template:extractor@1.0.0', idempotency_key: randomUUID() },
      '198.51.100.77',
    ),
  );
  const stats = async () =>
    Object.fromEntries(
      (
        await db.query<{ scope_key: string; agents: number; buckets: number }>(
          'SELECT scope_key, agents, buckets FROM unclaimed_stats',
        )
      ).rows.map((row) => [row.scope_key, `${row.agents}/${row.buckets}`]),
    );
  const clean = await stats();
  assert.deepEqual(await reconcile(db, { confirm: false, now }), {
    command: 'reconcile',
    applied: false,
    checked_at: '2026-09-26T12:00:00.000Z',
    partitions: { counter: 2, actual: 2, after: 2 },
    agents: [],
    abandoned_holds: [],
    untracked: { partitions: 0, agents: 0 },
    without_region: { partitions: 0, agents: 0 },
    expiry_index: { missing: 0, repaired: 0, invalid_dates: 0, batch_limit: 100 },
  });
  type Scopes = { site_key: string; network_key: string; region_key: string };
  const [team, single] = (
    await db.query<Scopes>(
      `SELECT b.site_key, b.network_key, b.region_key FROM unclaimed_buckets b
        JOIN workspaces w ON w.operator_id=b.operator_id
        ORDER BY jsonb_array_length(w.data->'agents') DESC`,
    )
  ).rows as [Scopes, Scopes];
  const keys = (scopes: Scopes) => [
    'global',
    `site:${scopes.site_key}`,
    `network:${scopes.network_key}`,
    `region:${scopes.region_key}`,
  ];
  // Drift of every kind: a reservation leaked without a hold, a lost site count, a missing
  // network row, a stale region count and a stale partition count...
  await db.query(
    "UPDATE unclaimed_stats SET agents=agents+5, buckets=buckets+3 WHERE scope_key='global'",
  );
  await db.query('UPDATE unclaimed_stats SET agents=0 WHERE scope_key=$1', [keys(team)[1]]);
  await db.query('DELETE FROM unclaimed_stats WHERE scope_key=$1', [keys(single)[2]]);
  await db.query('UPDATE unclaimed_stats SET agents=agents+2 WHERE scope_key=$1', [keys(team)[3]]);
  // ...plus a reservation abandoned by a crashed process and one still in flight, recorded the
  // way anonymous creation records them.
  const holdOf = (at: number, scopes: Scopes) =>
    `hold:${at}:${randomUUID()}:${scopes.site_key}:${scopes.network_key}:${scopes.region_key}`;
  const abandoned = holdOf(now - UNCLAIMED_HOLD_TTL_MS - 60_000, team);
  const inFlight = holdOf(now - 1_000, single);
  for (const [hold, scopes, agents] of [
    [abandoned, team, 4],
    [inFlight, single, 2],
  ] as const) {
    await db.query('INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES($1,$2,0)', [
      hold,
      agents,
    ]);
    for (const key of keys(scopes))
      await db.query(
        `INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES($1,$2,0)
          ON CONFLICT (scope_key) DO UPDATE SET agents=unclaimed_stats.agents+$2`,
        [key, agents],
      );
  }
  const corrupted = await stats();
  const dry = await reconcile(db, { confirm: false, now });
  assert.deepEqual(await stats(), corrupted, 'a dry run writes nothing');
  assert.deepEqual(dry.partitions, { counter: 5, actual: 2, after: 2 });
  assert.deepEqual(
    dry.abandoned_holds.map((hold) => [hold.hold, hold.agents]),
    [[abandoned, 4]],
  );
  assert.deepEqual(
    Object.fromEntries(
      dry.agents.map((change) => [
        change.scope,
        [change.counter, change.actual, change.in_flight, change.abandoned, change.after],
      ]),
    ),
    {
      global: [15, 4, 2, 4, 6],
      [keys(team)[1]]: [4, 3, 0, 4, 3],
      [keys(team)[2]]: [7, 3, 0, 4, 3],
      [keys(team)[3]]: [9, 3, 0, 4, 3],
      [keys(single)[2]]: [2, 1, 2, 0, 3],
    },
  );
  const applied = await reconcile(db, { confirm: true, now });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.agents, dry.agents);
  const fixed = await stats();
  assert.equal(fixed.global, '6/2');
  assert.equal(fixed[abandoned], undefined);
  assert.equal(fixed[inFlight], '2/0');
  assert.deepEqual((await reconcile(db, { confirm: false, now })).agents, []);
  // The in-flight create then releases its unused reservation: the counters equal the rows.
  await db.query('DELETE FROM unclaimed_stats WHERE scope_key=$1', [inFlight]);
  for (const key of keys(single))
    await db.query('UPDATE unclaimed_stats SET agents=agents-2 WHERE scope_key=$1', [key]);
  assert.deepEqual(await stats(), clean);
  // Partitions whose scope keys predate migrations 8 and 9 are reported, not guessed.
  await db.query('UPDATE unclaimed_buckets SET region_key=NULL WHERE region_key=$1', [
    team.region_key,
  ]);
  const legacy = await reconcile(db, { confirm: false, now });
  assert.deepEqual(legacy.without_region, { partitions: 1, agents: 3 });
  assert.deepEqual(legacy.untracked, { partitions: 0, agents: 0 });

  assert.deepEqual(parseAdminArgs(['--', 'reconcile']), { command: 'reconcile', confirm: false });
  assert.deepEqual(parseAdminArgs(['reconcile', '--confirm']), {
    command: 'reconcile',
    confirm: true,
  });
  assert.throws(() => parseAdminArgs(['reconcile', '--yes']), /Unknown flag/);
  assert.throws(() => parseAdminArgs(['reconcile', '--confirm', 'now']), /takes no value/);
});

test('hosted mode refuses to start without a 32-character CITY_RATE_LIMIT_KEY', () => {
  assert.throws(() => assertHostedSecret({}), /CITY_RATE_LIMIT_KEY/);
  assert.throws(() => assertHostedSecret({ CITY_RATE_LIMIT_KEY: 'too-short' }), /at least 32/);
  assert.doesNotThrow(() => assertHostedSecret({ CITY_RATE_LIMIT_KEY: 'x'.repeat(32) }));
});

test('hosted createApp fails clearly when the secret is missing', async () => {
  const saved = process.env.CITY_RATE_LIMIT_KEY;
  delete process.env.CITY_RATE_LIMIT_KEY;
  try {
    await assert.rejects(
      createApp({
        hosted: {
          databaseUrl: 'postgres://synthetic.invalid/db',
          publicOrigin: 'https://city.example.org',
          allowedOrigins: ['https://city.example.org'],
        },
      }),
      /CITY_RATE_LIMIT_KEY must be set/,
    );
  } finally {
    if (saved !== undefined) process.env.CITY_RATE_LIMIT_KEY = saved;
  }
});

test('anonymous idempotency keys: random keys pass, predictable ones are refused', () => {
  for (const good of [
    randomUUID(),
    randomUUID().toUpperCase(),
    `req_${randomUUID()}`,
    randomBytes(16).toString('base64url'),
    randomBytes(24).toString('base64url'),
    randomBytes(32).toString('base64url'),
    randomBytes(16).toString('hex'),
    randomBytes(16).toString('hex').toUpperCase(),
  ])
    assert.equal(highEntropyKey(good), true, good);
  for (const bad of [
    'Password1234567890abcd', // dictionary word and a digit sequence
    'MyPassword-9f3Kx7Qz2Lm',
    'create-research-team-first-attempt', // words of one case
    'thisisarandomidempotencykey',
    'qwhzjxkvmnbtrplgdfsyca', // 22 lowercase letters
    'CreateResearchTeam-Attempt-7',
    'agent-key-2026-09-26-Xy7', // a date
    'k1790000000123-aBcXyZqW', // timestamps in milliseconds and seconds
    'job_1790012345_Kx9Qm2Zt4L',
    'aB3dE5fG7hI9jK1lM3nO5p', // alphabetical letters behind the noise
    'Kx9Qm2Zt4LKx9Qm2Zt4LKx', // a repeated block
    'qwertyuiopASDF1234zxcv',
    'deadbeefcafebabe01234567', // hex under 32 digits, in any case
    'DeAdBeEfCaFeBaBe0f1e2d3c',
    '1234567890123456789012345678901234567890',
    '12345678-1234-4234-8234-123456789abc', // UUID-shaped but patterned
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8', // not version 4
    '550e8400-e29b-41d4-a716-446655440000', // published example UUIDs
    '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000000',
    'ffffffff-ffff-4fff-bfff-ffffffffffff',
    'abcdefghijklmnopqrstuvwxyzABCDEF',
    '0123456789abcdefghijklmnopqrstuv',
    'A'.repeat(40),
    '0'.repeat(25),
    'short',
    'retry-001',
    'x7Kp2mQ9vL4nR8sT1wY6z!',
  ])
    assert.equal(highEntropyKey(bad), false, bad);
  // Genuine random keys may be refused at most 1 in 1,000,000 times (the rules are sized for
  // about 1e-7). CI fuzzes 100,000 UUIDs and 100,000 base64url keys of 16 random bytes; run the
  // full million with CITY_KEY_FUZZ=1000000 npx tsx --test tests/autonomous-creation.test.ts.
  const fuzz = Number(process.env.CITY_KEY_FUZZ ?? 100_000);
  const pool = randomBytes(16 * fuzz);
  const refused: string[] = [];
  for (let index = 0; index < fuzz; index++) {
    const uuid = randomUUID();
    if (!highEntropyKey(uuid)) refused.push(uuid);
    const key = pool.subarray(index * 16, index * 16 + 16).toString('base64url');
    if (!highEntropyKey(key)) refused.push(key);
  }
  assert.ok(refused.length <= Math.max(1, Math.floor((2 * fuzz) / 1_000_000)), refused.join(' '));
});

test('a partition used again refreshes last_used_at so it is not evicted as idle', async (t) => {
  let now = Date.parse('2026-09-26T12:00:00Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const single = () => ({ template: 'template:extractor@1.0.0', idempotency_key: randomUUID() });
  ok(await tool(app, null, 'city_create_agent', single(), '192.0.2.40'));
  const used = () =>
    count(app, 'SELECT last_used_at FROM unclaimed_buckets ORDER BY created_at LIMIT 1');
  assert.equal(await used(), now);
  now += 30 * 60_000;
  ok(await tool(app, null, 'city_create_agent', single(), '192.0.2.40'));
  assert.equal(await used(), now);
});

test('a manifest update that changes the display name shows as a rename in Activity', async (t) => {
  const { app, cookie } = await fixture(t);
  const token = await ownerGrant(app);
  const first = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:fact-checker@1.0.0',
      idempotency_key: randomUUID(),
    }),
  );
  const updated = ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:fact-checker@1.0.0',
      overrides: { metadata: { displayName: 'Claim checker' } },
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(updated.agent.id, first.agent.id);
  const state = await snapshot(app, cookie);
  assert.equal(state.agents.find((agent) => agent.id === first.agent.id)?.name, 'Claim checker');
  assert.ok(
    state.events.some((item) => item.message === 'Renamed Fact checker to Claim checker.'),
    'the owner sees the name change in Activity',
  );
  // Re-applying the same manifest changes nothing and records no further rename.
  ok(
    await tool(app, token, 'city_create_agent', {
      template: 'template:fact-checker@1.0.0',
      overrides: { metadata: { displayName: 'Claim checker' } },
      idempotency_key: randomUUID(),
    }),
  );
  const renames = (await snapshot(app, cookie)).events.filter((item) =>
    /^Renamed /.test(item.message),
  );
  assert.equal(renames.length, 1);
});

test('concurrent metrics misses share one aggregation over every workspace', async (t) => {
  let now = Date.parse('2026-10-15T06:00:00Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const cookie = await register(app, 'Metrics owner');
  const db = app.city.db;
  const original = db.query.bind(db);
  let scans = 0;
  (db as { query: typeof db.query }).query = ((text: string, params?: unknown[]) => {
    if (typeof text === 'string' && text.includes("jsonb_array_elements(w.data->'agents')"))
      scans++;
    return original(text as never, params as never);
  }) as typeof db.query;
  const burst = async () =>
    Promise.all(Array.from({ length: 6 }, () => ownerApi(app, cookie, '/api/metrics/agents')));
  const first = await burst();
  assert.ok(first.every((res) => res.statusCode === 200));
  assert.equal(scans, 1);
  assert.equal(new Set(first.map((res) => res.body)).size, 1);
  // Cached: no new scan. After the cache expires, one more burst is one more scan.
  await burst();
  assert.equal(scans, 1);
  now += 61_000;
  await burst();
  assert.equal(scans, 2);
});
