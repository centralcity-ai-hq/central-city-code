import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import {
  limitRequestRate,
  MemoryRateLimiter,
  PRINCIPAL_ADDRESS_FACTOR,
  PrincipalCache,
  presentedPrincipal,
  type PrincipalResolvers,
} from '../server/rate-limit.js';

const PER_MINUTE = 5;
const token = (prefix: string, fill: string) => `${prefix}_${fill.repeat(43).slice(0, 43)}`;

function harness() {
  const time = 1_800_000_000_000;
  const limiter = new MemoryRateLimiter(() => time);
  const lookups: string[] = [];
  const resolvers: PrincipalResolvers = {
    guest: async (value) => (lookups.push(value), value.endsWith('A') ? { agent_id: 'g1' } : null),
    workspaceKey: async (value) => (
      lookups.push(value),
      value.endsWith('A') ? { operatorId: 'w1' } : null
    ),
    accessToken: async (value) => (
      lookups.push(value),
      value.endsWith('A') ? { operatorId: 'w2' } : null
    ),
    session: async (value) => (
      lookups.push(value),
      value.startsWith('ok-')
        ? value
        : value === 'good-a'
          ? 'op-a'
          : value === 'good-b'
            ? 'op-b'
            : null
    ),
  };
  async function request(ip: string, authorization?: string, cookie?: string): Promise<boolean> {
    try {
      await limitRequestRate(
        async (key, max, windowMs) => {
          if (!(await limiter.hit(key, max, windowMs)).allowed) throw new Error('429');
        },
        ip,
        presentedPrincipal(authorization, cookie, resolvers),
        PER_MINUTE,
      );
      return true;
    } catch {
      return false;
    }
  }
  const burst = async (count: number, ...args: Parameters<typeof request>) => {
    let allowed = 0;
    for (let index = 0; index < count; index++) if (await request(...args)) allowed++;
    return allowed;
  };
  return { request, burst, lookups };
}

test('two principals behind one address each get the full budget', async () => {
  const h = harness();
  assert.equal(await h.burst(PER_MINUTE + 2, '198.51.100.7', undefined, 'good-a'), PER_MINUTE);
  assert.equal(await h.burst(PER_MINUTE + 2, '198.51.100.7', undefined, 'good-b'), PER_MINUTE);
  for (const prefix of ['crc', 'ccw', 'cca'])
    assert.equal(
      await h.burst(PER_MINUTE + 2, '198.51.100.7', `Bearer ${token(prefix, 'A')}`),
      PER_MINUTE,
      prefix,
    );
  // Anonymous traffic from the same address still has its own, untouched budget.
  assert.equal(await h.burst(PER_MINUTE + 2, '198.51.100.7'), PER_MINUTE);
});

test('one principal is limited regardless of address', async () => {
  const h = harness();
  let allowed = 0;
  for (let index = 0; index < PER_MINUTE * 3; index++)
    if (await h.request(`203.0.113.${index + 1}`, `Bearer ${token('ccw', 'A')}`)) allowed++;
  assert.equal(allowed, PER_MINUTE);
});

test('invalid credentials are charged to the address bucket', async () => {
  const h = harness();
  // Rotating garbage tokens and cookies all draw from one per-address budget.
  let allowed = 0;
  for (let index = 0; index < PER_MINUTE * 2; index++) {
    const garbage = index % 2 ? `Bearer ${token('cca', String(index % 10))}` : undefined;
    if (await h.request('192.0.2.9', garbage, garbage ? undefined : `bad-${index}`)) allowed++;
  }
  assert.equal(allowed, PER_MINUTE);
  // Which also exhausts that address for anonymous requests.
  assert.equal(await h.request('192.0.2.9'), false);
  // Unknown bearer formats are not a credential: per address, no lookup.
  const before = h.lookups.length;
  assert.equal(await h.request('192.0.2.9', 'Bearer something-else'), false);
  assert.equal(h.lookups.length, before);
});

test('anonymous requests stay per address', async () => {
  const h = harness();
  assert.equal(await h.burst(PER_MINUTE + 3, '192.0.2.50'), PER_MINUTE);
  assert.equal(await h.burst(PER_MINUTE + 3, '192.0.2.51'), PER_MINUTE);
});

