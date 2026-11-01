import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';

/**
 * The MCP routes answer failures themselves (their own error handler, and the tool error mapper),
 * so the root handler's request_failed line never runs for them. A 500 there still leaves a line:
 * class names only, never a message. Synthetic data.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-mcp-error-log-test-root-secret';

const rpc = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

test('a 500 on the MCP routes leaves a line in the error log', async (t) => {
  const lines: string[] = [];
  const database = await PGlite.create('memory://');
  const app = await createApp({
    database,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
    logLine: (line) => lines.push(line),
  });
  // The database is closed on purpose below, so closing the app may complain about it.
  t.after(() => app.close().catch(() => undefined));
  const post = (authorization?: string) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'centralcity.ai',
        ...(authorization ? { authorization } : {}),
      },
      payload: JSON.stringify(rpc(1, 'tools/list')),
      remoteAddress: '198.51.100.41',
    });
  // The database is gone, so checking this key throws inside the MCP scope.
  await database.close();
  lines.length = 0;
  const res = await post('Bearer ccw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(res.statusCode, 500, res.body);
  const logged = lines.filter((line) => line.includes('"request_failed"'));
  assert.equal(logged.length, 1, lines.join('\n'));
  const line = JSON.parse(logged[0]!) as { route: string; where?: string };
  assert.equal(line.route.startsWith('/mcp'), true);
  assert.match(line.where ?? '', /@[\w$.-]+:\d+/, 'where it was thrown');
});
