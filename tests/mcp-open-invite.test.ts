import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import { rpcResult } from './oauth-helpers.js';
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-open-invite-test-root-secret';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  limits: Partial<CityLimits> = {},
) {
  let time = Date.now();
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
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
  const bootstrap = () => post('/api/public/invites/bootstrap', { code });
  const redeem = (handle: string, address = '203.0.113.12') =>
    post('/api/public/invites/redeem', { code, handle, name: 'Invited AI' }, {}, address);
  const admit = async () => {
    const start = await bootstrap();
    assert.equal(start.statusCode, 200, start.body);
    const joined = await redeem(start.json().handle);
    assert.equal(joined.statusCode, 200, joined.body);
    return joined.json();
  };
  const invoke = (credential: string, tool: string, args: unknown = {}) =>
    post(`/api/public/invites/tools/${tool}`, args, { authorization: `Bearer ${credential}` });
  return {
    app,
    now: () => time,
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

async function rpc(f: Awaited<ReturnType<typeof fixture>>, method: string, params: unknown = {}) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
    remoteAddress: '203.0.113.12',
  });
  assert.equal(response.statusCode, 200, response.body);
  return rpcResult(response.body);
}
async function call(f: Awaited<ReturnType<typeof fixture>>, name: string, args: unknown) {
  return (await rpc(f, 'tools/call', { name, arguments: args })).result;
}
async function join(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await call(f, 'city_join_invite', {
    invite_link: `https://centralcity.ai/j/${f.code}`,
    name: 'External test AI',
  });
  assert.ok(result && !result.isError, JSON.stringify(result));
  return result.structuredContent;
}

test('anonymous MCP discovers invitation tools with explicit credential disclosure', async (t) => {
  const f = await fixture(t);
  const { result } = await rpc(f, 'tools/list');
  for (const name of [
    'city_join_invite',
    'city_room_read',
    'city_room_post',
    'city_room_members',
  ]) {
    const tool = result.tools.find((x: any) => x.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations.readOnlyHint, name === 'city_room_members');
  }
  assert.ok(!result.tools.some((x: any) => x.name === 'city_workspace'));
});

test('anonymous MCP joins, posts idempotently and reads without a workspace credential', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  assert.equal(guest.room_id, f.roomId);
  assert.match(guest.room_credential, /^crc_/);
  assert.equal(Date.parse(guest.expires_at) - f.now(), 24 * 3_600_000);
  const args = {
    room_credential: guest.room_credential,
    text: 'External AI joined',
    idempotency_key: randomUUID(),
  };
  const first = await call(f, 'city_room_post', args);
  assert.ok(first && !first.isError, JSON.stringify(first));
  // The invited-room post gets the same explicit confirmation as city_room_post on /mcp.
  assert.equal(first.structuredContent.posted, true);
  const seq = first.structuredContent.message.seq;
  assert.ok(
    first.content.some(
      (c: { text: string }) => c.text === `Posted in room ${f.roomId} as message #${seq}.`,
    ),
    JSON.stringify(first.content),
  );
  const second = await call(f, 'city_room_post', args);
  assert.ok(second && !second.isError, JSON.stringify(second));
  assert.equal(second.structuredContent.posted, true);
  assert.equal(second.structuredContent.message.seq, seq);
  // Its own post is not unread for it (no wake on its own post); a lookup shows it exactly once.
  const unread = await call(f, 'city_room_read', { room_credential: guest.room_credential });
  assert.ok(unread && !unread.isError, JSON.stringify(unread));
  assert.equal(
    unread.structuredContent.messages.filter((m: any) => m.text === args.text).length,
    0,
  );
  const read = await call(f, 'city_room_read', {
    room_credential: guest.room_credential,
    since: 0,
  });
  assert.ok(read && !read.isError, JSON.stringify(read));
  assert.equal(read.structuredContent.messages.filter((m: any) => m.text === args.text).length, 1);
  const members = await call(f, 'city_room_members', { room_credential: guest.room_credential });
  assert.ok(members && !members.isError, JSON.stringify(members));
  for (const tool of ['city_room_read', 'city_room_members']) {
    const denied = await call(f, tool, {
      room_credential: guest.room_credential,
      room_id: randomUUID(),
    });
    assert.ok(denied?.isError, JSON.stringify(denied));
    assert.ok(!JSON.stringify(denied).includes(guest.room_credential));
  }
});

test('anonymous MCP rejects foreign or decorated invitation URLs without admitting agents', async (t) => {
  const f = await fixture(t);
  for (const invite_link of [
    `https://evil.example/j/${f.code}`,
    `https://centralcity.ai/j/${f.code}?x=1`,
    `https://user:pass@centralcity.ai/j/${f.code}`,
    `https://centralcity.ai/j/${f.code}#secret`,
  ]) {
    const denied = await call(f, 'city_join_invite', { invite_link, name: 'No admission' });
    assert.ok(denied?.isError, JSON.stringify(denied));
  }
  assert.equal((await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length, 0);
});

test('anonymous MCP enforces host removal, revoked credentials, and 24-hour expiry', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  // block_rejoin false: the next guest joins from the same test network (a default removal
  // would block that network from the room; see room-management tests).
  await f.post(
    `/api/rooms/${f.roomId}/members/${guest.agent_id}/remove`,
    { block_rejoin: false },
    f.host,
  );
  assert.ok((await call(f, 'city_room_read', { room_credential: guest.room_credential })).isError);
  const second = await join(f);
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$1', [f.now()]);
  assert.ok(
    (
      await call(f, 'city_room_post', {
        room_credential: second.room_credential,
        text: 'Denied',
        idempotency_key: randomUUID(),
      })
    ).isError,
  );
  const third = await join(f);
  f.advance(24 * 3_600_000 + 1);
  assert.ok((await call(f, 'city_room_read', { room_credential: third.room_credential })).isError);
});

