/*
 * The balances port (docs/base/ARCHITECTURE.md §6.1 `balances`): what one agent wallet holds on
 * Base, read in ONE Multicall3 aggregate3 call pinned to one block: USDC.balanceOf(wallet),
 * Multicall3.getEthBalance(wallet), and whether the wallet has code (deployed). Read only:
 * eth_chainId once, then eth_blockNumber and one eth_call per read. Any transport, HTTP, RPC or
 * decoding failure rejects the whole read: a failed read is never a balance of zero. The URL may
 * carry a key (the CDP endpoint), so it is never logged or returned.
 *
 * `url` may be a list (read-transport.ts): the configured endpoint first, then a second one that
 * answers when the first cannot. The head number may come from either; the one aggregate3 call is
 * pinned to that number on whichever node answers it (a node without that block fails, never
 * reads another one), so every value still describes one block.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  multicall3Abi,
  parseAbi,
  size,
} from 'viem';
import {
  MULTICALL3,
  NATIVE_ETH,
  type Address,
  type BaseNetwork,
} from '../../../shared/base/chains.js';
import type { ReservationDeps } from './reservations.js';
import { baseReadTransport } from './read-transport.js';

export interface WalletBalances {
  /** USDC in base units (6 decimals). */
  usdc: bigint;
  /** Native ETH in wei. */
  eth: bigint;
  /** The wallet has code at `blockNumber` (the counterfactual account was deployed). */
  deployed: boolean;
  /** The one block every value was read at. */
  blockNumber: bigint;
}

export interface BalanceReader {
  /** Rejects on anything but a complete, well-formed answer for the expected network. */
  balances(wallet: Address): Promise<WalletBalances>;
}

const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
/**
 * The code probe: a Coinbase Smart Wallet answers entryPoint(). A call to an address without code
 * succeeds with empty return data (the EVM runs nothing), so empty success means "not deployed";
 * any other answer, a revert included, can only come from code.
 */
const probeAbi = parseAbi(['function entryPoint() view returns (address)']);

export function baseBalanceReader(
  url: string | readonly string[],
  network: BaseNetwork,
  timeoutMs = 3_000,
  /** What these reads count as per minute (rpc-count.ts); 'read' by default. */
  purpose?: string,
): BalanceReader {
  const client = createPublicClient({
    transport: baseReadTransport(url, {
      chainId: network.chainId,
      timeoutMs,
      headNumberMayFallBack: true,
      ...(purpose ? { purpose } : {}),
    }),
  });
  const usdc = network.tokens.USDC.address;
  let chainChecked = false;
  // A URL for another network must never report its balances as this network's.
  const checkChain = async () => {
    if (chainChecked) return;
    if ((await client.getChainId()) !== network.chainId)
      throw new Error('Not the expected network.');
    chainChecked = true;
  };
  return {
    async balances(wallet) {
      const account = getAddress(wallet);
      await checkChain();
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      // aggregate3 is called directly (as in explorer/head.ts), never through viem's multicall():
      // that action turns a failed eth_call into per-call "failure" entries, which must never
      // read as a balance. The two balances may not fail; only the code probe may.
      const results = await client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: 'aggregate3',
        blockNumber,
        args: [
          [
            {
              target: usdc,
              allowFailure: false,
              callData: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [account],
              }),
            },
            {
              target: MULTICALL3,
              allowFailure: false,
              callData: encodeFunctionData({
                abi: multicall3Abi,
                functionName: 'getEthBalance',
                args: [account],
              }),
            },
            {
              target: account,
              allowFailure: true,
              callData: encodeFunctionData({ abi: probeAbi, functionName: 'entryPoint' }),
            },
          ],
        ],
      });
      if (results.length !== 3) throw new Error('Malformed multicall answer.');
      const [token, native, probe] = results;
      if (!token.success || !native.success) throw new Error('Malformed multicall answer.');
      // Exactly one word each: anything shorter or longer is not a uint256 answer.
      if (size(token.returnData) !== 32 || size(native.returnData) !== 32)
        throw new Error('Malformed multicall answer.');
      return {
        usdc: decodeFunctionResult({
          abi: erc20Abi,
          functionName: 'balanceOf',
          data: token.returnData,
        }),
        eth: decodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'getEthBalance',
          data: native.returnData,
        }),
        deployed: !(probe.success && size(probe.returnData) === 0),
        blockNumber,
      };
    },
  };
}

/**
 * `ReservationDeps.balanceOf` (chain/reservations.ts) on top of the reader: one fresh read (never
 * a cached one) of the wallet, answering for the allowlisted USDC or native ETH only.
 */
export function reservationBalanceOf(
  reader: BalanceReader,
  network: BaseNetwork,
): ReservationDeps['balanceOf'] {
  return async (address, token) => {
    const lower = token.toLowerCase();
    const usdc = lower === network.tokens.USDC.address.toLowerCase();
    if (!usdc && lower !== NATIVE_ETH.toLowerCase()) throw new Error('Token not allowlisted.');
    const read = await reader.balances(address);
    return { balance: usdc ? read.usdc : read.eth, blockNumber: read.blockNumber };
  };
}
