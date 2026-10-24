import {
  FEED_ERRORS,
  FEED_LIMITS,
  FEED_RESPOND_ERRORS,
  FEED_PATHS,
  FEED_REQUEST_ID,
  FEED_SERVICE_ID,
  type FeedCloseRequest,
  type FeedReport,
  type FeedRequestPage,
  type FeedServiceDetail,
  type FeedServicePage,
  type FeedServiceSort,
  type NewFeedRequest,
  type PostedFeedRequest,
  type PublicFeedRequest,
  usdcToRaw,
} from '../../shared/feed';
import { selectedWorkspaceId } from '../api';
import { parseRetryAfter } from '../ui/errors';
import { plain, validHost, validTag } from './feedFormat';

/*
 * The Feed's data layer: one typed helper per contract route (shared/feed.ts FEED_PATHS), with
 * abort, one quiet retry for reads, none for writes, and every failure as a FeedFailure whose
 * code the screens turn into plain words (feedErrorCopy). Server text is shown in one place only:
 * a post the server refused as invalid (400), whose sentence is ours and written for people; it
 * is shown as plain text, capped, and dropped when it reads like code.
 *
 * The routes are public, but the page is the workspace's: every write carries the console's
 * request header (X-City-Request) and the workspace chosen in the console (X-City-Workspace), so
 * the server posts and closes as the signed-in account or one of its agents.
 */

export type Fetcher = typeof fetch;

/** Every way a Feed call can fail, as the screens see it. */
export type FeedFailureCode =
  | keyof typeof FEED_ERRORS
  | keyof typeof FEED_RESPOND_ERRORS
  | 'rate_limited'
  | 'signed_out'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unknown';

export class FeedFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: FeedFailureCode,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    /** The server's own sentence, plain and capped (serverSentence); shown for a refused post. */
    public readonly said?: string,
  ) {
    super(`feed ${status} ${code}`);
    this.name = 'FeedFailure';
  }
}

const KNOWN = new Set<string>([...Object.keys(FEED_ERRORS), ...Object.keys(FEED_RESPOND_ERRORS)]);

