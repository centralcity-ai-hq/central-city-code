import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { transientDatabaseError, postgresDatabase } from '../server/database.js';

function fakePool() {
  const released: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [] }),
    release: (broken?: boolean) => released.push(broken),
  });
  const pool = Object.assign(new EventEmitter(), {
    connect: async () => client,
    query: async () => ({ rows: [] }),
    end: async () => {},
  }) as unknown as Pool;
  return { pool, client, released };
}
const ended = Object.assign(new Error('terminating connection'), { code: '08P01' });

test('a connection the server ends mid-transaction fails that transaction, never the process', async () => {
  const { pool, client, released } = fakePool();
  const db = postgresDatabase(pool);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query('SELECT 1');
      client.emit('error', ended); // throws if nothing listens
      await tx.query('SELECT 2');
    }),
    (error: unknown) => error === ended && transientDatabaseError(error),
  );
  assert.deepEqual(released, [true]);
  assert.equal(client.listenerCount('error'), 0);
});

test('ended after the last statement: the commit does not run on it', async () => {
  const { pool, client, released } = fakePool();
  const db = postgresDatabase(pool);
  await assert.rejects(
    db.transaction(async () => {
      client.emit('error', ended);
    }),
    (error: unknown) => error === ended,
  );
  assert.deepEqual(released, [true]);
});

test('a healthy transaction returns its connection and leaves no listener', async () => {
  const { pool, client, released } = fakePool();
  const db = postgresDatabase(pool);
  assert.equal(await db.transaction(async () => 7), 7);
  assert.deepEqual(released, [false]);
  assert.equal(client.listenerCount('error'), 0);
});
