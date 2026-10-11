import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { runMigrations, listMigrations } from '../server/migrations.js';
import { loadLimits } from '../server/limits.js';
import { SHORT_CODE_LIMITS } from '../server/links/short-code.js';
import { INVITE_PICKUPS_PER_SOURCE } from '../server/links/invites.js';
import { ROOM_LIMITS } from '../server/rooms/contract.js';
import { registerMessagingMigration } from '../server/messaging/schema.js';
import { registerAiWorkspacesMigration } from '../server/workspaces/schema.js';
import { registerCrossConnectionsMigration } from '../server/connections/schema.js';
import { registerRoomsMigration } from '../server/rooms/schema.js';
import { registerJoinLinksMigration } from '../server/links/schema.js';
import { registerWakeMigration } from '../server/wake/schema.js';
import { registerResultsMigration } from '../server/results/schema.js';
import { registerRoomFormatMigration } from '../server/rooms/format-schema.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-cap-test-root-secret-000';

/**
 * Room member caps. A room holds up to 100 members (default 100); only
 * approved stress-test operators (CITY_STRESS_TEST_OPERATORS) may set up to 10,000. Migration 32
 * raised 20 -> 100, 34 raised 100 -> 10,000, and 36 lowers open rooms above 100 back to
 * GREATEST(100, active members) without evicting anyone. The host changes the cap in the console,
 * and the anonymous admission budgets allow a room of 100 guests from one address. Synthetic data.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

test('limits: member cap defaults, pickups per source and the short-code budget', () => {
  assert.equal(ROOM_LIMITS.memberCapDefault, 100);
  assert.equal(ROOM_LIMITS.memberCapStandard, 100);
  assert.equal(ROOM_LIMITS.memberCapMax, 10_000);
  const caps = loadLimits({});
  assert.equal(caps.roomMembersMax, 10_000);
  assert.equal(caps.roomMembersDefault, 100);
  assert.equal(loadLimits({ CITY_LIMIT_ROOM_MEMBERS_MAX: '500' }).roomMembersMax, 500);
  assert.equal(loadLimits({ CITY_LIMIT_ROOM_MEMBERS_DEFAULT: '100' }).roomMembersDefault, 100);
  assert.throws(() => loadLimits({ CITY_LIMIT_ROOM_MEMBERS_MAX: 'many' }), /ROOM_MEMBERS_MAX/);
  assert.equal(caps.unclaimedCreatesPerSourcePerHour, 200);
  assert.equal(caps.unclaimedCreatesPerSitePerHour, 200);
  assert.equal(caps.unclaimedCreatesPerNetworkPerHour, 300);
  assert.equal(caps.unclaimedCreatesPerRegionPerHour, 500);
  // Environment overrides still win.
  assert.equal(
    loadLimits({ CITY_LIMIT_UNCLAIMED_CREATES_PER_SOURCE_PER_HOUR: '40' })
      .unclaimedCreatesPerSourcePerHour,
    40,
  );
  assert.equal(INVITE_PICKUPS_PER_SOURCE, 100);
  assert.equal(SHORT_CODE_LIMITS.attemptsPerAddressPerHour, 100);
});

test('migration 32 raises open rooms at 20 to 100, and nothing else', async (t) => {
  registerMessagingMigration();
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  registerRoomsMigration();
  registerJoinLinksMigration();
  registerWakeMigration();
  registerResultsMigration();
  registerRoomFormatMigration();
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  const before = listMigrations().filter((migration) => migration.version < 32);
  await runMigrations(db, before);
  await db.exec(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES ('op','Op','op','x','y');`,
  );
  const room = (id: string, cap: number, closed: number | null) =>
    db.query(
      `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,closed_at,idempotency_key,request_hash)
       VALUES ($1,$1,$1,'op','agent',$2,'full',1000,0,$3,$1,'h')`,
      [id, cap, closed],
    );
  await room('open-20', 20, null);
  await room('open-12', 12, null);
  await room('closed-20', 20, 5);
  const result = await runMigrations(db, listMigrations());
  assert.ok(result.applied.includes(32));
  const caps = Object.fromEntries(
    (
      await db.query<{ id: string; member_cap: number }>('SELECT id, member_cap FROM rooms')
    ).rows.map((row) => [row.id, row.member_cap]),
  );
  // Migration 34 then raised the open rooms at 100 to 10,000, and migration 36 lowered them back.
  assert.deepEqual(caps, { 'open-20': 100, 'open-12': 12, 'closed-20': 20 });
});

test('migration 34 raises open rooms at 100 to 10,000, and nothing else', async (t) => {
  registerMessagingMigration();
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  registerRoomsMigration();
  registerJoinLinksMigration();
  registerWakeMigration();
  registerResultsMigration();
  registerRoomFormatMigration();
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < 34),
  );
  await db.exec(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES ('op','Op','op','x','y');`,
  );
  const room = (id: string, cap: number, closed: number | null) =>
    db.query(
      `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,closed_at,idempotency_key,request_hash)
       VALUES ($1,$1,$1,'op','agent',$2,'full',1000,0,$3,$1,'h')`,
      [id, cap, closed],
    );
  await room('open-100', 100, null);
  await room('open-60', 60, null);
  await room('closed-100', 100, 5);
  // Migration 36 (below) lowers them again; this test pins 34 on its own.
  const result = await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < 36),
  );
  assert.ok(result.applied.includes(34));
  const caps = Object.fromEntries(
    (
      await db.query<{ id: string; member_cap: number }>('SELECT id, member_cap FROM rooms')
    ).rows.map((row) => [row.id, row.member_cap]),
  );
  assert.deepEqual(caps, { 'open-100': 10_000, 'open-60': 60, 'closed-100': 100 });
});

test('the host changes the member cap (never below the members), logged; others cannot', async (t) => {
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
  let address = 60;
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const account = async (name: string) => {
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic room cap password',
    });
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const host = await account('Cap host');
  const created = await post(
    '/api/rooms',
    { name: 'Big room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.json().room.member_cap, 100);
  const roomId = created.json().room.id as string;
  const member = await account('Member');
  const joined = await post(
    `/api/rooms/${roomId}/join`,
    { link: created.json().link.link, agent_id: member.agentId, idempotency_key: randomUUID() },
    { cookie: member.cookie },
  );
  assert.equal(joined.statusCode, 200, joined.body);
  const set = (cookie: string, cap: number) =>
    post(`/api/rooms/${roomId}/settings`, { member_cap: cap }, { cookie });
  const lowered = await set(host.cookie, 30);
  assert.equal(lowered.statusCode, 200, lowered.body);
  assert.equal(lowered.json().room.member_cap, 30);
  assert.equal((await set(host.cookie, 1)).statusCode, 400);
  assert.equal((await set(host.cookie, 10_001)).statusCode, 400);
  // Above 100 is for approved operators only.
  const tooLarge = await set(host.cookie, 101);
  assert.equal(tooLarge.statusCode, 400, tooLarge.body);
  assert.equal(tooLarge.json().code, 'member_cap_too_large');
  const raised = await set(host.cookie, 100);
  assert.equal(raised.statusCode, 200, raised.body);
  assert.equal(raised.json().room.member_cap, 100);
  // Three members: the host agent, the host as a person (in its room from creation) and the
  // member. Cap three is allowed, two is below them.
  const below = await set(host.cookie, 3);
  assert.equal(below.statusCode, 200, 'three members, cap three is allowed');
  const tooLow = await set(host.cookie, 2);
  assert.equal(tooLow.statusCode, 409, tooLow.body);
  assert.equal(tooLow.json().code, 'cap_below_members');
  const other = await set(member.cookie, 50);
  assert.equal(other.statusCode, 403, other.body);
  const snapshot = await app.inject({
    method: 'GET',
    url: '/api/snapshot',
    headers: { ...headers, cookie: host.cookie },
  });
  assert.ok(
    (snapshot.json().events as Array<{ message: string }>).some((e) =>
      e.message.includes('members allowed 100 -> 30'),
    ),
  );
  assert.ok(
    (snapshot.json().events as Array<{ message: string }>).some((e) =>
      e.message.includes('members allowed 30 -> 100'),
    ),
  );
  // The history setting keeps working on the same route.
  const history = await post(
    `/api/rooms/${roomId}/settings`,
    { history: 'from_join' },
    { cookie: host.cookie },
  );
  assert.equal(history.statusCode, 200, history.body);
});

test('a default join link admits as many joins as the room holds (an earlier test stopped at 24)', async (t) => {
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
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.90') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Fifty host',
    password: 'Synthetic room cap password',
  });
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const agent = await post(
    '/api/agents',
    { name: 'Fifty host agent', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  const room = await post(
    '/api/rooms',
    { name: 'Fifty', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    { cookie },
  );
  const roomId = room.json().room.id as string;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, { cookie });
  assert.equal(link.json().max_uses, 100, 'omitted max_uses follows the member cap');
  const explicit = await post(
    '/api/links',
    { target: 'room', room_id: roomId, max_uses: 7 },
    { cookie },
  );
  assert.equal(explicit.json().max_uses, 7, 'an explicit max_uses is kept');
  // A lower cap gives a lower default.
  await post(`/api/rooms/${roomId}/settings`, { member_cap: 30 }, { cookie });
  const lower = await post('/api/links', { target: 'room', room_id: roomId }, { cookie });
  assert.equal(lower.json().max_uses, 30);
  await post(`/api/rooms/${roomId}/settings`, { member_cap: 100 }, { cookie });

  // 50 AI guests through the one default link (the /mcp/open path, one source address).
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  for (let i = 0; i < 50; i++) {
    const start = await post('/api/public/invites/bootstrap', { code });
    assert.equal(start.statusCode, 200, `guest ${i + 1} bootstrap: ${start.body}`);
    const joined = await post('/api/public/invites/redeem', {
      code,
      handle: start.json().handle,
      name: `Guest ${i + 1}`,
    });
    assert.equal(joined.statusCode, 200, `guest ${i + 1} redeem: ${joined.body}`);
  }
  const members = await app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/members`,
    headers: { ...headers, cookie },
  });
  // The host agent, the host as a person (in its room from creation) and the 50 guests.
  assert.equal(members.json().members.length, 52);
});

test('a lowered CITY_LIMIT_ROOM_MEMBERS_MAX bounds joins to rooms created under a higher one', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
    // What CITY_LIMIT_ROOM_MEMBERS_MAX=3 loads (loadLimits: environment, then these overrides).
    limits: loadLimits({ CITY_LIMIT_ROOM_MEMBERS_MAX: '3' }),
  });
  t.after(() => app.close());
  let address = 120;
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const account = async (name: string) => {
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic room cap password',
    });
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const host = await account('Lowered host');
  const created = await post(
    '/api/rooms',
    { name: 'Old big room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const link = created.json().link.link as string;
  // The room was created while the server allowed 10,000 (the stored cap stays 10,000).
  await app.city.db.query('UPDATE rooms SET member_cap=10000 WHERE id=$1', [roomId]);
  const join = async (name: string) => {
    const member = await account(name);
    return post(
      `/api/rooms/${roomId}/join`,
      { link, agent_id: member.agentId, idempotency_key: randomUUID() },
      { cookie: member.cookie },
    );
  };
  const joined = await join('Lowered one');
  assert.equal(joined.statusCode, 200, joined.body);
  // The host agent, the host as a person (in its room from creation) and one member reach the
  // server maximum of 3: the next join is refused.
  const full = await join('Lowered two');
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().code, 'room_full');
  assert.match(full.json().message ?? full.json().error ?? full.body, /3 members/);
  // The guest invite path is bounded the same way (its uniform refusal).
  const invite = await post(
    '/api/links',
    { target: 'room', room_id: roomId },
    { cookie: host.cookie },
  );
  assert.equal(invite.statusCode, 201, invite.body);
  const code = new URL(invite.json().url).pathname.split('/').at(-1)!;
  const start = await post('/api/public/invites/bootstrap', { code });
  const redeemed =
    start.statusCode === 200
      ? await post('/api/public/invites/redeem', {
          code,
          handle: start.json().handle,
          name: 'Lowered guest',
        })
      : start;
  assert.notEqual(redeemed.statusCode, 200, redeemed.body);
  // Members already in stay.
  const members = await app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/members`,
    headers: { ...headers, cookie: host.cookie },
  });
  assert.equal(members.json().members.length, 3);
});

/** An app with helpers for the host-maximum tests (CITY_STRESS_TEST_OPERATORS read at call time). */
async function capApp(t: { after(fn: () => unknown): void }, first: number) {
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
  let address = first;
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const account = async (name: string) => {
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic room cap password',
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    const operatorId = (
      await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { cookie, agentId: agent.json().agent.id as string, operatorId };
  };
  const createRoom = (host: { cookie: string; agentId: string }, extra: object = {}) =>
    post(
      '/api/rooms',
      { name: 'Cap room', agent_id: host.agentId, idempotency_key: randomUUID(), ...extra },
      { cookie: host.cookie },
    );
  return { app, post, account, createRoom };
}

/** Runs `run` with CITY_STRESS_TEST_OPERATORS set to `ids`, then restores it. */
async function asStressOperators<T>(ids: string[], run: () => Promise<T>): Promise<T> {
  const before = process.env.CITY_STRESS_TEST_OPERATORS;
  process.env.CITY_STRESS_TEST_OPERATORS = ids.join(',');
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.CITY_STRESS_TEST_OPERATORS;
    else process.env.CITY_STRESS_TEST_OPERATORS = before;
  }
}

