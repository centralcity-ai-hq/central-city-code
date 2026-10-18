import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../server/database.js';
import {
  BASE_RATED_AGENTS_SQL,
  BASE_TABLES,
  baseRatedAgentsMigration,
} from '../server/base/schema.js';
import { RATED_AGENTS_SQL } from '../server/base/explorer/store.js';
import { BASE_MAINNET, BASE_SEPOLIA } from '../shared/base/chains.js';
import { add, addRating, setup } from './on-base-fixture.js';

/*
 * Migration 120: base_rated_agents, the rated agents kept as ratings turn final (the Agent
 * Explorer's "Rated agents" number counts it). Ratings from before it are added once; after it,
 * two triggers add a row whenever a rating's operation is final, whichever row changes last.
 */

const rated = async (db: Database, chainId: number = BASE_MAINNET) =>
  Number((await db.query<{ rated: string }>(RATED_AGENTS_SQL, [chainId])).rows[0]!.rated);

const rows = async (db: Database) =>
  (
    await db.query<{ chain_id: number; rated_base_id: string }>(
      'SELECT chain_id, rated_base_id::text FROM base_rated_agents ORDER BY 1, 2',
    )
  ).rows.map((row) => `${row.chain_id}:${row.rated_base_id}`);

const finalOp = (db: Database, key: string, chainId: number = BASE_MAINNET) =>
  db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       block_number, created_at, updated_at) VALUES ($1, $1, '0x00', 'rate', $2, 'final', 2000, 1, 1)`,
    [key, chainId],
  );

test('migration 121: version, table recognized, and every existing final rating added once', async (t) => {
  assert.equal(baseRatedAgentsMigration.version, 121);
  assert.equal(baseRatedAgentsMigration.sql, BASE_RATED_AGENTS_SQL);
  assert.ok(BASE_TABLES.includes('base_rated_agents'));

  const db = await setup(t);
  // The database as it was before migration 121.
  await db.exec(`DROP TABLE base_rated_agents;
    DROP FUNCTION base_rated_agents_from_op() CASCADE;
    DROP FUNCTION base_rated_agents_from_rating() CASCADE;`);
  // The rater's wallet (fixture 1).
  await add(db, { n: 1, kind: 'final', id: 125 });
  const rate = (id: string, baseId: number, more: Record<string, unknown> = {}) =>
    addRating(db, { id, rater: 1, baseId, rated: 1, stars: 4, ...more });
  await rate('a', 120);
  await rate('b', 120, { block: 2001 });
  await rate('c', 121, { status: 'included' });
  await rate('d', 122, { reverted: true });
  await rate('e', 123, { status: 'failed', block: null });
  await rate('f', 124, { status: null });
  await rate('g', 120, { chainId: BASE_SEPOLIA });

  await db.exec(BASE_RATED_AGENTS_SQL);
  assert.deepEqual(await rows(db), ['8453:120', '84532:120']);
  assert.equal(await rated(db), 1);
  assert.equal(await rated(db, BASE_SEPOLIA), 1);
  // Applying it again changes nothing.
  await db.exec(BASE_RATED_AGENTS_SQL);
  assert.deepEqual(await rows(db), ['8453:120', '84532:120']);
});

test('migration 121: a rating counts the moment its operation is final, on any write order', async (t) => {
  const db = await setup(t);
  // The raters' wallets.
  for (let n = 1; n <= 3; n++) await add(db, { n, kind: 'final', id: 140 + n });
  // Signed, not on Base yet; then in a block; then final.
  await addRating(db, { id: 'a', rater: 1, baseId: 130, rated: 1, stars: 5, status: null });
  assert.equal(await rated(db), 0);
  await db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       created_at, updated_at) VALUES ('base-wallet:rate:a', 'base-wallet:rate:a', '0x00', 'rate',
       8453, 'submitted', 1, 1)`,
  );
  await db.query(
    `UPDATE base_chain_ops SET status = 'included' WHERE op_id = 'base-wallet:rate:a'`,
  );
  assert.equal(await rated(db), 0);
  await db.query(`UPDATE base_chain_ops SET status = 'final' WHERE op_id = 'base-wallet:rate:a'`);
  assert.equal(await rated(db), 1);

  // Stored final directly; a second rating of the same agent adds nothing.
  await addRating(db, { id: 'b', rater: 2, baseId: 131, rated: 2, stars: 5 });
  await addRating(db, { id: 'c', rater: 3, baseId: 131, rated: 2, stars: 3 });
  assert.equal(await rated(db), 2);

  // The operation was final before the rating row pointed at it.
  await finalOp(db, 'base-wallet:rate:d');
  await addRating(db, { id: 'd', rater: 1, baseId: 132, rated: 3, stars: 4, status: null });
  assert.equal(await rated(db), 3);

  // Reverted on Base, failed, another kind of operation, another network: not this count.
  await addRating(db, { id: 'e', rater: 1, baseId: 133, rated: 4, stars: 4, reverted: true });
  await addRating(db, { id: 'f', rater: 1, baseId: 134, rated: 5, stars: 4, status: 'failed' });
  await addRating(db, { id: 'g', rater: 1, baseId: 135, rated: 6, stars: 4, chainId: 84532 });
  await db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       created_at, updated_at) VALUES ('x', 'x', '0x00', 'register', 8453, 'final', 1, 1)`,
  );
  assert.equal(await rated(db), 3);
  assert.equal(await rated(db, BASE_SEPOLIA), 1);
  assert.deepEqual(await rows(db), ['8453:130', '8453:131', '8453:132', '84532:135']);
});
