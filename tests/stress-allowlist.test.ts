import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import {
  STRESS_TEST_MAX_GUESTS_DEFAULT,
  STRESS_TEST_MAX_GUESTS_ENV,
  STRESS_TEST_MAX_ROOMS_DEFAULT,
  STRESS_TEST_MAX_ROOMS_ENV,
  stressTestMaxRooms,
  STRESS_TEST_OPERATORS_ENV,
  stressTestMaxGuests,
  isStressTestHost,
  stressTestOperators,
} from '../server/stress-allowlist.js';
import { windowClock } from './window-clock.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-stress-allowlist-test-secret-00';

/**
 * Stress-test operators: guests joining rooms of an allowlisted host skip the per-source, site,
 * network and region unclaimed caps; the deployment-wide caps and the room member cap still
 * apply, and every other host keeps the public limits. Synthetic data.
 */
test('the allowlist is read from CITY_STRESS_TEST_OPERATORS; empty or absent exempts nobody', () => {
  assert.equal(STRESS_TEST_OPERATORS_ENV, 'CITY_STRESS_TEST_OPERATORS');
  assert.equal(stressTestOperators({}).size, 0);
  assert.equal(stressTestOperators({ CITY_STRESS_TEST_OPERATORS: '' }).size, 0);
  assert.equal(stressTestOperators({ CITY_STRESS_TEST_OPERATORS: ' , ,' }).size, 0);
  assert.deepEqual(
    [...stressTestOperators({ CITY_STRESS_TEST_OPERATORS: ' op-a ,op-b,,bad id,op-a ' })],
    ['op-a', 'op-b'],
  );
  const env = { CITY_STRESS_TEST_OPERATORS: 'op-a,op-b' };
  assert.equal(isStressTestHost('op-a', env), true);
  assert.equal(isStressTestHost('op-c', env), false);
  assert.equal(isStressTestHost('', env), false);
  assert.equal(isStressTestHost(null, env), false);
  assert.equal(isStressTestHost('op-a', {}), false);
  assert.equal(stressTestMaxGuests({}), STRESS_TEST_MAX_GUESTS_DEFAULT);
  assert.equal(STRESS_TEST_MAX_GUESTS_DEFAULT, 50_000);
  assert.equal(stressTestMaxGuests({ CITY_STRESS_TEST_MAX_GUESTS: '25' }), 25);
  assert.throws(() => stressTestMaxGuests({ CITY_STRESS_TEST_MAX_GUESTS: 'lots' }));
  assert.throws(() => stressTestMaxGuests({ CITY_STRESS_TEST_MAX_GUESTS: '0' }));
});

const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};
/** Every guest joins from this one machine. */
const GUEST_ADDRESS = '203.0.113.12';

async function setup(
  t: TestContext,
  limits: Partial<CityLimits> = {},
  rooms: Record<string, number> = {},
) {
  for (const name of [
    STRESS_TEST_OPERATORS_ENV,
    STRESS_TEST_MAX_GUESTS_ENV,
    STRESS_TEST_MAX_ROOMS_ENV,
  ]) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    // Rate-limit windows are fixed and clock-aligned: a pinned clock keeps every burst below in
    // one window, whatever the wall clock does during the run.
    now: windowClock(),
    limits,
    ...(Object.keys(rooms).length ? { rooms } : {}),
  });
  t.after(() => app.close());
  let hostAddress = 40;
  const post = (url: string, body: unknown, extra = {}, remoteAddress = GUEST_ADDRESS) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const host = async (name: string, memberCap?: number) => {
    const address = `203.0.113.${hostAddress++}`;
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic stress test password' },
      {},
      address,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
      address,
    );
    const create = (cap?: number) =>
      post(
        '/api/rooms',
        {
          name: `${name} room`,
          agent_id: agent.json().agent.id,
          idempotency_key: randomUUID(),
          ...(cap ? { member_cap: cap } : {}),
        },
        { cookie },
        address,
      );
    const room = async (cap?: number) => {
      const created = await create(cap);
      assert.equal(created.statusCode, 201, created.body);
      const roomId = created.json().room.id as string;
      const link = await post(
        '/api/links',
        { target: 'room', room_id: roomId },
        { cookie },
        address,
      );
      assert.equal(link.statusCode, 201, link.body);
      const roomLink = created.json().link?.link as string | undefined;
      return { roomId, code: (link.json().url as string).split('/j/')[1]!, roomLink };
    };
    const operatorId = (
      await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { operatorId, main: await room(memberCap), room, create };
  };
  let guest = 0;
  const bootstrap = (code: string) => post('/api/public/invites/bootstrap', { code });
  const join = async (code: string, address = GUEST_ADDRESS) => {
    const start = await post('/api/public/invites/bootstrap', { code }, {}, address);
    if (start.statusCode !== 200) return start;
    return post(
      '/api/public/invites/redeem',
      { code, handle: start.json().handle, name: `Guest ${++guest}` },
      {},
      address,
    );
  };

  const stress = await host('Stress host');
  const other = await host('Public host');
  process.env[STRESS_TEST_OPERATORS_ENV] = `unrelated-operator, ${stress.operatorId}`;
  return { app, post, host, join, bootstrap, stress, other };
}

