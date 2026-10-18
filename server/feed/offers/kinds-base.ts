/*
 * The Base kinds (base-usdc-balance, base-block; base-tx, base-erc20-balance and base-gas are in
 * kinds-base-tx.ts and share this file's reader and read helpers): read-only reads of Base
 * mainnet through one reader set at startup (setOfferKindDeps({ readBase }), kind-core.ts;
 * offerBaseReaderFromEnv builds it from the server's Base read settings). Until one is set, every read refuses with
 * 'unavailable' (503): a chain kind never answers from nothing.
 *
 *   - every answer names the block it describes: the balance is read AT the latest block's number,
 *     so both describe the same moment; base-block answers the block asked for, or the latest
 *   - one read waits at most BASE_READ_TIMEOUT_MS ('timeout', 504) and stops when ctx.signal
 *     aborts; a malformed or failed answer is 'chain_unavailable' (502), never a zero
 *   - check() holds every refusal of the input alone (the schema; the address's checksum), so it
 *     comes before payment. A block number past the chain's head depends on the chain, not the
 *     input: it is a failure of the paid call ('block_not_found', 422, retryable: the block may
 *     exist later); the latest block is read only to tell that apart from a failed read
 *   - a reader that is not configured (setOfferKindDeps({ readBase: null })) answers 'unavailable'
 *     (503) for every read
 */
import { createPublicClient, getAddress, isAddress, parseAbi, type Hex } from 'viem';
import {
  BASE_MAINNET,
  BASE_NETWORKS,
  baseNetwork,
  type Address,
  type BaseNetwork,
} from '../../../shared/base/chains.js';
import { OFFER_KIND_SPECS } from '../../../shared/feed-offers.js';
import { baseReadTransport, baseReadUrls } from '../../base/chain/read-transport.js';
import {
  checked,
  jsonAnswer,
  offerKindDeps,
  OfferKindFailure,
  OfferKindInputError,
  pureKind,
  type OfferKind,
  type OfferKindContext,
} from './kind-core.js';

/** USDC on Base mainnet. */
export const BASE_USDC: Address = BASE_NETWORKS[BASE_MAINNET].tokens.USDC.address;
export const USDC_DECIMALS = 6;
export const USDC_BALANCE_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);
export const BASE_READ_TIMEOUT_MS = 5_000;

export interface OfferBaseBlock {
  number: bigint | null;
  hash: string | null;
  timestamp: bigint;
}

/** A transaction as base-tx reads it (a subset of viem's). */
export interface OfferBaseTransaction {
  hash: string;
  blockNumber: bigint | null;
  from: string;
  to: string | null;
  value: bigint;
}

/** A transaction receipt as base-tx reads it (a subset of viem's). */
export interface OfferBaseReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: string;
  from: string;
  to: string | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}

/** eth_feeHistory as base-gas reads it (a subset of viem's). */
export interface OfferBaseFeeHistory {
  oldestBlock: bigint;
  baseFeePerGas: readonly bigint[];
  reward?: ReadonlyArray<readonly bigint[]>;
}

/**
 * The Base reads the chain kinds need, a subset of a viem PublicClient (one for Base mainnet,
 * chain 8453, can be passed as it is). getTransaction and getTransactionReceipt answer null for a
 * transaction the chain does not have (offerBaseReader turns viem's not-found errors into null).
 */
export interface OfferBaseReader {
  getBlock(args: { blockTag: 'latest' } | { blockNumber: bigint }): Promise<OfferBaseBlock>;
  readContract(args: {
    address: Address;
    abi: typeof USDC_BALANCE_ABI;
    functionName: 'balanceOf';
    args: readonly [Address];
    blockNumber?: bigint;
  }): Promise<bigint>;
  /** eth_call, pinned to a block (base-erc20-balance). */
  call(args: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex }>;
  getTransaction(args: { hash: Hex }): Promise<OfferBaseTransaction | null>;
  getTransactionReceipt(args: { hash: Hex }): Promise<OfferBaseReceipt | null>;
  getFeeHistory(args: {
    blockCount: number;
    blockTag: 'latest';
    rewardPercentiles: number[];
  }): Promise<OfferBaseFeeHistory>;
  getGasPrice(): Promise<bigint>;
}

/** viem's answer for a transaction or receipt the node does not have. */
const NOT_FOUND = new Set(['TransactionNotFoundError', 'TransactionReceiptNotFoundError']);
const nullIfNotFound = (error: unknown) => {
  if (NOT_FOUND.has((error as { name?: unknown } | null)?.name as string)) return null;
  throw error;
};

