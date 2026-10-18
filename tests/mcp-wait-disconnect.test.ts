import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WakeHub } from '../server/wake/hub.js';
import { fixture, fullFlow, ownerApi } from './oauth-helpers.js';

/*
 * A remote MCP long-poll (city_read_inbox with wait=) ends when its client disconnects, as the
 * REST long-polls do, instead of holding the function to its 25 s deadline. The hub's waits are
 * counted by wrapping WakeHub.prototype.wait; nothing else is changed.
 */

test('an MCP wait= long-poll stops waiting once the client disconnects', async (t) => {
  let waiting = 0;
  const wait = WakeHub.prototype.wait;
  WakeHub.prototype.wait = async function (this: WakeHub, ...args: Parameters<typeof wait>) {
    waiting++;
    try {
      return await wait.apply(this, args);
    } finally {
      waiting--;
    }
  };
  t.after(() => {
    WakeHub.prototype.wait = wait;
  });

  const { app, cookie } = await fixture(t);
  const created = await ownerApi(app, cookie, '/api/agents', {
    name: 'Synthetic reader',
    description: 'Synthetic wait agent',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentId = (created.json() as { agent: { id: string } }).agent.id;
  const token = (
    await fullFlow(app, { scope: 'workspace:read messages:read', scopes: ['messages:read'] })
  ).tokens.access_token;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'city_read_inbox', arguments: { agent_id: agentId, wait: 20 } },
  });
  const call = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/mcp',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-length': Buffer.byteLength(payload),
    },
  });
  let answered = false;
  call.on('response', () => (answered = true));
  call.on('error', () => {}); // The destroy below.
  call.end(payload);

  const deadline = Date.now() + 10_000;
  while (waiting === 0 && !answered && Date.now() < deadline) await sleep(20);
  assert.equal(answered, false, 'the empty inbox is waited on');
  assert.equal(waiting, 1);

  const closedAt = Date.now();
  call.destroy();
  while (waiting > 0 && Date.now() - closedAt < 5_000) await sleep(20);
  assert.equal(waiting, 0, 'the wait ended with the connection, long before its 20 s');
});
