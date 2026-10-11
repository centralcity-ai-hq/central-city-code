import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { createApp } from '../server/app.js';
import {
  fixture,
  fullFlow,
  mcpCall,
  OWNER,
  PASSWORD,
  rpcResult,
  consent,
  TestProvider,
} from './oauth-helpers.js';
import type { Snapshot } from '../shared/types.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';

/** A grant with every scope, so tools/list offers every tool (it hides what a grant cannot call). */
const EVERY_SCOPE = { scope: ASSISTANT_SCOPES.join(' '), scopes: [...ASSISTANT_SCOPES] };

/** Whether a grant holding `granted` can call `tool` (workspace:read plus the tool's own scope). */
function callable(tool: string, granted: readonly string[]): boolean {
  const own = (ASSISTANT_TOOL_SCOPES as Record<string, string>)[tool] ?? 'workspace:read';
  return granted.includes('workspace:read') && granted.includes(own);
}

const agentArgs = (idempotencyKey = randomUUID()) => ({
  name: 'Remote record',
  description: 'Synthetic only',
  capability: 'extract',
  mode: 'hosted',
  idempotencyKey,
});
const callTool = async (
  app: Parameters<typeof mcpCall>[0],
  token: string,
  name: string,
  args: unknown = {},
) => {
  const res = await mcpCall(app, token, 'tools/call', { name, arguments: args });
  assert.equal(res.statusCode, 200, res.body);
  return rpcResult(res.body).result as {
    isError?: boolean;
    structuredContent?: any;
    content: { type: string; text: string }[];
  };
};

test('remote tools mirror the bridge with schemas, annotations and structured results', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, EVERY_SCOPE);
  const list = await mcpCall(app, tokens.access_token, 'tools/list');
  const tools = rpcResult(list.body).result.tools as {
    name: string;
    inputSchema: any;
    outputSchema: any;
    annotations: Record<string, boolean>;
  }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'city_workspace',
      'city_create_agent',
      'city_create_job',
      'city_get_job',
      'city_cancel_job',
      'city_list_templates',
      'city_plan_team',
      'city_apply_team',
      'city_control',
      'city_send_message',
      'city_read_inbox',
      'city_ack_inbox',
      'city_create_invite',
      'city_list_invites',
      'city_revoke_invite',
      'city_set_connection_requests',
      'city_request_connection',
      'city_list_connection_requests',
      'city_decide_connection',
      'city_revoke_connection',
      'city_create_room',
      'city_list_room_templates',
      'city_room_link',
      'city_join_room',
      'city_room_post',
      'city_room_read',
      'city_room_members',
      'city_room_remove',
      'city_room_close',
      'city_room_leave',
      'city_room_search',
      'city_room_update',
      'city_room_pin',
      'city_room_unpin',
      'city_room_pins',
      'city_room_brief',
      'city_room_overview',
      'city_mentions',
      'city_ack_mentions',
      'city_set_wake_webhook',
      'city_clear_wake_webhook',
      'city_publish_result',
      'city_unpublish_result',
      'city_ask',
      'city_report_reuse',
    ],
  );
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.outputSchema.type, 'object');
  }
  // Directory review: every tool's hints, one row per tool (openWorld: reaches other owners,
  // people or outside URLs; destructive: can remove, revoke, deny or overwrite).
  const OPEN_WORLD = new Set([
    'city_room_post',
    'city_send_message',
    'city_request_connection',
    'city_join_room',
    'city_publish_result',
    'city_ask',
    'city_set_wake_webhook',
    'city_create_invite',
    // Pins are seen by every member of the room (other owners).
    'city_room_pin',
    'city_room_unpin',
    // Returns messages written by other owners' agents and people.
    'city_room_read',
    // Create or change a space other owners' members share.
    'city_create_room',
    'city_room_update',
    'city_room_remove',
    'city_room_close',
    'city_room_leave',
  ]);
  const DESTRUCTIVE = new Set([
    'city_cancel_job',
    'city_control',
    'city_apply_team',
    // Updates a same-named agent in place.
    'city_create_agent',
    'city_decide_connection',
    'city_revoke_connection',
    'city_revoke_invite',
    'city_room_remove',
    'city_room_close',
    'city_room_leave',
    'city_room_unpin',
    'city_clear_wake_webhook',
    'city_unpublish_result',
    'city_room_link',
    'city_set_wake_webhook',
    // city_room_update stays false: reversible history change, nobody loses access.
  ]);
  for (const tool of tools) {
    assert.equal(
      tool.annotations.openWorldHint,
      OPEN_WORLD.has(tool.name),
      `${tool.name} openWorld`,
    );
    assert.equal(
      tool.annotations.destructiveHint,
      DESTRUCTIVE.has(tool.name),
      `${tool.name} destructive`,
    );
  }
  assert.equal(byName.city_workspace!.annotations.readOnlyHint, true);
  assert.equal(byName.city_get_job!.annotations.readOnlyHint, true);
  assert.equal(byName.city_create_agent!.annotations.readOnlyHint, false);
  assert.equal(byName.city_create_agent!.annotations.destructiveHint, true);
  assert.equal(byName.city_create_agent!.annotations.idempotentHint, true);
  assert.equal(byName.city_cancel_job!.annotations.destructiveHint, true);
  // Legacy fields and manifest mode share one schema; the backend requires one complete form.
  assert.equal(byName.city_create_agent!.inputSchema.required, undefined);
  for (const field of [
    'name',
    'capability',
    'mode',
    'idempotencyKey',
    'manifest',
    'template',
    'dry_run',
    'idempotency_key',
  ])
    assert.ok(byName.city_create_agent!.inputSchema.properties[field], field);
  assert.equal(byName.city_list_templates!.annotations.readOnlyHint, true);
  assert.equal(byName.city_list_room_templates!.annotations.readOnlyHint, true);
  assert.ok(byName.city_create_room!.inputSchema.properties.room_template_id);
  assert.equal(byName.city_plan_team!.annotations.readOnlyHint, true);
  assert.equal(byName.city_apply_team!.annotations.readOnlyHint, false);
  assert.equal(byName.city_control!.annotations.destructiveHint, true);
});

