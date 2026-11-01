import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WakeHub } from '../server/wake/hub.js';
import { fixture, ownerApi } from './oauth-helpers.js';

/*
 * Audit R1-10: the REST tool route (POST /api/assistant/tools/:tool) ends a wait= long-poll when
 * its client disconnects, as /mcp does, instead of holding the wait to its deadline. The hub's
 * waits are counted by wrapping WakeHub.prototype.wait; nothing else is changed. Synthetic data.
 */

async function setup(t: { after: (fn: () => unknown) => void }) {
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
    name: 'Synthetic REST reader',
    description: 'Synthetic wait agent',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentId = (created.json() as { agent: { id: string } }).agent.id;
  const granted = await ownerApi(app, cookie, '/api/assistant-access', {
    label: 'Synthetic REST grant',
    scopes: ['workspace:read', 'messages:read'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const token = (granted.json() as { token: string }).token;
  return { app, agentId, token, waiting: () => waiting };
}

test('a REST wait= tool call stops waiting once the client disconnects', async (t) => {
  const { app, agentId, token, waiting } = await setup(t);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  const payload = JSON.stringify({ agent_id: agentId, wait: 20 });
  const call = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/assistant/tools/city_read_inbox',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${token}`,
      'content-length': Buffer.byteLength(payload),
    },
  });
  let answered = false;
  call.on('response', () => (answered = true));
  call.on('error', () => {}); // The destroy below.
  call.end(payload);

  const deadline = Date.now() + 10_000;
  while (waiting() === 0 && !answered && Date.now() < deadline) await sleep(20);
  assert.equal(answered, false, 'the empty inbox is waited on');
  assert.equal(waiting(), 1);

  const closedAt = Date.now();
  call.destroy();
  while (waiting() > 0 && Date.now() - closedAt < 5_000) await sleep(20);
  assert.equal(waiting(), 0, 'the wait ended with the connection, long before its 20 s');
});

test('a REST wait= tool call still answers normally when the client stays', async (t) => {
  const { app, agentId, token } = await setup(t);
  // No wait: an immediate answer.
  const now = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_read_inbox',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify({ agent_id: agentId }),
  });
  assert.equal(now.statusCode, 200, now.body);
  assert.deepEqual((now.json() as { messages: unknown[] }).messages, []);
  // A short wait on an empty inbox runs to its limit and answers with the same empty page.
  const started = Date.now();
  const waited = await app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_read_inbox',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify({ agent_id: agentId, wait: 1 }),
  });
  assert.equal(waited.statusCode, 200, waited.body);
  assert.deepEqual((waited.json() as { messages: unknown[] }).messages, []);
  assert.ok(Date.now() - started >= 900, 'the wait was not cut short');
});
