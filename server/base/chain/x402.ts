/*
 * EIP-3009 authorizations signed by an agent's spender smart account, for x402 payments
 * (docs/base/ARCHITECTURE.md §11.5, leg B). The payer is always the spender account, never the
 * owner's wallet and never a bare key: USDC (FiatToken v2.2) verifies the `bytes signature`
 * overload with ERC-1271, which a Coinbase Smart Wallet answers for its replay-safe hash.
 *
 * ERC-1271 needs deployed code, so the spender account must exist before an authorization is
 * handed out (its first operation deploys it). The nonce is deterministic per payment intent, so a
 * retry reproduces the same authorization instead of creating a second spendable one.
 */
import {
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  stringToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { allowedToken, type Address, type BaseNetwork } from '../../../shared/base/chains.js';
import { ownerTypedData, walletSignature } from './permissions.js';

export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export class AuthorizationError extends Error {
  constructor(
    readonly code:
      'TOKEN_NOT_SUPPORTED' | 'PAYER_NOT_DEPLOYED' | 'INVALID_WINDOW' | 'INVALID_AMOUNT',
    message: string,
  ) {
    super(message);
  }
}

/** Domain-separated, deterministic nonce: same payment intent → same authorization. */
export function authorizationNonce(input: {
  chainId: number;
  token: Address;
  payer: Address;
  paymentIntentId: string;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [
        keccak256(stringToHex('cc.x402.v1')),
        BigInt(input.chainId),
        getAddress(input.token),
        getAddress(input.payer),
        keccak256(stringToHex(input.paymentIntentId)),
      ],
    ),
  );
}

/** The EIP-712 typed data USDC verifies for transferWithAuthorization. */
export function transferAuthorizationTypedData(
  network: BaseNetwork,
  token: Address,
  authorization: TransferAuthorization,
) {
  const info = allowedToken(network, token);
  if (!info?.eip712)
    throw new AuthorizationError('TOKEN_NOT_SUPPORTED', 'Token has no EIP-3009 domain.');
  return {
    domain: {
      name: info.eip712.name,
      version: info.eip712.version,
      chainId: network.chainId,
      verifyingContract: getAddress(info.address),
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    } as const,
    primaryType: 'TransferWithAuthorization' as const,
    message: authorization,
  };
}

/**
 * Signs an EIP-3009 transfer authorization for the spender account with its key inside the
 * keystore. Returns the ERC-1271 signature (Coinbase Smart Wallet wrapper over the replay-safe
 * hash), to be passed to USDC's `transferWithAuthorization(..., bytes signature)`.
 */
export async function signTransferAuthorization(deps: {
  network: BaseNetwork;
  client: PublicClient;
  keystore: {
    withSigner<T>(
      ref: string,
      use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
    ): Promise<T>;
  };
  keyRef: string;
  token: Address;
  authorization: TransferAuthorization;
  /** Unix seconds, for the window check. */
  now?: number;
}): Promise<Hex> {
  const { authorization: a } = deps;
  if (a.value <= 0n || a.value >= 2n ** 256n)
    throw new AuthorizationError('INVALID_AMOUNT', 'Value must be a positive uint256.');
  const now = BigInt(deps.now ?? Math.floor(Date.now() / 1000));
  if (a.validBefore <= a.validAfter || a.validBefore <= now)
    throw new AuthorizationError('INVALID_WINDOW', 'The authorization window is empty or over.');
  if ((await deps.client.getCode({ address: a.from })) === undefined)
    throw new AuthorizationError(
      'PAYER_NOT_DEPLOYED',
      'ERC-1271 needs the spender account deployed first.',
    );
  const hash = hashTypedData(transferAuthorizationTypedData(deps.network, deps.token, a));
  return deps.keystore.withSigner(deps.keyRef, async (owner) =>
    walletSignature(await owner.signTypedData(ownerTypedData(deps.network.chainId, a.from, hash)), {
      ownerIndex: 0,
    }),
  );
}

