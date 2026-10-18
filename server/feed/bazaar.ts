/*
 * Operation Central City Feed, release 1 (shared/feed.ts): reading the x402 Bazaar, the public and
 * keyless discovery list of x402 resources, and turning one of its records into the Feed's stored
 * row (server/feed/types.ts FeedServiceRow), or into the reason the Feed never lists it.
 *
 * - fetchBazaarPage reads one page (offset paging, at most BAZAAR_PAGE_LIMIT records). It never
 *   retries: the sweep (server/feed/ingest.ts) backs off on 'rate_limited' and 'unavailable'. Its
 *   errors are fixed sentences: never a URL, a status text or anything the source sent.
 * - normalizeBazaarItem keeps one offer per record: Base mainnet ("eip155:8453", or "base" as x402
 *   v1 names it, exact match only), USDC by contract address, scheme exact or upto, the cheapest
 *   if several. Anything else is an exclusion (FEED_EXCLUSIONS) kept for the operator.
 * - Provider text is untrusted data: stored as plain text without control or invisible characters
 *   (bidi, zero-width, tag characters and the like: removed, so the risk rule reads the words a
 *   person sees) and cut to the contract's limits. A resource with whitespace or an invisible
 *   character in it is a bad URL. What the source does not say stays null, never a guessed value.
 * - The service id hashes the canonical resource URL, so it stays the same across sweeps.
 * - A record on the host Central City serves its own offers from is 'hosted_here', never a row:
 *   that resource is listed from its offer (server/feed/offers/store.ts).
 */
import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import type { Address } from '../../shared/base/chains.js';
import {
  FEED_HTTP_METHODS,
  FEED_LIMITS,
  FEED_NETWORK,
  FEED_USDC,
  feedActionRiskOf,
  feedEndpointRiskOf,
  feedRiskOf,
  usdcToRaw,
  type FeedExampleState,
  type FeedExclusion,
  type FeedField,
  type FeedHttpMethod,
  type FeedRiskCategory,
  type FeedSchemaSummary,
} from '../../shared/feed.js';
import { contactDataService, serviceContactIn } from './policy.js';
import type { FeedServiceRow } from './types.js';

/** The discovery list: no key, every resource type (http and mcp) in one pass. */
export const BAZAAR_LIST_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
/** Records per page: the most the list answers (it accepts 20 to 1000). */
export const BAZAAR_PAGE_LIMIT = 1000;
const BAZAAR_PAGE_MIN = 20;
export const BAZAAR_TIMEOUT_MS = 30_000;
/** A larger page is refused as 'malformed' (1000 real records are about 3 MB). */
export const BAZAAR_PAGE_MAX_BYTES = 64 * 1024 * 1024;
/** How x402 v1 names Base mainnet. */
const V1_BASE_MAINNET = 'base';

export type FeedSourceErrorCode = 'rate_limited' | 'unavailable' | 'malformed';

const SOURCE_ERROR_TEXT: Record<FeedSourceErrorCode, string> = {
  rate_limited: 'The x402 Bazaar asked us to slow down.',
  unavailable: 'The x402 Bazaar did not answer.',
  malformed: 'The x402 Bazaar answered something we could not read.',
};

export class FeedSourceError extends Error {
  /** The HTTP status when the source answered one; null when no answer came at all. */
  readonly status: number | null;
  /** From Retry-After on a 429 (at most a day); null when absent or unreadable. */
  readonly retryAfterMs: number | null;

