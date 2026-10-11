import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { postgresDatabase } from '../server/database.js';
import { createCountLog, CheckpointInProgress } from '../server/count-log/service.js';
import { countLogMigration, countLogCheckpointV2Migration } from '../server/count-log/schema.js';
import {
  countLogPendingMigration,
  countLogPendingBackfillMigration,
} from '../server/count-log/pending.js';
import { cutInstant } from '../shared/count-log/index.js';

// Never uses production DATABASE_URL. Creates and deletes only its own isolated test database.
const url = process.env.CITY_TEST_POSTGRES_URL;
test(
  'real PG: pre-cut writes committed after seal appear next day exactly once',
  { skip: !url, timeout: 30000 },
  async (t) => {
    const name = `city_checkpoint_late_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const pools: pg.Pool[] = [];
    let created = false;
    t.after(async () => {
      try {
        await Promise.all(pools.map((pool) => pool.end()));
        if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const isolated = new URL(url!);
    isolated.pathname = `/${name}`;
    for (let i = 0; i < 2; i++) {
      const pool = new pg.Pool({
        connectionString: isolated.toString(),
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
        lock_timeout: 5000,
      });
      // The forced DROP DATABASE in cleanup ends idle connections; without a handler that error
      // surfaces as an uncaught exception and fails the run.
      pool.on('error', () => {});
      pools.push(pool);
    }
    const db = postgresDatabase(pools[1]);
    await db.exec(
      "CREATE TABLE operators(id text PRIMARY KEY,kind text); CREATE TABLE workspaces(operator_id text PRIMARY KEY,data jsonb); INSERT INTO operators VALUES('one','unclaimed'),('two','unclaimed')",
    );
    await db.exec(countLogMigration.sql);
    await db.exec(countLogCheckpointV2Migration.sql);
    await db.exec(countLogPendingMigration.sql);
    await db.exec(countLogPendingBackfillMigration.sql);
    // Fixture-only deterministic timestamps; no production trigger is modified.
    await db.exec('ALTER TABLE count_log_pending DISABLE TRIGGER count_log_pending_append_only');
    const cut = cutInstant('2026-10-10');
    let now = cut + 30000;
    const log = createCountLog({ db, clock: () => now, log: () => {} });
    const writer = await pools[0].connect();
    writer.on('error', () => {});
    try {
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const readerPid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      assert.notEqual(writerPid, readerPid);
      await writer.query('BEGIN');
      for (const [operator, id] of [
        ['one', 'late-pending'],
        ['two', 'late-fallback'],
      ])
        await writer.query('INSERT INTO workspaces VALUES($1,$2::jsonb)', [
          operator,
          JSON.stringify({ agents: [{ id, createdAt: new Date(cut - 1000).toISOString() }] }),
        ]);
      await writer.query('UPDATE count_log_pending SET recorded_at=$1', [cut - 1000]);
      assert.equal(
        (await writer.query('SELECT * FROM count_log_pending')).rowCount,
        2,
        'both inserts must have exercised the pending recorder',
      );
      // Delete only the fixture row to exercise the missing-feed fallback without table-locking DDL.
      await writer.query("DELETE FROM count_log_pending WHERE agent_id='late-fallback'");
      assert.deepEqual((await writer.query('SELECT agent_id FROM count_log_pending')).rows, [
        { agent_id: 'late-pending' },
      ]);
      assert.equal(
        (await db.query('SELECT * FROM workspaces')).rows.length,
        0,
        'seal session cannot see either uncommitted source row',
      );
      const today = await log.checkpoint({ cut });
      assert.equal(today.checkpoint.tree_size, 0);
      await writer.query('COMMIT');
      assert.equal((await db.query('SELECT * FROM workspaces')).rows.length, 2);
      const retry = await log.checkpoint({ cut });
      assert.equal(retry.created, false);
      assert.equal(retry.checkpoint.hash, today.checkpoint.hash);
      now = cutInstant('2026-10-11') + 30000;
      const tomorrow = await log.checkpoint({ cut: cutInstant('2026-10-11') });
      assert.equal(tomorrow.checkpoint.tree_size, 2);
      assert.equal((await log.checkpoint({ cut: cutInstant('2026-10-11') })).created, false);
      assert.deepEqual(
        (await db.query('SELECT agent_id FROM count_log_leaves ORDER BY agent_id')).rows,
        [{ agent_id: 'late-fallback' }, { agent_id: 'late-pending' }],
      );
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }
  },
);
test(
  'real PG: blocked lock timeout, checkpoint busy, and terminated-holder recovery',
  { skip: !url, timeout: 30000 },
  async (t) => {
    const name = `city_checkpoint_review_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    const isolated = new URL(url!);
    isolated.pathname = `/${name}`;
    const pool = new pg.Pool({
      connectionString: isolated.toString(),
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 8000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 10000,
    });
    pool.on('error', () => {});
    const db = postgresDatabase(pool);
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const holder = await pool.connect();
    holder.on('error', () => {});
    let released = false;
    try {
      await holder.query('BEGIN');
      // Simulate an old holder lacking the idle timeout, bounded by test cleanup.
      await holder.query("SET LOCAL idle_in_transaction_session_timeout = '0'");
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('SELECT pg_advisory_xact_lock(1128485529)');
      const started = Date.now();
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '120s'");
          await tx.query('SELECT pg_advisory_xact_lock(1128485529)');
        }),
        (e: unknown) => e instanceof Error && 'code' in e && e.code === '55P03',
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 4500 && elapsed < 15000, `lock_timeout elapsed ${elapsed}`);
      t.diagnostic(
        `old blocking path: SQLSTATE 55P03 after ${elapsed}ms despite statement_timeout=120s`,
      );
      const begin = Date.now();
      await assert.rejects(
        createCountLog({ db, clock: Date.now }).checkpoint(),
        (e: unknown) => e instanceof CheckpointInProgress && e.busy && e.appended === 0,
      );
      assert.ok(Date.now() - begin < 5000);
      t.diagnostic('current checkpoint service returns busy before table scans');
      // Terminate only our own test holder in this newly created test database.
      const terminated = await pool.query('SELECT pg_terminate_backend($1, 5000) AS ok', [pid]);
      assert.equal(terminated.rows[0]?.ok, true);
      holder.release(true);
      released = true;
      await db.transaction(async (tx) => {
        const result = await tx.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock(1128485529) AS ok',
        );
        assert.equal(result.rows[0]?.ok, true);
      });
      t.diagnostic('terminated holder releases transaction lock; another session acquires it');
    } finally {
      if (!released) {
        await holder.query('ROLLBACK').catch(() => {});
        holder.release(true);
      }
    }
  },
);