test('disabled invitation flag removes anonymous tools and refuses direct calls', async (t) => {
  const f = await fixture(t);
  const guest = await join(f);
  process.env.CITY_INVITE_FLOW = '0';
  try {
    const { result } = await rpc(f, 'tools/list');
    assert.ok(
      !result.tools.some((x: any) => x.name === 'city_join_invite' || x.name === 'city_room_read'),
    );
    const denied = await rpc(f, 'tools/call', {
      name: 'city_join_invite',
      arguments: { invite_link: `https://centralcity.ai/j/${f.code}`, name: 'Disabled' },
    });
    assert.ok(denied.error || denied.result?.isError);
    const roomDenied = await rpc(f, 'tools/call', {
      name: 'city_room_read',
      arguments: { room_credential: guest.room_credential },
    });
    assert.ok(roomDenied.error || roomDenied.result?.isError);
  } finally {
    process.env.CITY_INVITE_FLOW = '1';
  }
});

test('revoked invitation cannot admit a guest through anonymous MCP', async (t) => {
  const f = await fixture(t);
  await f.app.city.db.query('UPDATE join_links SET revoked_at=$1', [f.now()]);
  const denied = await call(f, 'city_join_invite', {
    invite_link: `https://centralcity.ai/j/${f.code}`,
    name: 'Denied',
  });
  assert.ok(denied?.isError);
  assert.equal((await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length, 0);
});

test('anonymous MCP rejects sender override and unknown credentials without leakage', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const injected = await call(f, 'city_room_post', {
    room_credential: guest.room_credential,
    agent_id: randomUUID(),
    text: 'Denied',
    idempotency_key: randomUUID(),
  });
  assert.ok(injected?.isError);
  assert.ok(!JSON.stringify(injected).includes(guest.room_credential));
  const unknown = 'crc_' + 'A'.repeat(43);
  const denied = await call(f, 'city_room_read', { room_credential: unknown });
  assert.ok(denied?.isError);
  assert.ok(!JSON.stringify(denied).includes(unknown));
});

test('direct HTTP redemption issues the same 24-hour credential as /mcp/open', async (t) => {
  const f = await fixture(t),
    guest = await f.admit();
  assert.equal(Date.parse(guest.expires_at) - f.now(), 24 * 3_600_000);
});

const errorCode = (result: any) => JSON.parse(result.content[0].text).error.code as string;
const joinWith = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown>) =>
  call(f, 'city_join_invite', {
    invite_link: `https://centralcity.ai/j/${f.code}`,
    name: 'External test AI',
    ...extra,
  });
const count = async (f: Awaited<ReturnType<typeof fixture>>, sql: string) =>
  Number((await f.app.city.db.query<{ n: string }>(sql)).rows[0]!.n);

test('room posts refuse credentials in text and data parts on every path (P2a)', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const secret = guest.room_credential as string;
  const own = secret.slice(4);
  const samples = [
    `my credential is ${secret}`,
    `x${secret}`, // no word boundary needed
    secret.toUpperCase(), // any letter case
    `ccw_${'b'.repeat(43)}`,
    `cca_${'c'.repeat(43)}`,
    `ccr_${'d'.repeat(43)}`,
    `crr_${'e'.repeat(43)}`,
    `cir_${'f'.repeat(43)}`,
    `cci_${'g'.repeat(43)}`,
    `ccclaim_${'h'.repeat(43)}`,
    `ccwclaim_${'i'.repeat(43)}`,
    `whsec_${'j'.repeat(43)}=`,
    own, // this guest's own secret without its prefix
    [...own].reverse().join(''), // and reversed
  ];
  const variants = (value: string) => [
    { text: value },
    { parts: [{ type: 'text', text: value }] },
    { parts: [{ type: 'data', data: { nested: [{ note: value }] } }] },
    { parts: [{ type: 'data', data: { [value]: 1 } }] },
  ];
  for (const value of samples)
    for (const body of variants(value)) {
      const refused = await call(f, 'city_room_post', {
        room_credential: secret,
        idempotency_key: randomUUID(),
        ...body,
      });
      assert.ok(refused?.isError, JSON.stringify(body).slice(0, 80));
      assert.equal(errorCode(refused), 'credential_in_message');
      assert.ok(!JSON.stringify(refused).includes(secret));
      assert.ok(!JSON.stringify(refused).includes(own));
    }
  // Nothing reached the room.
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_messages'), 0);
  // Mentioning a prefix in prose is fine.
  const prose = await call(f, 'city_room_post', {
    room_credential: secret,
    idempotency_key: randomUUID(),
    text: 'Never paste crc_ or ccw_ credentials here.',
  });
  assert.ok(prose && !prose.isError, JSON.stringify(prose));
  // The owner's own REST path is filtered too.
  const owner = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    { text: `key ccw_${'k'.repeat(43)}`, idempotency_key: randomUUID() },
    f.host,
  );
  assert.equal(owner.statusCode, 400, owner.body);
  assert.equal(owner.json().code, 'credential_in_message');
});

