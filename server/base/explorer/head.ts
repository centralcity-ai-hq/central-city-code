/*
 * The server's own reads of Base for the On Base list: the latest block (totals.readAtBlock) and
 * ownerOf of the listed ids at that block (row.owner), and a passport's feedback in the Reputation
 * Registry. Read only: eth_chainId once, then eth_blockNumber, one eth_call per page (Multicall3
 * aggregate3 over the canonical registry's ownerOf) and one per passport (readAllFeedback). The
 * URL may carry a key (the CDP endpoint), so it is never logged or returned.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  multicall3Abi,
  parseAbi,
  type Address,
} from 'viem';
import { identityRegistryAbi } from '../chain/identity-chain.js';
import { MULTICALL3 } from '../../../shared/base/chains.js';

export { MULTICALL3 };

/** The one ERC-8004 Reputation Registry read the passport makes (erc-8004-contracts v1 ABI). */
export const reputationReadAbi = parseAbi([
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);

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

export interface OnBaseChainReader {
  head(): Promise<{ block: bigint }>;
  /**
   * ownerOf(id) for every id at `block`: the owner, or null only when ownerOf itself reverted for
   * that id (the registry has no such token). Rejects on anything else: a transport, HTTP or RPC
   * error, or an answer that does not decode. Never a partial map.
   */
  owners(ids: readonly string[], block: bigint): Promise<Map<string, string | null>>;
  /**
   * Every feedback entry for the id at `block`, revoked ones left out, in the registry's order
   * (per client, in the order the clients first gave feedback; each client's oldest first). An id
   * without feedback is []. Absent without a reputation registry. Rejects like owners().
   */
  feedback?(baseId: string, block: bigint): Promise<FeedbackRead[]>;
}

export function baseChainReader(
  url: string,
  chainId: number,
  registry: Address,
  timeoutMs = 3_000,
  reputation?: Address,
): OnBaseChainReader {
  const client = createPublicClient({
    transport: http(url, { timeout: timeoutMs, retryCount: 0 }),
  });
  let chainChecked = false;
  // A URL for another network must never report its blocks or owners as Base's.
  const checkChain = async () => {
    if (chainChecked) return;
    if ((await client.getChainId()) !== chainId) throw new Error('Not the expected network.');
    chainChecked = true;
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
          async feedback(baseId: string, block: bigint) {
            await checkChain();
            const [clients, indexes, values, decimals, tag1s, tag2s, revoked] =
              await client.readContract({
                address: reputation,
                abi: reputationReadAbi,
                functionName: 'readAllFeedback',
                blockNumber: block,
                args: [BigInt(baseId), [], '', '', false],
              });
            const n = clients.length;
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
            return entries;
          },
        }
      : {}),
  };
}
