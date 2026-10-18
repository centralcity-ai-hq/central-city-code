import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createApp } from '../server/app.js';
import { postgresDatabase, type Database } from '../server/database.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { CityLimits } from '../server/limits.js';
import {
  STRESS_TEST_MAX_GUESTS_ENV,
  STRESS_TEST_OPERATORS_ENV,
} from '../server/stress-allowlist.js';

/**
 * Invite joins under concurrency: no host-wide lock on the join path, every limit still exact.
 * Runs on PGlite by default (one connection, so transactions serialize and these check the
 * limits only). With CITY_TEST_POSTGRES_URL set to a PostgreSQL server (a role that may create
 * databases), each test runs on a fresh database with a real connection pool, so the joins truly
 * race and the benchmark measures lock contention.
 */
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-concurrency-test-root-stand-in-secret';

const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};
const POSTGRES = process.env.CITY_TEST_POSTGRES_URL;
const HIGH = 1_000_000;
/** Simulated round trip per statement on PostgreSQL (CITY_TEST_POSTGRES_DELAY_MS, default 1). */
const DELAY_MS = Number(process.env.CITY_TEST_POSTGRES_DELAY_MS ?? 1);
/** Generous per-address limits: these tests are about the host, room and source bounds. */
const OPEN_LIMITS: Partial<CityLimits> = {
  invitedGuestsPerSite: HIGH,
  invitedGuestsPerNetwork: HIGH,
  invitedGuestsPerRegion: HIGH,
  inviteRequestsPerSourcePerHour: HIGH,
  inviteRequestsPerSitePerHour: HIGH,
  inviteRequestsPerNetworkPerHour: HIGH,
  inviteRequestsPerRegionPerHour: HIGH,
  unclaimedAgentsGlobal: HIGH,
  unclaimedBucketsGlobal: HIGH,
};

