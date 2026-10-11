/*
 * Signed run authorization (docs/base/ARCHITECTURE.md §11.4): before a bulk provisioning run
 * reserves or sends anything, the treasury owner signs one RunIntent in the browser, fixing the
 * workspace, network, treasury, the exact agent manifest, a principal ceiling per token, a fee
 * ceiling, a nonce and a validity window. The server verifies it here and never signs for the owner.
 *
 * The signature is checked by the treasury account itself (ERC-1271; ERC-6492 when the treasury is
 * not deployed yet), so it proves the treasury's owner key approved exactly this intent.
 */
import { getAddress, hashTypedData, isAddress, type Hex, type PublicClient } from 'viem';
import { allowedToken, type Address, type BaseNetwork } from '../../../shared/base/chains.js';

export interface RunIntent {
  workspaceId: string;
  chainId: number;
  treasury: Address;
  /** Hash of the immutable, ordered agent manifest the run may touch. */
  manifestHash: Hex;
  /** Most the run may move per token (integer base units). */
  principal: { token: Address; amount: bigint }[];
  /** Most the run may cost in gas/fees across all its operations (wei). */
  feeCeilingWei: bigint;
  /** Unique per workspace; a nonce is accepted once. */
  nonce: bigint;
  /** Unix seconds. */
  notBefore: number;
  expiry: number;
}