test('city_join_invite with idempotency_key replays the same guest and credential (P2b)', async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const first = await joinWith(f, { idempotency_key: key });
  assert.ok(first && !first.isError, JSON.stringify(first));
  assert.equal(first.structuredContent.replayed, false);
  const pickups = await count(f, 'SELECT count(*) AS n FROM room_invite_bootstrap');
  const retry = await joinWith(f, { idempotency_key: key });
  assert.ok(retry && !retry.isError, JSON.stringify(retry));
  assert.equal(retry.structuredContent.replayed, true);
  for (const field of ['room_credential', 'agent_id', 'room_id', 'expires_at'])
    assert.equal(retry.structuredContent[field], first.structuredContent[field], field);
  // No new identity, credential, membership or pickup.
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_credentials'), 1);
  assert.equal(await count(f, "SELECT count(*) AS n FROM operators WHERE kind='unclaimed'"), 1);
  assert.equal(
    await count(f, "SELECT count(*) AS n FROM room_members WHERE role='member' AND kind='agent'"),
    1,
  );
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_bootstrap'), pickups);
  // The replayed credential works.
  const read = await call(f, 'city_room_read', {
    room_credential: retry.structuredContent.room_credential,
  });
  assert.ok(read && !read.isError, JSON.stringify(read));
  // Same key, different name: a conflict, never a second identity.
  const renamed = await joinWith(f, { idempotency_key: key, name: 'Someone else' });
  assert.equal(errorCode(renamed), 'idempotency_conflict');
  // A different key is a different join.
  const other = await joinWith(f, { idempotency_key: randomUUID() });
  assert.ok(other && !other.isError);
  assert.notEqual(other.structuredContent.agent_id, first.structuredContent.agent_id);
  // After the replay window the credential is never shown again.
  f.advance(15 * 60_000 + 1);
  const late = await joinWith(f, { idempotency_key: key });
  assert.equal(errorCode(late), 'join_already_completed');
  assert.ok(!JSON.stringify(late).includes(first.structuredContent.room_credential));
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_credentials'), 2);
});

test('city_join_invite refuses low-entropy idempotency keys and replays concurrent retries', async (t) => {
  const f = await fixture(t);
  for (const idempotency_key of ['join-attempt-1', '00000000-0000-4000-8000-000000000000']) {
    const refused = await joinWith(f, { idempotency_key });
    assert.equal(errorCode(refused), 'invalid_request');
  }
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_credentials'), 0);
  const key = randomUUID();
  const results = await Promise.all([1, 2, 3].map(() => joinWith(f, { idempotency_key: key })));
  results.forEach((r) => assert.ok(r && !r.isError, JSON.stringify(r)));
  assert.equal(new Set(results.map((r) => r.structuredContent.room_credential)).size, 1);
  assert.equal(results.filter((r) => r.structuredContent.replayed === false).length, 1);
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_credentials'), 1);
});

test('city_join_invite accepts link as an alias of invite_link', async (t) => {
  const f = await fixture(t);
  const url = `https://centralcity.ai/j/${f.code}`;
  const name = 'Alias test AI';
  // The alias joins like the canonical key.
  const key = randomUUID();
  const first = await call(f, 'city_join_invite', { link: url, name, idempotency_key: key });
  assert.ok(first && !first.isError, JSON.stringify(first));
  assert.match(first.structuredContent.room_credential, /^crc_/);
  assert.equal(first.structuredContent.replayed, false);
  // The join is keyed by the code, not by the argument name: a retry may switch spellings.
  const retry = await call(f, 'city_join_invite', { invite_link: url, name, idempotency_key: key });
  assert.ok(retry && !retry.isError, JSON.stringify(retry));
  assert.equal(retry.structuredContent.replayed, true);
  for (const field of ['room_credential', 'agent_id'])
    assert.equal(retry.structuredContent[field], first.structuredContent[field], field);
  // Both keys with the same value are accepted.
  const same = await call(f, 'city_join_invite', {
    invite_link: url,
    link: url,
    name,
    idempotency_key: key,
  });
  assert.ok(same && !same.isError, JSON.stringify(same));
  assert.equal(same.structuredContent.agent_id, first.structuredContent.agent_id);
  const guests = await count(f, "SELECT count(*) AS n FROM operators WHERE kind='unclaimed'");
  // Neither key, or two different values, is invalid_arguments and admits nobody.
  for (const args of [
    { name },
    { invite_link: url, link: 'https://centralcity.ai/j/other', name },
  ]) {
    const refused = await call(f, 'city_join_invite', args);
    assert.ok(refused?.isError, JSON.stringify(refused));
    assert.equal(errorCode(refused), 'invalid_arguments', JSON.stringify(refused));
  }
  assert.equal(
    await count(f, "SELECT count(*) AS n FROM operators WHERE kind='unclaimed'"),
    guests,
  );
  // tools/list advertises both names.
  const { result } = await rpc(f, 'tools/list');
  const schema = result.tools.find((x: any) => x.name === 'city_join_invite').inputSchema;
  assert.ok(schema.properties.invite_link, 'invite_link kept');
  assert.ok(schema.properties.link, 'link alias advertised');
  assert.ok(!schema.required.includes('invite_link'), 'invite_link no longer required alone');
});

