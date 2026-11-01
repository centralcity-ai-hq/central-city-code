// Request-level smoke test of the built server bundle (api/_bundle/index.mjs).
//
// Unit tests import server modules one by one, so an import cycle that only exists in the
// single-file bundle (a crash at load, or a constant that is still undefined when a request
// runs) passes every test. This script loads the bundle exactly as api/index.js does, boots
// the bundled app against an in-memory PGlite database (no network, no Postgres URL), serves it
// through the bundled hosted handler on an ephemeral node:http port, and sends real HTTP
// requests. Any 5xx, thrown error or failed expectation exits 1 with the response body.
//
// Run: pnpm smoke:bundle (builds the bundle first).
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ORIGIN = 'https://centralcity.ai';
const HOST = 'centralcity.ai';
process.env.CITY_INVITE_FLOW ??= '1';
// A fixed, non-secret stand-in: hosted mode refuses to start without 32+ characters.
process.env.CITY_RATE_LIMIT_KEY ??= 'bundle-smoke-rate-limit-stand-in-value';

const results = [];
function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}`);
  for (const r of results) console.error(`  ok   ${r}`);
  process.exit(1);
}
process.on('unhandledRejection', (error) => fail('unhandled rejection', error?.stack ?? error));
process.on('uncaughtException', (error) => fail('uncaught exception', error?.stack ?? error));

const bundlePath = fileURLToPath(new URL('../api/_bundle/index.mjs', import.meta.url));
process.setSourceMapsEnabled(true);
let bundle;
try {
  bundle = await import(pathToFileURL(bundlePath).href);
} catch (error) {
  fail('load bundle', error?.stack ?? error);
}
if (typeof bundle.default !== 'function') fail('load bundle', 'no default handler export');
results.push('load bundle (default handler present)');
if (typeof bundle.createApp !== 'function' || typeof bundle.createHostedHandler !== 'function')
  fail('load bundle', 'createApp / createHostedHandler not exported by the bundle');

const { PGlite } = await import('@electric-sql/pglite');
const database = await PGlite.create('memory://');
let app;
const handler = bundle.createHostedHandler(
  async () => {
    app = await bundle.createApp({
      database,
      hosted: {
        databaseUrl: 'postgres://unused.invalid/smoke',
        publicOrigin: ORIGIN,
        allowedOrigins: [ORIGIN],
      },
      startWorkers: false,
    });
    return app;
  },
  (line) => console.error(line),
);
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let cookie = '';
function send(method, path, { body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: HOST,
          origin: ORIGIN,
          'x-city-request': '1',
          'x-forwarded-proto': 'https',
          ...(cookie ? { cookie } : {}),
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...headers,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Sends a request; any 5xx or an unexpected status fails the run with the body. */
async function step(name, method, path, opts, expected) {
  let res;
  try {
    res = await send(method, path, opts);
  } catch (error) {
    fail(name, error?.stack ?? error);
  }
  if (res.status >= 500) fail(name, `${method} ${path} -> ${res.status}\n${res.text}`);
  if (expected && !expected.includes(res.status))
    fail(name, `${method} ${path} -> ${res.status}, expected ${expected.join('/')}\n${res.text}`);
  results.push(`${name}: ${res.status}`);
  return res;
}

function rpcBody(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const data = t
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  return JSON.parse(data);
}
const rpc = (method, params) => ({
  body: { jsonrpc: '2.0', id: randomUUID(), method, params },
  headers: { accept: 'application/json, text/event-stream' },
});
const json = (name, res) => {
  try {
    return JSON.parse(res.text);
  } catch {
    fail(name, `not JSON: ${res.text.slice(0, 500)}`);
  }
};

// 1) Public stats.
await step('GET /api/public/stats', 'GET', '/api/public/stats');

// 2) Open MCP tools/list.
{
  const res = await step(
    'POST /mcp/open tools/list',
    'POST',
    '/mcp/open',
    rpc('tools/list', {}),
    [200],
  );
  const tools = rpcBody(res.text).result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) fail('POST /mcp/open tools/list', res.text);
  results[results.length - 1] += ` (${tools.length} tools)`;
}

// 3) Guest tool without a credential: must be refused before anything else, never a 500.
await step(
  'guest city_room_read, no credential',
  'POST',
  '/api/public/invites/tools/city_room_read',
  { body: {} },
  [401],
);

// 4) Authenticated MCP with an invalid bearer.
await step(
  'POST /mcp invalid bearer tools/call',
  'POST',
  '/mcp',
  {
    ...rpc('tools/call', { name: 'city_list_agents', arguments: {} }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer invalid-smoke-value',
    },
  },
  [401],
);

// 5) Full invite-guest flow: owner, agent, room, join link, join, read, post.
{
  const reg = await step(
    'register owner',
    'POST',
    '/api/auth/register',
    {
      body: { name: 'Bundle smoke host', password: 'Bundle smoke host password' },
    },
    [201],
  );
  const setCookie = reg.headers['set-cookie'] ?? [];
  cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const agent = await step(
    'create agent',
    'POST',
    '/api/agents',
    {
      body: { name: 'Host', capability: 'research', mode: 'hosted' },
    },
    [201],
  );
  const room = await step(
    'create room',
    'POST',
    '/api/rooms',
    {
      body: {
        name: 'Smoke room',
        agent_id: json('create agent', agent).agent.id,
        idempotency_key: randomUUID(),
      },
    },
    [201],
  );
  const link = await step(
    'create join link',
    'POST',
    '/api/links',
    {
      body: { target: 'room', room_id: json('create room', room).room.id },
    },
    [201],
  );
  cookie = '';
  const code = new URL(json('create join link', link).url).pathname.split('/').at(-1);
  const joined = await step(
    'join via /mcp/open',
    'POST',
    '/mcp/open',
    rpc('tools/call', {
      name: 'city_join_invite',
      arguments: {
        invite_link: `${ORIGIN}/j/${code}`,
        name: 'Bundle smoke guest',
        idempotency_key: randomUUID(),
      },
    }),
    [200],
  );
  const credential = rpcBody(joined.text).result?.structuredContent?.room_credential;
  if (typeof credential !== 'string' || !credential.startsWith('crc_'))
    fail('join via /mcp/open', joined.text);
  const auth = { authorization: `Bearer ${credential}` };
  await step(
    'guest city_room_post',
    'POST',
    '/api/public/invites/tools/city_room_post',
    {
      body: { text: 'bundle smoke', idempotency_key: randomUUID() },
      headers: auth,
    },
    [200],
  );
  await step(
    'guest city_room_read',
    'POST',
    '/api/public/invites/tools/city_room_read',
    {
      body: {},
      headers: auth,
    },
    [200],
  );
}

console.log('bundle request smoke passed');
for (const r of results) console.log(`  ok   ${r}`);
server.close();
await app?.close();
await database.close().catch(() => {});
process.exit(0);