test('idempotency keys, jobs and machine-actionable errors behave as on the bridge', async (t) => {
  const { app, cookie } = await fixture(t);
  const { tokens } = await fullFlow(app);
  const token = tokens.access_token;
  const key = randomUUID();
  const first = await callTool(app, token, 'city_create_agent', agentArgs(key));
  assert.ok(!first.isError, JSON.stringify(first));
  assert.equal(first.structuredContent.agent.name, 'Remote record');
  assert.equal(first.structuredContent.connectionRequired, true);
  assert.deepEqual(JSON.parse(first.content[0]!.text), first.structuredContent);
  const again = await callTool(app, token, 'city_create_agent', agentArgs(key));
  assert.equal(again.structuredContent.agent.id, first.structuredContent.agent.id);
  const conflict = await callTool(app, token, 'city_create_agent', {
    ...agentArgs(key),
    name: 'Changed',
  });
  assert.equal(conflict.isError, true);
  assert.equal(JSON.parse(conflict.content[0]!.text).error.code, 'conflict');
  assert.equal(JSON.parse(conflict.content[0]!.text).error.kind, 'conflict');
  const missing = await callTool(app, token, 'city_get_job', { id: randomUUID() });
  assert.equal(missing.isError, true);
  assert.deepEqual(JSON.parse(missing.content[0]!.text).error, {
    code: 'not_found',
    kind: 'not_found',
    message: 'Job not found.',
    retryable: false,
  });
  const invalid = await callTool(app, token, 'city_create_agent', { name: 'x' });
  assert.equal(invalid.isError, true);
  const reserved = await callTool(app, token, 'city_create_job', {
    requesterId: randomUUID(),
    providerId: randomUUID(),
    input: 'x',
    idempotencyKey: 'assistant:reserved',
  });
  const reservedError = JSON.parse(reserved.content[0]!.text).error;
  assert.equal(reservedError.code, 'invalid_arguments');
  // Field-level detail, shared with REST 400s (server/validation-errors.ts).
  assert.deepEqual(reservedError.issues, [{ path: 'idempotencyKey', message: 'Is not valid' }]);
  assert.equal(reservedError.message, 'Check these fields: idempotencyKey (is not valid).');
  const invalidError = JSON.parse(invalid.content[0]!.text).error;
  assert.equal(invalidError.code, 'invalid_arguments');
  assert.ok(
    invalidError.issues.some(
      (issue: { path: string; message: string }) =>
        issue.path === 'idempotencyKey' && issue.message === 'Required',
    ),
  );

  // A job between demo agents the owner connected, then read and cancel it.
  const headers = { 'content-type': 'application/json', 'x-city-request': '1', cookie };
  await app.inject({ method: 'POST', url: '/api/demo/start', headers, payload: '{}' });
  await app.city.tick();
  const state = (
    await app.inject({ method: 'GET', url: '/api/snapshot', headers })
  ).json() as Snapshot;
  const job = await callTool(app, token, 'city_create_job', {
    requesterId: state.connections[0]!.fromAgentId,
    providerId: state.connections[0]!.toAgentId,
    input: 'Synthetic amount 42',
    idempotencyKey: randomUUID(),
  });
  assert.ok(!job.isError, JSON.stringify(job));
  const id = job.structuredContent.job.id;
  assert.equal((await callTool(app, token, 'city_get_job', { id })).structuredContent.job.id, id);
  assert.deepEqual((await callTool(app, token, 'city_cancel_job', { id })).structuredContent, {
    ok: true,
  });
  const events = (await app.inject({ method: 'GET', url: '/api/snapshot', headers })).json()
    .events as { message: string }[];
  assert.ok(
    events.some((event) => /Synthetic MCP client\) used city_cancel_job/.test(event.message)),
  );
});

