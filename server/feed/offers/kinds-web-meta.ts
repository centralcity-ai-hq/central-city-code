/*
 * web-meta and web-links: one public https page read live, exactly as web-read reads it (the same
 * safe fetcher, URL rules, deadline, byte cap, redirects and failures: fetchPage and pageUrlInput
 * in kinds-web.ts), but only an HTML page (text/html; anything else is
 * 'unsupported_content_type', 422), and answered as JSON about the page instead of its text.
 *
 *   - web-meta: the page's URL before and after redirects, its status, <title>, meta description,
 *     canonical link, <html lang>, the Open Graph (og:*) and Twitter card (twitter:*) tags, the
 *     text of its first WEB_META_LIMITS.headings <h1> headings and the words of its visible text
 *     (counted as text-stats counts them). Every text is entity-decoded, whitespace-collapsed and
 *     cut to its own small cap; a tag the page does not have is null.
 *   - web-links: the page's <a href> links in document order, each resolved against the page's
 *     final URL (or its <base href>), with its text (at most 200 characters), its rel and whether
 *     it stays on the page's own host. Only http and https links are listed (mailto:, tel:,
 *     javascript: and fragments of the same page are counted as skipped); each URL once (its first
 *     text kept); at most `max_links` (default and most 500), never more than fits in 64 KiB; the
 *     counts say how many there were in all.
 *
 * The page is read by one forward scan (scanPage): tag ends are found as html-text.ts finds them
 * (tagEnd, linear), attributes by a pattern whose runs are separated by fixed characters, and the
 * contents of script, style, textarea, template, noscript and xmp elements are skipped whole. A
 * link's or heading's text is read from at most 4 KiB of its markup. The scan keeps at most
 * PAGE_SCAN_LIMITS of each thing, so a hostile page costs at most one linear pass of 1 MiB.
 *
 * As for web-read, check() holds the URL's static rules (before payment); run() starts after
 * payment, and everything there that fails is OfferKindFailure (the paid call's outcome).
 */
import { OFFER_KIND_SPECS } from '../../../shared/feed-offers.js';
import { decodeEntities, collapseWhitespace, htmlToText, tagEnd } from './html-text.js';
import { jsonAnswer, OFFER_ANSWER_MAX_BYTES, type OfferKind } from './kind-core.js';
import { countWords } from './kinds-text.js';
import { decodePage, fetchPage, pageUrlInput } from './kinds-web.js';

export const WEB_META_CONTENT_TYPES = ['text/html'] as const;

export const WEB_META_LIMITS = {
  /** The first <h1> headings answered. */
  headings: 5,
  /**
   * The longest heading, title, description or tag value answered (characters). With the URLs,
   * 18 such texts of at most 4 bytes per character keep the answer well under 64 KiB.
   */
  maxTextChars: 500,
  /** The longest URL answered (characters); a longer one is left out. */
  maxUrlChars: 2_048,
} as const;

export const WEB_LINKS_LIMITS = {
  /** The default and the most links answered (OFFER_KIND_SPECS['web-links'].max_links). */
  maxLinks: 500,
  /** The longest link text answered (characters). */
  maxTextChars: 200,
} as const;

export const PAGE_SCAN_LIMITS = {
  /** <a href> tags read; the rest of the page's links are not read. */
  anchors: 5_000,
  /** <meta> tags read. */
  metas: 500,
  /** The markup of one link or heading read for its text. */
  innerChars: 4_096,
  /** The attribute text of one tag read. */
  attributeChars: 8_192,
} as const;

/** Elements whose content is not markup: skipped whole. */
const RAW = new Set(['script', 'style', 'textarea', 'template', 'noscript', 'xmp']);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
/** One attribute: a name, then optionally = and a quoted or bare value. */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A tag's attributes, names in lower case, values entity-decoded; the first of a name wins. */
export function parseAttributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  const source = text.slice(0, PAGE_SCAN_LIMITS.attributeChars);
  for (let match = ATTRIBUTE.exec(source); match; match = ATTRIBUTE.exec(source)) {
    const name = match[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return out;
}

export interface ScannedPage {
  title: string | null;
  lang: string | null;
  base: string | null;
  canonical: string | null;
  /** Meta tags: (name or property, lower case) to content, the first of each. */
  metas: Map<string, string>;
  headings: string[];
  anchors: Array<{ href: string; rel: string | null; text: string }>;
}

/** The text of a piece of markup, collapsed and cut to `max` characters (code points). */
function innerText(html: string, max: number): string {
  const text = htmlToText(html.slice(0, PAGE_SCAN_LIMITS.innerChars)).text;
  return cutChars(text, max);
}

const cutChars = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
};

