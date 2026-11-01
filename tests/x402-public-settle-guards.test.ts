import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Hex } from 'viem';
import { INTENT, setup } from './helpers/x402-fake-base.js';
import { CLAIM_TTL_MS, type FacilitatorError } from '../server/protocol/x402/facilitator.js';
import {
  FACILITATOR_NETWORK,
  type ExactPayment,
  type VerifyAnswer,
} from '../server/protocol/x402/public-facilitator.js';
import { createPublicSettle } from '../server/protocol/x402/public-settle.js';

/*
 * CCA-704 (fix batch FB-704): the durable facilitator's guards the public x402 sender relies on,
 * on the facilitator itself (PGlite and the fake Base of tests/helpers/x402-fake-base.ts).
 */
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Hex;
const ok = async () => {};
const call = (n: number) => `0xa9059cbb${n.toString(16).padStart(64, '0')}` as Hex;
const NOW = 1_792_900_000_000;
const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
/** A public payment of PAYER with EIP-3009 nonce n. */
const payment = (n: number): ExactPayment => ({
  requirements: {
    scheme: 'exact',
    network: FACILITATOR_NETWORK,
    amount: 50_000n,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
  },
  authorization: {
    from: PAYER,
    to: '0x2222222222222222222222222222222222222222',
    value: 50_000n,
    validAfter: 0n,
    validBefore: BigInt(NOW / 1000 + 600),
    nonce: `0x${n.toString(16).padStart(64, '0')}`,
  },
  signature: `0x${'cd'.repeat(65)}`,
});

const PREFIX = 'x402:exact:8453:0xaa:';

test('oneInFlight: a second settlement with the same prefix is refused while the first is sent and not in a block', async (t) => {
  const { base, facilitator, row } = await setup(t, { router: USDC });
  const submit = (key: string, n: number, oneInFlight: string | undefined = PREFIX) =>
    facilitator.submitCall({
      key,
      intentHash: `0x${n.toString(16).padStart(64, '0')}`,
      calldata: call(n),
      beforeBroadcast: ok,
      ...(oneInFlight ? { oneInFlight } : {}),
    });
  assert.equal((await submit(`${PREFIX}0x01`, 1)).status, 'submitted');
  await assert.rejects(submit(`${PREFIX}0x02`, 2), (e: FacilitatorError) => e.code === 'IN_FLIGHT');
  assert.equal(await row(`${PREFIX}0x02`), undefined, 'nothing stored');
  assert.equal(base.sends.length, 1);
  // The same key again is the stored settlement, never refused as its own conflict.
  assert.equal((await submit(`${PREFIX}0x01`, 1)).status, 'submitted');
  // Another payer's prefix is never held up.
  assert.equal(
    (await submit('x402:exact:8453:0xbb:0x01', 3, 'x402:exact:8453:0xbb:')).status,
    'submitted',
  );
  assert.deepEqual(
    (await facilitator.openWithPrefix(PREFIX)).map((o) => [o.key, o.status]),
    [[`${PREFIX}0x01`, 'submitted']],
  );
  // In a block: the payer's balance already moved, the next one may be stored.
  base.mine(keccak256(base.sends[0]!), 5n);
  assert.equal((await facilitator.status(`${PREFIX}0x01`))?.status, 'included');
  assert.equal((await submit(`${PREFIX}0x02`, 2)).status, 'submitted');
});

test('oneInFlight: a queued row nobody can send any more does not count; one being sent does', async (t) => {
  const { pg, account, clock, facilitator } = await setup(t, { router: USDC });
  const submit = (key: string, n: number) =>
    facilitator.submitCall({
      key,
      intentHash: `0x${n.toString(16).padStart(64, '0')}`,
      calldata: call(n),
      beforeBroadcast: ok,
      oneInFlight: PREFIX,
    });
  // Stored and not signed yet, no claim (as when Base went away before its send).
  await pg.query(
    `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router, calldata,
       status, created_at, updated_at) VALUES ($1, $2, 84532, $3, $4, $5, 'queued', $6, $6)`,
    [
      `${PREFIX}0x01`,
      `0x${'01'.padStart(64, '0')}`,
      account.address.toLowerCase(),
      USDC,
      call(1),
      clock.now,
    ],
  );
  await assert.rejects(submit(`${PREFIX}0x02`, 2), (e: FacilitatorError) => e.code === 'IN_FLIGHT');
  clock.now += CLAIM_TTL_MS + 1;
  assert.equal((await submit(`${PREFIX}0x02`, 2)).status, 'submitted');
  await assert.rejects(facilitator.openWithPrefix('x402:%'), /prefix/i);
});

