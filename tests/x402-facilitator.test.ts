import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeErrorResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BATCH_KEY_PREFIX,
  CLAIM_TTL_MS,
  createRouter3Facilitator,
  decodeSettle,
  encodeSettle,
  encodeSettleBatch,
  FacilitatorError,
  router3SettleAbi,
  STUCK_MS,
  type FacilitatorBatchConfig,
  type FacilitatorCaps,
  type Router3Settlement,
} from '../server/protocol/x402/facilitator.js';
import {
  X402_FACILITATOR_BATCH_SQL,
  X402_FACILITATOR_SQL,
} from '../server/protocol/x402/facilitator-schema.js';
import {
  CHAIN_ID,
  FakeBase,
  INTENT,
  OTHER_INTENT,
  ROUTER,
  settlement,
  setup,
} from './helpers/x402-fake-base.js';
const ok = async () => {};

test('stores the settlement before it is broadcast, then sends one signed EIP-1559 tx', async (t) => {
  const { base, facilitator, row, account } = await setup(t);
  let seenAtBroadcast: Record<string, unknown> | undefined;
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: async () => {
      seenAtBroadcast = await row('k1');
    },
  });
  assert.equal(seenAtBroadcast?.status, 'queued');
  assert.equal(seenAtBroadcast?.calldata, encodeSettle(settlement()));
  assert.equal(base.sends.length, 1);
  assert.equal(op.status, 'submitted');
  assert.equal(op.neverSent, false);
  assert.equal(op.txHash, keccak256(base.sends[0]));
  const stored = await row('k1');
  assert.equal(stored.raw_tx, base.sends[0]);
  const tx = parseTransaction(base.sends[0]);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.to, ROUTER);
  assert.equal(tx.nonce, 0);
  assert.equal(tx.chainId, CHAIN_ID);
  assert.equal(tx.gas, 208_000n); // 160,000 × 1.3
  assert.equal(tx.maxFeePerGas, 2n * base.baseFee + base.priority);
  assert.equal(tx.data, encodeSettle(settlement()));
  assert.equal(await facilitator.address(), account.address);
});

test('a second submit with the same key returns the stored op and never sends again', async (t) => {
  const { base, facilitator } = await setup(t);
  let calls = 0;
  const input = {
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: async () => {
      calls++;
    },
  };
  const first = await facilitator.submit(input);
  const second = await facilitator.submit(input);
  assert.deepEqual(second, first);
  assert.equal(base.sends.length, 1);
  assert.equal(calls, 1);
});

test('the same key with a different intent hash throws', async (t) => {
  const { facilitator } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  await assert.rejects(
    facilitator.submit({
      key: 'k1',
      intentHash: OTHER_INTENT,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
    (e: unknown) => e instanceof FacilitatorError && e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('beforeBroadcast refusing ends the row failed REFUSED_BEFORE_BROADCAST, never sent', async (t) => {
  const { base, facilitator, row } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: async () => {
      throw new Error('limit withdrawn');
    },
  });
  assert.equal(op.status, 'failed');
  assert.equal(op.errorCode, 'REFUSED_BEFORE_BROADCAST');
  assert.equal(op.neverSent, true);
  assert.equal(base.sends.length, 0);
  assert.equal((await row('k1')).nonce, null);
  // A retry with the same key does not run it again.
  const again = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(again.errorCode, 'REFUSED_BEFORE_BROADCAST');
  assert.equal(base.sends.length, 0);
});

test('a simulation revert ends failed SIMULATION_REVERTED with the decoded name and takes no nonce', async (t) => {
  const { base, facilitator, row } = await setup(t);
  base.revertData = encodeErrorResult({ abi: router3SettleAbi, errorName: 'AlreadyCharged' });
  let ran = false;
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: async () => {
      ran = true;
    },
  });
  assert.equal(op.status, 'failed');
  assert.equal(op.errorCode, 'SIMULATION_REVERTED');
  assert.equal(op.neverSent, true);
  assert.equal(ran, false);
  assert.equal(base.sends.length, 0);
  assert.equal((await row('k1')).nonce, null);
  assert.equal(await facilitator.errorName('k1'), 'AlreadyCharged');
  // The next settlement takes nonce 0: the lane has no gap.
  base.revertData = null;
  await facilitator.submit({
    key: 'k2',
    intentHash: INTENT,
    settlement: settlement(2_000_000n),
    beforeBroadcast: ok,
  });
  assert.equal(parseTransaction(base.sends[0]).nonce, 0);
});

test('a revert string is decoded too', async (t) => {
  const { base, facilitator } = await setup(t);
  base.revertData = encodeErrorResult({
    abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }],
    errorName: 'Error',
    args: ['FiatTokenV2: invalid signature'],
  });
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(await facilitator.errorName('k1'), 'Error: FiatTokenV2: invalid signature');
});

test('Base down before the first send: nothing sent, row stays queued, a later submit continues', async (t) => {
  const { base, facilitator, row } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  // Seed a row first, then make the simulation fail transiently for a new key.
  base.down = false;
  const original = base.client.estimateGas;
  (base.client as { estimateGas: unknown }).estimateGas = async () => {
    throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
  };
  await assert.rejects(
    facilitator.submit({
      key: 'k2',
      intentHash: INTENT,
      settlement: settlement(2_000_000n),
      beforeBroadcast: ok,
    }),
    (e: unknown) => e instanceof FacilitatorError && e.code === 'RPC_UNAVAILABLE',
  );
  assert.equal((await row('k2')).status, 'queued');
  assert.equal(base.sends.length, 1);
  (base.client as { estimateGas: unknown }).estimateGas = original;
  const op = await facilitator.submit({
    key: 'k2',
    intentHash: INTENT,
    settlement: settlement(2_000_000n),
    beforeBroadcast: ok,
  });
  assert.equal(op.status, 'submitted');
  assert.equal(parseTransaction(base.sends[1]).nonce, 1);
});

test('low gas funds: submit refuses before storing', async (t) => {
  const { base, facilitator, row } = await setup(t);
  base.balance = 400_000_000_000_000n; // 0.0004 ETH
  assert.equal(await facilitator.canPay(), false);
  await assert.rejects(
    facilitator.submit({
      key: 'k1',
      intentHash: INTENT,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
    (e: unknown) => e instanceof FacilitatorError && e.code === 'LOW_GAS_FUNDS',
  );
  assert.equal(await row('k1'), undefined);
  base.balance = 500_000_000_000_000n;
  assert.equal(await facilitator.canPay(), true);
  assert.equal(await facilitator.ethBalance(), 500_000_000_000_000n);
});

test('the nonce lane is serial under concurrency: distinct, gapless nonces', async (t) => {
  const { base, facilitator, pg } = await setup(t);
  const ops = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      facilitator.submit({
        key: `k${i}`,
        intentHash: INTENT,
        settlement: settlement(BigInt(1_000_000 + i)),
        beforeBroadcast: ok,
      }),
    ),
  );
  assert.ok(ops.every((op) => op.status === 'submitted'));
  const nonces = base.sends.map((raw) => parseTransaction(raw).nonce).sort((a, b) => a! - b!);
  assert.deepEqual(
    nonces,
    Array.from({ length: 12 }, (_, i) => i),
  );
  const lane = await pg.query<{ next_nonce: string }>(
    'SELECT next_nonce::text AS next_nonce FROM x402_facilitator_lanes',
  );
  assert.equal(lane.rows[0].next_nonce, '12');
  // The same key submitted concurrently sends once.
  const same = await Promise.all(
    Array.from({ length: 5 }, () =>
      facilitator.submit({
        key: 'dup',
        intentHash: INTENT,
        settlement: settlement(9_000_000n),
        beforeBroadcast: ok,
      }),
    ),
  );
  assert.equal(base.sends.length, 13);
  assert.ok(same.some((op) => op.status === 'submitted'));
});

