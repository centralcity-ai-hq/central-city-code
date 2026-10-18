import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { feedServiceDetail, feedStatus, searchFeedServices } from '../server/feed/query.js';
import {
  FEED_OPERATOR_HIDES_SQL,
  feedOperatorHidesMigration,
  feedServicesMigration,
} from '../server/feed/services-schema.js';
import { FEED_OFFERS_SQL } from '../server/feed/offers/schema.js';
import { createFeedStore } from '../server/feed/store.js';
import { BAZAAR_SOURCE, type FeedServiceRow } from '../server/feed/types.js';
import { runMigrations } from '../server/migrations.js';
import type { FeedRiskCategory, FeedServiceQuery } from '../shared/feed.js';

/*
 * Migration 107 (server/feed/services-schema.ts): `hidden` becomes the operator's own hide and
 * `risky` alone hides for risk. The rows before it are written as the ingestion before it left
 * them (a risky row stored hidden, and a hide that stuck after its rule stopped matching), through
 * the store and a few UPDATEs. In-memory database, made-up, low-entropy data only.
 */

const T0 = Date.parse('2026-10-13T06:00:00Z');
const HOUR = 3_600_000;
const NOW = T0 + HOUR;

async function feedDb(t: { after: (fn: () => Promise<unknown>) => void }): Promise<Database> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  return {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const idOf = (n: number) => `svc_${'a'.repeat(19)}${B32[n]}`;

/** Listing n as ingestion hands it to the store, with the risk the rules of its sweep gave it. */
function rowOf(n: number, risky: FeedRiskCategory | null, fetchedAt: number): FeedServiceRow {
  const url = `https://svc${n}.example.com/api/v1/run`;
  return {
    id: idOf(n),
    recordId: url,
    host: `svc${n}.example.com`,
    url,
    title: `Listing ${n}`,
    description: 'Data for one place.',
    capabilities: ['data'],
    providerName: null,
    method: 'GET',
    x402Version: 2,
    scheme: 'exact',
    priceRaw: '10000',
    payTo: `0x${'1'.repeat(38)}${n.toString(16).padStart(2, '0')}` as FeedServiceRow['payTo'],
    input: null,
    output: null,
    paidCalls30d: n,
    payers30d: null,
    lastCalledAt: null,
    sourceUpdatedAt: null,
    fetchedAt,
    risky,
    searchText: `listing ${n} data for one place. data svc${n}.example.com`,
  };
}

/** One complete sweep of one page through the store. */
async function sweep(db: Database, rows: FeedServiceRow[], now: number) {
  const store = createFeedStore(db);
  const previous = (await store.source(BAZAAR_SOURCE)).sweepId;
  const sweepId = await store.startSweep(BAZAAR_SOURCE, previous, now);
  assert.ok(sweepId !== null);
  const saved = await store.savePage({
    source: BAZAAR_SOURCE,
    sweepId,
    offset: 0,
    next: rows.length,
    total: rows.length,
    services: rows,
    excluded: [],
    complete: true,
    now,
  });
  assert.equal(saved.advanced, true);
  return saved;
}

const ALL = [1, 2, 3, 4, 5, 6, 7];

/**
 * The table as ingestion left it before migration 107: 1 and 6 listed; 2 and 7 risky, so stored
 * hidden; 3 risky and withdrawn (hidden); 4 withdrawn; 5 hidden though no rule matches it any more
 * (a risk hide that stuck after its rule was loosened).
 */
async function seedBefore107(db: Database) {
  await runMigrations(
    db,
    [feedServicesMigration],
    () => T0,
    true,
    () => {},
  );
  // Migration 122's columns (seller_key, the second source's data version), which today's store
  // and reads use; applied outside the ledger, so the runs below see only 104 and 107.
  await db.exec(FEED_OFFERS_SQL);
  const risk: Record<number, FeedRiskCategory | null> = {
    2: 'contact_details',
    3: 'money_mover',
    7: 'prepaid_cards',
  };
  await sweep(
    db,
    ALL.map((n) => rowOf(n, risk[n] ?? null, T0)),
    T0,
  );
  await db.query('UPDATE feed_services SET hidden = true WHERE risky IS NOT NULL OR id = $1', [
    idOf(5),
  ]);
  await db.query('UPDATE feed_services SET withdrawn_at = $1 WHERE id = ANY($2::text[])', [
    T0 + 1,
    [idOf(3), idOf(4)],
  ]);
}

async function listedIds(db: Database, rule: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM feed_services WHERE ${rule} ORDER BY id`,
  );
  return rows.map((row) => row.id);
}
const OLD_RULE = 'withdrawn_at IS NULL AND NOT hidden';
const RULE = 'withdrawn_at IS NULL AND NOT hidden AND risky IS NULL';

const query = (q = ''): FeedServiceQuery => ({
  q,
  maxPrice: null,
  sort: 'most_used',
  host: null,
  cursor: null,
});

/** Everything the Feed answers: the unfiltered list, a search, the Offered count, each detail. */
async function answers(db: Database) {
  const list = await searchFeedServices(db, query(), { limit: 100, now: NOW });
  const search = await searchFeedServices(db, query('listing data'), { limit: 100, now: NOW });
  const details: Array<[number, string | null]> = [];
  for (const n of ALL)
    details.push([n, (await feedServiceDetail(db, idOf(n), NOW))?.service.status ?? null]);
  return {
    list: list.services.map((service) => service.id),
    total: list.total,
    search: search.services.map((service) => service.id),
    offered: (await feedStatus(db, NOW)).services,
    details,
  };
}

async function flags(db: Database) {
  const { rows } = await db.query<{ id: string; hidden: boolean; risky: string | null }>(
    'SELECT id, hidden, risky FROM feed_services ORDER BY id',
  );
  return rows;
}

test('migration 107 clears risk hides, keeps the rest hidden, and lists exactly the same rows', async (t) => {
  const db = await feedDb(t);
  await seedBefore107(db);
  const listedBefore = await listedIds(db, OLD_RULE);
  assert.deepEqual(listedBefore, [idOf(1), idOf(6)]);
  // Before 107 the two rules agree: every risky row is hidden.
  assert.deepEqual(await listedIds(db, RULE), listedBefore);
  const before = await answers(db);
  assert.deepEqual(before, {
    list: [idOf(6), idOf(1)],
    total: 2,
    search: [idOf(6), idOf(1)],
    offered: 2,
    details: [
      [1, 'active'],
      [2, null],
      [3, null],
      [4, 'withdrawn'],
      [5, null],
      [6, 'active'],
      [7, null],
    ],
  });

  const reports: Array<[string, Record<string, number>]> = [];
  const applied = await runMigrations(
    db,
    [feedServicesMigration, feedOperatorHidesMigration],
    () => NOW,
    true,
    (event, fields) => void reports.push([event, fields]),
  );
  assert.deepEqual(applied.applied, [107]);
  // Counts only: the risk hides it cleared and the hidden rows with no risk it kept.
  assert.deepEqual(reports, [['feed.migration107', { risk_hides_cleared: 3, hidden_kept: 1 }]]);
  assert.deepEqual(await flags(db), [
    { id: idOf(1), hidden: false, risky: null },
    { id: idOf(2), hidden: false, risky: 'contact_details' },
    { id: idOf(3), hidden: false, risky: 'money_mover' },
    { id: idOf(4), hidden: false, risky: null },
    // Kept hidden: never more public than before (only the operator clears it).
    { id: idOf(5), hidden: true, risky: null },
    { id: idOf(6), hidden: false, risky: null },
    { id: idOf(7), hidden: false, risky: 'prepaid_cards' },
  ]);

  // The listed rows are exactly the same right after: through the rule, through a process that
  // starts after the migration (no cache yet) and one that cached its answers before it.
  assert.deepEqual(await listedIds(db, RULE), listedBefore);
  assert.deepEqual(await answers({ ...db }), before);
  assert.deepEqual(await answers(db), before);

  // Idempotent: the ledger applies it once, and its SQL run again changes nothing.
  const changed = await flags(db);
  assert.deepEqual(
    (await runMigrations(db, [feedServicesMigration, feedOperatorHidesMigration])).applied,
    [],
  );
  await db.exec(FEED_OPERATOR_HIDES_SQL);
  assert.deepEqual(await flags(db), changed);
  assert.deepEqual(await answers({ ...db }), before);
});

test('after migration 107 the next sweep lists a listing whose rule was loosened; other hides stay', async (t) => {
  const db = await feedDb(t);
  await seedBefore107(db);
  await runMigrations(
    db,
    [feedServicesMigration, feedOperatorHidesMigration],
    () => NOW,
    true,
    () => {},
  );
  // The next sweep: 2's rule was loosened (a product decision), 7 still matches, 3 and 4 are back.
  await sweep(
    db,
    ALL.map((n) => rowOf(n, n === 7 ? 'prepaid_cards' : null, NOW)),
    NOW,
  );
  assert.deepEqual(await listedIds(db, RULE), [idOf(1), idOf(2), idOf(3), idOf(4), idOf(6)]);
  const after = await answers({ ...db });
  assert.equal(after.offered, 5);
  assert.equal(after.total, 5);
  assert.deepEqual(
    after.details.filter(([, status]) => status === null).map(([n]) => n),
    [5, 7],
  );
  assert.equal((await createFeedStore(db).source(BAZAAR_SOURCE)).listed, 5);
  // 5 stays hidden although no rule matches it: the migration kept it for the operator.
  assert.deepEqual(
    (await flags(db)).filter((row) => row.hidden).map((row) => row.id),
    [idOf(5)],
  );
});

test('migration 107 on a new database: nothing to clear', async (t) => {
  const db = await feedDb(t);
  const reports: Array<[string, Record<string, number>]> = [];
  const applied = await runMigrations(
    db,
    [feedServicesMigration, feedOperatorHidesMigration],
    () => T0,
    true,
    (event, fields) => void reports.push([event, fields]),
  );
  assert.deepEqual(applied.applied, [104, 107]);
  assert.deepEqual(reports, [['feed.migration107', { risk_hides_cleared: 0, hidden_kept: 0 }]]);
  // Data only: no table, column or index is created, altered or dropped.
  assert.doesNotMatch(FEED_OPERATOR_HIDES_SQL, /\b(CREATE|ALTER|DROP|DELETE|TRUNCATE)\b/i);
});
