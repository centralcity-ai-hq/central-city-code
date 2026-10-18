/*
 * Spending limits (Operation Base Wallet W3; contract v1.3): what the browser and the server share.
 *
 * The owner signs ONE spend permission per token for the agent's spender (SpendPermissionManager,
 * EIP-712). That permission is the only security bound: a stolen agent key can never move more
 * than its allowance per on-chain period. On-chain periods are FIXED lengths, starting at 00:00
 * Europe/Berlin of the day the owner signs (`berlinDayStart`), so the first period is the current
 * one and a new limit works at once: a day is 86,400 s, a week 604,800 s, a month 2,678,400 s
 * (31 days). SpendPermissionManager takes a start in the past: approveWithSignature does not check
 * the start, and spend / getCurrentPeriod only need block.timestamp >= start.
 *
 * Two on-chain models, chosen by one server setting (`OnchainCapModel`):
 *   'half'  the allowance per Base period is floor(cap / 2), so even the burst around a reset (one
 *           period's allowance just before it and the next one just after) stays within the cap
 *           the owner chose. The default.
 *   'full'  the allowance per Base period is the cap; around a reset an agent could spend up to the
 *           cap just before and the cap again just after, and the limit screen says so.
 * Either way Central City ALSO counts the Berlin calendar day / week (Monday) / month (the 1st)
 * and refuses agent spends beyond the full cap in it. That counter is stricter, never looser, and
 * is never presented as protection: Base enforces the permission, nothing else.
 *
 * The browser recomputes `spendPermissionHash` from the permission it was given and signs
 * `smartWalletMessageTypedData` over it (the wallet's ERC-1271 replay-safe wrapper), so the owner
 * signs exactly the limit on screen.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  hexToBigInt,
  isAddress,
  parseAbi,
  type Hex,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { BASE_NETWORKS, type Address, type BaseChainId } from './chains.js';
import type { SpendPermission } from './types.js';

export const LIMIT_TIME_ZONE = 'Europe/Berlin';

export type LimitPeriod = 'day' | 'week' | 'month';

/** The fixed on-chain period lengths (seconds). */
export const LIMIT_PERIOD_SECONDS: Readonly<Record<LimitPeriod, number>> = Object.freeze({
  day: 86_400,
  week: 604_800,
  month: 2_678_400,
});

/** The calendar period behind an on-chain period length, or null for any other length. */
export function limitPeriodOf(seconds: number): LimitPeriod | null {
  for (const [period, length] of Object.entries(LIMIT_PERIOD_SECONDS))
    if (length === seconds) return period as LimitPeriod;
  return null;
}

/** A limit has no end of its own: the largest uint48, as the Base SDKs use for "no end". */
export const LIMIT_PERMISSION_END = 281_474_976_710_655;

/** How long a prepared limit (or an unsigned revoke) can still be signed. */
export const LIMIT_SIGNATURE_TTL_MS = 10 * 60_000;

export type OnchainCapModel = 'half' | 'full';
export const DEFAULT_ONCHAIN_CAP_MODEL: OnchainCapModel = 'half';

/** The server setting; anything but exactly 'full' is the stricter 'half'. */
export function onchainCapModel(value: string | undefined): OnchainCapModel {
  return value?.trim() === 'full' ? 'full' : DEFAULT_ONCHAIN_CAP_MODEL;
}

/** The on-chain allowance per Base period for the owner's cap under a model. */
export function onchainAllowance(cap: bigint, model: OnchainCapModel): bigint {
  return model === 'half' ? cap / 2n : cap;
}