/**
 * The production reader: Base mainnet through the server's read transport (the configured endpoint,
 * then the second one; chain/read-transport.ts). The endpoint must report chain 8453 before
 * anything it answers is used (checked once). The URLs may carry a key: never logged or returned.
 */
export function offerBaseReader(
  urls: string | readonly string[],
  network: BaseNetwork,
  timeoutMs = 3_000,
): OfferBaseReader {
  if (network.chainId !== BASE_MAINNET) throw new Error('The offer kinds read Base mainnet only.');
  const client = createPublicClient({
    transport: baseReadTransport(urls, { chainId: network.chainId, timeoutMs, purpose: 'offers' }),
  });
  let chainChecked = false;
  const checkChain = async () => {
    if (chainChecked) return;
    if ((await client.getChainId()) !== network.chainId)
      throw new Error('Not the expected network.');
    chainChecked = true;
  };
  return {
    async getBlock(args) {
      await checkChain();
      return client.getBlock(args);
    },
    async readContract(args) {
      await checkChain();
      return client.readContract(args);
    },
    async call(args) {
      await checkChain();
      return client.call(args);
    },
    async getTransaction(args) {
      await checkChain();
      return client.getTransaction(args).catch(nullIfNotFound);
    },
    async getTransactionReceipt(args) {
      await checkChain();
      return client.getTransactionReceipt(args).catch(nullIfNotFound);
    },
    async getFeeHistory(args) {
      await checkChain();
      return client.getFeeHistory(args);
    },
    async getGasPrice() {
      await checkChain();
      return client.getGasPrice();
    },
  };
}

/**
 * The reader from the server's settings: Base mainnet when its gate is open (CITY_BASE_MAINNET=1)
 * and its endpoint is set, with the second read endpoint; null otherwise (the kinds then answer
 * 'unavailable'). Building it reads nothing.
 */
export function offerBaseReaderFromEnv(
  env: Record<string, string | undefined>,
  options: { hosted?: boolean } = {},
): OfferBaseReader | null {
  const network = baseNetwork(BASE_MAINNET, env);
  if (!network) return null;
  const urls = baseReadUrls(env[network.bundlerEnv], env, network.chainId, options);
  return urls.length ? offerBaseReader(urls, network) : null;
}

export const TIMEOUT = Symbol('timeout');
export const FAILED = Symbol('failed');

/**
 * One chain read under the Base deadline. Throws the signal's reason when the call ends, and an
 * OfferKindFailure the reader threw (not configured) as it is; any other failure is FAILED.
 */
