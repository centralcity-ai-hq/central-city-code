/*
 * The call budget of the one keyed CDP endpoint (node reads, bundler and paymaster share it, and it
 * answers 429 under load). Two things keep the chain runtime inside it:
 *
 * 1. cdpTransport: one retry, one second apart (viem honours a Retry-After header), instead of
 *    viem's three retries 150 ms apart, which multiply every call by four exactly while the
 *    endpoint is throttling.
 *
 * 2. blockTagCache: the head-of-chain reads are shared for a moment, process-wide, per client.
 *    eth_blockNumber and eth_getBlockByNumber('latest') for LATEST_TTL_MS, 'safe' and 'finalized'
 *    for SETTLED_TTL_MS, keyed by tag and the full-transactions flag. The age is counted from the
 *    START of the request (the node may have answered at any moment of it), so no answer is served
 *    once it may be older than its TTL; a request still in flight past its TTL is not joined, a new
 *    one is sent. Concurrent callers within the TTL share one request; an error is never kept
 *    (every waiter of that request sees it, the next caller asks again). Blocks by number or hash,
 *    'pending', 'earliest' and every other method always go to the node.
 *
 * Safety: hashes, not heights. The endpoint is load balanced: any answer, cached or not, may come
 * from a backend that lags (an OLDER head), one on another fork (same height, DIFFERENT hash), or
 * one that has since rolled back (a head HIGHER than a later live read). The cache never invents a
 * head; it replays one this endpoint served within the TTL. So no consumer may rely on a head being
 * recent or heights being monotonic. Each consumer either
 *   - treats the head as a hint that only ever says "not yet" or chooses a fee (any head is fine),
 *   - binds its conclusion to canonical block hashes read at the moment it concludes: the head's
 *     own hash re-read live BY NUMBER (submit.ts headIsCanonical) and the receipt's block hash
 *     canonical at its height (canonicalOutcome / provenMint), so a head from another fork or one
 *     rolled back makes the proof fail ("not yet"), never succeed, or
 *   - reads live (liveReads, the uncached twin) where the conclusion needs the node's current head.
 *
 * Consumers of the shared runtime client's heads:
 *
 *   consumer                               head          use / relies on
 *   rpc-bundler bundlerFees,               latest        fee quote only (capped); no conclusion
 *     viem estimateFeesPerGas              (cached)
 *   submit settledHead → refreshFinality   finalized     not deep enough → "not yet". final, failed
 *     (final / failed / NONCE_CONSUMED       (cached)      (revert or nonce consumed) only after
 *     failed / reorged)                                   headIsCanonical(finalized) AND the receipt
 *                                                         block canonical (canonicalOutcome)
 *   submit safeHead → identity-port        safe          display depth, recomputed every poll; 'safe'
 *     finalityOf ('safe' vs 'included')    (cached)      only with headIsCanonical(safe) and the
 *                                                         receipt block canonical (describe/provenMint)
 *   owner-ops settledAtSafe (releases      safe (LIVE)   live safe + its hash re-read by number +
 *     withdrawal holds)                                   EIP-1898 nonce read AT the safe hash + the
 *                                                         receipt block canonical
 *   identity-port identityAt (hand-over    finalized     live; every read at that height re-checked
 *     destination check)                   (LIVE)        against the finalized block's hash
 *   submit submittedBlock (search start),  blockNumber   live: a head too high would start a search
 *     reconcile search bound, receipt-     (LIVE)        late or end it early and conclude absence
 *     gone and canonical-missing gates,
 *     settled depth on test networks
 */
import { http, type EIP1193RequestFn, type HttpTransportConfig, type Transport } from 'viem';

/** One retry, a second later (or after the endpoint's Retry-After). */
export const CDP_RETRY = { retryCount: 1, retryDelay: 1000 } as const;

/** The transport of every client on the CDP endpoint that has no timeout budget of its own. */
export function cdpTransport(url: string, config: Omit<HttpTransportConfig, 'retryCount'> = {}) {
  return http(url, { ...config, ...CDP_RETRY });
}

export const LATEST_TTL_MS = 1000;
export const SETTLED_TTL_MS = 2000;

interface Entry {
  promise: Promise<unknown>;
  /** When the request was sent: the oldest the answer can be. */
  startedAt: number;
  ttlMs: number;
}

type RequestFn = (
  args: { method: string; params?: unknown },
  options?: unknown,
) => Promise<unknown>;

/** The cache key and lifetime of a head read; null for anything that always goes to the node. */
function headRead(
  method: string,
  params: unknown,
  ttl: { latest: number; settled: number },
): { key: string; ttlMs: number } | null {
  if (method === 'eth_blockNumber') return { key: 'blockNumber', ttlMs: ttl.latest };
  if (method !== 'eth_getBlockByNumber' || !Array.isArray(params)) return null;
  const [tag, full] = params as [unknown, unknown];
  const ttlMs =
    tag === 'latest' ? ttl.latest : tag === 'safe' || tag === 'finalized' ? ttl.settled : null;
  return ttlMs === null ? null : { key: `${tag}:${full === true}`, ttlMs };
}

/** A request function whose head reads are shared for their TTL (see the module header). */
export function cachedHeadRequests<R extends RequestFn>(
  request: R,
  options: { now?: () => number; latestTtlMs?: number; settledTtlMs?: number } = {},
): R {
  const now = options.now ?? Date.now;
  const ttl = {
    latest: options.latestTtlMs ?? LATEST_TTL_MS,
    settled: options.settledTtlMs ?? SETTLED_TTL_MS,
  };
  const entries = new Map<string, Entry>();
  const cached = (args: { method: string; params?: unknown }, requestOptions?: unknown) => {
    const read = headRead(args.method, args.params, ttl);
    if (!read) return request(args, requestOptions);
    const hit = entries.get(read.key);
    if (hit && now() < hit.startedAt + hit.ttlMs) return hit.promise;
    const entry: Entry = { startedAt: now(), ttlMs: read.ttlMs, promise: Promise.resolve() };
    entry.promise = request(args, requestOptions);
    entries.set(read.key, entry);
    entry.promise.catch(() => {
      if (entries.get(read.key) === entry) entries.delete(read.key);
    });
    return entry.promise;
  };
  return cached as R;
}

/** A transport whose head reads are shared (one cache per client built on it). */
export function blockTagCache(
  transport: Transport,
  options?: Parameters<typeof cachedHeadRequests>[1],
): Transport {
  return (params) => {
    const built = transport(params);
    return {
      ...built,
      request: cachedHeadRequests(built.request as RequestFn, options) as EIP1193RequestFn,
    };
  };
}

const LIVE = Symbol.for('centralcity.base.liveReads');

/** Attaches the uncached twin of a cached client (same endpoint, no head cache). */
export function withLiveReads<C extends object>(cached: C, live: C): C {
  Object.defineProperty(cached, LIVE, { value: live, enumerable: true });
  return cached;
}

/** The client to read a head with when a conclusion needs the node's current head. */
export function liveReads<C>(client: C): C {
  const live = (client as { [LIVE]?: C } | null)?.[LIVE];
  return live ?? client;
}