/** The SpendPermissionManager's EIP-712 struct (field order and types as the contract hashes it). */
export const SPEND_PERMISSION_TYPES = {
  SpendPermission: [
    { name: 'account', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'allowance', type: 'uint160' },
    { name: 'period', type: 'uint48' },
    { name: 'start', type: 'uint48' },
    { name: 'end', type: 'uint48' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraData', type: 'bytes' },
  ],
} as const;

/** The typed data SpendPermissionManager.getHash computes on the given network. */
export function spendPermissionTypedData(chainId: BaseChainId, permission: SpendPermission) {
  return {
    domain: {
      name: 'Spend Permission Manager',
      version: '1',
      chainId,
      verifyingContract: BASE_NETWORKS[chainId].contracts.spendPermissionManager,
    },
    types: SPEND_PERMISSION_TYPES,
    primaryType: 'SpendPermission' as const,
    message: permission,
  };
}

/** SpendPermissionManager.getHash, computed locally (no RPC). */
export function spendPermissionHash(chainId: BaseChainId, permission: SpendPermission): Hex {
  return hashTypedData(spendPermissionTypedData(chainId, permission));
}

/**
 * What the owner key signs for a Coinbase Smart Wallet: its replay-safe wrapper
 * (CoinbaseSmartWalletMessage) around a hash, bound to the wallet and the network.
 */
export function smartWalletMessageTypedData(chainId: number, wallet: Address, hash: Hex) {
  return {
    domain: { name: 'Coinbase Smart Wallet', version: '1', chainId, verifyingContract: wallet },
    types: { CoinbaseSmartWalletMessage: [{ name: 'hash', type: 'bytes32' }] },
    primaryType: 'CoinbaseSmartWalletMessage' as const,
    message: { hash },
  };
}

/** A permission as JSON: integers that may exceed 2^53 as decimal strings, seconds as numbers. */
export interface SpendPermissionJson {
  account: Address;
  spender: Address;
  token: Address;
  allowance: string;
  period: number;
  start: number;
  end: number;
  salt: string;
  extraData: Hex;
}

export const permissionToJson = (permission: SpendPermission): SpendPermissionJson => ({
  account: permission.account,
  spender: permission.spender,
  token: permission.token,
  allowance: permission.allowance.toString(10),
  period: permission.period,
  start: permission.start,
  end: permission.end,
  salt: permission.salt.toString(10),
  extraData: permission.extraData,
});

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const UINT48 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 48;

/** Parses a permission sent back as JSON; null when any field is missing or malformed. */
export function permissionFromJson(raw: unknown): SpendPermission | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'account,allowance,end,extraData,period,salt,spender,start,token') return null;
  const { account, spender, token, allowance, period, start, end, salt, extraData } = value;
  for (const address of [account, spender, token])
    if (typeof address !== 'string' || !isAddress(address, { strict: false })) return null;
  if (typeof allowance !== 'string' || !DECIMAL.test(allowance)) return null;
  if (typeof salt !== 'string' || !DECIMAL.test(salt)) return null;
  if (!UINT48(period) || !UINT48(start) || !UINT48(end)) return null;
  if (typeof extraData !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(extraData)) return null;
  return {
    account: getAddress(account as string),
    spender: getAddress(spender as string),
    token: getAddress(token as string),
    allowance: BigInt(allowance),
    period: period as number,
    start: start as number,
    end: end as number,
    salt: BigInt(salt),
    extraData: extraData.toLowerCase() as Hex,
  };
}

// ---------------------------------------------------------------------------------------------
// Revoking a limit: a UserOperation from the agent wallet itself calling
// SpendPermissionManager.revoke(permission), signed by the owner key over its RAW userOpHash.

const revokeAbi = parseAbi([
  'function revoke((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) spendPermission)',
]);
const smartWalletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data) payable',
]);

/** The one call of a revoke. */
export function revokeCall(chainId: BaseChainId, permission: SpendPermission) {
  return {
    target: BASE_NETWORKS[chainId].contracts.spendPermissionManager,
    value: 0n,
    data: encodeFunctionData({ abi: revokeAbi, functionName: 'revoke', args: [permission] }),
  };
}