test('host invitation quota counts only live credentials (P2b)', async (t) => {
  const f = await fixture(t, { inviteGuestsPerHost: 100 }),
    guest = await join(f);
  const { host_owner_id: host, room_id: room } = (
    await f.app.city.db.query<{ host_owner_id: string; room_id: string }>(
      'SELECT host_owner_id, room_id FROM room_invite_credentials WHERE agent_id=$1',
      [guest.agent_id],
    )
  ).rows[0]!;
  // Fill the host's lifetime quota of 100 with synthetic live credentials (99 plus the guest).
  await f.app.city.db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
     SELECT 'quota-op-'||g, 'Room guest', 'quota-op-'||g, '!', '!', 'unclaimed' FROM generate_series(1,99) g`,
  );
  await f.app.city.db.query(
    `INSERT INTO unclaimed_agent_expiry SELECT 'quota-agent-'||g, 'quota-op-'||g, $1 FROM generate_series(1,99) g`,
    [f.now() + 86_400_000],
  );
  await f.app.city.db.query(
    `INSERT INTO room_invite_credentials(token_hash,operator_id,agent_id,room_id,host_owner_id,created_at,expires_at,source_hash)
     SELECT 'quota-token-'||g, 'quota-op-'||g, 'quota-agent-'||g, $1, $2, $3, $4, 'quota-source-'||g FROM generate_series(1,99) g`,
    [room, host, f.now(), f.now() + 86_400_000],
  );
  const full = await joinWith(f, {});
  assert.equal(errorCode(full), 'invite_host_capacity');
  // Expired and revoked credentials no longer hold host slots.
  await f.app.city.db.query(
    "UPDATE room_invite_credentials SET expires_at=0 WHERE token_hash LIKE 'quota-token-%' AND agent_id<'quota-agent-5'",
  );
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$1 WHERE agent_id=$2', [
    f.now(),
    guest.agent_id,
  ]);
  const admitted = await joinWith(f, {});
  assert.ok(admitted && !admitted.isError, JSON.stringify(admitted));
});

test('anonymous MCP instructions tell an AI to join a pasted invite link, only with the flag on', async (t) => {
  const f = await fixture(t);
  const initialize = () =>
    rpc(f, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'instructions-test', version: '1' },
    });
  const on = (await initialize()).result.instructions as string;
  assert.match(on, /https:\/\/centralcity\.ai\/j\//);
  assert.match(on, /city_join_invite joins with a Central City invite link/);
  assert.match(on, /the user gives and intends to use/);
  assert.match(on, /The room_credential is secret/);
  assert.match(on, /city_room_read, city_room_post and city_room_members/);
  assert.match(
    on,
    /Chat apps \(ChatGPT, Claude, …\) join a room through the connector at https:\/\/centralcity\.ai\/mcp with the rooms:join scope \(plus agents:create when the app has no Central City agent yet\) and city_join_room/,
  );
  assert.match(on, /city_room_read and city_mentions accept wait \(up to 25 s\) to long-poll/);
  assert.match(on, /Stateless HTTP agents and scripts/);
  assert.match(on, /a post is confirmed by the returned seq/);
  assert.ok(on.indexOf('Chat apps') < on.indexOf('city_join_invite'), 'chat apps lead');
  assert.match(on, /not meant to be repeated to the user, shared or posted/);
  assert.match(on, /reused for every city_room_\* call in the conversation/);
  assert.match(on, /shown once and cannot be recovered/);
  assert.match(on, /rejoin link for the member from the room host/);
  process.env.CITY_INVITE_FLOW = '0';
  try {
    const off = (await initialize()).result.instructions as string;
    assert.doesNotMatch(off, /city_join_invite/);
    assert.match(off, /connector at https:\/\/centralcity\.ai\/mcp/);
  } finally {
    process.env.CITY_INVITE_FLOW = '1';
  }
});

test('the join result carries a one-line KEEP THIS block with the expiry and never the secret', async (t) => {
  const f = await fixture(t);
  const { result } = await rpc(f, 'tools/list');
  const description = result.tools.find((x: any) => x.name === 'city_join_invite').description;
  assert.match(description, /Store the returned room_credential privately/);
  assert.match(description, /reuse it for every city_room_\* call in this conversation/);
  const guest = await join(f);
  const keep = guest.keep_this as string;
  assert.ok(!keep.includes('\n'), 'one line');
  assert.match(keep, /^KEEP THIS: save room_credential privately now/);
  assert.match(keep, /do not repeat it to the user/);
  assert.match(keep, /every city_room_\* call/);
  assert.match(keep, /cannot be recovered/);
  assert.ok(keep.includes(guest.expires_at), 'absolute expiry');
  assert.match(keep, /24 hours/);
  assert.ok(!keep.includes(guest.room_credential), 'never the secret');
  assert.ok(!keep.includes(guest.room_credential.slice(4)));
  assert.ok(!guest.warning.includes(guest.room_credential));
  assert.match(guest.stay_responsive, /city_join_room/);
  assert.doesNotMatch(guest.stay_responsive, /wait=25/);
  assert.match(guest.stay_responsive, /Do not poll in a loop/);
});

test('the /j JSON leads with the authenticated connector and adds stateless guidance', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'GET',
    url: `/j/${f.code}?format=json`,
    headers: { host: 'centralcity.ai', 'x-forwarded-proto': 'https' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const doc = response.json();
  assert.match(doc.chat_apps, /^Chat apps .*connect https:\/\/centralcity\.ai\/mcp once/);
  assert.match(
    doc.stateless_agents,
    /^Stateless HTTP agents and scripts: call city_join_invite on https:\/\/centralcity\.ai\/mcp\/open/,
  );
  assert.match(doc.stateless_agents, /check the returned seq, all in the same turn/);
  const keys = Object.keys(doc);
  assert.ok(keys.indexOf('chat_apps') < keys.indexOf('stateless_agents'));
});

const rejoinLink = (f: Awaited<ReturnType<typeof fixture>>, agentId: string, extra = f.host) =>
  f.post(`/api/rooms/${f.roomId}/members/${agentId}/rejoin-link`, {}, extra);

test('a host rejoin link gives the same member a fresh credential and kills the old one', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  assert.equal(guest.member_handle, `External test AI #${guest.agent_id.slice(0, 8)}`);
  assert.match(guest.keep_this, /rejoin link for member External test AI #/);
  const issued = await rejoinLink(f, guest.agent_id);
  assert.equal(issued.statusCode, 200, issued.body);
  const { link, expires_at, agent_id, single_use } = issued.json();
  assert.equal(agent_id, guest.agent_id);
  assert.equal(single_use, true);
  assert.equal(Date.parse(expires_at) - f.now(), 30 * 60_000);
  assert.match(
    link,
    /^https:\/\/centralcity\.ai\/j\/rejoin\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{43}$/,
  );
  assert.ok(!link.includes(guest.room_credential.slice(4)));
  // Redeemed with the normal join tool; the name is ignored.
  const back = await call(f, 'city_join_invite', { invite_link: link, name: 'Any name' });
  assert.ok(back && !back.isError, JSON.stringify(back));
  const fresh = back.structuredContent;
  assert.equal(fresh.agent_id, guest.agent_id);
  assert.equal(fresh.room_id, guest.room_id);
  assert.equal(fresh.rejoined, true);
  assert.equal(fresh.member_handle, guest.member_handle);
  assert.notEqual(fresh.room_credential, guest.room_credential);
  assert.ok(!fresh.keep_this.includes(fresh.room_credential));
  // Same member, no duplicate identity, credential row or slot.
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_credentials'), 1);
  assert.equal(await count(f, "SELECT count(*) AS n FROM operators WHERE kind='unclaimed'"), 1);
  assert.equal(
    await count(f, "SELECT count(*) AS n FROM room_members WHERE role='member' AND kind='agent'"),
    1,
  );
  // The old credential is dead, the new one works.
  const old = await call(f, 'city_room_read', { room_credential: guest.room_credential });
  assert.equal(errorCode(old), 'room_credential_denied');
  const posted = await call(f, 'city_room_post', {
    room_credential: fresh.room_credential,
    text: 'Back again',
    idempotency_key: randomUUID(),
  });
  assert.ok(posted && !posted.isError, JSON.stringify(posted));
  // Single use: the same link never works again.
  const again = await call(f, 'city_join_invite', { invite_link: link, name: 'Any name' });
  assert.equal(errorCode(again), 'invite_invalid');
});

test('rejoin links are single-use under a race, expire, and refuse tampering', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const { link } = (await rejoinLink(f, guest.agent_id)).json();
  const code = link.split('/j/')[1];
  const results = await Promise.all([
    f.post('/api/public/invites/rejoin', { code }),
    f.post('/api/public/invites/rejoin', { code }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 404]);
  // The direct HTTP path issues the same 24-hour credential as every guest path.
  const won = results.find((r) => r.statusCode === 200)!.json();
  assert.equal(Date.parse(won.expires_at) - f.now(), 24 * 3_600_000);
  assert.equal(won.agent_id, guest.agent_id);
  const second = (await rejoinLink(f, guest.agent_id)).json().link.split('/j/')[1];
  const tampered = second.slice(0, -1) + (second.endsWith('A') ? 'B' : 'A');
  assert.equal((await f.post('/api/public/invites/rejoin', { code: tampered })).statusCode, 404);
  f.advance(30 * 60_000 + 1);
  const late = await f.post('/api/public/invites/rejoin', { code: second });
  assert.equal(late.statusCode, 404);
  assert.equal(late.json().code, 'invite_invalid');
});

test('only the host gets a rejoin link, only for a live invited guest (uniform 404)', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const other = await f.post('/api/auth/register', {
    name: 'Someone else',
    password: 'Another synthetic password',
  });
  const stranger = {
    cookie: `cc_session=${other.cookies.find((c) => c.name === 'cc_session')!.value}`,
  };
  const hostAgent = (
    await f.app.city.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM room_members WHERE role='host'",
    )
  ).rows[0]!.agent_id;
  const refused = [
    await rejoinLink(f, guest.agent_id, stranger), // not the host
    await rejoinLink(f, randomUUID()), // unknown agent
    await rejoinLink(f, hostAgent), // a host member, not an invited guest
    await rejoinLink(f, 'not-a-uuid'),
    await f.post(`/api/rooms/${randomUUID()}/members/${guest.agent_id}/rejoin-link`, {}, f.host),
  ];
  for (const r of refused) {
    assert.equal(r.statusCode, 404, r.body);
    assert.deepEqual(r.json(), refused[0]!.json());
  }
  // A member the host removed cannot be re-linked.
  await f.post(`/api/rooms/${f.roomId}/members/${guest.agent_id}/remove`, {}, f.host);
  assert.equal((await rejoinLink(f, guest.agent_id)).statusCode, 404);
});

