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
  [BASE_MAINNET]: [
    '0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c',
    // Our own instance (Operation Paymaster, deployed 23 Oct 2026, block 53000665): runtime code
    // byte-identical to Coinbase's above (8,347 bytes), owner our admin, verifyingSigner our
    // server-held key, entryPoint v0.6. Same layout and the same token-zero rule apply.
    '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
  ],
};

/** paymasterAndData of the pinned verifying paymaster: 129 bytes of fields + a 65-byte signature. */
export const SPONSOR_DATA_BYTES = 194;
const TOKEN = { from: 51, to: 71 };
/** The signed validity window, uint48 seconds each (byte offsets in the layout above). */
const VALID_UNTIL = { from: 20, to: 26 };
const VALID_AFTER = { from: 26, to: 32 };
/** A field of paymasterAndData (already checked to be the pinned layout), as a number. */
const field = (data: string, at: { from: number; to: number }) =>
  BigInt(`0x${data.slice(2 + at.from * 2, 2 + at.to * 2)}`);

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
 *
 * `expirySkewMs` (browser only; the server passes none) tolerates a device clock that runs that
 * much ahead: the "not expired yet" checks use `now - expirySkewMs`. It never loosens the other
 * bounds: validUntil stays within the deadline, and validAfter must have passed by `now` itself,
 * so a sponsorship that starts in the future is still refused.
 */
export function sponsoredWithinDeadline(
  chainId: number,
  paymasterAndData: string | undefined,
  window: { now: number; deadline: number; expirySkewMs?: number },
  allowlist: SponsorAllowlist = SPONSOR_PAYMASTERS,
): boolean {
  const skew = window.expirySkewMs ?? 0;
  if (
    !Number.isSafeInteger(window.now) ||
    !Number.isSafeInteger(window.deadline) ||
    !Number.isSafeInteger(skew) ||
    skew < 0 ||
    skew > MAX_EXPIRY_SKEW_MS ||
    window.now < 0 ||
    window.deadline <= window.now - skew ||
    !sponsoredWithoutCharge(chainId, paymasterAndData, allowlist)
  )
    return false;
  const data = paymasterAndData!;
  const validUntil = field(data, VALID_UNTIL) * 1000n;
  const validAfter = field(data, VALID_AFTER) * 1000n;
  return (
    validUntil > BigInt(window.now - skew) &&
    validUntil <= BigInt(window.deadline) &&
    validAfter <= BigInt(window.now) &&
    validAfter < validUntil
  );
}

/**
 * When a sponsorship stops being valid, in milliseconds: the signed validUntil of paymasterAndData
 * in the pinned layout (no allowlist check here; callers check that first). Null when the data
 * isn't that layout, or validUntil is zero (unbounded to EntryPoint) or beyond a safe integer.
 */
export function sponsoredValidUntil(paymasterAndData: string | undefined): number | null {
  const data = paymasterAndData ?? '0x';
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length !== 2 + SPONSOR_DATA_BYTES * 2) return null;
  const until = field(data, VALID_UNTIL) * 1000n;
  return until > 0n && until <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(until) : null;
}

/**
 * Bundlers refuse an operation whose sponsorship ends within seconds, and EntryPoint refuses it once
 * Base's block time is past the paymaster's signed validUntil (AA32). A signature for a sponsored
 * operation is never taken that close to its sponsorship's end, whatever its signing deadline says:
 * lanes off keeps a longer deadline, but the sponsorship still ends about two minutes after prepare.
 */
export const SPONSOR_SEND_MARGIN_MS = 10_000;

/**
 * Whether a sponsored operation's sponsorship ends too soon to send it at `now` (milliseconds).
 * Owner-funded ('0x') never; data not in the pinned layout is left to the sponsor checks.
 */
export function sponsorshipEnding(paymasterAndData: string | undefined, now: number): boolean {
  if (!paymasterAndData || paymasterAndData === '0x') return false;
  const until = sponsoredValidUntil(paymasterAndData);
  return until !== null && until <= now + SPONSOR_SEND_MARGIN_MS;
}

/** The most a caller may tolerate a fast device clock (see sponsoredWithinDeadline). */
export const MAX_EXPIRY_SKEW_MS = 120_000;

/**
 * validUntil and validAfter of paymasterAndData in the pinned layout, in milliseconds; both zero
 * when it isn't that layout (no allowlist check here).
 */
export function sponsorshipWindow(paymasterAndData: string | undefined): {
  validUntil: bigint;
  validAfter: bigint;
} {
  const data = paymasterAndData ?? '0x';
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length !== 2 + SPONSOR_DATA_BYTES * 2)
    return { validUntil: 0n, validAfter: 0n };
  return {
    validUntil: field(data, VALID_UNTIL) * 1000n,
    validAfter: field(data, VALID_AFTER) * 1000n,
  };
}
