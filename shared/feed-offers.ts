/*
 * Feed offers: services that an owner's agents sell in the Feed, hosted by Central City. Browser-safe:
 * no Node imports. The server's writer is server/feed/offers/store.ts; what a kind does when it is
 * bought is server/feed/offers/kinds.ts.
 *
 * - An offer is one of the built-in, deterministic kinds below (OFFER_KINDS), at a fixed price per
 *   call in Base USDC, paid to the selling agent's own wallet (`payTo`, copied from the agent's
 *   ready wallet when the offer is created and never changed).
 * - The protocol fee is INCLUDED in the price: the buyer pays the listed price, the seller gets 90%
 *   and the protocol 10%, in one on-chain call (CentralCityFeeRouter.pay). The price bounds below
 *   are that call's own.
 * - Every offer is listed in the Feed under the source "Central City" (FEED_HOSTED_SOURCE in
 *   shared/feed.ts) unless it is paused or removed, its agent or workspace is paused, or a risk
 *   rule matches its text. The same rules, caps and limits hold for every owner.
 * - Each kind declares its input (OfferKindSpec.input): the server checks every call's input
 *   against it, and the listing shows it as the service's input schema.
 * - An offer may fix some of its kind's input fields (its preset, OfferPreset): every call runs with
 *   those values merged in, a buyer can leave them out but never send another value, and the
 *   listing shows them as fixed settings instead of input fields.
 */
import type { FeedField, FeedSchemaSummary } from './feed.js';

/**
 * CentralCityFeeRouter's MIN_INCLUDED and MAX_TOTAL (contracts/fees/CentralCityFeeRouter.sol), in
 * USDC base units: an offer is paid with the router's fee-included pay(payee, gross, ref), which
 * reverts for a gross below MIN_INCLUDED or above MAX_TOTAL, so a price outside them could never be
 * bought.
 */
export const FEE_ROUTER_MIN_INCLUDED = 50_000;
export const FEE_ROUTER_MAX_TOTAL = 100_000;

/** USDC on Base mainnet, the example contract of base-erc20-balance (lower case, as typed). */
const EXAMPLE_ERC20 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** The built-in kinds an offer can sell. Each one is deterministic: the same input, the same answer. */
export const OFFER_KINDS = [
  'web-read',
  'text-stats',
  'json-check',
  'hash',
  'base-usdc-balance',
  'base-block',
  'unit-convert',
  'base64',
  'url-encode',
  'case-convert',
  'slugify',
  'reading-time',
  'csv-to-json',
  'json-to-csv',
  'markdown-to-text',
  'roman-numerals',
  'number-to-words',
  'color-convert',
  'date-diff',
  'address-checksum',
  'web-meta',
  'web-links',
  'keyword-density',
  'text-diff',
  'json-query',
  'json-schema-check',
  'csv-stats',
  'base-tx',
  'base-erc20-balance',
  'base-gas',
] as const;
export type OfferKindName = (typeof OFFER_KINDS)[number];

/** 'off_' + 16 base32 characters (RFC 4648, lowercase). */
export const OFFER_ID = /^off_[a-z2-7]{16}$/;

/** active: listed (unless something else holds it); paused: kept, not listed; removed: final. */
export const OFFER_STATES = ['active', 'paused', 'removed'] as const;
export type OfferState = (typeof OFFER_STATES)[number];

/** The caller's own name for an offer, unique among its workspace's offers that are not removed. */
export const OFFER_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
/** A publish's idempotency key. */
export const OFFER_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** Where an offer is served for buyers outside Central City (its listing URL): origin + path + id. */
export const OFFER_PUBLIC_PATH = '/api/public/x402/';

export const OFFER_LIMITS = {
  /** Offers in one plan or publish. */
  batchMax: 100,
  /** The batch as JSON (UTF-8 bytes). */
  batchBytesMax: 1024 * 1024,
} as const;

/** The request body every tool call keeps, on /mcp and /api/assistant/tools/<tool>. */
export const TOOL_BODY_MAX_BYTES = 64 * 1024;
/**
 * The tools whose arguments carry a whole batch of offers: the only tool calls whose request body
 * may be up to OFFER_LIMITS.batchBytesMax (1 MiB), on /mcp and on their own REST tool routes.
 * Every other tool, city_service_pause and city_service_mine included, keeps TOOL_BODY_MAX_BYTES.
 */
export const OFFER_BATCH_TOOLS: readonly string[] = [
  'city_service_plan',
  'city_service_publish',
  'city_service_update',
];

/** A value of an input field. */
export type OfferInputValue = string | number | boolean;

