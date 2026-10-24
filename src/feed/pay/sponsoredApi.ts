import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  FEED_SPONSORED_PATHS,
  type FeedSponsoredCall,
  type FeedSponsoredCallRequest,
  type FeedSponsoredCreditView,
  type FeedSponsoredRefusal,
} from '../../../shared/feed-sponsored';
import { FEED_SERVICE_ID } from '../../../shared/feed';
import { newIdempotencyKey, writeHeaders, type Fetcher } from '../feedApi';
import { onFeedForget } from '../feedPaths';
import { payFailureOf, type PayFailure } from '../payApi';

/*
 * Free first buys (the sponsored first purchase, shared/feed-sponsored.ts): the read of which of
 * the person's agents would get their first Central City service free, the call that uses it, and
 * that call's status. Every route is signed in, so every request carries the console's request
 * header. A call is sent again only with the same idempotency key (the server answers the same
 * call and never pays twice).
 */

/** Why a sponsored call was refused, as the sheet says it. */
export class SponsoredFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | 'credit_unavailable'
      | 'unavailable'
      | 'busy'
      | 'agent_not_found'
      | 'idempotency_conflict'
      | 'off'
      | 'rate_limited'
      | 'signed_out'
      | 'network'
      | 'server'
      | 'unknown',
    public readonly reason: FeedSponsoredRefusal | null = null,
  ) {
    super(`sponsored ${status} ${code}${reason ? ` ${reason}` : ''}`);
    this.name = 'SponsoredFailure';
  }
  /**
   * The server said for sure that nothing started: a new try may take a new key. Only definite
   * 4xx refusals. A 5xx (busy, unavailable, server), a network failure or anything unknown may
   * come after the buy began (a connection dropped at commit), so the same key is sent again.
   */
  get final() {
    return FINAL_CODES.has(this.code) && this.status >= 400 && this.status < 500;
  }
}

const FINAL_CODES = new Set<SponsoredFailure['code']>([
  'credit_unavailable',
  'agent_not_found',
  'idempotency_conflict',
  'off',
  'signed_out',
]);

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

const SPONSORED_CODES = new Set([
  'credit_unavailable',
  'unavailable',
  'busy',
  'agent_not_found',
  'idempotency_conflict',
]);

/**
 * A refused answer: a sponsored refusal (credit_unavailable with its reason, unavailable, busy,
 * ...), else Feed pay's own refusal of the service or its inputs (PayFailure, from the same
 * engine checks a paid call runs).
 */
async function failureOf(response: Response): Promise<SponsoredFailure | PayFailure> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown; reason?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : null;
  if (response.status === 401) return new SponsoredFailure(401, 'signed_out');
  if (response.status === 429) return new SponsoredFailure(429, 'rate_limited');
  if (code && SPONSORED_CODES.has(code))
    return new SponsoredFailure(
      response.status,
      code as SponsoredFailure['code'],
      typeof body?.reason === 'string' ? (body.reason as FeedSponsoredRefusal) : null,
    );
  if (code) return payFailureOf(response);
  // Not a contract answer: a 404 is a route that isn't there (free first buys off).
  if (response.status === 404) return new SponsoredFailure(404, 'off');
  if (response.status >= 500) return new SponsoredFailure(response.status, 'server');
  return new SponsoredFailure(response.status, 'unknown');
}

interface Options {
  signal?: AbortSignal;
  fetcher?: Fetcher;
}

async function send<T>(
  path: string,
  method: 'GET' | 'POST',
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
    throw new SponsoredFailure(0, 'network');
  }
  if (response.ok) return (await response.json()) as T;
  throw await failureOf(response);
}

/** The owner's agents' credits and the services they cover (all the owner's agents, max 200). */
export function getSponsoredCredit(options: Options = {}) {
  return send<FeedSponsoredCreditView>(FEED_SPONSORED_PATHS.credit, 'GET', undefined, options);
}

/** Uses the agent's free first buy on this service (Central City pays). */
export function startSponsoredCall(
  serviceId: string,
  body: FeedSponsoredCallRequest,
  options: Options = {},
) {
  if (!FEED_SERVICE_ID.test(serviceId)) return Promise.reject(new SponsoredFailure(404, 'unknown'));
  return send<FeedSponsoredCall>(
    FEED_SPONSORED_PATHS.call.replace(':id', encodeURIComponent(serviceId)),
    'POST',
    body,
    options,
  );
}

const CALL_ID = /^sp_[a-z2-7]{20}$/;

