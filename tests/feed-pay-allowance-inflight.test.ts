import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CHAIN_ID, setup, USDC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed pay float top-ups and agent Pay payments spend the same owner limit on Base
 * (SpendPermissionManager.spend under one permission). An agent Pay payment held here but not in
 * a block yet is missing from Base's count of the period, so a top-up sized from that count alone
 * would revert on Base (or make the payment revert). The real app, engine and chain side over a
 * fake Base. Synthetic data only; nothing reaches a network.
 */

/** An agent Pay payment reserved on the agent's wallet (held: sent, not on Base yet). */
const heldPayment = (f: FeedPayApp, amount: bigint) =>
  f.sql(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'payment', $6, 'h', 'held', $7, $7)`,
    [randomUUID(), f.walletId, CHAIN_ID, USDC, amount.toString(10), randomUUID(), f.clock()],
  );

/**
 * The owner's Berlin day cap twice the on-chain allowance (the half model): the calendar counter
 * leaves room, so only the on-chain allowance decides here.
 */
const halfModel = (f: FeedPayApp) =>
  f.sql(
    "UPDATE base_spend_permissions SET cap_raw = 10000000, onchain_model = 'half' WHERE wallet_id = $1",
    [f.walletId],
  );

const spends = (f: FeedPayApp) => f.base.state.effects.filter((effect) => effect === 'spend');

test('a Feed call is refused when held agent Pay payments leave too little of the limit', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  await halfModel(f);
  // The limit is 5 USDC for the period and Base reports nothing spent; 4.99 of it is held by an
  // agent Pay payment on its way, so the 0.02 the call needs from the limit is not there.
  await heldPayment(f, 4_990_000n);
  const res = await f.pay();
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'over_limit');
  assert.equal(res.json().limitLeftRaw, '10000');
  assert.equal(spends(f).length, 0);
  assert.equal(f.service.paid().length, 0);
  const moves = await f.sql("SELECT 1 FROM feed_pay_float_moves WHERE kind = 'top_up'");
  assert.equal(moves.length, 0);
});

test('a Feed call fits next to held agent Pay payments that leave enough of the limit', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  await halfModel(f);
  await heldPayment(f, 4_500_000n);
  const call = await f.settled((await f.pay()).json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  // The top-up stays within the 0.5 USDC the payment leaves (sized from Base alone: 1 USDC).
  const [move] = await f.sql<{ amount: string }>(
    "SELECT amount_raw::text AS amount FROM feed_pay_float_moves WHERE kind = 'top_up'",
  );
  assert.ok(BigInt(move!.amount) <= 500_000n, move!.amount);
});

test('a top-up is never planned over an agent Pay payment reserved after the call was', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  await halfModel(f);
  // The call passes its own admission; then, before its top-up is planned, an agent Pay payment
  // of 4.99 is reserved (sent, not on Base yet) on the same limit.
  let inserted = false;
  f.base.state.beforeBalanceRead = async (address) => {
    if (inserted || address.toLowerCase() !== f.wallet.toLowerCase()) return;
    const calls = await f.sql("SELECT 1 FROM feed_pay_calls WHERE state = 'reserved'");
    if (!calls.length) return;
    inserted = true;
    await heldPayment(f, 4_990_000n);
  };
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  const call = await f.settled(res.json().callId);
  f.base.state.beforeBalanceRead = null;
  assert.ok(inserted, 'the payment was reserved before the top-up');
  assert.equal(call.state, 'refused', JSON.stringify(call));
  assert.equal(call.failure?.code, 'over_limit');
  assert.equal(spends(f).length, 0, 'no top-up was sent');
  assert.equal(f.service.paid().length, 0);
});
