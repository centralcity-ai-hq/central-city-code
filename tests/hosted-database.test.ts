import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { postgresDatabase } from '../server/database.js';

function fixture(failRollback = false, timeoutOn?: string) {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === timeoutOn) throw new Error('Query read timeout');
      if (sql === 'ROLLBACK' && failRollback) throw new Error('Synthetic broken connection');
      return { rows: [{ value: 1 }] };
    },
    release: (broken: boolean) => releases.push(broken),
  };
  const pool = {
    on: () => {},
    connect: async () => client,
    query: async () => {
      throw new Error('Transaction escaped pinned connection');
    },
    end: async () => {},
  };
  return { db: postgresDatabase(pool as unknown as Pool), queries, releases };
}

test('PostgreSQL transaction commits all work on one client', async () => {
  const f = fixture();
  const value = await f.db.transaction(async (tx) => {
    await tx.query('SELECT test');
    await tx.exec('UPDATE test');
    return 7;
  });
  assert.equal(value, 7);
  assert.deepEqual(f.queries, ['BEGIN', 'SELECT test', 'UPDATE test', 'COMMIT']);
  assert.deepEqual(f.releases, [false]);
});

for (const statement of ['BEGIN', 'SELECT test', 'COMMIT']) {
  test(`read timeout at ${statement} discards the client without queuing rollback`, async () => {
    const f = fixture(false, statement);
    await assert.rejects(
      f.db.transaction((tx) => tx.query('SELECT test')),
      /Query read timeout/,
    );
    assert.equal(f.queries.includes('ROLLBACK'), false);
    assert.deepEqual(f.releases, [true]);
  });
}

test('a swallowed query timeout cannot commit a transaction', async () => {
  const f = fixture(false, 'SELECT test');
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await tx.query('SELECT test').catch(() => undefined);
    }),
    /Query read timeout/,
  );
  assert.deepEqual(f.queries, ['BEGIN', 'SELECT test']);
  assert.deepEqual(f.releases, [true]);
});

test('PostgreSQL transaction rolls back errors and releases its client', async () => {
  const f = fixture();
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await tx.query('UPDATE test');
      throw new Error('Synthetic action failure');
    }),
    /Synthetic action failure/,
  );
  assert.deepEqual(f.queries, ['BEGIN', 'UPDATE test', 'ROLLBACK']);
  assert.deepEqual(f.releases, [false]);
});

test('failed rollback discards the broken connection', async () => {
  const f = fixture(true);
  await assert.rejects(
    f.db.transaction(async () => {
      throw new Error('original');
    }),
    /original/,
  );
  assert.deepEqual(f.releases, [true]);
});