  constructor(
    readonly code: FeedSourceErrorCode,
    message: string = SOURCE_ERROR_TEXT[code],
    details: { status?: number | null; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'FeedSourceError';
    this.status = details.status ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

export interface BazaarFetchDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Tests; defaults to BAZAAR_PAGE_MAX_BYTES. */
  maxBytes?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const DAY_MS = 86_400_000;

/** Retry-After as delay-seconds or an HTTP date; null when absent, unreadable or past. */
function retryAfterOf(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  const ms = /^\d{1,9}$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, DAY_MS) : null;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/** The body as text, or null when it is larger than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await discard(response);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * One page of the list: its records (unread, for normalizeBazaarItem) and the total the source
 * reports now (it moves while a sweep runs). `limit` is held to 20..1000.
 */
export async function fetchBazaarPage(
  deps: BazaarFetchDeps,
  offset: number,
  limit: number = BAZAAR_PAGE_LIMIT,
): Promise<{ items: unknown[]; total: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError('The page offset must be a whole number, 0 or more.');
  const size = Number.isFinite(limit)
    ? Math.min(BAZAAR_PAGE_LIMIT, Math.max(BAZAAR_PAGE_MIN, Math.trunc(limit)))
    : BAZAAR_PAGE_LIMIT;
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${BAZAAR_LIST_URL}?limit=${size}&offset=${offset}`, {
      headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
      // Only the Bazaar itself is ever read: a redirect elsewhere fails the page, never followed.
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? BAZAAR_TIMEOUT_MS),
    });
  } catch {
    throw new FeedSourceError('unavailable');
  }
  const status = response.status;
  if (status === 429) {
    const retryAfterMs = retryAfterOf(response.headers.get('retry-after'), Date.now());
    await discard(response);
    throw new FeedSourceError('rate_limited', undefined, { status, retryAfterMs });
  }
  if (!response.ok) {
    await discard(response);
    throw new FeedSourceError('unavailable', undefined, { status });
  }
  let text: string | null;
  try {
    text = await readCapped(response, deps.maxBytes ?? BAZAAR_PAGE_MAX_BYTES);
  } catch {
    // The connection broke or the timeout fired while the body was still arriving.
    throw new FeedSourceError('unavailable', undefined, { status });
  }
  if (text === null) throw new FeedSourceError('malformed', undefined, { status });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FeedSourceError('malformed', undefined, { status });
  }
  const page = recordOf(body);
  const items = page.items;
  const total = recordOf(page.pagination).total;
  if (
    !Array.isArray(items) ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    throw new FeedSourceError('malformed', undefined, { status });
  return { items, total };
}

// ---------------------------------------------------------------------------------------------
// Ids and URLs

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const SERVICE_ID_LENGTH = 20;

/** 'svc_' + the first 20 base32 characters (RFC 4648, lowercase) of sha256("x402-bazaar\n" + url). */
export function feedServiceId(canonicalUrl: string): string {
  const digest = createHash('sha256').update(`x402-bazaar\n${canonicalUrl}`).digest();
  let id = '';
  let value = 0;
  let bits = 0;
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && id.length < SERVICE_ID_LENGTH) {
      bits -= 5;
      id += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
    if (id.length === SERVICE_ID_LENGTH) break;
  }
  return `svc_${id}`;
}

/**
 * A resource longer than this (UTF-8 bytes) is not kept, not even as an exclusion: record ids are
 * unique keys, and an index entry has a size limit.
 */
const RECORD_ID_MAX_BYTES = 2048;

/** The resource exactly as listed, when it can serve as a record id at all. */
function recordIdOf(resource: unknown): string | null {
  if (typeof resource !== 'string' || !resource.trim()) return null;
  if (/[\p{Cc}\p{Cs}]/u.test(resource)) return null;
  return Buffer.byteLength(resource, 'utf8') <= RECORD_ID_MAX_BYTES ? resource : null;
}

/** A DNS name of two labels or more, the shape `?host=` accepts (shared/feed.ts). */
const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Names that only ever resolve on a private network or not at all. */
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'arpa',
  'test',
  'invalid',
];

/**
 * Characters that show as nothing, or only change how the text around them shows, as the body of
 * a character class: every format character (bidi controls, zero-width characters, the soft
 * hyphen, the tag characters), variation selectors, the combining grapheme joiner, the invisible
 * Mongolian and Khmer marks and the Hangul fillers. The whole tag block and the whole selector
 * supplement are named, assigned or not. A model reads them; a person reviewing the page does not.
 */
const INVISIBLE = String.raw`\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}`;

/** Raw whitespace or an invisible character: never in a resource that is a real URL. */
const NOT_IN_URL = new RegExp(`[\\s\\p{Z}\\u0085${INVISIBLE}]`, 'u');

/**
 * The resource as a WHATWG URL (lowercase host, default port dropped, path, query and fragment as
 * listed), or null for a bad URL: raw whitespace or an invisible character in it, not https,
 * credentials in it, or a host that is an IP literal, a single label, a private or local name, or
 * not a DNS name.
 *
 * A real URL never carries whitespace or invisible characters raw (they are percent-encoded), but
 * the parser accepts them, and the record id (the resource as listed) is in every answer: a bidi
 * override there spoofs a file name, and spaces or tag characters carry free text to a model.
 */
function resourceUrlOf(resource: string): URL | null {
  if (NOT_IN_URL.test(resource)) return null;
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname;
  if (host.startsWith('[') || IPV4.test(host) || !DNS_NAME.test(host)) return null;
  const suffix = host.slice(host.lastIndexOf('.') + 1);
  return PRIVATE_SUFFIXES.includes(suffix) ? null : url;
}

// ---------------------------------------------------------------------------------------------
// Provider text

/** Whitespace (the byte order mark aside, which is invisible) and NEL: each one a space. */
const SPACE = /[^\S\ufeff]|\u0085/gu;
/** Control characters, lone surrogates and the invisible characters: removed, never a space. */
const HIDDEN = new RegExp(`[\\p{Cc}\\p{Cs}${INVISIBLE}]`, 'gu');

/**
 * Plain text as a reader sees it: whitespace runs become one space, hidden characters are removed
 * (a space would split a word in two), then trimmed. The risk rule reads this text too, so a word
 * with an invisible character inside it is still that word.
 */
function plain(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(SPACE, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * The string values of every `enum` in an extension (an action list like 'aave-supply token-
 * transfer' named nowhere else), plain, for the risk check only. Bounded: at most 8 levels deep,
 * 200 values and 4,000 characters.
 */
function enumWords(value: unknown): string {
  const words: string[] = [];
  let length = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || words.length >= 200 || length >= 4_000) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'enum' && Array.isArray(child)) {
        for (const word of child) {
          const text = plain(word);
          if (!text || words.length >= 200 || length >= 4_000) continue;
          words.push(text);
          length += text.length + 1;
        }
      } else walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return words.join(' ');
}

/**
 * At most `max` code points, cut whole: at the last space within the limit, so no word is cut in
 * two. A text whose last space within the limit comes before its middle (one very long token) is
 * cut at the limit instead.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  const head = points.slice(0, max);
  if (/\s/.test(points[max])) return head.join('').trimEnd();
  let space = head.length - 1;
  while (space >= 0 && !/\s/.test(head[space])) space--;
  return (space >= max / 2 ? head.slice(0, space) : head).join('').trimEnd();
}

/**
 * Characters JSON.stringify leaves raw that must not reach a reader raw: the C1 controls, the
 * line and paragraph separators and the invisible characters.
 */
const JSON_HIDDEN = new RegExp(`[\\u007f-\\u009f\\u2028\\u2029${INVISIBLE}]`, 'gu');

/** A character as JSON escapes (\uXXXX; one past U+FFFF as its surrogate pair): still JSON. */
const jsonEscape = (c: string) =>
  Array.from(
    { length: c.length },
    (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`,
  ).join('');

/** The example shortened: arrays to their first `items`, strings to `chars` code points (cut + …). */
function shortened(value: unknown, items: number, chars: number, depth = 0): unknown {
  if (depth > 64) return '…';
  if (typeof value === 'string')
    return Array.from(value).length > chars ? `${cut(value, chars - 1)}…` : value;
  if (Array.isArray(value))
    return value.slice(0, items).map((item) => shortened(item, items, chars, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, shortened(child, items, chars, depth + 1)]),
  );
}

/** Shorter forms of an example too long to show whole: fewer items, shorter strings. */
const EXAMPLE_STEPS: ReadonlyArray<readonly [items: number, chars: number]> = [
  [3, 160],
  [1, 80],
];

interface ShownExample {
  example: string | null;
  exampleState: FeedExampleState | null;
}

/**
 * The provider's example as JSON text, at most exampleMax, and how it is shown; null and no state
 * when absent. Always JSON (the detail shows it as code): an example too long to show whole is
 * shortened (its arrays to their first items, its long strings cut with "…"), and left out
 * ('too_long') when even that does not fit.
 */
function exampleOf(value: unknown): ShownExample {
  const none: ShownExample = { example: null, exampleState: null };
  if (value === undefined || value === null) return none;
  const json = (shown: unknown) => {
    const text = JSON.stringify(shown) as string | undefined;
    return text === undefined ? null : text.replace(JSON_HIDDEN, jsonEscape);
  };
  const fits = (text: string | null) =>
    text !== null && Array.from(text).length <= FEED_LIMITS.exampleMax;
  const whole = json(value);
  if (whole === null) return none;
  if (fits(whole)) return { example: whole, exampleState: 'whole' };
  for (const [items, chars] of EXAMPLE_STEPS) {
    const text = json(shortened(value, items, chars));
    if (fits(text)) return { example: text, exampleState: 'shortened' };
  }
  return { example: null, exampleState: 'too_long' };
}

/**
 * What names nothing in a path: a placeholder segment (":address", "{id}", "<id>", "[id]"), a
 * placeholder inside one ("{id}.json", "report-{id}", "by-:id"; a colon inside a word, as in
 * "models:generate", is no placeholder), and as a part of a segment 0x hex, a number of 6 digits
 * or more, a hex id (12 or more hex digits with a digit among them, or 8 or more with a digit
 * before a letter: "0dfa6d40", not "feed1234" or "decade2024") or an opaque id (8 or more letters
 * and digits, at least 3 digits, a digit before a letter twice: "1fdtpty5r4th", not "blake2s256").
 * UUIDs go before the split.
 */
const PLACEHOLDER = /^(?::\w|\{.*\}$|<.*>$|\[.*\]$)/;
const PLACEHOLDER_IN = /\{[^{}]*\}|<[^<>]*>|\[[^[\]]*\]|(?<=^|[-_.\s]):\w+/g;
/** What is left of "{id}.json" once its placeholder goes: a file type, naming nothing. */
const FILE_TYPE_ONLY = /^\.\w{1,5}$/;
const OPAQUE_PART =
  /^(?:0x[0-9a-f]*|\d{6,}|(?=[a-f]*\d)(?:[0-9a-f]{12,}|(?=[a-f]*\d+[a-f])[0-9a-f]{8,11})|(?=(?:[a-z]*\d){3})(?=(?:[a-z]*\d+[a-z]){2})[a-z0-9]{8,})$/i;
/** A one-character segment that names nothing: a Latin letter (a Han character is a word). */
const LONE_LETTER = /^\p{Script=Latin}$/u;
/** Segments that say nothing of the service on their own. */
const GENERIC_SEGMENT = /^(?:api|apis|rest|v\d+(?:\.\d+)*)$/i;

/** One path segment (or tool name) as words: its opaque parts and placeholders left out. */
function readableSegment(segment: string): string {
  if (!segment || PLACEHOLDER.test(segment)) return '';
  const bare = segment.replace(PLACEHOLDER_IN, '');
  if (bare !== segment && FILE_TYPE_ONLY.test(bare)) return '';
  // A UUID with a prefix ("svc_" + UUID) goes whole, before the split on '-' takes it apart.
  const text = bare.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '');
  // Parts at even indexes, the separators between them at odd ones.
  const parts = text.split(/([-_.:\s]+)/);
  let words = '';
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i] || OPAQUE_PART.test(parts[i])) continue;
    // A kept part joins the words before it with the separator just before it.
    words += (words ? parts[i - 1] : '') + parts[i];
  }
  // One Latin letter names nothing; one Han, kana or Hangul character is a word. Counted in code
  // points, not UTF-16 units.
  return /\p{L}/u.test(words) &&
    (Array.from(words).length > 1 || !LONE_LETTER.test(words)) &&
    !GENERIC_SEGMENT.test(words)
    ? words
    : '';
}

