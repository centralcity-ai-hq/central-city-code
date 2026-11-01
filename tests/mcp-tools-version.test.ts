import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import {
  RECONNECT_HINT,
  TOOLS_VERSION_META_KEY,
  toolsVersion,
  withReconnectHint,
} from '../server/remote-mcp/tools-version.js';
import { rpcResult } from './oauth-helpers.js';

/**
 * A client that loaded its tool list before a deploy is told to reconnect (tools-version.ts):
 * tools/list carries a tools version, and an unknown tool or unknown argument answer keeps its
 * content and gains the hint. Synthetic data.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-tools-version-test-root-not-a-real-secret';

async function openMcp(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  return async (method: string, params: unknown) => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/open',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
      remoteAddress: '203.0.113.40',
    });
    assert.equal(response.statusCode, 200, response.body);
    return rpcResult(response.body);
  };
}

test('toolsVersion is short, order-independent and changes with a schema', () => {
  const a = toolsVersion([
    ['x', { type: 'object' }],
    ['y', { type: 'object', properties: { n: { type: 'number' } } }],
  ]);
  const b = toolsVersion([
    ['y', { type: 'object', properties: { n: { type: 'number' } } }],
    ['x', { type: 'object' }],
  ]);
  const c = toolsVersion([
    ['x', { type: 'object' }],
    ['y', { type: 'object', properties: { m: { type: 'number' } } }],
  ]);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('tools/list advertises a stable tools version', async (t) => {
  const rpc = await openMcp(t);
  const first = await rpc('tools/list', {});
  const second = await rpc('tools/list', {});
  const version = first.result._meta?.[TOOLS_VERSION_META_KEY];
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.equal(second.result._meta[TOOLS_VERSION_META_KEY], version);
  assert.ok(first.result.tools.length > 0);
});

test('an unknown tool keeps the not-found error and adds the reconnect hint', async (t) => {
  const rpc = await openMcp(t);
  const answer = await rpc('tools/call', { name: 'city_tool_from_the_future', arguments: {} });
  assert.ok(answer.error, JSON.stringify(answer));
  assert.match(answer.error.message, /Tool city_tool_from_the_future not found/);
  assert.ok(answer.error.message.includes(RECONNECT_HINT));
  assert.equal(answer.error.data.reconnect_hint, RECONNECT_HINT);
  assert.match(answer.error.data.tools_version, /^[0-9a-f]{12}$/);
});

test('an unknown argument keeps invalid_arguments and adds the hint as a field and a line', async (t) => {
  const rpc = await openMcp(t);
  const { result } = await rpc('tools/call', {
    name: 'city_create_workspace',
    arguments: { argument_from_an_old_schema: 1 },
  });
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.error.code, 'invalid_arguments');
  assert.ok(
    body.error.issues.some((issue: { message: string }) => issue.message === 'Unknown field'),
  );
  assert.equal(body.error.reconnect_hint, RECONNECT_HINT);
  assert.equal(result.content.at(-1).text, RECONNECT_HINT);
});

test('results without an unknown field, or with a specific hint, are unchanged', () => {
  const ok = { content: [{ type: 'text', text: '{"ok":true}' }] };
  assert.equal(withReconnectHint(ok, 'abc'), ok);
  const required = {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: { code: 'invalid_arguments', issues: [{ path: 'q', message: 'Required' }] },
        }),
      },
    ],
  };
  assert.equal(withReconnectHint(required, 'abc'), required);
  const aliased = {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'invalid_arguments',
            issues: [{ path: 'message', message: 'Unknown field' }],
            hint: 'Put the message in text (or parts).',
          },
        }),
      },
    ],
  };
  assert.equal(withReconnectHint(aliased, 'abc'), aliased);
});
