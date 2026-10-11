/*
 * Spend permissions as Base sees them (Operation Base Wallet W3). One Multicall3 aggregate3 call
 * pinned to ONE block reads, for every permission: SpendPermissionManager.isApproved, isRevoked and
 * getCurrentPeriod, plus that block's timestamp. So "spent", "left", "approved" and "revoked" always
 * describe the same moment.
 *
 * getCurrentPeriod reverts before a permission's start and from its end on. Such a revert is
 * expected exactly when the block's own timestamp is outside start..end, and then reads as
 * `phase: 'before_start' | 'ended'`; a revert inside the window, a short or malformed answer, a
 * wrong network or any transport failure rejects the whole read. A failed read is never zeros.
 *
 * `settled: true` reads at a block that no longer reorgs (the finalized block on mainnet, the
 * network's confirmation depth below head elsewhere): a revocation is only ever concluded there.
 * The URL may carry a key (the CDP endpoint), so it is never logged or returned.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  multicall3Abi,
  size,
  type PublicClient,
} from 'viem';
import {
  BASE_MAINNET,
  MULTICALL3,
  type Address,
  type BaseNetwork,
} from '../../../shared/base/chains.js';
import type { SpendPermission } from '../../../shared/base/types.js';
import { spendPermissionManagerAbi } from './permissions.js';

export type PermissionPhase = 'before_start' | 'active' | 'ended';

export interface PermissionChainState {
  approved: boolean;
  revoked: boolean;
  phase: PermissionPhase;
  /** SpendPermissionManager's current period at the read block; null outside start..end. */
  current: { start: number; end: number; spend: bigint } | null;
}

export interface PermissionsRead {
  /** The one block every value was read at. */
  blockNumber: bigint;
  /** That block's timestamp (unix seconds). */
  blockTimestamp: number;
  /** In the order the permissions were given. */
  permissions: PermissionChainState[];
}

export interface PermissionReader {
  /** Rejects on anything but a complete, well-formed answer for the expected network. */
  read(
    permissions: readonly SpendPermission[],
    options?: { settled?: boolean },
  ): Promise<PermissionsRead>;
  /** Whether the address has code at the latest block; rejects when the chain cannot tell. */
  deployed(address: Address): Promise<boolean>;
}

/** At most this many permissions in one read (4 calls each, one aggregate3). */
export const PERMISSION_READ_MAX = 50;

const WORD = 32;

function decodeBool(data: `0x${string}`, functionName: 'isApproved' | 'isRevoked'): boolean {
  if (size(data) !== WORD) throw new Error('Malformed multicall answer.');
  return decodeFunctionResult({ abi: spendPermissionManagerAbi, functionName, data }) as boolean;
}

/** The read over an already built client (tests use a local JSON-RPC stand-in). */
export function permissionReaderFor(client: PublicClient, network: BaseNetwork): PermissionReader {
  const manager = network.contracts.spendPermissionManager;
  let chainChecked = false;
  // A URL for another network must never report its permissions as this network's.
  const checkChain = async () => {
    if (chainChecked) return;
    if ((await client.getChainId()) !== network.chainId)
      throw new Error('Not the expected network.');
    chainChecked = true;
  };

  async function blockFor(settled: boolean): Promise<bigint> {
    if (settled && network.chainId === BASE_MAINNET) {
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (finalized.number === null) throw new Error('No finalized block.');
      return finalized.number;
    }
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (!settled) return head;
    const depth = BigInt(network.confirmations);
    return head > depth ? head - depth : 0n;
  }

  return {
    async read(permissions, options = {}) {
      if (permissions.length > PERMISSION_READ_MAX) throw new Error('Too many permissions.');
      await checkChain();
      const blockNumber = await blockFor(options.settled === true);
      const calls = [
        {
          target: MULTICALL3,
          allowFailure: false,
          callData: encodeFunctionData({
            abi: multicall3Abi,
            functionName: 'getCurrentBlockTimestamp',
          }),
        },
        ...permissions.flatMap((permission) =>
          (['isApproved', 'isRevoked', 'getCurrentPeriod'] as const).map((functionName) => ({
            target: manager,
            // Only getCurrentPeriod may revert (outside start..end); the flags never do.
            allowFailure: functionName === 'getCurrentPeriod',
            callData: encodeFunctionData({
              abi: spendPermissionManagerAbi,
              functionName,
              args: [permission],
            }),
          })),
        ),
      ];
      // aggregate3 is called directly (as in balances.ts), never through viem's multicall(): that
      // action turns a failed eth_call into per-call failure entries.
      const results = await client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: 'aggregate3',
        blockNumber,
        args: [calls],
      });
      if (results.length !== calls.length) throw new Error('Malformed multicall answer.');
      const [time, ...rest] = results;
      if (!time.success || size(time.returnData) !== WORD)
        throw new Error('Malformed multicall answer.');
      const blockTimestamp = Number(
        decodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'getCurrentBlockTimestamp',
          data: time.returnData,
        }),
      );
      const states = permissions.map((permission, index): PermissionChainState => {
        const [approved, revoked, period] = rest.slice(index * 3, index * 3 + 3);
        if (!approved.success || !revoked.success) throw new Error('Malformed multicall answer.');
        const phase: PermissionPhase =
          blockTimestamp < permission.start
            ? 'before_start'
            : blockTimestamp >= permission.end
              ? 'ended'
              : 'active';
        let current: PermissionChainState['current'] = null;
        if (phase === 'active') {
          // Inside the window the contract must answer: a revert here is not explained.
          if (!period.success || size(period.returnData) !== 3 * WORD)
            throw new Error('Malformed multicall answer.');
          const value = decodeFunctionResult({
            abi: spendPermissionManagerAbi,
            functionName: 'getCurrentPeriod',
            data: period.returnData,
          });
          current = { start: Number(value.start), end: Number(value.end), spend: value.spend };
          if (
            current.start > blockTimestamp ||
            current.end <= blockTimestamp ||
            current.end > permission.end
          )
            throw new Error('Malformed multicall answer.');
        } else if (period.success) {
          // Outside the window the contract reverts; an answer means the block time is not its time.
          throw new Error('Malformed multicall answer.');
        }
        return {
          approved: decodeBool(approved.returnData, 'isApproved'),
          revoked: decodeBool(revoked.returnData, 'isRevoked'),
          phase,
          current,
        };
      });
      return { blockNumber, blockTimestamp, permissions: states };
    },

    async deployed(address) {
      await checkChain();
      const code = await client.getCode({ address: getAddress(address) });
      return code !== undefined && code !== '0x';
    },
  };
}

export function basePermissionReader(
  url: string,
  network: BaseNetwork,
  timeoutMs = 3_000,
): PermissionReader {
  return permissionReaderFor(
    createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 0 }) }),
    network,
  );
}