test('guests of a stress-test host skip the unclaimed caps, not the room cap or its ceiling', async (t) => {
  const { app, join, stress, other } = await setup(t, {
    // Tiny per-address caps so a handful of guests reaches them.
    invitedGuestsPerSource: 2,
    invitedGuestsPerSite: 2,
    invitedGuestsPerNetwork: 2,
    invitedGuestsPerRegion: 2,
    inviteRequestsPerSourcePerHour: 4,
    inviteRequestsPerSitePerHour: 4,
    inviteRequestsPerNetworkPerHour: 4,
    inviteRequestsPerRegionPerHour: 4,
    unclaimedAgentsGlobal: 11,
  });

  // Another host's room keeps the public per-address limits: the third guest is refused.
  for (let i = 0; i < 2; i++) assert.equal((await join(other.main.code)).statusCode, 200);
  assert.equal((await join(other.main.code)).statusCode, 429);

  // The stress host's room admits more guests from the same machine.
  for (let i = 0; i < 6; i++) {
    const joined = await join(stress.main.code);
    assert.equal(joined.statusCode, 200, `stress guest ${i + 1}: ${joined.body}`);
  }
  // Nothing was added to the machine's real site, network or region counters.
  const stats = (
    await app.city.db.query<{ scope_key: string; agents: number }>(
      'SELECT scope_key, agents FROM unclaimed_stats ORDER BY scope_key',
    )
  ).rows;
  assert.equal(stats.find((row) => row.scope_key === 'global')?.agents, 8);
  for (const row of stats.filter((item) => item.scope_key !== 'global'))
    assert.equal(row.agents, 2, `${row.scope_key} counts only the public host's guests`);

  // The room member cap still applies to a stress host's room (the host agent, the host as a
  // person (in its room from creation) and two guests).
  const small = await stress.room(4);
  for (let i = 0; i < 2; i++) assert.equal((await join(small.code)).statusCode, 200);
  const full = await join(small.code);
  assert.equal(full.statusCode, 404, full.body);
  assert.equal(full.json().code, 'invite_invalid', 'a full room admits nobody');

  // The deployment-wide cap (11) binds the public host, not the stress host.
  for (let i = 0; i < 2; i++) assert.equal((await join(stress.main.code)).statusCode, 200);
  const global = await join(other.main.code, '198.51.100.7');
  assert.equal(global.statusCode, 409, global.body);
  assert.equal(global.json().code, 'unclaimed_capacity');

  // The stress host's own ceiling: live guests across its rooms (10 so far).
  process.env[STRESS_TEST_MAX_GUESTS_ENV] = '11';
  assert.equal((await join(stress.main.code)).statusCode, 200);
  const ceiling = await join(stress.main.code);
  assert.equal(ceiling.statusCode, 429, ceiling.body);
  // The same neutral answer as any full host: a public caller learns nothing about the host.
  assert.equal(ceiling.json().code, 'invite_host_capacity');
  assert.doesNotMatch(ceiling.body, /stress|load.?test/i);

  // With the allowlist emptied, the stress host's room is back to the public limits.
  process.env[STRESS_TEST_OPERATORS_ENV] = '';
  assert.equal((await join(stress.main.code)).statusCode, 429);
});