test('an ordinary host is held to 100: create, link uses and join links above 100 are refused', async (t) => {
  const f = await capApp(t, 140);
  const host = await f.account('Standard host');
  const big = await f.createRoom(host, { member_cap: 101 });
  assert.equal(big.statusCode, 400, big.body);
  assert.equal(big.json().code, 'member_cap_too_large');
  assert.match(big.json().error, /at most 100 members/);
  const uses = await f.createRoom(host, { link_max_uses: 101 });
  assert.equal(uses.statusCode, 400, uses.body);
  assert.equal(uses.json().code, 'member_cap_too_large');
  const room = await f.createRoom(host);
  assert.equal(room.statusCode, 201, room.body);
  assert.equal(room.json().room.member_cap, 100, 'the default is 100');
  const roomId = room.json().room.id as string;
  const tooMany = await f.post(
    '/api/links',
    { target: 'room', room_id: roomId, max_uses: 101 },
    { cookie: host.cookie },
  );
  assert.equal(tooMany.statusCode, 400, tooMany.body);
  assert.equal(tooMany.json().code, 'max_uses_too_large');
  const link = await f.post(
    '/api/links',
    { target: 'room', room_id: roomId },
    { cookie: host.cookie },
  );
  assert.equal(link.statusCode, 201, link.body);
  assert.equal(link.json().max_uses, 100);
});

