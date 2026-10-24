import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeErrorResult,
  keccak256,
  parseTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../../server/database.js';
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
} from '../../server/protocol/x402/facilitator.js';
import {
  X402_FACILITATOR_BATCH_SQL,
  X402_FACILITATOR_SQL,
} from '../../server/protocol/x402/facilitator-schema.js';

/* The facilitator tests' fake Base and setup (moved from tests/x402-facilitator.test.ts, shared with
 * tests/feed-pay-sponsored-facilitator.test.ts). */
export const ROUTER = `0x${'9'.repeat(40)}` as const;
export const CHAIN_ID = 84532;
export const INTENT = `0x${'11'.repeat(32)}` as Hex;
export const OTHER_INTENT = `0x${'22'.repeat(32)}` as Hex;

export const settlement = (gross = 1_000_000n): Router3Settlement => ({
  payer: `0x${'1'.repeat(40)}`,
  payee: `0x${'2'.repeat(40)}`,
  gross,
  ref: `0x${'ab'.repeat(32)}`,
  validAfter: 0n,
  validBefore: 2_000_000_000n,
  sellerSignature: `0x${'cd'.repeat(65)}`,
  feeSignature: `0x${'ef'.repeat(65)}`,
});

/** A small fake of Base: a mempool, receipts, nonces, blocks and a finalized head. */
export class FakeBase {
  balance = 10n ** 18n;
  baseFee = 1_000_000n;
  priority = 100_000n;
  gas = 160_000n;
  revertData: Hex | null = null;
  /** Reverts the simulation of exactly the calldata it matches (batch tests). */
  revertWhen: ((data: Hex) => boolean) | null = null;
  /** Simulations never answer (a stalled node). */
  hang = false;
  down = false;
  /** Transactions the node knows (mempool or mined). */
  known = new Map<Hex, Hex>();
  sends: Hex[] = [];
  receipts = new Map<
    Hex,
    { status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex }
  >();
  minedCount = 0;
  /** The account's transaction count at the finalized block (null: same as latest). */
  finalizedCount: number | null = null;
  finalized = 0n;
  blocks = new Map<bigint, Hex>();
  estimates = 0;
  /** What the L1 fee oracle answers, and every serialized transaction it was asked about. */
  l1Fee = 0n;
  l1Asked: Hex[] = [];

  mine(hash: Hex, blockNumber: bigint, status: 'success' | 'reverted' = 'success') {
    const blockHash = keccak256(`0x${blockNumber.toString(16).padStart(8, '0')}aa` as Hex);
    this.blocks.set(blockNumber, blockHash);
    this.receipts.set(hash, { status, blockNumber, blockHash });
    const nonce = parseTransaction(this.known.get(hash)!).nonce!;
    this.minedCount = Math.max(this.minedCount, nonce + 1);
  }

  private guard() {
    if (this.down) throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
  }

  client = {
    readContract: async (args: { address: string; functionName: string; args: [Hex] }) => {
      this.guard();
      assert.equal(args.address, '0x420000000000000000000000000000000000000F');
      assert.equal(args.functionName, 'getL1Fee');
      this.l1Asked.push(args.args[0]);
      return this.l1Fee;
    },
    getBalance: async () => {
      this.guard();
      return this.balance;
    },
    estimateGas: async (args?: { data?: Hex }) => {
      this.guard();
      this.estimates++;
      if (this.hang) await new Promise(() => {});
      if (args?.data && this.revertWhen?.(args.data))
        throw new Error('Execution reverted', {
          cause: { name: 'RpcRequestError', code: 3, message: 'execution reverted', data: '0x' },
        });
      if (this.revertData)
        throw new Error('Execution reverted', {
          cause: {
            name: 'RpcRequestError',
            code: 3,
            message: 'execution reverted',
            data: this.revertData,
          },
        });
      return this.gas;
    },
    estimateMaxPriorityFeePerGas: async () => {
      this.guard();
      return this.priority;
    },
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
      this.guard();
      if (args.blockTag === 'latest')
        return { number: 100n, hash: `0x${'01'.repeat(32)}`, baseFeePerGas: this.baseFee };
      if (args.blockTag === 'finalized')
        return {
          number: this.finalized,
          hash: this.blocks.get(this.finalized) ?? `0x${'02'.repeat(32)}`,
        };
      return { number: args.blockNumber, hash: this.blocks.get(args.blockNumber!) ?? null };
    },
    getTransactionCount: async (args: { blockTag: string }) => {
      this.guard();
      if (args.blockTag === 'finalized') return this.finalizedCount ?? this.minedCount;
      return this.minedCount;
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      this.guard();
      const hash = keccak256(serializedTransaction);
      this.sends.push(serializedTransaction);
      this.known.set(hash, serializedTransaction);
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      this.guard();
      const r = this.receipts.get(hash);
      if (!r) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: hash, ...r };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      this.guard();
      if (!this.known.has(hash)) throw new TransactionNotFoundError({ hash });
      return { hash };
    },
  } as unknown as PublicClient;
}

export async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: {
    minBalanceWei?: bigint;
    caps?: Partial<FacilitatorCaps>;
    l1FeeWei?: (unsignedTx: Hex) => Promise<bigint>;
    batch?: FacilitatorBatchConfig;
    foreignReadOnly?: boolean;
  } = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(X402_FACILITATOR_BATCH_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const account = privateKeyToAccount(generatePrivateKey());
  const base = new FakeBase();
  const clock = { now: 1_000_000 };
  const lines: string[] = [];
  const facilitator = createRouter3Facilitator({
    db,
    client: base.client,
    keystore: { withSigner: async (_ref, use) => use(account) },
    keyRef: `v1:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
    router: ROUTER,
    chainId: CHAIN_ID,
    now: () => clock.now,
    log: (line) => lines.push(line),
    l1FeeWei: async () => 0n,
    ...options,
  });
  const row = async (key: string) =>
    (
      await pg.query<Record<string, unknown>>(
        'SELECT *, nonce::text AS nonce FROM x402_facilitator_ops WHERE op_key = $1',
        [key],
      )
    ).rows[0];
  return { db, pg, base, clock, facilitator, account, row, lines };
}
