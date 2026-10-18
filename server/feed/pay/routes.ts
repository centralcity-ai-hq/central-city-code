/*
 * Feed pay over HTTP (docs/FEED_PAY.md section 10; shared/feed-pay.ts FEED_PAY_PATHS):
 *
 *   POST /api/feed/services/:id/quote                FeedPayQuoteRequest -> FeedPayQuoteAnswer
 *   POST /api/feed/services/:id/call                 FeedPayCallRequest  -> FeedPayCall
 *   GET  /api/feed/calls/:callId                     FeedPayCall (works while pay is off)
 *   GET  /api/feed/pay/agents                        FeedPayAgentList
 *   PUT  /api/feed/pay/agents/:agentId               FeedPayAgentSettings -> FeedPayAgent
 *   GET  /api/base/agents/:agentId/wallet/service-calls  FeedPayHistory (CITY_BASE_WALLET)
 *   GET  /api/cron/feed-pay-recover                  the recovery and sweep cron (CRON_SECRET)
 *
 * Signed in only: the console session AND X-City-Request: 1, else 401. Live for every signed-in
 * owner; quote, call, agents and the per-call maximum answer 404 not_found only while CITY_FEED or
 * CITY_FEED_PAY is '0' (the emergency off, read per request). Errors are FeedPayError with the
 * status of FEED_PAY_ERRORS; every error of quote and call means nothing was signed or sent. Once a
 * call is stored, POST call never answers an error: it answers the call as it is (to follow with
 * GET callStatus), whatever happens while it waits.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { transientDatabaseError } from '../../database.js';
import { cronAuthorized } from '../../wake/cron.js';
import { FEED_BUSY_MESSAGE } from '../../../shared/feed.js';
import {
  FEED_PAY_CALL_ID,
  FEED_PAY_LIMITS,
  FEED_PAY_PATHS,
  feedPayEnabled,
} from '../../../shared/feed-pay.js';
import { FEED_BUSY_RETRY_AFTER_S } from '../busy.js';
import { callView } from './store.js';
import { FeedPayRefusal, feedPayCallBody, type FeedPayEngine } from './engine.js';
import { jsonTooDeep } from './inputs.js';
import type { FeedPayInputs } from '../../../shared/feed-pay.js';

export interface FeedPayRouteDeps {
  engine: FeedPayEngine;
  env: Record<string, string | undefined>;
  /** The signed-in person account (session + X-City-Request), or null. */
  person(request: FastifyRequest): Promise<{ accountId: string } | null>;
  /** The shared rate limiter (server/app.ts): throws its 429. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  cronSecret?: string;
  /** How long POST call waits for a terminal state (FEED_PAY_LIMITS.callAnswerWaitMs). */
  answerWaitMs?: number;
  /** Keeps work running past the response (Vercel waitUntil); in the background by default. */
  background?: (work: Promise<unknown>) => void;
}

/** Runs a promise past the response on Vercel Fluid (waitUntil), else just in the background. */
export function feedPayBackground(work: Promise<unknown>): void {
  work.catch(() => {});
  const context = (
    globalThis as { [key: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } }
  )[Symbol.for('@vercel/request-context')];
  context?.get?.()?.waitUntil?.(work.catch(() => {}));
}

const SIGN_IN = { error: 'Sign in to continue.' };

