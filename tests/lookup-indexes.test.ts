import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createApp } from '../server/app.js';
import { indexState, prebuildIndexes } from '../server/concurrent-index.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import {
  GUARD_ROWS,
  RESERVATION_AUDIT_INDEXES,
  RESERVATION_AUDIT_INDEXES_SQL,
} from '../server/base/lookup-indexes-schema.js';
import { unavailableAmount } from '../server/base/chain/reservations.js';
import { calendarSpent, periodAllowanceInFlight } from '../server/base/chain/calendar-limit.js';
import {
  AGENT_PAY_AUDIT_ONCE_SQL,
  AGENT_PAY_STORED_SQL,
} from '../server/base/payments/agent-pay.js';
import type { Address } from '../shared/base/chains.js';

/*
 * MPR1-01: the three reservation reads under the wallet row lock (unavailableAmount,
 * calendarSpent, periodAllowanceInFlight) and the agent-pay audit look-ups had no index starting
 * with what they filter. Migration 304 adds base_wallet_reservations (wallet_id, lower(token),
 * created_at) and base_audit_events (operator_id, kind, detail->>'paymentId'); the statements
 * themselves are unchanged. Synthetic data only.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-cf-migrations-test-stand-in';
const ORIGIN = 'https://centralcity.ai';
const extensions = { btree_gin, pg_trgm };
const RESERVATIONS_INDEX = 'base_wallet_reservations_wallet_token_created';
const AUDIT_INDEX = 'base_audit_events_payment';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** The same token as an older row may have stored it (checksum case). */
const USDC_MIXED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const WALLETS = 300;
const PER_WALLET = 20;

/** Registers every migration (one hosted app), then returns a database without migration 304. */
async function before304(t: { after: (fn: () => Promise<unknown>) => void }) {
  const builder = await PGlite.create('memory://', { extensions });
  const app = await createApp({
    database: builder,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  await app.close();
  const db = await PGlite.create('memory://', { extensions });
  t.after(async () => (db.closed ? undefined : db.close()));
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version !== 304),
  );
  return db;
}
const query = (db: PGlite) => async (sql: string) =>
  (await db.query(sql)) as { rows: Array<Record<string, unknown>> };

/** Reservations of many wallets (held, consumed, released; both token spellings) and audit events. */
async function seed(db: PGlite, wallets = WALLETS) {
  // Synthetic rows only: foreign keys and the append-only trigger are not the subject here.
  await db.exec("SET session_replication_role = 'replica'");
  await db.query(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, op_id, created_at, updated_at)
     SELECT 'r-' || g, 'w-' || (g % $1), 8453,
       -- k = g / wallets: the row's number within its wallet, so every wallet gets every mix.
       CASE WHEN (g / $1) % 7 = 0 THEN '${ETH}' WHEN (g / $1) % 3 = 0 THEN '${USDC_MIXED}'
         ELSE '${USDC}' END,
       1000 + g, (ARRAY['payment','float','withdrawal','payment'])[1 + (g / $1) % 4], 'h-' || g,
       '0xi', (ARRAY['held','consumed','released','consumed'])[1 + ((g / $1) / 4) % 4], NULL,
       1000000 + g * 1000, 1000000 + g * 1000 + 500
     FROM generate_series(1, $2::int) g`,
    [wallets, wallets * PER_WALLET],
  );
  await db.query(
    `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
     SELECT g, 'agent', 'op-' || (g % 20), 'a-' || g,
       (ARRAY['agent_payment_created','agent_payment_authorized','wallet_created','limit_set'])[1 + g % 4],
       CASE WHEN g % 4 < 2 THEN jsonb_build_object('paymentId', 'p-' || (g / 2)) ELSE '{}'::jsonb END
     FROM generate_series(1, $1::int) g`,
    [wallets * PER_WALLET],
  );
  await db.query(
    `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail) VALUES
       (1, 'agent', 'op-1', 'a-7', 'agent_payment_created', '{"paymentId":"p-10","n":1}'),
       (2, 'agent', 'op-1', 'a-7', 'agent_payment_authorized', '{"paymentId":"p-10","n":2}')`,
  );
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-7', 'a-7', 'op-1', 8453, '0x${'1'.repeat(40)}', '0x${'2'.repeat(40)}',
       '0x${'3'.repeat(40)}', 'v1:k', '{}', 'deployed', 1, 1)`,
  );
  await db.query(
    `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind, source_ref,
       payer_wallet_id, intent_version, intent_hash, idempotency_key, token_address,
       recipient_address, amount, kind, state, created_at, updated_at)
     VALUES ('p-10', 'op-1', 8453, 'agent:a-7', 'agent', 'a-7', 'w-7', 1, '0xi', 'k-10', '${USDC}',
       '0x${'4'.repeat(40)}', 5, 'transfer', 'created', 1, 1)`,
  );
  await db.exec("SET session_replication_role = 'origin'");
  await db.exec('ANALYZE base_wallet_reservations; ANALYZE base_audit_events');
}

