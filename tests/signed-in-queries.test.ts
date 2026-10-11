import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { elricFixture } from './elric-fixture.js';
import { createApp } from '../server/app.js';
import type { Database, Transaction } from '../server/database.js';
import { elricEligibility } from '../server/elric/access.js';
import { dayOf, resetAt, ELRIC_CONFIG } from '../server/elric/config.js';
import { ELRIC_WAKING_TEXT, elricLimitNotice } from '../server/elric/service.js';
import { iso } from '../server/model.js';
import { listMigrations, runMigrations } from '../server/migrations.js';

/*
 * The signed-in polls (GET /api/snapshot, GET /api/elric) and the cold start read the database in
 * fewer round trips. These tests pin both the answers (the same as the previous, one-query-per-
 * value code) and the number of round trips. Synthetic data only.
 */

type Kind = 'short' | 'summary' | 'tool';

/** GET /api/elric as it was computed before: one query per value, in this order. */
async function referenceStatus(db: Database, ownerId: string, time: number) {
  const day = dayOf(time);
  const usageRow = (
    await db.query<{ short: number; summary: number; tool: number }>(
      'SELECT short,summary,tool FROM elric_usage WHERE owner_id=$1 AND day=$2',
      [ownerId, day],
    )
  ).rows[0];
  const usage = {
    day,
    used: {
      short: usageRow?.short ?? 0,
      summary: usageRow?.summary ?? 0,
      tool: usageRow?.tool ?? 0,
    },
    allowance: { ...ELRIC_CONFIG.allowance },
    resets_at: iso(resetAt(time)),
  };
  const own = (
    await db.query<{ agent_id: string; status: 'active' | 'paused'; host_may_invoke: boolean }>(
      "SELECT agent_id,status,host_may_invoke FROM elric_agents WHERE owner_id=$1 AND status <> 'revoked'",
      [ownerId],
    )
  ).rows[0];
  const waking = (
    await db.query<{ room_id: string; source_seq: string | number; waking_since: string }>(
      `SELECT room_id, source_seq, waking_since FROM elric_invocations
        WHERE owner_id=$1 AND waking_since IS NOT NULL
          AND (status='queued' OR (status='running' AND locked_until > $2))
        ORDER BY waking_since LIMIT 20`,
      [ownerId, time],
    )
  ).rows;
  const eligibility = await elricEligibility(db, ownerId, time);
  return {
    agent_id: own?.agent_id ?? null,
    status: own?.status ?? null,
    host_may_invoke: own?.host_may_invoke ?? false,
    eligible: eligibility.eligible,
    eligibility_reason: eligibility.eligible ? null : eligibility.reason,
    usage,
    limit_notices: (Object.keys(usage.used) as Kind[])
      .filter((kind) => usage.used[kind] >= usage.allowance[kind])
      .map((kind) => elricLimitNotice('owner_allowance', kind)),
    waking: waking.map((row) => ({
      room_id: row.room_id,
      source_seq: Number(row.source_seq),
      since: iso(Number(row.waking_since)),
      text: ELRIC_WAKING_TEXT,
    })),
  };
}

/** Counts the statements a database runs (BEGIN and COMMIT of a transaction included). */
function counting(inner: Database) {
  const counter = { statements: [] as string[] };
  const wrap = (q: Transaction): Transaction => ({
    query: (sql, params) => {
      counter.statements.push(sql);
      return q.query(sql, params);
    },
    exec: (sql) => {
      counter.statements.push(sql);
      return q.exec(sql);
    },
  });
  const db: Database = {
    ...wrap(inner),
    transaction: async (action) => {
      counter.statements.push('BEGIN');
      const result = await inner.transaction((tx) => action(wrap(tx)));
      counter.statements.push('COMMIT');
      return result;
    },
    close: () => inner.close(),
  };
  return { db, counter };
}

