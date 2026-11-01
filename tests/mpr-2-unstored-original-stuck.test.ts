import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import { createOwnerOperationsPort } from '../server/base/chain/owner-ops.js';
import { walletSignature } from '../server/base/chain/permissions.js';
import { userOperationFromRpc } from '../shared/base/withdraw.js';
import { WALLET_EXPECTED } from './wallet-network-fixture.js';
import {
  FEE_BUDGET,
  NETWORK,
  created,
  create,
  post,
  rawSign,
  read,
  reservations,
  setup,
  usdc,
  type Fixture,
} from './mpr-2-fixture.js';

/**
 * Path 2 review (sponsored withdrawals), finding "a signed withdrawal whose own operation can never
 * be stored is never retired, and even a landed cancel at its nonce does not end it".
 *
 * advance() (server/base/wallet/withdrawals.ts) used to return the row unchanged whenever follow()
 * of the ORIGINAL gave null ("the chain could not be read: keep what is stored"). follow() gives
 * null when port.submit throws before the chain module stored the operation. When that throw is
 * persistent (here: the paymaster the operation was sponsored by is no longer in the allowlist,
 * e.g. a paymaster rotation deployed inside the 10-minute signing window; equally a lowered
 * CITY_BASE_WALLET_FEE_CAP_WEI), the withdrawal stayed 'submitted' forever, and even a final cancel
 * at the same nonce left it 'cancel_pending' forever: its amount and its sponsor exposure held, and
 * (lanes off) every new withdrawal of the wallet refused operation_pending.
 *
 * Fixed behaviour: a cancel final at the withdrawal's nonce ends it 'cancelled'; a sponsorship
 * provably lapsed (a settled canonical block past validUntil, the nonce unused there) ends it
 * 'failed' (not_sent); either releases its holds and exposure. Nothing else is concluded.
 *
 * Before the fix these tests FAIL (the withdrawal never leaves submitted / cancel_pending).
 */

const withdrawKey = (id: string) => `base-wallet:withdraw:${id}`;
const cancelKey = (id: string) => `base-wallet:withdraw-cancel:${id}`;

/** The sponsor allowlist moves on to another paymaster (a rotation deployed meanwhile). */
function rotatePaymaster(f: Fixture, paymaster: `0x${string}`) {
  const bundler = rpcBundler({
    url: 'https://bundler.test/rpc/test-key-0001',
    entryPoint: NETWORK.contracts.entryPointV06,
    chainId: WALLET_EXPECTED.chainId,
    client: f.chain.client,
    maxFeePerGasCap: 10n ** 12n,
    stubSignature: walletSignature(`0x${'ff'.repeat(64)}1c`, { ownerIndex: 0 }),
    fetch: f.chain.fetch,
  });
  f.runtime.ownerOperations = createOwnerOperationsPort({
    network: NETWORK,
    client: f.chain.client,
    store: pgChainOperationStore(f.db, () => f.clock.now),
    bundler,
    maxCostWeiCap: FEE_BUDGET,
    sponsors: { [WALLET_EXPECTED.chainId]: [paymaster] },
    now: () => f.clock.now,
  });
  f.chain.state.paymaster = paymaster;
}

/** Created under the pinned paymaster, then the allowlist moves on before the owner signs. */
async function unstoredSigned(f: Fixture, n = 1) {
  const body = await created(f, n);
  rotatePaymaster(f, getAddress(`0x${'6b'.repeat(20)}`));
  // The owner signs: accepted (202, 'submitted'), but the chain module refuses to store it.
  const signed = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(signed.statusCode, 202, signed.body);
  assert.equal(signed.json().state, 'submitted');
  const stored = await f.pg.query('SELECT 1 FROM base_chain_ops WHERE idempotency_key = $1', [
    withdrawKey(body.withdrawalId),
  ]);
  assert.equal(stored.rows.length, 0, 'the original was never stored, never sent');
  assert.equal(f.chain.state.sends.length, 0);
  return body;
}