/** A signed authorization as issued, frozen: retries hand out exactly this, never a new one. */
export interface IssuedAuthorization {
  paymentIntentId: string;
  chainId: number;
  token: Address;
  authorization: TransferAuthorization;
  signature: Hex;
}

/** Restricted storage for issued authorizations (never in views, logs or audit payloads). */
export interface AuthorizationStore {
  get(paymentIntentId: string): Promise<IssuedAuthorization | null>;
  /** Inserts unless the intent already has one; returns the stored row either way (atomic). */
  insert(row: IssuedAuthorization): Promise<IssuedAuthorization>;
}

/**
 * Issues the authorization for a payment intent exactly once: the first call signs it and stores
 * it BEFORE returning it; every later call returns the stored authorization unchanged (same window,
 * same nonce, same signature). Retry rule: chain, token, payer, recipient and value must match the
 * stored authorization or the request is refused; a different validity window asked for on a retry
 * is ignored (the stored, already-signed window is returned), so a retry can never widen it.
 */
export async function issueTransferAuthorization(
  deps: Parameters<typeof signTransferAuthorization>[0] & {
    store: AuthorizationStore;
    paymentIntentId: string;
  },
): Promise<IssuedAuthorization> {
  const existing = await deps.store.get(deps.paymentIntentId);
  const same = (stored: IssuedAuthorization) =>
    stored.chainId === deps.network.chainId &&
    getAddress(stored.token) === getAddress(deps.token) &&
    getAddress(stored.authorization.from) === getAddress(deps.authorization.from) &&
    getAddress(stored.authorization.to) === getAddress(deps.authorization.to) &&
    stored.authorization.value === deps.authorization.value;
  if (existing) {
    if (!same(existing))
      throw new AuthorizationError(
        'INVALID_AMOUNT',
        'This payment already has a different authorization.',
      );
    return existing;
  }
  const authorization = {
    ...deps.authorization,
    nonce: authorizationNonce({
      chainId: deps.network.chainId,
      token: deps.token,
      payer: deps.authorization.from,
      paymentIntentId: deps.paymentIntentId,
    }),
  };
  const signature = await signTransferAuthorization({ ...deps, authorization });
  const stored = await deps.store.insert({
    paymentIntentId: deps.paymentIntentId,
    chainId: deps.network.chainId,
    token: getAddress(deps.token),
    authorization,
    signature,
  });
  if (!same(stored))
    throw new AuthorizationError(
      'INVALID_AMOUNT',
      'This payment already has a different authorization.',
    );
  return stored;
}

/**
 * Signs USDC's CancelAuthorization for an unused nonce, so a payment that will not settle can be
 * invalidated on-chain before its funds are swept back (§11.5 recovery order).
 */
export async function signCancelAuthorization(deps: {
  network: BaseNetwork;
  keystore: {
    withSigner<T>(
      ref: string,
      use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
    ): Promise<T>;
  };
  keyRef: string;
  token: Address;
  authorizer: Address;
  nonce: Hex;
}): Promise<Hex> {
  const info = allowedToken(deps.network, deps.token);
  if (!info?.eip712)
    throw new AuthorizationError('TOKEN_NOT_SUPPORTED', 'Token has no EIP-3009 domain.');
  const hash = hashTypedData({
    domain: {
      name: info.eip712.name,
      version: info.eip712.version,
      chainId: deps.network.chainId,
      verifyingContract: getAddress(info.address),
    },
    types: {
      CancelAuthorization: [
        { name: 'authorizer', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
      ],
    } as const,
    primaryType: 'CancelAuthorization',
    message: { authorizer: getAddress(deps.authorizer), nonce: deps.nonce },
  });
  return deps.keystore.withSigner(deps.keyRef, async (owner) =>
    walletSignature(
      await owner.signTypedData(ownerTypedData(deps.network.chainId, deps.authorizer, hash)),
      { ownerIndex: 0 },
    ),
  );
}
