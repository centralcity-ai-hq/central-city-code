import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

/**
 * AI-owned workspaces ("AI parity", docs/AI_WORKSPACES.md): an AI creates a workspace without
 * any human, works in it with its workspace key, hands other AIs their own keys, and a person may
 * later claim it as co-owner. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic parity owner password';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, limits = {}) {
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    limits: limits as Partial<CityLimits>,
  });
  t.after(() => app.close());
  return app;
}
function createWorkspace(app: App, name: string, key: string = randomUUID(), address?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: key }),
    ...(address ? { remoteAddress: address } : {}),
  });
}
function tool(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
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
function owner(
  app: App,
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  workspace?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      ...jsonHeaders,
      cookie,
      ...(workspace ? { 'x-city-workspace': workspace } : {}),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
const structured = (result: unknown) => (result as { structuredContent: any }).structuredContent;
const toolError = (result: unknown) => {
  const value = result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(value.isError, true, JSON.stringify(value));
  return JSON.parse(value.content[0]!.text).error as { code: string; message: string };
};

test('an AI creates its own workspace on /mcp/open and works on /mcp with its key', async (t) => {
  const app = await fixture(t);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // No account, no human: the official MCP client on the open endpoint.
  const open = new Client({ name: 'parity-open', version: '1.0.0' });
  await open.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/open`)));
  t.after(() => open.close());
  const openTools = (await open.listTools()).tools.map((item) => item.name);
  assert.ok(openTools.includes('city_create_workspace'));
  const idempotency = randomUUID();
  const created = structured(
    await open.callTool({
      name: 'city_create_workspace',
      arguments: { name: 'Parity Lab', idempotency_key: idempotency },
    }),
  );
  assert.match(created.workspace_key, /^ccw_[A-Za-z0-9_-]{43}$/);
  assert.match(created.claim_token, /^ccwclaim_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.claim_url, `${base}/#claim=${created.claim_token}`);
  assert.equal(created.mcp_url, `${base}/mcp`);
  assert.equal(created.secrets_already_issued, false);
  // Created without a human: every scope except rooms:host, rooms:apply, results:publish and pay
  // (a co-owner can grant them later).
  assert.deepEqual(
    created.key.scopes,
    ASSISTANT_SCOPES.filter(
      (scope) =>
        scope !== 'rooms:host' &&
        scope !== 'rooms:apply' &&
        scope !== 'results:publish' &&
        scope !== 'pay',
    ),
  );
  assert.match(created.slug, /^parity-lab-[0-9a-f]{10}$/);

  // B1: a replay returns the same workspace and no secrets.
  const replay = structured(
    await open.callTool({
      name: 'city_create_workspace',
      arguments: { name: 'Parity Lab', idempotency_key: idempotency },
    }),
  );
  assert.equal(replay.workspace_id, created.workspace_id);
  assert.equal(replay.workspace_key, null);
  assert.equal(replay.claim_token, null);
  assert.equal(replay.secrets_already_issued, true);
  assert.equal(
    toolError(
      await open.callTool({
        name: 'city_create_workspace',
        arguments: { name: 'Other name', idempotency_key: idempotency },
      }),
    ).code,
    'conflict',
  );
  assert.equal(
    toolError(
      await open.callTool({
        name: 'city_create_workspace',
        arguments: { name: 'Guessable', idempotency_key: 'my-workspace-1' },
      }),
    ).code,
    'invalid_arguments',
  );

  // The official client on the OAuth endpoint, authenticated only by the workspace key.
  const key = created.workspace_key as string;
  const keyed = new Client({ name: 'parity-keyed', version: '1.0.0' });
  await keyed.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: { token: async () => key },
    }),
  );
  t.after(() => keyed.close());
  const names = (await keyed.listTools()).tools.map((item) => item.name);
  for (const name of [
    'city_workspace',
    'city_apply_team',
    'city_workspace_keys',
    'city_create_workspace_key',
    'city_revoke_workspace_key',
    'city_request_connection',
    'city_decide_connection',
    'city_create_invite',
  ])
    assert.ok(names.includes(name), name);
  assert.ok(!names.includes('city_create_workspace'), 'creation lives on /mcp/open only');
  const workspace = structured(await keyed.callTool({ name: 'city_workspace', arguments: {} }));
  assert.deepEqual(workspace.operator, { id: created.workspace_id, name: 'Parity Lab' });

  // Agents: a template team with its connections, then a message between members.
  const team = structured(
    await keyed.callTool({
      name: 'city_apply_team',
      arguments: { template: 'template:research-team@1.0.0', idempotency_key: randomUUID() },
    }),
  );
  assert.equal(team.mode, 'owned');
  assert.ok(team.agents.length >= 2);
  assert.ok(team.connections.length >= 1);
  const edge = team.connections[0];
  const idOf = (name: string) => team.agents.find((item: any) => item.name === name).agent_id;
  const sent = structured(
    await keyed.callTool({
      name: 'city_send_message',
      arguments: {
        from_agent_id: idOf(edge.from),
        to_agent_id: idOf(edge.to),
        text: 'Synthetic hello from an AI-owned workspace.',
        idempotency_key: randomUUID(),
      },
    }),
  );
  assert.equal(sent.message.seq, 1);
  const snapshotAgents = structured(
    await keyed.callTool({ name: 'city_workspace', arguments: {} }),
  ).agents;
  assert.ok(snapshotAgents.every((agent: any) => agent.createdBy.kind === 'workspace-key'));
  assert.ok(snapshotAgents.every((agent: any) => agent.createdBy.id === created.key.id));

  // A second key for another AI: least privilege, shown once, hashed at rest.
  const minted = structured(
    await keyed.callTool({
      name: 'city_create_workspace_key',
      arguments: { label: 'reader AI', scopes: ['workspace:read', 'messages:read'] },
    }),
  );
  assert.match(minted.workspace_key, /^ccw_/);
  assert.deepEqual(minted.key.scopes, ['workspace:read', 'messages:read']);
  const reader = minted.workspace_key as string;
  assert.equal((await tool(app, reader, 'city_workspace')).statusCode, 200);
  const denied = await tool(app, reader, 'city_create_agent', {
    template: 'template:research-analyst@1.0.0',
    idempotency_key: randomUUID(),
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error, 'Workspace key does not permit this tool.');
  // No escalation: a key with workspace:keys cannot mint scopes it does not hold.
  const keysOnly = structured(
    await keyed.callTool({
      name: 'city_create_workspace_key',
      arguments: { label: 'key manager', scopes: ['workspace:read', 'workspace:keys'] },
    }),
  ).workspace_key as string;
  const escalate = await tool(app, keysOnly, 'city_create_workspace_key', {
    label: 'escalated',
    scopes: ['workspace:read', 'agents:create'],
  });
  assert.equal(escalate.statusCode, 403, escalate.body);
  const listed = structured(await keyed.callTool({ name: 'city_workspace_keys', arguments: {} }));
  assert.equal(listed.keys.length, 3);
  assert.ok(!JSON.stringify(listed).includes('ccw_'), 'secrets are never listed');
  const stored = await app.city.db.query<{ key_hash: string }>(
    'SELECT key_hash FROM workspace_keys',
  );
  for (const row of stored.rows) assert.match(row.key_hash, /^[a-f0-9]{64}$/);
  assert.ok(!stored.rows.some((row) => row.key_hash === reader));

  // Revocation takes effect at once on REST and on /mcp (401 with the resource challenge).
  const revoked = structured(
    await keyed.callTool({
      name: 'city_revoke_workspace_key',
      arguments: { key_id: minted.key.id },
    }),
  );
  assert.notEqual(revoked.key.revokedAt, null);
  assert.equal(revoked.revoked_self, false);
  assert.equal((await tool(app, reader, 'city_workspace')).statusCode, 401);
  const challenged = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${reader}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(challenged.status, 401);
  assert.match(
    challenged.headers.get('www-authenticate') ?? '',
    /resource_metadata=.*error="invalid_token"/,
  );
  // Non-key bearers keep the unchanged OAuth challenge.
  const oauth = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(oauth.status, 401);
  assert.match(oauth.headers.get('www-authenticate') ?? '', /The access token is invalid/);

  // The last active key cannot be revoked while no person co-owns the workspace.
  structured(
    await keyed.callTool({
      name: 'city_revoke_workspace_key',
      arguments: {
        key_id: listed.keys.find((item: any) => item.label === 'key manager').id,
      },
    }),
  );
  const last = await keyed.callTool({
    name: 'city_revoke_workspace_key',
    arguments: { key_id: created.key.id },
  });
  assert.equal(toolError(last).code, 'conflict');

  // An AI workspace can never sign in with a password.
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Parity Lab', password: PASSWORD }),
  });
  assert.equal(login.statusCode, 401);
});

test('creation is rate limited per address scope and capacity capped, separately from people', async (t) => {
  const app = await fixture(t, {
    aiWorkspaceCreatesPerSourcePerHour: 2,
    aiWorkspacesPerSite: 3,
    operators: 1,
  });
  assert.equal((await createWorkspace(app, 'First AI', undefined, '203.0.113.10')).statusCode, 201);
  assert.equal(
    (await createWorkspace(app, 'Second AI', undefined, '203.0.113.10')).statusCode,
    201,
  );
  const limited = await createWorkspace(app, 'Third AI', undefined, '203.0.113.10');
  assert.equal(limited.statusCode, 429, limited.body);
  assert.ok(limited.headers['retry-after']);
  // Replays are free: they neither count nor mint.
  const key = randomUUID();
  assert.equal((await createWorkspace(app, 'Site AI', key, '203.0.113.11')).statusCode, 201);
  const again = await createWorkspace(app, 'Site AI', key, '203.0.113.11');
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().secrets_already_issued, true);
  // The /24 site holds three AI workspaces at most.
  const full = await createWorkspace(app, 'Fourth AI', undefined, '203.0.113.12');
  assert.equal(full.statusCode, 409, full.body);
  assert.match(full.json().error, /capacity/);
  // A different network is unaffected; the human account cap stays separate.
  assert.equal(
    (await createWorkspace(app, 'Elsewhere', undefined, '198.51.100.7')).statusCode,
    201,
  );
  await account(app, 'Only person');
  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Second person', password: PASSWORD }),
  });
  assert.equal(second.statusCode, 409);
  const counters = await app.city.db.query<{ scope_key: string; workspaces: number }>(
    "SELECT scope_key,workspaces FROM ai_workspace_stats WHERE scope_key='global'",
  );
  assert.equal(Number(counters.rows[0]!.workspaces), 4);
  const people = await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(people.json().setupRequired, false);
});

test('a global cap bounds AI workspaces and a refused create leaves nothing behind', async (t) => {
  const app = await fixture(t, { aiWorkspacesGlobal: 1 });
  assert.equal((await createWorkspace(app, 'Only AI', undefined, '192.0.2.1')).statusCode, 201);
  assert.equal((await createWorkspace(app, 'Too many', undefined, '192.0.2.200')).statusCode, 409);
  const kinds = await app.city.db.query<{ kind: string; n: string }>(
    "SELECT kind, count(*)::text AS n FROM operators WHERE kind='ai' GROUP BY kind",
  );
  assert.equal(kinds.rows[0]!.n, '1');
  const counters = await app.city.db.query<{ scope_key: string; workspaces: number }>(
    'SELECT scope_key,workspaces FROM ai_workspace_stats',
  );
  // The refused reservation was fully released on every counter it touched.
  assert.ok(counters.rows.every((row) => Number(row.workspaces) <= 1));
});

test('a person claims an AI workspace, co-owns it in the console and can revoke its keys', async (t) => {
  const app = await fixture(t);
  const created = (await createWorkspace(app, 'Claimable AI')).json();
  const aiId = created.workspace_id as string;
  const agent = await tool(app, created.workspace_key, 'city_create_agent', {
    name: 'AI scout',
    capability: 'research',
    mode: 'hosted',
    idempotencyKey: randomUUID(),
  });
  assert.equal(agent.statusCode, 200, agent.body);

  const person = await account(app, 'Claiming person');
  const stranger = await account(app, 'Stranger person');
  const before = (await owner(app, person, 'GET', '/api/workspaces')).json();
  assert.deepEqual(
    before.workspaces.map((item: any) => item.kind),
    ['owner'],
  );
  // Selecting a workspace one does not co-own is refused without disclosing it.
  assert.equal((await owner(app, person, 'GET', '/api/snapshot', undefined, aiId)).statusCode, 404);
  assert.equal(
    (await owner(app, person, 'POST', '/api/workspaces/claim', { claim_token: 'ccwclaim_bad' }))
      .statusCode,
    404,
  );
  const claimed = await owner(app, person, 'POST', '/api/workspaces/claim', {
    claim_token: created.claim_token,
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.deepEqual(claimed.json().workspace, {
    id: aiId,
    name: 'Claimable AI',
    kind: 'ai',
    role: 'co-owner',
  });
  // Single use.
  assert.equal(
    (
      await owner(app, stranger, 'POST', '/api/workspaces/claim', {
        claim_token: created.claim_token,
      })
    ).statusCode,
    404,
  );
  const after = (await owner(app, person, 'GET', '/api/workspaces')).json();
  assert.deepEqual(
    after.workspaces.map((item: any) => [item.id, item.kind, item.role]),
    [
      [after.workspaces[0].id, 'owner', 'owner'],
      [aiId, 'ai', 'co-owner'],
    ],
  );
  const snapshot = (await owner(app, person, 'GET', '/api/snapshot', undefined, aiId)).json();
  assert.equal(snapshot.operator.id, aiId);
  assert.deepEqual(
    snapshot.agents.map((item: any) => item.name),
    ['AI scout'],
  );
  assert.ok(snapshot.events.some((item: any) => item.type === 'workspace.claimed'));
  // The person's own workspace is unchanged and still the default.
  const own = (await owner(app, person, 'GET', '/api/snapshot')).json();
  assert.notEqual(own.operator.id, aiId);
  assert.equal(own.agents.length, 0);
  // Tenant isolation: the stranger cannot select it.
  assert.equal(
    (await owner(app, stranger, 'GET', '/api/snapshot', undefined, aiId)).statusCode,
    404,
  );
  assert.equal(
    (await owner(app, stranger, 'GET', '/api/workspace-keys', undefined, aiId)).statusCode,
    404,
  );
  // Keys are an AI workspace feature.
  assert.equal((await owner(app, person, 'GET', '/api/workspace-keys')).statusCode, 409);

  // The co-owner sees the keys (never the secrets) and may revoke even the last one now.
  const keys = (await owner(app, person, 'GET', '/api/workspace-keys', undefined, aiId)).json();
  assert.equal(keys.keys.length, 1);
  assert.ok(!JSON.stringify(keys).includes('ccw_'));
  const minted = await owner(
    app,
    person,
    'POST',
    '/api/workspace-keys',
    { label: 'second AI', scopes: ['workspace:read', 'messages:read'] },
    aiId,
  );
  assert.equal(minted.statusCode, 201, minted.body);
  assert.equal((await tool(app, minted.json().workspace_key, 'city_workspace')).statusCode, 200);
  for (const key of [keys.keys[0], minted.json().key]) {
    const res = await owner(
      app,
      person,
      'DELETE',
      `/api/workspace-keys/${key.id}`,
      undefined,
      aiId,
    );
    assert.equal(res.statusCode, 200, res.body);
  }
  assert.equal((await tool(app, created.workspace_key, 'city_workspace')).statusCode, 401);
  assert.equal((await tool(app, minted.json().workspace_key, 'city_workspace')).statusCode, 401);
  // The AI workspace stays reachable to its co-owner.
  assert.equal((await owner(app, person, 'GET', '/api/snapshot', undefined, aiId)).statusCode, 200);
});

test('Base registration routes act in the selected co-owned AI workspace', async (t) => {
  const app = await fixture(t);
  const created = (await createWorkspace(app, 'Base AI')).json();
  const aiId = created.workspace_id as string;
  const other = (await createWorkspace(app, 'Unlinked AI')).json();
  const made = await tool(app, created.workspace_key, 'city_create_agent', {
    name: 'Base scout',
    capability: 'research',
    mode: 'hosted',
    idempotencyKey: randomUUID(),
  });
  assert.equal(made.statusCode, 200, made.body);
  const agentId = made.json().agent.id as string;
  // The Base routes find an agent's workspace through its manifest row.
  await app.city.db.query(
    "INSERT INTO agent_manifests(agent_id,revision,manifest_hash,manifest,created_at,operator_id) VALUES($1,1,'synthetic','{}'::jsonb,0,$2)",
    [agentId, aiId],
  );
  const person = await account(app, 'Base co-owner');
  const claimed = await owner(app, person, 'POST', '/api/workspaces/claim', {
    claim_token: created.claim_token,
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const registration = `/api/base/agents/${agentId}/registration`;

  // (a) The co-owned AI workspace selected: its agent is found.
  const selected = await owner(app, person, 'GET', registration, undefined, aiId);
  assert.equal(selected.statusCode, 200, selected.body);
  assert.deepEqual(selected.json(), { identities: [] });
  // (b) No selection: the person's own workspace, where the agent is not.
  assert.equal((await owner(app, person, 'GET', registration)).statusCode, 404);
  // (c) An AI workspace the person does not co-own, or a malformed selection: 404, no data.
  for (const workspace of [other.workspace_id as string, 'not-a-workspace']) {
    const refused = await owner(app, person, 'GET', registration, undefined, workspace);
    assert.equal(refused.statusCode, 404, refused.body);
    assert.equal(refused.json().identities, undefined);
  }
  // (d) Signed out: 401, also with a selection.
  for (const headers of [jsonHeaders, { ...jsonHeaders, 'x-city-workspace': aiId }]) {
    const anonymous = await app.inject({ method: 'GET', url: registration, headers });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
  }
  // (e) POST passes the same workspace check; past it, no chain runtime here answers 503.
  const body = { ownerAddress: `0x${'2'.repeat(40)}` };
  const register = `/api/base/agents/${agentId}/register`;
  const started = await owner(app, person, 'POST', register, body, aiId);
  assert.equal(started.statusCode, 503, started.body);
  assert.equal((await owner(app, person, 'POST', register, body)).statusCode, 404);
  assert.equal(
    (await owner(app, person, 'POST', register, body, other.workspace_id)).statusCode,
    404,
  );
});

test('a key handed to another AI cannot take the workspace over', async (t) => {
  const app = await fixture(t);
  const created = (await createWorkspace(app, 'Takeover target')).json();
  const primary = created.workspace_key as string;
  assert.equal(created.key.primary, true);
  // By default a minted key cannot manage keys at all.
  const helper = (await tool(app, primary, 'city_create_workspace_key', { label: 'AI-B' })).json();
  assert.equal(helper.key.primary, false);
  assert.ok(!helper.key.scopes.includes('workspace:keys'));
  // Nor approve cross-owner connections on the owner's behalf (F4: approval is explicit).
  assert.ok(!helper.key.scopes.includes('connections:approve'));
  const noKeys = await tool(app, helper.workspace_key, 'city_revoke_workspace_key', {
    key_id: created.key.id,
  });
  assert.equal(noKeys.statusCode, 403, noKeys.body);
  // Even a key explicitly given workspace:keys cannot revoke the primary key or a stronger key.
  const manager = (
    await tool(app, primary, 'city_create_workspace_key', {
      label: 'AI-B manager',
      scopes: ['workspace:read', 'workspace:keys'],
    })
  ).json();
  const takeover = await tool(app, manager.workspace_key, 'city_revoke_workspace_key', {
    key_id: created.key.id,
  });
  assert.equal(takeover.statusCode, 403, takeover.body);
  assert.match(takeover.json().error, /primary key/);
  const stronger = await tool(app, manager.workspace_key, 'city_revoke_workspace_key', {
    key_id: helper.key.id,
  });
  assert.equal(stronger.statusCode, 403, stronger.body);
  // Within its own scopes it may revoke (here a peer key with the same scopes).
  const peer = (
    await tool(app, primary, 'city_create_workspace_key', {
      label: 'peer',
      scopes: ['workspace:read', 'workspace:keys'],
    })
  ).json();
  assert.equal(
    (
      await tool(app, manager.workspace_key, 'city_revoke_workspace_key', {
        key_id: peer.key.id,
      })
    ).statusCode,
    200,
  );
  // The primary key still works and can revoke the others.
  assert.equal((await tool(app, primary, 'city_workspace')).statusCode, 200);
  assert.equal(
    (await tool(app, primary, 'city_revoke_workspace_key', { key_id: manager.key.id })).statusCode,
    200,
  );
});

test('capacity counts live workspaces; only empty idle ones are reclaimed at the bound', async (t) => {
  let now = Date.parse('2026-09-01T00:00:00Z');
  const lines: string[] = [];
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    limits: { aiWorkspacesGlobal: 2 },
    logLine: (line) => lines.push(line),
  });
  t.after(() => app.close());
  const idle = (await createWorkspace(app, 'Idle AI', undefined, '203.0.113.20')).json();
  const busy = (await createWorkspace(app, 'Busy AI', undefined, '198.51.100.20')).json();
  const agent = await tool(app, busy.workspace_key, 'city_create_agent', {
    name: 'Keeper',
    capability: 'research',
    mode: 'hosted',
    idempotencyKey: randomUUID(),
  });
  assert.equal(agent.statusCode, 200, agent.body);
  // At the bound and nothing is idle yet: refused, and pressure is reported and logged.
  const full = await createWorkspace(app, 'Third AI', undefined, '192.0.2.20');
  assert.equal(full.statusCode, 409, full.body);
  assert.ok(lines.some((line) => /"scope":"ai_workspaces".*"pressure":"critical"/.test(line)));
  const person = await account(app, 'Metrics person');
  const metrics = (await owner(app, person, 'GET', '/api/metrics/agents')).json();
  assert.deepEqual(metrics.ai_workspace_capacity, {
    workspaces_used: 2,
    workspaces_cap: 2,
    pressure: 'critical',
  });
  assert.equal(metrics.ai_owned.workspaces, 2);

  // 31 days later the empty workspace whose keys were never used is reclaimed; the workspace
  // with an agent never is, even though its key is idle too.
  now += 31 * 86_400_000;
  const third = await createWorkspace(app, 'Third AI', undefined, '192.0.2.20');
  assert.equal(third.statusCode, 201, third.body);
  assert.equal((await tool(app, idle.workspace_key, 'city_workspace')).statusCode, 401);
  assert.equal((await tool(app, busy.workspace_key, 'city_workspace')).statusCode, 200);
  const remaining = await app.city.db.query<{ id: string }>(
    "SELECT id FROM operators WHERE kind='ai' ORDER BY name",
  );
  assert.deepEqual(
    remaining.rows.map((row) => row.id).sort(),
    [busy.workspace_id, third.json().workspace_id].sort(),
  );
  assert.equal((await createWorkspace(app, 'Fourth AI', undefined, '192.0.2.21')).statusCode, 409);

  // Counters are exact; the admin reconcile finds and repairs drift.
  const { reconcileAiWorkspaces } = await import('../server/workspaces/admin.js');
  const clean = await reconcileAiWorkspaces(app.city.db, { confirm: false, now });
  assert.deepEqual(clean?.changes, []);
  assert.equal(clean?.workspaces, 2);
  await app.city.db.query(
    "UPDATE ai_workspace_stats SET workspaces=workspaces+5 WHERE scope_key='global'",
  );
  const drift = await reconcileAiWorkspaces(app.city.db, { confirm: true, now });
  assert.deepEqual(drift?.changes, [{ scope: 'global', counter: 7, actual: 2 }]);
  assert.deepEqual(
    (await reconcileAiWorkspaces(app.city.db, { confirm: false, now }))?.changes,
    [],
  );
});

test('claim preview lists the AI keys that keep access, and events never name the person', async (t) => {
  const app = await fixture(t);
  const created = (await createWorkspace(app, 'Preview AI')).json();
  await tool(app, created.workspace_key, 'city_create_workspace_key', { label: 'helper AI' });
  const person = await account(app, 'Secret Account Name');
  const preview = await owner(app, person, 'POST', '/api/workspaces/claim/preview', {
    claim_token: created.claim_token,
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().workspace.name, 'Preview AI');
  assert.deepEqual(
    preview
      .json()
      .active_keys.map((key: any) => [key.label, key.primary])
      .sort(),
    [
      ['helper AI', false],
      ['initial key', true],
    ],
  );
  assert.ok(!preview.body.includes('ccw_'));
  // Previewing does not claim.
  assert.equal(
    (await owner(app, person, 'GET', '/api/snapshot', undefined, created.workspace_id)).statusCode,
    404,
  );
  await owner(app, person, 'POST', '/api/workspaces/claim', { claim_token: created.claim_token });
  const minted = await owner(
    app,
    person,
    'POST',
    '/api/workspace-keys',
    { label: 'from console', scopes: ['workspace:read'] },
    created.workspace_id,
  );
  await owner(
    app,
    person,
    'DELETE',
    `/api/workspace-keys/${minted.json().key.id}`,
    undefined,
    created.workspace_id,
  );
  const events = (
    await owner(app, person, 'GET', '/api/snapshot', undefined, created.workspace_id)
  ).json().events;
  assert.ok(events.some((item: any) => item.type === 'workspace.claimed'));
  assert.ok(!JSON.stringify(events).includes('Secret Account Name'));
});

test('a co-owner claim link expires 7 days after the AI workspace was created', async (t) => {
  let now = Date.parse('2026-09-01T00:00:00Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const created = (await createWorkspace(app, 'Expiring claim')).json();
  now += 7 * 86_400_000 + 1;
  const person = await account(app, 'Late claimer');
  const preview = await owner(app, person, 'POST', '/api/workspaces/claim/preview', {
    claim_token: created.claim_token,
  });
  assert.equal(preview.statusCode, 404, preview.body);
  const claim = await owner(app, person, 'POST', '/api/workspaces/claim', {
    claim_token: created.claim_token,
  });
  assert.equal(claim.statusCode, 404, claim.body);
  assert.match(claim.json().error, /expired/);
});