/** One input field of a kind. Strings are measured in UTF-8 bytes. */
export interface OfferInputField {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean';
  required: boolean;
  /** Plain words, shown in the listing. */
  description: string;
  /** string: at most this many UTF-8 bytes. */
  maxBytes?: number;
  /** string: the whole value matches. */
  pattern?: RegExp;
  /** string: one of these. */
  values?: readonly string[];
  /** integer or number: inclusive bounds. */
  min?: number;
  max?: number;
}

export interface OfferKindSpec {
  name: OfferKindName;
  /** What one call answers, in plain words. */
  summary: string;
  /** The call's input: a JSON object with exactly these fields (unknown fields are refused). */
  input: readonly OfferInputField[];
  /** A valid input, shown in the listing as the example. */
  example: Record<string, OfferInputValue>;
  /** The answer's media type. */
  outputMime: 'application/json' | 'text/plain';
}

const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The largest text a text kind takes (UTF-8 bytes); its answer is also at most 64 KiB. */
const TEXT_MAX_BYTES = 65_536;
const textField = (description: string): OfferInputField => ({
  name: 'text',
  type: 'string',
  required: true,
  description,
  maxBytes: TEXT_MAX_BYTES,
});
const modeField = (what: string): OfferInputField => ({
  name: 'mode',
  type: 'string',
  required: true,
  description: `encode or decode ${what}.`,
  values: ['encode', 'decode'],
});

/** The cases case-convert writes. */
export const CASE_CONVERT_CASES = [
  'upper',
  'lower',
  'title',
  'sentence',
  'snake',
  'kebab',
  'camel',
  'pascal',
] as const;
/** The delimiters csv-to-json reads (\t is a tab). */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;

/** Units unit-convert reads, by dimension (a conversion stays within one). */
export const UNIT_CONVERT_UNITS = {
  length: ['mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi'],
  mass: ['mg', 'g', 'kg', 'oz', 'lb'],
  volume: ['ml', 'l', 'floz', 'gal'],
  temperature: ['c', 'f', 'k'],
} as const;
const UNITS = Object.values(UNIT_CONVERT_UNITS).flat();

/** An https page URL field, as web-read takes it. */
const pageUrlField = (description: string): OfferInputField => ({
  name: 'url',
  type: 'string',
  required: true,
  description,
  maxBytes: 2_048,
  pattern: HTTPS_URL,
});
/** The CSV delimiter and header fields, as csv-to-json takes them. */
const csvDelimiterField: OfferInputField = {
  name: 'delimiter',
  type: 'string',
  required: false,
  description: 'The field delimiter: a comma (default), a semicolon, a tab (\\t) or a pipe.',
  values: CSV_DELIMITERS,
};
/** The largest JSON Schema json-schema-check takes (UTF-8 bytes). */
export const JSON_SCHEMA_MAX_BYTES = 16_384;
/** The longest path json-query takes (UTF-8 bytes). */
export const JSON_QUERY_PATH_MAX_BYTES = 256;