/**
 * The title when serviceName is absent: "<host> <tool name>" for an MCP tool, else "<host> <last
 * readable path segment>" (placeholders, hex, UUIDs, long numbers and opaque ids left out), else
 * the host.
 */
function fallbackTitle(url: URL): string {
  const decode = (part: string) => {
    try {
      return plain(decodeURIComponent(part));
    } catch {
      return plain(part);
    }
  };
  const segments = [url.hash.slice(1), ...url.pathname.split('/').reverse()];
  for (const segment of segments) {
    const words = readableSegment(decode(segment));
    if (words) return `${url.hostname} ${words}`;
  }
  return url.hostname;
}

/** Provider tags: plain, lowercased, deduplicated, each at most tagMax (longer ones left out). */
function capabilitiesOf(tags: string[]): string[] {
  const kept = new Set<string>();
  for (const tag of tags) {
    const value = tag.toLowerCase();
    if (value && Array.from(value).length <= FEED_LIMITS.tagMax) kept.add(value);
    if (kept.size === FEED_LIMITS.tagsMax) break;
  }
  return [...kept];
}

// ---------------------------------------------------------------------------------------------
// Schema summaries

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
/** Field names as shown. */
const FIELD_NAME_MAX = 64;

/** A JSON Schema type as text: "string", "string[]", "string | null"; "unknown" if absent. */
function typeOf(schema: unknown): string {
  const node = recordOf(schema);
  const listed = Array.isArray(node.type) ? node.type : [node.type];
  const types = [
    ...new Set(listed.filter((t): t is string => typeof t === 'string' && SCHEMA_TYPES.has(t))),
  ].map((type) => {
    if (type !== 'array') return type;
    const item = recordOf(node.items).type;
    return typeof item === 'string' && SCHEMA_TYPES.has(item) && item !== 'array'
      ? `${item}[]`
      : 'array';
  });
  if (!types.length) return 'unknown';
  return [...types.filter((t) => t !== 'null'), ...types.filter((t) => t === 'null')].join(' | ');
}