test('an expired guest can rejoin, and room tool errors explain how to recover', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const missing = await call(f, 'city_room_read', {});
  assert.equal(errorCode(missing), 'room_credential_required');
  assert.match(JSON.stringify(missing), /ask the room host for a rejoin link/);
  const unknown = 'crc_' + 'Q'.repeat(43);
  const denied = await call(f, 'city_room_post', {
    room_credential: unknown,
    text: 'x',
    idempotency_key: randomUUID(),
  });
  assert.equal(errorCode(denied), 'room_credential_denied');
  assert.match(
    JSON.stringify(denied),
    /to keep the same member, ask the room host for a rejoin link/,
  );
  assert.match(JSON.stringify(denied), /original invite link creates a NEW member/);
  assert.ok(!JSON.stringify(denied).includes(unknown));
  // Expire the credential (the host's console session stays valid).
  await f.app.city.db.query('UPDATE room_invite_credentials SET expires_at=$1 WHERE agent_id=$2', [
    f.now() - 1,
    guest.agent_id,
  ]);
  assert.equal(
    errorCode(await call(f, 'city_room_read', { room_credential: guest.room_credential })),
    'room_credential_denied',
  );
  const { link } = (await rejoinLink(f, guest.agent_id)).json();
  const back = await call(f, 'city_join_invite', { invite_link: link, name: 'x' });
  assert.ok(back && !back.isError, JSON.stringify(back));
  const read = await call(f, 'city_room_read', {
    room_credential: back.structuredContent.room_credential,
  });
  assert.ok(read && !read.isError, JSON.stringify(read));
});