export const OFFER_KIND_SPECS: Readonly<Record<OfferKindName, OfferKindSpec>> = {
  'web-read': {
    name: 'web-read',
    summary: 'Reads one public https page and answers its text.',
    input: [
      {
        name: 'url',
        type: 'string',
        required: true,
        description: 'The https page to read.',
        maxBytes: 2_048,
        pattern: HTTPS_URL,
      },
      {
        name: 'max_chars',
        type: 'integer',
        required: false,
        description: 'Most characters of text to answer (default 20000).',
        min: 1,
        max: 20_000,
      },
    ],
    example: { url: 'https://example.com/' },
    outputMime: 'text/plain',
  },
  'text-stats': {
    name: 'text-stats',
    summary: 'Counts the characters, words, lines and sentences of a text.',
    input: [
      {
        name: 'text',
        type: 'string',
        required: true,
        description: 'The text, at most 64 KiB.',
        maxBytes: 65_536,
      },
    ],
    example: { text: 'One line. Two words.' },
    outputMime: 'application/json',
  },
  'json-check': {
    name: 'json-check',
    summary: 'Checks whether a text is valid JSON, and where it fails if not.',
    input: [
      {
        name: 'text',
        type: 'string',
        required: true,
        description: 'The JSON text, at most 64 KiB.',
        maxBytes: 65_536,
      },
    ],
    example: { text: '{"a": 1}' },
    outputMime: 'application/json',
  },
  hash: {
    name: 'hash',
    summary: 'The SHA-256 of a text (its UTF-8 bytes), as lowercase hex.',
    input: [
      {
        name: 'text',
        type: 'string',
        required: true,
        description: 'The text, at most 8 KiB.',
        maxBytes: 8_192,
      },
    ],
    example: { text: 'hello' },
    outputMime: 'application/json',
  },
  'base-usdc-balance': {
    name: 'base-usdc-balance',
    summary: 'The USDC balance of an address on Base.',
    input: [
      {
        name: 'address',
        type: 'string',
        required: true,
        description: 'A Base address (0x and 40 hex digits).',
        maxBytes: 42,
        pattern: BASE_ADDRESS,
      },
    ],
    example: { address: '0x0000000000000000000000000000000000000001' },
    outputMime: 'application/json',
  },
  'base-block': {
    name: 'base-block',
    summary: "A Base block's number, hash and time; the latest block when no number is given.",
    input: [
      {
        name: 'number',
        type: 'integer',
        required: false,
        description: 'The block number.',
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      },
    ],
    example: { number: 1 },
    outputMime: 'application/json',
  },
  'unit-convert': {
    name: 'unit-convert',
    summary: 'Converts a value between two units of length, mass, volume or temperature.',
    input: [
      {
        name: 'value',
        type: 'number',
        required: true,
        description: 'The value to convert.',
        min: -1e15,
        max: 1e15,
      },
      {
        name: 'from',
        type: 'string',
        required: true,
        description: `The unit of value: ${UNITS.join(', ')}.`,
        values: UNITS,
      },
      {
        name: 'to',
        type: 'string',
        required: true,
        description: 'The unit to convert to, of the same kind as from.',
        values: UNITS,
      },
    ],
    example: { value: 1, from: 'km', to: 'mi' },
    outputMime: 'application/json',
  },
  base64: {
    name: 'base64',
    summary: 'Encodes a text as Base64, or decodes Base64 back to its UTF-8 text.',
    input: [
      textField('The text to encode (at most 48 KiB) or the Base64 to decode, at most 64 KiB.'),
      modeField('the text'),
    ],
    example: { text: 'hello', mode: 'encode' },
    outputMime: 'text/plain',
  },
  'url-encode': {
    name: 'url-encode',
    summary: 'Percent-encodes a text for a URL, or decodes a percent-encoded text.',
    input: [textField('The text, at most 64 KiB.'), modeField('the text')],
    example: { text: 'a b&c', mode: 'encode' },
    outputMime: 'text/plain',
  },
  'case-convert': {
    name: 'case-convert',
    summary:
      'Writes a text in another case: upper, lower, title, sentence, snake, kebab, camel or pascal.',
    input: [
      textField('The text, at most 64 KiB.'),
      {
        name: 'to',
        type: 'string',
        required: true,
        description: `The case to write: ${CASE_CONVERT_CASES.join(', ')}.`,
        values: CASE_CONVERT_CASES,
      },
    ],
    example: { text: 'Hello big world', to: 'snake' },
    outputMime: 'text/plain',
  },
  slugify: {
    name: 'slugify',
    summary: 'Turns a text into a URL slug: lower case ASCII letters and digits joined by hyphens.',
    input: [textField('The text, at most 64 KiB; the slug is at most 200 characters.')],
    example: { text: 'Caf\u00e9 & Cr\u00e8me: the best of 2026' },
    outputMime: 'text/plain',
  },
  'reading-time': {
    name: 'reading-time',
    summary: 'How long a text takes to read: its words, minutes and seconds.',
    input: [
      textField('The text, at most 64 KiB.'),
      {
        name: 'words_per_minute',
        type: 'integer',
        required: false,
        description: 'The reading speed in words per minute (default 200).',
        min: 100,
        max: 1_000,
      },
    ],
    example: { text: 'One short sentence to read.' },
    outputMime: 'application/json',
  },
  'csv-to-json': {
    name: 'csv-to-json',
    summary: 'Reads CSV (quoted fields as in RFC 4180) into JSON rows, at most 10000 rows.',
    input: [
      textField('The CSV text, at most 64 KiB.'),
      {
        name: 'delimiter',
        type: 'string',
        required: false,
        description: 'The field delimiter: a comma (default), a semicolon, a tab (\\t) or a pipe.',
        values: CSV_DELIMITERS,
      },
      {
        name: 'header',
        type: 'boolean',
        required: false,
        description:
          'Whether the first row names the columns (default true): rows are then objects, else arrays.',
      },
    ],
    example: { text: 'name,age\nAda,36\n' },
    outputMime: 'application/json',
  },
  'json-to-csv': {
    name: 'json-to-csv',
    summary: 'Writes a JSON array of flat objects as CSV, with a header of every key.',
    input: [
      textField(
        'A JSON array of objects whose values are text, numbers, true, false or null, at most 64 KiB.',
      ),
    ],
    example: { text: '[{"name":"Ada","age":36},{"name":"Alan"}]' },
    outputMime: 'text/plain',
  },
  'markdown-to-text': {
    name: 'markdown-to-text',
    summary: 'Turns Markdown into plain text: link text kept, images and markup removed.',
    input: [textField('The Markdown, at most 64 KiB.')],
    example: { text: '# Title\n\nSome **bold** text and a [link](https://example.com/).' },
    outputMime: 'text/plain',
  },
  'roman-numerals': {
    name: 'roman-numerals',
    summary: 'Converts a number from 1 to 3999 to Roman numerals, or Roman numerals to the number.',
    input: [
      {
        name: 'value',
        type: 'integer',
        required: false,
        description: 'The number to write in Roman numerals (give value or text).',
        min: 1,
        max: 3_999,
      },
      {
        name: 'text',
        type: 'string',
        required: false,
        description: 'Roman numerals in their standard form, such as MMXXVI (give value or text).',
        // The longest standard form, MMMDCCCLXXXVIII (3888), is 15 characters.
        maxBytes: 15,
      },
    ],
    example: { value: 2026 },
    outputMime: 'application/json',
  },
  'number-to-words': {
    name: 'number-to-words',
    summary: 'Writes a whole number in English words.',
    input: [
      {
        name: 'value',
        type: 'integer',
        required: true,
        description: 'A whole number from -999999999999 to 999999999999.',
        min: -999_999_999_999,
        max: 999_999_999_999,
      },
    ],
    example: { value: 1234 },
    outputMime: 'application/json',
  },
  'color-convert': {
    name: 'color-convert',
    summary: 'Converts a color between hex, RGB and HSL.',
    input: [
      {
        name: 'color',
        type: 'string',
        required: true,
        description: 'A color as #rrggbb, #rgb, rgb(r, g, b) or hsl(h, s%, l%).',
        maxBytes: 64,
      },
    ],
    example: { color: '#1e90ff' },
    outputMime: 'application/json',
  },
  'date-diff': {
    name: 'date-diff',
    summary: 'The time between two dates: days, weeks, and calendar years, months and days.',
    input: [
      {
        name: 'from',
        type: 'string',
        required: true,
        description: 'The first date, YYYY-MM-DD (years 1 to 9999).',
        maxBytes: 10,
        pattern: ISO_DATE,
      },
      {
        name: 'to',
        type: 'string',
        required: true,
        description: 'The second date, YYYY-MM-DD (years 1 to 9999).',
        maxBytes: 10,
        pattern: ISO_DATE,
      },
    ],
    example: { from: '2026-01-01', to: '2026-10-15' },
    outputMime: 'application/json',
  },
  'address-checksum': {
    name: 'address-checksum',
    summary: 'Checks the EIP-55 checksum of an address and answers its checksummed form.',
    input: [
      {
        name: 'address',
        type: 'string',
        required: true,
        description: 'An address (0x and 40 hex digits).',
        maxBytes: 42,
        pattern: BASE_ADDRESS,
      },
    ],
    example: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    outputMime: 'application/json',
  },
  'web-meta': {
    name: 'web-meta',
    summary:
      "Reads one public https page's metadata: title, description, canonical, language, Open Graph and Twitter card tags, first headings and word count.",
    input: [pageUrlField('The https page to read.')],
    example: { url: 'https://example.com/' },
    outputMime: 'application/json',
  },
  'web-links': {
    name: 'web-links',
    summary:
      'Lists the links of one public https page: absolute URL, text, rel and whether it stays on the same host, at most 500.',
    input: [
      pageUrlField('The https page to read.'),
      {
        name: 'max_links',
        type: 'integer',
        required: false,
        description: 'Most links to answer (default and most 500).',
        min: 1,
        max: 500,
      },
    ],
    example: { url: 'https://example.com/' },
    outputMime: 'application/json',
  },
  'keyword-density': {
    name: 'keyword-density',
    summary:
      'The most frequent words and two-word phrases of a text, with counts and percentages; English stopwords left out by default.',
    input: [
      textField('The text, at most 64 KiB.'),
      {
        name: 'top',
        type: 'integer',
        required: false,
        description: 'How many words and how many phrases to answer, 1 to 100 (default 20).',
        min: 1,
        max: 100,
      },
      {
        name: 'stopwords',
        type: 'boolean',
        required: false,
        description: 'Whether common English words (the, and, of ...) are left out (default true).',
      },
    ],
    example: { text: 'Fresh coffee beans. Fresh coffee every morning, and coffee beans to go.' },
    outputMime: 'application/json',
  },
  'text-diff': {
    name: 'text-diff',
    summary:
      'Compares two texts line by line: a unified diff and how many lines were added, removed and kept.',
    input: [
      {
        name: 'a',
        type: 'string',
        required: true,
        description: 'The first (old) text, at most 64 KiB.',
        maxBytes: TEXT_MAX_BYTES,
      },
      {
        name: 'b',
        type: 'string',
        required: true,
        description: 'The second (new) text, at most 64 KiB.',
        maxBytes: TEXT_MAX_BYTES,
      },
      {
        name: 'context',
        type: 'integer',
        required: false,
        description: 'Unchanged lines shown around each change, 0 to 10 (default 3).',
        min: 0,
        max: 10,
      },
    ],
    example: { a: 'one\ntwo\nthree\n', b: 'one\n2\nthree\nfour\n' },
    outputMime: 'application/json',
  },
  'json-query': {
    name: 'json-query',
    summary:
      'Picks values out of a JSON document by a path such as items[*].price or a.b[0].c, at most 1000 matches.',
    input: [
      {
        name: 'json',
        type: 'string',
        required: true,
        description: 'The JSON document, at most 64 KiB.',
        maxBytes: TEXT_MAX_BYTES,
      },
      {
        name: 'path',
        type: 'string',
        required: true,
        description:
          'The path: names joined by dots, [n] for an array index, [*] or .* for every item, ["name"] for any key; an optional leading $.',
        maxBytes: JSON_QUERY_PATH_MAX_BYTES,
      },
    ],
    example: { json: '{"items":[{"price":3},{"price":5}]}', path: 'items[*].price' },
    outputMime: 'application/json',
  },
  'json-schema-check': {
    name: 'json-schema-check',
    summary:
      'Checks a JSON document against a JSON Schema (type, properties, required, items, enum, const, minimum, maximum, minLength, maxLength, pattern, additionalProperties).',
    input: [
      {
        name: 'json',
        type: 'string',
        required: true,
        description: 'The JSON document, at most 64 KiB.',
        maxBytes: TEXT_MAX_BYTES,
      },
      {
        name: 'schema',
        type: 'string',
        required: true,
        description: 'The JSON Schema as JSON text, at most 16 KiB.',
        maxBytes: JSON_SCHEMA_MAX_BYTES,
      },
    ],
    example: {
      json: '{"name":"Ada","age":36}',
      schema:
        '{"type":"object","required":["name"],"properties":{"name":{"type":"string"},"age":{"type":"integer","minimum":0}}}',
    },
    outputMime: 'application/json',
  },
  'csv-stats': {
    name: 'csv-stats',
    summary:
      'Per column of a CSV text: its type, values, empty cells and distinct values; for numbers also min, max, mean, median and sum.',
    input: [
      textField('The CSV text, at most 64 KiB.'),
      csvDelimiterField,
      {
        name: 'header',
        type: 'boolean',
        required: false,
        description: 'Whether the first row names the columns (default true).',
      },
    ],
    example: { text: 'name,age\nAda,36\nAlan,41\n' },
    outputMime: 'application/json',
  },
  'base-tx': {
    name: 'base-tx',
    summary:
      'A Base transaction by hash: status, block, time, from, to, gas, value and its ERC-20 transfers.',
    input: [
      {
        name: 'hash',
        type: 'string',
        required: true,
        description: 'The transaction hash (0x and 64 hex digits).',
        maxBytes: 66,
        pattern: TX_HASH,
      },
    ],
    example: { hash: `0x${'ab'.repeat(32)}` },
    outputMime: 'application/json',
  },
  'base-erc20-balance': {
    name: 'base-erc20-balance',
    summary:
      "An address's balance of one ERC-20 token on Base, with the token's decimals and symbol.",
    input: [
      {
        name: 'address',
        type: 'string',
        required: true,
        description: 'The holder: a Base address (0x and 40 hex digits).',
        maxBytes: 42,
        pattern: BASE_ADDRESS,
      },
      {
        name: 'token',
        type: 'string',
        required: true,
        description: "The token's contract address on Base (0x and 40 hex digits).",
        maxBytes: 42,
        pattern: BASE_ADDRESS,
      },
    ],
    example: {
      address: '0x0000000000000000000000000000000000000001',
      token: EXAMPLE_ERC20,
    },
    outputMime: 'application/json',
  },
  'base-gas': {
    name: 'base-gas',
    summary:
      "Base's gas prices now: the latest block's base fee, the next one's, and a priority fee.",
    input: [],
    example: {},
    outputMime: 'application/json',
  },
};