type Plans = Array<{ sql: string; plan: string }>;
/** A Queryable that records each statement's plan (EXPLAIN with the same parameters), then runs it. */
function explaining(db: PGlite, plans: Plans) {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      plans.push({ sql, plan });
      return db.query<T>(sql, params) as Promise<{ rows: T[]; affectedRows?: number }>;
    },
  };
}

/** The three reservation reads and the audit look-ups, with their results and plans. */
async function lookups(db: PGlite) {
  const plans: Plans = [];
  const tx = explaining(db, plans) as never;
  const token = USDC as Address;
  const results = {
    unavailable: String(await unavailableAmount(tx, { walletId: 'w-7', token, blockNumber: 100n })),
    calendar: String(
      await calendarSpent(tx, {
        walletId: 'w-7',
        token,
        window: { start: 1_000, end: 100_000 },
        excludeHolderRef: 'h-none',
      }),
    ),
    inFlight: String(
      await periodAllowanceInFlight(tx, {
        walletId: 'w-7',
        chainId: 8453,
        token,
        window: { start: 1_000, end: 100_000 },
        limitCreatedAtMs: 1_000_000,
        chainReadAtMs: 50_000_000,
        excludeHolderRef: 'h-none',
      }),
    ),
    stored: (
      await (tx as ReturnType<typeof explaining>).query(AGENT_PAY_STORED_SQL, [
        'p-10',
        'op-1',
        8453,
      ])
    ).rows,
  };
  const audit = (paymentId: string) =>
    (tx as ReturnType<typeof explaining>).query(AGENT_PAY_AUDIT_ONCE_SQL, [
      1,
      'agent',
      'op-1',
      'a-7',
      'agent_payment_created',
      JSON.stringify({ paymentId }),
      paymentId,
    ]);
  return { results, plans, audit };
}

const reservationPlans = (plans: Plans) =>
  plans.filter(({ sql }) => /FROM base_wallet_reservations\s/.test(sql)).map(({ plan }) => plan);
const auditPlans = (plans: Plans) =>
  plans.filter(({ sql }) => /base_audit_events/.test(sql)).map(({ plan }) => plan);
const uses = (plan: string, name: string) => new RegExp(`(using|on) ${name}\\b`).test(plan);