for (const mode of ['auto', 'legacy'] as const)
  test(`end to end: official SDK client completes OAuth and operates agents (${mode})`, async (t) => {
    const app = await createApp({ dataDir: ':memory:', startWorkers: false });
    t.after(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const registered = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-city-request': '1' },
      body: JSON.stringify({ name: OWNER, password: PASSWORD }),
    });
    assert.equal(registered.status, 201);

    const provider = new TestProvider();
    const endpoint = new URL(`${base}/mcp`);
    const client = new Client(
      { name: 'central-city-remote-test', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    await assert.rejects(
      client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider })),
      (error: unknown) => error instanceof UnauthorizedError,
    );
    assert.ok(provider.authorizationUrl, 'the SDK should request authorization');
    assert.equal(provider.authorizationUrl.origin, base);
    assert.equal(provider.authorizationUrl.searchParams.get('resource'), `${base}/mcp`);
    assert.equal(provider.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.match(String(provider.info?.client_id), /^ccc_/);

    const callback = await consent(provider.authorizationUrl);
    assert.equal(callback.searchParams.get('state'), 'sdk-state');
    const finishing = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    await finishing.finishAuth(callback.searchParams);
    assert.match(String(provider.saved?.access_token), /^cca_/);

    const connected = new Client(
      { name: 'central-city-remote-test', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    await connected.connect(
      new StreamableHTTPClientTransport(endpoint, { authProvider: provider }),
    );
    t.after(() => connected.close());
    const tools = await connected.listTools();
    // Only the tools this grant can call (no workspace-key tools for an OAuth grant).
    const granted = String(provider.saved?.scope ?? '').split(' ');
    const listed = tools.tools.map((tool) => tool.name);
    assert.ok(listed.includes('city_create_agent') && listed.includes('city_workspace'));
    for (const name of listed)
      assert.ok(callable(name, granted), `${name} is listed but not callable`);
    assert.ok(!listed.includes('city_workspace_keys'));
    const key = randomUUID();
    const created = await connected.callTool({
      name: 'city_create_agent',
      arguments: {
        name: 'SDK remote agent',
        description: 'Created over remote MCP',
        capability: 'verify',
        mode: 'external',
        idempotencyKey: key,
      },
    });
    assert.ok(!created.isError, JSON.stringify(created));
    const agent = (created.structuredContent as any).agent;
    assert.equal(agent.name, 'SDK remote agent');
    assert.equal((created.structuredContent as any).runtimeSetupRequired, true);
    const workspace = await connected.callTool({ name: 'city_workspace', arguments: {} });
    assert.ok(!workspace.isError);
    const agents = (workspace.structuredContent as any).agents as { id: string; name: string }[];
    assert.deepEqual(
      agents.map((item) => [item.id, item.name]),
      [[agent.id, 'SDK remote agent']],
    );
    assert.equal((workspace.structuredContent as any).operator.name, OWNER);
  });

test('server instructions and tool descriptions describe; they never direct unrequested calls', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, EVERY_SCOPE);
  const DIRECTIVE =
    /(^|[.:;!]\s+)always\b|\bsession start\b|\bbefore (computing|calling|you (do|compute|start))\b|\bkeep (calling|checking|polling)\b|\breply when\b|\bcall city_\w+ first\b|\bthen (call|report|read)\b|\bread (it|them) first\b|\bset up a check\b/i;
  const post = (url: string, method: string, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method,
        params:
          method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'directive-test', version: '1' },
              }
            : {},
      },
    });
  const token = tokens.access_token;
  const texts: [string, string][] = [
    [
      'oauth instructions',
      rpcResult((await post('/mcp', 'initialize', token)).body).result.instructions,
    ],
    [
      'open instructions',
      rpcResult((await post('/mcp/open', 'initialize')).body).result.instructions,
    ],
  ];
  for (const [url, bearer] of [
    ['/mcp', token],
    ['/mcp/open', undefined],
  ] as const) {
    const listed = rpcResult((await post(url, 'tools/list', bearer)).body).result.tools as {
      name: string;
      description: string;
    }[];
    for (const tool of listed) texts.push([`${url} ${tool.name}`, tool.description]);
  }
  assert.ok(texts.length > 40);
  for (const [name, text] of texts) {
    assert.ok(text, name);
    assert.doesNotMatch(text, DIRECTIVE, name);
  }
  // The descriptive essentials stay: what it is, and the untrusted-data warning.
  assert.match(texts[0]![1], /untrusted data/);
  assert.match(texts[1]![1], /untrusted data/);
});