test('the lane follows the chain when the chain is ahead', async (t) => {
  const { base, facilitator } = await setup(t);
  base.minedCount = 7;
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(parseTransaction(base.sends[0]).nonce, 7);
});

test('a lost transaction is rebroadcast exactly as stored, never re-signed', async (t) => {
  const { base, facilitator } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  const raw = base.sends[0];
  base.known.clear(); // the node dropped it
  const op = await facilitator.status('k1');
  assert.equal(op?.status, 'submitted');
  assert.equal(base.sends.length, 2);
  assert.equal(base.sends[1], raw);
  // Known to the node: no resend.
  await facilitator.status('k1');
  assert.equal(base.sends.length, 2);
});

test('a failed first send is unknown, then status sends the same raw tx and it is submitted', async (t) => {
  const { base, facilitator } = await setup(t);
  const original = base.client.sendRawTransaction;
  (base.client as { sendRawTransaction: unknown }).sendRawTransaction = async () => {
    throw new Error('connection reset');
  };
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(op.status, 'unknown');
  assert.equal(op.neverSent, false);
  (base.client as { sendRawTransaction: unknown }).sendRawTransaction = original;
  const after = await facilitator.status('k1');
  assert.equal(after?.status, 'submitted');
  assert.equal(after?.txHash, op.txHash);
  assert.equal(keccak256(base.sends[0]), op.txHash);
});

test('stuck over 5 minutes: replaced with the same nonce and calldata at +30% fees; any hash counts', async (t) => {
  const { base, facilitator, clock, row } = await setup(t);
  const first = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  const original = parseTransaction(base.sends[0]);
  clock.now += STUCK_MS + 1;
  const replaced = await facilitator.status('k1');
  assert.equal(base.sends.length, 2);
  const next = parseTransaction(base.sends[1]);
  assert.equal(next.nonce, original.nonce);
  assert.equal(next.data, original.data);
  assert.equal(next.gas, original.gas);
  assert.equal(next.maxFeePerGas, (original.maxFeePerGas! * 13n + 9n) / 10n);
  assert.equal(next.maxPriorityFeePerGas, (original.maxPriorityFeePerGas! * 13n + 9n) / 10n);
  assert.notEqual(replaced?.txHash, first.txHash);
  const stored = await row('k1');
  assert.deepEqual(stored.tx_hashes, [first.txHash, replaced?.txHash]);
  // The ORIGINAL one is mined: accepted.
  base.mine(first.txHash!, 50n);
  const included = await facilitator.status('k1');
  assert.equal(included?.status, 'included');
  assert.equal(included?.txHash, first.txHash);
  assert.equal(included?.blockNumber, 50n);
});

test('included, then final once at or below the finalized block and still canonical', async (t) => {
  const { base, facilitator, row } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.mine(op.txHash!, 60n);
  base.finalized = 59n;
  assert.equal((await facilitator.status('k1'))?.status, 'included');
  assert.equal((await row('k1')).block_hash, base.blocks.get(60n));
  // Finalized past it, but the block at that height is now another one: not final yet.
  base.finalized = 70n;
  const realHash = base.blocks.get(60n)!;
  base.blocks.set(60n, `0x${'ee'.repeat(32)}`);
  assert.equal((await facilitator.status('k1'))?.status, 'included');
  base.blocks.set(60n, realHash);
  const final = await facilitator.status('k1');
  assert.equal(final?.status, 'final');
  assert.equal(final?.errorCode, null);
  assert.equal(final?.blockNumber, 60n);
});

test('a reverted receipt is included with REVERTED, then failed REVERTED when finalized', async (t) => {
  const { base, facilitator } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.mine(op.txHash!, 60n, 'reverted');
  const included = await facilitator.status('k1');
  assert.equal(included?.status, 'included');
  assert.equal(included?.errorCode, 'REVERTED');
  base.finalized = 61n;
  const failed = await facilitator.status('k1');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.errorCode, 'REVERTED');
  assert.equal(failed?.neverSent, false);
});

test('a dropped block: reorged, then the same raw tx is sent again', async (t) => {
  const { base, facilitator } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.mine(op.txHash!, 60n);
  await facilitator.status('k1');
  base.receipts.clear();
  base.minedCount = 0;
  base.known.clear();
  const after = await facilitator.status('k1');
  assert.equal(after?.status, 'reorged');
  assert.equal(after?.blockNumber, null);
  assert.equal(base.sends.at(-1), base.sends[0]);
});

test('the nonce consumed on chain without a receipt for any of our hashes: failed NONCE_CONSUMED', async (t) => {
  const { base, facilitator } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.minedCount = 1; // something else took nonce 0
  base.finalizedCount = 1; // ... and that is final
  const op = await facilitator.status('k1');
  assert.equal(op?.status, 'failed');
  assert.equal(op?.errorCode, 'NONCE_CONSUMED');
  assert.equal(op?.neverSent, false);
});

test('status never throws on RPC hiccups and returns the stored op; unknown key is null', async (t) => {
  const { base, facilitator } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.down = true;
  assert.deepEqual(await facilitator.status('k1'), op);
  assert.equal(await facilitator.status('nope'), null);
});

