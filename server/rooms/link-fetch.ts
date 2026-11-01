import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * Server-side web page fetch for room link snapshots (docs/ROOMS.md "Saved web pages"). One
 * shared readable copy per link, fetched by the server, never by a search provider.
 *
 * SSRF guard: http/https on ports 80/443 only; every host is resolved and every address must be
 * public (no private, loopback, link-local incl. cloud metadata, CGNAT, multicast, reserved,
 * IPv6 ULA/link-local, IPv4-mapped/NAT64/6to4/Teredo forms); the connection is pinned to the
 * checked address; each redirect (at most 5) is checked again. GET only, no cookies, no auth,
 * 10 s for the whole fetch, at most 5 MB of (decoded) body.
 */
export const LINK_LIMITS = {
  maxRedirects: 5,
  timeMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
} as const;
export const LINK_USER_AGENT = 'CentralCityRooms/1.0 (+https://centralcity.ai)';

export class LinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** False for an upstream answer that a retry will not change (HTTP 4xx). */
    readonly retryable?: boolean,
  ) {
    super(message);
  }
}

const blocked4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked4.addSubnet(net, bits, 'ipv4');
/** IPv6 must be global unicast (2000::/3) and outside these. */
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['3fff::', 20], // documentation (RFC 9637)
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['64:ff9b::', 96], // NAT64 (outside 2000::/3 anyway)
] as const)
  blocked6.addSubnet(net, bits, 'ipv6');