export function registerFeedPayRoutes(app: FastifyInstance, deps: FeedPayRouteDeps): void {
  const background = deps.background ?? feedPayBackground;
  const switchOn = () => feedPayEnabled(deps.env);

  const send = (reply: FastifyReply, error: FeedPayRefusal) => {
    if (error.extra.retryAfterMs !== undefined)
      reply.header('Retry-After', String(Math.ceil(error.extra.retryAfterMs / 1000)));
    return reply.code(error.status).header('Cache-Control', 'no-store').send(error.body());
  };

  /** A refusal as its FeedPayError, a database under load as busy; anything else goes on. */
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof FeedPayRefusal) return send(reply, error);
    if (transientDatabaseError(error))
      return send(
        reply,
        new FeedPayRefusal(
          'busy',
          { retryAfterMs: FEED_BUSY_RETRY_AFTER_S * 1000 },
          FEED_BUSY_MESSAGE,
        ),
      );
    throw error;
  };

  /**
   * The person when the feature is on; otherwise the reply is sent (404 switched off, 401 signed
   * out) and null is returned.
   */
  async function admitted(request: FastifyRequest, reply: FastifyReply) {
    if (!switchOn()) {
      send(reply, new FeedPayRefusal('not_found'));
      return null;
    }
    const person = await deps.person(request);
    if (!person) {
      reply.code(401).header('Cache-Control', 'no-store').send(SIGN_IN);
      return null;
    }
    return person;
  }

  const serviceId = (request: FastifyRequest) =>
    String(((request.params ?? {}) as { id?: unknown }).id ?? '');

  app.post(FEED_PAY_PATHS.quote, async (request, reply) => {
    const person = await admitted(request, reply);
    if (!person) return reply;
    await deps.limit?.(
      `feed-pay-quote:${person.accountId}`,
      FEED_PAY_LIMITS.quotesPerMinute,
      60_000,
    );
    // Nested past any real input: refused before a parser that recurses sees it.
    if (jsonTooDeep(request.body)) return send(reply, new FeedPayRefusal('invalid_request'));
    try {
      return reply
        .header('Cache-Control', 'no-store')
        .send(await deps.engine.quote(person.accountId, serviceId(request), request.body));
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.post(FEED_PAY_PATHS.call, async (request, reply) => {
    const person = await admitted(request, reply);
    if (!person) return reply;
    await deps.limit?.(`feed-pay-call:${person.accountId}`, FEED_PAY_LIMITS.callsPerMinute, 60_000);
    if (jsonTooDeep(request.body)) return send(reply, new FeedPayRefusal('invalid_request'));
    const parsed = feedPayCallBody.safeParse(request.body ?? {});
    if (!parsed.success) return send(reply, new FeedPayRefusal('invalid_request'));
    let started;
    try {
      started = await deps.engine.call(
        { origin: 'feed', accountId: person.accountId },
        {
          serviceId: serviceId(request),
          agentId: parsed.data.agentId,
          inputs: parsed.data.inputs as FeedPayInputs,
          maxAmountRaw: BigInt(parsed.data.maxAmountRaw),
          ...(parsed.data.maxTotalRaw === undefined
            ? {}
            : { maxTotalRaw: BigInt(parsed.data.maxTotalRaw) }),
          idempotencyKey: parsed.data.idempotencyKey,
          quoteId: parsed.data.quoteId,
        },
      );
    } catch (error) {
      return failed(reply, error);
    }
    // The call exists and its work may be paying: from here on the answer is the call, never an
    // error the page would read as "nothing was paid" (a database hiccup while waiting included).
    const { call, work } = started;
    if (work) background(work);
    let row = null;
    try {
      row = await deps.engine.waitFor(
        call.callId,
        deps.answerWaitMs ?? FEED_PAY_LIMITS.callAnswerWaitMs,
        work,
      );
    } catch {
      row = null;
    }
    return reply.header('Cache-Control', 'no-store').send(row ? callView(row) : call);
  });

  // The call's page reads it while pay is off too, so started calls can be followed to the end.
  app.get(FEED_PAY_PATHS.callStatus, async (request, reply) => {
    const person = await deps.person(request);
    if (!person) return reply.code(401).header('Cache-Control', 'no-store').send(SIGN_IN);
    const { callId } = (request.params ?? {}) as { callId?: unknown };
    try {
      const call =
        typeof callId === 'string' && FEED_PAY_CALL_ID.test(callId)
          ? await deps.engine.callFor(person.accountId, callId)
          : null;
      if (!call) return send(reply, new FeedPayRefusal('call_not_found'));
      return reply.header('Cache-Control', 'no-store').send(call);
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get(FEED_PAY_PATHS.agents, async (request, reply) => {
    const person = await admitted(request, reply);
    if (!person) return reply;
    // Each answer reads Base for every listed agent: bounded per person.
    await deps.limit?.(
      `feed-pay-agents:${person.accountId}`,
      FEED_PAY_LIMITS.agentsPerMinute,
      60_000,
    );
    try {
      return reply
        .header('Cache-Control', 'no-store')
        .send(await deps.engine.agents(person.accountId));
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.put(FEED_PAY_PATHS.agent, async (request, reply) => {
    const person = await admitted(request, reply);
    if (!person) return reply;
    const { agentId } = (request.params ?? {}) as { agentId?: unknown };
    try {
      if (typeof agentId !== 'string' || agentId.length > 100)
        return send(reply, new FeedPayRefusal('agent_not_found'));
      return reply
        .header('Cache-Control', 'no-store')
        .send(await deps.engine.setPerCallMax(person.accountId, agentId, request.body));
    } catch (error) {
      return failed(reply, error);
    }
  });

  // Wallet History: a wallet route (CITY_BASE_WALLET), so past calls stay readable while pay is off.
  app.get(FEED_PAY_PATHS.history, async (request, reply) => {
    if (deps.env.CITY_BASE_WALLET !== '1') return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person) return reply.code(401).header('Cache-Control', 'no-store').send(SIGN_IN);
    const { agentId } = (request.params ?? {}) as { agentId?: unknown };
    try {
      const history =
        typeof agentId === 'string' && agentId.length <= 100
          ? await deps.engine.history(person.accountId, agentId)
          : null;
      if (!history) return reply.code(404).send({ error: 'Not found.' });
      return reply.header('Cache-Control', 'no-store').send(history);
    } catch (error) {
      return failed(reply, error);
    }
  });

  // The recovery and sweep cron (vercel.json, every minute). Without the secret: 404.
  app.get(FEED_PAY_PATHS.cron, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, deps.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    return reply.send(await deps.engine.recover());
  });
}
