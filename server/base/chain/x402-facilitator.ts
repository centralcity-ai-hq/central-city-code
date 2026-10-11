/*
 * x402 v2 facilitator client for the "exact" scheme on EVM, EIP-3009 only (Base room #361). It
 * sends an authorization that the chain module already issued and stored (x402.ts) to a facilitator's
 * POST /verify and POST /settle, and classifies the answer without ever signing anything new:
 *
 *   success                                   → settled (transaction hash)
 *   errorReason "settlement_pending" + tx     → pending: the broadcast transaction is kept and
 *                                               reconciled on-chain; never re-signed or replaced
 *   any other refusal                         → refused (reason only)
 *   timeout, network error, unparseable reply → unknown: the payment may still settle, so it is
 *                                               reconciled, never treated as a refusal
 *
 * Other transfer methods (Permit2, ERC-7710) are refused explicitly. Smart-account payers sign with
 * an ERC-1271-wrapped signature; a facilitator's acceptance of that is exactly what the integration
 * gate test proves before x402 is enabled anywhere.
 */
import { getAddress, type Hex } from 'viem';
import { allowedToken, type BaseNetwork } from '../../../shared/base/chains.js';
import type { IssuedAuthorization } from './x402.js';

export const X402_VERSION = 2;

/** One entry of a resource's PaymentRequired.accepts (x402 v2, exact scheme). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { assetTransferMethod?: string; name?: string; version?: string };
}

export class FacilitatorError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_SCHEME'
      | 'UNSUPPORTED_METHOD'
      | 'WRONG_NETWORK'
      | 'TOKEN_NOT_ALLOWED'
      | 'REQUIREMENTS_MISMATCH',
    message: string,
  ) {
    super(message);
  }
}

export type VerifyResult =
  | { kind: 'valid'; payer: string | null }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unknown' };

export type SettleResult =
  | { kind: 'settled'; transaction: Hex }
  | { kind: 'pending'; transaction: Hex }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown' };

export const caip2 = (chainId: number) => `eip155:${chainId}`;

/**
 * Checks that the stored authorization pays exactly what the resource asked for, then builds the
 * v2 PaymentPayload. Nothing is signed here; the authorization is used exactly as stored.
 */
export function exactPaymentPayload(
  network: BaseNetwork,
  requirements: PaymentRequirements,
  issued: IssuedAuthorization,
) {
  if (requirements.scheme !== 'exact')
    throw new FacilitatorError('UNSUPPORTED_SCHEME', 'Only the exact scheme is supported.');
  const method = requirements.extra?.assetTransferMethod ?? 'eip3009';
  if (method !== 'eip3009')
    throw new FacilitatorError('UNSUPPORTED_METHOD', 'Only EIP-3009 transfers are supported.');
  if (requirements.network !== caip2(network.chainId) || issued.chainId !== network.chainId)
    throw new FacilitatorError('WRONG_NETWORK', 'The payment is for another network.');
  const token = allowedToken(network, requirements.asset);
  if (!token?.eip712 || getAddress(token.address) !== getAddress(issued.token))
    throw new FacilitatorError('TOKEN_NOT_ALLOWED', 'This asset cannot be paid with EIP-3009.');
  const a = issued.authorization;
  const domainMatches =
    (requirements.extra?.name ?? token.eip712.name) === token.eip712.name &&
    (requirements.extra?.version ?? token.eip712.version) === token.eip712.version;
  if (
    !/^(0|[1-9][0-9]{0,77})$/.test(requirements.amount) ||
    BigInt(requirements.amount) !== a.value ||
    getAddress(requirements.payTo) !== getAddress(a.to) ||
    !domainMatches
  )
    throw new FacilitatorError(
      'REQUIREMENTS_MISMATCH',
      'The stored authorization does not pay what the resource asked for.',
    );
  return {
    x402Version: X402_VERSION,
    accepted: requirements,
    payload: {
      signature: issued.signature,
      authorization: {
        from: getAddress(a.from),
        to: getAddress(a.to),
        value: a.value.toString(10),
        validAfter: a.validAfter.toString(10),
        validBefore: a.validBefore.toString(10),
        nonce: a.nonce,
      },
    },
  };
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// Provider text may echo credentials or payment payloads. Only known literal codes escape.
const safeReason = (value: unknown): string =>
  value === 'invalid_signature' || value === 'insufficient_funds' ? value : 'unspecified';

export function facilitatorClient(options: {
  /** Facilitator base URL; it may carry credentials, so it never appears in errors or results. */
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');

  async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      const json = (await response.json()) as unknown;
      return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return {
    async verify(
      paymentPayload: unknown,
      paymentRequirements: PaymentRequirements,
    ): Promise<VerifyResult> {
      const json = await post('/verify', {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      });
      if (!json || typeof json.isValid !== 'boolean') return { kind: 'unknown' };
      if (json.isValid)
        return { kind: 'valid', payer: typeof json.payer === 'string' ? json.payer : null };
      return {
        kind: 'invalid',
        reason: safeReason(json.invalidReason),
      };
    },

    async settle(
      paymentPayload: unknown,
      paymentRequirements: PaymentRequirements,
    ): Promise<SettleResult> {
      const json = await post('/settle', {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      });
      if (!json || typeof json.success !== 'boolean') return { kind: 'unknown' };
      const transaction = typeof json.transaction === 'string' ? json.transaction : '';
      if (json.success)
        return TX_HASH.test(transaction)
          ? { kind: 'settled', transaction: transaction as Hex }
          : { kind: 'unknown' };
      if (json.errorReason === 'settlement_pending')
        // A pending settlement without its transaction cannot be reconciled: still never a refusal.
        return TX_HASH.test(transaction)
          ? { kind: 'pending', transaction: transaction as Hex }
          : { kind: 'unknown' };
      return {
        kind: 'refused',
        reason: safeReason(json.errorReason),
      };
    },
  };
}
