/*
 * The standard x402 `exact` payment at an offer's public address (public-route.ts), next to its
 * own router 3 scheme. The owner's decision (2 Nov 2026): stock x402 clients and directories pay
 * with one USDC transfer, so a listed offer also takes `exact` with the seller as payTo for the
 * full price. No protocol fee is charged on these calls, and nothing passes through Central City.
 *
 * Off unless CITY_X402_PUBLIC_OFFERS_EXACT=1, and only on Base mainnet: the public facilitator
 * (protocol/x402/public-facilitator.ts) relays exact payments there only.
 *
 * Order, the usual x402 resource server's: the payment is verified (USDC's own simulation of the
 * signed transfer), the kind runs, then the public sender settles it with all its own guards
 * (screening, gas budget, one payment per payer in flight, cool-down after a revert). The result is
 * sent only once the transfer is included. A kind that fails, or a payment that does not settle,
 * charges nothing and shows nothing.
 */
import { getAddress } from 'viem';
import { baseNetwork } from '../../../shared/base/chains.js';
import { usdcOf } from '../../../shared/chains.js';
import {
  bindingCheck,
  FACILITATOR_CHAIN_ID,
  FACILITATOR_NETWORK,
  parseExactPayment,
  X402_VERSION,
  type PublicSettle,
  type VerifyAnswer,
} from '../../protocol/x402/public-facilitator.js';
import type { Database } from '../../database.js';
import { PUBLIC_CALL_KEY_PREFIX, PUBLIC_EXACT_SCHEME } from '../pay/public-calls-schema.js';
import { inputHashOf, newCallId, type PublicAnswer, type PublicHostedOffer } from './public-pay.js';

export const PUBLIC_OFFER_EXACT_SETTING = 'CITY_X402_PUBLIC_OFFERS_EXACT';
/** How long a buyer's exact authorization may be valid for (the public sender allows 15 min). */
export const PUBLIC_EXACT_TIMEOUT_S = 300;

export const publicExactOn = (env: Record<string, string | undefined>, chainId: number) =>
  env[PUBLIC_OFFER_EXACT_SETTING] === '1' && chainId === FACILITATOR_CHAIN_ID;

/** What the exact lane needs beyond the route's own deps. */
export interface PublicExactDeps {
  /** The public facilitator's /verify check of a facilitator request body. */
  verify: (body: unknown, admit?: () => Promise<void>) => Promise<VerifyAnswer>;
  /** The public sender, or null while it is off: then no exact entry is offered. */
  sender: () => PublicSettle | null;
  /**
   * Takes one signed authorization (payer and EIP-3009 nonce) for one call, across every instance;
   * false, or a throw, when it was taken already or cannot be checked. The sender answers a repeated
   * payment with its stored settlement, so without this one payment could be shown two results.
   */
  claim: (payer: string, nonce: string) => Promise<boolean>;
  /**
   * Admits one payer before the kind runs, across every instance: at most one exact call per payer
   * per minute (covers the settle) and a per-payer hourly cap. Without it, payments with fresh
   * nonces from one funded payer, sent at once, would each run the kind while only one can settle.
   */
  admit: (payer: string) => Promise<boolean>;
  run: (
    offer: { offerId: string; kind: string; version: number },
    input: string,
  ) => Promise<
    | { ok: true; text: string; mime: string; format: 'json' | 'text' }
    | { ok: false; failure: string }
  >;
  /**
   * Stores a paid call so it counts like every other paid call (recordExactCall). Called once the
   * transfer is included; a failure must not change the answer, the buyer has paid.
   */
  record?: (call: ExactCallRecord) => Promise<void>;
}

/** One paid exact call, as recordExactCall stores it. */
export interface ExactCallRecord {
  serviceId: string;
  offer: PublicHostedOffer;
  payer: string;
  nonce: string;
  client: string;
  validAfter: bigint;
  validBefore: bigint;
  txHash: string;
}

/**
 * Stores a paid exact call in feed_pay_public_calls (migration 358): scheme 'exact', fee 0, state
 * 'delivered' with its transaction, so migration 356's insert trigger counts it once. The payer and
 * nonce are the row's (payer, ref), so one authorization is stored once. The seller is the offer's
 * agent; an offer removed meanwhile stores nothing. The input stays out, as the worker's sweep
 * leaves a finished call.
 */
