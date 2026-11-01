/*
 * Visible text of an HTML (or XML) page for web-read: one linear pass, no regular expression that
 * can backtrack over the whole page. Scripts, styles, templates, SVG, comments and the like are
 * dropped, and so are HTML elements a person never sees (hidden, aria-hidden or an inline style
 * that hides them) and invisible format characters; the first <title> is kept apart; entities are
 * decoded; whitespace is collapsed. A '>' inside a quoted attribute value does not end its tag.
 * The walk can stop once it has more text than the caller sends.
 */

/** Elements whose content is never visible text. */
const HIDDEN = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'canvas',
]);
/** Elements that separate words (a line break or a block). Inline tags join their text. */
const BREAKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'option',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

/** HTML's Latin-1 named references, U+00A0 to U+00FF in order. */
const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn ' +
  'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave ' +
  'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN ' +
  'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute ' +
  'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
  'yacute thorn yuml'
)
  .split(' ')
  .map((name, index): [string, string] => [name, String.fromCharCode(0xa0 + index)]);

const NAMED = new Map<string, string>([
  ...LATIN1,
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['copy', '\u00a9'],
  ['reg', '\u00ae'],
  ['trade', '\u2122'],
  ['hellip', '\u2026'],
  ['mdash', '\u2014'],
  ['ndash', '\u2013'],
  ['lsquo', '\u2018'],
  ['rsquo', '\u2019'],
  ['sbquo', '\u201a'],
  ['ldquo', '\u201c'],
  ['rdquo', '\u201d'],
  ['bdquo', '\u201e'],
  ['laquo', '\u00ab'],
  ['raquo', '\u00bb'],
  ['middot', '\u00b7'],
  ['bull', '\u2022'],
  ['deg', '\u00b0'],
  ['times', '\u00d7'],
  ['divide', '\u00f7'],
  ['euro', '\u20ac'],
  ['pound', '\u00a3'],
  ['yen', '\u00a5'],
  ['cent', '\u00a2'],
  ['sect', '\u00a7'],
  ['para', '\u00b6'],
  ['shy', ''],
  ['zwj', '\u200d'],
  ['zwnj', '\u200c'],
]);
/** The named references HTML also accepts in capitals. */
const UPPER = new Set(['AMP', 'LT', 'GT', 'QUOT']);

/**
 * Numeric references 0x80-0x9F mean windows-1252 characters in HTML (&#150; is an en dash, not a
 * C1 control); the five unassigned ones stay controls.
 */
const WINDOWS_1252 = new Map<number, number>([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

/** Decodes numeric and common named character references; unknown ones stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g,
    (whole, ref: string) => {
      if (ref.startsWith('#')) {
        const code =
          ref[1] === 'x' || ref[1] === 'X'
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        // NUL, surrogates and anything past Unicode read as the replacement character.
        if (
          !Number.isFinite(code) ||
          code === 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          return '\ufffd';
        return String.fromCodePoint(WINDOWS_1252.get(code) ?? code);
      }
      return NAMED.get(UPPER.has(ref) ? ref.toLowerCase() : ref) ?? whole;
    },
  );
}

/**
 * Characters that are neither visible nor whitespace: C0/C1 controls other than whitespace, format
 * characters and every default-ignorable code point (zero-width spaces and joiners, tags), as the
 * Feed's own text policy drops them.
 */
const CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Collapses every whitespace run to one space and trims; drops invisible characters. */
export function collapseWhitespace(text: string): string {
  return text.replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
}

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a character. */
export function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  // A continuation byte (10xxxxxx) at the cut belongs to a character that does not fit.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;

/** Elements that have no content, so a hidden one hides nothing past its own tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * The attributes of a tag (names lowercased, the last of a repeated name wins), read from the
 * text between its name and its '>'. Linear, quoted values skipped whole as in tagEnd.
 */
function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(text.charCodeAt(i)) || text[i] === '/')) i++;
    const start = i;
    while (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== '=' && text[i] !== '/') i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = text.slice(start, i).toLowerCase();
    while (i < n && isSpace(text.charCodeAt(i))) i++;
    let value = '';
    if (text[i] === '=') {
      i++;
      while (i < n && isSpace(text.charCodeAt(i))) i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        value = text.slice(i + 1, close < 0 ? n : close);
        i = close < 0 ? n : close + 1;
      } else {
        const begin = i;
        while (i < n && !isSpace(text.charCodeAt(i))) i++;
        value = text.slice(begin, i);
      }
    }
    out.set(name, decodeEntities(value));
  }
  return out;
}

/** An inline style declaration that hides its element's text from a person reading the page. */
const HIDING_STYLE = /^(?:display:none|visibility:hidden)(?:!important)?$/;

/**
 * Whether a person never sees this element's text: the hidden attribute, aria-hidden="true", or an
 * inline style of display:none or visibility:hidden.
 */
