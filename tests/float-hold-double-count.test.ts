import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOAT_DEBIT_MARGIN_BLOCKS, unavailableAmount } from '../server/base/chain/reservations.js';
import { setup, USDC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * A Feed pay top-up moves USDC from the agent wallet to its own spender. Between the block it is
 * in and its finality its hold is still 'held': a wallet read at or after that block no longer
 * shows the USDC, so the hold must not count as well (it did, refusing calls the wallet covers).
 * Real engine and chain side on PGlite against a fake Base; synthetic data only.
 */

/** One paid call (a final top-up), its hold set back to 'held': as between inclusion and finality. */
async function heldTopUp(f: FeedPayApp) {
  await f.list();
  await f.limit();
  assert.equal((await f.pay()).statusCode, 200);
  const [move] = await f.sql<{ op_key: string; amount_raw: string }>(
    `SELECT op_key, amount_raw::text AS amount_raw FROM feed_pay_float_moves
     WHERE kind = 'top_up' AND state = 'final' LIMIT 1`,
  );
  assert.ok(move, 'a final top-up');
  await f.sql(
    `UPDATE base_wallet_reservations SET state = 'held', op_id = NULL
     WHERE holder_kind = 'float' AND holder_ref = $1`,
    [move!.op_key],
  );
  const [op] = await f.sql<{ block_number: string }>(
    'SELECT block_number::text AS block_number FROM base_chain_ops WHERE idempotency_key = $1',
    [move!.op_key],
  );
  assert.ok(op?.block_number, 'the top-up has a block');
  return { key: move!.op_key, amount: BigInt(move!.amount_raw), block: BigInt(op!.block_number) };
}

const unavailable = (f: FeedPayApp, blockNumber: bigint) =>
  unavailableAmount(f.db, { walletId: f.walletId, token: USDC, blockNumber });

test('a held float hold whose top-up is included well below the read is not counted twice', async (t) => {
  const f = await setup(t);
  const top = await heldTopUp(f);
  for (const status of ['included', 'final']) {
    await f.sql('UPDATE base_chain_ops SET status = $2 WHERE idempotency_key = $1', [
      top.key,
      status,
    ]);
    assert.equal(await unavailable(f, top.block + FLOAT_DEBIT_MARGIN_BLOCKS), 0n, status);
  }
});

test('a held float hold still counts when the read is too close to its block, before it, after a reorg or on a revert', async (t) => {
  const f = await setup(t);
  const top = await heldTopUp(f);
  await f.sql("UPDATE base_chain_ops SET status = 'final' WHERE idempotency_key = $1", [top.key]);
  // Within the reorg margin, and a read before the block.
  assert.equal(await unavailable(f, top.block + FLOAT_DEBIT_MARGIN_BLOCKS - 1n), top.amount);
  assert.equal(await unavailable(f, top.block - 1n), top.amount);
  // Dropped by a reorg: it counts again.
  await f.sql(
    "UPDATE base_chain_ops SET status = 'reorged', error_code = 'RECEIPT_GONE' WHERE idempotency_key = $1",
    [top.key],
  );
  assert.equal(await unavailable(f, top.block + 100n), top.amount);
  // Reverted (an error code): the USDC never left, it counts.
  await f.sql(
    "UPDATE base_chain_ops SET status = 'final', error_code = 'REVERTED' WHERE idempotency_key = $1",
    [top.key],
  );
  assert.equal(await unavailable(f, top.block + 100n), top.amount);
  // Still in flight (no block yet): it counts.
  await f.sql(
    "UPDATE base_chain_ops SET status = 'submitted', error_code = NULL, block_number = NULL WHERE idempotency_key = $1",
    [top.key],
  );
  assert.equal(await unavailable(f, top.block + 100n), top.amount);
});

test('an included top-up not final yet stops counting only past the reorg margin', async (t) => {
  const f = await setup(t);
  const top = await heldTopUp(f);
  await f.sql("UPDATE base_chain_ops SET status = 'included' WHERE idempotency_key = $1", [
    top.key,
  ]);
  assert.equal(await unavailable(f, top.block + FLOAT_DEBIT_MARGIN_BLOCKS - 1n), top.amount);
  assert.equal(await unavailable(f, top.block + FLOAT_DEBIT_MARGIN_BLOCKS), 0n);
  // Included with an error (reverted): the USDC never left, it counts.
  await f.sql("UPDATE base_chain_ops SET error_code = 'REVERTED' WHERE idempotency_key = $1", [
    top.key,
  ]);
  assert.equal(await unavailable(f, top.block + 100n), top.amount);
});

test('only float holds are affected: another holder kind with the same op key still counts', async (t) => {
  const f = await setup(t);
  const top = await heldTopUp(f);
  await f.sql(
    "UPDATE base_wallet_reservations SET holder_kind = 'withdrawal' WHERE holder_kind = 'float' AND holder_ref = $1",
    [top.key],
  );
  assert.equal(await unavailable(f, top.block + 100n), top.amount);
});
