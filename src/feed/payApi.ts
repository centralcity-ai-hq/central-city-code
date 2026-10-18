import {
  FEED_PAY_CALL_ID,
  FEED_PAY_ERRORS,
  FEED_PAY_PATHS,
  type FeedPayAgent,
  type FeedPayAgentList,
  type FeedPayAgentSettings,
  type FeedPayCall,
  type FeedPayCallRequest,
  type FeedPayError,
  type FeedPayErrorCode,
  type FeedPayHistory,
  type FeedPayInputs,
  type FeedPayQuote,
  type FeedPayQuoteAnswer,
  type FeedPayQuoteRequest,
} from '../../shared/feed-pay';
import { FEED_SERVICE_ID, rawToUsdc } from '../../shared/feed';
import { parseRetryAfter } from '../ui/errors';
import { writeHeaders, type Fetcher } from './feedApi';

/*
 * Feed pay's data layer (shared/feed-pay.ts FEED_PAY_PATHS): "Use with my agent" in the Feed and
 * the service calls in an agent's wallet. Every route is signed in, so every request (reads too)
 * carries the console's request header. Nothing here ever repeats a request by itself: a quote or
 * a call is sent again only when the person asks, and a call is sent again only with the same
 * idempotency key (the server then answers the same call and never pays twice).
 */

/** Every way a Feed pay request can fail, as the screens see it. */
export type PayFailureCode =
  FeedPayErrorCode | 'rate_limited' | 'signed_out' | 'network' | 'server' | 'unknown';

/** What a refusal carries besides its code (amounts, the fresh quote, the inputs' problems). */
export type PayFailureDetail = Pick<
  FeedPayError,
  'reason' | 'quote' | 'neededRaw' | 'perCallMaxRaw' | 'limitLeftRaw' | 'startsAt' | 'fields'
>;

export class PayFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: PayFailureCode,
    public readonly retryable: boolean,
    public readonly detail: PayFailureDetail = {},
    public readonly retryAfterMs?: number,
  ) {
    super(`feed pay ${status} ${code}`);
    this.name = 'PayFailure';
  }
}

const KNOWN = new Set<string>(Object.keys(FEED_PAY_ERRORS));

// ---------------------------------------------------------------------------------------------
// Central City's fee (docs/protocol/FEES.md). An answer without the fee's fields (a server from
// before them, during a deploy) reads as fees off: no fee, and the total is the price. An answer
// with them is taken as it is: the server's total is what the caps hold for.

/** A quote with its fee and total always set (null and the price while fees are off). */
export function withFee<T extends FeedPayQuote>(quote: T): T {
  const fee = quote.protocolFee ?? null;
  if (quote.total) return fee === quote.protocolFee ? quote : { ...quote, protocolFee: fee };
  if (!fee || !/^\d{1,30}$/.test(fee.raw) || !/^\d{1,30}$/.test(quote.amount.raw))
    return { ...quote, protocolFee: fee, total: quote.amount };
  const raw = (BigInt(quote.amount.raw) + BigInt(fee.raw)).toString(10);
  return { ...quote, total: { raw, decimals: 6, display: rawToUsdc(raw) } };
}

const quoteWithFee = (answer: FeedPayQuoteAnswer): FeedPayQuoteAnswer =>
  answer && answer.payable === true ? withFee(answer) : answer;

/** A call or a History item with its fee always set (null when no fee applies). */
const callWithFee = <T extends { protocolFee?: unknown }>(item: T): T =>
  item && item.protocolFee === undefined ? { ...item, protocolFee: null } : item;

/** The failure a response stands for: the contract's code, its details, Retry-After. */
export async function payFailureOf(response: Response): Promise<PayFailure> {
  const body = (await response.json().catch(() => null)) as Partial<FeedPayError> | null;
  const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After') ?? undefined);
  if (response.status === 429)
    return new PayFailure(429, 'rate_limited', true, {}, retryAfterMs ?? undefined);
  if (response.status === 401) return new PayFailure(401, 'signed_out', false);
  const code = typeof body?.code === 'string' && KNOWN.has(body.code) ? body.code : null;
  if (code) {
    const detail: PayFailureDetail = {};
    if (body?.reason) detail.reason = body.reason;
    if (body?.quote && body.quote.payable === true) detail.quote = withFee(body.quote);
    for (const key of ['neededRaw', 'perCallMaxRaw', 'limitLeftRaw'] as const)
      if (typeof body?.[key] === 'string' && /^\d{1,30}$/.test(body[key]!)) detail[key] = body[key];
    if (
      typeof body?.startsAt === 'string' &&
      body.startsAt.length <= 40 &&
      Number.isFinite(Date.parse(body.startsAt))
    )
      detail.startsAt = body.startsAt;
    if (Array.isArray(body?.fields)) detail.fields = body.fields;
    return new PayFailure(
      response.status,
      code,
      body?.retryable === true,
      detail,
      retryAfterMs ?? (typeof body?.retryAfterMs === 'number' ? body.retryAfterMs : undefined),
    );
  }
  // Not a contract answer: a 404 is a route that isn't there (Feed pay off), a 5xx is ours.
  if (response.status === 404) return new PayFailure(404, 'not_found', false);
  if (response.status >= 500)
    return new PayFailure(response.status, 'server', true, {}, retryAfterMs ?? undefined);
  return new PayFailure(response.status, 'unknown', false);
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

interface Options {
  signal?: AbortSignal;
  fetcher?: Fetcher;
}

async function send<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  body: unknown,
  { signal, fetcher = fetch }: Options = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers:
        method === 'GET' ? { accept: 'application/json', 'X-City-Request': '1' } : writeHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw error;
    throw new PayFailure(0, 'network', true);
  }
  if (response.ok) return (await response.json()) as T;
  throw await payFailureOf(response);
}

