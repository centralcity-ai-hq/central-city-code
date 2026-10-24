/**
 * Fee router 3 (docs/protocol/FEE_ROUTER_3.md): a Central City service payment settled as an x402
 * payment. The agent's spender account signs two EIP-3009 authorizations off-chain (90% to the
 * seller, 10% to the treasury, nonces bound to one purchase by the router), and Central City's own
 * facilitator sends one router3.settle transaction, paying its gas in ETH. No UserOperation and no
 * paymaster for the sale itself; the float (pot) and its top-ups stay exactly as for routers 1/2.
 *
 * The switch, in one place for the engine and the offer store: live only while protocol fees are
 * on, router 3 is configured (CITY_PROTOCOL_FEE_ROUTER3), CITY_PROTOCOL_FEE_ROUTER3_ENABLED is
 * exactly '1' and a facilitator is wired (the engine checks the last one).
 */
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToHex,
  toEventSelector,
  type Hex,
} from 'viem';
import type { FeedPayOp } from '../../base/chain/feed-pay-chain.js';
import { FEE_ROUTER3_FLAG } from '../../../shared/protocol.js';
import { protocolFeesEnabled, protocolRouter3FromEnv } from '../../protocol/fees/cron.js';
import { feeEventsOf } from '../../protocol/fees/fee-call.js';

/**
 * Router 3's address from the one parser the ledger uses too (protocolRouter3FromEnv:
 * CITY_PROTOCOL_FEE_ROUTER3 and its FROM_BLOCK), checksummed; null when unset or invalid.
 */
export function router3AddressFromEnv(env: Record<string, string | undefined>): Hex | null {
  const found = protocolRouter3FromEnv(env)[0]?.address;
  return found ? (getAddress(found) as Hex) : null;
}

/**
 * The batch lane's allowlist (room Stress Test #200): workspace ids (operator_id, decided by the
 * server, never by the caller) whose router-3 settlements go out in settleBatch transactions from
 * the same facilitator. Empty or unset: nothing is batched.
 */
export const PAY_BATCH_WORKSPACES_ENV = 'CITY_PAY_BATCH_WORKSPACES';
export function batchWorkspacesFromEnv(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env[PAY_BATCH_WORKSPACES_ENV] ?? '')
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** New fee-included payments may be pinned to router 3 (the facilitator is checked by the engine). */
export function feeRouter3Live(env: Record<string, string | undefined>): boolean {
  return (
    env[FEE_ROUTER3_FLAG]?.trim() === '1' &&
    protocolFeesEnabled(env) &&
    router3AddressFromEnv(env) !== null
  );
}

/** Router 3's immutable cap (MAX_TOTAL): 100 USDC, fee included, like router 2. */
export const MAX_TOTAL_ROUTER3 = 100_000_000n;
/** Router 3's smallest fee-included price (MIN_INCLUDED): 0.05 USDC, like quoteFeeIncluded. */
export const MIN_INCLUDED_ROUTER3 = 50_000n;
/**
 * How long a router-3 pair stays valid (validBefore - now at signing). Short on purpose: a pair
 * whose settlement did not go through is only declared unpaid once Base's safe block is past it and
 * both nonces are unused, so this bounds how long such a call waits.
 */
export const ROUTER3_VALIDITY_S = 600;

export const LEG_SELLER = 0;
export const LEG_FEE = 1;
export const ROUTER3_NONCE_TAG = keccak256(stringToHex('centralcity.router3.settle.v1'));

export const ROUTER3_ABI = parseAbi([
  'struct Settlement { address payer; address payee; uint256 gross; bytes32 ref; uint256 validAfter; uint256 validBefore; bytes sellerSignature; bytes feeSignature; }',
  'function settle(Settlement s) returns (uint256 fee)',
  'function nonceFor(address payer, address payee, uint256 gross, bytes32 ref, uint256 validAfter, uint256 validBefore, uint8 leg) view returns (bytes32)',
  'function MIN_INCLUDED() view returns (uint256)',
]);

/**
 * The EIP-3009 nonce of one leg, exactly as CentralCityFeeRouter3.nonceFor derives it (PR #500 from
 * 58699aa5): tag, chain id, router, treasury, payer, payee, gross, ref, both validity bounds, leg.
 */
export function router3Nonce(input: {
  chainId: number;
  router: Hex;
  treasury: Hex;
  payer: Hex;
  payee: Hex;
  gross: bigint;
  ref: Hex;
  validAfter: bigint;
  validBefore: bigint;
  leg: typeof LEG_SELLER | typeof LEG_FEE;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint8' },
      ],
      [
        ROUTER3_NONCE_TAG,
        BigInt(input.chainId),
        getAddress(input.router),
        getAddress(input.treasury),
        getAddress(input.payer),
        getAddress(input.payee),
        input.gross,
        input.ref,
        input.validAfter,
        input.validBefore,
        input.leg,
      ],
    ),
  );
}