test('MPR1-01: before migration 304 no reservation read or audit look-up has an index of its own; after it each uses one, with the same results', async (t) => {
  const db = await before304(t);
  await seed(db);
  const before = await lookups(db);
  // Before: the reads walk another index across every wallet (or the table); the audit look-ups
  // read the workspace's events by (operator_id, at) or the whole table.
  assert.equal(reservationPlans(before.plans).length, 3);
  for (const plan of reservationPlans(before.plans)) {
    assert.ok(!uses(plan, RESERVATIONS_INDEX));
    // wallet_id is the third column of the unique key: probed across every wallet's rows.
    assert.match(
      plan,
      /(using|on) base_wallet_reservations_holder_kind_holder_ref_wallet_id_t_key|Seq Scan on base_wallet_reservations/,
    );
  }
  assert.equal(auditPlans(before.plans).length, 1);
  for (const plan of auditPlans(before.plans)) {
    assert.ok(!uses(plan, AUDIT_INDEX));
    assert.match(plan, /(using|on) base_audit_events_operator|Seq Scan on base_audit_events/);
  }
  const auditBefore = [
    (await before.audit('p-10')).affectedRows ?? 0, // already has its created event
    (await before.audit('p-new-1')).affectedRows ?? 0,
    (await before.audit('p-new-1')).affectedRows ?? 0, // a retry adds nothing
  ];

  const result = await runMigrations(db, listMigrations());
  assert.deepEqual(result.applied, [304]);
  for (const index of RESERVATION_AUDIT_INDEXES)
    assert.equal(await indexState(query(db), index.name), 'valid', index.name);
  await db.exec('ANALYZE base_wallet_reservations; ANALYZE base_audit_events');

  const after = await lookups(db);
  assert.deepEqual(after.results, before.results, 'every result is unchanged');
  // The mixed-case rows still count: the index is on lower(token), the form the reads compare.
  assert.notEqual(after.results.unavailable, '0');
  const plans = reservationPlans(after.plans);
  assert.equal(plans.length, 3);
  for (const plan of plans) assert.ok(uses(plan, RESERVATIONS_INDEX), plan);
  for (const plan of plans) assert.doesNotMatch(plan, /Seq Scan on base_wallet_reservations/);
  const auditAfterPlans = auditPlans(after.plans);
  for (const plan of auditAfterPlans) assert.ok(uses(plan, AUDIT_INDEX), plan);
  const auditAfter = [
    (await after.audit('p-10')).affectedRows ?? 0,
    (await after.audit('p-new-2')).affectedRows ?? 0,
    (await after.audit('p-new-2')).affectedRows ?? 0,
  ];
  assert.deepEqual(auditAfter, auditBefore);
  assert.deepEqual(auditAfter, [0, 1, 0]);
  // The audit marker's own NOT EXISTS probe uses the index too.
  const marker = (
    await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${AGENT_PAY_AUDIT_ONCE_SQL}`, [
      1,
      'agent',
      'op-1',
      'a-7',
      'agent_payment_created',
      JSON.stringify({ paymentId: 'p-11' }),
      'p-11',
    ])
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  assert.ok(uses(marker, AUDIT_INDEX), marker);
});

test('MPR1-01: migration 304 never builds on a large table and never fails; the owner script builds CONCURRENTLY', async (t) => {
  const db = await before304(t);
  // More than GUARD_ROWS reservations; few audit events.
  await db.exec("SET session_replication_role = 'replica'");
  await db.query(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, op_id, created_at, updated_at)
     SELECT 'r-' || g, 'w-' || (g % 50), 8453, '${USDC}', 1, 'payment', 'h-' || g, '0xi', 'consumed',
       NULL, g, g FROM generate_series(1, ${GUARD_ROWS + 1}) g`,
  );
  await db.exec("SET session_replication_role = 'origin'");
  const logged: Array<[string, Record<string, number>]> = [];
  const result = await runMigrations(db, listMigrations(), Date.now, true, (event, fields) =>
    logged.push([event, fields]),
  );
  assert.deepEqual(result.applied, [304]);
  assert.equal(await indexState(query(db), RESERVATIONS_INDEX), 'missing');
  assert.equal(await indexState(query(db), AUDIT_INDEX), 'valid');
  assert.deepEqual(logged.find(([event]) => event === 'reservation_audit_lookup_indexes')?.[1], {
    valid: 0,
    build_now: 1,
    left_for_script: 1,
    invalid: 0,
  });

  const statements: string[] = [];
  const run = async (sql: string) => {
    statements.push(sql);
    return query(db)(sql);
  };
  const dry = await prebuildIndexes(run, RESERVATION_AUDIT_INDEXES, { confirm: false });
  assert.deepEqual(
    dry.map((step) => [step.name, step.action]),
    [
      [RESERVATIONS_INDEX, 'would build'],
      [AUDIT_INDEX, 'kept'],
    ],
  );
  assert.equal(statements.filter((sql) => /CREATE|DROP/.test(sql)).length, 0);
  const built = await prebuildIndexes(run, RESERVATION_AUDIT_INDEXES, { confirm: true });
  assert.deepEqual(
    built.map((step) => [step.name, step.action, step.after]),
    [
      [RESERVATIONS_INDEX, 'built', 'valid'],
      [AUDIT_INDEX, 'kept', 'valid'],
    ],
  );
  assert.ok(
    statements
      .filter((sql) => /CREATE INDEX/.test(sql))
      .every((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')),
  );
  // A failed concurrent build leaves its index invalid: the migration leaves it, the script
  // drops and rebuilds it.
  await db.query(
    `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${RESERVATIONS_INDEX}'::regclass`,
  );
  await db.exec(RESERVATION_AUDIT_INDEXES_SQL);
  assert.equal(await indexState(query(db), RESERVATIONS_INDEX), 'invalid');
  statements.length = 0;
  const again = await prebuildIndexes(run, RESERVATION_AUDIT_INDEXES, { confirm: true });
  assert.equal(again[0]!.action, 'rebuilt');
  assert.ok(statements.includes(`DROP INDEX CONCURRENTLY IF EXISTS ${RESERVATIONS_INDEX}`));
  assert.equal(await indexState(query(db), RESERVATIONS_INDEX), 'valid');
  await db.exec(RESERVATION_AUDIT_INDEXES_SQL);
});

test('MPR1-01: the prebuild skips tables this database does not have', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(async () => (db.closed ? undefined : db.close()));
  const steps = await prebuildIndexes(query(db), RESERVATION_AUDIT_INDEXES, { confirm: true });
  assert.deepEqual(
    steps.map((step) => step.action),
    RESERVATION_AUDIT_INDEXES.map(() => 'skipped'),
  );
  await db.exec(RESERVATION_AUDIT_INDEXES_SQL);
});