/** A queued, unsigned row with no claim, stored now (as when Base went away before its send). */
const staleQueued = async (
  pg: Awaited<ReturnType<typeof setup>>['pg'],
  from: string,
  at: number,
  n: number,
) =>
  pg.query(
    `INSERT INTO x402_facilitator_ops (op_key, intent_hash, chain_id, facilitator, router, calldata,
       status, created_at, updated_at) VALUES ($1, $2, 84532, $3, $4, $5, 'queued', $6, $6)`,
    [
      `${PREFIX}0x${n.toString(16).padStart(2, '0')}`,
      `0x${n.toString(16).padStart(64, '0')}`,
      from.toLowerCase(),
      USDC,
      call(n),
      at,
    ],
  );

test('oneInFlight: an expired queued row is not resumed while another settlement of the payer is in flight', async (t) => {
  const { pg, base, account, clock, facilitator, row } = await setup(t, { router: USDC });
  const submit = (key: string, n: number) =>
    facilitator.submitCall({
      key,
      intentHash: `0x${n.toString(16).padStart(64, '0')}`,
      calldata: call(n),
      beforeBroadcast: ok,
      oneInFlight: PREFIX,
    });
  await staleQueued(pg, account.address, clock.now, 1);
  clock.now += CLAIM_TTL_MS + 1;
  const second = await submit(`${PREFIX}0x02`, 2);
  assert.equal(second.status, 'submitted');
  assert.equal(base.sends.length, 1);
  // The expired row's own key again: its resume is refused like a new settlement would be.
  await assert.rejects(submit(`${PREFIX}0x01`, 1), (e: FacilitatorError) => e.code === 'IN_FLIGHT');
  assert.equal(base.sends.length, 1, 'nothing signed or sent');
  const stale = await row(`${PREFIX}0x01`);
  assert.equal(stale?.status, 'queued');
  assert.equal(stale?.raw_tx, null);
  assert.equal(stale?.claim_id, null, 'the claim was rolled back');
  // The submitted one's retry is unchanged: the same settlement, nothing new sent.
  const again = await submit(`${PREFIX}0x02`, 2);
  assert.equal(again.status, 'submitted');
  assert.equal(again.txHash, second.txHash);
  assert.equal(base.sends.length, 1);
  // Once that one is in a block, the expired row resumes and is sent.
  base.mine(keccak256(base.sends[0]!), 5n);
  assert.equal((await facilitator.status(`${PREFIX}0x02`))?.status, 'included');
  assert.equal((await submit(`${PREFIX}0x01`, 1)).status, 'submitted');
  assert.equal(base.sends.length, 2);
});

test('a worker whose claim expired while it stalled never signs: it releases the row, one settlement stays in flight', async (t) => {
  const { base, clock, facilitator, row } = await setup(t, { router: USDC });
  const submit = (key: string, n: number, beforeBroadcast = ok) =>
    facilitator.submitCall({
      key,
      intentHash: `0x${n.toString(16).padStart(64, '0')}`,
      calldata: call(n),
      beforeBroadcast,
      oneInFlight: PREFIX,
    });
  let second: Awaited<ReturnType<typeof submit>> | undefined;
  // The first worker claims 0x01 and stalls right before signing, past CLAIM_TTL_MS. Meanwhile its
  // row no longer counts as in flight, so a second settlement of the same payer is admitted and sent.
  const stalled = await submit(`${PREFIX}0x01`, 1, async () => {
    clock.now += CLAIM_TTL_MS + 1;
    second = await submit(`${PREFIX}0x02`, 2);
  });
  assert.equal(second?.status, 'submitted');
  // The stalled worker resumes: nothing signed or sent, its claim released.
  assert.equal(stalled.status, 'queued');
  assert.equal(base.sends.length, 1, 'only the second settlement was sent');
  const first = await row(`${PREFIX}0x01`);
  assert.equal(first?.raw_tx, null);
  assert.equal(first?.nonce, null);
  assert.equal(first?.claim_id, null);
  assert.equal(first?.claimed_at, null);
  assert.deepEqual(
    (await facilitator.openWithPrefix(PREFIX)).map((o) => [o.key, o.status]),
    [[`${PREFIX}0x02`, 'submitted']],
  );
  // The guarded resume decides now: refused while 0x02 is in flight; 0x02's retry is unchanged.
  await assert.rejects(submit(`${PREFIX}0x01`, 1), (e: FacilitatorError) => e.code === 'IN_FLIGHT');
  const again = await submit(`${PREFIX}0x02`, 2);
  assert.equal(again.txHash, second?.txHash);
  assert.equal(base.sends.length, 1);
});

test('a worker that does not stall signs as before', async (t) => {
  const { base, clock, facilitator } = await setup(t, { router: USDC });
  const op = await facilitator.submitCall({
    key: `${PREFIX}0x01`,
    intentHash: INTENT,
    calldata: call(1),
    // Just inside its claim.
    beforeBroadcast: async () => {
      clock.now += CLAIM_TTL_MS - 1;
    },
    oneInFlight: PREFIX,
  });
  assert.equal(op.status, 'submitted');
  assert.equal(base.sends.length, 1);
});