test('a duplicate room slug over MCP answers the specific service code with the generic kind', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: 'workspace:read agents:create rooms:host',
    scopes: ['agents:create', 'rooms:host'],
  });
  const token = tokens.access_token;
  const agent = await callTool(app, token, 'city_create_agent', agentArgs());
  assert.ok(!agent.isError, JSON.stringify(agent));
  const room = (idempotency_key: string) =>
    callTool(app, token, 'city_create_room', {
      agent_id: agent.structuredContent.agent.id,
      name: 'Slug room',
      slug: 'slug-room-dup',
      idempotency_key,
    });
  const first = await room(randomUUID());
  assert.ok(!first.isError, JSON.stringify(first));
  const dup = await room(randomUUID());
  assert.equal(dup.isError, true);
  const { error } = JSON.parse(dup.content[0]!.text);
  assert.equal(error.code, 'slug_taken');
  assert.equal(error.kind, 'conflict');
  assert.equal(error.retryable, false);
});

test('workspace-key tools are listed to AI workspace key (ccw_) sessions only, never to OAuth', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app);
  const KEY_TOOLS = [
    'city_workspace_keys',
    'city_create_workspace_key',
    'city_revoke_workspace_key',
  ];
  const names = async (token: string) =>
    (
      rpcResult((await mcpCall(app, token, 'tools/list')).body).result.tools as { name: string }[]
    ).map((tool) => tool.name);
  const oauth = await names(tokens.access_token);
  for (const name of KEY_TOOLS) assert.ok(!oauth.includes(name), name);
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Key Lab', idempotency_key: randomUUID() }),
  });
  assert.ok(created.statusCode < 300, created.body);
  const key = created.json().workspace_key as string;
  assert.match(key, /^ccw_/);
  const keyed = await names(key);
  for (const name of KEY_TOOLS) assert.ok(keyed.includes(name), name);
  const listed = await callTool(app, key, 'city_workspace_keys');
  assert.ok(!listed.isError, JSON.stringify(listed));
});