test('a room link (crr_ token) of a stress-test host skips the hourly budget; others keep it', async (t) => {
  const { bootstrap, stress, other } = await setup(t, {
    inviteRequestsPerSourcePerHour: 2,
    inviteRequestsPerSitePerHour: 2,
    inviteRequestsPerNetworkPerHour: 2,
    inviteRequestsPerRegionPerHour: 2,
  });
  const stressLink = stress.main.roomLink!;
  const otherLink = other.main.roomLink!;
  assert.match(stressLink, /\/r\/[a-z0-9-]+#crr_[A-Za-z0-9_-]{43}$/);
  const stressToken = stressLink.split('#')[1]!;
  // The public host's room link: the third pickup from this machine hits the hourly budget.
  for (let i = 0; i < 2; i++) assert.equal((await bootstrap(otherLink)).statusCode, 200);
  const limited = await bootstrap(otherLink);
  assert.equal(limited.statusCode, 429, limited.body);
  // The stress host's room link, and its bare crr_ token, are not charged.
  for (let i = 0; i < 4; i++) {
    const picked = await bootstrap(i % 2 ? stressToken : stressLink);
    assert.equal(picked.statusCode, 200, `stress pickup ${i + 1}: ${picked.body}`);
  }
});

for (const [state, update] of [
  ['revoked', 'UPDATE room_links SET revoked_at=1 WHERE room_id=$1'],
  ['expired', 'UPDATE room_links SET expires_at=1 WHERE room_id=$1'],
] as const)
  test(`a ${state} room link of a stress-test host is charged like any other`, async (t) => {
    const { app, bootstrap, stress } = await setup(t, {
      inviteRequestsPerSourcePerHour: 2,
      inviteRequestsPerSitePerHour: 2,
      inviteRequestsPerNetworkPerHour: 2,
      inviteRequestsPerRegionPerHour: 2,
    });
    const dead = await stress.room();
    await app.city.db.query(update, [dead.roomId]);
    // Refused as unusable, but each attempt still counts against the hourly budget.
    for (let i = 0; i < 2; i++) assert.notEqual((await bootstrap(dead.roomLink!)).statusCode, 200);
    const limited = await bootstrap(dead.roomLink!);
    assert.equal(limited.statusCode, 429, limited.body);
  });

test('a stress-test host lifts the per-code and per-source pickup bounds; others keep them', async (t) => {
  const { bootstrap, stress, other } = await setup(t);
  // Another host's link: at most 100 live pickups per code (and per source) in 10 minutes.
  for (let i = 0; i < 100; i++) {
    const picked = await bootstrap(other.main.code);
    assert.equal(picked.statusCode, 200, `public pickup ${i + 1}: ${picked.body}`);
  }
  const refused = await bootstrap(other.main.code);
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, 'invite_capacity');
  // The stress host's link from the same machine goes past both bounds.
  for (let i = 0; i < 120; i++) {
    const picked = await bootstrap(stress.main.code);
    assert.equal(picked.statusCode, 200, `stress pickup ${i + 1}: ${picked.body}`);
  }
});

test('stress-host pickups from an address never block a normal room pickup from it', async (t) => {
  const { bootstrap, join, stress, other } = await setup(t);
  for (let i = 0; i < 120; i++) {
    const picked = await bootstrap(stress.main.code);
    assert.equal(picked.statusCode, 200, `stress pickup ${i + 1}: ${picked.body}`);
  }
  // Same machine, an ordinary room: not counted against the stress host's pickups.
  for (let i = 0; i < 100; i++) {
    const picked = await bootstrap(other.main.code);
    assert.equal(picked.statusCode, 200, `public pickup ${i + 1}: ${picked.body}`);
  }
  // A stress pickup (recorded under its own source) still redeems from the same machine.
  assert.equal((await join(stress.main.code)).statusCode, 200);
});

test('redeemed pickups no longer count toward the code and source bounds', async (t) => {
  const { app, bootstrap, other } = await setup(t);
  for (let i = 0; i < 100; i++) assert.equal((await bootstrap(other.main.code)).statusCode, 200);
  assert.equal((await bootstrap(other.main.code)).json().code, 'invite_capacity');
  await app.city.db.query('UPDATE room_invite_bootstrap SET used_at=1');
  const picked = await bootstrap(other.main.code);
  assert.equal(picked.statusCode, 200, picked.body);
});