function concealed(attrs: string): boolean {
  if (!/hidden|style/i.test(attrs)) return false;
  const read = attributes(attrs);
  if (read.has('hidden')) return true;
  if (read.get('aria-hidden')?.trim().toLowerCase() === 'true') return true;
  const style = read.get('style');
  if (!style) return false;
  return style
    .toLowerCase()
    .replace(/\s+/g, '')
    .split(';')
    .some((declaration) => HIDING_STYLE.test(declaration));
}

/** A paragraph ends at the start of any of these (HTML's implied end of a <p>). */
const ENDS_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
/** Elements a phrase is made of: their end tags never end a <p>; any other end tag does. */
const PHRASING = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);
const set = (...names: string[]) => new Set(names);
const TABLE_ENDS = set('table', 'tbody', 'thead', 'tfoot');
/**
 * Elements whose end tag HTML lets a page leave out: the start tags (`starts`) and end tags
 * (`ends`, the parent's) that end one implicitly.
 */
const OPTIONAL_END = new Map<string, { starts: ReadonlySet<string>; ends: ReadonlySet<string> }>([
  ['li', { starts: set('li'), ends: set('ul', 'ol', 'menu') }],
  ['dt', { starts: set('dt', 'dd'), ends: set('dl', 'div') }],
  ['dd', { starts: set('dt', 'dd'), ends: set('dl', 'div') }],
  [
    'option',
    { starts: set('option', 'optgroup', 'hr'), ends: set('select', 'datalist', 'optgroup') },
  ],
  ['optgroup', { starts: set('optgroup', 'hr'), ends: set('select') }],
  ['tr', { starts: set('tr', 'tbody', 'thead', 'tfoot'), ends: TABLE_ENDS }],
  [
    'td',
    { starts: set('td', 'th', 'tr', 'tbody', 'thead', 'tfoot'), ends: set('tr', ...TABLE_ENDS) },
  ],
  [
    'th',
    { starts: set('td', 'th', 'tr', 'tbody', 'thead', 'tfoot'), ends: set('tr', ...TABLE_ENDS) },
  ],
  ['thead', { starts: set('tbody', 'tfoot'), ends: set('table') }],
  ['tbody', { starts: set('tbody', 'tfoot'), ends: set('table') }],
  ['tfoot', { starts: set('tbody'), ends: set('table') }],
  ['caption', { starts: set('colgroup', 'thead', 'tbody', 'tfoot', 'tr'), ends: set('table') }],
  ['colgroup', { starts: set('thead', 'tbody', 'tfoot', 'tr', 'colgroup'), ends: set('table') }],
  ['rb', { starts: set('rb', 'rt', 'rtc', 'rp'), ends: set('ruby') }],
  ['rt', { starts: set('rb', 'rt', 'rtc', 'rp'), ends: set('ruby') }],
  ['rp', { starts: set('rb', 'rt', 'rtc', 'rp'), ends: set('ruby') }],
  ['p', { starts: ENDS_P, ends: set() }],
]);

/**
 * Where the walk goes on after an element whose content starts at `from`: past its end tag, or at
 * the tag that ends it implicitly (OPTIONAL_END; a <p> also at any end tag that is not of a
 * phrase). Same elements nested inside it are counted. -1 when it is not closed before `until`.
 */
function findElementEnd(html: string, name: string, from: number, until: number): number {
  const implied = OPTIONAL_END.get(name);
  let depth = 1;
  let i = from;
  while (i < until) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt >= until) return -1;
    // A comment, doctype or processing instruction holds no tags: an end tag written inside one
    // does not end the element (the browser keeps hiding what follows it).
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return -1;
      i = end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    TAG.lastIndex = lt;
    const tag = TAG.exec(html);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const gt = tagEnd(html, lt + tag[0].length);
    if (gt < 0) return -1;
    i = gt + 1;
    const tagName = tag[2]!.toLowerCase();
    const closing = tag[1] === '/';
    // Raw text (a script, a style...): nothing inside is a tag, so its own end tag is searched.
    if (!closing && RAW_TEXT.has(tagName) && tagName !== name) {
      const close = findClose(html, tagName, i);
      if (close < 0 || close >= until) return -1;
      const end = html.indexOf('>', close);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (tagName === name) {
      if (closing) {
        depth--;
        if (depth === 0) return i;
      } else if (implied) return lt;
      else if (html[gt - 1] !== '/') depth++;
      continue;
    }
    if (!implied) continue;
    const ends = closing
      ? implied.ends.has(tagName) || (name === 'p' && !PHRASING.has(tagName))
      : implied.starts.has(tagName);
    if (ends) return lt;
  }
  return -1;
}

/** Elements whose content HTML reads as raw text up to their own end tag (no tags inside). */
const RAW_TEXT = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);