export function getSponsoredCall(callId: string, options: Options = {}) {
  if (!CALL_ID.test(callId)) return Promise.reject(new SponsoredFailure(404, 'unknown'));
  return send<FeedSponsoredCall>(
    FEED_SPONSORED_PATHS.status.replace(':callId', callId),
    'GET',
    undefined,
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// The credits, kept for the page: one read for all the owner's agents, renewed after FRESH_MS or
// a call.

/** An agent's free first buy as the screens show it. */
export type FreeState = 'free' | 'used' | 'in_progress';

export interface SponsoredView {
  /** An answer came (or the read failed for good): the services below are what there is. */
  known: boolean;
  enabled: boolean;
  creditMaxRaw: string | null;
  /** The Feed services a free first buy may be. */
  services: Set<string>;
  /** The owner's agents whose credit is free, used or in progress (unavailable ones are absent). */
  agents: Map<string, FreeState>;
}

const FRESH_MS = 30_000;
const EMPTY: SponsoredView = {
  known: false,
  enabled: false,
  creditMaxRaw: null,
  services: new Set(),
  agents: new Map(),
};

let view: SponsoredView = EMPTY;
let readAt = 0;
let reading: Promise<void> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function publish(next: SponsoredView) {
  view = next;
  for (const listener of listeners) listener();
}

const SHOWN: Partial<Record<FeedSponsoredCreditView['agents'][number]['credit'], FreeState>> = {
  available: 'free',
  used: 'used',
  in_progress: 'in_progress',
};

/** Sets the view from an answer (tests set it directly). */
export function primeSponsored(answer: FeedSponsoredCreditView, at = Date.now()) {
  readAt = at;
  const agents = new Map<string, FreeState>();
  for (const agent of answer.agents ?? []) {
    const state = SHOWN[agent.credit];
    if (state) agents.set(agent.agentId, state);
  }
  const max = /^\d{1,30}$/.test(answer.maxPriceRaw ?? '') ? answer.maxPriceRaw : '0';
  const services = new Set(answer.serviceIds ?? []);
  publish({
    known: true,
    enabled: services.size > 0 && BigInt(max) > 0n,
    creditMaxRaw: BigInt(max) > 0n ? max : null,
    services,
    agents,
  });
}

/** Reads the credits (again); one read at a time. Off, signed out or unreachable: nothing free. */
export function loadSponsored(fresh = false): Promise<void> {
  if (reading) return reading;
  if (!fresh && view.known && Date.now() - readAt < FRESH_MS) return Promise.resolve();
  const started = generation;
  reading = getSponsoredCredit()
    .then(
      (answer) => {
        if (started === generation) primeSponsored(answer);
      },
      () => {
        if (started !== generation) return;
        readAt = Date.now();
        publish({ ...EMPTY, known: true });
      },
    )
    .finally(() => {
      // Only the current read clears it (a sign-out meanwhile may have started another).
      if (started === generation) reading = null;
    });
  return reading;
}

// ---------------------------------------------------------------------------------------------
// One attempt, one key: the same agent, service and inputs send the same idempotency key until the
// server said for sure that nothing started (or the call failed), so a lost answer or a second
// click never starts a second buy. A call started is kept for its service until it is seen done.

const freeKeys = new Map<string, string>();
const attempt = (serviceId: string, agentId: string, inputs: unknown) =>
  `${serviceId}|${agentId}|${JSON.stringify(inputs)}`;

export function freeKey(serviceId: string, agentId: string, inputs: unknown): string {
  const at = attempt(serviceId, agentId, inputs);
  let key = freeKeys.get(at);
  if (!key) {
    key = `sfp-${newIdempotencyKey()}`;
    freeKeys.set(at, key);
  }
  return key;
}

export function dropFreeKey(serviceId: string, agentId: string, inputs: unknown) {
  freeKeys.delete(attempt(serviceId, agentId, inputs));
}

/** After a refused or lost Use free: the key goes only when nothing started for sure. */
export function afterFreeFailure(
  serviceId: string,
  agentId: string,
  inputs: unknown,
  failure: SponsoredFailure,
) {
  if (failure.final) dropFreeKey(serviceId, agentId, inputs);
}

export interface OpenFree {
  call: FeedSponsoredCall;
  agentName: string;
  inputs: unknown;
}
const openFree = new Map<string, OpenFree>();
export const getOpenFree = (serviceId: string) => openFree.get(serviceId) ?? null;
export function setOpenFree(serviceId: string, entry: OpenFree | null) {
  if (entry) openFree.set(serviceId, entry);
  else openFree.delete(serviceId);
}

/** Sign-out, or another account in this tab. */
export function forgetSponsored() {
  generation += 1;
  readAt = 0;
  reading = null;
  freeKeys.clear();
  openFree.clear();
  publish(EMPTY);
}
onFeedForget(forgetSponsored);

/** The view of the owner's free first buys, read when it mounts (and again when stale). */
export function useSponsored(load = true): SponsoredView {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => view,
    () => view,
  );
  useEffect(() => {
    if (load) void loadSponsored();
  }, [load]);
  return value;
}

// ---------------------------------------------------------------------------------------------
// What the screens need from the view

/** A Feed service a free first buy may be. */
export const freeService = (view: SponsoredView, serviceId: string | null) =>
  Boolean(view.enabled && serviceId && view.services.has(serviceId));

/** The agents of these whose first buy is free now. */
export function freeAgents(view: SponsoredView, agentIds: readonly string[]): string[] {
  return agentIds.filter((id) => view.agents.get(id) === 'free');
}

/** The Feed services a free first buy may be. */
export const freeServiceIds = (view: SponsoredView): string[] => [...view.services];

/** Free first buys on this service as the use sheet needs them. */
export function useFreeBuy(serviceId: string, load = true) {
  const sponsored = useSponsored(load);
  return useMemo(() => {
    const eligible = freeService(sponsored, serviceId);
    return {
      eligible,
      creditMaxRaw: sponsored.creditMaxRaw,
      state: (agentId: string | null): FreeState | null =>
        eligible && agentId ? (sponsored.agents.get(agentId) ?? null) : null,
    };
  }, [sponsored, serviceId]);
}