test('pickups from one address are bounded per link, with a much larger total across links', async (t) => {
  const { app, bootstrap, other } = await setup(t, { invitePickupsPerSource: 1000 });
  const second = await other.room();
  // 160 live pickups from one address across two ordinary rooms all succeed.
  for (const code of [other.main.code, second.code])
    for (let i = 0; i < 80; i++) {
      const picked = await bootstrap(code);
      assert.equal(picked.statusCode, 200, `pickup ${i + 1}: ${picked.body}`);
    }
  // The anti-abuse ceiling: outstanding pickups per address across all codes (default 10,000).
  const { source_hash, expires_at } = (
    await app.city.db.query<{ source_hash: string; expires_at: string }>(
      'SELECT source_hash, expires_at FROM room_invite_bootstrap LIMIT 1',
    )
  ).rows[0]!;
  await app.city.db.query(
    `INSERT INTO room_invite_bootstrap
     SELECT 'synthetic-' || n, 'synthetic-code-' || n, $1, $2, NULL FROM generate_series(1, $3::int) AS n`,
    [source_hash, expires_at, 1000 - 160],
  );
  const third = await other.room();
  const refused = await bootstrap(third.code);
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, 'invite_capacity');
});

test('the per-code pickup bound still holds across addresses', async (t) => {
  const { post, other } = await setup(t);
  const pick = (address: string) =>
    post('/api/public/invites/bootstrap', { code: other.main.code }, {}, address);
  for (let i = 0; i < 100; i++) {
    const picked = await pick(`198.51.100.${i % 2 ? 20 : 21}`);
    assert.equal(picked.statusCode, 200, `pickup ${i + 1}: ${picked.body}`);
  }
  const refused = await pick('198.51.100.22');
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, 'invite_capacity');
});

test('live guests per address: stress guests never count; no per-room bound, a high total', async (t) => {
  const { app, join, stress, other } = await setup(t, { invitedGuestsPerSource: 5 });
  // A stress test from this machine fills far more than the per-address ceiling...
  for (let i = 0; i < 6; i++) {
    const joined = await join(stress.main.code);
    assert.equal(joined.statusCode, 200, `stress guest ${i + 1}: ${joined.body}`);
  }
  // ...and an ordinary room still admits guests from the same machine; the room itself is
  // bounded by its member cap, not per address.
  for (let i = 0; i < 4; i++) {
    const joined = await join(other.main.code);
    assert.equal(joined.statusCode, 200, `guest ${i + 1}: ${joined.body}`);
  }
  const second = await other.room();
  assert.equal((await join(second.code)).statusCode, 200);
  // The per-address ceiling across all rooms (5 here, 10,000 by default).
  const total = await join(second.code);
  assert.equal(total.statusCode, 429, total.body);
  assert.equal(total.json().code, 'invite_source_capacity');
  // Another address is not affected.
  assert.equal((await join(second.code, '198.51.100.30')).statusCode, 200);
  // Guests are counted under invite scopes of their own, apart from anonymous agent creation.
  const scopes = (
    await app.city.db.query<{ site_key: string }>('SELECT site_key FROM unclaimed_buckets')
  ).rows.map((row) => row.site_key);
  assert.equal(new Set(scopes).size, 3, 'stress, invite and second-address site scopes');
});

test('guests of a stress-test host each get their own activity budget; others share one', async (t) => {
  const { app, join, stress, other } = await setup(t);
  const credentials = async (code: string) => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const joined = await join(code);
      assert.equal(joined.statusCode, 200, joined.body);
      tokens.push(joined.json().credential as string);
    }
    return tokens;
  };
  let address = 0;
  const members = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/public/invites/tools/city_room_members',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: '{}',
      // Spread over addresses: only the host's guest activity budget is under test.
      remoteAddress: `198.51.100.${(address++ % 200) + 1}`,
    });
  // Another host: 120 guest calls per minute across all its guests.
  const shared = await credentials(other.main.code);
  for (let i = 0; i < 120; i++)
    assert.equal((await members(shared[i % 2]!)).statusCode, 200, `public call ${i + 1}`);
  assert.equal((await members(shared[0]!)).statusCode, 429);
  // The stress host: 120 per minute for each guest, so two guests make 140 calls.
  const own = await credentials(stress.main.code);
  for (let i = 0; i < 140; i++)
    assert.equal((await members(own[i % 2]!)).statusCode, 200, `stress call ${i + 1}`);
});