export const isOfferKind = (value: unknown): value is OfferKindName =>
  typeof value === 'string' && (OFFER_KINDS as readonly string[]).includes(value);

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export type OfferInputCheck =
  { ok: true; value: Record<string, OfferInputValue> } | { ok: false; reason: string };

/**
 * One value checked against one input field: null when it fits, else a plain sentence naming the
 * field (never echoing its value). The value is present (neither undefined nor null).
 */
export function checkOfferField(field: OfferInputField, given: unknown): string | null {
  if (field.type === 'boolean') {
    if (typeof given !== 'boolean') return `${field.name} must be true or false.`;
  } else if (field.type === 'string') {
    if (typeof given !== 'string') return `${field.name} must be text.`;
    if (field.maxBytes !== undefined && utf8Bytes(given) > field.maxBytes)
      return `${field.name} is longer than ${field.maxBytes} bytes.`;
    if (field.pattern && !field.pattern.test(given))
      return `${field.name} is not in the expected form.`;
    if (field.values && !field.values.includes(given))
      return `${field.name} must be one of ${field.values.join(', ')}.`;
  } else {
    if (typeof given !== 'number' || !Number.isFinite(given))
      return `${field.name} must be a number.`;
    if (field.type === 'integer' && !Number.isSafeInteger(given))
      return `${field.name} must be a whole number.`;
    if (
      (field.min !== undefined && given < field.min) ||
      (field.max !== undefined && given > field.max)
    )
      return `${field.name} is out of range.`;
  }
  return null;
}

