import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex, PublicClient } from 'viem';
import { BASE_MAINNET, baseNetwork, type Address } from '../shared/base/chains.js';
import {
  chainCheckIntervalMs,
  MOVING_CHECK_MAX_MS,
  SETTLING_CHECK_MS,
  settlingCanWait,
  type IdentityRow,
} from '../server/base/identity/service.js';
import {
  refreshFinality,
  type Bundler,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';

/*
 * The identity service's call budget rules (service.ts): how often one registration's chain is
 * asked (chainCheckIntervalMs) and when a settling advance can skip the chain (settlingCanWait),
 * and submit.ts reading the settled head only where a decision needs it. Synthetic values only.
 */

const NOW = 1_760_000_000_000;

/** A registration whose mint and hand-over both landed (the settling stages). */
const settlingRow = (overrides: Partial<IdentityRow> = {}): IdentityRow => ({
  agent_id: 'a1',
  chain_id: BASE_MAINNET,
  state: 'submitted',
  op_id: 'identity:transfer:8453:a1~7',
  tx_hash: '0x01',
  updated_at: String(NOW),
  erc8004_agent_id: null,
  agent_card_uri: 'https://centralcity.ai/a/abc123',
  registry_address: '0x8004',
  register_op_id: 'identity:register:8453:a1',
  mint_op_id: 'identity:register:8453:a1',
  provisional_agent_id: '7',
  mint_tx_hash: '0x01',
  mint_block: '1000',
  mint_seen_at: String(NOW),
  mint_lost_at: null,
  transfer_op_id: 'identity:transfer:8453:a1~7',
  handover_id: '7',
  handover_tx_hash: '0x02',
  evidence_rev: '3',
  started_at: String(NOW),
  mint_block_hash: '0xaa',
  mint_finality: 'included',
  handover_block: '1004',
  handover_block_hash: '0xbb',
  handover_finality: 'included',
  destination_mismatch: null,
  handover_refusals: 0,
  handover_retry_at: null,
  register_refusals: 0,
  register_retry_at: null,
  ...overrides,
});

test('chain check interval: settling every 30 s; in flight at the panel pace, then once a minute', () => {
  assert.equal(chainCheckIntervalMs(settlingRow(), NOW), SETTLING_CHECK_MS);
  const registering = settlingRow({
    mint_op_id: null,
    provisional_agent_id: null,
    transfer_op_id: null,
    handover_id: null,
    handover_tx_hash: null,
  });
  assert.equal(chainCheckIntervalMs(registering, NOW), 2000, 'just moved: the panel pace');
  assert.equal(chainCheckIntervalMs(registering, NOW + 20_000), 10_000);
  assert.equal(chainCheckIntervalMs(registering, NOW + 60_000), 30_000);
  assert.equal(chainCheckIntervalMs(registering, NOW + 10 * 60_000), MOVING_CHECK_MAX_MS);
  assert.equal(MOVING_CHECK_MAX_MS, 60_000, 'never slower than the finalize cron');
  const handingOver = settlingRow({ handover_tx_hash: null, handover_block: null });
  assert.equal(chainCheckIntervalMs(handingOver, NOW), 3000);
});

test('settling gate: skip only while no head has reached a block that could deepen', () => {
  const below = { safe: 999n, finalized: 400n };
  assert.equal(settlingCanWait(settlingRow(), below), true, 'both included, safe below both');
  // A head reached one of the blocks: the full check runs.
  assert.equal(settlingCanWait(settlingRow(), { safe: 1000n, finalized: 400n }), false);
  assert.equal(
    settlingCanWait(settlingRow({ mint_finality: 'safe' }), { safe: 1003n, finalized: 400n }),
    true,
    'mint already safe, hand-over not yet',
  );
  assert.equal(
    settlingCanWait(settlingRow({ mint_finality: 'safe' }), { safe: 1004n, finalized: 400n }),
    false,
  );
  // Both safe: only the finalized head reaching a block counts.
  const bothSafe = settlingRow({ mint_finality: 'safe', handover_finality: 'safe' });
  assert.equal(settlingCanWait(bothSafe, { safe: 5000n, finalized: 999n }), true);
  assert.equal(settlingCanWait(bothSafe, { safe: 5000n, finalized: 1000n }), false);
  // The mint is final (its id is): only the hand-over's block matters.
  const mintFinal = settlingRow({
    erc8004_agent_id: '7',
    mint_finality: 'final',
    handover_finality: 'safe',
  });
  assert.equal(settlingCanWait(mintFinal, { safe: 5000n, finalized: 1003n }), true);
  assert.equal(settlingCanWait(mintFinal, { safe: 5000n, finalized: 1004n }), false);
  // Unknown heads or blocks, a final hand-over (confirmation pending), a lost mint, a recheck or
  // any other stage: never skipped.
  assert.equal(settlingCanWait(settlingRow(), { safe: null, finalized: 400n }), false);
  assert.equal(settlingCanWait(bothSafe, { safe: 5000n, finalized: null }), false);
  assert.equal(settlingCanWait(settlingRow({ handover_block: null }), below), false);
  assert.equal(settlingCanWait(settlingRow({ mint_finality: null }), below), false);
  assert.equal(
    settlingCanWait(settlingRow({ erc8004_agent_id: '7', handover_finality: 'final' }), below),
    false,
  );
  assert.equal(settlingCanWait(settlingRow({ mint_lost_at: String(NOW) }), below), false);
  assert.equal(
    settlingCanWait(settlingRow({ destination_mismatch: 'owner_mismatch' }), below),
    false,
  );
  assert.equal(settlingCanWait(settlingRow({ handover_tx_hash: null }), below), false);
  assert.equal(settlingCanWait(settlingRow({ state: 'confirmed' }), below), false);
});

const network = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;

const stored = (overrides: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: 'op:1',
  intentHash: `0x${'11'.repeat(32)}`,
  chainId: BASE_MAINNET,
  kind: 'register',
  sender: '0x1111111111111111111111111111111111111111',
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation: JSON.stringify({
    sender: '0x1111111111111111111111111111111111111111',
    nonce: '5',
    initCode: '0x',
    callData: '0x',
    callGasLimit: '1',
    verificationGasLimit: '1',
    preVerificationGas: '1',
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '1',
    paymasterAndData: '0x',
    signature: '0x',
  }),
  status: 'submitted',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: '1000',
  errorCode: null,
  updatedAt: NOW,
  ...overrides,
});

