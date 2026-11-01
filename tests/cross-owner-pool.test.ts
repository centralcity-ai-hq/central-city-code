import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { postgresDatabase } from '../server/database.js';
import { loadHostedConfig } from '../server/hosted.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-test-only-rate-limit-secret-0000';

/**
 * F4 §7.11: approve and revoke race cleanly on the hosted PostgreSQL code path with the production
 * pool bound (three clients). A PGlite-backed pool models it: each transaction holds one client
 * and runs exclusively (as row locks would serialize these rows), queries outside a transaction
 * wait their turn, and any acquisition while all three clients are held fails at once, like the
 * pool's acquisition timeout. So a limiter or read nested inside a transaction fails the test
 * instead of starving the pool. This is a bounded-pool contract test, not a benchmark.
 */
function boundedPool(pg: PGlite) {
  const stats = { held: 0, peak: 0, nested: 0 };
  let chain: Promise<void> = Promise.resolve();
  const turn = async () => {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const previous = chain;
    chain = previous.then(() => mine);
    await previous;
    return release;
  };
  const run = async (sql: string, params?: unknown[]) =>
    params === undefined && /;\s*\S/.test(sql)
      ? (await pg.exec(sql), { rows: [] })
      : pg.query(sql, params ?? []);
  const waiting: Array<() => void> = [];
  const pool = {
    on() {},
    async connect() {
      while (stats.held >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
      stats.held++;
      stats.peak = Math.max(stats.peak, stats.held);
      let release: (() => void) | undefined;
      return {
        async query(sql: string, params?: unknown[]) {
          if (sql === 'BEGIN') release = await turn();
          const result = await run(sql, params);
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            release?.();
            release = undefined;
          }
          return result;
        },
        release() {
          release?.();
          release = undefined;
          stats.held--;
          waiting.shift()?.();
        },
      };
    },
    async query(sql: string, params?: unknown[]) {
      if (stats.held >= 3) {
        stats.nested++;
        throw new Error('Synthetic bounded pool acquisition timeout');
      }
      const release = await turn();
      try {
        return await run(sql, params);
      } finally {
        release();
      }
    },
    async end() {
      await pg.close();
    },
  };
  return { db: postgresDatabase(pool as unknown as Pool), stats };
}

test(
  '§7.11 concurrent approve and revoke race cleanly on a bounded pool',
  { timeout: 60_000 },
  async (t) => {
    const hosted = loadHostedConfig({
      CITY_HOSTED: '1',
      DATABASE_URL: 'postgresql://db.example.com/staging',
      CITY_PUBLIC_ORIGIN: 'https://city.example.com',
    });
    const pool = boundedPool(await PGlite.create('memory://'));
    const app = await createApp({ hosted, database: pool.db, rateLimiter: 'postgres' });
    t.after(() => app.close());
    const headers = {
      host: 'city.example.com',
      origin: 'https://city.example.com',
      'content-type': 'application/json',
      'x-city-request': '1',
    };
    const call = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { ...headers, cookie },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const account = async (name: string) => {
      const res = await call('', 'POST', '/api/auth/register', {
        name,
        password: 'Synthetic pool race password',
      });
      assert.equal(res.statusCode, 201, res.body);
      return sessionPair(res.cookies);
    };
    const one = await account('Pool requester');
    const two = await account('Pool recipient');
    const agentOf = async (cookie: string, name: string) =>
      (
        await call(cookie, 'POST', '/api/agents', { name, capability: 'research', mode: 'hosted' })
      ).json().agent.id as string;
    const x = await agentOf(one, 'Requester desk');
    const y = await agentOf(two, 'Recipient desk');

    for (let round = 0; round < 4; round++) {
      const token = (await call(two, 'POST', '/api/v2/connections/invites', { agent_id: y })).json()
        .invite_token;
      const requested = await call(one, 'POST', '/api/v2/connections/requests', {
        from_agent_id: x,
        invite_token: token,
        idempotency_key: randomUUID(),
      });
      assert.equal(requested.statusCode, 201, requested.body);
      const id = requested.json().request.id as string;
      // Recipient approves twice while the requester withdraws, all at once (three clients).
      const results = await Promise.all([
        call(two, 'POST', `/api/v2/connections/requests/${id}/decide`, { decision: 'approve' }),
        call(one, 'POST', `/api/v2/connections/requests/${id}/revoke`, {}),
        call(two, 'POST', `/api/v2/connections/requests/${id}/decide`, { decision: 'approve' }),
      ]);
      for (const res of results) assert.ok([200, 409].includes(res.statusCode), res.body);
      // Whatever the order, the connection ends revoked, in one row, and carries nothing.
      const rows = await pool.db.query<{ status: string }>(
        'SELECT status FROM cross_connections WHERE id=$1',
        [id],
      );
      assert.deepEqual(rows.rows, [{ status: 'revoked' }]);
      const sent = await call(one, 'POST', `/api/agents/${x}/messages`, {
        to_agent_id: y,
        text: 'After the race',
        idempotency_key: randomUUID(),
      });
      assert.equal(sent.statusCode, 403, sent.body);
      // The invite was consumed once; a fresh invite is needed for the next round.
    }
    assert.equal(pool.stats.nested, 0, 'no pool acquisition while all clients were held');
    assert.ok(pool.stats.peak <= 3);
    const live = await pool.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM cross_connections WHERE status IN ('pending','approved')",
    );
    assert.equal(live.rows[0]!.n, '0');
  },
);