/**
 * A call's input checked against its kind: a JSON object with only the kind's fields, every
 * required one present, each of its type and within its bounds. The answer is the input with only
 * those fields; the reason is a plain sentence naming the field (never echoing its value).
 */
export function checkOfferInput(kind: OfferKindName, input: unknown): OfferInputCheck {
  const spec = OFFER_KIND_SPECS[kind];
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, reason: 'The input must be a JSON object.' };
  const record = input as Record<string, unknown>;
  const known = new Set(spec.input.map((field) => field.name));
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length)
    return {
      ok: false,
      reason: known.size
        ? `This service takes only ${[...known].join(', ')}.`
        : 'This service takes no fields: send an empty object, {}.',
    };
  const value: Record<string, OfferInputValue> = {};
  for (const field of spec.input) {
    const given = record[field.name];
    if (given === undefined || given === null) {
      if (field.required) return { ok: false, reason: `${field.name} is required.` };
      continue;
    }
    const problem = checkOfferField(field, given);
    if (problem) return { ok: false, reason: problem };
    value[field.name] = given as OfferInputValue;
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------
// Presets

/**
 * An offer's preset: some of its kind's input fields with fixed values, e.g. unit-convert
 * {"from": "km", "to": "mi"} or base-erc20-balance {"token": "0x..."}. Every call of the offer runs
 * with these values; the buyer sends the other fields only.
 */
export type OfferPreset = Record<string, OfferInputValue>;

/** The largest preset (canonical JSON, UTF-8 bytes). */
export const OFFER_PRESET_MAX_BYTES = 2_048;

/** A preset as JSON with its keys in the kind's field order (how it is stored and hashed). */
function orderedPreset(kind: OfferKindName, preset: OfferPreset): OfferPreset {
  const out: OfferPreset = {};
  for (const field of OFFER_KIND_SPECS[kind].input)
    if (Object.prototype.hasOwnProperty.call(preset, field.name))
      out[field.name] = preset[field.name]!;
  return out;
}

export type OfferPresetCheck =
  { ok: true; value: OfferPreset | null } | { ok: false; reason: string };

/**
 * A preset checked against its kind's fields: absent, null or {} is no preset (null); otherwise a
 * JSON object of only the kind's fields, each value valid for its field (checkOfferField), at most
 * OFFER_PRESET_MAX_BYTES. The answer has the kind's field order. Whether the kind's own rules
 * accept it with the rest of an input is the server's check (server/feed/offers/store.ts).
 */
export function checkOfferPreset(kind: OfferKindName, preset: unknown): OfferPresetCheck {
  if (preset === undefined || preset === null) return { ok: true, value: null };
  if (typeof preset !== 'object' || Array.isArray(preset))
    return { ok: false, reason: 'preset must be a JSON object of input fields.' };
  const record = preset as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.length) return { ok: true, value: null };
  const fields = new Map(OFFER_KIND_SPECS[kind].input.map((field) => [field.name, field]));
  const value: OfferPreset = {};
  for (const key of keys) {
    const field = fields.get(key);
    if (!field)
      return {
        ok: false,
        reason: fields.size
          ? `preset may only fix ${[...fields.keys()].join(', ')}.`
          : 'This kind has no input fields to fix.',
      };
    const given = record[key];
    if (given === undefined || given === null)
      return { ok: false, reason: `preset ${key} must have a value.` };
    const problem = checkOfferField(field, given);
    if (problem) return { ok: false, reason: `preset ${problem}` };
    value[key] = given as OfferInputValue;
  }
  const ordered = orderedPreset(kind, value);
  if (utf8Bytes(JSON.stringify(ordered)) > OFFER_PRESET_MAX_BYTES)
    return { ok: false, reason: `preset is larger than ${OFFER_PRESET_MAX_BYTES} bytes.` };
  return { ok: true, value: ordered };
}