test('an approved operator (CITY_STRESS_TEST_OPERATORS) may set up to 10,000; its default stays 100', async (t) => {
  const f = await capApp(t, 160);
  const master = await f.account('Master host');
  await asStressOperators([master.operatorId], async () => {
    const plain = await f.createRoom(master);
    assert.equal(plain.statusCode, 201, plain.body);
    assert.equal(plain.json().room.member_cap, 100, 'the default stays 100');
    const big = await f.createRoom(master, { member_cap: 10_000, link_max_uses: 10_000 });
    assert.equal(big.statusCode, 201, big.body);
    assert.equal(big.json().room.member_cap, 10_000);
    const roomId = big.json().room.id as string;
    const link = await f.post(
      '/api/links',
      { target: 'room', room_id: roomId },
      {
        cookie: master.cookie,
      },
    );
    assert.equal(link.statusCode, 201, link.body);
    assert.equal(link.json().max_uses, 10_000, 'the default link follows the member cap');
    const explicit = await f.post(
      '/api/links',
      { target: 'room', room_id: roomId, max_uses: 5_000 },
      { cookie: master.cookie },
    );
    assert.equal(explicit.statusCode, 201, explicit.body);
    const raised = await f.post(
      `/api/rooms/${plain.json().room.id}/settings`,
      { member_cap: 10_000 },
      { cookie: master.cookie },
    );
    assert.equal(raised.statusCode, 200, raised.body);
    assert.equal(raised.json().room.member_cap, 10_000);
    assert.equal((await f.createRoom(master, { member_cap: 10_001 })).statusCode, 400);
  });
  // Once the host is no longer approved, it cannot set more than 100 again.
  const rooms = (
    await f.app.city.db.query<{ id: string }>(
      'SELECT id FROM rooms WHERE host_owner_id=$1 AND member_cap=10000',
      [master.operatorId],
    )
  ).rows;
  assert.equal(rooms.length, 2);
  const raise = await f.post(
    `/api/rooms/${rooms[0]!.id}/settings`,
    { member_cap: 10_000 },
    { cookie: master.cookie },
  );
  assert.equal(raise.statusCode, 400, 'without approval the settings path is held to 100');
});