test('a revoked guest credential is never revived by a rejoin link (uniform 404)', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const { link } = (await rejoinLink(f, guest.agent_id)).json();
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$1 WHERE agent_id=$2', [
    f.now(),
    guest.agent_id,
  ]);
  // Redeeming a link made before the revocation: the same 404 as any unusable link.
  const code = link.split('/j/')[1];
  const redeemed = await f.post('/api/public/invites/rejoin', { code });
  assert.equal(redeemed.statusCode, 404, redeemed.body);
  assert.equal(redeemed.json().code, 'invite_invalid');
  const viaMcp = await call(f, 'city_join_invite', { invite_link: link, name: 'x' });
  assert.equal(errorCode(viaMcp), 'invite_invalid');
  // No new link for a revoked member either, and the same body as for an unknown agent.
  const refused = await rejoinLink(f, guest.agent_id);
  assert.equal(refused.statusCode, 404);
  assert.deepEqual(refused.json(), (await rejoinLink(f, randomUUID())).json());
  // Still revoked; nothing was revived.
  const row = (
    await f.app.city.db.query<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM room_invite_credentials WHERE agent_id=$1',
      [guest.agent_id],
    )
  ).rows[0]!;
  assert.notEqual(row.revoked_at, null);
});

test('a browser or AI reading a rejoin link is told to use city_join_invite', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const issued = (await rejoinLink(f, guest.agent_id)).json();
  assert.match(issued.warning, /Confirm the full agent id/);
  assert.match(issued.warning, /privately/);
  const path = new URL(issued.link).pathname;
  const html = await f.app.inject({
    method: 'GET',
    url: path,
    headers: { host: 'centralcity.ai', accept: 'text/html', 'x-forwarded-proto': 'https' },
  });
  assert.equal(html.statusCode, 200, html.body);
  assert.match(
    html.body,
    /This is a rejoin link: pass it to your AI&#39;s city_join_invite tool|This is a rejoin link: pass it to your AI's city_join_invite tool/,
  );
  assert.doesNotMatch(html.body, /invalid or has expired/);
  const json = await f.app.inject({
    method: 'GET',
    url: `${path}?format=json`,
    headers: { host: 'centralcity.ai', 'x-forwarded-proto': 'https' },
  });
  assert.equal(json.json().tool, 'city_join_invite');
  // Reading never uses the link up.
  const back = await call(f, 'city_join_invite', { invite_link: issued.link, name: 'x' });
  assert.ok(back && !back.isError, JSON.stringify(back));
});

test('city_room_renew extends the same member; the old credential fails immediately', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  assert.match(guest.keep_this, /renew it with city_room_renew before then/);
  assert.match(guest.standing_behaviour, /^Do not poll the room in a loop within one turn\./);
  assert.match(guest.standing_behaviour, /check with long gaps \(several minutes apart\)/);
  assert.match(guest.standing_behaviour, /stop after 3 checks in a row with nothing new/);
  assert.match(guest.standing_behaviour, /each check uses their AI usage/);
  assert.match(guest.standing_behaviour, /renew with city_room_renew before expires_at/);
  assert.doesNotMatch(guest.standing_behaviour, /once a minute|wait=25|keep checking/);
  f.advance(20 * 3_600_000);
  const renewed = await call(f, 'city_room_renew', { room_credential: guest.room_credential });
  assert.ok(renewed && !renewed.isError, JSON.stringify(renewed));
  const next = renewed.structuredContent;
  assert.equal(next.agent_id, guest.agent_id);
  assert.equal(next.room_id, guest.room_id);
  assert.equal(next.replayed, undefined);
  assert.notEqual(next.room_credential, guest.room_credential);
  assert.equal(Date.parse(next.expires_at) - f.now(), 24 * 3_600_000);
  assert.ok(!next.keep_this.includes(next.room_credential));
  assert.equal(await count(f, 'SELECT count(*) AS n FROM room_invite_credentials'), 1);
  // The old credential is dead at once, for reading and for another renew (no replay).
  assert.equal(
    errorCode(await call(f, 'city_room_read', { room_credential: guest.room_credential })),
    'room_credential_denied',
  );
  const retry = await call(f, 'city_room_renew', { room_credential: guest.room_credential });
  assert.equal(errorCode(retry), 'room_credential_denied');
  assert.match(JSON.stringify(retry), /a renew whose response was lost/);
  assert.match(JSON.stringify(retry), /rejoin link/);
  // The new one works and outlives the original 24 hours.
  f.advance(5 * 3_600_000);
  const later = await call(f, 'city_room_read', { room_credential: next.room_credential });
  assert.ok(later && !later.isError, JSON.stringify(later));
});

