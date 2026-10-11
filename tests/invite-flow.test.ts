import type { CityLimits } from '../server/limits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-invite-test-root-not-a-real-secret';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  limits: Partial<CityLimits> = {},
) {
  let time = Date.now();
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => time,
    limits,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.12') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Invite host',
    password: 'Synthetic invite test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const host = { cookie };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    { name: 'Invite room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    host,
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const bootstrap = (address = '203.0.113.12') =>
    post('/api/public/invites/bootstrap', { code }, {}, address);
  const redeem = (handle: string, address = '203.0.113.12') =>
    post('/api/public/invites/redeem', { code, handle, name: 'Invited AI' }, {}, address);
  const admit = async (address = '203.0.113.12') => {
    const start = await bootstrap(address);
    assert.equal(start.statusCode, 200, start.body);
    const joined = await redeem(start.json().handle, address);
    assert.equal(joined.statusCode, 200, joined.body);
    return joined.json();
  };
  const invoke = (credential: string, tool: string, args: unknown = {}) =>
    post(`/api/public/invites/tools/${tool}`, args, { authorization: `Bearer ${credential}` });
  return {
    app,
    post,
    host,
    roomId,
    code,
    bootstrap,
    redeem,
    admit,
    invoke,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
test('invited AI joins, posts and reads with room-only authority', async (t) => {
  const f = await fixture(t),
    guest = await f.admit();
  assert.match(guest.credential, /^crc_/);
  assert.equal(guest.room_id, f.roomId);
  const posted = await f.invoke(guest.credential, 'city_room_post', {
    text: 'Hello from invited AI',
    idempotency_key: randomUUID(),
  });
  assert.equal(posted.statusCode, 200, posted.body);
  // Its own post is not unread for it (no wake on its own post); a lookup (since 0) shows it.
  const unread = await f.invoke(guest.credential, 'city_room_read');
  assert.equal(unread.statusCode, 200, unread.body);
  assert.ok(
    !unread.json().messages.some((m: { text: string }) => m.text === 'Hello from invited AI'),
  );
  const read = await f.invoke(guest.credential, 'city_room_read', { since: 0 });
  assert.equal(read.statusCode, 200, read.body);
  assert.ok(read.json().messages.some((m: { text: string }) => m.text === 'Hello from invited AI'));
  assert.equal(
    (await f.invoke(guest.credential, 'city_room_read', { room_id: randomUUID() })).statusCode,
    403,
  );
  assert.equal(
    (await f.invoke(guest.credential, 'city_create_agent', { name: 'Escalation' })).statusCode,
    404,
  );
  const workspace = await f.post(
    '/api/assistant/tools/city_create_agent',
    { name: 'Escalation', capability: 'research', mode: 'external' },
    { authorization: `Bearer ${guest.credential}` },
  );
  assert.ok([401, 403].includes(workspace.statusCode), workspace.body);
  const counts = await f.app.city.db.query<{ uses: number }>('SELECT uses FROM join_links');
  assert.equal(counts.rows[0]!.uses, 1);
});
test('pickup is source-bound and single-use without repeated admission', async (t) => {
  const f = await fixture(t),
    start = await f.bootstrap();
  assert.equal(start.statusCode, 200, start.body);
  assert.equal((await f.redeem(start.json().handle, '198.51.100.99')).statusCode, 404);
  const joined = await f.redeem(start.json().handle);
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal((await f.redeem(start.json().handle)).statusCode, 404);
  assert.equal((await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length, 1);
});
test('revoked invitation refuses pickup redemption and expired pickup rolls back', async (t) => {
  const f = await fixture(t),
    start = await f.bootstrap();
  assert.equal(start.statusCode, 200, start.body);
  await f.app.city.db.query('UPDATE join_links SET revoked_at=$1', [Date.now()]);
  assert.equal((await f.redeem(start.json().handle)).statusCode, 404);
  assert.equal((await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length, 0);
  await f.app.city.db.query('UPDATE join_links SET revoked_at=NULL');
  f.advance(600_001);
  assert.equal((await f.redeem(start.json().handle)).statusCode, 404);
});
test('host removal and credential expiry stop invited AI access', async (t) => {
  const f = await fixture(t),
    guest = await f.admit();
  const removed = await f.post(
    `/api/rooms/${f.roomId}/members/${guest.agent_id}/remove`,
    {},
    f.host,
  );
  assert.equal(removed.statusCode, 200, removed.body);
  const afterRemoval = await f.invoke(guest.credential, 'city_room_read');
  assert.equal(afterRemoval.statusCode, 403, afterRemoval.body);
  assert.equal(afterRemoval.json().code, 'removed_from_room');
  // A guest without an account is held by its join source: the same address is refused.
  assert.equal(removed.json().guest_source_blocked, true);
  const blocked = await f.bootstrap();
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().code, 'removed_from_room');
  const second = await f.admit('198.51.100.12');
  f.advance(24 * 3_600_000 + 1);
  assert.equal((await f.invoke(second.credential, 'city_room_read')).statusCode, 401);
});
test('capacity rejection rolls back identity, membership, invitation use and pickup', async (t) => {
  const f = await fixture(t),
    start = await f.bootstrap();
  assert.equal(start.statusCode, 200, start.body);
  await f.app.city.db.query(
    "INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES('global',2147483647,2147483647) ON CONFLICT(scope_key) DO UPDATE SET agents=2147483647,buckets=2147483647",
  );
  const before = (await f.app.city.db.query('SELECT id FROM operators')).rows.length;
  const denied = await f.redeem(start.json().handle);
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal((await f.app.city.db.query('SELECT id FROM operators')).rows.length, before);
  // Only the host's members: its agent and itself as a person (in its room from creation).
  assert.equal((await f.app.city.db.query('SELECT * FROM room_members')).rows.length, 2);
  assert.equal(
    (await f.app.city.db.query<{ uses: number }>('SELECT uses FROM join_links')).rows[0]!.uses,
    0,
  );
  assert.equal(
    (
      await f.app.city.db.query<{ used_at: number | null }>(
        'SELECT used_at FROM room_invite_bootstrap',
      )
    ).rows[0]!.used_at,
    null,
  );
});

test('revoked room credentials cannot read or post', async (t) => {
  const f = await fixture(t),
    guest = await f.admit();
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$1', [Date.now()]);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 401);
  assert.equal(
    (
      await f.invoke(guest.credential, 'city_room_post', {
        text: 'Denied',
        idempotency_key: randomUUID(),
      })
    ).statusCode,
    401,
  );
});

test('credential expiry refuses access without deleting the invited agent or its history', async (t) => {
  const { sweepUnclaimedAgents } = await import('../server/autonomy/expiry.js');
  const f = await fixture(t),
    guest = await f.admit();
  assert.equal(
    (
      await f.invoke(guest.credential, 'city_room_post', {
        text: 'Retained history',
        idempotency_key: randomUUID(),
      })
    ).statusCode,
    200,
  );
  const before = (
    await f.app.city.db.query("SELECT agents FROM unclaimed_stats WHERE scope_key='global'")
  ).rows;
  f.advance(72 * 3_600_000 + 1);
  assert.deepEqual(await sweepUnclaimedAgents(f.app.city.db, Date.parse(guest.expires_at) + 1), {
    examined: 0,
    removed: 0,
  });
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 401);
  const retained = await f.app.city.db.query(
    "SELECT a->>'id' AS id FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a WHERE a->>'id'=$1",
    [guest.agent_id],
  );
  assert.equal(retained.rows.length, 1);
  assert.deepEqual(
    (await f.app.city.db.query("SELECT agents FROM unclaimed_stats WHERE scope_key='global'")).rows,
    before,
  );
  assert.equal(
    (
      await f.app.city.db.query('SELECT * FROM room_messages WHERE sender_agent_id=$1', [
        guest.agent_id,
      ])
    ).rows.length,
    1,
  );
});

test('disabled invitation flow and GET bootstrap do not mutate pickup state', async (t) => {
  const f = await fixture(t);
  const before = (await f.app.city.db.query('SELECT * FROM room_invite_bootstrap')).rows;
  const get = await f.app.inject({
    method: 'GET',
    url: `/api/public/invites/bootstrap?code=${f.code}`,
  });
  assert.equal(get.statusCode, 404, get.body);
  const prior = process.env.CITY_INVITE_FLOW;
  try {
    process.env.CITY_INVITE_FLOW = '0';
    assert.equal((await f.bootstrap()).statusCode, 404);
  } finally {
    process.env.CITY_INVITE_FLOW = prior;
  }
  assert.deepEqual((await f.app.city.db.query('SELECT * FROM room_invite_bootstrap')).rows, before);
});

test('anonymous invitation admission is bounded to 24h even for legacy seven-day links', async (t) => {
  const f = await fixture(t);
  const created = await f.post(
    '/api/links',
    { target: 'room', room_id: f.roomId, ttl_hours: 168 },
    f.host,
  );
  assert.equal(created.statusCode, 201, created.body);
  const span = Date.parse(created.json().expires_at) - Date.now();
  assert.ok(span <= 86_400_000);
  await f.app.city.db.query('UPDATE join_links SET expires_at=created_at+604800000');
  f.advance(86_400_001);
  const pickup = await f.bootstrap();
  assert.equal(pickup.statusCode, 404, pickup.body);
});

test('a single-use code has bounded pickups without blocking another code', async (t) => {
  const f = await fixture(t);
  await f.app.city.db.query('UPDATE join_links SET max_uses=1');
  for (let i = 0; i < 3; i++) assert.equal((await f.bootstrap()).statusCode, 200);
  assert.equal((await f.bootstrap()).statusCode, 429);
  const other = await f.post('/api/links', { target: 'room', room_id: f.roomId }, f.host);
  const code = new URL(other.json().url).pathname.split('/').at(-1);
  assert.equal((await f.post('/api/public/invites/bootstrap', { code })).statusCode, 200);
});

test('invited identities share sponsoring host activity budget and refuse control characters', async (t) => {
  const f = await fixture(t);
  const pickup = await f.bootstrap();
  const bad = await f.post('/api/public/invites/redeem', {
    code: f.code,
    handle: pickup.json().handle,
    name: 'bad\u0000name',
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const a = await f.admit(),
    b = await f.admit();
  for (let i = 0; i < 120; i++) {
    const response = await f.invoke(i % 2 ? a.credential : b.credential, 'city_room_members');
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal((await f.invoke(b.credential, 'city_room_read')).statusCode, 429);
});

test('source and host invitation quotas count only live credentials; identities are retained', async (t) => {
  const previous = process.env.CITY_LIMIT_INVITED_GUESTS_PER_SOURCE;
  process.env.CITY_LIMIT_INVITED_GUESTS_PER_SOURCE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.CITY_LIMIT_INVITED_GUESTS_PER_SOURCE;
    else process.env.CITY_LIMIT_INVITED_GUESTS_PER_SOURCE = previous;
  });
  const f = await fixture(t),
    guest = await f.admit();
  // While the first credential is live, the source's single slot is taken.
  const blocked = await f.redeem((await f.bootstrap()).json().handle);
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.equal(blocked.json().code, 'invite_source_capacity');
  // An expired (or revoked) credential frees the invitation slot...
  await f.app.city.db.query('UPDATE room_invite_credentials SET expires_at=0 WHERE agent_id=$1', [
    guest.agent_id,
  ]);
  const second = await f.redeem((await f.bootstrap()).json().handle);
  assert.equal(second.statusCode, 200, second.body);
  // ...but never deletes the retained identity, which still counts toward anonymous capacity.
  assert.equal(
    (
      await f.app.city.db.query('SELECT * FROM unclaimed_agent_expiry WHERE agent_id=$1', [
        guest.agent_id,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await f.app.city.db.query<{ agents: number }>(
        "SELECT agents FROM unclaimed_stats WHERE scope_key='global'",
      )
    ).rows[0]!.agents,
    2,
  );
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=1 WHERE agent_id=$1', [
    second.json().agent_id,
  ]);
  const third = await f.redeem((await f.bootstrap()).json().handle);
  assert.equal(third.statusCode, 200, third.body);
});

test('invitation admission honors effective application capacity overrides', async (t) => {
  const f = await fixture(t, { unclaimedAgentsGlobal: 1 });
  await f.admit();
  const pickup = await f.bootstrap();
  assert.equal(pickup.statusCode, 200, pickup.body);
  const second = await f.redeem(pickup.json().handle);
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().code, 'unclaimed_capacity');
  assert.equal(
    (await f.app.city.db.query("SELECT * FROM operators WHERE kind='unclaimed'")).rows.length,
    1,
  );
});

test('normal MCP accepts room credentials with exactly five room tools and no workspace authority', async (t) => {
  const { mcpCall, rpcResult } = await import('./oauth-helpers.js');
  const f = await fixture(t),
    guest = await f.admit();
  const listed = await mcpCall(f.app, guest.credential, 'tools/list');
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(
    rpcResult(listed.body)
      .result.tools.map((v: { name: string }) => v.name)
      .sort(),
    [
      'city_room_leave',
      'city_room_members',
      'city_room_post',
      'city_room_read',
      'city_room_search',
    ],
  );
  assert.equal(
    rpcResult(listed.body).result.tools.find((v: { name: string }) => v.name === 'city_room_read')
      .inputSchema.properties.wait,
    undefined,
  );
  const posted = await mcpCall(f.app, guest.credential, 'tools/call', {
    name: 'city_room_post',
    arguments: { room_id: f.roomId, text: 'MCP guest', idempotency_key: randomUUID() },
  });
  assert.equal(posted.statusCode, 200, posted.body);
  assert.notEqual(rpcResult(posted.body).result?.isError, true, posted.body);
  // Room-only credentials on /mcp get the same explicit post confirmation.
  const confirmed = rpcResult(posted.body).result;
  assert.equal(confirmed.structuredContent.posted, true);
  assert.ok(
    confirmed.content.some(
      (c: { text: string }) =>
        c.text ===
        `Posted in room ${f.roomId} as message #${confirmed.structuredContent.message.seq}.`,
    ),
    posted.body,
  );
  const denied = rpcResult(
    (
      await mcpCall(f.app, guest.credential, 'tools/call', {
        name: 'city_workspace',
        arguments: {},
      })
    ).body,
  );
  assert.ok(denied.error || denied.result?.isError);
  const foreign = rpcResult(
    (
      await mcpCall(f.app, guest.credential, 'tools/call', {
        name: 'city_room_read',
        arguments: { room_id: randomUUID() },
      })
    ).body,
  );
  assert.equal(foreign.result?.isError, true);
  await f.post(`/api/rooms/${f.roomId}/members/${guest.agent_id}/remove`, {}, f.host);
  const removed = rpcResult(
    (
      await mcpCall(f.app, guest.credential, 'tools/call', {
        name: 'city_room_read',
        arguments: { room_id: f.roomId },
      })
    ).body,
  );
  assert.equal(removed.result?.isError, true);
  f.advance(72 * 3_600_000 + 1);
  assert.equal((await mcpCall(f.app, guest.credential, 'tools/list')).statusCode, 401);
});
