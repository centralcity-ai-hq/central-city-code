/*
 * web-read: the visible text of one public https page, read live through the safe fetcher
 * (safe-fetch.ts: public DNS names only, every answer checked and the connection pinned to them,
 * redirects checked again and https only, one deadline, byte and piece caps, per-host limits).
 *
 *   - the input is OFFER_KIND_SPECS['web-read']: an https `url` and an optional `max_chars`
 *     (default and most WEB_READ_LIMITS.maxChars). check() holds the URL's static rules
 *     (publicUrlProblem: https, port, no user name or password, length, no IP literal, no
 *     localhost / .local / .internal / single-label name): a URL that breaks them is an input
 *     error before payment, with no lookup and no request
 *   - the answer is text/plain: the page's text (HTML and XML: the visible text without the
 *     title; plain text and JSON: the body), whitespace collapsed, at most `max_chars` characters
 *     (code points) and at most OFFER_ANSWER_MAX_BYTES of UTF-8, cut at a character
 *   - a page that answers with a status other than 2xx is not read as an answer: it is a failure
 *     ('page_status', 422), since a plain text answer cannot say it is an error page
 *   - run() starts after the buyer paid. Every failure there (DNS, a private address behind the
 *     name, the page, the fetcher's limits: host_busy 429 and busy 503 included) is
 *     OfferKindFailure, the paid call's outcome (paid_no_result). outboundSent only says whether a
 *     request reached the page's host; it never decides whether money moves (kind-core.ts).
 *     host_busy and busy (nothing sent) are run again by the engine a few times, seconds apart
 *     (OFFER_RUN_ATTEMPTS in server/feed/pay/engine.ts), before the call ends paid_no_result.
 *     Follow-up: a fetcher slot reserved before payment would turn busy/host_busy into a refusal
 *     before payment
 *   - ctx.signal ends the read (the fetcher's own deadline still applies); ctx.now is the only
 *     clock (the fetcher's per-host minute)
 */
import { OFFER_KIND_SPECS } from '../../../shared/feed-offers.js';
import {
  checked,
  OFFER_ANSWER_MAX_BYTES,
  offerKindDeps,
  OfferKindFailure,
  OfferKindInputError,
  type OfferKind,
  type OfferKindContext,
} from './kind-core.js';
import { collapseWhitespace, cutUtf8, htmlToText } from './html-text.js';
import {
  publicUrlProblem,
  SafeFetchError,
  type PublicFetchResponse,
  type SafeFetchErrorKind,
} from './safe-fetch.js';

export const WEB_READ_LIMITS = {
  timeoutMs: 5_000,
  /** The largest page body read. */
  maxBytes: 1024 * 1024,
  maxRedirects: 3,
  /** The default and the largest `max_chars` (OFFER_KIND_SPECS['web-read']). */
  maxChars: 20_000,
} as const;

export const WEB_READ_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
] as const;

type FetchFailure = [status: OfferKindFailure['status'], code: string, message?: string];

const NO_PUBLIC_ADDRESS = 'The host has no public address.';
const NOT_READ = 'The page could not be reached or did not answer in time.';

/**
 * How each refusal of the safe fetch answers: the target's fault is 422, the network's 502, the
 * fetcher's limits 429 (that host) or 503 (this process). Some kinds share one code and a fixed
 * message on purpose: a buyer must not learn which internal names exist (a name with only private
 * addresses and a missing one look the same) or tell a closed port from a silent one.
 */
const FETCH_FAILURES: Record<SafeFetchErrorKind, FetchFailure> = {
  bad_url: [422, 'url_refused'],
  not_public: [422, 'host_refused', NO_PUBLIC_ADDRESS],
  not_found: [422, 'host_refused', NO_PUBLIC_ADDRESS],
  too_large: [422, 'too_large'],
  fragmented: [422, 'too_fragmented'],
  content_type: [422, 'unsupported_content_type'],
  encoding: [422, 'unsupported_encoding'],
  too_many_redirects: [422, 'too_many_redirects'],
  unreachable: [502, 'unreachable', NOT_READ],
  timeout: [502, 'unreachable', NOT_READ],
  host_busy: [429, 'host_busy'],
  busy: [503, 'busy'],
};

/**
 * The charset a page declares in a <meta> tag near its start, or null. As the HTML prescan does,
 * a declared UTF-16 reads as UTF-8 (a page whose <meta> can be read as ASCII is not UTF-16) and
 * x-user-defined as windows-1252.
 */