// Ajv is not a direct dependency; use the copy the MCP SDK already ships (as protocol-schemas does).
const sdkRequire = createRequire(
  fileURLToPath(import.meta.resolve('@modelcontextprotocol/server')),
);
const Ajv2020 = sdkRequire('ajv/dist/2020').default as new (options: object) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown };
};

test('paged city_room_members results validate against the advertised outputSchema', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: 'workspace:read agents:create rooms:host rooms:join',
    scopes: ['agents:create', 'rooms:host', 'rooms:join'],
  });
  const token = tokens.access_token;
  const agents: string[] = [];
  for (let index = 0; index < 3; index++) {
    const agent = await callTool(app, token, 'city_create_agent', agentArgs());
    assert.ok(!agent.isError, JSON.stringify(agent));
    agents.push(agent.structuredContent.agent.id);
  }
  const room = await callTool(app, token, 'city_create_room', {
    agent_id: agents[0],
    name: 'Paged room',
    idempotency_key: randomUUID(),
  });
  assert.ok(!room.isError, JSON.stringify(room));
  const roomId = room.structuredContent.room.id as string;
  for (const agentId of agents.slice(1)) {
    const joined = await callTool(app, token, 'city_join_room', {
      link: room.structuredContent.link.link,
      agent_id: agentId,
      idempotency_key: randomUUID(),
    });
    assert.ok(!joined.isError, JSON.stringify(joined));
  }
  const listed = rpcResult((await mcpCall(app, token, 'tools/list')).body).result.tools as {
    name: string;
    outputSchema: object;
  }[];
  const advertised = listed.find((tool) => tool.name === 'city_room_members')!.outputSchema;
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(advertised);
  // One member per page: every page but the last carries next_cursor, and each validates.
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await callTool(app, token, 'city_room_members', {
      room_id: roomId,
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(!page.isError, JSON.stringify(page));
    assert.ok(
      validate(page.structuredContent),
      `page ${pages + 1}: ${JSON.stringify(validate.errors)}`,
    );
    seen.push(...(page.structuredContent.members as { id: string }[]).map((member) => member.id));
    cursor = page.structuredContent.next_cursor;
    if (pages < 2) assert.equal(typeof cursor, 'string', `page ${pages + 1} has next_cursor`);
    pages++;
  } while (cursor !== undefined && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual([...seen].sort(), [...agents].sort());
});

test('tools/list offers only the tools a grant can call; an unlisted tool still answers the step-up', async (t) => {
  const { app } = await fixture(t);
  // The scopes a chat app such as Claude asks for by default (the 401 challenge).
  const scopes = [
    'workspace:read',
    'agents:create',
    'rooms:join',
    'rooms:host',
    'messages:read',
    'messages:send',
  ];
  const { tokens } = await fullFlow(app, { scope: scopes.join(' '), scopes });
  const granted = tokens.scope.split(' ');
  const list = rpcResult((await mcpCall(app, tokens.access_token, 'tools/list')).body).result
    .tools as { name: string }[];
  const names = list.map((tool) => tool.name);
  for (const name of names)
    assert.ok(callable(name, granted), `${name} is listed but not callable`);
  for (const hidden of [
    'city_create_invite',
    'city_control',
    'city_create_job',
    'city_decide_connection',
  ])
    assert.ok(!names.includes(hidden), `${hidden} needs a scope this grant lacks`);
  for (const shown of [
    'city_workspace',
    'city_create_room',
    'city_join_room',
    'city_room_post',
    'city_send_message',
  ])
    assert.ok(names.includes(shown), `${shown} is callable and listed`);
  // Still registered: calling it answers insufficient_scope naming the missing scope.
  const call = await mcpCall(app, tokens.access_token, 'tools/call', {
    name: 'city_control',
    arguments: { agent_id: randomUUID(), action: 'pause' },
  });
  assert.match(call.body, /insufficient_scope|agents:control/);
});