export async function recordExactCall(db: Database, now: () => number, call: ExactCallRecord) {
  const callId = newCallId();
  const at = now();
  await db.query(
    `INSERT INTO feed_pay_public_calls (call_id, payer, ref, input_hash, client_key, service_id,
       offer_id, offer_kind, offer_version, operator_id, agent_id, pay_to, gross_raw, fee_raw,
       state, op_key, valid_after, valid_before, tx_hash, scheme, created_at, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, o.offer_id, $7, $8, o.operator_id, o.agent_id, $9, $10, 0,
       'delivered', $11, $12, $13, $14, $15, $16, $16
       FROM city_offers o WHERE o.offer_id = $17
     ON CONFLICT DO NOTHING`,
    [
      callId,
      call.payer.toLowerCase(),
      call.nonce.toLowerCase(),
      inputHashOf(call.offer.input).toLowerCase(),
      call.client,
      call.serviceId,
      call.offer.kind,
      call.offer.version,
      call.offer.payTo.toLowerCase(),
      call.offer.split.gross.toString(),
      `${PUBLIC_CALL_KEY_PREFIX}${callId}`,
      call.validAfter.toString(),
      call.validBefore.toString(),
      call.txHash.toLowerCase(),
      PUBLIC_EXACT_SCHEME,
      at,
      call.offer.offerId,
    ],
  );
}

/** The accepts entry for an offer, or null when Base or its USDC is unknown here. */
export function exactEntry(
  offer: PublicHostedOffer,
  chainId: number,
  env: Record<string, string | undefined>,
) {
  const network = baseNetwork(chainId, env);
  const domain = usdcOf(chainId)?.eip712;
  if (!network || !domain) return null;
  return {
    scheme: 'exact' as const,
    network: FACILITATOR_NETWORK,
    asset: getAddress(network.tokens.USDC.address),
    amount: offer.split.gross.toString(),
    payTo: getAddress(offer.payTo),
    maxTimeoutSeconds: PUBLIC_EXACT_TIMEOUT_S,
    extra: { name: domain.name, version: domain.version, assetTransferMethod: 'eip3009' },
  };
}

/**
 * The decoded payment header when it is an exact payment (x402 v2 `accepted.scheme`, or v1's
 * top-level `scheme`); null for anything else, which the router 3 lane reads as before.
 */
export function exactPayloadOf(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> | null {
  const v2 = headers['payment-signature'];
  const v1 = headers['x-payment'];
  const raw = v2 ?? v1;
  if (!raw || Array.isArray(raw)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
    const payload = decoded as Record<string, unknown>;
    const accepted = payload.accepted as Record<string, unknown> | undefined;
    return accepted?.scheme === 'exact' || payload.scheme === 'exact' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Pays and runs one exact call. `challenge` builds the 402 the buyer gets back (with a reason)
 * when the payment is not good; nothing is charged in that case.
 */
export async function payExact(input: {
  deps: PublicExactDeps;
  offer: PublicHostedOffer;
  entry: NonNullable<ReturnType<typeof exactEntry>>;
  payload: Record<string, unknown>;
  client: string;
  serviceId: string;
  challenge: (error: string) => PublicAnswer;
}): Promise<PublicAnswer> {
  const { deps, offer, entry, payload } = input;
  const sender = deps.sender();
  if (!sender) return input.challenge('settlement_unavailable');
  // The requirements are always ours, never the buyer's copy: payee and amount bind to the offer.
  const body = { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: entry };
  const parsed = parseExactPayment(body);
  if (!parsed.ok) return input.challenge(parsed.reason);
  // Exactly the seller, exactly the price (never more), here first: verify checks it again.
  const unbound = bindingCheck(parsed.payment);
  if (unbound) return input.challenge(unbound);
  const verified = await deps.verify(body);
  if (!verified.isValid) return input.challenge(verified.invalidReason);
  const { from, nonce } = parsed.payment.authorization;
  // The payer's own budget first, so parallel payments never buy free runs of the kind.
  const admitted = await deps.admit(from).catch(() => false);
  if (!admitted) return input.challenge('payer_busy');
  // One authorization, one call: a replay of the same payment never runs the kind again.
  const claimed = await deps.claim(from, nonce).catch(() => false);
  if (!claimed) return input.challenge('payment_already_used');
  const result = await deps.run(
    { offerId: offer.offerId, kind: offer.kind, version: offer.version },
    offer.input,
  );
  if (!result.ok)
    return {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
      json: {
        error: 'The service did not answer. Nothing was charged.',
        code: 'service_failed',
        retryable: true,
      },
    };
  const settled = await sender.settle(parsed.payment, (admit) => deps.verify(body, admit), {
    client: input.client,
  });
  // Included and not final yet: the money is moving, so the buyer gets what was paid for.
  const paid =
    settled.success || (settled.errorReason === 'settlement_pending' && !!settled.transaction);
  if (!paid) return input.challenge(settled.errorReason ?? 'settlement_failed');
  const { validAfter, validBefore } = parsed.payment.authorization;
  await deps
    .record?.({
      serviceId: input.serviceId,
      offer,
      payer: from,
      nonce,
      client: input.client,
      validAfter,
      validBefore,
      txHash: settled.transaction,
    })
    .catch(() => {});
  return {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settled)).toString('base64'),
      'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settled)).toString('base64'),
    },
    text: { mime: result.mime, body: result.text },
  };
}
