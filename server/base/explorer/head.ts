/*
 * The server's own reads of Base for the On Base list: the latest block (totals.readAtBlock) and
 * ownerOf of the listed ids at that block (row.owner), and a passport's feedback in the Reputation
 * Registry. Read only: eth_chainId once, then eth_blockNumber, one eth_call per page (Multicall3
 * aggregate3 over the canonical registry's ownerOf) and a bounded few per passport (getClients,
 * getLastIndex through aggregate3, then readAllFeedback of at most FEEDBACK_READ_MAX entries). The
 * URL may carry a key (the CDP endpoint), so it is never logged or returned.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  multicall3Abi,
  parseAbi,
  type Address,
} from 'viem';
import { identityRegistryAbi } from '../chain/identity-chain.js';
import { MULTICALL3 } from '../../../shared/base/chains.js';

export { MULTICALL3 };

/** The ERC-8004 Reputation Registry feedback read (erc-8004-contracts v1 ABI). */
export const reputationReadAbi = parseAbi([
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);
/** The registry's client list and per-client counts, read first to bound the feedback read. */
export const reputationClientsAbi = parseAbi([
  'function getClients(uint256 agentId) view returns (address[])',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
]);

/**
 * The most feedback entries one passport read asks Base for. Anyone but the owner can give
 * feedback and each entry is cheap to add, so one unbounded readAllFeedback could grow past an
 * RPC's gas, size or time limit and leave the passport unread. Above this the read takes the
 * rater wallets first, then the newest clients, each with all of its entries or none.
 */
export const FEEDBACK_READ_MAX = 200;
/** The most clients whose entry count one read asks for (getLastIndex, in calls of 500). */
export const FEEDBACK_CLIENTS_MAX = 1_000;
const FEEDBACK_CLIENTS_CHUNK = 500;

/** One feedback entry as the Reputation Registry stores it. */
export interface FeedbackRead {
  client: string;
  /** The client's feedback index (uint64): a bigint, exact above 2^53. */
  index: bigint;
  value: bigint;
  decimals: number;
  tag1: string;
  tag2: string;
}

/** A passport's feedback read: the entries read and how many there are on Base. */
export interface FeedbackReads {
  entries: FeedbackRead[];
  /**
   * The entries on Base. entries.length when every client was read (revoked ones left out);
   * otherwise the registry's count for every client asked (revoked ones included) plus one for
   * each client not asked.
   */
  total: number;
  /** True when the FEEDBACK_READ_MAX bound left some clients out. */
  bounded: boolean;
}

export interface OnBaseChainReader {
  head(): Promise<{ block: bigint }>;
  /**
   * ownerOf(id) for every id at `block`: the owner, or null only when ownerOf itself reverted for
   * that id (the registry has no such token). Rejects on anything else: a transport, HTTP or RPC
   * error, or an answer that does not decode. Never a partial map.
   */
  owners(ids: readonly string[], block: bigint): Promise<Map<string, string | null>>;
  /**
   * The feedback entries for the id at `block`, revoked ones left out, in the registry's order
   * (per client, in the order the clients first gave feedback; each client's oldest first), at
   * most FEEDBACK_READ_MAX of them: every entry when they fit, else the clients `prefer` names
   * (lower case: the rater wallets) first, then the newest clients, each with all of its entries
   * or none. An id without feedback has none. Absent without a reputation registry. Rejects like
   * owners().
   */
  feedback?(
    baseId: string,
    block: bigint,
    prefer?: (clients: readonly string[]) => Promise<ReadonlySet<string>>,
  ): Promise<FeedbackReads>;
}

/**
 * `url` may be a list: the first endpoint answers, and a read that fails there (a timeout, an
 * HTTP or RPC transport error, a rate limit) is asked once of the next. Production passes the CDP
 * endpoint first and Base's public RPC second, so the public explorer keeps reading Base while the
 * CDP endpoint is busy (it also carries the paymaster). Read only; the chain check still applies,
 * and a revert or an answer that does not decode still rejects (never read as "no owner").
 */
export function baseChainReader(
  url: string | readonly string[],
  chainId: number,
  registry: Address,
  timeoutMs = 3_000,
  reputation?: Address,
): OnBaseChainReader {
  const urls = (typeof url === 'string' ? [url] : [...url]).filter(Boolean);
  const one = (u: string) => http(u, { timeout: timeoutMs, retryCount: 0 });
  const client = createPublicClient({
    transport: urls.length > 1 ? fallback(urls.map(one), { retryCount: 0 }) : one(urls[0]!),
  });
  let chainChecked = false;
  // A URL for another network must never report its blocks or owners as Base's.
  const checkChain = async () => {
    if (chainChecked) return;
    if ((await client.getChainId()) !== chainId) throw new Error('Not the expected network.');
    chainChecked = true;
  };
  /** getLastIndex (each client's feedback count) of every client at `block`, via aggregate3. */
  const lastIndexes = async (
    registryAddress: Address,
    agentId: bigint,
    clients: readonly Address[],
    block: bigint,
  ): Promise<bigint[]> => {
    const chunks: Address[][] = [];
    for (let i = 0; i < clients.length; i += FEEDBACK_CLIENTS_CHUNK)
      chunks.push(clients.slice(i, i + FEEDBACK_CLIENTS_CHUNK));
    const answers = await Promise.all(
      chunks.map((chunk) =>
        client.readContract({
          address: MULTICALL3,
          abi: multicall3Abi,
          functionName: 'aggregate3',
          blockNumber: block,
          args: [
            chunk.map((address) => ({
              target: registryAddress,
              allowFailure: false,
              callData: encodeFunctionData({
                abi: reputationClientsAbi,
                functionName: 'getLastIndex',
                args: [agentId, address],
              }),
            })),
          ],
        }),
      ),
    );
    return answers.flatMap((results, c) => {
      if (results.length !== chunks[c]!.length) throw new Error('Malformed multicall answer.');
      return results.map(({ success, returnData }) => {
        if (!success) throw new Error('Feedback count not read.');
        return decodeFunctionResult({
          abi: reputationClientsAbi,
          functionName: 'getLastIndex',
          data: returnData,
        });
      });
    });
  };
  return {
    async head() {
      await checkChain();
      return { block: await client.getBlockNumber({ cacheTime: 0 }) };
    },
    async owners(ids, block) {
      await checkChain();
      const owners = new Map<string, string | null>();
      if (ids.length === 0) return owners;
      // aggregate3 itself is called directly, not through viem's multicall(): that action turns a
      // failed eth_call (an outage, an HTTP or RPC error) into per-contract "failure" entries,
      // which must never read as "no owner". Any error of this one call rejects.
      const results = await client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: 'aggregate3',
        blockNumber: block,
        args: [
          ids.map((id) => ({
            target: registry,
            allowFailure: true,
            callData: encodeFunctionData({
              abi: identityRegistryAbi,
              functionName: 'ownerOf',
              args: [BigInt(id)],
            }),
          })),
        ],
      });
      if (results.length !== ids.length) throw new Error('Malformed multicall answer.');
      ids.forEach((id, index) => {
        const { success, returnData } = results[index];
        // success=false: ownerOf reverted inside aggregate3 for this id (no such token), the one
        // case that means "no owner". A success that does not decode rejects the whole read.
        owners.set(
          id,
          success
            ? getAddress(
                decodeFunctionResult({
                  abi: identityRegistryAbi,
                  functionName: 'ownerOf',
                  data: returnData,
                }),
              )
            : null,
        );
      });
      return owners;
    },
    ...(reputation
      ? {
          async feedback(
            baseId: string,
            block: bigint,
            prefer?: (clients: readonly string[]) => Promise<ReadonlySet<string>>,
          ): Promise<FeedbackReads> {
            await checkChain();
            const agentId = BigInt(baseId);
            const all = (
              await client.readContract({
                address: reputation,
                abi: reputationClientsAbi,
                functionName: 'getClients',
                blockNumber: block,
                args: [agentId],
              })
            ).map((address) => getAddress(address));
            if (all.length === 0) return { entries: [], total: 0, bounded: false };
            const preferred = prefer ? await prefer(all) : new Set<string>();
            const isPreferred = (address: string) => preferred.has(address.toLowerCase());
            // The clients asked for their counts: every one up to FEEDBACK_CLIENTS_MAX, else the
            // preferred ones and the newest. Registry order is kept throughout.
            const asked =
              all.length <= FEEDBACK_CLIENTS_MAX
                ? all
                : all.filter(
                    (address, i) => isPreferred(address) || i >= all.length - FEEDBACK_CLIENTS_MAX,
                  );
            const counts = await lastIndexes(reputation, agentId, asked, block);
            const sum = counts.reduce((total, count) => total + count, 0n);
            const everyone = asked.length === all.length && sum <= BigInt(FEEDBACK_READ_MAX);
            const onBase = Number(sum) + (all.length - asked.length);
            let chosen: Address[] = [];
            if (!everyone) {
              // Preferred clients first, then from the newest back. A client is read whole or
              // not at all, so a rater's latest rating is never cut from the entries before it.
              let room = BigInt(FEEDBACK_READ_MAX);
              const take = new Set<number>();
              const order = asked.map((_, i) => i);
              for (const i of [
                ...order.filter((i) => isPreferred(asked[i]!)),
                ...order.reverse().filter((i) => !isPreferred(asked[i]!)),
              ]) {
                const count = counts[i]!;
                if (count > 0n && count <= room) {
                  take.add(i);
                  room -= count;
                }
              }
              chosen = asked.filter((_, i) => take.has(i));
              if (chosen.length === 0) return { entries: [], total: onBase, bounded: true };
            }
            const [clients, indexes, values, decimals, tag1s, tag2s, revoked] =
              await client.readContract({
                address: reputation,
                abi: reputationReadAbi,
                functionName: 'readAllFeedback',
                blockNumber: block,
                args: [agentId, chosen, '', '', false],
              });
            const n = clients.length;
            if (n > FEEDBACK_READ_MAX) throw new Error('Feedback answer over the bound.');
            if (
              [indexes, values, decimals, tag1s, tag2s, revoked].some((list) => list.length !== n)
            )
              throw new Error('Malformed feedback answer.');
            const entries: FeedbackRead[] = [];
            for (let i = 0; i < n; i += 1) {
              if (revoked[i]) continue;
              entries.push({
                client: getAddress(clients[i]),
                index: indexes[i],
                value: values[i],
                decimals: decimals[i],
                tag1: tag1s[i],
                tag2: tag2s[i],
              });
            }
            return everyone
              ? { entries, total: entries.length, bounded: false }
              : { entries, total: onBase, bounded: true };
          },
        }
      : {}),
  };
}
