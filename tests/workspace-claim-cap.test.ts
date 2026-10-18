import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';

/**
 * The per-person cap of 50 co-owned AI workspaces holds when two claims of the same person run at
 * once: each claim locks the person before it counts their links, so a second claim waits and
 * sees the first one's link. Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

test('two concurrent claims never take a person past 50 co-owned AI workspaces', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  // Every statement run inside a transaction, in order.
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const transaction = db.transaction.bind(db);
  db.transaction = (action) =>
    transaction((tx) =>
      action({
        ...tx,
        query: ((sql: string, params?: unknown[]) => {
          statements.push({ sql, params });
          return tx.query(sql, params);
        }) as typeof tx.query,
      }),
    );

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Cap person', password: 'Synthetic cap person password' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const person = (
    await db.query<{ id: string }>("SELECT id FROM operators WHERE name = 'Cap person'")
  ).rows[0]!.id;
  // 49 co-owned AI workspaces already: one more fits, a second does not.
  for (let i = 0; i < 49; i++) {
    const id = `cap-filler-${i}`;
    await db.query(
      "INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES($1,$1,$1,'x','x')",
      [id],
    );
    await db.query(
      "INSERT INTO operator_links(human_operator_id,ai_operator_id,role,created_at) VALUES($1,$2,'co-owner',0)",
      [person, id],
    );
  }
  const tokens: string[] = [];
  for (const [i, name] of ['Cap AI one', 'Cap AI two'].entries()) {
    const created = await app.inject({
      method: 'POST',
      url: '/api/public/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
      remoteAddress: `198.51.100.${10 + i}`,
    });
    assert.equal(created.statusCode, 201, created.body);
    tokens.push(created.json().claim_token);
  }

  statements.length = 0;
  const claims = await Promise.all(
    tokens.map((token) =>
      app.inject({
        method: 'POST',
        url: '/api/workspaces/claim',
        headers: { ...jsonHeaders, cookie },
        payload: JSON.stringify({ claim_token: token }),
      }),
    ),
  );
  assert.deepEqual(claims.map((res) => res.statusCode).sort(), [200, 409]);
  const links = await db.query<{ n: string | number }>(
    'SELECT count(*) AS n FROM operator_links WHERE human_operator_id=$1',
    [person],
  );
  assert.equal(Number(links.rows[0]!.n), 50);

  // Each claim takes the person's lock before it counts: on PostgreSQL with a real pool the two
  // would otherwise both count 49 and both insert.
  const lock = statements.findIndex(
    (s) => /pg_advisory_xact_lock/.test(s.sql) && s.params?.[0] === `ws-claim:${person}`,
  );
  const count = statements.findIndex((s) => /count\(\*\) AS n FROM operator_links/.test(s.sql));
  assert.ok(lock >= 0, 'the claim never locks the person');
  assert.ok(lock < count, 'the claim counts before it locks the person');
});