/** The top-level fields of an object schema. Header fields keep their name only. */
function fieldsOf(schema: unknown, place: FeedField['in']): FeedField[] {
  const node = recordOf(schema);
  if (!isRecord(node.properties)) return [];
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const fields: FeedField[] = [];
  for (const [key, value] of Object.entries(node.properties)) {
    const name = cut(plain(key), FIELD_NAME_MAX);
    if (!name) continue;
    fields.push({
      name,
      in: place,
      type: typeOf(value),
      required: required.has(key),
      description:
        place === 'header'
          ? ''
          : cut(plain(recordOf(value).description), FEED_LIMITS.fieldDescriptionMax),
    });
  }
  return fields;
}

function formatOf(value: unknown): FeedSchemaSummary['format'] {
  if (typeof value !== 'string' || !value) return null;
  return value === 'json' || value === 'text' ? value : 'other';
}

function summaryOf(
  fields: FeedField[],
  format: FeedSchemaSummary['format'],
  { example, exampleState }: ShownExample,
): FeedSchemaSummary | null {
  if (!fields.length && format === null && exampleState === null) return null;
  return {
    format,
    fields: fields.slice(0, FEED_LIMITS.fieldsMax),
    more: Math.max(0, fields.length - FEED_LIMITS.fieldsMax),
    example,
    exampleState,
  };
}