test('a REST renew kills the old credential for an MCP renew, even much later', async (t) => {
  const f = await fixture(t),
    guest = await join(f);
  const rest = await f.post(
    '/api/public/invites/renew',
    {},
    { authorization: `Bearer ${guest.room_credential}` },
  );
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(Date.parse(rest.json().expires_at) - f.now(), 24 * 3_600_000);
  for (const wait of [0, 6 * 60_000, 23 * 3_600_000]) {
    f.advance(wait);
    const old = await call(f, 'city_room_renew', { room_credential: guest.room_credential });
    assert.equal(errorCode(old), 'room_credential_denied', `after ${wait} ms`);
  }
  const fresh = await call(f, 'city_room_read', { room_credential: rest.json().credential });
  assert.ok(fresh && !fresh.isError, JSON.stringify(fresh));
});

test("a from_join guest's latest_messages exclude messages from before it joined", async (t) => {
  const f = await fixture(t);
  const set = await f.post(`/api/rooms/${f.roomId}/settings`, { history: 'from_join' }, f.host);
  assert.equal(set.statusCode, 200, set.body);
  const hostAgent = (
    await f.app.city.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM room_members WHERE role='host'",
    )
  ).rows[0]!.agent_id;
  const before = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    { agent_id: hostAgent, text: 'Before the guest joined', idempotency_key: randomUUID() },
    f.host,
  );
  assert.equal(before.statusCode, 201, before.body);
  const guest = await join(f);
  assert.equal(guest.history, 'from_join');
  const texts = JSON.stringify(guest.latest_messages);
  assert.ok(!texts.includes('Before the guest joined'), texts);
  const after = await f.post(
    `/api/rooms/${f.roomId}/messages`,
    { agent_id: hostAgent, text: 'After the guest joined', idempotency_key: randomUUID() },
    f.host,
  );
  assert.equal(after.statusCode, 201, after.body);
  const again = await call(f, 'city_room_read', { room_credential: guest.room_credential });
  const seen = JSON.stringify(again.structuredContent.messages);
  assert.ok(seen.includes('After the guest joined'));
  assert.ok(!seen.includes('Before the guest joined'));
});

test('city_room_renew: removed_from_room, room_closed, else refused (revoked, expired, unknown)', async (t) => {
  const f = await fixture(t);
  const removed = await join(f);
  // block_rejoin false: later guests join from the same test network.
  await f.post(
    `/api/rooms/${f.roomId}/members/${removed.agent_id}/remove`,
    { block_rejoin: false },
    f.host,
  );
  const revoked = await joinWith(f, { name: 'Revoked AI' });
  await f.app.city.db.query('UPDATE room_invite_credentials SET revoked_at=$1 WHERE agent_id=$2', [
    f.now(),
    revoked.structuredContent.agent_id,
  ]);
  const expired = await joinWith(f, { name: 'Expired AI' });
  await f.app.city.db.query('UPDATE room_invite_credentials SET expires_at=$1 WHERE agent_id=$2', [
    f.now() - 1,
    expired.structuredContent.agent_id,
  ]);
  // A removed member hears why.
  const removedRenew = await call(f, 'city_room_renew', {
    room_credential: removed.room_credential,
  });
  assert.equal(errorCode(removedRenew), 'removed_from_room');
  assert.ok(!JSON.stringify(removedRenew).includes(removed.room_credential));
  for (const credential of [
    revoked.structuredContent.room_credential,
    expired.structuredContent.room_credential,
    'crc_' + 'Z'.repeat(43),
  ]) {
    const refused = await call(f, 'city_room_renew', { room_credential: credential });
    assert.equal(errorCode(refused), 'room_credential_denied');
    assert.ok(!JSON.stringify(refused).includes(credential));
  }
  const open = await joinWith(f, { name: 'Closing AI' });
  await f.post(`/api/rooms/${f.roomId}/close`, {}, f.host);
  const closed = await call(f, 'city_room_renew', {
    room_credential: open.structuredContent.room_credential,
  });
  assert.equal(errorCode(closed), 'room_closed');
});

test('the REST renew twin issues a 24-hour credential for the same member', async (t) => {
  const f = await fixture(t),
    guest = await f.admit();
  const renewed = await f.post(
    '/api/public/invites/renew',
    {},
    { authorization: `Bearer ${guest.credential}` },
  );
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal(renewed.json().agent_id, guest.agent_id);
  assert.equal(Date.parse(renewed.json().expires_at) - f.now(), 24 * 3_600_000);
  assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 401);
  assert.equal((await f.invoke(renewed.json().credential, 'city_room_read')).statusCode, 200);
  assert.equal((await f.post('/api/public/invites/renew', {})).statusCode, 401);
});

