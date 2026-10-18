import { getAddress, parseAbi, type Hex, type PublicClient } from 'viem';
import { MAX_LOG_RANGE_BLOCKS } from '../chain/rpc-budget.js';
import type { createReceiveStore } from './receive-store.js';

type Store = ReturnType<typeof createReceiveStore>;

const authorizationEvents = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
]);
const authorizationStateAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

/** Blocks before the claim that the search also covers (a payer may broadcast first). */
export const RECEIVE_SEARCH_LOOKBACK_BLOCKS = 600n;
/**
 * The most blocks searched from a claim's start block (about 28 hours of Base blocks). An event
 * past this window is never found; authorizationState then reads "used", so the claim stays
 * pending rather than failing.
 */
export const RECEIVE_SEARCH_MAX_BLOCKS = 50_000n;
/**
 * Blocks per getLogs page to start with: the endpoint's range cap, so no page is refused for its
 * size. Halved on a provider error down to the minimum.
 */
const LOG_PAGE_BLOCKS = MAX_LOG_RANGE_BLOCKS;
const LOG_PAGE_MIN_BLOCKS = 500n;

export type ReceiveReconcileOutcome =
  /** A finalized, canonical AuthorizationUsed was found and its transaction is now recorded. */
  | { kind: 'transaction'; transaction: Hex }
  /** The authorization can never be used: the claim is now 'failed'. */
  | { kind: 'failed' }
  /** Nothing can be concluded yet (including every read error). Nothing was written. */
  | { kind: 'pending' }
  /** Not a claim this reconciler handles (missing, already has a transaction, or ended). */
  | { kind: 'untouched' };

export type ReceiveReconcileClient = Pick<
  PublicClient,
  'getChainId' | 'getBlockNumber' | 'getBlock' | 'getLogs' | 'readContract'
>;

/**
 * Read-only on chain: resolves a claim that has no transaction using the configured trusted RPC
 * only (never the facilitator). It writes solely through the store's guarded paths: the
 * write-once transaction record, or 'failed' for a claim without a transaction. It never pays;
 * paying stays with markPaid and its finalized canonical direct-call proof. Callable per request
 * or from a periodic job.
 */
export function createReceiveReconciler(deps: {
  store: Store;
  client: ReceiveReconcileClient;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const { client, store } = deps;
  return {
    /** Where a new claim's search starts; null (never conclude absence) when the head is unknown. */
    async startBlock(): Promise<bigint | null> {
      try {
        const head = await client.getBlockNumber({ cacheTime: 0 });
        return head > RECEIVE_SEARCH_LOOKBACK_BLOCKS ? head - RECEIVE_SEARCH_LOOKBACK_BLOCKS : 0n;
      } catch {
        return null;
      }
    },
    async reconcile(workspaceId: string, receiptId: string): Promise<ReceiveReconcileOutcome> {
      const pending = { kind: 'pending' } as const;
      try {
        const row = await store.load(workspaceId, receiptId);
        if (
          !row ||
          row.transaction !== null ||
          (row.state !== 'claimed' && row.state !== 'reconciling')
        )
          return { kind: 'untouched' };
        // Without a start block the search has no bounded coverage: never conclude anything.
        if (row.searchFromBlock === null) return pending;
        if ((await client.getChainId()) !== row.binding.chainId) return pending;
        const token = getAddress(row.binding.token);
        const payer = getAddress(row.binding.payer);
        const nonce = row.binding.nonce as Hex;
        const finalized = await client.getBlock({ blockTag: 'finalized' });
        if (finalized.number === null) return pending;
        const head = await client.getBlockNumber({ cacheTime: 0 });
        const last = row.searchFromBlock + RECEIVE_SEARCH_MAX_BLOCKS - 1n;
        const end = head < last ? head : last;
        let used: { transactionHash: Hex; blockHash: Hex; blockNumber: bigint } | null = null;
        let canceled: { blockHash: Hex; blockNumber: bigint } | null = null;
        // Some RPC providers cap the block range per getLogs call: a failed page is retried at half
        // its size down to LOG_PAGE_MIN_BLOCKS; only an error at the minimum gives up (pending).
        let size = LOG_PAGE_BLOCKS;
        for (let from = row.searchFromBlock; from <= end && !used; from += size) {
          let usedLogs, canceledLogs;
          for (;;) {
            const to = from + size - 1n < end ? from + size - 1n : end;
            const page = { address: token, args: { authorizer: payer, nonce }, fromBlock: from };
            try {
              usedLogs = await client.getLogs({
                ...page,
                event: authorizationEvents[0],
                toBlock: to,
              });
              canceledLogs = await client.getLogs({
                ...page,
                event: authorizationEvents[1],
                toBlock: to,
              });
              break;
            } catch (error) {
              if (size <= LOG_PAGE_MIN_BLOCKS) throw error;
              size /= 2n;
            }
          }
          const hit = usedLogs.find((log) => !log.removed && log.transactionHash && log.blockHash);
          if (hit)
            used = {
              transactionHash: hit.transactionHash!,
              blockHash: hit.blockHash!,
              blockNumber: hit.blockNumber!,
            };
          const cancel = canceledLogs.find((log) => !log.removed && log.blockHash);
          if (cancel && !canceled)
            canceled = { blockHash: cancel.blockHash!, blockNumber: cancel.blockNumber! };
        }
        const finalCanonical = async (log: { blockHash: Hex; blockNumber: bigint }) =>
          log.blockNumber <= finalized.number! &&
          (await client.getBlock({ blockNumber: log.blockNumber })).hash?.toLowerCase() ===
            log.blockHash.toLowerCase();
        if (used) {
          // Record only a final canonical inclusion: the tx record is write-once, and a reorged
          // hash pinned forever could never be proven. markPaid still decides paid.
          if (!(await finalCanonical(used))) return pending;
          if (!(await store.reconcile(workspaceId, receiptId, used.transactionHash)))
            return pending;
          return { kind: 'transaction', transaction: used.transactionHash };
        }
        // A finalized cancellation consumes the nonce: the authorization can never transfer.
        if (canceled && (await finalCanonical(canceled)))
          return (await store.markFailed(workspaceId, receiptId)) ? { kind: 'failed' } : pending;
        if (row.validBefore === null) return pending;
        // EIP-3009 accepts only block.timestamp < validBefore. Once a finalized block is at or past
        // it, no later block can use the authorization; the wall clock must agree as well.
        const validBefore = BigInt(row.validBefore);
        if (BigInt(Math.floor(now() / 1000)) <= validBefore || finalized.timestamp < validBefore)
          return pending;
        // The nonce state is read at the finalized block, which must still be the same block
        // afterwards: a node that served another block in between proves nothing.
        if (!finalized.hash) return pending;
        const consumed = await client.readContract({
          address: token,
          abi: authorizationStateAbi,
          functionName: 'authorizationState',
          args: [payer, nonce],
          blockNumber: finalized.number,
        });
        // Used (or canceled) outside the window: the payer may have paid, so never fail it.
        if (consumed !== false) return pending;
        const again = await client.getBlock({ blockNumber: finalized.number });
        if (!again.hash || again.hash.toLowerCase() !== finalized.hash.toLowerCase())
          return pending;
        return (await store.markFailed(workspaceId, receiptId)) ? { kind: 'failed' } : pending;
      } catch {
        // RPC or database unavailability proves nothing; keep the durable state as it is.
        return pending;
      }
    },
  };
}
