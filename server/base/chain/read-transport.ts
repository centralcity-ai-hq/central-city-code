/*
 * Base reads with a second endpoint. The configured (CDP) endpoint also carries the paymaster, the
 * bundler and every wallet read, and it answers 429 under load; a read it cannot answer right now
 * is asked once of a second, keyless endpoint: CITY_BASE_READ_FALLBACK_RPC_URL, else (hosted only)
 * the network's public RPC. One setting for every read-only Base client of the server.
 *
 * What may be asked of the second endpoint, and why mixing two nodes inside one decision stays safe:
 *
 *   - Only reads whose answer the request itself fixes, or that carry their own proof:
 *       eth_chainId;
 *       eth_getBlockByNumber / eth_getBlockByHash (a block carries its hash; every consumer that
 *         concludes from a head re-checks it by hash, rpc-budget.ts);
 *       eth_call, eth_getBalance, eth_getCode, eth_getStorageAt, eth_getTransactionCount PINNED to a
 *         block number or hash (the same pin the caller chose; never 'latest', 'safe', 'finalized'
 *         or 'pending', which stay on the configured endpoint: nonce and code reads that feed an
 *         operation, and guards like NONCE_MOVED, must see that node's current state);
 *       eth_getTransactionReceipt / eth_getTransactionByHash;
 *       eth_getLogs over a closed numbered range or one block hash.
 *       eth_gasPrice and eth_maxPriorityFeePerGas: a fee quote, never a decision; the fee cap still
 *         bounds what is signed, and a low quote only waits longer (Audit 1: these were the reads the
 *         rate limit refused most).
 *     eth_blockNumber only where the caller opts in (`headNumberMayFallBack`): the standalone readers
 *     that pin their next read to that number. The chain runtime does not: its absence gates (a
 *     receipt declared gone up to a head, submit.ts) compare a bare head number with a search.
 *   - The second endpoint may prove presence, never absence: a null block, receipt or transaction
 *     and an empty log page from it are refused (the first endpoint's error stands), so "gone",
 *     "missing" and "absent" are only ever concluded from the configured endpoint, as before.
 *   - Everything else goes to the configured endpoint only, with its own retry policy: bundler and
 *     paymaster methods (eth_sendUserOperation, eth_estimateUserOperationGas,
 *     eth_getUserOperationReceipt/ByHash, pm_*), gas estimates and any send. (The
 *     bundler client, rpc-bundler.ts, never uses this transport at all: it posts to the configured
 *     URL itself.)
 *   - A revert, or any answer naming one, is an answer: it is never asked again elsewhere.
 *   - The second endpoint must report the expected chain id before it answers anything; a URL for
 *     another network is never used (checked once; a check that fails is not asked again for
 *     SECOND_BACKOFF_MS, the second endpoint is simply skipped meanwhile).
 *
 * So every answer from the second endpoint is one the first could also have given (a block, a
 * pinned state read, a receipt that exists), and every refusal is the error the caller already
 * handles today when the first endpoint fails. Neither URL is ever logged or put into an error.
 *
 * With `preferSecond` the order is reversed for exactly those reads (the identity port's evidence
 * reads, fee quotes and head hints, runtime.ts): the second endpoint is asked first, and only a
 * presence it proves is taken from it; an absence, a revert or a failure there is asked of the
 * configured endpoint. The same rules hold, only the configured endpoint's budget is spared. Two
 * more bounds keep that order from costing time or freshness:
 *   - the second endpoint gets PREFERRED_SECOND_TIMEOUT_MS per request (not viem's 10 s): a node
 *     that hangs costs one read that long, then is skipped for SECOND_BACKOFF_MS;
 *   - a 'safe' or 'finalized' block from it older than STALE_TAGGED_HEAD_MS (by its timestamp) is
 *     treated as absent: a public node stuck on an old head would otherwise hold every finality
 *     check (and the settling gate's hints) at "not yet" forever.
 */
