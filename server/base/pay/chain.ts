/*
 * Operation Base Pay: the one Base read behind "this Base ID is that agent's wallet". ownerOf(id) in
 * the canonical ERC-8004 Identity Registry of the wallet network, at ONE block named by its number
 * AND its hash: the latest block is read first, then the call runs at exactly that block hash
 * (EIP-1898, requireCanonical), so the answer and its evidence can never come from two blocks.
 *
 * Read only: eth_chainId once, then eth_getBlockByNumber('latest') and one eth_call (Multicall3
 * aggregate3, as explorer/head.ts) per read. A rating (rate/service.ts) reads two owners in that
 * one call (ownersOf), so both come from the same block. Any transport, HTTP, RPC or decoding failure rejects:
 * a failed read is never "no owner". The URL may carry a key (the CDP endpoint), so it is never
 * logged or returned.
 *
 * A read that fails for the transport (a node behind the endpoint that hasn't seen the head yet
 * answers the call at that block hash with an error; a timeout) is tried again from a fresh head,
 * at most READ_ATTEMPTS times in all with a short pause: seen as occasional 503s ("Base cannot be
 * read right now") on ratings in the Base runs, each fine on the next try. Every attempt is still
 * one block; an invalid Base ID or another network is never retried.
 *
 * `url` may be a list (chain/read-transport.ts): a second endpoint answers what the configured one
 * cannot right now. The head and the call may then come from two nodes; that is safe because the
 * call names the head's HASH with requireCanonical: a node that does not hold that block as
 * canonical fails the call (and the attempt is retried from a fresh head), it never answers for
 * another block. A revert of the whole call is never asked of the second endpoint.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  multicall3Abi,
  type Hex,
} from 'viem';
import { MULTICALL3, type Address, type BaseNetwork } from '../../../shared/base/chains.js';
import { identityRegistryAbi } from '../chain/identity-chain.js';
import { baseReadTransport } from '../chain/read-transport.js';

export interface RecipientOwnerRead {
  block: bigint;
  blockHash: Hex;
  /** ownerOf(baseId) at that block; null only when ownerOf itself reverted (no such id). */
  owner: Address | null;
}

export interface OwnersRead {
  block: bigint;
  blockHash: Hex;
  /** ownerOf of each Base ID asked for, in order, all at that one block; null where it reverted. */
  owners: (Address | null)[];
}

export interface PayChainReader {
  /** The canonical registry this reader asks (the wallet network's). */
  readonly registry: Address;
  readonly chainId: number;
  /** ownerOf(baseId) at the latest block, with that block's number and hash. Rejects otherwise. */
  ownerOf(baseId: string): Promise<RecipientOwnerRead>;
  /**
   * ownerOf of several Base IDs at ONE block (the latest), in one call. Rejects otherwise. Optional:
   * a reader without it cannot check a rating (rate/service.ts answers 503).
   */
  ownersOf?(baseIds: readonly string[]): Promise<OwnersRead>;
}

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
/** Attempts of one owners read, and the pause before each retry (ms). */
export const READ_ATTEMPTS = 3;
export const RETRY_PAUSE_MS = [250, 750] as const;

/** A refusal that a retry can't change: never tried again. */
class FinalReadError extends Error {}

export function payChainReader(
  url: string | readonly string[],
  network: BaseNetwork,
  timeoutMs = 3_000,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const registry = network.contracts.identityRegistry;
  if (!registry) throw new Error('The wallet network has no identity registry.');
  const client = createPublicClient({
    transport: baseReadTransport(url, { chainId: network.chainId, timeoutMs }),
  });
  let chainChecked = false;
  // A URL for another network must never answer for this one.
  const checkChain = async () => {
    if (chainChecked) return;
    if ((await client.getChainId()) !== network.chainId)
      throw new FinalReadError('Not the expected network.');
    chainChecked = true;
  };
  const BASE_ID = /^(0|[1-9][0-9]{0,77})$/;
  /** ownerOf of each id at the latest block, read in one aggregate3 call at that block's hash. */
  async function readOwners(baseIds: readonly string[]): Promise<OwnersRead> {
    if (baseIds.length === 0 || baseIds.some((id) => !BASE_ID.test(id)))
      throw new Error('Not a Base ID.');
    for (let attempt = 1; ; attempt++) {
      try {
        return await readOwnersOnce(baseIds);
      } catch (error) {
        if (error instanceof FinalReadError || attempt >= READ_ATTEMPTS) throw error;
        await pause(RETRY_PAUSE_MS[attempt - 1] ?? RETRY_PAUSE_MS[RETRY_PAUSE_MS.length - 1]);
      }
    }
  }
  /** One attempt: the latest head, then the call at exactly that head's hash. */
  async function readOwnersOnce(baseIds: readonly string[]): Promise<OwnersRead> {
    await checkChain();
    const head = await client.getBlock({ blockTag: 'latest' });
    if (head.number === null || head.hash === null || !BLOCK_HASH.test(head.hash))
      throw new Error('Malformed block.');
    const data = await client.request({
      method: 'eth_call',
      params: [
        {
          to: MULTICALL3,
          data: encodeFunctionData({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            args: [
              baseIds.map((baseId) => ({
                target: registry!,
                allowFailure: true,
                callData: encodeFunctionData({
                  abi: identityRegistryAbi,
                  functionName: 'ownerOf',
                  args: [BigInt(baseId)],
                }),
              })),
            ],
          }),
        },
        { blockHash: head.hash, requireCanonical: true },
      ],
    });
    const results = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      data,
    });
    if (results.length !== baseIds.length) throw new Error('Malformed multicall answer.');
    return {
      block: head.number,
      blockHash: head.hash.toLowerCase() as Hex,
      // success=false: ownerOf reverted inside aggregate3 (no such id), the one "no owner" case.
      // A success that does not decode rejects the whole read.
      owners: results.map(({ success, returnData }) =>
        success
          ? getAddress(
              decodeFunctionResult({
                abi: identityRegistryAbi,
                functionName: 'ownerOf',
                data: returnData,
              }),
            )
          : null,
      ),
    };
  }
  const reader: PayChainReader = {
    registry,
    chainId: network.chainId,
    async ownerOf(baseId) {
      const read = await readOwners([baseId]);
      return { block: read.block, blockHash: read.blockHash, owner: read.owners[0] };
    },
    ownersOf: readOwners,
  };
  return reader;
}