/** Longest validity window accepted for one signed run. */
export const MAX_RUN_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const types = {
  Principal: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  RunIntent: [
    { name: 'workspaceId', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'treasury', type: 'address' },
    { name: 'manifestHash', type: 'bytes32' },
    { name: 'principal', type: 'Principal[]' },
    { name: 'feeCeilingWei', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

/** The EIP-712 typed data the owner signs (wrapped by the treasury wallet's replay-safe hash). */
export function runTypedData(intent: RunIntent) {
  return {
    domain: {
      name: 'Central City Run',
      version: '1',
      chainId: intent.chainId,
      verifyingContract: getAddress(intent.treasury),
    },
    types,
    primaryType: 'RunIntent' as const,
    message: {
      workspaceId: intent.workspaceId,
      chainId: BigInt(intent.chainId),
      treasury: getAddress(intent.treasury),
      manifestHash: intent.manifestHash,
      principal: intent.principal.map((p) => ({ token: getAddress(p.token), amount: p.amount })),
      feeCeilingWei: intent.feeCeilingWei,
      nonce: intent.nonce,
      notBefore: BigInt(intent.notBefore),
      expiry: BigInt(intent.expiry),
    },
  };
}

/** The hash the treasury validates (ERC-1271 `isValidSignature(hash, signature)`). */
export const runIntentHash = (intent: RunIntent): Hex => hashTypedData(runTypedData(intent));

export type RunCheck =
  /** `intent` is the exact snapshot that was checked and hashed: persist this one, not the input. */
  | { ok: true; intentHash: Hex; intent: RunIntent }
  | {
      ok: false;
      reason:
        | 'WRONG_NETWORK'
        | 'TOKEN_NOT_ALLOWED'
        | 'DUPLICATE_TOKEN'
        | 'INVALID_AMOUNT'
        | 'INVALID_WINDOW'
        | 'NOT_YET_VALID'
        | 'EXPIRED'
        | 'NONCE_USED'
        | 'MALFORMED_INTENT'
        | 'UNAVAILABLE'
        | 'BAD_SIGNATURE';
    };

const MAX_UINT64 = 2 ** 64 - 1;
const isUint = (value: unknown, max: bigint) =>
  typeof value === 'bigint' && value >= 0n && value < max;
const isSeconds = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT64;

/** Most principal entries one run may name. */
const MAX_PRINCIPAL_ENTRIES = 8;

/**
 * A detached, frozen copy of the intent, each field read exactly once. Everything after it (checks,
 * the nonce lookup, hashing, the signature check) uses the copy, so a caller's object that changes
 * while the verifier awaits can never make it check one intent and hash another. Only primitives
 * are copied (addresses must be real strings, never objects with their own toString), and the
 * principal list is copied by index into a fresh array, never through the caller's own `map` or
 * array species. Null when the input can't be copied this way (MALFORMED_INTENT).
 */
function snapshot(intent: RunIntent): RunIntent | null {
  try {
    const principal: unknown = intent.principal;
    if (!Array.isArray(principal)) return null;
    // Length read once and capped before anything walks the list.
    const length: unknown = principal.length;
    if (typeof length !== 'number' || length > MAX_PRINCIPAL_ENTRIES) return null;
    const entries: { token: Address; amount: bigint }[] = [];
    for (let index = 0; index < length; index++) {
      const entry: unknown = principal[index];
      if (typeof entry !== 'object' || entry === null) return null;
      const { token, amount } = entry as { token: unknown; amount: unknown };
      if (typeof token !== 'string' || typeof amount !== 'bigint') return null;
      entries.push(Object.freeze({ token: token as Address, amount }));
    }
    const copy = {
      workspaceId: intent.workspaceId,
      chainId: intent.chainId,
      treasury: intent.treasury,
      manifestHash: intent.manifestHash,
      principal: Object.freeze(entries) as RunIntent['principal'],
      feeCeilingWei: intent.feeCeilingWei,
      nonce: intent.nonce,
      notBefore: intent.notBefore,
      expiry: intent.expiry,
    };
    if (typeof copy.treasury !== 'string') return null;
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

/** Structural checks that make hashing and verification safe; false means MALFORMED_INTENT. */
function wellFormed(intent: RunIntent, signature: unknown): boolean {
  return (
    typeof intent === 'object' &&
    intent !== null &&
    typeof intent.workspaceId === 'string' &&
    intent.workspaceId.length > 0 &&
    intent.workspaceId.length <= 128 &&
    Number.isSafeInteger(intent.chainId) &&
    isAddress(intent.treasury, { strict: false }) &&
    typeof intent.manifestHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(intent.manifestHash) &&
    Array.isArray(intent.principal) &&
    intent.principal.length <= 8 &&
    intent.principal.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        isAddress(p.token, { strict: false }) &&
        typeof p.amount === 'bigint',
    ) &&
    isUint(intent.feeCeilingWei, 2n ** 256n) &&
    isUint(intent.nonce, 2n ** 256n) &&
    isSeconds(intent.notBefore) &&
    isSeconds(intent.expiry) &&
    typeof signature === 'string' &&
    /^0x([0-9a-fA-F]{2})*$/.test(signature)
  );
}

export interface VerifyRunDeps {
  client: PublicClient;
  network: BaseNetwork;
  /** True when this workspace already used the nonce (stored with the job). */
  nonceUsed(workspaceId: string, nonce: bigint): Promise<boolean>;
  /** Unix seconds. */
  now?: () => number;
}

/**
 * Checks everything about a signed run before any reservation: shape, network, tokens, amounts,
 * window, replay and, last, the signature itself. Never throws: every outcome is a result, and
 * anything that cannot be checked (nonce store or RPC down, RPC on another network) fails closed
 * with UNAVAILABLE or WRONG_NETWORK.
 */
export async function verifyRunAuthorization(
  deps: VerifyRunDeps,
  input: RunIntent,
  signature: Hex,
): Promise<RunCheck> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // Copied before the first check and the first await; the input is never read again.
  const intent = typeof input === 'object' && input !== null ? snapshot(input) : null;
  if (!intent || !wellFormed(intent, signature)) return { ok: false, reason: 'MALFORMED_INTENT' };
  if (intent.chainId !== deps.network.chainId) return { ok: false, reason: 'WRONG_NETWORK' };
  const seen = new Set<string>();
  for (const { token, amount } of intent.principal) {
    if (!allowedToken(deps.network, token)) return { ok: false, reason: 'TOKEN_NOT_ALLOWED' };
    if (seen.has(token.toLowerCase())) return { ok: false, reason: 'DUPLICATE_TOKEN' };
    seen.add(token.toLowerCase());
    if (amount <= 0n || amount >= 2n ** 160n) return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  if (intent.principal.length === 0 || intent.feeCeilingWei <= 0n || intent.nonce < 0n)
    return { ok: false, reason: 'INVALID_AMOUNT' };
  if (
    intent.expiry <= intent.notBefore ||
    intent.expiry - intent.notBefore > MAX_RUN_WINDOW_SECONDS
  )
    return { ok: false, reason: 'INVALID_WINDOW' };
  const at = now();
  if (at < intent.notBefore) return { ok: false, reason: 'NOT_YET_VALID' };
  if (at >= intent.expiry) return { ok: false, reason: 'EXPIRED' };
  let used: boolean;
  try {
    used = await deps.nonceUsed(intent.workspaceId, intent.nonce);
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  if (used) return { ok: false, reason: 'NONCE_USED' };

  // The signature is checked against the treasury's on-chain state, so the RPC must be on the
  // run's network: the same address on another network could hold a different account.
  let rpcChainId: number;
  try {
    rpcChainId = await deps.client.getChainId();
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  if (rpcChainId !== deps.network.chainId) return { ok: false, reason: 'WRONG_NETWORK' };

  let intentHash: Hex;
  try {
    intentHash = runIntentHash(intent);
  } catch {
    return { ok: false, reason: 'MALFORMED_INTENT' };
  }
  let valid: boolean;
  try {
    valid = await deps.client.verifyHash({
      address: getAddress(intent.treasury),
      hash: intentHash,
      signature,
    });
  } catch {
    // The verification call itself failed (RPC down): not proof of a bad signature.
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  return valid ? { ok: true, intentHash, intent } : { ok: false, reason: 'BAD_SIGNATURE' };
}
