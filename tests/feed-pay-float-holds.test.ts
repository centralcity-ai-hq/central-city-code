import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { createFeedPayEngine } from '../server/feed/pay/engine.js';
import { setup, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed pay float holds that nothing visited again: the recovery cron settles pending float moves
 * least recently checked first (migration 241), and ends float holds left 'held' whose move is no
 * longer pending, by the same rules as a pending move. Real routes, engine and chain side on PGlite
 * against a fake Base; synthetic data only.
 */

/** An engine on the fixture's database with a clock that stands still at `at`. */
function engineAt(f: FeedPayApp, at: number) {
  return createFeedPayEngine({
    db: f.db,
    env: process.env,
    now: () => at,
    chain: async () => f.base.chainFor(() => f.db),
    sleep: async () => {},
  });
}

/** One paid call, so the wallet has a final top-up (its move and its consumed float hold). */
async function finalTopUp(f: FeedPayApp) {
  await f.list();
  await f.limit();
  assert.equal((await f.pay()).statusCode, 200);
  const [move] = await f.sql<{ move_id: string; op_key: string }>(
    `SELECT move_id, op_key FROM feed_pay_float_moves WHERE kind = 'top_up' AND state = 'final'
     LIMIT 1`,
  );
  assert.ok(move, 'a final top-up');
  return move!;
}

test('pending moves are settled least recently checked first: a backlog of waiting moves never blocks a newer one', async (t) => {
  const f = await setup(t);
  const move = await finalTopUp(f);
  const at = f.clock();
  // 30 moves that keep waiting: planned, no operation yet, still inside the grace.
  const [row] = await f.sql<{ m: Record<string, unknown> }>(
    'SELECT to_jsonb(m) AS m FROM feed_pay_float_moves m WHERE move_id = $1',
    [move.move_id],
  );
  for (let i = 0; i < 30; i++) {
    const key = `feed-pay:top-up:${randomUUID()}`;
    await f.sql(
      `INSERT INTO feed_pay_float_moves
       SELECT * FROM jsonb_populate_record(NULL::feed_pay_float_moves, $1::jsonb)`,
      [
        JSON.stringify({
          ...row!.m,
          move_id: randomUUID(),
          op_key: key,
          intent_hash: keccak256(stringToHex(key)),
          state: 'pending',
          tx_hash: null,
          call_id: null,
          checked_at: 0,
          created_at: at - 1_000 - i,
          updated_at: at - 1_000 - i,
        }),
      ],
    );
  }
  // The newer move: its top-up is final on Base, recorded as still pending.
  await f.sql(
    `UPDATE feed_pay_float_moves SET state = 'pending', checked_at = 0, updated_at = $2
     WHERE move_id = $1`,
    [move.move_id, at],
  );
  const engine = engineAt(f, at);
  await engine.recover();
  await engine.recover();
  const [after] = await f.sql<{ state: string }>(
    'SELECT state FROM feed_pay_float_moves WHERE move_id = $1',
    [move.move_id],
  );
  assert.equal(after!.state, 'final', 'the second run reached the move behind the 30 waiting ones');
  const [{ n }] = await f.sql<{ n: string }>(
    "SELECT count(*)::text AS n FROM feed_pay_float_moves WHERE state = 'pending'",
  );
  assert.equal(n, '30', 'the waiting moves (inside the grace) are left as they are');
});

test('a float hold left held after its top-up is final is consumed by the cron', async (t) => {
  const f = await setup(t);
  const move = await finalTopUp(f);
  const at = f.clock() + 5 * 60_000;
  // As if the final settlement of the hold never ran: the move ended, its hold still 'held'.
  await f.sql(
    `UPDATE base_wallet_reservations SET state = 'held', op_id = NULL, updated_at = $2
     WHERE holder_kind = 'float' AND holder_ref = $1`,
    [move.op_key, at - 2 * 60_000],
  );
  const result = await engineAt(f, at).recover();
  assert.equal(result.holds, 1, JSON.stringify(result));
  const [hold] = await f.sql<{ state: string }>(
    "SELECT state FROM base_wallet_reservations WHERE holder_kind = 'float' AND holder_ref = $1",
    [move.op_key],
  );
  assert.equal(hold!.state, 'consumed');
});

test('a float hold whose key never got an operation is fenced and released past the grace, never before', async (t) => {
  const f = await setup(t);
  const move = await finalTopUp(f);
  const [held] = await f.sql<{ r: Record<string, unknown> }>(
    "SELECT to_jsonb(r) AS r FROM base_wallet_reservations r WHERE holder_kind = 'float' AND holder_ref = $1",
    [move.op_key],
  );
  const key = `feed-pay:top-up:${randomUUID()}`;
  const at = f.clock() + 5 * 60_000;
  await f.sql(
    `INSERT INTO base_wallet_reservations
     SELECT * FROM jsonb_populate_record(NULL::base_wallet_reservations, $1::jsonb)`,
    [
      JSON.stringify({
        ...held!.r,
        reservation_id: randomUUID(),
        holder_ref: key,
        intent_hash: keccak256(stringToHex(key)),
        amount: 1000,
        state: 'held',
        op_id: null,
        created_at: at - 30_000,
        updated_at: at - 30_000,
      }),
    ],
  );
  const stateOf = async () =>
    (
      await f.sql<{ state: string }>(
        "SELECT state FROM base_wallet_reservations WHERE holder_kind = 'float' AND holder_ref = $1",
        [key],
      )
    )[0]!.state;
  // Inside the grace: a worker may still send it, so nothing is touched.
  assert.equal((await engineAt(f, at).recover()).holds, 0);
  assert.equal(await stateOf(), 'held');
  // Past the grace: the key is fenced (no late send) and the hold released.
  assert.equal((await engineAt(f, at + 60_000).recover()).holds, 1);
  assert.equal(await stateOf(), 'released');
});

test('a float hold whose move is still pending is left to the moves pass', async (t) => {
  const f = await setup(t);
  const move = await finalTopUp(f);
  const at = f.clock() + 5 * 60_000;
  // The move pending again and its hold held: settleMoves settles both, the holds pass skips it.
  await f.sql(`UPDATE feed_pay_float_moves SET state = 'pending' WHERE move_id = $1`, [
    move.move_id,
  ]);
  await f.sql(
    `UPDATE base_wallet_reservations SET state = 'held', op_id = NULL, updated_at = $2
     WHERE holder_kind = 'float' AND holder_ref = $1`,
    [move.op_key, at - 2 * 60_000],
  );
  const result = await engineAt(f, at).recover();
  assert.equal(result.moves, 1, JSON.stringify(result));
  assert.equal(result.holds, 0, JSON.stringify(result));
  const [hold] = await f.sql<{ state: string }>(
    "SELECT state FROM base_wallet_reservations WHERE holder_kind = 'float' AND holder_ref = $1",
    [move.op_key],
  );
  assert.equal(hold!.state, 'consumed');
});

test('float holds are checked least recently first: holds whose top-up stays in flight never block a newer final one', async (t) => {
  const f = await setup(t);
  const move = await finalTopUp(f);
  const at = f.clock() + 5 * 60_000;
  const [held] = await f.sql<{ r: Record<string, unknown> }>(
    "SELECT to_jsonb(r) AS r FROM base_wallet_reservations r WHERE holder_kind = 'float' AND holder_ref = $1",
    [move.op_key],
  );
  const [op] = await f.sql<{ o: Record<string, unknown> }>(
    'SELECT to_jsonb(o) AS o FROM base_chain_ops o WHERE idempotency_key = $1',
    [move.op_key],
  );
  // 30 older holds whose top-up was sent and is still waiting for its receipt (no move pending).
  for (let i = 0; i < 30; i++) {
    const key = `feed-pay:top-up:${randomUUID()}`;
    const old = at - 10 * 60_000 - i;
    await f.sql(
      `INSERT INTO base_chain_ops
       SELECT * FROM jsonb_populate_record(NULL::base_chain_ops, $1::jsonb)`,
      [
        JSON.stringify({
          ...op!.o,
          op_id: randomUUID(),
          idempotency_key: key,
          intent_hash: keccak256(stringToHex(key)),
          status: 'submitted',
          tx_hash: keccak256(stringToHex(`tx-${key}`)),
          block_number: null,
          block_hash: null,
          error_code: null,
          created_at: old,
          updated_at: at,
        }),
      ],
    );
    await f.sql(
      `INSERT INTO base_wallet_reservations
       SELECT * FROM jsonb_populate_record(NULL::base_wallet_reservations, $1::jsonb)`,
      [
        JSON.stringify({
          ...held!.r,
          reservation_id: randomUUID(),
          holder_ref: key,
          intent_hash: keccak256(stringToHex(key)),
          amount: 1000,
          state: 'held',
          op_id: null,
          checked_at: 0,
          created_at: old,
          updated_at: old,
        }),
      ],
    );
  }
  // The newer hold: its top-up is final, the hold left 'held'.
  await f.sql(
    `UPDATE base_wallet_reservations SET state = 'held', op_id = NULL, checked_at = 0,
       updated_at = $2 WHERE holder_kind = 'float' AND holder_ref = $1`,
    [move.op_key, at - 2 * 60_000],
  );
  const engine = engineAt(f, at);
  await engine.recover();
  await engine.recover();
  const [hold] = await f.sql<{ state: string }>(
    "SELECT state FROM base_wallet_reservations WHERE holder_kind = 'float' AND holder_ref = $1",
    [move.op_key],
  );
  assert.equal(hold!.state, 'consumed', 'the second run reached the hold behind the 30 in flight');
  const [{ n }] = await f.sql<{ n: string }>(
    "SELECT count(*)::text AS n FROM base_wallet_reservations WHERE holder_kind = 'float' AND state = 'held'",
  );
  assert.equal(n, '30', 'the holds whose top-up is in flight are left held');
});