test('join results carry the standing behaviour, /mcp/open instructions only describe; the invite page is readable', async (t) => {
  const f = await fixture(t);
  const instructions = (
    await rpc(f, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'standing', version: '1' },
    })
  ).result.instructions as string;
  // Descriptive only: the standing behaviour lives in the join result, not the instructions.
  assert.doesNotMatch(instructions, /set up a check|keep checking/);
  assert.match(instructions, /long-poll/);
  // A web reader asking for HTML gets the full AI instructions in the page, not a bare button.
  const page = await f.app.inject({
    method: 'GET',
    url: `/j/${f.code}`,
    headers: {
      host: 'centralcity.ai',
      'x-forwarded-proto': 'https',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'user-agent': 'SomeWebReader/1.0',
    },
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.match(page.body, /For AIs reading this page/);
  assert.match(page.body, /city_join_invite/);
  assert.match(page.body, /city_join_room/);
  assert.match(page.body, /\/api\/public\/invites\/bootstrap/);
});

test('latest_messages holds the NEWEST ten, oldest first, and says how many earlier ones exist', async (t) => {
  const f = await fixture(t);
  const hostAgent = (
    await f.app.city.db.query<{ agent_id: string }>(
      "SELECT agent_id FROM room_members WHERE role='host'",
    )
  ).rows[0]!.agent_id;
  for (let i = 1; i <= 25; i++) {
    const posted = await f.post(
      `/api/rooms/${f.roomId}/messages`,
      { agent_id: hostAgent, text: `Message ${i}`, idempotency_key: randomUUID() },
      f.host,
    );
    assert.equal(posted.statusCode, 201, posted.body);
  }
  const guest = await join(f);
  const latest = guest.latest_messages as {
    messages: Array<{ seq: number; text: string }>;
    latest_seq: number;
    next_since: number;
    earlier_messages: number;
  };
  assert.deepEqual(
    latest.messages.map((m) => m.seq),
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  );
  assert.equal(latest.messages.at(-1)!.text, 'Message 25');
  assert.equal(latest.latest_seq, 25);
  assert.equal(latest.next_since, 25);
  assert.equal(latest.earlier_messages, 15);
  assert.match(
    guest.next_step,
    /15 earlier messages are not included: page with city_room_read since 0/,
  );
  // Joining is a lookup: the whole visible history is still unread for the guest.
  const unread = await call(f, 'city_room_read', { room_credential: guest.room_credential });
  assert.equal(unread.structuredContent.messages[0].seq, 1);

  // A short room: nothing earlier, no hint.
  const g = await fixture(t);
  const small = await join(g);
  assert.equal(small.latest_messages.earlier_messages, 0);
  assert.doesNotMatch(small.next_step, /earlier message/);
});

test('a stress-test host is bounded by CITY_STRESS_TEST_MAX_GUESTS, not the public per-host quota', async (t) => {
  const f = await fixture(t, { inviteGuestsPerHost: 100 }),
    guest = await join(f);
  const { host_owner_id: host, room_id: room } = (
    await f.app.city.db.query<{ host_owner_id: string; room_id: string }>(
      'SELECT host_owner_id, room_id FROM room_invite_credentials WHERE agent_id=$1',
      [guest.agent_id],
    )
  ).rows[0]!;
  await f.app.city.db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
     SELECT 'stress-op-'||g, 'Room guest', 'stress-op-'||g, '!', '!', 'unclaimed' FROM generate_series(1,99) g`,
  );
  await f.app.city.db.query(
    `INSERT INTO unclaimed_agent_expiry SELECT 'stress-agent-'||g, 'stress-op-'||g, $1 FROM generate_series(1,99) g`,
    [f.now() + 86_400_000],
  );
  await f.app.city.db.query(
    `INSERT INTO room_invite_credentials(token_hash,operator_id,agent_id,room_id,host_owner_id,created_at,expires_at,source_hash)
     SELECT 'stress-token-'||g, 'stress-op-'||g, 'stress-agent-'||g, $1, $2, $3, $4, 'stress-source-'||g FROM generate_series(1,99) g`,
    [room, host, f.now(), f.now() + 86_400_000],
  );
  assert.equal(errorCode(await joinWith(f, {})), 'invite_host_capacity', 'public cap applies');
  const before = {
    ops: process.env.CITY_STRESS_TEST_OPERATORS,
    max: process.env.CITY_STRESS_TEST_MAX_GUESTS,
  };
  t.after(() => {
    if (before.ops === undefined) delete process.env.CITY_STRESS_TEST_OPERATORS;
    else process.env.CITY_STRESS_TEST_OPERATORS = before.ops;
    if (before.max === undefined) delete process.env.CITY_STRESS_TEST_MAX_GUESTS;
    else process.env.CITY_STRESS_TEST_MAX_GUESTS = before.max;
  });
  process.env.CITY_STRESS_TEST_OPERATORS = host;
  process.env.CITY_STRESS_TEST_MAX_GUESTS = '101';
  const admitted = await joinWith(f, {});
  assert.ok(admitted && !admitted.isError, JSON.stringify(admitted));
  assert.equal(
    errorCode(await joinWith(f, {})),
    'invite_host_capacity',
    'the stress ceiling still binds, with the neutral host answer',
  );
});
