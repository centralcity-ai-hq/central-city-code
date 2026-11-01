import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { registerHistoryRoute } from '../server/base/explorer/history-route.js';
test('history cold empty coverage stays unknown and query is read-only and bounded', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const statements: string[] = [];
  const tx = {
    async query<T>(sql: string) {
      statements.push(sql);
      return { rows: [] as T[] };
    },
    async exec() {},
  };
  const db: Database = {
    ...tx,
    async close() {},
    async transaction(fn) {
      return fn(tx);
    },
  };
  registerHistoryRoute(app, { db });
  assert.equal((await app.inject('/api/public/base/history?fake=1')).statusCode, 400);
  assert.equal(statements.length, 0);
  const response = await app.inject('/api/public/base/history');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().kind, 'observed_counter_snapshots');
  assert.equal(response.json().series.length, 5);
  assert.ok(
    response
      .json()
      .series.every(
        (s: { collectionStart: null; observedHours: number }) =>
          s.collectionStart === null && s.observedHours === 0,
      ),
  );
  assert.equal(statements[0], 'SET TRANSACTION READ ONLY');
  assert.equal(statements[1], 'SET LOCAL statement_timeout = 2000');
});
test('history read failure returns unavailable instead of an empty successful chart', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const db = {
    async transaction() {
      throw new Error('offline');
    },
  } as unknown as Database;
  registerHistoryRoute(app, { db });
  const response = await app.inject('/api/public/base/history');
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'history_unavailable');
});