/** The longest server sentence a screen shows (code points). */
export const SAID_MAX = 200;
/** Text that reads like code, not like a sentence for people: never shown. */
const MACHINE = /[{}<>_|`$\\]|idempoten|city_/i;

/**
 * The server's `error` sentence as a screen may show it: plain text (feedFormat plain), one line,
 * at most SAID_MAX code points; undefined when there is none or it reads like code.
 */
export function serverSentence(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = plain(text).replace(/\s+/g, ' ');
  if (!line || MACHINE.test(line)) return undefined;
  const points = Array.from(line);
  return points.length > SAID_MAX
    ? `${points
        .slice(0, SAID_MAX - 1)
        .join('')
        .trimEnd()}…`
    : line;
}

/** The failure a response stands for (status, the contract's code, Retry-After). */
export async function failureOf(response: Response): Promise<FeedFailure> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    retryable?: unknown;
    error?: unknown;
  } | null;
  const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After') ?? undefined);
  const code = typeof body?.code === 'string' && KNOWN.has(body.code) ? body.code : null;
  // The server's own sentence: a refused post (400), and the refusals that have no code of their
  // own (429 "The Feed is full right now.", 503 "Posting is paused for now.").
  const said = [400, 429, 503].includes(response.status) ? serverSentence(body?.error) : undefined;
  if (response.status === 429)
    return new FeedFailure(429, 'rate_limited', true, retryAfterMs ?? undefined, said);
  if (response.status === 401) return new FeedFailure(401, 'signed_out', false);
  if (code)
    return new FeedFailure(
      response.status,
      code as FeedFailureCode,
      body?.retryable === true ||
        code === 'cursor_stale' ||
        code === 'source_unavailable' ||
        code === 'busy',
      retryAfterMs,
      said,
    );
  if (response.status === 404) return new FeedFailure(404, 'not_found', false);
  if (response.status === 400 || response.status === 422)
    return new FeedFailure(response.status, 'invalid_request', false, undefined, said);
  if (response.status >= 500)
    return new FeedFailure(response.status, 'server', true, retryAfterMs, said);
  return new FeedFailure(response.status, 'unknown', false);
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });

export interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  /** Reads only: one more try after a network failure or a 5xx other than a contract code. */
  retry?: boolean;
  /** Milliseconds before that one retry (tests pass 0). */
  retryDelayMs?: number;
  /**
   * 'no-store' skips the browser's cache: the services list may be kept for a minute
   * (Cache-Control max-age=60), so a list that must be read again (after cursor_stale, Try again)
   * would otherwise come back as it was.
   */
  cache?: RequestCache;
  /** Reads only: READ_TIMEOUT_MS (tests pass less). */
  timeoutMs?: number;
}

/**
 * A read that has not answered by then is given up and fails as 'timeout' (no retry: the server
 * is slow, not briefly down), so a stalled list shows its Try again instead of "Reading…" forever.
 */
export const READ_TIMEOUT_MS = 8_000;

/**
 * The caller's signal and a deadline, as one signal; `timedOut` says which one ended it. `done`
 * clears the timer and stops following the caller's signal (exported for tests).
 */
export function withDeadline(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const follow = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', follow, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut && !signal?.aborted,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', follow);
    },
  };
}

/** The headers of a write: the console's request header, and the workspace chosen in it. */
export function writeHeaders(workspace = selectedWorkspaceId()): Record<string, string> {
  return {
    accept: 'application/json',
    'Content-Type': 'application/json',
    'X-City-Request': '1',
    ...(workspace ? { 'X-City-Workspace': workspace } : {}),
  };
}

export async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, fetcher = fetch, retryDelayMs = 700, cache } = options;
  // Writes never repeat by themselves: a person decides to send again.
  const retry = method === 'GET' && options.retry !== false;
  for (let attempt = 0; ; attempt++) {
    // Reads have a deadline; a write waits for its answer (giving up would not undo it).
    const deadline =
      method === 'GET' ? withDeadline(signal, options.timeoutMs ?? READ_TIMEOUT_MS) : null;
    let failure: FeedFailure;
    try {
      let response: Response;
      try {
        response = await fetcher(path, {
          method,
          credentials: 'same-origin',
          headers: method === 'GET' ? { accept: 'application/json' } : writeHeaders(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(deadline ? { signal: deadline.signal } : signal ? { signal } : {}),
          ...(cache ? { cache } : {}),
        });
      } catch (error) {
        if (deadline?.timedOut()) throw new FeedFailure(0, 'timeout', true);
        if (isAbort(error) || signal?.aborted) throw error;
        if (retry && attempt === 0) {
          await wait(retryDelayMs, signal);
          continue;
        }
        throw new FeedFailure(0, 'network', true);
      }
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch (error) {
          // The body stalled past the deadline.
          if (deadline?.timedOut()) throw new FeedFailure(0, 'timeout', true);
          throw error;
        }
      }
      // A failure's body is read under the same deadline and abort as the rest of the call: one
      // that stalls (a 5xx from a stuck function) ends as a timeout, not as a wait without end.
      failure = await failureOf(response);
      if (deadline?.timedOut()) throw new FeedFailure(0, 'timeout', true);
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    } finally {
      deadline?.done();
    }
    if (retry && attempt === 0 && failure.code === 'server') {
      await wait(retryDelayMs, signal);
      continue;
    }
    throw failure;
  }
}

export const withId = (template: string, id: string) =>
  template.replace(':id', encodeURIComponent(id));

// ---------------------------------------------------------------------------------------------
// Queries

/** The Offered view's filters, as the address bar keeps them (/feed?q=&max_price=&sort=&host=). */
export interface OfferedFilters {
  q: string;
  /** USDC as chosen ("0.05"), or '' for any price. */
  maxPrice: string;
  /** '' = the default: Relevance with a search, else Most used. */
  sort: '' | FeedServiceSort;
  host: string;
  /**
   * Only the services a free first buy may be (?free=1, src/feed/pay/sponsoredApi.ts): the agent
   * page's Choose opens it. Left out when off.
   */
  free?: true;
}

export interface RequestFilters {
  q: string;
  tag: string;
}

export const NO_OFFERED_FILTERS: OfferedFilters = { q: '', maxPrice: '', sort: '', host: '' };
export const NO_REQUEST_FILTERS: RequestFilters = { q: '', tag: '' };

const SORTS = new Set<string>(['relevance', 'most_used', 'cheapest', 'newest']);

function params(entries: Array<[string, string | null | undefined]>) {
  const search = new URLSearchParams();
  for (const [key, value] of entries) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The sort a list is in: the one chosen, else Relevance with a search and Most used without. */
export function sortOf(filters: OfferedFilters): FeedServiceSort {
  const q = filters.q.trim();
  if (filters.sort === 'relevance' && !q) return 'most_used';
  return filters.sort || (q ? 'relevance' : 'most_used');
}

/** "?q=pdf&max_price=0.05" for the address bar and the API alike ('' when nothing is set). */
export function offeredSearch(filters: OfferedFilters, cursor?: string | null): string {
  const q = filters.q.trim();
  const sort = sortOf(filters);
  return params([
    ['q', q],
    ['max_price', filters.maxPrice.trim()],
    // The default sort stays out of the address.
    ['sort', sort === (q ? 'relevance' : 'most_used') ? '' : sort],
    ['host', filters.host],
    ['free', filters.free ? '1' : ''],
    ['cursor', cursor],
  ]);
}

/** Search words from the address bar: plain text (no control or invisible characters), one line. */
const addressWords = (text: string | null) =>
  Array.from(plain(text).replace(/\s+/g, ' ')).slice(0, FEED_LIMITS.queryMax).join('');

/** A max_price as the server reads one (usdcToRaw: 0 is allowed), else ''. */
const validMaxPrice = (value: string) =>
  value.length <= 20 && value && usdcToRaw(value) !== null ? value : '';

export function readOfferedFilters(search: string): OfferedFilters {
  const query = new URLSearchParams(search);
  const sort = query.get('sort') ?? '';
  // The server ignores a host that is not one, so the page never shows it as a filter either.
  const host = (query.get('host') ?? '').trim().toLowerCase();
  return {
    q: addressWords(query.get('q')),
    // A price the server can't read (it answers 400) is no filter at all: Any, and the list loads.
    maxPrice: validMaxPrice((query.get('max_price') ?? '').trim()),
    sort: SORTS.has(sort) ? (sort as FeedServiceSort) : '',
    host: validHost(host) ? host : '',
    ...(query.get('free') === '1' ? { free: true as const } : {}),
  };
}

export function requestSearch(filters: RequestFilters, cursor?: string | null): string {
  return params([
    ['q', filters.q.trim()],
    ['tag', filters.tag],
    ['cursor', cursor],
  ]);
}

export function readRequestFilters(search: string): RequestFilters {
  const query = new URLSearchParams(search);
  // A tag the contract can't read (the server answers 400) is no filter at all.
  const tag = (query.get('tag') ?? '').trim().toLowerCase();
  return { q: addressWords(query.get('q')), tag: validTag(tag) ? tag : '' };
}

// ---------------------------------------------------------------------------------------------
// Routes

type Common = {
  signal?: AbortSignal;
  fetcher?: Fetcher;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Reads only: 'no-store' when the list must be read again from the server. */
  cache?: RequestCache;
};

/**
 * A list read again past every cache (cursor_stale, Try again) carries a throwaway `fresh`
 * parameter: the browser's no-store does not reach past the edge, which keeps a page for up to
 * about 3 minutes (and with it the cursor that just went stale). The services route ignores
 * parameters it does not know; the requests route refuses them, so only services get it.
 */
export function freshParam(search: string, now = Date.now()): string {
  return `${search}${search ? '&' : '?'}fresh=${now}`;
}

export function getServices(filters: OfferedFilters, cursor: string | null, options: Common = {}) {
  const search = offeredSearch(filters, cursor);
  return call<FeedServicePage>(
    `${FEED_PATHS.services}${options.cache === 'no-store' ? freshParam(search) : search}`,
    options,
  );
}

export function getService(id: string, options: Common = {}) {
  // An id that cannot be a service is the same answer the server gives an unknown one.
  if (!FEED_SERVICE_ID.test(id))
    return Promise.reject(new FeedFailure(404, 'service_not_found', false));
  return call<FeedServiceDetail>(withId(FEED_PATHS.service, id), options);
}

export function getRequests(filters: RequestFilters, cursor: string | null, options: Common = {}) {
  return call<FeedRequestPage>(`${FEED_PATHS.requests}${requestSearch(filters, cursor)}`, options);
}

export function getRequest(id: string, options: Common = {}) {
  if (!FEED_REQUEST_ID.test(id))
    return Promise.reject(new FeedFailure(404, 'request_not_found', false));
  return call<PublicFeedRequest>(withId(FEED_PATHS.request, id), options);
}

/**
 * The form's hidden field (the server's honeypot): sent only when something filled it, so a
 * person's request never carries it.
 */
export type FeedRequestPost = NewFeedRequest & { website?: string };

export function postRequest(body: FeedRequestPost, options: Common = {}) {
  return call<PostedFeedRequest>(FEED_PATHS.requests, { ...options, method: 'POST', body });
}

export function reportRequest(id: string, report: FeedReport, options: Common = {}) {
  if (!FEED_REQUEST_ID.test(id))
    return Promise.reject(new FeedFailure(404, 'request_not_found', false));
  return call<{ ok: true }>(withId(FEED_PATHS.report, id), {
    ...options,
    method: 'POST',
    body: report,
  });
}

/** Closes with the manage token when there is one; signed in, the poster's session works too. */
export function closeRequest(id: string, manageToken: string | null, options: Common = {}) {
  if (!FEED_REQUEST_ID.test(id))
    return Promise.reject(new FeedFailure(404, 'request_not_found', false));
  const body: FeedCloseRequest = manageToken ? { manageToken } : {};
  return call<PublicFeedRequest>(withId(FEED_PATHS.close, id), {
    ...options,
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------------------------------------
// Words for failures

export type FeedAction = 'list' | 'service' | 'request' | 'post' | 'report' | 'close';

export interface FeedCopy {
  title: string;
  detail: string;
}

function minutesText(ms: number | undefined) {
  if (!ms) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 90) return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

function waitText(ms: number) {
  return ms < 60_000 ? `about ${Math.ceil(ms / 1000)} seconds` : minutesText(ms);
}

/** Plain words for a failure (docs/COPY_GLOSSARY.md: no codes, no server text). */
export function feedErrorCopy(error: unknown, action: FeedAction): FeedCopy {
  const failure =
    error instanceof FeedFailure
      ? error
      : error instanceof TypeError
        ? new FeedFailure(0, 'network', true)
        : new FeedFailure(0, 'unknown', false);
  switch (failure.code) {
    case 'network':
      return {
        title: "We couldn't reach Central City.",
        detail: 'Check your connection and try again.',
      };
    case 'timeout':
      return {
        title: 'Central City is taking too long to answer.',
        detail: 'Try again in a moment.',
      };
    case 'rate_limited': {
      const wait = minutesText(failure.retryAfterMs);
      // Without Retry-After a post is refused by a cap, which the server names: the open requests
      // a poster may have, or the whole Feed's.
      if (action === 'post' && !failure.retryAfterMs)
        return !failure.said || /open requests/i.test(failure.said)
          ? { title: 'You have too many open requests.', detail: 'Close one first.' }
          : { title: 'Your request wasn’t posted.', detail: failure.said };
      // The account's caps and the network's both answer this way: never "you" alone.
      if (action === 'post')
        return {
          title: 'Too many requests were posted from your account or network recently.',
          detail: wait ? `Try again in ${wait}.` : 'Try again later.',
        };
      return {
        title: 'Too many tries in a short time.',
        detail: wait ? `Try again in ${wait}.` : 'Try again in a minute.',
      };
    }
    case 'signed_out':
      return { title: "You're signed out.", detail: 'Sign in again, then try once more.' };
    case 'invalid_request':
      return action === 'post'
        ? {
            title: "Something in this form isn't right.",
            detail: failure.said ?? 'Check it and try again.',
          }
        : action === 'report'
          ? { title: "The report couldn't be sent.", detail: 'Pick a reason and try again.' }
          : { title: "This search couldn't be read.", detail: 'Change the filters and try again.' };
    case 'source_unavailable':
      return {
        title: "x402 Bazaar hasn't been read yet.",
        detail:
          'There is no list to show. Nothing is wrong with your search. Try again in a moment.',
      };
    case 'cursor_stale':
      return {
        title: 'The list was refreshed while you read it.',
        detail: 'It starts again from the top.',
      };
    case 'service_not_found':
      return {
        title: "This service isn't listed.",
        detail: 'x402 Bazaar may no longer list it, or it was hidden.',
      };
    case 'request_not_found':
      return {
        title: "This request isn't listed.",
        detail: 'It may have been closed, expired or hidden, or it is still in review.',
      };
    case 'request_closed':
      return { title: 'This request is already closed.', detail: 'Nothing else to do.' };
    case 'not_poster':
      return {
        title: "This link can't close the request.",
        detail: 'Use the private link shown when it was posted, or the account that posted it.',
      };
    case 'agent_not_found':
      return {
        title: "That agent isn't in this workspace any more.",
        detail: 'Pick another one, or post as yourself.',
      };
    case 'not_found':
      return { title: "The Feed isn't available right now.", detail: 'Try again later.' };
    // A moment of database load (503 busy) has the same words as any failure on our side; a
    // longer wait (a search past its own time limit) is said, so Try again is not pressed at once.
    case 'busy':
      if ((failure.retryAfterMs ?? 0) > 10_000)
        return {
          title: 'The Feed is busy right now.',
          detail: `Nothing is wrong with your search. Try again in ${waitText(failure.retryAfterMs!)}.`,
        };
    // falls through
    case 'server':
      // A post refused while posting is paused says so (503 "Posting is paused for now.").
      if (action === 'post' && failure.status === 503 && failure.said)
        return { title: 'Your request wasn’t posted.', detail: failure.said };
      return {
        title: 'Something went wrong on our side.',
        detail: 'Nothing changed. Try again in a moment.',
      };
    default:
      return {
        title: action === 'post' ? "Your request wasn't posted." : "This couldn't be loaded.",
        detail: 'Try again in a moment.',
      };
  }
}

/** A random key for one request, kept across retries of the same form. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The idempotency key a post was sent with, and the request it was sent for. */
export interface PostKey {
  key: string;
  text: string;
}

/**
 * The key for sending this request. A retry of the same request keeps the last key (an answer
 * that was lost is answered again, never posted twice). Once any field changed (the text, budget,
 * deadline, tags, reply handle or who it is posted as) it is a new request with a new key: the
 * server answers a reused key with the request it first posted, which would confirm the old
 * version as the one that is live. If that first one did land, the server refuses the new key as
 * a duplicate title and the form says so.
 */
export function postKey(
  last: PostKey | null,
  body: Omit<NewFeedRequest, 'idempotencyKey'> & { idempotencyKey?: string; website?: string },
  make: () => string = newIdempotencyKey,
): PostKey {
  const text = JSON.stringify([
    body.title,
    body.description,
    body.budgetUsdc ?? null,
    body.deadline ?? null,
    body.capabilities ?? [],
    body.reply ?? null,
    body.agentId ?? null,
  ]);
  return last && last.text === text ? last : { key: make(), text };
}

/** A close the server refused as already closed (409 request_closed): it is closed all the same. */
export const alreadyClosed = (error: unknown) =>
  error instanceof FeedFailure && error.code === 'request_closed';
