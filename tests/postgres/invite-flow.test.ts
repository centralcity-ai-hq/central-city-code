import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { postgresDatabase } from '../../server/database.js';
import { createApp } from '../../server/app.js';
import { rpcResult } from '../oauth-helpers.js';
import { sessionPair } from '../session-cookie-pair.js';
const connection = process.env.CITY_EXPIRY_PG_TEST_URL;
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-invite-test-root-not-a-real-secret';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'city.test',
  origin: 'https://city.test',
};
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  let time = Date.now();
  assert.ok(connection);
  const url = new URL(connection);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/cc_expiry_synthetic');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  const admin = new Pool({ connectionString: connection, max: 2 });
  const schema = `invite_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: connection,
    max: 8,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=6000`,
  });
  const db = postgresDatabase(pool);
  t.after(async () => {
    await db.close();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const app = await createApp({
    database: { ...db, close: async () => {} },
    hosted: {
      databaseUrl: connection,
      publicOrigin: 'https://city.test',
      allowedOrigins: ['https://city.test'],
    },
    startWorkers: false,
    now: () => time,
  });
  t.after(() => app.close());
  const backend = (
    await app.city.db.query<{ version: string; schema: string }>(
      'SELECT version(), current_schema() AS schema',
    )
  ).rows[0]!;
  assert.match(backend.version, /^PostgreSQL 17\./);
  assert.equal(
    backend.schema,
    schema,
    'the application must use the isolated real PostgreSQL schema',
  );
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
  const cookie = sessionPair(registered.cookies);
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

test(
  'real PostgreSQL concurrent room invitation admission',
  { skip: !connection, timeout: 90000 },
  async (t) => {
    await t.test('single-use invitation admits exactly one competing pickup', async (t) => {
      const f = await fixture(t);
      await f.app.city.db.query('UPDATE join_links SET max_uses=1');
      const starts = await Promise.all([f.bootstrap(), f.bootstrap()]);
      starts.forEach((r) => assert.equal(r.statusCode, 200, r.body));
      const results = await Promise.all(starts.map((r) => f.redeem(r.json().handle)));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 404]);
      assert.equal(
        (await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length,
        1,
      );
      assert.equal(
        (await f.app.city.db.query("SELECT * FROM room_members WHERE role='member'")).rows.length,
        1,
      );
      assert.equal(
        Number(
          (await f.app.city.db.query<{ uses: number }>('SELECT uses FROM join_links')).rows[0]!
            .uses,
        ),
        1,
      );
    });
    await t.test('same pickup racing itself creates one identity', async (t) => {
      const f = await fixture(t),
        start = await f.bootstrap();
      assert.equal(start.statusCode, 200, start.body);
      const results = await Promise.all([
        f.redeem(start.json().handle),
        f.redeem(start.json().handle),
      ]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 404]);
      assert.equal(
        (await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length,
        1,
      );
    });
    await t.test('last global slot race rolls back the losing admission', async (t) => {
      const f = await fixture(t);
      const { loadLimits } = await import('../../server/limits.js');
      const cap = loadLimits(process.env).unclaimedAgentsGlobal;
      await f.app.city.db.query(
        "INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES('global',$1,0) ON CONFLICT(scope_key) DO UPDATE SET agents=EXCLUDED.agents,buckets=0",
        [cap - 1],
      );
      const starts = await Promise.all([f.bootstrap(), f.bootstrap()]);
      starts.forEach((r) => assert.equal(r.statusCode, 200, r.body));
      const results = await Promise.all(starts.map((r) => f.redeem(r.json().handle)));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      assert.equal(
        (await f.app.city.db.query("SELECT * FROM operators WHERE kind='unclaimed'")).rows.length,
        1,
      );
      assert.equal(
        Number(
          (await f.app.city.db.query<{ uses: number }>('SELECT uses FROM join_links')).rows[0]!
            .uses,
        ),
        1,
      );
      assert.equal(
        (await f.app.city.db.query('SELECT * FROM room_invite_bootstrap WHERE used_at IS NULL'))
          .rows.length,
        1,
      );
      assert.equal(
        Number(
          (
            await f.app.city.db.query<{ agents: number }>(
              "SELECT agents FROM unclaimed_stats WHERE scope_key='global'",
            )
          ).rows[0]!.agents,
        ),
        cap,
      );
    });
    await t.test('host removal orders against posts and refuses every later post', async (t) => {
      const f = await fixture(t),
        guest = await f.admit();
      const results = await Promise.all([
        f.post(`/api/rooms/${f.roomId}/members/${guest.agent_id}/remove`, {}, f.host),
        f.invoke(guest.credential, 'city_room_post', {
          text: 'Racing removal',
          idempotency_key: randomUUID(),
        }),
      ]);
      assert.equal(results[0].statusCode, 200, results[0].body);
      // A post that loses the race hears removed_from_room (403), like every later post.
      assert.ok([200, 403].includes(results[1].statusCode), results[1].body);
      assert.equal(
        (
          await f.invoke(guest.credential, 'city_room_post', {
            text: 'After removal',
            idempotency_key: randomUUID(),
          })
        ).statusCode,
        403,
      );
    });
  },
);

test(
  'real PostgreSQL revoke and expiry races',
  { skip: !connection, timeout: 60000 },
  async (t) => {
    await t.test('per-code revoke racing redeem prevents all subsequent admission', async (t) => {
      const f = await fixture(t),
        start = await f.bootstrap();
      assert.equal(start.statusCode, 200, start.body);
      const id = (await f.app.city.db.query<{ id: string }>('SELECT id FROM join_links')).rows[0]!
        .id;
      const results = await Promise.all([
        f.post(`/api/links/${id}/revoke`, {}, f.host),
        f.redeem(start.json().handle),
      ]);
      assert.equal(results[0].statusCode, 200, results[0].body);
      assert.ok([200, 404].includes(results[1].statusCode), results[1].body);
      assert.equal((await f.bootstrap()).statusCode, 404);
      assert.equal((await f.redeem(start.json().handle)).statusCode, 404);
      assert.equal(
        (await f.app.city.db.query('SELECT * FROM room_invite_credentials')).rows.length,
        results[1].statusCode === 200 ? 1 : 0,
      );
    });
    await t.test(
      'credential expiry denies invoke while legacy sweep preserves the identity',
      async (t) => {
        const { sweepUnclaimedAgents } = await import('../../server/autonomy/expiry.js');
        const f = await fixture(t),
          guest = await f.admit();
        assert.equal(
          (
            await f.invoke(guest.credential, 'city_room_post', {
              text: 'Before expiry',
              idempotency_key: randomUUID(),
            })
          ).statusCode,
          200,
        );
        f.advance(72 * 3600000 + 1);
        const [swept, read] = await Promise.all([
          sweepUnclaimedAgents(f.app.city.db, Date.parse(guest.expires_at) + 1),
          f.invoke(guest.credential, 'city_room_read'),
        ]);
        assert.equal(swept.removed, 0);
        assert.equal(read.statusCode, 401, read.body);
        assert.equal((await f.invoke(guest.credential, 'city_room_read')).statusCode, 401);
        assert.equal(
          (
            await f.app.city.db.query('SELECT * FROM room_messages WHERE sender_agent_id=$1', [
              guest.agent_id,
            ])
          ).rows.length,
          1,
        );
      },
    );
    await t.test('concurrent idempotent MCP joins admit exactly one guest', async (t) => {
      const f = await fixture(t);
      const key = randomUUID();
      const join = () =>
        f.app.inject({
          method: 'POST',
          url: '/mcp/open',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            host: 'city.test',
            'x-forwarded-proto': 'https',
          },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'city_join_invite',
              arguments: {
                invite_link: `https://city.test/j/${f.code}`,
                name: 'Racing AI',
                idempotency_key: key,
              },
            },
          },
          remoteAddress: '203.0.113.12',
        });
      const responses = await Promise.all(Array.from({ length: 6 }, join));
      const results = responses.map((r) => {
        assert.equal(r.statusCode, 200, r.body);
        const result = rpcResult(r.body).result;
        assert.ok(result && !result.isError, JSON.stringify(result));
        return result.structuredContent;
      });
      assert.equal(new Set(results.map((r) => r.room_credential)).size, 1);
      assert.equal(results.filter((r) => r.replayed === false).length, 1);
      for (const table of ['room_invite_credentials', 'unclaimed_agent_expiry'])
        assert.equal((await f.app.city.db.query(`SELECT * FROM ${table}`)).rows.length, 1, table);
      assert.equal(
        (await f.app.city.db.query("SELECT * FROM room_members WHERE role='member'")).rows.length,
        1,
      );
    });
    await t.test('live-only source quota: expiry racing a new admission', async (t) => {
      const previous = process.env.CITY_LIMIT_UNCLAIMED_AGENTS_PER_SOURCE;
      process.env.CITY_LIMIT_UNCLAIMED_AGENTS_PER_SOURCE = '1';
      t.after(() => {
        if (previous === undefined) delete process.env.CITY_LIMIT_UNCLAIMED_AGENTS_PER_SOURCE;
        else process.env.CITY_LIMIT_UNCLAIMED_AGENTS_PER_SOURCE = previous;
      });
      const f = await fixture(t);
      await f.admit();
      await f.app.city.db.query('UPDATE room_invite_credentials SET expires_at=0');
      // With the only slot freed, two competing admissions from the same source: one wins.
      const starts = await Promise.all([f.bootstrap(), f.bootstrap()]);
      starts.forEach((r) => assert.equal(r.statusCode, 200, r.body));
      const results = await Promise.all(starts.map((r) => f.redeem(r.json().handle)));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429]);
      assert.equal(
        (
          await f.app.city.db.query(
            'SELECT * FROM room_invite_credentials WHERE revoked_at IS NULL AND expires_at>0',
          )
        ).rows.length,
        1,
      );
    });
  },
);
