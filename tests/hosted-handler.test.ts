import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedHandler, withoutRewriteParameter } from '../server/vercel-handler.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

test('checkpoint diagnostics distinguish pending startup and omit request secrets', async () => {
  const lines: string[] = [];
  let resolve!: (app: FastifyInstance) => void;
  const app = new Promise<FastifyInstance>((done) => {
    resolve = done;
  });
  const handler = createHostedHandler(
    () => app,
    (line) => lines.push(line),
  );
  const response = new EventEmitter() as ServerResponse;
  const request = {
    url: '/api/cron/count-checkpoint?secret=synthetic-private',
    headers: { authorization: 'Bearer synthetic-private' },
  } as IncomingMessage;
  const pending = handler(request, response);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event),
    ['count_log.request.entry'],
  );
  const server = new EventEmitter();
  server.on('request', () => response.emit('finish'));
  resolve({ ready: async () => {}, server } as unknown as FastifyInstance);
  await pending;
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event),
    ['count_log.request.entry', 'count_log.request.app_ready', 'count_log.request.response_end'],
  );
  assert.equal(lines.join('').includes('synthetic-private'), false);
  assert.equal(new Set(lines.map((line) => JSON.parse(line).trace)).size, 1);
});

test('the Vercel rewrite parameter is removed and every other query byte is kept', () => {
  assert.equal(
    withoutRewriteParameter('/api/messages/conversations?path=messages%2Fconversations'),
    '/api/messages/conversations',
  );
  assert.equal(
    withoutRewriteParameter('/api/messages/conversations?path=messages/conversations'),
    '/api/messages/conversations',
  );
  assert.equal(
    withoutRewriteParameter('/api/agents/a1/inbox?since=0&limit=20&path=agents%2Fa1%2Finbox'),
    '/api/agents/a1/inbox?since=0&limit=20',
  );
  assert.equal(
    withoutRewriteParameter('/api/x?path=x&b=%2B%20c'),
    '/api/x?b=%2B%20c',
    'other parameters keep their exact encoding (signed runtime requests)',
  );
  assert.equal(withoutRewriteParameter('/oauth/token?path=token'), '/oauth/token');
  assert.equal(withoutRewriteParameter('/a2a/abc/tasks?path=abc%2Ftasks'), '/a2a/abc/tasks');
});

test('anything that is not the rewritten tail is left untouched', () => {
  assert.equal(withoutRewriteParameter('/api/messages/summary'), '/api/messages/summary');
  assert.equal(withoutRewriteParameter('/api/files?path=other'), '/api/files?path=other');
  assert.equal(withoutRewriteParameter('/mcp?path=mcp'), '/mcp?path=mcp');
  assert.equal(withoutRewriteParameter('/index.html?path=x'), '/index.html?path=x');
  assert.equal(withoutRewriteParameter('/api/a?path=%E0%A4%A'), '/api/a?path=%E0%A4%A');
});