import { http, type EIP1193RequestFn, type HttpTransportConfig, type Transport } from 'viem';
import { countingFetch } from './rpc-count.js';
import { BASE_MAINNET, BASE_SEPOLIA } from '../../../shared/base/chains.js';
import { PUBLIC_BASE_RPC } from '../../../shared/base/on-base.js';

/**
 * preferSecond: the second endpoint's per-request timeout. A healthy public node answers in well
 * under a second; past this the configured endpoint is asked instead.
 */
export const PREFERRED_SECOND_TIMEOUT_MS = 2500;

/** How long a second endpoint that failed its chain-id check (or timed out first) is skipped. */
export const SECOND_BACKOFF_MS = 60_000;

/**
 * preferSecond: how old (by block timestamp) a tagged head from the second endpoint may be before
 * it is treated as absent. On Base mainnet 'safe' trails the head by about 1-3 minutes (the L1
 * batch inclusion) and 'finalized' by about 15-25 minutes (two L1 epochs after the batch); the
 * limits are a few times those lags, so only a node that stopped following the chain is passed
 * over.
 */
export const STALE_TAGGED_HEAD_MS: Readonly<Record<'safe' | 'finalized', number>> = Object.freeze({
  safe: 10 * 60_000,
  finalized: 45 * 60_000,
});

/** The one setting for the second read endpoint of every Base read. */
export const READ_FALLBACK_SETTING = 'CITY_BASE_READ_FALLBACK_RPC_URL';

/** The keyless public RPC per network, used as the second read endpoint when hosted. */
export const PUBLIC_READ_RPC: Readonly<Record<number, string>> = Object.freeze({
  [BASE_MAINNET]: PUBLIC_BASE_RPC,
  [BASE_SEPOLIA]: 'https://sepolia.base.org',
});

/**
 * The read endpoints of a network: the configured one first, then the second one (the setting,
 * else the network's public RPC when hosted), never the same URL twice. Empty without a primary.
 */
export function baseReadUrls(
  primary: string | undefined,
  env: Record<string, string | undefined>,
  chainId: number,
  options: { hosted?: boolean } = {},
): string[] {
  const first = primary?.trim();
  if (!first) return [];
  const second =
    env[READ_FALLBACK_SETTING]?.trim() || (options.hosted ? PUBLIC_READ_RPC[chainId] : undefined);
  return second && second !== first ? [first, second] : [first];
}

export interface ReadTransportOptions {
  /** The network both endpoints must serve. */
  chainId: number;
  /** Per-request timeout of each endpoint (viem's default when absent). */
  timeoutMs?: number;
  /** The configured endpoint's retry policy for what only it answers (none by default). */
  retry?: Pick<HttpTransportConfig, 'retryCount' | 'retryDelay'>;
  /** eth_blockNumber may be answered by the second endpoint (see the module header). */
  headNumberMayFallBack?: boolean;
  /**
   * Ask the second endpoint FIRST for what it may answer, to keep those reads off the configured
   * endpoint's budget. Only presence is taken from it: an absence (null, empty logs), a revert or
   * any failure there is asked of the configured endpoint, exactly as without a second endpoint,
   * so "gone", "missing", "absent" and a revert are still only ever concluded from the configured
   * endpoint. Everything else (unpinned reads, bundler, paymaster) goes to the configured endpoint
   * only, as always.
   */
  preferSecond?: boolean;
  /** preferSecond: the second endpoint's per-request timeout (PREFERRED_SECOND_TIMEOUT_MS). */
  secondTimeoutMs?: number;
  /** The clock tagged heads and the back-off are measured with (Date.now). */
  now?: () => number;
  /** What these reads are for, in the per-minute request count (rpc-count.ts); 'read' by default. */
  purpose?: string;
}

type Args = { method: string; params?: unknown };