test('endUnsent: tombstone when absent, false for a sent row, true for never-sent rows', async (t) => {
  const { base, facilitator, clock } = await setup(t);
  assert.equal(await facilitator.endUnsent('t1', INTENT), true);
  const tomb = await facilitator.status('t1');
  assert.deepEqual(tomb, {
    key: 't1',
    status: 'failed',
    txHash: null,
    blockNumber: null,
    neverSent: true,
    errorCode: 'ABANDONED_BEFORE_BROADCAST',
  });
  // A tombstoned key can never be sent.
  const after = await facilitator.submit({
    key: 't1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(after.errorCode, 'ABANDONED_BEFORE_BROADCAST');
  assert.equal(base.sends.length, 0);
  // Idempotent.
  assert.equal(await facilitator.endUnsent('t1', INTENT), true);
  // A real, sent row: false.
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(await facilitator.endUnsent('k1', INTENT), false);
  // A refused row is never-sent: true.
  await facilitator.submit({
    key: 'k2',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: async () => {
      throw new Error('no');
    },
  });
  assert.equal(await facilitator.endUnsent('k2', INTENT), true);
  // A queued, unsigned row left by a failed simulation call: ended once its claim is stale.
  const original = base.client.estimateGas;
  (base.client as { estimateGas: unknown }).estimateGas = async () => {
    throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
  };
  await assert.rejects(
    facilitator.submit({
      key: 'k3',
      intentHash: INTENT,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
  );
  (base.client as { estimateGas: unknown }).estimateGas = original;
  clock.now += CLAIM_TTL_MS;
  assert.equal(await facilitator.endUnsent('k3', INTENT), true);
  assert.equal((await facilitator.status('k3'))?.errorCode, 'ABANDONED_BEFORE_BROADCAST');
  // Intent mismatch throws.
  await assert.rejects(facilitator.endUnsent('k1', OTHER_INTENT), FacilitatorError);
});

test('the nonce used at the latest block only: reconciling, and our late receipt still reaches final', async (t) => {
  const { base, facilitator } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  // The node already counts nonce 0 as used, but its receipt backend lags and nothing is final.
  base.minedCount = 1;
  base.finalizedCount = 0;
  const pending = await facilitator.status('k1');
  assert.equal(pending?.status, 'reconciling');
  assert.notEqual(pending?.errorCode, 'NONCE_CONSUMED');
  // Our own transaction's receipt appears later: included, then final.
  base.mine(op.txHash!, 60n);
  assert.equal((await facilitator.status('k1'))?.status, 'included');
  base.finalized = 61n;
  base.finalizedCount = 1;
  assert.equal((await facilitator.status('k1'))?.status, 'final');
});

test('the nonce used at the latest block, then freed by a reorg: the same transaction continues', async (t) => {
  const { base, facilitator } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.minedCount = 1;
  base.finalizedCount = 0;
  assert.equal((await facilitator.status('k1'))?.status, 'reconciling');
  // A reorg drops whatever used the nonce; the node forgot our transaction too.
  base.minedCount = 0;
  base.known.clear();
  const resumed = await facilitator.status('k1');
  assert.equal(resumed?.status, 'submitted');
  // Sent again exactly as stored: never re-signed.
  assert.equal(base.sends.at(-1), base.sends[0]);
});

test('fee ceilings: an extreme node quote is capped at maxFeePerGas and the priority cap', async (t) => {
  const { base, facilitator } = await setup(t, {
    caps: { maxFeePerGasWei: 2_000_000n, maxPriorityFeePerGasWei: 200_000n },
  });
  base.baseFee = 10n ** 15n; // an absurd quote
  base.priority = 10n ** 14n;
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  const tx = parseTransaction(base.sends[0]);
  assert.equal(tx.maxFeePerGas, 2_000_000n);
  assert.equal(tx.maxPriorityFeePerGas, 200_000n);
});

test('replacements are bounded: at most maxReplacements, never above the ceiling, then pending', async (t) => {
  const { base, facilitator, clock, lines } = await setup(t, {
    caps: { maxReplacements: 2 },
  });
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  for (let i = 0; i < 5; i++) {
    clock.now += STUCK_MS + 1;
    await facilitator.status('k1');
  }
  // One first send + 2 replacements; later stuck rounds only rebroadcast or wait.
  const signed = new Set(base.sends);
  assert.equal(signed.size, 3);
  for (const raw of signed) assert.ok(parseTransaction(raw).maxFeePerGas! <= 500_000_000n);
  assert.equal(
    (await facilitator.status('k1'))?.status === 'failed',
    false,
    'never failed for a cap',
  );
  assert.ok(lines.some((line) => line.includes('replacement limit reached')));
});

test('a gas limit above maxGasLimit ends the settlement never sent', async (t) => {
  const { base, facilitator } = await setup(t, { caps: { maxGasLimit: 100_000n } } as never);
  base.gas = 160_000n;
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(op.status, 'failed');
  assert.equal(op.errorCode, 'GAS_LIMIT_EXCEEDED');
  assert.equal(op.neverSent, true);
  assert.equal(base.sends.length, 0);
});

test('concurrent first sends cannot oversubscribe: balance covers one settlement, only one is signed', async (t) => {
  const { base, facilitator, row } = await setup(t, {
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
  });
  // One settlement's worst case: 160k gas x 1.3 x (2 x base fee + priority).
  const oneTx = ((160_000n * 13n + 9n) / 10n) * (2n * base.baseFee + base.priority);
  base.balance = oneTx + oneTx / 2n;
  const results = await Promise.allSettled(
    ['k1', 'k2'].map((key, i) =>
      facilitator.submit({
        key,
        intentHash: `0x${String(i + 1).repeat(64)}` as Hex,
        settlement: settlement(),
        beforeBroadcast: ok,
      }),
    ),
  );
  assert.equal(base.sends.length, 1, 'exactly one raw transaction signed and sent');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(refused.length, 1);
  assert.equal((refused[0] as PromiseRejectedResult).reason.code, 'LOW_GAS_FUNDS');
  const stored = [await row('k1'), await row('k2')].filter((r) => r?.raw_tx);
  assert.equal(stored.length, 1);
});

test('NONCE_CONSUMED is not abandoned: a receipt for a stored hash that appears later includes it again', async (t) => {
  const { base, facilitator } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.minedCount = 1;
  base.finalizedCount = 1;
  assert.equal((await facilitator.status('k1'))?.errorCode, 'NONCE_CONSUMED');
  // The receipt backend lagged past finality: our transaction was mined after all.
  base.mine(op.txHash!, 60n);
  const back = await facilitator.status('k1');
  assert.equal(back?.status, 'included');
  assert.equal(back?.txHash, op.txHash);
});

test('concurrent replacements of one stuck settlement sign one replacement only', async (t) => {
  const { base, facilitator, clock, row } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  clock.now += STUCK_MS + 1;
  await Promise.all([facilitator.status('k1'), facilitator.status('k1'), facilitator.status('k1')]);
  assert.equal(new Set(base.sends).size, 2, 'the original and exactly one replacement');
  assert.equal(((await row('k1')).tx_hashes as string[]).length, 2);
});

test('the L1 data fee counts in the budget: gas fits but gas + L1 fee does not -> refused, stays queued', async (t) => {
  const { base, facilitator, row } = await setup(t, {
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
    l1FeeWei: async () => 10n ** 12n,
  });
  const oneTx = ((160_000n * 13n + 9n) / 10n) * (2n * base.baseFee + base.priority);
  base.balance = oneTx + 10n ** 12n - 1n;
  await assert.rejects(
    facilitator.submit({
      key: 'k1',
      intentHash: INTENT,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
    (error: FacilitatorError) => error.code === 'LOW_GAS_FUNDS',
  );
  assert.equal(base.sends.length, 0);
  assert.equal((await row('k1')).status, 'queued');
  base.balance += 1n;
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(op.status, 'submitted');
});

test('verify is read-only: simulates the settle call, stores nothing, signs nothing, sends nothing', async (t) => {
  const { base, facilitator, pg } = await setup(t);
  const good = await facilitator.verify(settlement());
  assert.deepEqual(good, { ok: true, gas: base.gas });
  base.revertData = encodeErrorResult({ abi: router3SettleAbi, errorName: 'AlreadyCharged' });
  const bad = await facilitator.verify(settlement());
  assert.equal(bad.ok, false);
  assert.equal(base.sends.length, 0);
  const rows = await pg.query('SELECT count(*)::int AS n FROM x402_facilitator_ops');
  assert.equal((rows.rows[0] as { n: number }).n, 0);
});

test('storedStatus reads the database only: no rebroadcast or replacement while stuck', async (t) => {
  const { base, facilitator, clock } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.known.clear();
  clock.now += STUCK_MS + 1;
  const stored = await facilitator.storedStatus('k1');
  assert.equal(stored?.txHash, op.txHash);
  assert.equal(base.sends.length, 1, 'nothing sent by a stored-status read');
  assert.equal(await facilitator.storedStatus('nope'), null);
});

test('two different stuck settlements compete for the budget: only the replacement that fits is signed', async (t) => {
  const { base, facilitator, clock } = await setup(t, {
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
  });
  for (const [key, i] of [
    ['k1', 1],
    ['k2', 2],
  ] as const)
    await facilitator.submit({
      key,
      intentHash: `0x${String(i).repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    });
  assert.equal(base.sends.length, 2);
  // Enough for both originals plus ONE +30% replacement, not two.
  const gasLimit = (160_000n * 13n + 9n) / 10n;
  const fee = 2n * base.baseFee + base.priority;
  const bumped = (fee * 13n + 9n) / 10n;
  base.balance = gasLimit * fee + gasLimit * bumped + (gasLimit * (bumped - fee)) / 2n;
  clock.now += STUCK_MS + 1;
  await Promise.all([facilitator.status('k1'), facilitator.status('k2')]);
  assert.equal(new Set(base.sends).size, 3, 'two originals and exactly one replacement');
});

test('a settlement already in a block no longer counts as in flight: its gas is out of the balance', async (t) => {
  const { base, facilitator, pg } = await setup(t, {
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
  });
  const oneTx = ((160_000n * 13n + 9n) / 10n) * (2n * base.baseFee + base.priority);
  base.balance = oneTx + oneTx / 2n;
  const first = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  // In flight (sent, not in a block): a second settlement does not fit.
  await assert.rejects(
    facilitator.submit({
      key: 'k2',
      intentHash: `0x${'2'.repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
    (error: FacilitatorError) => error.code === 'LOW_GAS_FUNDS',
  );
  // Mined (included, not final yet): its gas left the balance, which still covers one more.
  base.mine(first.txHash!, 60n);
  assert.equal((await facilitator.status('k1'))?.status, 'included');
  base.balance = oneTx + oneTx / 2n;
  const second = await facilitator.submit({
    key: 'k3',
    intentHash: `0x${'3'.repeat(64)}` as Hex,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.ok(second.txHash);
  assert.equal(base.sends.length, 2); // Dropped by a reorg (back to 'reorged'): it counts again, next to k3 still in flight.
  await pg.query("UPDATE x402_facilitator_ops SET status = 'reorged' WHERE op_key = 'k1'");
  base.balance = 2n * oneTx + oneTx / 2n;
  await assert.rejects(
    facilitator.submit({
      key: 'k4',
      intentHash: `0x${'4'.repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
    (error: FacilitatorError) => error.code === 'LOW_GAS_FUNDS',
  );
  assert.equal(base.sends.length, 2);
});

test('the L1 fee of the OTHER settlements in flight counts too', async (t) => {
  const l1 = 10n ** 12n;
  const { base, facilitator } = await setup(t, {
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
    l1FeeWei: async () => l1,
  });
  const oneTx = ((160_000n * 13n + 9n) / 10n) * (2n * base.baseFee + base.priority);
  // Enough for two settlements' gas and ONE L1 fee for the new one, but not the first one's L1.
  base.balance = 2n * oneTx + l1 + l1 / 2n;
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  await assert.rejects(
    facilitator.submit({
      key: 'k2',
      intentHash: `0x${'2'.repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    }),
    (error: FacilitatorError) => error.code === 'LOW_GAS_FUNDS',
  );
  assert.equal(base.sends.length, 1);
});

test('the L1 oracle is asked about exactly the transaction signed (allocated nonce, gas, capped fees); 2x is stored with it', async (t) => {
  const { base, facilitator, row } = await setup(t, { l1FeeWei: undefined });
  base.l1Fee = 7_000_000n;
  base.minedCount = 5;
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal(base.l1Asked.length, 1);
  const asked = parseTransaction(base.l1Asked[0]!);
  const sent = parseTransaction(base.sends[0]!);
  assert.equal(asked.type, 'eip1559');
  assert.equal(asked.r, undefined, 'unsigned');
  for (const field of [
    'chainId',
    'nonce',
    'to',
    'data',
    'gas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
  ] as const)
    assert.equal(asked[field], sent[field], field);
  assert.equal(asked.nonce, 5);
  assert.equal((await row('k1')).l1_fee_wei, '14000000');
});

test('two distinct settlements with different nonzero L1 fees: each reserves its own, the next counts the stored one', async (t) => {
  const { base, facilitator, row } = await setup(t, {
    l1FeeWei: undefined,
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
  });
  const oneTx = ((160_000n * 13n + 9n) / 10n) * (2n * base.baseFee + base.priority);
  base.l1Fee = 4n * 10n ** 11n; // k1 reserves 8e11
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  assert.equal((await row('k1')).l1_fee_wei, (8n * 10n ** 11n).toString());
  base.l1Fee = 10n ** 11n; // k2 reserves 2e11; it must still count k1's stored 8e11
  base.balance = 2n * oneTx + 2n * 10n ** 11n + 8n * 10n ** 11n - 1n;
  const k2 = {
    key: 'k2',
    intentHash: OTHER_INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  };
  await assert.rejects(
    facilitator.submit(k2),
    (error: FacilitatorError) => error.code === 'LOW_GAS_FUNDS',
  );
  base.balance += 1n;
  assert.equal((await facilitator.submit(k2)).status, 'submitted');
  assert.equal((await row('k2')).l1_fee_wei, (2n * 10n ** 11n).toString());
});

test('a replacement quotes its own L1 fee for its bumped transaction and updates its reservation', async (t) => {
  const { base, facilitator, row, clock } = await setup(t, { l1FeeWei: undefined });
  base.l1Fee = 1_000n;
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  base.known.clear();
  base.l1Fee = 3_000n;
  clock.now += STUCK_MS + 1;
  await facilitator.status('k1');
  assert.equal(base.sends.length, 2);
  const asked = parseTransaction(base.l1Asked.at(-1)!);
  const replacement = parseTransaction(base.sends[1]!);
  assert.equal(asked.nonce, replacement.nonce);
  assert.equal(asked.maxFeePerGas, replacement.maxFeePerGas);
  assert.equal(asked.maxPriorityFeePerGas, replacement.maxPriorityFeePerGas);
  assert.equal((await row('k1')).l1_fee_wei, '6000');
});

test('a lane head nobody follows is refreshed by the next submit: the lane never stays blocked', async (t) => {
  const { base, facilitator, clock } = await setup(t);
  await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  const head = parseTransaction(base.sends[0]);
  // k1 is never asked for again (its call is gone) and stays unmined past STUCK_MS.
  clock.now += STUCK_MS + 1;
  await facilitator.submit({
    key: 'k2',
    intentHash: `0x${'2'.repeat(64)}` as Hex,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  // The head was replaced at its own nonce (same calldata) before k2 took the next nonce.
  assert.equal(base.sends.length, 3);
  const replacement = parseTransaction(base.sends[1]);
  assert.equal(replacement.nonce, head.nonce);
  assert.equal(replacement.data, head.data);
  assert.equal(parseTransaction(base.sends[2]).nonce, head.nonce! + 1);
});

test('a settlement included after the block the balance was read at still counts as in flight', async (t) => {
  const { base, facilitator } = await setup(t, {
    minBalanceWei: 0n,
    caps: { reserveWei: 0n },
  });
  const oneTx = ((160_000n * 13n + 9n) / 10n) * (2n * base.baseFee + base.priority);
  // Room for two settlements, not three.
  base.balance = 2n * oneTx + oneTx / 2n;
  const submit = (key: string, digit: string) =>
    facilitator.submit({
      key,
      intentHash: `0x${digit.repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    });
  const first = await submit('k1', '1');
  const second = await submit('k2', '2');
  // Both mined AFTER the block the next balance read sees (the fake's latest block is 100), and the
  // balance read there does not show their gas yet: they must still count.
  base.mine(first.txHash!, 150n);
  base.mine(second.txHash!, 151n);
  assert.equal((await facilitator.status('k1'))?.status, 'included');
  assert.equal((await facilitator.status('k2'))?.status, 'included');
  await assert.rejects(
    submit('k3', '3'),
    (error: FacilitatorError) => error.code === 'LOW_GAS_FUNDS',
  );
  assert.equal(base.sends.length, 2);
});

// ------------------------------------------------------------------ batch lane (room #200/#214)

const member = (i: number): Router3Settlement => ({
  ...settlement(1_000_000n + BigInt(i)),
  ref: `0x${i.toString(16).padStart(64, '0')}` as Hex,
});
const intentOf = (i: number) => `0x${(i + 0x100).toString(16).padStart(64, '0')}` as Hex;
const allowAll = async () => new Set<string>();
const batchOf = (raw: Hex) => parseTransaction(raw);

test('without a batch config a batch request is sent alone, exactly as before', async (t) => {
  const { base, facilitator, row } = await setup(t);
  const op = await facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  assert.equal(op.status, 'submitted');
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettle(settlement()));
  assert.equal((await row('k1')).batch_lane, false);
});

test('a full batch goes out as ONE settleBatch from the facilitator; members share its tx', async (t) => {
  const { base, facilitator, row, account } = await setup(t, {
    batch: { maxItems: 3, windowMs: 1_500 },
  });
  const ops = [];
  for (const i of [1, 2, 3])
    ops.push(
      await facilitator.submit({
        key: `m${i}`,
        intentHash: intentOf(i),
        settlement: member(i),
        beforeBroadcast: ok,
        batch: { authorize: allowAll, grant: null },
      }),
    );
  // The first two wait (not full, window not over); the third fills the batch.
  assert.equal(ops[0]!.status, 'queued');
  assert.equal(ops[1]!.status, 'queued');
  assert.equal(base.sends.length, 1, 'one transaction for three settlements');
  const tx = batchOf(base.sends[0]!);
  assert.equal(tx.to, ROUTER);
  assert.equal(tx.data, encodeSettleBatch([member(1), member(2), member(3)]));
  const hash = keccak256(base.sends[0]!);
  assert.equal(ops[2]!.status, 'submitted');
  assert.equal(ops[2]!.txHash, hash);
  // Signed by the facilitator key itself.
  const { recoverTransactionAddress } = await import('viem');
  assert.equal(
    (
      await recoverTransactionAddress({ serializedTransaction: base.sends[0] as never })
    ).toLowerCase(),
    account.address.toLowerCase(),
  );
  for (const key of ['m1', 'm2', 'm3']) {
    const r = await row(key);
    assert.equal(r.tx_hash, hash);
    assert.equal(r.nonce, null, 'members never take a nonce');
    assert.equal(r.raw_tx, null);
    assert.ok(String(r.batch_key).startsWith(BATCH_KEY_PREFIX));
  }
  const batchRow = await row(String((await row('m1')).batch_key));
  assert.equal(batchRow.nonce, '0');
  // Mined, then final: every member follows its batch.
  base.mine(hash, 60n);
  assert.equal((await facilitator.status('m2', { authorize: allowAll }))?.status, 'included');
  assert.equal((await row('m1')).status, 'included');
  base.finalized = 70n;
  assert.equal((await facilitator.status('m3', { authorize: allowAll }))?.status, 'final');
  assert.equal((await row('m1')).status, 'final');
});

test('a waiting settlement goes in a smaller batch once the window is over', async (t) => {
  const { base, clock, facilitator } = await setup(t, { batch: { maxItems: 50, windowMs: 1_500 } });
  for (const i of [1, 2])
    await facilitator.submit({
      key: `w${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  assert.equal(base.sends.length, 0);
  clock.now += 1_500;
  const op = await facilitator.status('w1', { authorize: allowAll });
  assert.equal(op?.status, 'submitted');
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(2)]));
});

test('a member that fails alone goes to the single path; the rest is re-simulated and batched', async (t) => {
  const { base, facilitator, row } = await setup(t, { batch: { maxItems: 3, windowMs: 1_500 } });
  base.revertWhen = (data) =>
    data === encodeSettle(member(2)) ||
    data === encodeSettleBatch([member(1), member(2), member(3)]);
  for (const i of [1, 2, 3])
    await facilitator.submit({
      key: `r${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(3)]));
  const r2 = await row('r2');
  assert.equal(r2.batch_key, null);
  assert.equal(r2.batch_lane, false, 'back to the single path');
  assert.equal(r2.status, 'queued');
  // Sent alone it fails its own simulation and ends never sent, as any single settlement.
  const alone = await facilitator.submit({
    key: 'r2',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
  });
  assert.equal(alone.status, 'failed');
  assert.equal(alone.errorCode, 'SIMULATION_REVERTED');
  assert.equal(base.sends.length, 1);
});

test('the authority is asked before simulating and again before signing; a refusal is never sent', async (t) => {
  const { base, facilitator, row } = await setup(t, { batch: { maxItems: 3, windowMs: 1_500 } });
  let calls = 0;
  const authorize = async (keys: string[]) => {
    calls++;
    return new Set(keys.filter((k) => k === 'a2'));
  };
  for (const i of [1, 2, 3])
    await facilitator.submit({
      key: `a${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize, grant: null },
    });
  assert.ok(calls >= 2, 'before simulation and before signing');
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(3)]));
  const a2 = await row('a2');
  assert.equal(a2.status, 'failed');
  assert.equal(a2.never_sent, true);
  assert.equal(a2.error_code, 'REFUSED_BEFORE_BROADCAST');
});

test('a refusal right before signing sends nothing; the other members go back to the single path', async (t) => {
  const { base, facilitator, row } = await setup(t, { batch: { maxItems: 2, windowMs: 1_500 } });
  let asked = 0;
  // Allowed at the first check, refused at the one right before signing.
  const authorize = async (keys: string[]) =>
    ++asked >= 2 ? new Set(keys.slice(0, 1)) : new Set<string>();
  for (const i of [1, 2])
    await facilitator.submit({
      key: `l${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize, grant: null },
    });
  assert.equal(base.sends.length, 0, 'nothing signed or sent');
  assert.equal((await row('l1')).error_code, 'REFUSED_BEFORE_BROADCAST');
  const l2 = await row('l2');
  assert.equal(l2.batch_key, null);
  assert.equal(l2.batch_lane, false);
  assert.equal(l2.status, 'queued');
});

test('Base down while sending: the batch stays queued with its members and is continued later, never rebuilt twice', async (t) => {
  const { base, clock, facilitator, row, pg } = await setup(t, {
    batch: { maxItems: 2, windowMs: 1_500 },
  });
  base.down = true;
  await facilitator
    .submit({
      key: 'c1',
      intentHash: intentOf(1),
      settlement: member(1),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    })
    .catch(() => null);
  base.down = false;
  // The second fills the batch; Base fails again during the batch's simulation.
  base.down = true;
  await facilitator
    .submit({
      key: 'c2',
      intentHash: intentOf(2),
      settlement: member(2),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    })
    .catch(() => null);
  base.down = false;
  const batchKey = (await row('c1'))?.batch_key as string | null;
  const batches = (
    await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM x402_facilitator_ops WHERE op_key LIKE 'batch:%'`,
    )
  ).rows[0]!.n;
  assert.ok(batches <= 1, 'at most one batch op');
  if (batchKey) {
    assert.equal((await row('c2')).batch_key, batchKey);
    clock.now += CLAIM_TTL_MS;
    await facilitator.flushBatches(allowAll);
    assert.equal(base.sends.length, 1);
    assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(2)]));
  }
  // No member ever had a transaction of its own.
  assert.equal(base.sends.filter((raw) => batchOf(raw).data === encodeSettle(member(1))).length, 0);
});

test('a batched member is never fenced off by endUnsent (it may be in a transaction)', async (t) => {
  const { facilitator, base } = await setup(t, { batch: { maxItems: 2, windowMs: 1_500 } });
  for (const i of [1, 2])
    await facilitator.submit({
      key: `e${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  assert.equal(base.sends.length, 1);
  assert.equal(await facilitator.endUnsent('e1', intentOf(1)), false);
});

test('single and batched settlements share ONE nonce lane', async (t) => {
  const { base, facilitator, row } = await setup(t, { batch: { maxItems: 2, windowMs: 1_500 } });
  await facilitator.submit({
    key: 's1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: ok,
  });
  for (const i of [1, 2])
    await facilitator.submit({
      key: `b${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  await facilitator.submit({
    key: 's2',
    intentHash: OTHER_INTENT,
    settlement: { ...settlement(), ref: `0x${'cc'.repeat(32)}` },
    beforeBroadcast: ok,
  });
  const nonces = base.sends.map((raw) => batchOf(raw).nonce);
  assert.deepEqual(nonces, [0, 1, 2]);
  assert.equal((await row('s2')).nonce, '2');
});

test('decodeSettle reads back exactly the stored settlement', () => {
  assert.deepEqual(decodeSettle(encodeSettle(member(7))), member(7));
});

test('finalizeIncluded marks final in bulk only canonical blocks at or below the finalized head', async (t) => {
  const { base, facilitator, row } = await setup(t);
  const submit = (key: string, digit: string) =>
    facilitator.submit({
      key,
      intentHash: `0x${digit.repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    });
  const a = await submit('k1', '1');
  const b = await submit('k2', '2');
  const c = await submit('k3', '3');
  base.mine(a.txHash!, 60n);
  base.mine(b.txHash!, 61n);
  base.mine(c.txHash!, 90n);
  for (const key of ['k1', 'k2', 'k3'])
    assert.equal((await facilitator.status(key))?.status, 'included');
  // Block 61 was reorged away (the chain's hash at that height differs from the stored one).
  base.blocks.set(61n, `0x${'ee'.repeat(32)}` as Hex);
  base.finalized = 80n;
  assert.equal(
    await facilitator.finalizeIncluded!({ maxBlocks: 10, maxRows: 100, budgetMs: 5_000 }),
    1,
  );
  assert.equal((await row('k1')).status, 'final');
  assert.equal((await row('k2')).status, 'included', 'not canonical: left to refresh()');
  assert.equal((await row('k3')).status, 'included', 'above the finalized head');
  // Idempotent: a second run moves nothing.
  assert.equal(
    await facilitator.finalizeIncluded!({ maxBlocks: 10, maxRows: 100, budgetMs: 5_000 }),
    0,
  );
});

test('finalizeIncluded is scoped to this chain and bounded by rows', async (t) => {
  const { base, facilitator, row, pg } = await setup(t);
  const submit = (key: string, digit: string) =>
    facilitator.submit({
      key,
      intentHash: `0x${digit.repeat(64)}` as Hex,
      settlement: settlement(),
      beforeBroadcast: ok,
    });
  const a = await submit('k1', '1');
  const b = await submit('k2', '2');
  const c = await submit('k3', '3');
  base.mine(a.txHash!, 60n);
  base.mine(b.txHash!, 60n);
  base.mine(c.txHash!, 60n);
  for (const key of ['k1', 'k2', 'k3'])
    assert.equal((await facilitator.status(key))?.status, 'included');
  // k3 recorded under another chain id (same EOA): never this chain's to finalize.
  await pg.query("UPDATE x402_facilitator_ops SET chain_id = chain_id + 1 WHERE op_key = 'k3'");
  base.finalized = 80n;
  assert.equal(
    await facilitator.finalizeIncluded!({ maxBlocks: 10, maxRows: 1, budgetMs: 5_000 }),
    1,
  );
  assert.equal(
    await facilitator.finalizeIncluded!({ maxBlocks: 10, maxRows: 10, budgetMs: 5_000 }),
    1,
  );
  assert.equal((await row('k1')).status, 'final');
  assert.equal((await row('k2')).status, 'final');
  assert.equal((await row('k3')).status, 'included', 'another chain: untouched');
});

test('finalizeIncluded carries a final batch outcome to members not brought up to date yet', async (t) => {
  const { base, facilitator, row, pg } = await setup(t, {
    batch: { maxItems: 3, windowMs: 1_500 },
  });
  for (const i of [1, 2, 3])
    await facilitator.submit({
      key: `m${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  const hash = keccak256(base.sends[0]!);
  base.mine(hash, 60n);
  assert.equal((await facilitator.status('m2', { authorize: allowAll }))?.status, 'included');
  // m1 lags behind its batch (as if propagate() had not reached it yet).
  await pg.query(
    "UPDATE x402_facilitator_ops SET status = 'submitted', block_number = NULL, block_hash = NULL WHERE op_key = 'm1'",
  );
  base.finalized = 70n;
  await facilitator.finalizeIncluded!({ maxBlocks: 10, maxRows: 100, budgetMs: 5_000 });
  const batchKey = String((await row('m2')).batch_key);
  assert.equal((await row(batchKey)).status, 'final');
  for (const key of ['m1', 'm2', 'm3']) {
    const r = await row(key);
    assert.equal(r.status, 'final', key);
    assert.equal(r.tx_hash, hash, key);
  }
});

test('a member older than maxMemberAgeMs is refused, never sent on an old grant (room #222)', async (t) => {
  const { base, clock, facilitator, row } = await setup(t, {
    batch: { maxItems: 50, windowMs: 30_000, maxMemberAgeMs: 10_000 },
  });
  await facilitator.submit({
    key: 'old',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  clock.now += 9_000;
  await facilitator.submit({
    key: 'young',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  clock.now += 2_000; // 'old' waited 11 s, 'young' 2 s
  await facilitator.flushBatches(allowAll, true);
  const old = await row('old');
  assert.equal(old.status, 'failed');
  assert.equal(old.never_sent, true);
  assert.equal(old.error_code, 'REFUSED_BEFORE_BROADCAST');
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(2)]));
});

test('a stale worker that lost its batch claim changes nothing; the new owner sends it once (room #223)', async (t) => {
  const {
    db,
    base,
    clock,
    facilitator: a,
    account,
    row,
  } = await setup(t, {
    batch: { maxItems: 2, windowMs: 30_000, maxMemberAgeMs: 600_000 },
  });
  // Worker B: another instance over the same database, Base and facilitator key.
  const b = createRouter3Facilitator({
    db,
    client: base.client,
    keystore: { withSigner: async (_ref, use) => use(account) },
    keyRef: `v1:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
    router: ROUTER,
    chainId: CHAIN_ID,
    now: () => clock.now,
    l1FeeWei: async () => 0n,
    batch: { maxItems: 2, windowMs: 30_000, maxMemberAgeMs: 600_000 },
  });
  // Worker A stalls in its first authority check of the batch, then would refuse everyone.
  let release: () => void = () => {};
  let entered = false;
  const stalling = async (keys: string[]) => {
    entered = true;
    await new Promise<void>((r) => (release = r));
    return new Set(keys);
  };
  await a.submit({
    key: 's1',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  const pending = a.submit({
    key: 's2',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: stalling, grant: null },
  });
  for (let i = 0; i < 200 && !entered; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(entered, 'A claimed the batch and is inside authorize');
  const batchKey = String((await row('s1')).batch_key);
  // A's claim expires; B takes the batch over and sends it.
  clock.now += CLAIM_TTL_MS + 1;
  await b.flushBatches(allowAll);
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(2)]));
  // A wakes up with a stale claim: its refusals change nothing.
  release();
  await pending;
  for (const key of ['s1', 's2']) {
    const r = await row(key);
    assert.notEqual(r.error_code, 'REFUSED_BEFORE_BROADCAST');
    assert.equal(r.batch_key, batchKey);
    assert.equal(r.tx_hash, keccak256(base.sends[0]!));
  }
  assert.equal(base.sends.length, 1, 'sent once, by the new owner');
});

test('a flush past its deadline simulates, signs and sends nothing; a stalled simulation is cut at the deadline (room #229/#230)', async (t) => {
  const { base, clock, facilitator, row } = await setup(t, {
    batch: { maxItems: 50, windowMs: 30_000, maxMemberAgeMs: 600_000 },
  });
  for (const i of [1, 2])
    await facilitator.submit({
      key: `d${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  // Already past the deadline: no batch is even claimed.
  const before = base.estimates;
  await facilitator.flushBatches(allowAll, true, clock.now - 1);
  assert.equal(base.estimates, before);
  assert.equal((await row('d1')).batch_key, null);
  // A stalled node: the simulation is cut at the deadline, the claim released, nothing signed.
  base.hang = true;
  const started = Date.now();
  await facilitator.flushBatches(allowAll, true, clock.now + 80);
  assert.ok(Date.now() - started < 2_000, 'returned at the deadline, not when Base answered');
  assert.equal(base.sends.length, 0);
  const batchKey = String((await row('d1')).batch_key);
  assert.ok(batchKey.startsWith(BATCH_KEY_PREFIX), 'the batch stays, queued, with its members');
  assert.equal((await row(batchKey)).claim_id, null, 'claim released');
  // Base answers again: a later run (no deadline) continues the same batch and sends it once.
  base.hang = false;
  await facilitator.flushBatches(allowAll, true);
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(2)]));
  assert.equal((await row('d2')).batch_key, batchKey);
});

test('a deadline crossed while waiting for the lane lock signs nothing (room #234)', async (t) => {
  const { db, base, clock, account, row } = await setup(t);
  const deadline = clock.now + 1_000;
  // The lane's FOR UPDATE "returns late": the clock passes the deadline right when it does (the
  // regression from the review).
  const slowLane: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: async (sql: string, params?: unknown[]) => {
            const result = await tx.query(sql, params as never);
            if (/FROM x402_facilitator_lanes/.test(sql) && /FOR UPDATE/.test(sql))
              clock.now = deadline + 1;
            return result;
          },
        } as never),
      ),
  };
  const f = createRouter3Facilitator({
    db: slowLane,
    client: base.client,
    keystore: { withSigner: async (_ref, use) => use(account) },
    keyRef: `v1:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
    router: ROUTER,
    chainId: CHAIN_ID,
    now: () => clock.now,
    l1FeeWei: async () => 0n,
    batch: { maxItems: 50, windowMs: 30_000, maxMemberAgeMs: 600_000 },
  });
  for (const i of [1, 2])
    await f.submit({
      key: `x${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  await f.flushBatches(allowAll, true, deadline);
  assert.equal(base.sends.length, 0, 'nothing signed or sent');
  const batchKey = String((await row('x1')).batch_key);
  const batchRow = await row(batchKey);
  assert.equal(batchRow.raw_tx, null);
  assert.equal(batchRow.nonce, null);
  assert.equal(batchRow.claim_id, null, 'claim released, the batch stays queued');
  assert.equal(batchRow.status, 'queued');
});

test('a batch request only joins the lane when its grant is known (or none applies)', async (t) => {
  const { facilitator, row } = await setup(t, { batch: { maxItems: 50, windowMs: 30_000 } });
  await facilitator.submit({
    key: 'g1',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: { kind: 'grant', id: 'grant-1' } },
  });
  const g1 = await row('g1');
  assert.equal(g1.batch_lane, true);
  assert.equal(g1.grant_kind, 'grant');
  assert.equal(g1.grant_id, 'grant-1');
  await facilitator.submit({
    key: 'g2',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  assert.equal((await row('g2')).batch_lane, true, 'a Feed purchase: no grant applies');
  await facilitator.submit({
    key: 'g3',
    intentHash: intentOf(3),
    settlement: member(3),
    beforeBroadcast: ok,
    batch: { authorize: allowAll },
  });
  assert.equal((await row('g3')).batch_lane, false, 'grant unknown: sent alone, never batched');
});

test('members left behind a terminal batch are caught up by a later run, within the row quota', async (t) => {
  const { base, facilitator, row, pg } = await setup(t, {
    batch: { maxItems: 3, windowMs: 1_500 },
  });
  for (const i of [1, 2, 3])
    await facilitator.submit({
      key: `m${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  const hash = keccak256(base.sends[0]!);
  base.mine(hash, 60n);
  assert.equal((await facilitator.status('m1', { authorize: allowAll }))?.status, 'included');
  base.finalized = 70n;
  const batchKey = String((await row('m1')).batch_key);
  // As if the run that made the batch final had failed right after: parent final, members behind.
  await pg.query(`UPDATE x402_facilitator_ops SET status = 'final' WHERE op_key = $1`, [batchKey]);
  await pg.query(
    "UPDATE x402_facilitator_ops SET status = 'submitted', block_number = NULL, block_hash = NULL WHERE batch_key = $1",
    [batchKey],
  );
  const limits = { maxBlocks: 10, maxRows: 1, budgetMs: 5_000 };
  // One row per run (the quota counts members); each later run picks up where the last stopped.
  for (let run = 1; run <= 3; run++) {
    assert.equal(await facilitator.finalizeIncluded!(limits), 1, `run ${run}`);
    const final = (
      (
        await pg.query(
          `SELECT count(*)::int AS n FROM x402_facilitator_ops WHERE batch_key = $1 AND status = 'final'`,
          [batchKey],
        )
      ).rows[0] as { n: number }
    ).n;
    assert.equal(final, run);
  }
  assert.equal(await facilitator.finalizeIncluded!(limits), 0, 'nothing left');
  for (const key of ['m1', 'm2', 'm3']) assert.equal((await row(key)).tx_hash, hash, key);
});

// ------------------------------------------- batch groups (sponsored sends on the facilitator)

const SFP = { keyPrefix: 'sfp:', maxItems: 2, windowMs: 1_500, maxMemberAgeMs: 120_000 };
/** An authorize that allows everything and records every key it was asked about. */
const recorder = () => {
  const asked: string[] = [];
  const authorize = async (keys: string[]) => {
    asked.push(...keys);
    return new Set<string>();
  };
  return { asked, authorize };
};

test('groupsOnly: engine submits stay single even with a batch request; the group batches alone', async (t) => {
  const { base, facilitator, row, account } = await setup(t, {
    batch: { maxItems: 50, windowMs: 1_500, groups: [SFP], groupsOnly: true },
  });
  const engine = recorder();
  const sponsored = recorder();
  // An engine single (no batch) and an engine settlement asking for the batch lane: both alone.
  await facilitator.submit({
    key: 'feed-pay:pay:c1',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
  });
  await facilitator.submit({
    key: 'feed-pay:pay:c2',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: engine.authorize, grant: null },
  });
  assert.equal((await row('feed-pay:pay:c2')).batch_lane, false, 'never on the batch lane');
  assert.equal(base.sends.length, 2);
  // The default group is never flushed with groupsOnly.
  await facilitator.flushBatches(engine.authorize, true);
  for (const i of [3, 4])
    await facilitator.submit({
      key: `sfp:sp_${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: sponsored.authorize, grant: null },
    });
  await facilitator.submit({
    key: 'feed-pay:pay:c5',
    intentHash: intentOf(5),
    settlement: member(5),
    beforeBroadcast: ok,
  });
  assert.equal(base.sends.length, 4);
  const txs = base.sends.map(batchOf);
  assert.deepEqual(
    txs.map((tx) => tx.nonce),
    [0, 1, 2, 3],
    'one gapless lane for singles and the batch',
  );
  assert.equal(txs[0]!.data, encodeSettle(member(1)));
  assert.equal(txs[1]!.data, encodeSettle(member(2)));
  assert.equal(txs[2]!.data, encodeSettleBatch([member(3), member(4)]));
  assert.equal(txs[3]!.data, encodeSettle(member(5)));
  const batchKey = String((await row('sfp:sp_3')).batch_key);
  assert.ok(batchKey.startsWith(`${BATCH_KEY_PREFIX}sfp:`), 'the group names its batch');
  assert.equal((await row(batchKey)).facilitator, account.address.toLowerCase());
  assert.deepEqual(engine.asked, [], 'the engine authority never judged anything');
  assert.ok(sponsored.asked.every((k) => k.startsWith('sfp:')));
});

test('groups beside the engine lane: each flush asks only its own authorize about its own members', async (t) => {
  const { base, clock, facilitator, row } = await setup(t, {
    batch: { maxItems: 50, windowMs: 1_500, groups: [{ ...SFP, maxItems: 50 }] },
  });
  const engine = recorder();
  const sponsored = recorder();
  for (const i of [1, 2]) {
    await facilitator.submit({
      key: `feed-pay:pay:e${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: engine.authorize, grant: null },
    });
    await facilitator.submit({
      key: `sfp:s${i}`,
      intentHash: intentOf(10 + i),
      settlement: member(10 + i),
      beforeBroadcast: ok,
      batch: { authorize: sponsored.authorize, grant: null },
    });
  }
  assert.equal(base.sends.length, 0, 'all waiting');
  clock.now += 2_000;
  // The engine's flush (its recover cron) and the sponsored flush (its worker), each its group.
  await facilitator.flushBatches(engine.authorize, true);
  await facilitator.flushBatches(sponsored.authorize, true, undefined, 'sfp:');
  assert.equal(base.sends.length, 2);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(1), member(2)]));
  assert.equal(batchOf(base.sends[1]!).data, encodeSettleBatch([member(11), member(12)]));
  assert.ok(engine.asked.length && engine.asked.every((k) => k.startsWith('feed-pay:')));
  assert.ok(sponsored.asked.length && sponsored.asked.every((k) => k.startsWith('sfp:')));
  assert.ok(!String((await row('feed-pay:pay:e1')).batch_key).startsWith('batch:sfp:'));
  assert.ok(String((await row('sfp:s1')).batch_key).startsWith('batch:sfp:'));
  // A group this facilitator does not have flushes nothing (never another group's members).
  await facilitator.flushBatches(sponsored.authorize, true, undefined, 'other:');
  assert.equal(base.sends.length, 2);
});

test('member age is per group: the sponsored group waits 2 min, the engine members keep 10 s', async (t) => {
  const { base, clock, facilitator, row } = await setup(t, {
    batch: { maxItems: 50, windowMs: 30_000, groups: [{ ...SFP, maxItems: 50 }] },
  });
  await facilitator.submit({
    key: 'feed-pay:pay:e1',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  await facilitator.submit({
    key: 'sfp:s1',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  clock.now += 60_000;
  await facilitator.flushBatches(allowAll, true);
  await facilitator.flushBatches(allowAll, true, undefined, 'sfp:');
  assert.equal((await row('feed-pay:pay:e1')).error_code, 'REFUSED_BEFORE_BROADCAST');
  assert.equal(base.sends.length, 1);
  assert.equal(batchOf(base.sends[0]!).data, encodeSettleBatch([member(2)]));
});

test("another EOA's settlement is only read: never sent, refreshed, fenced or held here", async (t) => {
  const {
    db,
    base,
    clock,
    facilitator: own,
  } = await setup(t, {
    batch: { maxItems: 2, windowMs: 1_500 },
  });
  const other = privateKeyToAccount(generatePrivateKey());
  const shared = createRouter3Facilitator({
    db,
    client: base.client,
    keystore: { withSigner: async (_ref, use) => use(other) },
    keyRef: 'v1:other',
    router: ROUTER,
    chainId: CHAIN_ID,
    now: () => clock.now,
    l1FeeWei: async () => 0n,
    batch: { maxItems: 2, windowMs: 1_500, groups: [SFP], groupsOnly: true },
    foreignReadOnly: true,
  });
  await own.submit({
    key: 'sfp:old',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  assert.equal(await own.holds('sfp:old'), true);
  assert.equal(await shared.holds('sfp:old'), false);
  assert.equal(await shared.holds('sfp:none'), false);
  // Handed to the wrong facilitator: its stored state only, nothing signed or sent.
  const op = await shared.submit({
    key: 'sfp:old',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  assert.equal(op.status, 'queued');
  assert.equal((await shared.status('sfp:old', { authorize: allowAll }))?.status, 'queued');
  assert.equal(await shared.endUnsent('sfp:old', intentOf(1)), false);
  assert.equal(base.sends.length, 0);
  // Its own facilitator still finishes it.
  await own.submit({
    key: 'sfp:old2',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  assert.equal(base.sends.length, 1);
  const tx = base.sends[0]!;
  assert.equal(
    (await recoverTransactionAddress({ serializedTransaction: tx as never })).toLowerCase(),
    (await own.address()).toLowerCase(),
  );
});

test('both groups due in one cycle: the engine group is served first (lower nonce)', async (t) => {
  const { base, clock, facilitator } = await setup(t, {
    batch: { maxItems: 50, windowMs: 1_500, groups: [{ ...SFP, maxItems: 50 }] },
  });
  for (const i of [1, 2]) {
    await facilitator.submit({
      key: `sfp:s${i}`,
      intentHash: intentOf(10 + i),
      settlement: member(10 + i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
    await facilitator.submit({
      key: `feed-pay:pay:e${i}`,
      intentHash: intentOf(i),
      settlement: member(i),
      beforeBroadcast: ok,
      batch: { authorize: allowAll, grant: null },
    });
  }
  clock.now += 2_000;
  // The engine's flush is under way but slow (its authority check takes a while); the sponsored
  // flush asked meanwhile waits for it, so the engine's batch takes the lane's nonce first.
  const slow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Set<string>();
  };
  const engine = facilitator.flushBatches(slow, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all([facilitator.flushBatches(allowAll, true, undefined, 'sfp:'), engine]);
  assert.equal(base.sends.length, 2);
  const [first, second] = base.sends.map(batchOf);
  assert.equal(first!.nonce, 0);
  assert.equal(first!.data, encodeSettleBatch([member(1), member(2)]), 'engine batch first');
  assert.equal(second!.nonce, 1);
  assert.equal(second!.data, encodeSettleBatch([member(11), member(12)]));
});

test('fail closed: a group flush or a batch request without an authorize never batches', async (t) => {
  const { base, clock, facilitator, row } = await setup(t, {
    batch: { maxItems: 50, windowMs: 1_500, groups: [SFP], groupsOnly: true },
  });
  await facilitator.submit({
    key: 'sfp:w1',
    intentHash: intentOf(1),
    settlement: member(1),
    beforeBroadcast: ok,
    batch: { authorize: allowAll, grant: null },
  });
  clock.now += 2_000;
  await facilitator.flushBatches(undefined as never, true, undefined, 'sfp:');
  assert.equal(base.sends.length, 0, 'nothing sent unjudged');
  assert.equal((await row('sfp:w1')).batch_key, null);
  await facilitator.submit({
    key: 'sfp:w2',
    intentHash: intentOf(2),
    settlement: member(2),
    beforeBroadcast: ok,
    batch: { authorize: undefined as never, grant: null },
  });
  assert.equal((await row('sfp:w2')).batch_lane, false, 'not on the batch lane');
});
