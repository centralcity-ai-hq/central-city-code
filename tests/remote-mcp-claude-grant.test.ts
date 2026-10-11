import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';

/*
 * Claude Connectors Directory readiness: a connector must never list a tool the signed-in client
 * cannot call. Claude.ai connects with exactly the scopes below (the 401 challenge's scope list);
 * every tool it is shown must run past the scope gate on that fresh grant, and tools that need
 * another scope must not be listed at all (reviewers otherwise hit "Authentication required").
 */
const CLAUDE_SCOPES = [
  'workspace:read',
  'agents:create',
  'rooms:join',
  'rooms:host',
  'messages:read',
  'messages:send',
];

const requiredScope = (name: string) =>
  (ASSISTANT_TOOL_SCOPES as Record<string, string>)[name] ?? 'workspace:read';

test('a fresh Claude grant lists only tools its scopes allow, and none of them is refused for scope', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app, {
    scope: CLAUDE_SCOPES.join(' '),
    scopes: CLAUDE_SCOPES.filter((scope) => scope !== 'workspace:read'),
  });
  const token = tokens.access_token;
  const listed = (
    rpcResult((await mcpCall(app, token, 'tools/list')).body).result.tools as { name: string }[]
  ).map((tool) => tool.name);
  assert.ok(listed.length > 0, 'tools are listed');

  // Nothing outside the grant is shown (e.g. connections:*, agents:control, jobs:*).
  const outside = listed.filter((name) => !CLAUDE_SCOPES.includes(requiredScope(name)));
  assert.deepEqual(
    outside,
    [],
    `listed but not callable with Claude's scopes: ${outside.join(', ')}`,
  );
  for (const hidden of [
    'city_list_invites',
    'city_create_invite',
    'city_control',
    'city_cancel_job',
  ])
    assert.ok(!listed.includes(hidden), `${hidden} must not be listed to this grant`);

  // Every listed tool gets past the scope gate: with empty arguments it may fail validation or
  // answer a domain error, but never insufficient_scope / "Authentication required".
  for (const name of listed) {
    const res = await mcpCall(app, token, 'tools/call', { name, arguments: {} });
    assert.notEqual(res.statusCode, 401, `${name}: 401`);
    assert.notEqual(res.statusCode, 403, `${name}: 403 step-up`);
    const body = res.body;
    assert.ok(
      !/insufficient_scope/.test(body),
      `${name}: refused for scope: ${body.slice(0, 300)}`,
    );
  }
});
