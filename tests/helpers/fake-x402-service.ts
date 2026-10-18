/*
 * A fake x402 service for Feed pay tests (server/feed/pay): it answers the engine's outbound
 * transport (FeedPayHttp) like the services of the 14 Oct live probe, without any network. One
 * instance serves any number of listed URLs, each with its own behaviour:
 *
 *   402 answers  v2 (PAYMENT-REQUIRED header), v1 (JSON body), v1 inside the body of a v2 answer,
 *                options listed Solana first, several Base payees, only another payee, upto only,
 *                another token domain, Permit2, a price that changes between quote and call
 *   other        free 200 with a PAYMENT-REQUIRED header, a redirect, 404, an unreadable 402, a
 *                timeout, an unreachable host, an oversize answer
 *   paid         settle (through the `settle` hook, the facilitator's part) and answer 200, settle
 *                and then fail (500), refuse the payment (402), lose the answer (timeout)
 *
 * Shapes only (the UI e2e reuses `paymentRequiredV2`, `acceptOption` and the modes). Synthetic data;
 * nothing here signs or verifies anything.
 */
import type { Hex } from 'viem';
import {
  FeedPayHttpError,
  type FeedPayHttp,
  type FeedPayHttpRequest,
  type FeedPayHttpResponse,
} from '../../server/feed/pay/transport.js';

