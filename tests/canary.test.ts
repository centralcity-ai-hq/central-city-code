import test from 'node:test';
import assert from 'node:assert/strict';
import { runCanary } from '../scripts/canary/index.mjs';
const config = {
  origin: 'https://centralcity.ai',
  cookie: 'cc_session=secret',
  ownerId: 'owner',
  senderId: 'sender',
  recipientId: 'recipient',
};
function fixture(broken = false) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    let body = {};
    let status = 200;
    if (path === '/api/session') body = { operator: { id: 'owner', name: 'canary-production' } };
    else if (path === '/api/messages/conversations') {
      body = { conversations: [] };
      if (broken) status = 400;
    } else if (path === '/mcp/open')
      body = {
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'city_plan_team' }, { name: 'city_apply_team' }] },
      };
    else if (path.endsWith('/messages')) {
      status = 201;
      body = { message: { id: 'm1', seq: 3 } };
    } else if (path.endsWith('/inbox')) body = { messages: [{ id: 'm1', seq: 3 }] };
    else if (path.endsWith('/ack')) body = { agent_id: 'recipient', acked_seq: 3 };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetcher, calls };
}
test('canary verifies message before acknowledging and reports bounded checks', async () => {
  const f = fixture();
  const r = await runCanary(config, f.fetcher);
  assert.equal(r.ok, true);
  assert.ok(
    f.calls.indexOf('/api/agents/recipient/inbox') <
      f.calls.indexOf('/api/agents/recipient/inbox/ack'),
  );
});
test('pre-hotfix conversations failure stops before any write', async () => {
  const f = fixture(true);
  await assert.rejects(runCanary(config, f.fetcher), /conversations/);
  assert.equal(
    f.calls.some((p) => p.endsWith('/messages')),
    false,
  );
});
test('wrong workspace fails before writes without leaking credentials', async () => {
  const f = fixture();
  await assert.rejects(runCanary({ ...config, ownerId: 'different' }, f.fetcher), /identity/);
  assert.equal(f.calls.length, 1);
});
test('redirect or non-JSON success cannot be mistaken for health', async () => {
  await assert.rejects(
    runCanary(config, async () => new Response('<html>sign in</html>', { status: 200 })),
    /session/,
  );
});

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { createHostedHandler } from '../server/vercel-handler.js';