test('one shared address joins 57 different rooms (cloud egress of many unrelated people)', async (t) => {
  const { join, host } = await setup(t, {}, { createsPerOwnerPerDay: 100 });
  // Rooms of several unrelated hosts (an owner keeps at most 20 open rooms).
  const rooms = [];
  for (let h = 0; h < 3; h++) {
    const owner = await host(`Room host ${h + 1}`);
    rooms.push(owner.main);
    for (let i = 0; i < 18; i++) rooms.push(await owner.room());
  }
  assert.equal(rooms.length, 57);
  for (const [index, room] of rooms.entries()) {
    const joined = await join(room.code);
    assert.equal(joined.statusCode, 200, `room ${index + 1}: ${joined.body}`);
  }
});

test('the API request limit is per guest credential, with a 10x per-address floor', async (t) => {
  const { app, join, other } = await setup(t, { apiRequestsPerMinute: 8 });
  const tokens: string[] = [];
  for (let i = 0; i < 2; i++) {
    const joined = await join(other.main.code);
    assert.equal(joined.statusCode, 200, joined.body);
    tokens.push(joined.json().credential as string);
  }
  const members = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/public/invites/tools/city_room_members',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: '{}',
      remoteAddress: GUEST_ADDRESS,
    });
  // Two guests on one address: 8 calls each, far past the per-address limit of 8.
  for (let i = 0; i < 16; i++)
    assert.equal((await members(tokens[i % 2]!)).statusCode, 200, `call ${i + 1}`);
  const spent = await members(tokens[0]!);
  assert.equal(spent.statusCode, 429, 'each credential keeps its own limit');
  // An invalid credential is charged to the address, which the joins already used (4 of 8).
  const fake = `crc_${'A'.repeat(43)}`;
  for (let i = 0; i < 4; i++) assert.notEqual((await members(fake)).statusCode, 429);
  assert.equal((await members(fake)).statusCode, 429);
});

test('CITY_STRESS_TEST_MAX_ROOMS: default 1,000, read at call time, invalid values refused', () => {
  assert.equal(STRESS_TEST_MAX_ROOMS_ENV, 'CITY_STRESS_TEST_MAX_ROOMS');
  assert.equal(STRESS_TEST_MAX_ROOMS_DEFAULT, 1_000);
  assert.equal(stressTestMaxRooms({}), 1_000);
  assert.equal(stressTestMaxRooms({ CITY_STRESS_TEST_MAX_ROOMS: '' }), 1_000);
  assert.equal(stressTestMaxRooms({ CITY_STRESS_TEST_MAX_ROOMS: '40' }), 40);
  for (const bad of ['0', '-1', 'many', '1.5'])
    assert.throws(() => stressTestMaxRooms({ CITY_STRESS_TEST_MAX_ROOMS: bad }));
});

test('a stress-test host skips the open-room cap up to its ceiling; other owners keep the cap', async (t) => {
  // Each host already has one open room (main); the public cap here is 2.
  const { stress, other } = await setup(t, {}, { activeRoomsPerOwner: 2 });
  assert.equal((await other.create()).statusCode, 201);
  const refused = await other.create();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json().code, 'too_many_rooms');
  assert.match(refused.body, /At most 2 open rooms/);

  // The stress host goes past the public cap, up to CITY_STRESS_TEST_MAX_ROOMS (read per call).
  process.env[STRESS_TEST_MAX_ROOMS_ENV] = '4';
  for (let i = 0; i < 3; i++) assert.equal((await stress.create()).statusCode, 201);
  // The fifth open room is past the ceiling (the daily create count uses the same ceiling).
  assert.equal((await stress.create()).statusCode, 429);

  // Off the allowlist (empty variable): the public cap applies again, to everyone.
  process.env[STRESS_TEST_OPERATORS_ENV] = '';
  assert.equal((await stress.create()).statusCode, 429);
});

test('a stress-test host is not held to the daily create limit; other owners are', async (t) => {
  // The public create limit here is 3 a day (each host already created its main room).
  const { stress, other } = await setup(t, {}, { createsPerOwnerPerDay: 3 });
  for (let i = 0; i < 2; i++) assert.equal((await other.create()).statusCode, 201);
  const limited = await other.create();
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  for (let i = 0; i < 6; i++) assert.equal((await stress.create()).statusCode, 201);
});