test('a join beyond 100 members is refused, even in a room stored with a larger cap', async (t) => {
  const f = await capApp(t, 180);
  const host = await f.account('Full host');
  const room = await f.createRoom(host);
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id as string;
  const link = room.json().link.link as string;
  // 99 synthetic members plus the host: 100.
  await f.app.city.db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
       SELECT 'cap-owner-' || i, 'Cap guest', 'cap-owner-' || i, '!', '!', 'unclaimed'
         FROM generate_series(1, 99) AS i`,
  );
  await f.app.city.db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,last_read_seq)
       SELECT $1, 'cap-agent-' || i, 'cap-owner-' || i, 'member', 'Cap owner ' || i, 0, i, 'test', 0
         FROM generate_series(1, 99) AS i`,
    [roomId],
  );
  const late = await f.account('Late joiner');
  const join = () =>
    f.post(
      `/api/rooms/${roomId}/join`,
      { link, agent_id: late.agentId, idempotency_key: randomUUID() },
      { cookie: late.cookie },
    );
  const full = await join();
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().code, 'room_full');
  // A room stored with 10,000 (created before migration 36) is bounded the same way.
  await f.app.city.db.query('UPDATE rooms SET member_cap=10000 WHERE id=$1', [roomId]);
  const stillFull = await join();
  assert.equal(stillFull.statusCode, 409, stillFull.body);
  assert.equal(stillFull.json().code, 'room_full');
  assert.match(stillFull.json().error, /100 members/);
  // The guest invite path too (its uniform refusal).
  await f.app.city.db.query('UPDATE rooms SET member_cap=100 WHERE id=$1', [roomId]);
  const invite = await f.post(
    '/api/links',
    { target: 'room', room_id: roomId },
    {
      cookie: host.cookie,
    },
  );
  assert.equal(invite.statusCode, 201, invite.body);
  await f.app.city.db.query('UPDATE rooms SET member_cap=10000 WHERE id=$1', [roomId]);
  const code = new URL(invite.json().url).pathname.split('/').at(-1)!;
  const start = await f.post('/api/public/invites/bootstrap', { code });
  const redeemed =
    start.statusCode === 200
      ? await f.post('/api/public/invites/redeem', {
          code,
          handle: start.json().handle,
          name: 'Late guest',
        })
      : start;
  assert.notEqual(redeemed.statusCode, 200, redeemed.body);
});