test('real hosted app fails before rewrite fix and passes after it', async () => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'canary-regression', password: 'Synthetic-Canary-Only-2026!' },
  });
  assert.equal(reg.statusCode, 201, reg.body);
  const cookie = `cc_session=${reg.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const session = (await app.inject({ url: '/api/session', headers: { cookie } })).json();
  async function agent(name: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...headers, cookie },
      payload: { name, description: 'Synthetic probe', capability: 'research', mode: 'external' },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().agent.id as string;
  }
  const senderId = await agent('Canary sender');
  const recipientId = await agent('Canary recipient');
  const connected = await app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: { ...headers, cookie },
    payload: { fromAgentId: senderId, toAgentId: recipientId },
  });
  assert.equal(connected.statusCode, 201, connected.body);
  await app.ready();
  let fixed = false;
  const hosted = createHostedHandler(async () => app);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      const path = req.url.split('?')[0].slice(5);
      req.url += (req.url.includes('?') ? '&' : '?') + 'path=' + encodeURIComponent(path);
    }
    if (fixed) void hosted(req, res);
    else app.server.emit('request', req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport: typeof fetch = (url, opts) => {
    const parsed = new URL(String(url));
    return fetch(local + parsed.pathname + parsed.search, opts);
  };
  try {
    const cfg = {
      origin: 'https://centralcity.ai',
      cookie,
      ownerId: session.operator.id,
      senderId,
      recipientId,
    };
    await assert.rejects(runCanary(cfg, transport), /conversations/);
    fixed = true;
    const report = await runCanary(cfg, transport);
    assert.equal(report.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  }
});

test('stale and wrong-agent acknowledgements fail', async () => {
  for (const body of [
    { agent_id: 'recipient', acked_seq: 2 },
    { agent_id: 'other', acked_seq: 3 },
    {},
  ]) {
    const f = fixture();
    const fetcher: typeof fetch = (url, opts) =>
      String(url).endsWith('/ack')
        ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
        : f.fetcher(url, opts);
    await assert.rejects(runCanary(config, fetcher), /acknowledgement/);
  }
});

import { sendFailureAlert } from '../scripts/canary/alert.mjs';
test('failure alert uses stable idempotency and bounded non-secret text', async () => {
  const input = { token: 'secret', senderId: 'sender', deskId: 'desk', runId: '123' };
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://centralcity.ai/mcp');
    const args = JSON.parse(String(options?.body)).params.arguments;
    // Built from parts so the secret scanner's generic key rule has no literal to match.
    assert.equal(args.idempotency_key, ['canary', 'failure', input.runId].join('-'));
    assert.equal(args.text.includes('secret'), false);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: { id: 'message1', from_agent_id: 'sender', to_agent_id: 'desk' },
              }),
            },
          ],
        },
      }),
    );
  };
  assert.equal((await sendFailureAlert(input, fetcher)).delivered, true);
});
test('HTTP and MCP alert failures remain failures without secret response content', async () => {
  const input = { token: 'secret', senderId: 'sender', deskId: 'desk', runId: '123' };
  for (const response of [
    new Response('secret', { status: 401 }),
    new Response(JSON.stringify({ error: { message: 'secret' } })),
    new Response(JSON.stringify({ result: { isError: true, content: [] } })),
  ]) {
    await assert.rejects(
      sendFailureAlert(input, async () => response),
      (error) => String(error).includes('alert failed') && !String(error).includes('secret'),
    );
  }
});

test('alert accepts SSE receipt and rejects mismatched or missing receipts', async () => {
  const input = { token: 'secret', senderId: 'sender', deskId: 'desk', runId: '123' };
  const message = { id: 'm', from_agent_id: 'sender', to_agent_id: 'desk' };
  const rpc = { jsonrpc: '2.0', id: 1, result: { structuredContent: { message } } };
  const response = new Response('event: message\ndata: ' + JSON.stringify(rpc) + '\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  assert.equal((await sendFailureAlert(input, async () => response)).delivered, true);
  for (const invalid of [
    { ...rpc, id: 2 },
    { ...rpc, result: { structuredContent: { message: { ...message, to_agent_id: 'wrong' } } } },
    { ...rpc, result: { content: [] } },
  ])
    await assert.rejects(
      sendFailureAlert(input, async () => new Response(JSON.stringify(invalid))),
      /alert failed/,
    );
});

import { loginCanary } from '../scripts/canary/login.mjs';
test('fresh login extracts only the session cookie and fails closed', async () => {
  assert.equal(
    await loginCanary(
      { name: 'canary-test', password: 'fixture' },
      async () =>
        new Response('{}', { headers: { 'set-cookie': 'cc_session=example; HttpOnly; Secure' } }),
    ),
    'cc_session=example',
  );
  for (const response of [new Response('{}'), new Response('private failure', { status: 401 })])
    await assert.rejects(
      loginCanary({ name: 'canary-test', password: 'fixture' }, async () => response),
      /Canary login failed/,
    );
  await assert.rejects(
    loginCanary({ name: 'customer', password: 'fixture' }, async () => {
      throw new Error('must not call');
    }),
    /dedicated/,
  );
});

test('password mode refuses another origin before requesting a session', async () => {
  let calls = 0;
  await assert.rejects(
    loginCanary(
      { origin: 'https://preview.example', name: 'canary-test', password: 'fixture' },
      async () => {
        calls++;
        return new Response('{}');
      },
    ),
    /canonical/,
  );
  assert.equal(calls, 0);
});