test('the per-address floor stops a flood of credentialed requests', async () => {
  const h = harness();
  const floor = PER_MINUTE * PRINCIPAL_ADDRESS_FACTOR;
  let allowed = 0;
  for (let index = 0; index < floor + 20; index++) {
    // Many distinct valid principals from one address: the address floor still applies.
    if (await h.request('198.51.100.99', undefined, `ok-${index}`)) allowed++;
  }
  assert.equal(allowed, floor);
  // Unbounded distinct garbage: lookups per address are bounded by the floor.
  const before = h.lookups.length;
  for (let index = 0; index < floor * 2; index++)
    await h.request('198.51.100.100', `Bearer ${token('crc', String(index % 10))}`);
  assert.ok(h.lookups.length - before <= floor);
});

test('a resolved principal is cached so repeat requests do not look it up again', async () => {
  let time = 1_000;
  const cache = new PrincipalCache(() => time, 60_000);
  let calls = 0;
  const presented = presentedPrincipal(undefined, 'cookie', {
    session: async () => (calls++, 'op'),
  })!;
  assert.equal(await cache.resolve(presented), 'owner-api:op');
  assert.equal(await cache.resolve(presented), 'owner-api:op');
  assert.equal(calls, 1);
  time += 60_001;
  await cache.resolve(presented);
  assert.equal(calls, 2);
  // Invalid credentials are not cached.
  const bad = presentedPrincipal(undefined, 'bad', { session: async () => (calls++, null) })!;
  await cache.resolve(bad);
  await cache.resolve(bad);
  assert.equal(calls, 4);
});

test('the REST API limits signed-in owners per session, not per shared address', async (t) => {
  const time = 1_800_000_000_000;
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    now: () => time,
    limits: { registrationsPerWindow: 100, apiRequestsPerMinute: PER_MINUTE },
  });
  t.after(() => app.close());
  const shared = '198.51.100.20';
  const local = { 'content-type': 'application/json', 'x-city-request': '1' };
  const signUp = async (name: string, remoteAddress: string) => {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: local,
      remoteAddress,
      payload: JSON.stringify({ name, password: 'Synthetic signup password' }),
    });
    assert.equal(reply.statusCode, 201);
    const cookie = reply.cookies.find((entry) => entry.name === 'cc_session');
    assert.ok(cookie);
    return `cc_session=${cookie.value}`;
  };
  const a = await signUp('Owner A', '192.0.2.1');
  const b = await signUp('Owner B', '192.0.2.2');
  const burst = async (count: number, cookie?: string, remoteAddress = shared) => {
    const codes: number[] = [];
    for (let index = 0; index < count; index++)
      codes.push(
        (
          await app.inject({
            method: 'GET',
            url: '/api/snapshot',
            remoteAddress,
            headers: cookie ? { cookie } : {},
          })
        ).statusCode,
      );
    return codes;
  };
  const okCount = (codes: number[]) => codes.filter((code) => code !== 429).length;
  assert.equal(okCount(await burst(PER_MINUTE + 2, a)), PER_MINUTE);
  assert.equal(okCount(await burst(PER_MINUTE + 2, b)), PER_MINUTE);
  // Owner A is still limited from another address.
  assert.deepEqual(await burst(1, a, '192.0.2.77'), [429]);
  // Garbage session cookies and anonymous requests share the address budget.
  assert.equal(okCount(await burst(2, 'cc_session=forged')), 2);
  assert.equal(okCount(await burst(PER_MINUTE)), PER_MINUTE - 2);
});

test('the principal cache stays bounded at its cap and evicts the oldest entry', async () => {
  const cache = new PrincipalCache(() => 1_000);
  assert.equal(cache.maxEntries, 50_000);
  const calls = new Map<string, number>();
  const presented = (id: string) =>
    presentedPrincipal(undefined, id, {
      session: async () => (calls.set(id, (calls.get(id) ?? 0) + 1), id),
    })!;
  for (let index = 0; index <= cache.maxEntries; index++)
    await cache.resolve(presented(`s${index}`));
  assert.equal(cache.size, cache.maxEntries);
  // The newest is still cached; the first one was evicted and is looked up again.
  await cache.resolve(presented(`s${cache.maxEntries}`));
  assert.equal(calls.get(`s${cache.maxEntries}`), 1);
  await cache.resolve(presented('s0'));
  assert.equal(calls.get('s0'), 2);
  assert.equal(cache.size, cache.maxEntries);
});