/** True only for a public unicast address an outside fetch may reach. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // IPv4-mapped / compatible forms (::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d) are refused outright.
  if (lower.startsWith('::') || lower.includes('::ffff:') || lower.includes('.')) return false;
  return global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type LinkResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface LinkResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Closes the connection early (body too large, aborted). */
  destroy(): void;
}
/** One GET to a URL over a connection pinned to `address` (no redirects followed). */
export type LinkTransport = (request: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<LinkResponse>;

export interface LinkFetchOptions {
  resolve?: LinkResolver;
  transport?: LinkTransport;
  timeMs?: number;
  maxBytes?: number;
}
export interface FetchedLink {
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
}

const defaultResolve: LinkResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

const defaultTransport: LinkTransport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers,
        signal,
        agent: false,
        // The connection goes to the checked address only; TLS still verifies the host name.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts?.all
            ? cb(null, [{ address: address.address, family: address.family }])
            : cb(null, address.address, address.family)) as never,
      },
      (res) => {
        const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
        let body: Readable = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') body = res.pipe(createGunzip());
        else if (encoding === 'deflate') body = res.pipe(createInflate());
        else if (encoding === 'br') body = res.pipe(createBrotliDecompress());
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers))
          flat[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          body,
          destroy: () => {
            res.destroy();
            body.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

/** Parses and checks a URL: http/https, ports 80/443, no credentials in it. */
export function checkLinkUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    // A bare domain ("example.com/page", as AIs often write one) is read as https; every
    // address check below still applies. Never for a redirect (it has a base).
    const bare = raw.trim();
    if (base || !/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(bare))
      throw new LinkError(400, 'link_invalid_url', 'That is not a valid http or https URL.');
    url = new URL(`https://${bare}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new LinkError(400, 'link_invalid_url', 'Only http and https links can be saved.');
  if (url.port !== '' && url.port !== '80' && url.port !== '443')
    throw new LinkError(400, 'link_blocked', 'Only ports 80 and 443 can be fetched.');
  if (url.username || url.password)
    throw new LinkError(400, 'link_invalid_url', 'Links with a user name or password are refused.');
  url.hash = '';
  return url;
}

async function pinnedAddress(url: URL, resolve: LinkResolver): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new LinkError(502, 'link_fetch_failed', 'The link host could not be resolved.');
    }
  }
  if (!addresses.length)
    throw new LinkError(502, 'link_fetch_failed', 'The link host could not be resolved.');
  // Every address must be public: a host that resolves to any private one is refused.
  if (!addresses.every((a) => isPublicAddress(a.address)))
    throw new LinkError(403, 'link_blocked', 'That link points to a private or reserved address.');
  return addresses[0]!;
}

/** Fetches a link under the guard; the body is at most maxBytes. */
export async function fetchLink(raw: string, options: LinkFetchOptions = {}): Promise<FetchedLink> {
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? defaultTransport;
  const maxBytes = options.maxBytes ?? LINK_LIMITS.maxBytes;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeMs ?? LINK_LIMITS.timeMs);
  const timeout = new Promise<never>((_, reject) =>
    controller.signal.addEventListener('abort', () =>
      reject(new LinkError(504, 'link_timeout', 'The page did not load within 10 seconds.')),
    ),
  );
  timeout.catch(() => undefined);
  const run = async (): Promise<FetchedLink> => {
    let url = checkLinkUrl(raw);
    for (let hop = 0; ; hop++) {
      const address = await pinnedAddress(url, resolve);
      const res = await transport({
        url,
        address,
        signal: controller.signal,
        headers: {
          'user-agent': LINK_USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.destroy();
        if (hop >= LINK_LIMITS.maxRedirects)
          throw new LinkError(
            502,
            'link_too_many_redirects',
            'The link redirects more than 5 times.',
          );
        url = checkLinkUrl(res.headers.location, url);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.destroy();
        // The URL needs a change (not our failure, no retry): 400, not a 5xx a client would retry.
        if (res.status >= 400 && res.status < 500)
          throw new LinkError(
            400,
            'link_fetch_failed',
            `The page answered HTTP ${res.status}; check the URL.`,
            false,
          );
        throw new LinkError(502, 'link_fetch_failed', `The page answered HTTP ${res.status}.`);
      }
      const declared = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        throw new LinkError(413, 'link_too_large', 'The page is larger than 5 MB.');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          res.destroy();
          throw new LinkError(413, 'link_too_large', 'The page is larger than 5 MB.');
        }
        chunks.push(chunk);
      }
      return {
        finalUrl: url.toString(),
        contentType: String(res.headers['content-type'] ?? '').toLowerCase(),
        body: Buffer.concat(chunks),
      };
    }
  };
  try {
    return await Promise.race([run(), timeout]);
  } catch (error) {
    if (error instanceof LinkError) throw error;
    if (timedOut)
      throw new LinkError(504, 'link_timeout', 'The page did not load within 10 seconds.');
    throw new LinkError(502, 'link_fetch_failed', 'The page could not be fetched.');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
};
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** HTML past this many characters is cut before parsing (the body cap is 5 MB of bytes). */
export const HTML_PARSE_CHARS = 2 * 1024 * 1024;
/** Elements whose whole content is dropped. */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'object',
  'canvas',
  'select',
  'button',
  'head',
  'title',
]);
/** Tags that end a line of text. */
const BLOCK_TAGS = new Set([
  'br',
  'hr',
  'p',
  'div',
  'section',
  'article',
  'main',
  'li',
  'ul',
  'ol',
  'tr',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'dd',
  'dt',
  'dl',
  'figure',
  'figcaption',
]);

function isNameChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}

/** Removes tags from a short run of text in one pass ('<' with no '>' drops the rest). */
function stripTags(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) return out + text.slice(pos);
    out += text.slice(pos, lt);
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) return out;
    pos = gt + 1;
  }
}

/** The first <title> element's text, found with indexOf only. */
function titleOf(html: string, lower: string): string {
  let at = 0;
  for (;;) {
    at = lower.indexOf('<title', at);
    if (at < 0) return '';
    const next = lower.charCodeAt(at + 6);
    if (next === 62 || next === 32 || next === 9 || next === 10 || next === 13 || next === 47)
      break;
    at += 6;
  }
  const open = html.indexOf('>', at);
  if (open < 0) return '';
  const close = lower.indexOf('</title', open + 1);
  const raw = html.slice(open + 1, close < 0 ? Math.min(html.length, open + 1 + 4096) : close);
  return decodeEntities(stripTags(raw)).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

/**
 * Title and readable text of an HTML page: one linear pass with indexOf, no backtracking regex
 * (nothing is executed or fetched). Skipped elements jump to their closing tag or drop the rest;
 * an unclosed comment or tag drops the rest.
 */
export function htmlToText(input: string): { title: string; text: string } {
  const html = input.length > HTML_PARSE_CHARS ? input.slice(0, HTML_PARSE_CHARS) : input;
  const lower = html.toLowerCase();
  const out: string[] = [];
  const title = titleOf(html, lower);
  let pos = 0;
  const n = html.length;
  while (pos < n) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) {
      out.push(html.slice(pos));
      break;
    }
    if (lt > pos) out.push(html.slice(pos, lt));
    if (lower.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close < 0) break;
      out.push(' ');
      pos = close + 3;
      continue;
    }
    let i = lt + 1;
    const closing = html.charCodeAt(i) === 47; // '/'
    if (closing) i++;
    const nameStart = i;
    while (i < n && isNameChar(lower.charCodeAt(i))) i++;
    const name = lower.slice(nameStart, i);
    if (!name) {
      // '<' not starting a tag ('a < b', '<!doctype', '</ >'): a declaration is skipped, a bare
      // '<' is text.
      const c = html.charCodeAt(nameStart);
      if (c === 33 || c === 63 || closing) {
        const gt = html.indexOf('>', nameStart);
        if (gt < 0) break;
        pos = gt + 1;
      } else {
        out.push('<');
        pos = lt + 1;
      }
      continue;
    }
    const gt = html.indexOf('>', i);
    if (gt < 0) break;
    pos = gt + 1;
    if (!closing && SKIP_TAGS.has(name)) {
      const end = lower.indexOf(`</${name}`, pos);
      if (end < 0) break;
      const endGt = html.indexOf('>', end);
      if (endGt < 0) break;
      out.push(' ');
      pos = endGt + 1;
      continue;
    }
    if (BLOCK_TAGS.has(name)) out.push('\n');
    else if (closing && (name === 'td' || name === 'th')) out.push('\t');
    else out.push(' ');
  }
  const text = decodeEntities(out.join(''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/** Decodes body bytes with the declared charset (UTF-8 when unknown). */
export function decodeBody(body: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w.-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export const LINK_PAGE_BYTES = 16 * 1024;
/** Splits text into pages of about 16 KB, at line breaks where it can. */
export function splitPages(text: string, pageBytes = LINK_PAGE_BYTES): string[] {
  const pages: string[] = [];
  let rest = text;
  while (rest.length) {
    if (Buffer.byteLength(rest) <= pageBytes) {
      pages.push(rest);
      break;
    }
    // Largest prefix within the byte budget (characters are at most 4 bytes).
    let cut = Math.min(rest.length, pageBytes);
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut)) > pageBytes)
      cut = Math.floor(cut * 0.9);
    const newline = rest.lastIndexOf('\n', cut);
    if (newline > cut / 2) cut = newline + 1;
    else if (/[\ud800-\udbff]/.test(rest[cut - 1] ?? '')) cut--;
    pages.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return pages.length ? pages : [''];
}