/** A v0.6 UserOperation as JSON-RPC carries it: every quantity hex-encoded. */
export interface RpcUserOperation {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export function userOperationFromRpc(op: RpcUserOperation): UserOperation<'0.6'> {
  return {
    sender: getAddress(op.sender),
    nonce: hexToBigInt(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    callGasLimit: hexToBigInt(op.callGasLimit),
    verificationGasLimit: hexToBigInt(op.verificationGasLimit),
    preVerificationGas: hexToBigInt(op.preVerificationGas),
    maxFeePerGas: hexToBigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: hexToBigInt(op.maxPriorityFeePerGas),
    paymasterAndData: op.paymasterAndData,
    signature: '0x',
  };
}

/**
 * What the browser checks before the owner signs a revoke: the operation is sent by the agent
 * wallet, its only call is the wallet executing SpendPermissionManager.revoke(permission) with no
 * value, and the hash to sign is this operation's own. Returns that hash; throws on any mismatch.
 */
export function checkRevokeOperation(
  chainId: BaseChainId,
  rpc: RpcUserOperation,
  expected: { wallet: Address; permission: SpendPermission },
): Hex {
  const op = userOperationFromRpc(rpc);
  if (op.sender !== getAddress(expected.wallet)) throw new Error('Not this wallet.');
  const call = revokeCall(chainId, expected.permission);
  const decoded = decodeFunctionData({ abi: smartWalletAbi, data: op.callData });
  if (
    decoded.functionName !== 'execute' ||
    getAddress(decoded.args[0]) !== call.target ||
    decoded.args[1] !== 0n ||
    decoded.args[2].toLowerCase() !== call.data.toLowerCase()
  )
    throw new Error('Not the revoke of this limit.');
  return getUserOperationHash({
    chainId,
    entryPointAddress: BASE_NETWORKS[chainId].contracts.entryPointV06,
    entryPointVersion: '0.6',
    userOperation: op,
  });
}

// ---------------------------------------------------------------------------------------------
// The Berlin calendar (DST-aware, from the runtime's time-zone data). Midnight in Berlin always
// exists exactly once: the clocks change at 02:00 / 03:00, never at midnight.

const berlinClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: LIMIT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Berlin wall clock at an instant (ms). */
function berlinWall(ms: number) {
  const parts: Record<string, number> = {};
  for (const part of berlinClock.formatToParts(ms))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

/** Berlin's offset from UTC at an instant (ms; +1 h in winter, +2 h in summer). */
function berlinOffsetMs(ms: number): number {
  const wall = berlinWall(ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The Berlin calendar date at an instant; weekday 1 = Monday … 7 = Sunday. */
export function berlinDate(ms: number) {
  const wall = berlinWall(ms);
  const sundayFirst = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  return { year: wall.year, month: wall.month, day: wall.day, weekday: sundayFirst || 7 };
}

/**
 * 00:00 Berlin on a calendar date, as unix seconds. Day and month may overflow (day 32, month 13):
 * they roll over like Date.UTC.
 */
export function berlinMidnight(year: number, month: number, day: number): number {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  let at = wallAsUtc - berlinOffsetMs(wallAsUtc);
  // The offset at the true instant decides (it differs only when a switch lies in between).
  const offset = berlinOffsetMs(at);
  at = wallAsUtc - offset;
  return at / 1000;
}

/** The first 00:00 Berlin strictly after an instant (ms), as unix seconds. */
export function nextBerlinMidnight(nowMs: number): number {
  const today = berlinDate(nowMs);
  return berlinMidnight(today.year, today.month, today.day + 1);
}

/**
 * The last 00:00 Berlin at or before an instant (ms): the start of its Berlin day, as unix seconds.
 * A new limit starts here, so its first on-chain period is the current one.
 */
export function berlinDayStart(nowMs: number): number {
  const today = berlinDate(nowMs);
  return berlinMidnight(today.year, today.month, today.day);
}

/** The Berlin calendar day, week (from Monday) or month (from the 1st) containing an instant. */
export function calendarPeriod(period: LimitPeriod, nowMs: number): { start: number; end: number } {
  const today = berlinDate(nowMs);
  if (period === 'day')
    return {
      start: berlinMidnight(today.year, today.month, today.day),
      end: berlinMidnight(today.year, today.month, today.day + 1),
    };
  if (period === 'week') {
    const monday = today.day - (today.weekday - 1);
    return {
      start: berlinMidnight(today.year, today.month, monday),
      end: berlinMidnight(today.year, today.month, monday + 7),
    };
  }
  return {
    start: berlinMidnight(today.year, today.month, 1),
    end: berlinMidnight(today.year, today.month + 1, 1),
  };
}