test('an operation still in flight is refreshed without reading the settled head', async () => {
  for (const shape of [
    {},
    { status: 'unknown' as const, errorCode: 'BROADCAST_AMBIGUOUS' },
    { status: 'reorged' as const, errorCode: 'RECEIPT_GONE' },
  ]) {
    const row = stored(shape);
    const reads: string[] = [];
    const client = {
      getBlock: async (args: { blockTag?: string }) => {
        reads.push(`getBlock:${args.blockTag}`);
        return { number: 900n, hash: `0x${'bb'.repeat(32)}` };
      },
      getBlockNumber: async () => (reads.push('blockNumber'), 1100n),
      readContract: async () => (reads.push('getNonce'), 5n),
    } as unknown as PublicClient;
    const store: ChainOperationStore = {
      get: async () => ({ ...row }),
      insert: async (r) => r,
      update: async (_key, patch) => ({ ...row, ...patch }),
      transition: async (_key, _from, patch) => ({ ...row, ...patch }),
    };
    const bundler: Bundler = {
      prepare: async (op) => op,
      send: async () => OP_HASH,
      receipt: async () => null,
    };
    await refreshFinality(
      {
        network,
        client,
        store,
        bundler,
        now: () => NOW + 1,
        signer: { address: row.signer as Address, signUserOperation: async () => '0x' },
      },
      'op:1',
    );
    assert.ok(!reads.some((read) => read.startsWith('getBlock:')), `${row.status}: ${reads}`);
    assert.ok(reads.includes('getNonce'), 'the nonce is still read on every poll');
  }
});