const HEX_NUMBER = /^0x[0-9a-fA-F]+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** A block parameter that names one block: a number, or an EIP-1898 object with a number or hash. */
function pinned(block: unknown): boolean {
  if (typeof block === 'string') return HEX_NUMBER.test(block);
  if (!block || typeof block !== 'object') return false;
  const { blockHash, blockNumber } = block as { blockHash?: unknown; blockNumber?: unknown };
  return (
    (typeof blockHash === 'string' && HASH.test(blockHash)) ||
    (typeof blockNumber === 'string' && HEX_NUMBER.test(blockNumber))
  );
}

/** Where the block parameter sits, for the state reads that may be pinned. */
const STATE_READ_BLOCK: Readonly<Record<string, number>> = {
  eth_call: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
};

/** Whether the second endpoint may answer this request (see the module header). */
export function mayFallBack(
  args: Args,
  options: Pick<ReadTransportOptions, 'headNumberMayFallBack'> = {},
) {
  const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
  switch (args.method) {
    case 'eth_chainId':
    case 'eth_getBlockByHash':
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return true;
    case 'eth_blockNumber':
      return options.headNumberMayFallBack === true;
    case 'eth_getBlockByNumber':
      return params[0] !== 'pending';
    case 'eth_getLogs': {
      const filter = params[0] as { blockHash?: unknown; fromBlock?: unknown; toBlock?: unknown };
      if (!filter || typeof filter !== 'object') return false;
      if (typeof filter.blockHash === 'string') return HASH.test(filter.blockHash);
      return (
        typeof filter.fromBlock === 'string' &&
        HEX_NUMBER.test(filter.fromBlock) &&
        typeof filter.toBlock === 'string' &&
        HEX_NUMBER.test(filter.toBlock)
      );
    }
    default: {
      const at = STATE_READ_BLOCK[args.method];
      // Exactly the read and its block: a state override (a third eth_call parameter) stays home.
      return at !== undefined && params.length === at + 1 && pinned(params[at]);
    }
  }
}

/** An answer that says something is not there: never taken from the second endpoint. */
function absence(method: string, answer: unknown): boolean {
  if (answer === null || answer === undefined) return true;
  return method === 'eth_getLogs' && Array.isArray(answer) && answer.length === 0;
}

/**
 * A 'safe' or 'finalized' block whose timestamp is older than its limit (or that has none): from a
 * node that stopped following the chain. Never taken from the second endpoint in preferSecond mode.
 */
export function staleTaggedHead(args: Args, answer: unknown, now: number): boolean {
  if (args.method !== 'eth_getBlockByNumber') return false;
  const tag = Array.isArray(args.params) ? (args.params as unknown[])[0] : undefined;
  if (tag !== 'safe' && tag !== 'finalized') return false;
  const timestamp = (answer as { timestamp?: unknown } | null)?.timestamp;
  if (typeof timestamp !== 'string' || !HEX_NUMBER.test(timestamp)) return true;
  return now - Number(BigInt(timestamp)) * 1000 > STALE_TAGGED_HEAD_MS[tag];
}

/**
 * A request that ran out of its time anywhere in the cause chain: viem's TimeoutError, or the
 * fetch it aborted on that timeout (an AbortError; no caller here aborts a read itself).
 */
function timedOut(error: unknown): boolean {
  for (
    let e = error as { name?: unknown; cause?: unknown } | null, depth = 0;
    e && depth < 8;
    e = e.cause as typeof e, depth++
  )
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  return false;
}

const REVERTED = /execution reverted|\breverted\b/i;

/** A revert (or an error naming one) anywhere in the error's cause chain. */
export function reverted(error: unknown): boolean {
  for (
    let e = error as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        cause?: unknown;
      } | null,
      depth = 0;
    e && depth < 8;
    e = e.cause as typeof e, depth++
  ) {
    if (e.code === 3) return true;
    if (typeof e.details === 'string' && REVERTED.test(e.details)) return true;
    if (typeof e.message === 'string' && REVERTED.test(e.message)) return true;
  }
  return false;
}

