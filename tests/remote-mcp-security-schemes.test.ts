import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { createRemoteServer } from '../server/remote-mcp/tools.js';
import { fixture, fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';

// Per-tool securitySchemes (OpenAI Apps SDK, https://developers.openai.com/apps-sdk/build/auth):
// a top-level tool descriptor field, mirrored in _meta for clients that only read _meta.

type Listed = { name: string; securitySchemes?: unknown; _meta?: { securitySchemes?: unknown } };

const requiredScopes = (tool: string) => [
  ...new Set([
    'workspace:read',
    (ASSISTANT_TOOL_SCOPES as Record<string, string>)[tool] ?? 'workspace:read',
  ]),
];

test('/mcp declares oauth2 with the scopes each tool needs, top-level and in _meta', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: ASSISTANT_SCOPES.join(' '),
    scopes: [...ASSISTANT_SCOPES],
  });
  const tools = rpcResult((await mcpCall(app, tokens.access_token, 'tools/list')).body).result
    .tools as Listed[];
  assert.ok(tools.length > 30);
  for (const tool of tools) {
    const expected = [{ type: 'oauth2', scopes: requiredScopes(tool.name) }];
    assert.deepEqual(tool.securitySchemes, expected, tool.name);
    assert.deepEqual(tool._meta?.securitySchemes, expected, `${tool.name} _meta mirror`);
  }
  const control = tools.find((tool) => tool.name === 'city_control');
  assert.deepEqual(control?.securitySchemes, [
    { type: 'oauth2', scopes: ['workspace:read', 'agents:control'] },
  ]);
});

test('a narrower grant keeps tools/list filtering and the per-tool securitySchemes', async (t) => {
  const { app } = await fixture(t);
  const scopes = ['workspace:read', 'rooms:join'];
  const { tokens } = await fullFlow(app, { scope: scopes.join(' '), scopes });
  const tools = rpcResult((await mcpCall(app, tokens.access_token, 'tools/list')).body).result
    .tools as Listed[];
  assert.ok(tools.length > 0);
  assert.ok(!tools.some((tool) => tool.name === 'city_control'));
  for (const tool of tools)
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: requiredScopes(tool.name) }]);
});

test('/mcp/open declares noauth on every tool, top-level and in _meta', async (t) => {
  const { app } = await fixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.statusCode, 200, res.body);
  const tools = rpcResult(res.body).result.tools as Listed[];
  assert.ok(tools.some((tool) => tool.name === 'city_list_templates'));
  for (const tool of tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: 'noauth' }], tool.name);
    assert.deepEqual(
      tool._meta?.securitySchemes,
      [{ type: 'noauth' }],
      `${tool.name} _meta mirror`,
    );
  }
});

test('room-only credentials declare no scheme (neither anonymous nor OAuth)', async () => {
  const server = createRemoteServer(
    async () => ({}),
    () => ({ status: 500, message: 'unused' }),
    { roomOnly: true },
  );
  const list = (
    server.server as unknown as { _requestHandlers: Map<string, Function> }
  )._requestHandlers.get('tools/list')!;
  const { tools } = (await list(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    {},
  )) as {
    tools: Listed[];
  };
  assert.ok(tools.some((tool) => tool.name === 'city_room_post'));
  for (const tool of tools) {
    assert.equal(tool.securitySchemes, undefined, tool.name);
    assert.equal(tool._meta?.securitySchemes, undefined, tool.name);
  }
});

test('city_list_templates descriptions carry no demo wording', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: ASSISTANT_SCOPES.join(' '),
    scopes: [...ASSISTANT_SCOPES],
  });
  const res = await mcpCall(app, tokens.access_token, 'tools/call', {
    name: 'city_list_templates',
    arguments: {},
  });
  const listed = rpcResult(res.body).result.structuredContent as {
    templates: { ref: string; title: string; description: string }[];
  };
  assert.ok(listed.templates.length >= 4);
  for (const template of listed.templates)
    assert.doesNotMatch(`${template.title} ${template.description}`, /\bdemo/i, template.ref);
});
