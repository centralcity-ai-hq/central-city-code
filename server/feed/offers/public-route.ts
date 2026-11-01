/*
 * The public address of a Central City offer: POST /api/public/x402/off_<id> (OFFER_PUBLIC_PATH),
 * for buyers outside Central City. Stage 1 answers the payment request (402) and refuses every
 * payment (501): it writes nothing, signs nothing and moves no money. Stage 2 (public-pay.ts) takes
 * payments only with CITY_X402_PUBLIC_OFFERS_SETTLE=1; anything else answers exactly as stage 1,
 * except that a call already stored answers its own state whatever the settings say now.
 *
 * Off unless CITY_X402_PUBLIC_OFFERS=1, and then only for the offers named in
 * CITY_X402_PUBLIC_OFFERS_ALLOW (comma-separated ids). Everything else answers the same 404 as an
 * unknown route, so the setting can't be told apart from an offer that doesn't exist.
 *
 * Stock x402 `exact` clients can't pay through fee router 3: it takes two authorizations with
 * derived nonces (docs/protocol/FEE_ROUTER_3.md), and a router must never be a payee (money signed
 * to it is stranded). So the request names its own scheme and the seller as payTo.
 */
import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { baseNetwork } from '../../../shared/base/chains.js';
import { usdcOf } from '../../../shared/chains.js';
import type { FeedPayJson } from '../../../shared/feed-pay.js';
import { OFFER_ID } from '../../../shared/feed-offers.js';
import { protocolTreasuryFor } from '../../protocol/fees/cron.js';
import { clientAddressKey } from '../../rate-limit.js';
import { cronAuthorized } from '../../wake/cron.js';
import { FeedPayRefusal } from '../pay/engine.js';
import { feeRouter3Live, ROUTER3_VALIDITY_S, router3AddressFromEnv } from '../pay/router3.js';
import {
  PUBLIC_OFFER_MAX_RAW,
  PUBLIC_OFFER_SCHEME,
  publicOfferSettleOn,
  publicPaymentOf,
  type PublicAnswer,
  type PublicHostedOffer,
  type PublicOfferPay,
} from './public-pay.js';

export { PUBLIC_OFFER_MAX_RAW, PUBLIC_OFFER_SCHEME };
/** Kinds that fetch a page stay Feed-only: anonymous buyers would use up the fetcher's limits. */
const NOT_PUBLIC_KINDS: ReadonlySet<string> = new Set(['web-read', 'web-meta', 'web-links']);
const REQUESTS_PER_IP_PER_MINUTE = 60;
export const PUBLIC_OFFER_CRON_PATH = '/api/cron/x402-offer-work';
/** One worker pass (the cron, every minute). */
export const PUBLIC_OFFER_WORK_MAX_CALLS = 500;
export const PUBLIC_OFFER_WORK_BUDGET_MS = 50_000;

export function publicOfferAllowed(
  env: Record<string, string | undefined>,
  offerId: string,
): boolean {
  if (env.CITY_X402_PUBLIC_OFFERS !== '1' || !OFFER_ID.test(offerId)) return false;
  const allow = (env.CITY_X402_PUBLIC_OFFERS_ALLOW ?? '').split(',').map((id) => id.trim());
  // '*' opens every offer this route can sell (the owner's decision, 1 Nov 2026); the route's own
  // checks still apply to each one: hosted kinds only, Base only, price bounds, readiness, limits.
  return allow.includes('*') || allow.includes(offerId);
}