test('migration 36 lowers open rooms above 100 to GREATEST(100, active members); nobody is evicted', async (t) => {
  registerMessagingMigration();
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  registerRoomsMigration();
  registerJoinLinksMigration();
  registerWakeMigration();
  registerResultsMigration();
  registerRoomFormatMigration();
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < 36),
  );
  await db.exec(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES ('op','Op','op','x','y');`,
  );
  const room = (id: string, cap: number, closed: number | null) =>
    db.query(
      `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,closed_at,idempotency_key,request_hash)
       VALUES ($1,$1,$1,'op','agent',$2,'full',1000,0,$3,$1,'h')`,
      [id, cap, closed],
    );
  const members = (roomId: string, active: number, removed = 0) =>
    db.query(
      `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,removed_at)
         SELECT $1, $1 || '-agent-' || i, 'op', 'member', 'Op', 0, i, 'test',
                CASE WHEN i > $2 THEN 5 END
           FROM generate_series(1, $2::int + $3::int) AS i`,
      [roomId, active, removed],
    );
  await room('busy-10000', 10_000, null);
  await members('busy-10000', 150, 20);
  await room('quiet-10000', 10_000, null);
  await members('quiet-10000', 5, 200);
  await room('open-500', 500, null);
  await room('open-100', 100, null);
  await room('open-60', 60, null);
  await room('closed-10000', 10_000, 5);
  const logged: Array<{ event: string; fields: Record<string, number> }> = [];
  const result = await runMigrations(db, listMigrations(), Date.now, true, (event, fields) =>
    logged.push({ event, fields }),
  );
  assert.ok(result.applied.includes(36));
  // One structured line with counts measured before the UPDATE (no ids). Later migrations that
  // other test files registered (listMigrations() is global) may log their own lines.
  assert.deepEqual(
    logged.filter((line) => line.event === 'rooms.migration36'),
    [
      {
        event: 'rooms.migration36',
        fields: { rooms_lowered: 3, at_10000: 2, over_100_active: 1, largest_active: 150 },
      },
    ],
  );
  const caps = Object.fromEntries(
    (
      await db.query<{ id: string; member_cap: number }>('SELECT id, member_cap FROM rooms')
    ).rows.map((row) => [row.id, row.member_cap]),
  );
  assert.deepEqual(caps, {
    // 150 active (removed members do not count): the cap is the active count, nobody leaves.
    'busy-10000': 150,
    'quiet-10000': 100,
    'open-500': 100,
    'open-100': 100,
    'open-60': 60,
    'closed-10000': 10_000,
  });
  const active = await db.query<{ n: string | number }>(
    "SELECT count(*) AS n FROM room_members WHERE room_id='busy-10000' AND removed_at IS NULL",
  );
  assert.equal(Number(active.rows[0]!.n), 150, 'no member was removed');
});