function metaCharset(body: Buffer): string | null {
  const head = body.subarray(0, 1024).toString('latin1');
  // One optional space run on each side of "=": no two adjacent runs that could split the same
  // spaces, so a crafted head cannot make this backtrack.
  const label = /<meta\b[^>]{0,512}?charset\s*=\s*["']?([a-zA-Z0-9_:.-]{1,40})/i.exec(head)?.[1];
  if (!label) return null;
  if (label.toLowerCase() === 'x-user-defined') return 'windows-1252';
  try {
    if (new TextDecoder(label).encoding.startsWith('utf-16')) return 'utf-8';
  } catch {
    return null;
  }
  return label;
}

/** A fetched page's body as text: its declared charset (header, then <meta>), else UTF-8. */
export function decodePage(page: PublicFetchResponse): string {
  const label = page.charset ?? (page.contentType === 'text/html' ? metaCharset(page.body) : null);
  try {
    return new TextDecoder(label ?? 'utf-8').decode(page.body);
  } catch {
    // An unknown charset label reads as UTF-8.
    return new TextDecoder('utf-8').decode(page.body);
  }
}

/** At most `maxChars` code points of `text`, then at most `maxBytes` of UTF-8. */
export function capText(text: string, maxChars: number, maxBytes: number): string {
  let end = 0;
  let chars = 0;
  while (end < text.length && chars < maxChars) {
    const code = text.charCodeAt(end);
    end += code >= 0xd800 && code <= 0xdbff && end + 1 < text.length ? 2 : 1;
    chars++;
  }
  return cutUtf8(text.slice(0, end), maxBytes).text;
}

/** The text of a fetched page (HTML and XML: visible text; anything else: the body). */
export function pageText(page: PublicFetchResponse, maxChars: number): string {
  const decoded = decodePage(page);
  const text =
    page.contentType === 'text/html' || page.contentType === 'application/xml'
      ? htmlToText(decoded, {
          xml: page.contentType === 'application/xml',
          // Only this much text is sent: the walk stops once it has more (a code point is at most
          // 4 bytes of UTF-8).
          maxTextBytes: Math.min(OFFER_ANSWER_MAX_BYTES, maxChars * 4),
        }).text
      : collapseWhitespace(decoded);
  return capText(text, maxChars, OFFER_ANSWER_MAX_BYTES);
}

/**
 * The URL of a page kind's input (web-read, web-meta, web-links) after its schema, checked by the
 * static rules (publicUrlProblem); OfferKindInputError for any broken, with fixed text (never the
 * URL).
 */
export function pageUrlInput(
  kind: 'web-read' | 'web-meta' | 'web-links',
  input: unknown,
): { url: string; value: ReturnType<typeof checked> } {
  const value = checked(kind, input);
  const url = String(value.url);
  const problem = publicUrlProblem(url, { httpsOnly: true });
  if (problem) throw new OfferKindInputError(`url ${problem.reason}.`);
  return { url, value };
}

/** The URL and max_chars of a web-read input; OfferKindInputError for any static rule broken. */
function webReadInput(input: unknown): { url: string; maxChars: number } {
  const { url, value } = pageUrlInput('web-read', input);
  return {
    url,
    maxChars: value.max_chars === undefined ? WEB_READ_LIMITS.maxChars : Number(value.max_chars),
  };
}

/**
 * One page read through the safe fetcher with web-read's limits (WEB_READ_LIMITS) and only these
 * content types, for a kind's run() (after payment). Every failure is OfferKindFailure, as
 * web-read answers it (FETCH_FAILURES); a status other than 2xx is 'page_status' (422).
 */
export async function fetchPage(
  url: string,
  contentTypes: readonly string[],
  ctx: OfferKindContext,
): Promise<PublicFetchResponse> {
  ctx.signal.throwIfAborted();
  let page: PublicFetchResponse;
  try {
    page = await offerKindDeps().fetchPublic({
      url,
      timeoutMs: WEB_READ_LIMITS.timeoutMs,
      maxBytes: WEB_READ_LIMITS.maxBytes,
      maxRedirects: WEB_READ_LIMITS.maxRedirects,
      contentTypes,
      httpsOnly: true,
      signal: ctx.signal,
      now: ctx.now,
    });
  } catch (error) {
    // The caller's end is the caller's: its reason, not a fetch failure.
    ctx.signal.throwIfAborted();
    if (!(error instanceof SafeFetchError))
      throw new OfferKindFailure('unreachable', NOT_READ, 502);
    const [status, code, message] = FETCH_FAILURES[error.kind];
    throw new OfferKindFailure(code, message ?? error.message, status, {
      outboundSent: error.outboundSent,
    });
  }
  if (page.status < 200 || page.status > 299)
    throw new OfferKindFailure(
      'page_status',
      `The page answered with HTTP status ${page.status}.`,
      422,
      // A server error may pass; a missing or refused page answers the same again.
      { retryable: page.status >= 500, outboundSent: true },
    );
  return page;
}

export const webReadKind: OfferKind = {
  name: 'web-read',
  inputSchema: OFFER_KIND_SPECS['web-read'].input,
  outputMime: OFFER_KIND_SPECS['web-read'].outputMime,
  check(input) {
    webReadInput(input);
  },
  async run(input, ctx) {
    const { url, maxChars } = webReadInput(input);
    const page = await fetchPage(url, WEB_READ_CONTENT_TYPES, ctx);
    const text = pageText(page, maxChars);
    ctx.signal.throwIfAborted();
    return { body: text, mime: 'text/plain' };
  },
};