export function registerPublicOfferRoutes(
  app: FastifyInstance,
  deps: {
    env: Record<string, string | undefined>;
    chainId: number;
    origin: () => string;
    serviceIdOf: (offerId: string) => string;
    /** The offer exactly as a sale would see it now (the engine's hostedForSponsor). */
    hosted: (serviceId: string, inputs: { body?: FeedPayJson }) => Promise<PublicHostedOffer>;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
    /** The paid side (public-pay.ts): used only with CITY_X402_PUBLIC_OFFERS_SETTLE=1. */
    pay?: PublicOfferPay;
    cronSecret?: string;
  },
): void {
  const notFound = (reply: FastifyReply) =>
    reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Unknown API route' });
  const body = z.record(z.string(), z.unknown());
  const unavailable = (reply: FastifyReply, seconds = 60) =>
    reply
      .code(503)
      .header('Retry-After', String(seconds))
      .header('Cache-Control', 'no-store')
      .send({ error: 'Not available right now. Nothing was charged.', retryable: true });
  const send = (reply: FastifyReply, answer: PublicAnswer) => {
    reply.code(answer.status).headers(answer.headers ?? {});
    return answer.text
      ? reply
          .type(answer.text.mime)
          .header('X-Content-Type-Options', 'nosniff')
          .send(answer.text.body)
      : reply.send(answer.json ?? {});
  };

  app.post(
    '/api/public/x402/:offerId',
    async (request: FastifyRequest<{ Params: { offerId: string } }>, reply) => {
      const { offerId } = request.params;
      const allowed = publicOfferAllowed(deps.env, offerId);
      const clientKey = clientAddressKey(request.ip);
      const admit = () => deps.limit(`x402-offer:${clientKey}`, REQUESTS_PER_IP_PER_MINUTE, 60_000);
      // Turned off or taken off the list mid-flight: a buyer who already paid hears what happened to
      // that call, not a refusal. Only terms issued here read anything, so to anyone else this
      // still can't be told apart from an unknown route.
      if (
        deps.pay &&
        !(allowed && publicOfferSettleOn(deps.env)) &&
        (request.headers['payment-signature'] || request.headers['x-payment'])
      ) {
        const payment = publicPaymentOf(request.headers);
        const kept =
          payment.kind === 'ok'
            ? await deps.pay.kept({ offerId, payment: payment.payment, v1: payment.v1, admit })
            : null;
        if (kept) return send(reply, kept);
      }
      if (!allowed) return notFound(reply);
      await admit();
      const settle = publicOfferSettleOn(deps.env) ? (deps.pay ?? null) : null;
      const parsed = body.safeParse(request.body ?? {});
      const resource = new URL(request.url, deps.origin()).href;
      const challengeAnswer = (entry: object): PublicAnswer => {
        const challenge = { x402Version: 2, resource: { url: resource }, accepts: [entry] };
        return {
          status: 402,
          headers: {
            'Cache-Control': 'no-store',
            'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64'),
          },
          json: challenge,
        };
      };
      // A payment comes first: a call already stored still answers while the router is off.
      if (settle && (request.headers['payment-signature'] || request.headers['x-payment'])) {
        const payment = publicPaymentOf(request.headers);
        if (payment.kind !== 'ok' || !parsed.success)
          return reply
            .code(400)
            .header('Cache-Control', 'no-store')
            .send({ error: 'This payment could not be read.', code: 'invalid_payment' });
        return send(
          reply,
          await settle.pay({
            offerId,
            serviceId: deps.serviceIdOf(offerId),
            body: { body: parsed.data as FeedPayJson },
            client: clientKey,
            payment: payment.payment,
            v1: payment.v1,
            challenge: challengeAnswer,
          }),
        );
      }
      const network = baseNetwork(deps.chainId, deps.env);
      const router = router3AddressFromEnv(deps.env);
      const treasury = protocolTreasuryFor(deps.env, deps.chainId);
      const domain = usdcOf(deps.chainId)?.eip712;
      // Never a fallback router: asked to retry before anyone signs.
      if (!network || !domain || !router || !treasury || !feeRouter3Live(deps.env))
        return unavailable(reply);
      if (!parsed.success)
        return reply
          .code(400)
          .header('Cache-Control', 'no-store')
          .send({ error: 'Send the input as a JSON object.', code: 'invalid_inputs' });
      let offer: PublicHostedOffer;
      try {
        offer = await deps.hosted(deps.serviceIdOf(offerId), { body: parsed.data as FeedPayJson });
      } catch (error) {
        if (!(error instanceof FeedPayRefusal)) throw error;
        if (error.code !== 'invalid_inputs') return notFound(reply);
        return reply
          .code(400)
          .header('Cache-Control', 'no-store')
          .send({ error: error.message, code: 'invalid_inputs' });
      }
      if (NOT_PUBLIC_KINDS.has(offer.kind) || offer.split.gross > PUBLIC_OFFER_MAX_RAW)
        return notFound(reply);
      if (publicOfferSettleOn(deps.env)) {
        // On, the lane decides before anyone signs: no key, low gas, a finality lag: retry later.
        if (!settle) return unavailable(reply);
        if (!settle.settleable(offer)) return notFound(reply);
        if (await settle.paused()) return unavailable(reply);
        if (!(await settle.ready())) return unavailable(reply, 30);
        const entry = settle.acceptsEntry(offerId, offer);
        return entry ? send(reply, challengeAnswer(entry)) : unavailable(reply);
      }
      if (request.headers['payment-signature'] || request.headers['x-payment'])
        return reply.code(501).header('Cache-Control', 'no-store').send({
          error: 'Payments are not open at this address yet. This request charged nothing.',
          code: 'payments_not_open',
        });
      const now = Math.floor(Date.now() / 1000);
      return send(
        reply,
        challengeAnswer({
          scheme: PUBLIC_OFFER_SCHEME,
          network: `eip155:${deps.chainId}`,
          asset: getAddress(network.tokens.USDC.address),
          amount: offer.split.gross.toString(),
          payTo: getAddress(offer.payTo),
          maxTimeoutSeconds: ROUTER3_VALIDITY_S,
          extra: {
            name: domain.name,
            version: domain.version,
            assetTransferMethod: 'eip3009',
            router,
            treasury: getAddress(treasury),
            sellerAmount: offer.split.net.toString(),
            feeAmount: offer.split.fee.toString(),
            ref: `0x${randomBytes(32).toString('hex')}`,
            validAfter: String(now - 60),
            validBefore: String(now + ROUTER3_VALIDITY_S),
          },
        }),
      );
    },
  );

  // The worker (vercel.json, every minute): runs also while new payments are off, so a call already
  // accepted is followed to its end; with none open this is one indexed read. Without the secret: 404.
  app.get(PUBLIC_OFFER_CRON_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, deps.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    if (!deps.pay) return reply.send({ moved: 0, swept: 0 });
    return reply.send(
      await deps.pay.work({
        maxCalls: PUBLIC_OFFER_WORK_MAX_CALLS,
        budgetMs: PUBLIC_OFFER_WORK_BUDGET_MS,
      }),
    );
  });
}