async function database(t: TestContext): Promise<Database | PGlite> {
  if (!POSTGRES) return PGlite.create('memory://');
  const name = `city_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: POSTGRES, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(POSTGRES);
  url.pathname = `/${name}`;
  // A real pool (40 connections), so joins run on separate sessions and truly race.
  const pool = new pg.Pool({ connectionString: url.toString(), max: 40 });
  // The test owns the pool: it ends it before the drop, whatever order cleanup hooks run in, so
  // DROP ... WITH (FORCE) never terminates a live idle client (an unhandled pool 'error').
  pool.on('error', () => {});
  const db = postgresDatabase(pool);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  return withLatency({ ...db, close: async () => {} }, DELAY_MS);
}

/**
 * Each statement waits `ms` first, standing in for the network round trip to a managed database
 * (locks are held across round trips, which is what makes a hot lock expensive in production).
 */
function withLatency(db: Database, ms: number): Database {
  if (!ms) return db;
  const wait = () => new Promise((resolve) => setTimeout(resolve, ms));
  const slow =
    <Q extends Database['query']>(query: Q) =>
    async (sql: string, params?: unknown[]) => {
      await wait();
      return query(sql, params);
    };
  return {
    ...db,
    query: slow(db.query) as Database['query'],
    transaction: (action) =>
      db.transaction((tx) => action({ ...tx, query: slow(tx.query) as Database['query'] })),
  };
}

let addressSeq = 0;
/** A distinct client address per guest, so per-source budgets never interfere. */
const nextAddress = () => {
  const n = ++addressSeq;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

async function setup(t: TestContext, limits: Partial<CityLimits> = {}) {
  for (const name of [STRESS_TEST_OPERATORS_ENV, STRESS_TEST_MAX_GUESTS_ENV]) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const app = await createApp({
    database: await database(t),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    limits: { ...OPEN_LIMITS, ...limits },
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
  let hostAddress = 40;
  const host = async (name: string) => {
    const address = `203.0.113.${hostAddress++}`;
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic concurrency test password' },
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
    assert.equal(agent.statusCode, 201, agent.body);
    const operatorId = (
      await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    const room = async (cap = 100) => {
      const created = await post(
        '/api/rooms',
        {
          name: `${name} room`,
          agent_id: agent.json().agent.id,
          idempotency_key: randomUUID(),
          member_cap: cap,
        },
        { cookie },
        address,
      );
      assert.equal(created.statusCode, 201, created.body);
      const roomId = created.json().room.id as string;
      const link = await post(
        '/api/links',
        { target: 'room', room_id: roomId, max_uses: cap },
        { cookie },
        address,
      );
      assert.equal(link.statusCode, 201, link.body);
      return { roomId, code: (link.json().url as string).split('/j/')[1]! };
    };
    const remove = (roomId: string, agentId: string) =>
      post(`/api/rooms/${roomId}/members/${agentId}/remove`, {}, { cookie }, address);
    return { operatorId, room, remove };
  };
  let guest = 0;
  /** Picks up a handle (bootstrap); the redeem it returns joins when called. */
  const pickup = async (code: string, address = nextAddress()) => {
    const start = await post('/api/public/invites/bootstrap', { code }, {}, address);
    assert.equal(start.statusCode, 200, start.body);
    const handle = start.json().handle as string;
    const name = `Guest ${++guest}`;
    return () => post('/api/public/invites/redeem', { code, handle, name }, {}, address);
  };
  const liveGuests = async (hostOwnerId: string) =>
    Number(
      (
        await app.city.db.query<{ n: string }>(
          'SELECT count(*) AS n FROM room_invite_credentials WHERE host_owner_id=$1 AND revoked_at IS NULL',
          [hostOwnerId],
        )
      ).rows[0]!.n,
    );
  const members = async (roomId: string) =>
    Number(
      (
        await app.city.db.query<{ n: string }>(
          'SELECT count(*) AS n FROM room_members WHERE room_id=$1 AND removed_at IS NULL',
          [roomId],
        )
      ).rows[0]!.n,
    );
  return { app, post, host, pickup, liveGuests, members };
}

const tally = (results: { statusCode: number; json(): { code?: string } }[]) => {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = r.statusCode === 200 ? 'ok' : `${r.statusCode} ${r.json().code}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

test('parallel joins across rooms admit exactly up to the per-host guest ceiling', async (t) => {
  const { host, pickup, liveGuests } = await setup(t, { inviteGuestsPerHost: 7 });
  const h = await host('Ceiling host');
  const rooms = await Promise.all([h.room(), h.room(), h.room(), h.room()]);
  const redeems = [];
  for (let i = 0; i < 24; i++) redeems.push(await pickup(rooms[i % rooms.length]!.code));
  const results = await Promise.all(redeems.map((redeem) => redeem()));
  assert.deepEqual(tally(results), { ok: 7, '429 invite_host_capacity': 17 });
  assert.equal(await liveGuests(h.operatorId), 7);
});

test('a stress-test host is held exactly to its own ceiling under parallel joins', async (t) => {
  const { host, pickup, liveGuests } = await setup(t);
  const h = await host('Stress ceiling host');
  process.env[STRESS_TEST_OPERATORS_ENV] = h.operatorId;
  process.env[STRESS_TEST_MAX_GUESTS_ENV] = '9';
  const rooms = await Promise.all([h.room(200), h.room(200), h.room(200)]);
  const redeems = [];
  for (let i = 0; i < 30; i++) redeems.push(await pickup(rooms[i % rooms.length]!.code));
  const results = await Promise.all(redeems.map((redeem) => redeem()));
  assert.deepEqual(tally(results), { ok: 9, '429 invite_host_capacity': 21 });
  assert.equal(await liveGuests(h.operatorId), 9);
});

test('the room member cap is exact under parallel joins into one room', async (t) => {
  const { host, pickup, members } = await setup(t);
  const h = await host('Room cap host');
  // The host agent, the host as a person (in its room from creation) and five guests.
  const room = await h.room(7);
  const redeems = [];
  for (let i = 0; i < 15; i++) redeems.push(await pickup(room.code));
  const results = await Promise.all(redeems.map((redeem) => redeem()));
  assert.equal(tally(results).ok, 5, JSON.stringify(tally(results)));
  assert.equal(await members(room.roomId), 7);
});

test('the per-source guest cap is exact under parallel joins from one source', async (t) => {
  const { host, pickup } = await setup(t, {
    invitedGuestsPerSource: 3,
    invitePickupsPerSource: 50,
  });
  const h = await host('Source cap host');
  const rooms = await Promise.all([h.room(), h.room(), h.room()]);
  const redeems = [];
  for (let i = 0; i < 12; i++) redeems.push(await pickup(rooms[i % 3]!.code, '198.51.100.9'));
  const results = await Promise.all(redeems.map((redeem) => redeem()));
  assert.deepEqual(tally(results), { ok: 3, '429 invite_source_capacity': 9 });
});

test('a join waiting behind a removal sees the guest source block it commits', async (t) => {
  const { app, host, pickup } = await setup(t);
  const h = await host('Removal host');
  const room = await h.room();
  const address = '198.51.100.20';
  const first = await (await pickup(room.code, address))();
  assert.equal(first.statusCode, 200, first.body);
  const source = (
    await app.city.db.query<{ source_hash: string }>(
      'SELECT source_hash FROM room_invite_credentials WHERE agent_id=$1',
      [first.json().agent_id],
    )
  ).rows[0]!.source_hash;
  const redeem = await pickup(room.code, address);
  // A removal's critical section (rooms.remove): it locks the host's workspace and the room row,
  // then commits the source block.
  let joined: Promise<Awaited<ReturnType<typeof redeem>>> | undefined;
  await app.city.db.transaction(async (tx) => {
    await tx.query('SELECT operator_id FROM workspaces WHERE operator_id=$1 FOR UPDATE', [
      h.operatorId,
    ]);
    await tx.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [room.roomId]);
    await tx.query(
      'INSERT INTO room_guest_blocks(room_id, source_hash, expires_at) VALUES($1,$2,$3)',
      [room.roomId, source, Date.now() + 86_400_000],
    );
    joined = redeem();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const result = await joined!;
  assert.equal(result.statusCode, 403, result.body);
  assert.equal(result.json().code, 'removed_from_room');
});

test('a removal racing joins from the removed source never lets one in after the block', async (t) => {
  const { post, host, pickup } = await setup(t);
  const h = await host('Race host');
  for (let round = 0; round < 5; round++) {
    const room = await h.room();
    const address = `198.51.100.${100 + round}`;
    const first = await (await pickup(room.code, address))();
    assert.equal(first.statusCode, 200, first.body);
    const redeems = [];
    for (let i = 0; i < 4; i++) redeems.push(await pickup(room.code, address));
    const [removed, ...results] = await Promise.all([
      h.remove(room.roomId, first.json().agent_id),
      ...redeems.map((redeem) => redeem()),
    ]);
    assert.equal(removed.statusCode, 200, removed.body);
    for (const result of results)
      assert.ok(
        result.statusCode === 200 || result.json().code === 'removed_from_room',
        result.body,
      );
    // After the race, the source is refused.
    const late = await post('/api/public/invites/bootstrap', { code: room.code }, {}, address);
    assert.equal(late.json().code, 'removed_from_room', late.body);
  }
});

test('benchmark: 200 parallel joins for one host, across rooms and into one room', async (t) => {
  const { host, pickup, liveGuests } = await setup(t);
  const h = await host('Benchmark host');
  process.env[STRESS_TEST_OPERATORS_ENV] = h.operatorId;
  const run = async (label: string, codes: string[]) => {
    const redeems = [];
    for (let i = 0; i < 200; i++) redeems.push(await pickup(codes[i % codes.length]!));
    const started = performance.now();
    const results = await Promise.all(redeems.map((redeem) => redeem()));
    const ms = performance.now() - started;
    assert.deepEqual(tally(results), { ok: 200 }, label);
    t.diagnostic(
      `${label}: 200 joins in ${Math.round(ms)} ms, ${((200 / ms) * 1000).toFixed(1)} joins/s (${POSTGRES ? `PostgreSQL, ${DELAY_MS} ms per statement` : 'PGlite'})`,
    );
  };
  const rooms = [];
  for (let i = 0; i < 10; i++) rooms.push((await h.room(1000)).code);
  // Warm-up (connections, plans), not measured.
  await Promise.all((await Promise.all(rooms.map((code) => pickup(code)))).map((r) => r()));
  await run('10 rooms', rooms);
  await run('1 room', [(await h.room(1000)).code]);
  assert.equal(await liveGuests(h.operatorId), 410);
});

/**
 * Not a join race, but it needs the same real PostgreSQL pool (the postgres-races CI job runs this
 * file): a post moves its owner's cursors (recordPost) while reads and member lists of the same
 * owner touch the same rows (touchMembers). Both lock the rows in agent_id order, so the mix never
 * deadlocks (PostgreSQL would abort one side with 40P01, a 500 here).
 */
test('posts and reads of one owner with two AIs in a room never deadlock on member rows', async (t) => {
  const { post } = await setup(t);
  let address = 80;
  /** An AI workspace a person claims, with a key holding every scope (as tests/rooms.test.ts). */
  const owner = async (name: string) => {
    const from = `203.0.113.${address++}`;
    const created = await post(
      '/api/public/workspaces',
      { name, idempotency_key: randomUUID() },
      {},
      from,
    );
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().workspace_id as string;
    const person = await post(
      '/api/auth/register',
      { name: `${name} person`, password: 'Synthetic concurrency test password' },
      {},
      from,
    );
    assert.equal(person.statusCode, 201, person.body);
    const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const claimed = await post(
      '/api/workspaces/claim',
      { claim_token: created.json().claim_token },
      { cookie },
      from,
    );
    assert.equal(claimed.statusCode, 200, claimed.body);
    const minted = await post(
      '/api/workspace-keys',
      { label: 'races', scopes: [...ASSISTANT_SCOPES] },
      { cookie, 'x-city-workspace': id },
      from,
    );
    assert.equal(minted.statusCode, 201, minted.body);
    const key = minted.json().workspace_key as string;
    const tool = (name: string, args: unknown) =>
      post(`/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` }, from);
    const agent = async (agentName: string) => {
      const res = await tool('city_create_agent', {
        name: agentName,
        description: 'Synthetic room member',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      });
      assert.equal(res.statusCode, 200, res.body);
      return res.json().agent.id as string;
    };
    return { tool, agent };
  };
  const a = await owner('Race host');
  const b = await owner('Race member');
  const host = await a.agent('Race host desk');
  const [b1, b2] = [await b.agent('B one'), await b.agent('B two')];
  const room = await a.tool('city_create_room', {
    agent_id: host,
    name: 'Race room',
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 200, room.body);
  const roomId = room.json().room.id as string;
  for (const agentId of [b1, b2]) {
    const joined = await b.tool('city_join_room', {
      link: room.json().link.link,
      agent_id: agentId,
      idempotency_key: randomUUID(),
    });
    assert.equal(joined.statusCode, 200, joined.body);
  }
  const say = (who: typeof a, text: string, agentId?: string) =>
    who.tool('city_room_post', {
      room_id: roomId,
      text,
      idempotency_key: randomUUID(),
      ...(agentId ? { agent_id: agentId } : {}),
    });
  const calls = [];
  for (let i = 0; i < 20; i++)
    calls.push(
      say(b, `B one ${i}`, b1),
      say(b, `B two ${i}`, b2),
      say(a, `Host ${i}`),
      b.tool('city_room_read', { room_id: roomId }),
      b.tool('city_room_members', { room_id: roomId }),
    );
  const results = await Promise.all(calls);
  for (const res of results) assert.equal(res.statusCode, 200, res.body);
  // Nothing was lost: one more read delivers whatever B has not read, then B is caught up.
  const drain = async () => {
    for (;;) {
      const page = await b.tool('city_room_read', { room_id: roomId, limit: 100 });
      assert.equal(page.statusCode, 200, page.body);
      if (!page.json().has_more) return;
    }
  };
  await drain();
  const after = await b.tool('city_room_read', { room_id: roomId });
  assert.deepEqual(after.json().messages, []);
});