/** One closing-tag pattern per element name (only fixed names: HIDDEN, title and RAW_TEXT). */
const CLOSERS = new Map<string, RegExp>();
/** Finds `</name` (any case) at or after `from`; -1 when missing. */
function findClose(html: string, name: string, from: number): number {
  let close = CLOSERS.get(name);
  if (!close) CLOSERS.set(name, (close = new RegExp(`</${name}(?=[\\s/>]|$)`, 'gi')));
  close.lastIndex = from;
  return close.exec(html)?.index ?? -1;
}

const isSpace = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;

/**
 * The index of the '>' that ends a tag whose attributes start at `from`, or -1. As in HTML, an
 * attribute value after '=' is skipped whole: a quoted one up to its closing quote (so
 * `alt="5 > 3"` does not end the tag), an unquoted one up to whitespace or '>'. Linear: the
 * cursor only moves forward.
 */
export function tagEnd(html: string, from: number): number {
  const n = html.length;
  let i = from;
  while (i < n) {
    const code = html.charCodeAt(i);
    if (code === 0x3e) return i;
    i++;
    if (code !== 0x3d) continue;
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    while (i < n) {
      const value = html.charCodeAt(i);
      if (value === 0x3e || isSpace(value)) break;
      i++;
    }
  }
  return -1;
}

export interface HtmlToTextOptions {
  /**
   * XML (a feed served as application/xml): every tag separates words, and every <title> after the
   * first (an item's headline) is text.
   */
  xml?: boolean;
  /**
   * Stop once the collected text, decoded and collapsed, is longer than this many bytes of UTF-8;
   * the text returned is then longer than this (the caller cuts it and says so).
   */
  maxTextBytes?: number;
}

/**
 * The first <title> and the visible text, both entity-decoded and whitespace-collapsed. Linear:
 * every search moves the cursor past what it scanned, and the early-stop checks run at doubling
 * sizes.
 */
export function htmlToText(
  html: string,
  options: HtmlToTextOptions = {},
): { title: string | null; text: string } {
  const out: string[] = [];
  let title: string | null = null;
  let i = 0;
  const n = html.length;
  const xml = options.xml === true;
  const maxTextBytes = options.maxTextBytes ?? Number.POSITIVE_INFINITY;
  let collected = 0;
  let checkAt = maxTextBytes;
  let unclosedScan = 2 * n;
  const add = (piece: string) => {
    out.push(piece);
    collected += piece.length;
  };
  while (i < n) {
    if (collected >= checkAt) {
      const text = collapseWhitespace(decodeEntities(out.join('')));
      if (Buffer.byteLength(text, 'utf8') > maxTextBytes) return { title: title || null, text };
      checkAt = collected * 2;
    }
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      add(html.slice(i));
      break;
    }
    add(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      // CDATA is literal text: escaped so the entity decoding below leaves it as written.
      add(html.slice(lt + 9, end < 0 ? n : end).replace(/&/g, '&amp;'));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      // A doctype, a processing instruction or a bogus comment: no text.
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    TAG.lastIndex = lt;
    const tag = TAG.exec(html);
    if (!tag) {
      // A lone "<" is text.
      add('<');
      i = lt + 1;
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2]!.toLowerCase();
    const gt = tagEnd(html, lt + tag[0].length);
    if (gt < 0) break;
    i = gt + 1;
    if (xml || BREAKS.has(name)) add(' ');
    if (closing) continue;
    // HTML keeps every <title> out of the text; XML only the first (the feed's own title).
    const pageTitle = name === 'title' && (!xml || title === null);
    if (pageTitle || HIDDEN.has(name)) {
      if (html[gt - 1] === '/') continue;
      const close = findClose(html, name, i);
      const inner = html.slice(i, close < 0 ? n : close);
      if (name === 'title' && title === null) title = collapseWhitespace(decodeEntities(inner));
      if (close < 0) break;
      const end = html.indexOf('>', close);
      i = end < 0 ? n : end + 1;
      add(' ');
      continue;
    }
    // An HTML element a person never sees is left out with everything inside it. One never closed
    // is read as if it were not hidden, so the rest of the page is never lost to it; the searches
    // that find no end may scan the page twice over in all, then hidden ones are read as text.
    if (!xml && unclosedScan > 0 && concealed(html.slice(lt + tag[0].length, gt))) {
      // A '/' before '>' does not close an HTML element that is not void (`<div hidden/>`): the
      // browser hides what follows up to its end tag, so it is searched like any other.
      if (VOID.has(name)) continue;
      const until = Math.min(n, i + unclosedScan);
      const next = findElementEnd(html, name, i, until);
      if (next < 0) {
        unclosedScan -= until - i;
        continue;
      }
      i = next;
      add(' ');
    }
  }
  return { title: title || null, text: collapseWhitespace(decodeEntities(out.join(''))) };
}