/** One forward pass over a page (see the module header). */
export function scanPage(html: string, options: { headings: number }): ScannedPage {
  const page: ScannedPage = {
    title: null,
    lang: null,
    base: null,
    canonical: null,
    metas: new Map(),
    headings: [],
    anchors: [],
  };
  let metas = 0;
  /** An open <a href> or <h1>: where its content starts. */
  let anchor: { href: string; rel: string | null; start: number } | null = null;
  let heading: number | null = null;
  const closeAnchor = (end: number) => {
    if (!anchor) return;
    page.anchors.push({
      href: anchor.href,
      rel: anchor.rel,
      text: innerText(html.slice(anchor.start, end), WEB_LINKS_LIMITS.maxTextChars),
    });
    anchor = null;
  };
  const closeHeading = (end: number) => {
    if (heading === null) return;
    const text = innerText(html.slice(heading, end), WEB_META_LIMITS.maxTextChars);
    if (text) page.headings.push(text);
    heading = null;
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    TAG.lastIndex = lt;
    const tag = TAG.exec(html);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2]!.toLowerCase();
    const gt = tagEnd(html, lt + tag[0].length);
    if (gt < 0) break;
    i = gt + 1;
    if (closing) {
      if (name === 'a') closeAnchor(lt);
      else if (name === 'h1') closeHeading(lt);
      continue;
    }
    const selfClosed = html[gt - 1] === '/';
    const attributes = () => parseAttributes(html.slice(lt + tag[0].length, gt));
    if (RAW.has(name) || name === 'title') {
      if (selfClosed) continue;
      // The content runs to the first closing tag of the same name (a linear search forward).
      const close = findClose(html, name, i);
      if (name === 'title' && page.title === null)
        page.title = cutChars(
          collapseWhitespace(decodeEntities(html.slice(i, close < 0 ? n : close))),
          WEB_META_LIMITS.maxTextChars,
        );
      if (close < 0) break;
      const end = html.indexOf('>', close);
      i = end < 0 ? n : end + 1;
      continue;
    }
    switch (name) {
      case 'html':
        if (page.lang === null) page.lang = attributes().get('lang')?.trim().slice(0, 35) || null;
        break;
      case 'base':
        if (page.base === null) page.base = attributes().get('href')?.trim() || null;
        break;
      case 'link': {
        const attrs = attributes();
        const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
        if (page.canonical === null && rel.includes('canonical'))
          page.canonical = attrs.get('href')?.trim() || null;
        break;
      }
      case 'meta': {
        if (metas >= PAGE_SCAN_LIMITS.metas) break;
        metas++;
        const attrs = attributes();
        const key = (attrs.get('property') ?? attrs.get('name') ?? '').trim().toLowerCase();
        const content = attrs.get('content');
        if (key && content !== undefined && !page.metas.has(key))
          page.metas.set(key, cutChars(collapseWhitespace(content), WEB_META_LIMITS.maxTextChars));
        break;
      }
      case 'a': {
        // An <a> inside another closes the first, as HTML parsers do.
        closeAnchor(lt);
        if (page.anchors.length >= PAGE_SCAN_LIMITS.anchors) break;
        const attrs = attributes();
        const href = attrs.get('href');
        if (href !== undefined)
          anchor = { href: href.trim(), rel: attrs.get('rel')?.trim() || null, start: i };
        break;
      }
      case 'h1':
        closeHeading(lt);
        if (page.headings.length < options.headings) heading = i;
        break;
    }
  }
  closeAnchor(n);
  closeHeading(n);
  page.headings = page.headings.slice(0, options.headings);
  return page;
}

/** One closing-tag pattern per element name (only the fixed names of RAW and title). */
const CLOSERS = new Map<string, RegExp>();
function findClose(html: string, name: string, from: number): number {
  let close = CLOSERS.get(name);
  if (!close) CLOSERS.set(name, (close = new RegExp(`</${name}(?=[\\s/>]|$)`, 'gi')));
  close.lastIndex = from;
  return close.exec(html)?.index ?? -1;
}

/** An absolute http(s) URL of `href` against `base`, without its fragment; null otherwise. */
export function absoluteUrl(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  const text = url.toString();
  return text.length > WEB_META_LIMITS.maxUrlChars ? null : text;
}

