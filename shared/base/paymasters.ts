/*
 * Who may pay an owner operation's network fee (Operation Base Wallet; fees are covered, the
 * product owner's decision): a sponsoring paymaster whose data charges the wallet nothing. Checked
 * from the operation's own paymasterAndData, never from history; anything else fails closed (the
 * server prepares nothing, the browser signs nothing).
 *
 * Base mainnet: 0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c, Coinbase's VerifyingPaymaster for
 * EntryPoint v0.6 (entryPoint() = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789). Its source is an
 * exact Sourcify match (runtime and creation bytecode, solc 0.8.25) and it is not a proxy. Its
 * paymasterAndData is
 *   [0:20] paymaster  [20:26] validUntil  [26:32] validAfter  [32:48] sponsorUUID
 *   [48] allowAnyBundler  [49] precheckBalance  [50] prepaymentRequired
 *   [51:71] token  [71:91] receiver  [91:123] exchangeRate  [123:129] postOpGas  [129:194] signature
 * It charges the sender only in an ERC-20 token: safeTransferFrom at validation when
 * prepaymentRequired, and in postOp, both only when token != address(0). With token == 0 it does
 * no token logic and only emits UserOperationSponsored; the gas comes from its EntryPoint deposit.
 * So: the pinned address, exactly 194 bytes (its signature is 65 bytes), token all zero.
 *
 * Base Sepolia: nothing is pinned from evidence, so it fails closed there too. Tests pass their
 * own allowlist.
 */
import { getAddress } from 'viem';
import { BASE_MAINNET, type Address } from './chains.js';

export type SponsorAllowlist = Readonly<Record<number, readonly Address[]>>;

export const SPONSOR_PAYMASTERS: SponsorAllowlist = {
  [BASE_MAINNET]: ['0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c'],
};

/** paymasterAndData of the pinned verifying paymaster: 129 bytes of fields + a 65-byte signature. */
export const SPONSOR_DATA_BYTES = 194;
const TOKEN = { from: 51, to: 71 };

/**
 * Whether paymasterAndData names a paymaster allowed on that network, in its exact layout, with no
 * token to charge the wallet in. Anything else (none, unknown, malformed, a token) is false.
 */
export function sponsoredWithoutCharge(
  chainId: number,
  paymasterAndData: string | undefined,
  allowlist: SponsorAllowlist = SPONSOR_PAYMASTERS,
): boolean {
  const data = paymasterAndData ?? '0x';
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length !== 2 + SPONSOR_DATA_BYTES * 2) return false;
  const paymaster = getAddress(data.slice(0, 42));
  if (!(allowlist[chainId] ?? []).some((address) => getAddress(address) === paymaster))
    return false;
  return /^0+$/.test(data.slice(2 + TOKEN.from * 2, 2 + TOKEN.to * 2));
}

/**
 * A pinned sponsorship must already be valid and expire within the caller's original deadline.
 * Times are milliseconds; the signed paymaster fields are uint48 seconds. Zero validUntil means
 * unbounded validity to EntryPoint, so it is deliberately refused. Callers supply a fixed deadline,
 * including any explicit allowance, rather than extending it on each retry.
 */
export function sponsoredWithinDeadline(
  chainId: number,
  paymasterAndData: string | undefined,
  window: { now: number; deadline: number },
  allowlist: SponsorAllowlist = SPONSOR_PAYMASTERS,
): boolean {
  if (
    !Number.isSafeInteger(window.now) ||
    !Number.isSafeInteger(window.deadline) ||
    window.now < 0 ||
    window.deadline <= window.now ||
    !sponsoredWithoutCharge(chainId, paymasterAndData, allowlist)
  )
    return false;
  const data = paymasterAndData!;
  const validUntil = BigInt(`0x${data.slice(42, 54)}`) * 1000n;
  const validAfter = BigInt(`0x${data.slice(54, 66)}`) * 1000n;
  return (
    validUntil > BigInt(window.now) &&
    validUntil <= BigInt(window.deadline) &&
    validAfter <= BigInt(window.now) &&
    validAfter < validUntil
  );
}