/**
 * A viem transport over `urls`: the first is the configured endpoint, a second one (if any) answers
 * the reads listed in the module header when the first fails. With one URL it is the first
 * endpoint's plain HTTP transport.
 */
export function baseReadTransport(
  urls: string | readonly string[],
  options: ReadTransportOptions,
): Transport {
  const list = (typeof urls === 'string' ? [urls] : [...urls]).map((u) => u.trim()).filter(Boolean);
  const first = list[0];
  if (!first) throw new Error('No Base read endpoint.');
  const base: HttpTransportConfig =
    options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs };
  const purpose = options.purpose ?? 'read';
  const configured = `${purpose}:configured`;
  const primary = http(first, {
    ...base,
    retryCount: 0,
    ...options.retry,
    fetchFn: countingFetch(configured),
  });
  const second = list.find((u) => u !== first);
  if (!second) return primary;
  // Asked once each: a failure moves on to the second endpoint at once instead of waiting out a retry.
  const firstOnce = http(first, { ...base, retryCount: 0, fetchFn: countingFetch(configured) });
  // Asked first, it must not hold a read up for long (PREFERRED_SECOND_TIMEOUT_MS).
  const secondOnce = http(second, {
    ...(options.preferSecond
      ? { timeout: options.secondTimeoutMs ?? PREFERRED_SECOND_TIMEOUT_MS }
      : base),
    retryCount: 0,
    fetchFn: countingFetch(`${purpose}:second`),
  });
  const now = options.now ?? (() => Date.now());
  return (params) => {
    const home = primary(params);
    const once = firstOnce(params);
    const other = secondOnce(params);
    let sameChain: boolean | null = null;
    let checking: Promise<boolean> | null = null;
    /** Until when the second endpoint is skipped (a failed chain-id check, a timeout first). */
    let skipUntil = 0;
    const otherServesChain = (): Promise<boolean> => {
      if (sameChain !== null) return Promise.resolve(sameChain);
      if (now() < skipUntil) return Promise.resolve(false);
      // One check at a time: concurrent reads share it.
      checking ??= (async () => {
        try {
          const id = await other.request({ method: 'eth_chainId' } as never);
          sameChain = typeof id === 'string' && Number(id) === options.chainId;
          return sameChain;
        } catch {
          skipUntil = now() + SECOND_BACKOFF_MS;
          return false;
        } finally {
          checking = null;
        }
      })();
      return checking;
    };
    const request = (async (args: Args, requestOptions?: unknown) => {
      if (!mayFallBack(args, options)) return home.request(args as never, requestOptions as never);
      if (options.preferSecond) {
        try {
          if (now() >= skipUntil && (await otherServesChain())) {
            const answer = await other.request(args as never, requestOptions as never);
            // Presence only, and a tagged head only while it is recent.
            if (!absence(args.method, answer) && !staleTaggedHead(args, answer, now()))
              return answer;
          }
        } catch (error) {
          // A failure, a revert or an unchecked chain there: the configured endpoint decides. A
          // node that does not answer in time is skipped for a while.
          if (timedOut(error)) skipUntil = now() + SECOND_BACKOFF_MS;
        }
        return home.request(args as never, requestOptions as never);
      }
      try {
        return await once.request(args as never, requestOptions as never);
      } catch (error) {
        // A revert is the chain's answer: asking another node would only hide it.
        if (reverted(error)) throw error;
        let answer: unknown;
        try {
          if (!(await otherServesChain())) throw error;
          answer = await other.request(args as never, requestOptions as never);
        } catch (secondError) {
          if (secondError !== error && reverted(secondError)) throw secondError;
          throw error;
        }
        if (absence(args.method, answer)) throw error;
        return answer;
      }
    }) as EIP1193RequestFn;
    return { ...home, request };
  };
}