async function heldExposure(f: Fixture, withdrawalId: string) {
  const { rows } = await f.pg.query(
    `SELECT 1 FROM base_sponsor_exposure WHERE withdrawal_id = $1 AND state = 'held'`,
    [withdrawalId],
  );
  return rows.length;
}

/** The withdrawal's own operation, as prepared and stored on its row (the owner holds it too). */
async function signedOriginal(f: Fixture, withdrawalId: string): Promise<UserOperation<'0.6'>> {
  const { rows } = await f.pg.query<{ user_operation: unknown }>(
    'SELECT user_operation FROM base_wallet_withdrawals WHERE withdrawal_id = $1',
    [withdrawalId],
  );
  return userOperationFromRpc(rows[0].user_operation);
}

test('mpr-2: a landed cancel ends a withdrawal whose own operation was never stored', async (t) => {
  const f = await setup(t);
  const body = await unstoredSigned(f);

  // Long after it was signed it is still 'submitted': no block time, nothing is concluded.
  f.clock.now += 24 * 60 * 60_000;
  f.chain.mine(10_000);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 1);

  // The owner cancels: a sponsored no-op at the same nonce, prepared, signed, sent, landed, final.
  const asked = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  const cancelHash = asked.json().cancel.userOpHash as Hex;
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, cancelHash),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  // Sent, not yet landed: it may still land, nothing is concluded.
  assert.equal((await read(f, body.withdrawalId)).json().state, 'cancel_pending');
  f.chain.include(cancelHash);
  // Landed but not settled yet: still pending.
  assert.equal((await read(f, body.withdrawalId)).json().state, 'cancel_pending');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 1);
  f.chain.mine(10);
  await read(f, body.withdrawalId);
  const after = (await read(f, body.withdrawalId)).json();
  const cancelNow = await f.pg.query<{ status: string }>(
    'SELECT status FROM base_chain_ops WHERE idempotency_key = $1',
    [cancelKey(body.withdrawalId)],
  );
  assert.equal(cancelNow.rows[0].status, 'final', 'the cancel is final on Base');

  // FIXED: cancelled; the hold and the sponsor exposure are released.
  assert.equal(after.state, 'cancelled');
  assert.equal(after.cancel.state, 'final');
  assert.equal(
    (await reservations(f)).filter((r) => r.state === 'held').length,
    0,
    'the 1.5 USDC hold is released',
  );
  assert.equal(await heldExposure(f, body.withdrawalId), 0, 'the sponsor exposure is released');
  // The wallet takes a new withdrawal again (lanes off).
  const next = await create(f, usdc(2));
  assert.equal(next.statusCode, 201, next.body);
  // Still no record of the original: it was never sent from here.
  const stored = await f.pg.query('SELECT 1 FROM base_chain_ops WHERE idempotency_key = $1', [
    withdrawKey(body.withdrawalId),
  ]);
  assert.equal(stored.rows.length, 0);
});

test('mpr-2: a never-stored withdrawal whose sponsorship provably lapsed fails and releases its holds', async (t) => {
  const f = await setup(t);
  const body = await unstoredSigned(f);
  const until = BigInt(f.chain.state.sponsorValidUntil());
  f.chain.mine(10);

  // Base cannot tell the time: nothing concluded.
  f.chain.state.blockTime = null;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  // The settled block is exactly at validUntil: it could still land, nothing concluded.
  f.chain.state.blockTime = () => until;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  // Base unreachable: nothing concluded.
  f.chain.state.blockTime = () => until + 1n;
  f.chain.state.nodeDown = true;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  f.chain.state.nodeDown = false;
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 1);

  // Past validUntil at a settled canonical block, its nonce unused there: it can never land.
  const after = (await read(f, body.withdrawalId)).json();
  assert.equal(after.state, 'failed');
  assert.equal(after.errorCode, 'not_sent');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 0);
  assert.equal(await heldExposure(f, body.withdrawalId), 0);
  const next = await create(f, usdc(2));
  assert.equal(next.statusCode, 201, next.body);
});