/** The URL relative links of a page resolve against: its <base href> when valid, else its URL. */
function pageBase(page: ScannedPage, finalUrl: string): string {
  if (page.base) {
    const base = absoluteUrl(page.base, finalUrl);
    if (base) return base;
  }
  return finalUrl;
}

export const webMetaKind: OfferKind = {
  name: 'web-meta',
  inputSchema: OFFER_KIND_SPECS['web-meta'].input,
  outputMime: OFFER_KIND_SPECS['web-meta'].outputMime,
  check(input) {
    pageUrlInput('web-meta', input);
  },
  async run(input, ctx) {
    const { url } = pageUrlInput('web-meta', input);
    const response = await fetchPage(url, WEB_META_CONTENT_TYPES, ctx);
    const html = decodePage(response);
    const page = scanPage(html, { headings: WEB_META_LIMITS.headings });
    const meta = (key: string) => page.metas.get(key) ?? null;
    const base = pageBase(page, response.url);
    const words = countWords(htmlToText(html).text);
    ctx.signal.throwIfAborted();
    return jsonAnswer({
      url,
      final_url: response.url,
      status: response.status,
      title: page.title || null,
      description: meta('description'),
      canonical: page.canonical ? absoluteUrl(page.canonical, base) : null,
      lang: page.lang,
      og: {
        title: meta('og:title'),
        description: meta('og:description'),
        image: meta('og:image'),
        type: meta('og:type'),
        site_name: meta('og:site_name'),
      },
      twitter: {
        card: meta('twitter:card'),
        title: meta('twitter:title'),
        description: meta('twitter:description'),
        image: meta('twitter:image'),
        site: meta('twitter:site'),
        creator: meta('twitter:creator'),
      },
      h1: page.headings,
      word_count: words,
    });
  },
};

export interface PageLink {
  href: string;
  text: string;
  rel: string | null;
  internal: boolean;
}

/**
 * The links of a scanned page (see the module header): http(s) only, each URL once, at most
 * `max` and at most what fits in the answer next to its counts.
 */
export function pageLinks(page: ScannedPage, finalUrl: string, max: number) {
  const base = pageBase(page, finalUrl);
  const host = new URL(finalUrl).host;
  const pageWithoutHash = absoluteUrl(finalUrl, finalUrl);
  const seen = new Set<string>();
  const links: PageLink[] = [];
  let skipped = 0;
  let internal = 0;
  let truncated = false;
  // Room for the counts and the URLs around the list.
  let size = 512 + 2 * WEB_META_LIMITS.maxUrlChars;
  for (const anchor of page.anchors) {
    const href = absoluteUrl(anchor.href, base);
    // Not http(s), or only a fragment of this same page.
    if (!href || (anchor.href.startsWith('#') && href === pageWithoutHash)) {
      skipped++;
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    const link: PageLink = {
      href,
      text: cutChars(anchor.text, WEB_LINKS_LIMITS.maxTextChars),
      rel: anchor.rel ? anchor.rel.slice(0, 100) : null,
      internal: new URL(href).host === host,
    };
    if (link.internal) internal++;
    if (truncated) continue;
    const bytes = Buffer.byteLength(JSON.stringify(link), 'utf8') + 1;
    if (links.length >= max || size + bytes > OFFER_ANSWER_MAX_BYTES) {
      truncated = true;
      continue;
    }
    size += bytes;
    links.push(link);
  }
  return {
    total: seen.size,
    internal,
    external: seen.size - internal,
    skipped,
    truncated,
    links,
  };
}

export const webLinksKind: OfferKind = {
  name: 'web-links',
  inputSchema: OFFER_KIND_SPECS['web-links'].input,
  outputMime: OFFER_KIND_SPECS['web-links'].outputMime,
  check(input) {
    pageUrlInput('web-links', input);
  },
  async run(input, ctx) {
    const { url, value } = pageUrlInput('web-links', input);
    const max = value.max_links === undefined ? WEB_LINKS_LIMITS.maxLinks : Number(value.max_links);
    const response = await fetchPage(url, WEB_META_CONTENT_TYPES, ctx);
    const page = scanPage(decodePage(response), { headings: 0 });
    const result = pageLinks(page, response.url, max);
    ctx.signal.throwIfAborted();
    return jsonAnswer({ url, final_url: response.url, ...result });
  },
};