test('an invalid CITY_STRESS_TEST_MAX_ROOMS fails startup, like CITY_STRESS_TEST_MAX_GUESTS', async (t) => {
  const previous = process.env[STRESS_TEST_MAX_ROOMS_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[STRESS_TEST_MAX_ROOMS_ENV];
    else process.env[STRESS_TEST_MAX_ROOMS_ENV] = previous;
  });
  process.env[STRESS_TEST_MAX_ROOMS_ENV] = 'lots';
  await assert.rejects(
    createApp({ database: await PGlite.create('memory://'), startWorkers: false }),
    /CITY_STRESS_TEST_MAX_ROOMS must be a positive integer/,
  );
});

test('invite joins of a stress-test host skip the per-IP API limit; everything else keeps it', async (t) => {
  // Setup traffic comes from per-host addresses; the guests share GUEST_ADDRESS.
  const { post, join, bootstrap, stress, other } = await setup(t, { apiRequestsPerMinute: 6 });
  // A stress host's /j/ code joins well past the per-IP max from one machine.
  for (let i = 0; i < 5; i++) {
    const joined = await join(stress.main.code);
    assert.equal(joined.statusCode, 200, `stress guest ${i + 1}: ${joined.body}`);
  }
  // Another host's code is still charged: 6 requests per minute, then 429.
  for (let i = 0; i < 6; i++) assert.notEqual((await bootstrap(other.main.code)).statusCode, 429);
  const limited = await bootstrap(other.main.code);
  assert.equal(limited.statusCode, 429, limited.body);
  // A malformed body is charged too, and other /api routes from the same address stay limited.
  assert.equal((await post('/api/public/invites/bootstrap', {})).statusCode, 429);
  assert.equal((await post('/api/auth/login', { name: 'x', password: 'y' })).statusCode, 429);
  // The stress host's joins still pass.
  assert.equal((await join(stress.main.code)).statusCode, 200);
});

test('with an empty allowlist, invite joins keep the per-IP API limit as before', async (t) => {
  const { join, stress } = await setup(t, { apiRequestsPerMinute: 6 });
  process.env[STRESS_TEST_OPERATORS_ENV] = '';
  for (let i = 0; i < 3; i++) assert.equal((await join(stress.main.code)).statusCode, 200);
  const limited = await join(stress.main.code);
  assert.equal(limited.statusCode, 429, limited.body);
});

function countJoinLinkLookups(t: TestContext, db: { query: (...args: never[]) => unknown }) {
  const counter = { lookups: 0 };
  const original = db.query.bind(db) as (...args: unknown[]) => unknown;
  (db as { query: unknown }).query = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('FROM join_links')) counter.lookups++;
    return original(...args);
  };
  t.after(() => ((db as { query: unknown }).query = original));
  return counter;
}

test('random invite codes are refused by ip-lookup before any further DB lookups', async (t) => {
  const { app, post } = await setup(t, { apiRequestsPerMinute: 6 });
  const counter = countJoinLinkLookups(t, app.city.db as never);
  const address = '198.51.100.40';
  const random = () => post('/api/public/invites/bootstrap', { code: randomUUID() }, {}, address);
  // ip-lookup allows 10 x 6 = 60 a minute; the ip: bucket refuses most of them already.
  for (let i = 0; i < 60; i++) assert.notEqual((await random()).statusCode, 200);
  const before = counter.lookups;
  for (let i = 0; i < 3; i++) assert.equal((await random()).statusCode, 429);
  assert.equal(counter.lookups, before, 'no DB lookups once ip-lookup is exhausted');
});

test('a stress host code is looked up once and then served from the cache', async (t) => {
  const { app, bootstrap, stress } = await setup(t, { apiRequestsPerMinute: 60 });
  const counter = countJoinLinkLookups(t, app.city.db as never);
  let before = counter.lookups;
  assert.equal((await bootstrap(stress.main.code)).statusCode, 200);
  const first = counter.lookups - before;
  before = counter.lookups;
  assert.equal((await bootstrap(stress.main.code)).statusCode, 200);
  assert.equal(counter.lookups - before, first - 1, 'the stress-host lookup is cached');
});

test('requests refused before the handler still count against the per-IP limit', async (t) => {
  const { app } = await setup(t, { apiRequestsPerMinute: 6 });
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++)
    statuses.push(
      (
        await app.inject({
          method: 'POST',
          url: '/api/public/invites/bootstrap',
          headers,
          payload: '{not json',
          remoteAddress: GUEST_ADDRESS,
        })
      ).statusCode,
    );
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 400, 429]);
});