export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** One option of a 402's accepts, Base USDC exact by default. */
export function acceptOption(input: {
  payTo: string;
  amount: string;
  version?: 1 | 2;
  scheme?: string;
  network?: string;
  asset?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const v1 = input.version === 1;
  return {
    scheme: input.scheme ?? 'exact',
    network: input.network ?? (v1 ? 'base' : 'eip155:8453'),
    asset: input.asset ?? BASE_USDC,
    ...(v1 ? { maxAmountRequired: input.amount } : { amount: input.amount }),
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
    ...(v1
      ? { resource: 'https://example.invalid/', description: '', mimeType: 'application/json' }
      : {}),
    extra: input.extra ?? { name: 'USD Coin', version: '2' },
  };
}

/** A v2 PaymentRequired object (the PAYMENT-REQUIRED header decodes to this). */
export function paymentRequiredV2(url: string, accepts: Record<string, unknown>[]) {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url, description: 'Synthetic service', mimeType: 'application/json' },
    accepts,
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

export type QuoteMode =
  | 'v2'
  | 'v1'
  | 'v1_in_v2_body'
  | 'solana_first'
  | 'three_payees'
  | 'other_payee_only'
  | 'upto_only'
  | 'wrong_domain'
  | 'permit2'
  | 'free_200'
  | 'redirect'
  | 'not_found'
  | 'unreadable_402'
  | 'short_window'
  | 'timeout'
  | 'unreachable'
  /** The listed address resolves to a private address (or another port): never called. */
  | 'not_public';

export type PaidMode =
  | 'settle'
  | 'settle_then_fail'
  | 'reject'
  | 'timeout'
  | 'oversize'
  | 'binary'
  /** The paid request never leaves (the connection is refused before TLS). */
  | 'unreachable';

export interface FakeServiceConfig {
  url: string;
  payTo: string;
  /** Raw USDC base units the 402 asks for. */
  amount: string;
  quote?: QuoteMode;
  paid?: PaidMode;
  /** The answer of a paid 200 (JSON by default). */
  result?: unknown;
  /** After this many unpaid requests the 402 asks `nextAmount` (a price that changes). */
  priceChangeAfter?: number;
  nextAmount?: string;
  maxTimeoutSeconds?: number;
}

export interface SettleRequest {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** The decoded payment header (PAYMENT-SIGNATURE or X-PAYMENT), when one was sent. */
  payment: Record<string, unknown> | null;
  paymentHeader: string | null;
}

const OTHER_PAYEE = '0xB98eF2000000000000000000000000000000B98e';

export function fakeX402Service(
  options: {
    /** The facilitator's part: settles on the fake Base and answers the transaction hash. */
    settle?: (request: SettleRequest) => Promise<Hex>;
  } = {},
) {
  const services = new Map<string, FakeServiceConfig>();
  const requests: RecordedRequest[] = [];
  const unpaid = new Map<string, number>();

  const keyOf = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  };

  function amountFor(config: FakeServiceConfig, key: string) {
    const count = unpaid.get(key) ?? 0;
    return config.priceChangeAfter !== undefined && count > config.priceChangeAfter
      ? (config.nextAmount ?? config.amount)
      : config.amount;
  }

  function accepts(config: FakeServiceConfig, amount: string): Record<string, unknown>[] {
    const ours = acceptOption({
      payTo: config.payTo,
      amount,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
    });
    const solana = acceptOption({
      payTo: '8EgACpZ1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      amount,
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asset: SOLANA_USDC,
      extra: { feePayer: 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww' },
    });
    switch (config.quote) {
      case 'solana_first':
        return [solana, ours];
      case 'three_payees':
        return [
          acceptOption({ payTo: OTHER_PAYEE, amount: '1' }),
          ours,
          acceptOption({
            payTo: OTHER_PAYEE,
            amount: '1',
            extra: { name: 'GatewayWalletBatched', version: '1' },
          }),
        ];
      case 'other_payee_only':
        return [solana, acceptOption({ payTo: OTHER_PAYEE, amount })];
      case 'upto_only':
        return [acceptOption({ payTo: config.payTo, amount, scheme: 'upto' })];
      case 'wrong_domain':
        return [
          acceptOption({ payTo: config.payTo, amount, extra: { name: 'USDC', version: '2' } }),
        ];
      case 'permit2':
        return [
          acceptOption({
            payTo: config.payTo,
            amount,
            extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
          }),
        ];
      case 'short_window':
        return [acceptOption({ payTo: config.payTo, amount, maxTimeoutSeconds: 5 })];
      default:
        return [ours];
    }
  }

  function unpaidAnswer(config: FakeServiceConfig, key: string): FeedPayHttpResponse {
    unpaid.set(key, (unpaid.get(key) ?? 0) + 1);
    const amount = amountFor(config, key);
    const json = { 'content-type': 'application/json' };
    const body = (value: unknown) => Buffer.from(JSON.stringify(value));
    switch (config.quote) {
      case 'free_200':
        return {
          status: 200,
          headers: {
            ...json,
            'payment-required': b64(paymentRequiredV2(config.url, accepts(config, amount))),
          },
          body: body({ free: true }),
          truncated: false,
        };
      case 'redirect':
        return {
          status: 302,
          headers: { location: 'https://elsewhere.example/' },
          body: Buffer.alloc(0),
          truncated: false,
        };
      case 'not_found':
        return { status: 404, headers: json, body: body({ error: 'not found' }), truncated: false };
      case 'unreadable_402':
        return {
          status: 402,
          headers: { ...json, 'payment-required': 'not base64 json!' },
          body: body({}),
          truncated: false,
        };
      case 'v1':
        return {
          status: 402,
          headers: json,
          body: body({
            x402Version: 1,
            error: 'X-PAYMENT header is required',
            accepts: [acceptOption({ payTo: config.payTo, amount, version: 1 })],
          }),
          truncated: false,
        };
      case 'v1_in_v2_body':
        return {
          status: 402,
          headers: {
            ...json,
            'Payment-Required': b64(paymentRequiredV2(config.url, accepts(config, amount))),
          },
          body: body({
            x402Version: 1,
            accepts: [acceptOption({ payTo: OTHER_PAYEE, amount: '1', version: 1 })],
          }),
          truncated: false,
        };
      default:
        return {
          status: 402,
          headers: {
            ...json,
            'Payment-Required': b64(paymentRequiredV2(config.url, accepts(config, amount))),
          },
          body: body({}),
          truncated: false,
        };
    }
  }

  const http: FeedPayHttp = async (request: FeedPayHttpRequest) => {
    const lower = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const paymentHeader = lower['payment-signature'] ?? lower['x-payment'] ?? null;
    let payment: Record<string, unknown> | null = null;
    if (paymentHeader)
      try {
        payment = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        payment = null;
      }
    requests.push({
      url: request.url,
      method: request.method,
      headers: lower,
      body: request.body,
      payment,
      paymentHeader,
    });
    const key = keyOf(request.url);
    const config = services.get(key);
    if (!config) throw new FeedPayHttpError('unreachable', false);
    if (!payment) {
      if (config.quote === 'timeout') throw new FeedPayHttpError('timeout', true);
      if (config.quote === 'unreachable') throw new FeedPayHttpError('unreachable', false);
      if (config.quote === 'not_public') throw new FeedPayHttpError('not_public', false);
      return unpaidAnswer(config, key);
    }
    const mode = config.paid ?? 'settle';
    if (mode === 'timeout') throw new FeedPayHttpError('timeout', true);
    if (mode === 'unreachable') throw new FeedPayHttpError('unreachable', false);
    if (mode === 'reject')
      return {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'payment-response': b64({
            success: false,
            errorReason: 'invalid_exact_evm_payload_signature',
          }),
        },
        body: Buffer.from(JSON.stringify({ error: 'invalid payment' })),
        truncated: false,
      };
    const inner = (payment.payload ?? {}) as {
      signature?: Hex;
      authorization?: Record<string, string>;
    };
    const a = inner.authorization ?? {};
    let transaction: Hex | null = null;
    if (options.settle)
      transaction = await options.settle({
        from: a.from!,
        to: a.to!,
        value: BigInt(a.value!),
        validAfter: BigInt(a.validAfter!),
        validBefore: BigInt(a.validBefore!),
        nonce: a.nonce as Hex,
        signature: inner.signature!,
      });
    const settled = {
      'payment-response': b64({
        success: true,
        transaction,
        network: 'eip155:8453',
        payer: a.from,
      }),
    };
    if (mode === 'settle_then_fail')
      return {
        status: 500,
        headers: { 'content-type': 'text/plain', ...settled },
        body: Buffer.from('internal error'),
        truncated: false,
      };
    if (mode === 'oversize')
      return {
        status: 200,
        headers: { 'content-type': 'text/plain', ...settled },
        body: Buffer.alloc(request.maxBytes, 0x61),
        truncated: true,
      };
    if (mode === 'binary')
      return {
        status: 200,
        headers: { 'content-type': 'image/png', ...settled },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        truncated: false,
      };
    return {
      status: 200,
      headers: { 'content-type': 'application/json', ...settled },
      body: Buffer.from(JSON.stringify(config.result ?? { answer: 42 })),
      truncated: false,
    };
  };

  return {
    http,
    requests,
    /** Requests that carried a payment header (the paid ones). */
    paid: () => requests.filter((request) => request.paymentHeader !== null),
    serve(config: FakeServiceConfig) {
      services.set(keyOf(config.url), config);
      unpaid.delete(keyOf(config.url));
    },
    config: (url: string) => services.get(keyOf(url)),
  };
}

export type FakeX402Service = ReturnType<typeof fakeX402Service>;