const fill = (template: string, key: string, value: string) =>
  template.replace(`:${key}`, encodeURIComponent(value));

const notListed = () => Promise.reject(new PayFailure(404, 'service_not_found', false));

/** The person's agents that could pay, with balances and limits. 404 not_found: Feed pay is off. */
export function getPayAgents(options: Options = {}) {
  return send<FeedPayAgentList>(FEED_PAY_PATHS.agents, 'GET', undefined, options);
}

/** A new per-call maximum for one agent (USDC base units), or null for the default. */
export function setPerCallMax(
  agentId: string,
  perCallMaxRaw: string | null,
  options: Options = {},
) {
  const body: FeedPayAgentSettings = { perCallMaxRaw };
  return send<FeedPayAgent>(fill(FEED_PAY_PATHS.agent, 'agentId', agentId), 'PUT', body, options);
}

/**
 * A new pot target for one agent (USDC base units, 1 to 100 USDC, never above its spending limit
 * per period), or null for the default (docs/protocol/FEE_ROUTER_2.md section 6).
 */
export function setFloatTarget(
  agentId: string,
  floatTargetRaw: string | null,
  options: Options = {},
) {
  const body: FeedPayAgentSettings = { floatTargetRaw };
  return send<FeedPayAgent>(fill(FEED_PAY_PATHS.agent, 'agentId', agentId), 'PUT', body, options);
}

/** One unpaid request to the service: what it asks now, or why it can't be paid as listed. */
export function quoteService(serviceId: string, inputs: FeedPayInputs, options: Options = {}) {
  if (!FEED_SERVICE_ID.test(serviceId)) return notListed();
  const body: FeedPayQuoteRequest = { inputs };
  return send<FeedPayQuoteAnswer>(
    fill(FEED_PAY_PATHS.quote, 'id', serviceId),
    'POST',
    body,
    options,
  ).then(quoteWithFee);
}

/**
 * Pays and calls. Sent once per confirm click; sent again only with the same idempotency key
 * (a lost answer), which answers the same call.
 */
export function callService(serviceId: string, body: FeedPayCallRequest, options: Options = {}) {
  if (!FEED_SERVICE_ID.test(serviceId)) return notListed();
  return send<FeedPayCall>(fill(FEED_PAY_PATHS.call, 'id', serviceId), 'POST', body, options).then(
    callWithFee,
  );
}

/** One call, as it is now (the owner of the paying wallet only). */
export function getCall(callId: string, options: Options = {}) {
  if (!FEED_PAY_CALL_ID.test(callId))
    return Promise.reject(new PayFailure(404, 'call_not_found', false));
  return send<FeedPayCall>(
    fill(FEED_PAY_PATHS.callStatus, 'callId', callId),
    'GET',
    undefined,
    options,
  ).then(callWithFee);
}

/** An agent's service calls and float moves; null when there is nothing to show (404). */
export async function getServiceCalls(
  agentId: string,
  options: Options = {},
): Promise<FeedPayHistory | null> {
  try {
    const history = await send<FeedPayHistory>(
      fill(FEED_PAY_PATHS.history, 'agentId', agentId),
      'GET',
      undefined,
      options,
    );
    return history && Array.isArray(history.calls)
      ? { ...history, calls: history.calls.map(callWithFee) }
      : history;
  } catch (error) {
    if (error instanceof PayFailure && error.status === 404) return null;
    throw error;
  }
}

export const payFailure = (error: unknown): PayFailure =>
  error instanceof PayFailure
    ? error
    : error instanceof TypeError
      ? new PayFailure(0, 'network', true)
      : new PayFailure(0, 'unknown', false);