/** One router-3 settlement, as router3.settle takes it. */
export interface Router3Settlement {
  payer: Hex;
  payee: Hex;
  gross: bigint;
  ref: Hex;
  validAfter: bigint;
  validBefore: bigint;
  sellerSignature: Hex;
  feeSignature: Hex;
}

export const router3SettleData = (s: Router3Settlement): Hex =>
  encodeFunctionData({ abi: ROUTER3_ABI, functionName: 'settle', args: [s] });

/**
 * Central City's own x402 facilitator for router 3 (server/protocol/x402/facilitator.ts): one
 * stored transaction per key, sent from its EOA, followed like a chain operation.
 */
/** The engine's authority check for batch members, by op key: the keys refused now. */
export type BatchAuthorize = (keys: string[]) => Promise<Set<string>>;

export interface Router3FacilitatorPort {
  submit(input: {
    key: string;
    intentHash: Hex;
    settlement: Router3Settlement;
    beforeBroadcast: () => Promise<void>;
    /** grant null: no MCP grant applies (batch-eligible); left out: never batched. */
    batch?: { authorize: BatchAuthorize; grant?: { kind: 'grant' | 'key'; id: string } | null };
  }): Promise<FeedPayOp>;
  status(key: string, batch?: { authorize: BatchAuthorize }): Promise<FeedPayOp | null>;
  /**
   * Sends what the batch lane holds (a facilitator without a batch config does nothing). `group`:
   * the batch group served (its key prefix, facilitator.ts FacilitatorBatchConfig.groups); left out,
   * the default group.
   */
  flushBatches?(
    authorize: BatchAuthorize,
    force?: boolean,
    deadline?: number,
    group?: string,
  ): Promise<void>;
  /** Whether this facilitator's EOA stored the settlement of this key (optional). */
  holds?(key: string): Promise<boolean>;
  endUnsent(key: string, intentHash: Hex): Promise<boolean>;
  /** False while the EOA cannot pay for a settlement (low ETH): nothing new is pinned or sent. */
  canPay(): Promise<boolean>;
  /** The EOA's ETH balance (wei), read live (optional). */
  ethBalance?(): Promise<bigint>;
  /**
   * Marks final, in one bounded batch, the included settlements whose block is at or below Base's
   * finalized head and still canonical (stored block hash = the chain's at that height), within
   * the given blocks, rows and wall-time budget. Answers how many rows it moved. Optional: a port
   * without it leaves finality to status().
   */
  finalizeIncluded?(limits: {
    maxBlocks: number;
    maxRows: number;
    budgetMs: number;
  }): Promise<number>;
}

const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const ERC20_TRANSFER_TOPIC = toEventSelector(ERC20_TRANSFER);

/**
 * The USDC Transfers that belong to ONE router-3 payment in a receipt: those between the previous
 * FeeCharged of the router and this payment's own FeeCharged (same payer and ref). Router 3 emits,
 * per settlement: AuthorizationUsed, Transfer (seller leg), AuthorizationUsed, Transfer (fee leg),
 * FeeCharged (verified on Base, tx 0xa5cf…7a89). A settleBatch receipt carries many payments, maybe
 * with the same payer, payee and price, so only this slice may count (batch lane, room #214/#221).
 * null: this payment's FeeCharged is not in the receipt, or a Transfer in its slice is malformed.
 */
export function router3OwnTransfers(
  logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[],
  input: { chainId: number; router: Hex; usdc: Hex; payer: Hex; ref: Hex },
): { from: Hex; to: Hex; value: bigint }[] | null {
  const router = getAddress(input.router);
  const payer = getAddress(input.payer);
  const ref = input.ref.toLowerCase();
  const feeOf = (log: (typeof logs)[number]) => feeEventsOf(input.chainId, router, [log])[0];
  const own = logs.findIndex((log) => {
    const e = feeOf(log);
    return !!e && getAddress(e.payer) === payer && e.ref.toLowerCase() === ref;
  });
  if (own < 0) return null;
  let start = own;
  while (start > 0 && !feeOf(logs[start - 1]!)) start--;
  const out: { from: Hex; to: Hex; value: bigint }[] = [];
  for (const log of logs.slice(start, own)) {
    if (
      getAddress(log.address) !== getAddress(input.usdc) ||
      log.topics[0] !== ERC20_TRANSFER_TOPIC
    )
      continue;
    try {
      const { args } = decodeEventLog({
        abi: [ERC20_TRANSFER],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      out.push({ from: args.from, to: args.to, value: args.value });
    } catch {
      return null;
    }
  }
  return out;
}