/**
 * Input: the query, path, body and header fields of schema.properties.input; the format is the
 * body type (null without one); the example is info.input's queryParams, else its body.
 */
function inputOf(info: Record<string, unknown>, schema: Record<string, unknown>) {
  const declared = recordOf(recordOf(recordOf(schema.properties).input).properties);
  const fields = [
    ...fieldsOf(declared.queryParams, 'query'),
    ...fieldsOf(declared.pathParams, 'path'),
    ...fieldsOf(declared.body, 'body'),
    ...fieldsOf(declared.headers, 'header'),
  ];
  const input = recordOf(info.input);
  return summaryOf(fields, formatOf(input.bodyType), exampleOf(input.queryParams ?? input.body));
}

/**
 * Output: the fields of schema.properties.output's example schema, else of info.output.schema;
 * the format is info.output.type; the example is info.output.example.
 */
function outputOf(info: Record<string, unknown>, schema: Record<string, unknown>) {
  const output = recordOf(info.output);
  const declared = recordOf(recordOf(recordOf(schema.properties).output).properties).example;
  const fields = fieldsOf(declared, null);
  return summaryOf(
    fields.length ? fields : fieldsOf(output.schema, null),
    formatOf(output.type),
    exampleOf(output.example),
  );
}

// ---------------------------------------------------------------------------------------------
// Records

export type NormalizedService =
  | { ok: true; row: FeedServiceRow }
  | { ok: false; recordId: string | null; excluded: FeedExclusion };

const excluded = (recordId: string | null, reason: FeedExclusion): NormalizedService => ({
  ok: false,
  recordId,
  excluded: reason,
});