test('GET /api/elric answers exactly as the one-query-per-value code did, in every state', async (t) => {
  const f = await elricFixture(t);
  const time = Date.UTC(2026, 8, 30, 12, 0, 0);
  const check = async (ownerId: string, label: string) => {
    assert.deepEqual(
      await f.elric.status(ownerId),
      await referenceStatus(f.db, ownerId, time),
      label,
    );
  };
  // No operator, an AI-owned operator, a fresh person (no Google identity).
  await check('00000000-0000-4000-8000-000000000000', 'unknown operator');
  await f.db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt,kind) VALUES('ai-op','AI op','ai-op','x','x','ai')",
  );
  await check('ai-op', 'AI operator');
  const owner = await f.account('Equal Eve');
  await check(owner.operatorId, 'unverified');
  // Verified, then no date of birth, then adult with Elric.
  await f.db.query(
    `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,verified_at,created_at)
     VALUES($1,'google','sub-eve','eve@example.com',true,$2,$2)`,
    [owner.operatorId, time],
  );
  await check(owner.operatorId, 'age unknown');
  const adult = await f.account('Equal Ada');
  await f.verify(adult);
  await check(adult.operatorId, 'eligible, no Elric');
  const elricId = await f.addElric(adult);
  await check(adult.operatorId, 'eligible, Elric active');
  // Usage at and below the allowance, and waking invocations (one expired, one done).
  await f.db.query(
    `INSERT INTO elric_usage(owner_id,day,short,summary,tool) VALUES($1,$2,$3,1,$4)
     ON CONFLICT (owner_id,day) DO UPDATE SET short=EXCLUDED.short, summary=1, tool=EXCLUDED.tool`,
    [adult.operatorId, dayOf(time), ELRIC_CONFIG.allowance.short, ELRIC_CONFIG.allowance.tool],
  );
  for (const [seq, status, lockedUntil, since] of [
    [1, 'queued', null, time - 3000],
    [2, 'running', time + 60_000, time - 5000],
    [3, 'running', time - 1, time - 4000],
    [4, 'done', null, time - 2000],
    [5, 'queued', null, null],
  ] as const)
    await f.db.query(
      `INSERT INTO elric_invocations(agent_id,room_id,source_seq,owner_id,invoker_member_id,
         invoker_kind,status,locked_until,created_at,waking_since)
       VALUES($1,'room-eq',$2,$3,'m','owner',$4,$5,$6,$7)`,
      [elricId, seq, adult.operatorId, status, lockedUntil, time - 10_000, since],
    );
  const withWaking = await f.elric.status(adult.operatorId);
  assert.deepEqual(
    withWaking.waking.map((item) => item.source_seq),
    [2, 1],
  );
  assert.equal(withWaking.limit_notices.length, 2);
  await check(adult.operatorId, 'usage and waking');
  await f.call(adult.cookie, 'POST', '/api/elric/pause');
  await check(adult.operatorId, 'paused');
  // Under 18 (locked) and revoked.
  await f.db.query('UPDATE elric_age_checks SET locked_at=$2 WHERE operator_id=$1', [
    adult.operatorId,
    time,
  ]);
  await check(adult.operatorId, 'locked');
  await f.call(adult.cookie, 'POST', '/api/elric/revoke');
  await check(adult.operatorId, 'revoked');
  // The route answers the same body.
  const res = await f.call(adult.cookie, 'GET', '/api/elric');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), await referenceStatus(f.db, adult.operatorId, time));
});

test('expired sessions are found by the expiry index, not a scan of every session', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db as Database;
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES('s-op','S op','s-op','x','x')`,
  );
  await db.query(
    `INSERT INTO sessions(token_hash,operator_id,expires_at,created_at)
     SELECT 'tok'||g, 's-op', 1000000 + g, g FROM generate_series(1, 20000) g`,
  );
  await db.query('ANALYZE sessions');
  const plan = (
    await db.query<{ 'QUERY PLAN': string }>(
      'EXPLAIN SELECT token_hash FROM sessions WHERE expires_at<=1000010 LIMIT 1000',
    )
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  assert.match(plan, /sessions_expiry/);
  assert.doesNotMatch(plan, /Seq Scan on sessions/);
});

test('hosted polls: snapshot in 2 reads plus rate limits, Elric status in 2, start-up in 1', async (t) => {
  process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-signed-in-queries-root-secret';
  const pglite = await PGlite.create('memory://', { extensions: { btree_gin } });
  const { db, counter } = counting(pglite as unknown as Database);
  const options = {
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
    elric: { enabled: true, autoDrain: false },
  } as const;
  // The first instance migrates; the second starts on a current schema.
  const setup = await createApp({ ...options, database: { ...db, close: async () => {} } });
  await setup.ready();
  await setup.close();
  counter.statements = [];
  const app = await createApp({ ...options, database: db });
  t.after(() => app.close());
  await app.ready();
  assert.deepEqual(counter.statements, ['SELECT version,name,checksum FROM schema_migrations']);

  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: 'centralcity.ai',
    origin: 'https://centralcity.ai',
  };
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { name: 'Round Trip Rita', password: 'Synthetic round trip password' },
    remoteAddress: '203.0.113.9',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...headers, cookie },
    payload: {
      name: 'Round trip agent',
      description: 'x',
      capability: 'research',
      mode: 'external',
    },
    remoteAddress: '203.0.113.9',
  });
  assert.equal(created.statusCode, 201, created.body);
  const get = async (url: string) => {
    counter.statements = [];
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { ...headers, cookie },
      remoteAddress: '203.0.113.9',
    });
    assert.equal(res.statusCode, 200, res.body);
    // Rate-limit hits (per address and, since per-principal limits, per account) are the
    // limiter's own and not counted here; the assertions are about the endpoint's reads.
    return {
      body: res.json(),
      statements: counter.statements.filter((sql) => !sql.includes('rate_limits')),
    };
  };
  // The first poll of an instance also runs the expiry sweep (3 more round trips, was 6).
  const first = await get('/api/snapshot');
  assert.equal(first.statements.length, 5, first.statements.join('\n'));
  const warm = await get('/api/snapshot');
  assert.equal(warm.statements.length, 2, warm.statements.join('\n'));
  assert.ok(!warm.statements.includes('BEGIN'), 'no locked tick when nothing advances');
  assert.equal(warm.body.agents.length, 1);
  assert.equal(warm.body.agents[0].name, 'Round trip agent');
  const elric = await get('/api/elric');
  assert.equal(elric.statements.length, 2, elric.statements.join('\n'));
  assert.equal(elric.body.eligibility_reason, 'unverified');
});

test('start-up still applies a pending migration and refuses an unknown one', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  const all = listMigrations().filter((migration) => migration.version < 10);
  await runMigrations(db, all.slice(0, -1));
  // One pending: the fast path declines and the locked path applies it.
  assert.deepEqual((await runMigrations(db, all)).applied, [all.at(-1)!.version]);
  assert.deepEqual((await runMigrations(db, all)).applied, []);
  // The database has a version this build lacks: refused, as before.
  await assert.rejects(runMigrations(db, all.slice(0, -1)), /unknown to this build/);
});