/**
 * A buyer's input with the offer's preset merged in: the preset's values win, and a buyer value for
 * a preset field is refused unless it is the same value. An input that is not a JSON object is
 * answered as it is (checkOfferInput refuses it). No preset: the input as it is.
 */
export function mergeOfferPreset(
  preset: OfferPreset | null,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!preset) return { ok: true, value: input };
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return { ok: true, value: input };
  const record = input as Record<string, unknown>;
  for (const [name, fixed] of Object.entries(preset)) {
    const given = Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
    if (given !== undefined && given !== null && given !== fixed)
      return {
        ok: false,
        reason: `${name} is fixed by this service to ${JSON.stringify(fixed)}: leave it out.`,
      };
  }
  return { ok: true, value: { ...record, ...preset } };
}

/**
 * A kind's input as the Feed shows a service's input schema (a JSON body; method POST). With a
 * preset, its fields are left out of the fields and the example, and listed as `fixed`.
 */
export function offerInputSummary(
  kind: OfferKindName,
  preset: OfferPreset | null = null,
): FeedSchemaSummary {
  const spec = OFFER_KIND_SPECS[kind];
  const isFixed = (name: string) =>
    preset !== null && Object.prototype.hasOwnProperty.call(preset, name);
  const fields: FeedField[] = spec.input
    .filter((field) => !isFixed(field.name))
    .map((field) => ({
      name: field.name,
      in: 'body',
      type: field.type,
      required: field.required,
      description: field.description,
    }));
  const example = Object.fromEntries(
    Object.entries(spec.example).filter(([name]) => !isFixed(name)),
  );
  return {
    format: 'json',
    fields,
    more: 0,
    example: JSON.stringify(example),
    exampleState: 'whole',
    ...(preset ? { fixed: Object.entries(preset).map(([name, value]) => ({ name, value })) } : {}),
  };
}