export async function chainRead<T>(
  read: () => Promise<T>,
  ctx: OfferKindContext,
): Promise<T | typeof TIMEOUT | typeof FAILED> {
  ctx.signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      // A reader that throws at once is a failed read too.
      Promise.resolve().then(read),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), BASE_READ_TIMEOUT_MS);
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(ctx.signal.reason);
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (error instanceof OfferKindFailure) throw error;
    return FAILED;
  } finally {
    clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

export const chainTimeout = () =>
  new OfferKindFailure('timeout', 'Base did not answer in time.', 504);
export const chainFailed = () =>
  new OfferKindFailure('chain_unavailable', 'Base could not be read.', 502);

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface CheckedBlock {
  number: bigint;
  hash: string;
  timestamp: bigint;
}

/** A block as read, checked: a whole number, a 32-byte hash and a plausible time; else null. */
function wellFormed(block: unknown): CheckedBlock | null {
  const value = block as Partial<OfferBaseBlock> | null | undefined;
  if (
    typeof value?.number !== 'bigint' ||
    value.number < 0n ||
    typeof value.hash !== 'string' ||
    !BLOCK_HASH.test(value.hash) ||
    typeof value.timestamp !== 'bigint' ||
    value.timestamp <= 0n ||
    value.timestamp > 2n ** 40n
  )
    return null;
  return { number: value.number, hash: value.hash.toLowerCase(), timestamp: value.timestamp };
}

export async function latestBlock(ctx: OfferKindContext): Promise<CheckedBlock> {
  const read = await chainRead(
    () => offerKindDeps().readBase.getBlock({ blockTag: 'latest' }),
    ctx,
  );
  if (read === TIMEOUT) throw chainTimeout();
  const block = read === FAILED ? null : wellFormed(read);
  if (!block) throw chainFailed();
  return block;
}

/**
 * Block `number`, or 'block_not_found' when it is past the head (the head is read only to tell
 * that apart from a failed read).
 */
export async function blockAt(number: bigint, ctx: OfferKindContext): Promise<CheckedBlock> {
  const read = await chainRead(
    () => offerKindDeps().readBase.getBlock({ blockNumber: number }),
    ctx,
  );
  if (read === TIMEOUT) throw chainTimeout();
  if (read !== FAILED && read !== null) {
    // An answer for another block, or a malformed one, is a failed read.
    const block = wellFormed(read);
    if (!block || block.number !== number) throw chainFailed();
    return block;
  }
  // No such block, or the read failed: past the head is the buyer's input, anything else not.
  const head = await latestBlock(ctx);
  if (number > head.number)
    throw new OfferKindFailure('block_not_found', 'number is past the latest block.', 422, {
      retryable: true,
    });
  throw chainFailed();
}

export const baseBlockKind: OfferKind = {
  name: 'base-block',
  inputSchema: OFFER_KIND_SPECS['base-block'].input,
  outputMime: OFFER_KIND_SPECS['base-block'].outputMime,
  check(input) {
    // Any whole number in the schema's range is a block number; whether it exists yet is the
    // chain's answer, read after payment.
    checked('base-block', input);
  },
  async run(input, ctx) {
    baseBlockKind.check(input);
    const { number } = checked('base-block', input);
    const block =
      number === undefined ? await latestBlock(ctx) : await blockAt(BigInt(number), ctx);
    const timestamp = Number(block.timestamp);
    return jsonAnswer({
      chainId: BASE_MAINNET,
      number: Number(block.number),
      hash: block.hash,
      timestamp,
      time: new Date(timestamp * 1000).toISOString(),
    });
  },
};

/** The address of a base-usdc-balance input, checksummed; OfferKindInputError when refused. */
function usdcBalanceAddress(input: unknown): Address {
  return checkedAddress(String(checked('base-usdc-balance', input).address), 'address');
}

/**
 * An address field, checksummed; OfferKindInputError naming the field when its mixed case is not
 * its EIP-55 checksum.
 */
export function checkedAddress(given: string, field: string): Address {
  // EIP-55: all lower case and all upper case carry no checksum; mixed case must match it.
  if (!isAddress(given) && !/^0x[0-9A-F]{40}$/.test(given))
    throw new OfferKindInputError(
      `${field} must be all lower case, all upper case, or mixed case with a valid checksum.`,
    );
  return getAddress(given);
}

export const baseUsdcBalanceKind: OfferKind = {
  name: 'base-usdc-balance',
  inputSchema: OFFER_KIND_SPECS['base-usdc-balance'].input,
  outputMime: OFFER_KIND_SPECS['base-usdc-balance'].outputMime,
  check(input) {
    usdcBalanceAddress(input);
  },
  async run(input, ctx) {
    const address = usdcBalanceAddress(input);
    const block = await latestBlock(ctx);
    // Read at that block, so the balance and the block number describe the same moment.
    const balance = await chainRead(
      () =>
        offerKindDeps().readBase.readContract({
          address: BASE_USDC,
          abi: USDC_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [address],
          blockNumber: block.number,
        }),
      ctx,
    );
    if (balance === TIMEOUT) throw chainTimeout();
    if (balance === FAILED || typeof balance !== 'bigint' || balance < 0n) throw chainFailed();
    const unit = 10n ** BigInt(USDC_DECIMALS);
    return jsonAnswer({
      address,
      chainId: BASE_MAINNET,
      token: 'USDC',
      assetAddress: BASE_USDC,
      balance: {
        raw: balance.toString(),
        display: `${balance / unit}.${(balance % unit).toString().padStart(USDC_DECIMALS, '0')}`,
        decimals: USDC_DECIMALS,
      },
      blockNumber: Number(block.number),
      blockHash: block.hash,
    });
  },
};

/**
 * address-checksum: the EIP-55 form of an address, and whether the input's own checksum holds. An
 * address all in lower or all in upper case carries no checksum ('none') and is valid; a mixed-case
 * one is valid only when its case is the checksum ('correct', else 'wrong'). No chain read.
 */
export function addressChecksum(address: string): {
  checksummed: Address;
  valid: boolean;
  checksum: 'none' | 'correct' | 'wrong';
} {
  const checksummed = getAddress(address.toLowerCase());
  const hex = address.slice(2);
  const checksum =
    hex === hex.toLowerCase() || hex === hex.toUpperCase()
      ? 'none'
      : address === checksummed
        ? 'correct'
        : 'wrong';
  return { checksummed, valid: checksum !== 'wrong', checksum };
}

export const addressChecksumKind = pureKind('address-checksum', ({ address }) =>
  jsonAnswer(addressChecksum(String(address))),
);