test('mpr-2: a never-stored withdrawal the owner sent elsewhere (nonce used) is never failed', async (t) => {
  const f = await setup(t);
  const body = await unstoredSigned(f);
  // The owner holds the signed bytes and has them sent by another bundler: they land.
  const op = await signedOriginal(f, body.withdrawalId);
  f.chain.state.pool.set(body.userOpHash, op);
  f.chain.include(body.userOpHash);
  f.chain.mine(10);
  f.chain.state.blockTime = () => BigInt(f.chain.state.sponsorValidUntil()) + 1_000n;
  // Its nonce is used at the settled block: never concluded lapsed, the holds stay (fail closed).
  for (let i = 0; i < 2; i++)
    assert.equal((await read(f, body.withdrawalId)).json().state, 'submitted');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 1);
  assert.ok((await heldExposure(f, body.withdrawalId)) > 0);
});

test('mpr-2: a never-stored withdrawal with a cancel still in flight is not failed by the lapse', async (t) => {
  const f = await setup(t);
  const body = await unstoredSigned(f);
  const originalUntil = BigInt(f.chain.state.sponsorValidUntil());
  // The cancel is prepared minutes later: its own sponsorship outlives the original's.
  f.clock.now += 5 * 60_000;
  const asked = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  const cancelHash = asked.json().cancel.userOpHash as Hex;
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, cancelHash),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  // The original's sponsorship lapsed, but the cancel's has not and it is in flight: wait for it.
  f.chain.mine(10);
  f.chain.state.blockTime = () => originalUntil + 1n;
  const cancelOp = await f.pg.query('SELECT 1 FROM base_chain_ops WHERE idempotency_key = $1', [
    cancelKey(body.withdrawalId),
  ]);
  assert.equal(cancelOp.rows.length, 1);
  const state = (await read(f, body.withdrawalId)).json();
  assert.equal(state.state, 'cancel_pending');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 1);
  // Then the cancel lands and settles: cancelled.
  f.chain.include(cancelHash);
  f.chain.mine(10);
  await read(f, body.withdrawalId);
  assert.equal((await read(f, body.withdrawalId)).json().state, 'cancelled');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 0);
});

test('mpr-2: a never-stored withdrawal with a never-stored cancel ends only once both lapsed', async (t) => {
  const f = await setup(t);
  const body = await unstoredSigned(f);
  const originalUntil = BigInt(f.chain.state.sponsorValidUntil());
  f.clock.now += 5 * 60_000;
  const asked = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  const cancelUntil = BigInt(f.chain.state.sponsorValidUntil());
  assert.ok(cancelUntil > originalUntil);
  // Rotated again before the cancel is signed: the cancel is never stored either.
  rotatePaymaster(f, getAddress(`0x${'6c'.repeat(20)}`));
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.json().cancel.userOpHash as Hex),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  const stored = await f.pg.query('SELECT 1 FROM base_chain_ops WHERE idempotency_key = $1', [
    cancelKey(body.withdrawalId),
  ]);
  assert.equal(stored.rows.length, 0, 'the cancel was never stored');
  f.chain.mine(10);
  // Only the original lapsed: the owner could still send the cancel, nothing concluded.
  f.chain.state.blockTime = () => originalUntil + 1n;
  assert.equal((await read(f, body.withdrawalId)).json().state, 'cancel_pending');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 1);
  // Both lapsed: failed, not sent; holds and exposure released.
  f.chain.state.blockTime = () => cancelUntil + 1n;
  const after = (await read(f, body.withdrawalId)).json();
  assert.equal(after.state, 'failed');
  assert.equal(after.errorCode, 'not_sent');
  assert.equal(after.cancel.state, 'failed');
  assert.equal((await reservations(f)).filter((r) => r.state === 'held').length, 0);
  assert.equal(await heldExposure(f, body.withdrawalId), 0);
});