test('oneInFlight: an expired queued row resumes when no other settlement of the payer is in flight', async (t) => {
  const { pg, base, account, clock, facilitator } = await setup(t, { router: USDC });
  const submit = (key: string, n: number) =>
    facilitator.submitCall({
      key,
      intentHash: `0x${n.toString(16).padStart(64, '0')}`,
      calldata: call(n),
      beforeBroadcast: ok,
      oneInFlight: PREFIX,
    });
  await staleQueued(pg, account.address, clock.now, 1);
  clock.now += CLAIM_TTL_MS + 1;
  const resumed = await submit(`${PREFIX}0x01`, 1);
  assert.equal(resumed.status, 'submitted');
  assert.equal(base.sends.length, 1);
  // Its idempotent retry: the same settlement, nothing new sent.
  const again = await submit(`${PREFIX}0x01`, 1);
  assert.equal(again.status, 'submitted');
  assert.equal(again.txHash, resumed.txHash);
  assert.equal(base.sends.length, 1);
  // And now it is the payer's one in flight.
  await assert.rejects(submit(`${PREFIX}0x02`, 2), (e: FacilitatorError) => e.code === 'IN_FLIGHT');
});

test('the public sender over the durable facilitator: one settlement in flight per payer', async (t) => {
  const { base, facilitator } = await setup(t, { router: USDC });
  let clock = NOW;
  const sender = createPublicSettle({ facilitator, enabled: () => true, now: () => clock });
  const valid = async (): Promise<VerifyAnswer> => ({ isValid: true, payer: PAYER });
  const first = await sender.settle(payment(1), valid);
  assert.equal(first.errorReason, 'settlement_pending');
  const second = await sender.settle(payment(2), valid);
  assert.equal(second.errorReason, 'payer_settlement_in_flight');
  assert.equal(base.sends.length, 1);
  base.mine(keccak256(base.sends[0]!), 5n);
  // Followed on Base again (at most once per 10 s): now in a block.
  clock += 10_000;
  assert.equal((await sender.settle(payment(2), valid)).errorReason, 'settlement_pending');
  assert.equal(base.sends.length, 2);
});

test('feeRoom: false once the capped max fee no longer covers twice the base fee and the tip', async (t) => {
  const { base, facilitator } = await setup(t, { router: USDC });
  assert.equal(await facilitator.feeRoom(), true);
  // 0.5 gwei cap: 2 x 0.2 gwei + tip still fits, 2 x 0.25 gwei + tip does not.
  base.baseFee = 200_000_000n;
  assert.equal(await facilitator.feeRoom(), true);
  base.baseFee = 250_000_000n;
  assert.equal(await facilitator.feeRoom(), false);
  base.down = true;
  await assert.rejects(facilitator.feeRoom());
});

test('laneStuck: true while the lane head has waited unmined longer than asked, false once mined', async (t) => {
  const { base, clock, facilitator } = await setup(t, { router: USDC });
  assert.equal(await facilitator.laneStuck(600_000), false, 'an empty lane');
  await facilitator.submitCall({
    key: `${PREFIX}0x01`,
    intentHash: INTENT,
    calldata: call(1),
    beforeBroadcast: ok,
  });
  clock.now += 599_000;
  assert.equal(await facilitator.laneStuck(600_000), false);
  clock.now += 2_000;
  assert.equal(await facilitator.laneStuck(600_000), true);
  base.mine(keccak256(base.sends.at(-1)!), 5n);
  assert.equal(await facilitator.laneStuck(600_000), false, 'its nonce is used: not the head');
});

test('an L1 data fee above its cap is never signed: the first send ends never sent, alerted', async (t) => {
  const { base, facilitator, row, lines } = await setup(t, {
    router: USDC,
    caps: { maxL1FeeWei: 1_000n },
    l1FeeWei: async () => 1_001n,
  });
  const op = await facilitator.submitCall({
    key: 'x402:exact:8453:0xaa:0x01',
    intentHash: INTENT,
    calldata: call(1),
    beforeBroadcast: ok,
  });
  assert.equal(op.status, 'failed');
  assert.equal(op.neverSent, true);
  assert.equal(op.errorCode, 'L1_FEE_CAP');
  assert.equal(base.sends.length, 0);
  assert.equal((await row('x402:exact:8453:0xaa:0x01')).nonce, null, 'no nonce taken');
  assert.ok(lines.some((l) => l.includes('ALERT') && l.includes('L1 fee')));
});

test('at its cap the L1 data fee is signed as before', async (t) => {
  const { base, facilitator } = await setup(t, {
    router: USDC,
    caps: { maxL1FeeWei: 1_000n },
    l1FeeWei: async () => 1_000n,
  });
  const op = await facilitator.submitCall({
    key: 'x402:exact:8453:0xaa:0x02',
    intentHash: INTENT,
    calldata: call(2),
    beforeBroadcast: ok,
  });
  assert.equal(op.status, 'submitted');
  assert.equal(base.sends.length, 1);
});