test('sessions, workspace keys and OAuth grants of one owner share one budget', async () => {
  const time = 1_800_000_000_000;
  const limiter = new MemoryRateLimiter(() => time);
  const resolvers: PrincipalResolvers = {
    workspaceKey: async () => ({ operatorId: 'same-owner' }),
    accessToken: async () => ({ operatorId: 'same-owner' }),
    session: async () => 'same-owner',
    guest: async (value) => ({ agent_id: value }),
  };
  const hit = async (authorization?: string, cookie?: string) => {
    try {
      await limitRequestRate(
        async (key, max, windowMs) => {
          if (!(await limiter.hit(key, max, windowMs)).allowed) throw new Error('429');
        },
        '198.51.100.5',
        presentedPrincipal(authorization, cookie, resolvers),
        PER_MINUTE,
      );
      return true;
    } catch {
      return false;
    }
  };
  let allowed = 0;
  for (let index = 0; index < PER_MINUTE * 4; index++) {
    const variant = index % 4;
    if (
      await hit(
        variant === 0
          ? `Bearer ${token('ccw', 'A')}`
          : variant === 1
            ? `Bearer ${token('ccw', 'B')}`
            : variant === 2
              ? `Bearer ${token('cca', 'C')}`
              : undefined,
        variant === 3 ? 'session' : undefined,
      )
    )
      allowed++;
  }
  assert.equal(allowed, PER_MINUTE);
  // Guests stay per credential: two guests of the same room each get the full budget.
  assert.equal(await hit(`Bearer ${token('crc', 'X')}`), true);
  assert.equal(await hit(`Bearer ${token('crc', 'Y')}`), true);
});

test('two workspace keys of one workspace share the owner budget end to end', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: PER_MINUTE },
  });
  t.after(() => app.close());
  const json = { 'content-type': 'application/json' };
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: json,
    remoteAddress: '192.0.2.40',
    payload: JSON.stringify({ name: 'Bucket Lab', idempotency_key: crypto.randomUUID() }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const first = created.json().workspace_key as string;
  const tool = (key: string, name: string, args: unknown, remoteAddress: string) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: { ...json, 'x-city-request': '1', authorization: `Bearer ${key}` },
      remoteAddress,
      payload: JSON.stringify(args),
    });
  const minted = await tool(
    first,
    'city_create_workspace_key',
    { label: 'second', scopes: ['workspace:read'] },
    '192.0.2.41',
  );
  assert.equal(minted.statusCode, 200, minted.body);
  const second = minted.json().workspace_key as string;
  let allowed = 0;
  for (let index = 0; index < PER_MINUTE * 2; index++) {
    const reply = await tool(index % 2 ? second : first, 'city_workspace', {}, '198.51.100.60');
    if (reply.statusCode !== 429) allowed++;
  }
  // One owner budget, minus the call that minted the second key.
  assert.equal(allowed, PER_MINUTE - 1);
});

test('MCP counts keys per owner on /mcp and only guest credentials on /mcp/open', async (t) => {
  const app = await createApp({
    dataDir: 'memory://',
    startWorkers: false,
    limits: { apiRequestsPerMinute: PER_MINUTE },
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    remoteAddress: '192.0.2.50',
    payload: JSON.stringify({ name: 'Scope Lab', idempotency_key: crypto.randomUUID() }),
  });
  const key = created.json().workspace_key as string;
  const mcp = (url: string, remoteAddress: string, authorization?: string) =>
    app.inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorization ? { authorization } : {}),
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
  const shared = '198.51.100.70';
  // On /mcp/open a workspace key is not a credential: it draws from the address budget.
  const open: number[] = [];
  for (let index = 0; index < PER_MINUTE; index++)
    open.push((await mcp('/mcp/open', shared, `Bearer ${key}`)).statusCode);
  assert.ok(!open.includes(429), open.join(','));
  assert.equal((await mcp('/mcp/open', shared)).statusCode, 429);
  // On /mcp the same key is limited per owner, so the exhausted address does not block it.
  const keyed: number[] = [];
  for (let index = 0; index < PER_MINUTE + 1; index++)
    keyed.push((await mcp('/mcp', shared, `Bearer ${key}`)).statusCode);
  assert.ok(!keyed.slice(0, PER_MINUTE).includes(429), keyed.join(','));
  assert.equal(keyed[PER_MINUTE], 429);
  // An invalid key on /mcp is charged to the (exhausted) address.
  assert.equal(
    (await mcp('/mcp', '198.51.100.70', `Bearer ccw_${'z'.repeat(43)}`)).statusCode,
    429,
  );
});
