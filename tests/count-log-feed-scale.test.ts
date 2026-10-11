import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.js';
import { CheckpointInProgress, createCountLog } from '../server/count-log/index.js';
import { FEED_LIMITS, pendingFeed, type FeedEntry } from '../server/count-log/pending.js';
import type { Database } from '../server/database.js';

/*
 * The live log's feed at scale: the head page numbers only the newest pending entries and bounds
 * its pending count to the days since the latest checkpoint, and every page publishes exactly the
 * numbers (`n`) and live total (`total_now`) that the original whole-table ranking published.
 * Synthetic data only.
 */

const DAY = 86_400_000;

/** count one-agent partitions, created from `start`, one second apart. */
async function seed(db: Database, from: number, count: number, start: number) {
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
      SELECT 'op'||g, 'Op '||g, 'op'||g, 'x', 'x', 'unclaimed' FROM generate_series($1::int,$2::int) g`,
    [from, from + count - 1],
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
      SELECT 'op'||g, jsonb_build_object('agents', jsonb_build_array(jsonb_build_object(
        'id', 'agent-'||lpad(g::text,8,'0'), 'name', 'A'||g,
        'createdAt', to_char(to_timestamp(($3::bigint + (g-$1) * 1000) / 1000.0) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
      FROM generate_series($1::int,$2::int) g`,
    [from, from + count - 1, start],
  );
}

/** The original ranking: row_number over every pending entry, by fingerprint. */
async function legacy(db: Database, excluded: string[]) {
  const latest = (
    await db.query<{ date: string; tree_size: number; withdrawn: number }>(
      'SELECT date, tree_size, withdrawn FROM count_log_checkpoints ORDER BY date DESC LIMIT 1',
    )
  ).rows[0];
  const where = `NOT EXISTS (SELECT 1 FROM count_log_leaves l
        WHERE l.agent_id = p.agent_id AND l.idx < $3::int)
      AND NOT (p.operator_id = ANY($1::text[]))
      AND ($2::text IS NULL OR p.created_day >= $2)`;
  const params = [excluded, latest?.date ?? null, latest?.tree_size ?? 0];
  const ranks = (
    await db.query<{ leaf_hash: Buffer; rank: string | number }>(
      `SELECT p.leaf_hash, row_number() OVER (ORDER BY p.created_minute, COALESCE(p.created_ms, -1), p.seq) - 1 AS rank
         FROM count_log_pending p WHERE ${where}`,
      params,
    )
  ).rows;
  const pending = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM count_log_pending p WHERE ${where}`,
        params,
      )
    ).rows[0]!.n,
  );
  return {
    n: new Map(
      ranks.map((row) => [
        Buffer.from(row.leaf_hash).toString('hex'),
        Number(latest?.tree_size ?? 0) + Number(row.rank),
      ]),
    ),
    totalNow: (latest ? Number(latest.tree_size) - Number(latest.withdrawn) : 0) + pending,
  };
}

async function allPages(db: Database, excluded: string[], limit: number, upTo = Infinity) {
  const entries: FeedEntry[] = [];
  const totals = new Set<number>();
  let before: string | undefined;
  for (;;) {
    const page = await pendingFeed(db, { excluded, limit, before });
    entries.push(...page.entries);
    totals.add(page.total_now);
    if (!page.next || entries.length >= upTo) break;
    before = page.next;
  }
  return { entries, totals };
}

test('the feed publishes the original numbers and total at 30,000 agents, and its head is fast', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db as Database;
  const now = Date.now();
  const excluded = ['op29990'];
  // 21,000 agents three days ago, confirmed by the checkpoint two days ago.
  await seed(db, 1, 21_000, now - 3 * DAY);
  const log = createCountLog({ db, clock: () => now - 2 * DAY, excludedOperators: excluded });
  for (;;)
    try {
      await log.checkpoint();
      break;
    } catch (error) {
      if (!(error instanceof CheckpointInProgress)) throw error;
    }
  // Created on a day before that checkpoint but recorded after it: left behind (removed).
  // One hour before the checkpoint's UTC day, at any time of day the test runs.
  await seed(db, 21_001, 200, Math.floor((now - 2 * DAY) / DAY) * DAY - 3_600_000);
  // 8,800 pending agents since: yesterday and the last hours, one of them excluded.
  await seed(db, 21_201, 4_000, now - DAY);
  await seed(db, 25_201, 4_800, now - 4 * 3_600_000);
  await db.query('ANALYZE');

  const expected = await legacy(db, excluded);
  assert.equal(expected.n.size, 8_799);
  const { entries, totals } = await allPages(db, excluded, FEED_LIMITS.max);
  assert.equal(entries.length, 30_000 - 1);
  assert.deepEqual([...totals], [expected.totalNow]);
  assert.equal(expected.totalNow, 21_000 + 8_799);
  let pending = 0;
  for (const entry of entries) {
    if (entry.status === 'pending') {
      pending++;
      assert.equal(entry.n, expected.n.get(entry.fingerprint), entry.fingerprint);
    } else assert.equal(entry.n, undefined);
  }
  assert.equal(pending, expected.n.size);
  assert.equal(entries.filter((entry) => entry.status === 'removed').length, 200);
  // Small pages and the default page agree with the large ones.
  const small = await allPages(db, excluded, 7, 500);
  assert.deepEqual(small.entries.slice(0, 500), entries.slice(0, 500));

  // The head page (what the live log polls every 3 s): numbered from about one page of rows.
  await pendingFeed(db, { excluded });
  const started = performance.now();
  const head = await pendingFeed(db, { excluded });
  const elapsed = performance.now() - started;
  t.diagnostic(`feed head page at 30,000 agents (8,799 pending): ${Math.round(elapsed)} ms`);
  assert.equal(head.entries.length, FEED_LIMITS.default);
  assert.equal(head.entries[0]!.n, 21_000 + 8_799 - 1);
  assert.ok(elapsed < 1_000, `took ${elapsed} ms`);
});