interface Offer {
  scheme: 'exact' | 'upto';
  priceRaw: string | null;
  payTo: Address;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USDC_ADDRESS = FEED_USDC.address.toLowerCase();
const PRICE_CAP_RAW = BigInt(usdcToRaw(FEED_LIMITS.priceCapUsdc) ?? '0');

/** One offer, or null when its payee or its amount cannot be read. No amount: unknown price. */
function offerOf(offer: Record<string, unknown>): Offer | null {
  if (typeof offer.payTo !== 'string' || !EVM_ADDRESS.test(offer.payTo)) return null;
  const amount = offer.amount ?? offer.maxAmountRequired;
  let priceRaw: string | null = null;
  if (amount !== undefined && amount !== null) {
    if (typeof amount === 'string' && /^[0-9]{1,100}$/.test(amount))
      priceRaw = BigInt(amount).toString();
    else if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0)
      priceRaw = String(amount);
    else return null;
  }
  return {
    scheme: offer.scheme === 'upto' ? 'upto' : 'exact',
    priceRaw,
    payTo: getAddress(offer.payTo),
  };
}

/**
 * The cheaper offer: a known price before an unknown one, then the lower price; at the same price
 * exact before upto, else the one listed first. Prices are normalized, so equal text = equal price.
 */
function cheaper(a: Offer, b: Offer): Offer {
  if (a.priceRaw !== b.priceRaw) {
    if (a.priceRaw === null || b.priceRaw === null) return a.priceRaw === null ? b : a;
    return BigInt(b.priceRaw) < BigInt(a.priceRaw) ? b : a;
  }
  return a.scheme === 'upto' && b.scheme === 'exact' ? b : a;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

/** An ISO 8601 time with its zone, as ms; null otherwise. */
function timeOf(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A count the source reports, when it fits the column; null otherwise. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2 ** 31 - 1
    ? value
    : null;
}

function methodOf(value: unknown): FeedHttpMethod | null {
  const method = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return FEED_HTTP_METHODS.find((known) => known === method) ?? null;
}

/**
 * The risk rules over a listing's own text, the one check both sources run: the Bazaar's records
 * here and Central City's offers (server/feed/offers/store.ts). Matched on the whole text, before
 * it is cut for display, with the extension's own description; the schema's enum values only for
 * action names (read for this check only, never shown). Fullwidth and compatibility forms read as
 * their plain letters. Then the endpoint (host and path), and contact details in the listing's own
 * text (title, description, tags).
 */
export function listingRiskOf(listing: {
  title: string;
  description: string;
  tags: readonly string[];
  extensionDescription?: string;
  enumText?: string;
  url: URL;
}): FeedRiskCategory | null {
  const contactData = contactDataService(`${listing.title}\n${listing.description}`);
  return (
    feedRiskOf(
      listing.title.normalize('NFKC'),
      listing.description.normalize('NFKC'),
      listing.tags.join(' ').normalize('NFKC'),
      (listing.extensionDescription ?? '').normalize('NFKC'),
    ) ??
    feedActionRiskOf((listing.enumText ?? '').normalize('NFKC')) ??
    feedEndpointRiskOf(listing.url.href) ??
    ([listing.title, listing.description, listing.tags.join(' / ')].some((text) =>
      serviceContactIn(text, { contactData, host: listing.url.hostname }),
    )
      ? 'contact_details'
      : null)
  );
}

/** Plain text as a reader sees it (see plain above): the offers' writer uses the same rule. */
export const listingPlain = (value: unknown): string => plain(value);

/** Tags as the Feed keeps them (capabilitiesOf above). */
export const listingTags = (tags: readonly string[]): string[] =>
  capabilitiesOf(tags.map(plain).filter(Boolean));

export interface NormalizeOptions {
  /**
   * The host Central City serves its own offers from (the configured public origin's host). A
   * Bazaar record on it is 'hosted_here', never a row: that resource is listed from its offer.
   * Null or absent: no such check (the source guard in store.ts still keeps those rows).
   */
  hostedHost?: string | null;
}

/** Whether a record's resource is on the host Central City serves its own offers from. */
function hostedHere(recordId: string, hostedHost: string | null | undefined): boolean {
  if (!hostedHost) return false;
  try {
    return new URL(recordId).hostname === hostedHost.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * One Bazaar record to the row the Feed stores, or why it is never listed. Checked in this order:
 * unreadable ('malformed'), a resource Central City hosts itself ('hosted_here'), no Base mainnet
 * offer, no Base USDC offer, no exact/upto scheme among them, the URL ('bad_url'), unreadable
 * offers ('malformed'), then the cheapest price over the cap. A risky record is a row (`risky`
 * set), never listed while a rule matches it.
 */
export function normalizeBazaarItem(
  item: unknown,
  fetchedAt: number,
  options: NormalizeOptions = {},
): NormalizedService {
  if (!isRecord(item)) return excluded(null, 'malformed');
  const recordId = recordIdOf(item.resource);
  if (recordId === null) return excluded(null, 'malformed');
  if (hostedHere(recordId, options.hostedHost)) return excluded(recordId, 'hosted_here');
  const version = item.x402Version;
  if (!Array.isArray(item.accepts) || (version !== 1 && version !== 2))
    return excluded(recordId, 'malformed');

  const onBase = item.accepts
    .filter(isRecord)
    .filter((offer) => offer.network === FEED_NETWORK || offer.network === V1_BASE_MAINNET);
  if (!onBase.length) return excluded(recordId, 'not_base_mainnet');
  const inUsdc = onBase.filter(
    (offer) => typeof offer.asset === 'string' && offer.asset.toLowerCase() === USDC_ADDRESS,
  );
  if (!inUsdc.length) return excluded(recordId, 'not_usdc');
  const supported = inUsdc.filter((offer) => offer.scheme === 'exact' || offer.scheme === 'upto');
  if (!supported.length) return excluded(recordId, 'unsupported_scheme');

  const url = resourceUrlOf(recordId);
  if (!url) return excluded(recordId, 'bad_url');

  const offers = supported.map(offerOf).filter((offer): offer is Offer => offer !== null);
  if (!offers.length) return excluded(recordId, 'malformed');
  const offer = offers.reduce(cheaper);
  if (offer.priceRaw !== null && BigInt(offer.priceRaw) > PRICE_CAP_RAW)
    return excluded(recordId, 'price_over_cap');

  const host = url.hostname;
  const serviceName = plain(item.serviceName);
  const fullTitle = serviceName || fallbackTitle(url);
  const fullDescription = plain(item.description);
  const tags = (Array.isArray(item.tags) ? item.tags : []).map(plain).filter(Boolean);
  const title = cut(fullTitle, FEED_LIMITS.titleMax);
  const description = cut(fullDescription, FEED_LIMITS.descriptionMax);
  const capabilities = capabilitiesOf(tags);
  const providerName = serviceName ? cut(serviceName, FEED_LIMITS.titleMax) : null;

  const bazaar = recordOf(recordOf(item.extensions).bazaar);
  const info = recordOf(bazaar.info);
  const schema = recordOf(bazaar.schema);
  const quality = recordOf(item.quality);
  // A service that works on contact data, as its title and description say.
  const contactData = contactDataService(`${fullTitle}\n${fullDescription}`);
  // The detail shows the provider's examples and field descriptions as well. One that carries
  // contact details is left out, the listing stays: they are mostly sample data, and the check
  // also reads timestamps and ids there as numbers, so leaving out text is the cheap mistake. A
  // validator's sample inputs stay (its path may be what says so: "/hunter/email-verifier").
  const sample = {
    contactData: contactData || contactDataService(url.pathname.replace(/[/_-]+/g, ' ')),
    host,
  };
  const shown = (summary: FeedSchemaSummary | null): FeedSchemaSummary | null =>
    summary && {
      ...summary,
      fields: summary.fields.map((field) =>
        serviceContactIn(field.description, sample) ? { ...field, description: '' } : field,
      ),
      ...(summary.example !== null && serviceContactIn(summary.example, sample)
        ? { example: null, exampleState: null }
        : {}),
    };
  const input = shown(inputOf(info, schema));
  const output = shown(outputOf(info, schema));

  return {
    ok: true,
    row: {
      id: feedServiceId(url.href),
      recordId,
      host,
      url: url.href,
      title,
      description,
      capabilities,
      providerName,
      method: methodOf(recordOf(info.input).method),
      x402Version: version,
      scheme: offer.scheme,
      priceRaw: offer.priceRaw,
      payTo: offer.payTo,
      input,
      output,
      paidCalls30d: countOf(quality.l30DaysTotalCalls),
      payers30d: countOf(quality.l30DaysUniquePayers),
      lastCalledAt: timeOf(quality.lastCalledAt),
      sourceUpdatedAt: timeOf(item.lastUpdated),
      fetchedAt,
      risky: listingRiskOf({
        title: fullTitle,
        description: fullDescription,
        tags,
        extensionDescription: plain(bazaar.description),
        enumText: enumWords(bazaar),
        url,
      }),
      searchText: [title, description, capabilities.join(' '), host, providerName ?? '']
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    },
  };
}
