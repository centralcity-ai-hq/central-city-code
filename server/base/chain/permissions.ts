/*
 * Spend permissions signed off-chain (docs/base/ARCHITECTURE.md §11.1, lazy approval). The owner
 * signs once in the browser; the signature is stored and submitted only at the agent's first
 * spend, together with the wallet deployment. Until then nothing touches the chain.
 *
 * A Coinbase Smart Wallet validates ERC-1271 signatures over its replay-safe hash, wrapped in a
 * SignatureWrapper{ownerIndex, signatureData}. For an undeployed wallet the wrapper is wrapped
 * again in ERC-6492, so SpendPermissionManager can deploy the wallet while approving.
 */
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Address, BaseNetwork } from '../../../shared/base/chains.js';
import { smartWalletMessageTypedData } from '../../../shared/base/spend-limits.js';
import type { SpendPermission } from '../../../shared/base/types.js';
import { createAccountCall, type DerivationRecipe } from './derive.js';

const PERMISSION =
  '(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';

export const spendPermissionManagerAbi = parseAbi([
  `function getHash(${PERMISSION} spendPermission) view returns (bytes32)`,
  `function approveWithSignature(${PERMISSION} spendPermission, bytes signature) returns (bool)`,
  `function spend(${PERMISSION} spendPermission, uint160 value)`,
  `function revoke(${PERMISSION} spendPermission)`,
  `function isApproved(${PERMISSION} spendPermission) view returns (bool)`,
  `function isValid(${PERMISSION} spendPermission) view returns (bool)`,
  `function isRevoked(${PERMISSION} spendPermission) view returns (bool)`,
  `function getCurrentPeriod(${PERMISSION} spendPermission) view returns ((uint48 start, uint48 end, uint160 spend))`,
]);

/** ERC-6492 magic suffix. */
const ERC6492_SUFFIX = '0x6492649264926492649264926492649264926492649264926492649264926492';

const MAX_UINT48 = 2 ** 48 - 1;
const MAX_UINT160 = 2n ** 160n - 1n;

/** Refuses permissions the contract would reject or that break our rules (non-renewing jobs etc.). */
export function checkPermission(permission: SpendPermission): void {
  const { allowance, period, start, end, salt } = permission;
  if (allowance <= 0n || allowance > MAX_UINT160) throw new Error('Allowance out of range.');
  for (const value of [period, start, end])
    if (!Number.isInteger(value) || value < 0 || value > MAX_UINT48)
      throw new Error('Period, start and end must be uint48 seconds.');
  if (period === 0) throw new Error('Period must be positive.');
  if (end <= start) throw new Error('End must be after start.');
  if (salt < 0n || salt >= 2n ** 256n) throw new Error('Salt must be a uint256.');
  if (
    typeof permission.extraData !== 'string' ||
    !/^0x([0-9a-fA-F]{2})*$/.test(permission.extraData)
  )
    throw new Error('extraData must be hex bytes.');
}

/** A job-scoped, non-renewing permission: exactly one period covering start..end (§11.4). */
export function nonRenewing(permission: Omit<SpendPermission, 'period'>): SpendPermission {
  return { ...permission, period: permission.end - permission.start };
}

/** The hash the manager signs over, read from the contract so it always matches its EIP-712 domain. */
export function permissionHash(
  client: PublicClient,
  network: BaseNetwork,
  permission: SpendPermission,
): Promise<Hex> {
  checkPermission(permission);
  return client.readContract({
    address: network.contracts.spendPermissionManager,
    abi: spendPermissionManagerAbi,
    functionName: 'getHash',
    args: [permission],
  });
}

/**
 * The typed data the owner signs in the browser: the wallet's replay-safe wrapper around the
 * permission hash. Only the browser holds the owner key; the server never calls this with one.
 */
export function ownerTypedData(chainId: number, wallet: Address, hash: Hex) {
  // One definition for both sides: the browser signs exactly this (shared/base/spend-limits.ts).
  return smartWalletMessageTypedData(chainId, wallet, hash);
}

/** Wraps the owner's raw signature for the wallet; adds ERC-6492 when the wallet is not deployed. */
export function walletSignature(
  ownerSignature: Hex,
  options: { ownerIndex: number; undeployedRecipe?: DerivationRecipe },
): Hex {
  const wrapped = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'ownerIndex', type: 'uint8' },
          { name: 'signatureData', type: 'bytes' },
        ],
      },
    ],
    [{ ownerIndex: options.ownerIndex, signatureData: ownerSignature }],
  );
  const recipe = options.undeployedRecipe;
  if (!recipe) return wrapped;
  const deploy = encodeFunctionData(createAccountCall(recipe));
  return concat([
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      [recipe.factory, deploy, wrapped],
    ),
    ERC6492_SUFFIX,
  ]);
}

/** The two calls of an agent's first spend: approve (deploys the wallet) and spend, in order. */
export function firstSpendCalls(
  network: BaseNetwork,
  permission: SpendPermission,
  signature: Hex,
  value: bigint,
) {
  checkPermission(permission);
  if (value <= 0n || value > permission.allowance) throw new Error('Spend value out of range.');
  const target = network.contracts.spendPermissionManager;
  return [
    {
      target,
      value: 0n,
      data: encodeFunctionData({
        abi: spendPermissionManagerAbi,
        functionName: 'approveWithSignature',
        args: [permission, signature],
      }),
    },
    {
      target,
      value: 0n,
      data: encodeFunctionData({
        abi: spendPermissionManagerAbi,
        functionName: 'spend',
        args: [permission, value],
      }),
    },
  ];
}