/** A kind's answer as the Feed shows a service's output: its format only. */
export function offerOutputSummary(kind: OfferKindName): FeedSchemaSummary {
  return {
    format: OFFER_KIND_SPECS[kind].outputMime === 'application/json' ? 'json' : 'text',
    fields: [],
    more: 0,
    example: null,
    exampleState: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Writing offers (planOffers and publishOffers in server/feed/offers/store.ts)

/** One offer as a plan or a publish takes it. Absent optional fields take their defaults. */
export interface OfferInput {
  /** The caller's own name for the offer (OFFER_KEY): the same key updates the same offer. */
  key: string;
  /** The selling agent: one of the workspace's agents, with a ready wallet on Base. */
  agentId: string;
  kind: OfferKindName;
  title: string;
  /** Default ''. */
  description?: string;
  /** Default none. */
  tags?: string[];
  /** USDC base units as an integer string, FEE_ROUTER_MIN_INCLUDED to FEE_ROUTER_MAX_TOTAL. */
  priceRaw: string;
  /** Declared to x402 discovery lists when the offer's endpoint answers. Default true. */
  discoverable?: boolean;
  /** Default 'active'. */
  state?: OfferState;
  /** Input fields every call runs with (checkOfferPreset). Default none (null). */
  preset?: OfferPreset | null;
}

/** Why one offer of a batch cannot be written. */
export const OFFER_REFUSALS = [
  'invalid_key',
  'duplicate_key',
  'invalid_kind',
  'kind_unavailable',
  'invalid_title',
  'invalid_description',
  'invalid_tags',
  'invalid_price',
  'invalid_state',
  'invalid_field',
  'agent_not_found',
  'agent_not_allowed',
  'agent_paused',
  'workspace_paused',
  'wallet_not_ready',
  'agent_changed',
  'kind_changed',
  'price_change_too_soon',
  'agent_offer_cap',
  'workspace_offer_cap',
  'write_rate',
  'offer_not_found',
  'duplicate_offer',
  'invalid_preset',
] as const;
export type OfferRefusalReason = (typeof OFFER_REFUSALS)[number];

export interface OfferRefusal {
  /** The offer's position in the batch; null for a refusal of the whole batch. */
  index: number | null;
  key: string | null;
  reason: OfferRefusalReason;
  message: string;
}

/** What publishing does to one offer: create it, change it, or nothing (it is already so). */
export type OfferAction = 'create' | 'update' | 'unchanged';

export interface OfferPlanItem {
  key: string;
  /** null for an offer this plan creates (its id is drawn when it is published). */
  offerId: string | null;
  action: OfferAction;
  agentId: string;
  payTo: string;
  kind: OfferKindName;
  title: string;
  description: string;
  tags: string[];
  priceRaw: string;
  discoverable: boolean;
  state: OfferState;
  /** The fixed input fields (null: none). */
  preset: OfferPreset | null;
  /** The offer's version after publishing (1 for a new one). */
  version: number;
  /** Shown in the Feed after publishing; false while paused, removed, held or risky. */
  listed: boolean;
}

export interface OfferPlan {
  /** False: refused (see refusals); nothing can be published from it. */
  ok: boolean;
  /** sha256 hex over the canonical plan; publish with it as expectedHash. null when refused. */
  hash: string | null;
  items: OfferPlanItem[];
  refusals: OfferRefusal[];
  /** Offers the publish would create or change. */
  writes: number;
}

export interface OfferPublishResult {
  /** True: this idempotency key was published before, and this is that answer; nothing changed. */
  replay: boolean;
  hash: string;
  offers: Array<{
    key: string;
    offerId: string;
    action: OfferAction;
    version: number;
    listed: boolean;
  }>;
  writes: number;
}

/**
 * One change to an offer that exists (city_service_update, city_service_pause): the fields given
 * replace the offer's; the rest stay. The offer keeps its key, agent, kind and wallet.
 */
export interface OfferChange {
  offerId: string;
  title?: string;
  description?: string;
  tags?: string[];
  /** USDC base units as an integer string, FEE_ROUTER_MIN_INCLUDED to FEE_ROUTER_MAX_TOTAL. */
  priceRaw?: string;
  discoverable?: boolean;
  /** 'removed' is final: the offer is withdrawn for good and its key can be used again. */
  state?: OfferState;
  /** The fixed input fields; null (or {}) removes the preset. */
  preset?: OfferPreset | null;
}

/** Why an offer that exists is not shown in the Feed (null while it is). */
export const OFFER_NOT_LISTED = [
  /** Paused by its owner. */
  'paused',
  /** Removed for good. */
  'removed',
  /** Its agent or its workspace is paused. */
  'held',
  /** A Feed risk rule matches its text. */
  'risk_rule',
  /** Hidden by the Feed's operator. */
  'hidden',
] as const;
export type OfferNotListed = (typeof OFFER_NOT_LISTED)[number];

/** One of the workspace's offers as its owner reads it (city_service_mine). */
export interface OwnOffer {
  offerId: string;
  key: string;
  agentId: string;
  payTo: string;
  kind: OfferKindName;
  title: string;
  description: string;
  tags: string[];
  priceRaw: string;
  discoverable: boolean;
  state: OfferState;
  /** The fixed input fields (null: none). */
  preset: OfferPreset | null;
  version: number;
  /** Its Feed service id (svc_...): what buyers search for and call. */
  serviceId: string;
  listed: boolean;
  notListed: OfferNotListed | null;
  createdAt: number;
  updatedAt: number;
}

export interface OwnOfferPage {
  offers: OwnOffer[];
  /** Pass as cursor for the next page; null on the last one. */
  next: string | null;
}

/**
 * What a fee-included price splits into, as CentralCityFeeRouter.feeFor computes it (gross * 1000
 * / 10000, rounded down): the protocol fee, and what the seller's wallet receives.
 */
export function offerPriceSplit(priceRaw: string): { feeRaw: string; sellerRaw: string } {
  const gross = BigInt(priceRaw);
  const fee = (gross * 1_000n) / 10_000n;
  return { feeRaw: fee.toString(), sellerRaw: (gross - fee).toString() };
}
