/*
 * The plain text kinds (text-stats, json-check): pure functions over at most 64 KiB of text
 * (OFFER_KIND_SPECS), the same answer for the same input on every run, linear in the text.
 */
import { jsonAnswer, pureKind } from './kind-core.js';

/**
 * A word: letters, marks or digits, with inner apostrophes or hyphens ("don't", "well-known") and
 * a '.' or ',' between digits ("3.50", "1,000"). Every joiner starts with a character the runs
 * never contain, so a match never backtracks.
 */
const WORD =
  /[\p{L}\p{M}\p{N}]+(?:['\u2019-][\p{L}\p{M}\p{N}]+|(?<=\p{N})[.,](?=\p{N})[\p{L}\p{M}\p{N}]+)*/gu;
/** A word top words count: letters and marks, with inner apostrophes or hyphens (no digits). */
const LETTER_WORD = /^[\p{L}\p{M}]+(?:['\u2019-][\p{L}\p{M}]+)*$/u;
/**
 * A sentence ends at a run of . ! ? before whitespace or the end, or at a CJK full stop, ! or ?.
 * A match only starts at the first mark of a run: retried inside a long run (".".repeat(8000)),
 * the plain pattern would scan the rest of the run from every position, quadratic time.
 */
const SENTENCE_END = /(?<![.!?])[.!?]+(?=\s|$)|[\u3002\uff01\uff1f]+/u;
/** Line breaks: CR LF, CR, LF, NEL and the Unicode line and paragraph separators. */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;
/**
 * The longest word top words count, in UTF-16 units: five words of a 64 KiB text could otherwise
 * be an answer larger than the text (longer words still count as words).
 */
export const TOP_WORD_MAX_LENGTH = 64;

/** Orders strings by code point (plain < compares UTF-16 units, which puts U+1xxxx before U+FFxx). */
export function compareCodePoints(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

export interface TextStats {
  /** Unicode code points. */
  chars: number;
  words: number;
  lines: number;
  sentences: number;
  /** Mean code points per word, two decimals; 0 without words. */
  avgWordLength: number;
  /**
   * The five most frequent words made of letters (inner apostrophes and hyphens kept, so "don't"
   * is one word; words with digits left out, and words longer than TOP_WORD_MAX_LENGTH), lower
   * case, ’ read as '; ties in code point order.
   */
  topWords: Array<{ word: string; count: number }>;
}

/** The words of a text, as text-stats counts them. */
export function countWords(text: string): number {
  let count = 0;
  WORD.lastIndex = 0;
  while (WORD.exec(text)) count++;
  return count;
}

export function textStats(text: string): TextStats {
  const words = text.match(WORD) ?? [];
  const letters = words.reduce((sum, word) => sum + Array.from(word).length, 0);
  const counts = new Map<string, number>();
  for (const word of words) {
    if (word.length > TOP_WORD_MAX_LENGTH || !LETTER_WORD.test(word)) continue;
    const folded = word.toLowerCase().replace(/\u2019/g, "'");
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
  }
  const topWords = [...counts]
    .sort(([a, x], [b, y]) => y - x || compareCodePoints(a, b))
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));
  const segments = text.split(LINE_BREAK);
  // A final line break ends the last line; it does not start another one.
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  return {
    chars: Array.from(text).length,
    words: words.length,
    lines: text === '' ? 0 : segments.length,
    sentences: text.split(SENTENCE_END).filter((part) => /[\p{L}\p{N}]/u.test(part)).length,
    avgWordLength: words.length ? Math.round((letters / words.length) * 100) / 100 : 0,
    topWords,
  };
}

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonCheck {
  valid: boolean;
  error?: { message: string; line?: number; column?: number };
  type?: JsonType;
  /**
   * Top-level keys of an object, in order, at most JSON_CHECK_MAX_KEYS and at most
   * JSON_CHECK_KEYS_MAX_BYTES as JSON (keyCount says how many there are).
   */
  keys?: string[];
  keyCount?: number;
  /**
   * The text with 2-space indentation, when it fits JSON_CHECK_PRETTY_MAX_BYTES: every number,
   * string and key exactly as written (no rounding, duplicate keys kept), only whitespace changed.
   */
  pretty?: string;
  /** True when the indented copy would be larger than JSON_CHECK_PRETTY_MAX_BYTES. */
  prettyTooLarge?: boolean;
}

export const JSON_CHECK_PRETTY_MAX_BYTES = 16 * 1024;
export const JSON_CHECK_MAX_KEYS = 256;
/** The listed keys as JSON (quotes and escapes counted), so the answer stays within 64 KiB. */
export const JSON_CHECK_KEYS_MAX_BYTES = 16 * 1024;

/** The whole character at `index` (both halves of a surrogate pair), quoted. */
const quoteChar = (text: string, index: number) =>
  JSON.stringify(String.fromCodePoint(text.codePointAt(index)!));

/**
 * Where and why `text` is not JSON (RFC 8259), with fixed messages; null when it is. Iterative
 * (no recursion), so nesting depth costs no stack.
 */
export function findJsonError(text: string): { message: string; offset: number } | null {
  const n = text.length;
  const stack: Array<'array' | 'object'> = [];
  let i = 0;
  const err = (message: string, at = i) => ({ message, offset: at });
  const found = (expected: string) =>
    i >= n
      ? err(`Unexpected end of input, expected ${expected}`)
      : err(`Expected ${expected} but found ${quoteChar(text, i)}`);
  const skip = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };
  const string = () => {
    const start = i;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return null;
      }
      if (c < 0x20) return err('Control character in a string (it must be escaped)');
      if (c === 0x5c) {
        const next = text[i + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))
            return err('Invalid \\u escape (four hex digits expected)');
          i += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next))
          return err('Invalid escape sequence in a string');
        i += 2;
        continue;
      }
      i++;
    }
    return err('Unterminated string', start);
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const scalar = () => {
    const c = text[i];
    if (c === '"') return string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (!match) return err('Invalid number');
      i += match[0].length;
      const after = text[i];
      if (
        after === '.' ||
        after === 'e' ||
        after === 'E' ||
        (after && after >= '0' && after <= '9')
      )
        return err('Invalid number');
      return null;
    }
    for (const literal of ['true', 'false', 'null'])
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return null;
      }
    return found('a value');
  };
  const key = () => {
    skip();
    if (text[i] !== '"') return found('a double-quoted property name');
    const bad = string();
    if (bad) return bad;
    skip();
    if (text[i] !== ':') return found("':' after the property name");
    i++;
    return null;
  };
  for (;;) {
    // A value starts here.
    skip();
    const c = text[i];
    if (c === '{' || c === '[') {
      i++;
      skip();
      if (text[i] === (c === '{' ? '}' : ']')) i++;
      else {
        stack.push(c === '{' ? 'object' : 'array');
        if (c === '{') {
          const bad = key();
          if (bad) return bad;
        }
        continue;
      }
    } else {
      const bad = scalar();
      if (bad) return bad;
    }
    // A value ended: close containers or move to the next member.
    for (;;) {
      skip();
      const top = stack[stack.length - 1];
      if (!top) return i < n ? found('the end of the input') : null;
      const close = top === 'object' ? '}' : ']';
      if (text[i] === close) {
        i++;
        stack.pop();
        continue;
      }
      if (text[i] !== ',') return found(`',' or '${close}'`);
      i++;
      if (top === 'object') {
        const bad = key();
        if (bad) return bad;
      }
      break;
    }
  }
}

/** 1-based line and column (in code points) of a UTF-16 offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, column: Array.from(lines[lines.length - 1]!).length + 1 };
}

/**
 * Valid JSON text re-indented as JSON.stringify(value, null, 2) lays it out, but copied token by
 * token: numbers, strings and keys stay exactly as written (1e400, a uint256 or a duplicate key
 * survive), only whitespace changes. Null as soon as it would be larger than `maxBytes` of UTF-8
 * (deep nesting grows the indentation quadratically, so the text is never built past the budget).
 * Call it only on text JSON.parse accepts.
 */
export function indentJson(text: string, maxBytes: number): string | null {
  const parts: string[] = [];
  let size = 0;
  const push = (piece: string) => {
    size += Buffer.byteLength(piece, 'utf8');
    if (size > maxBytes) return false;
    parts.push(piece);
    return true;
  };
  const n = text.length;
  const isSpace = (code: number) =>
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  const skip = (from: number) => {
    let at = from;
    while (at < n && isSpace(text.charCodeAt(at))) at++;
    return at;
  };
  let depth = 0;
  let i = 0;
  while ((i = skip(i)) < n) {
    const c = text[i]!;
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      const next = skip(i + 1);
      if (text[next] === close) {
        if (!push(c + close)) return null;
        i = next + 1;
        continue;
      }
      depth++;
      if (!push(c + '\n' + '  '.repeat(depth))) return null;
      i++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (!push('\n' + '  '.repeat(depth) + c)) return null;
      i++;
    } else if (c === ',') {
      if (!push(',\n' + '  '.repeat(depth))) return null;
      i++;
    } else if (c === ':') {
      if (!push(': ')) return null;
      i++;
    } else if (c === '"') {
      // A string as written, escapes included.
      let end = i + 1;
      while (end < n && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (!push(text.slice(i, end + 1))) return null;
      i = end + 1;
    } else {
      // A number or a literal, up to the next structural character or whitespace.
      let end = i + 1;
      while (end < n && !isSpace(text.charCodeAt(end)) && !',:]}'.includes(text[end]!)) end++;
      if (!push(text.slice(i, end))) return null;
      i = end;
    }
  }
  return parts.join('');
}

function jsonType(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'object' | 'string' | 'number' | 'boolean';
}

/**
 * Validity, type and keys are JSON.parse's; the error position and message come from
 * findJsonError; the indented copy is the text itself (indentJson), never a re-serialized value.
 */
export function checkJson(text: string): JsonCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const found = findJsonError(text);
    if (!found) return { valid: false, error: { message: 'Not valid JSON' } };
    return { valid: false, error: { message: found.message, ...lineColumn(text, found.offset) } };
  }
  const type = jsonType(value);
  const result: JsonCheck = { valid: true, type };
  if (type === 'object') {
    const keys = Object.keys(value as object);
    const listed: string[] = [];
    let size = 0;
    for (const key of keys.slice(0, JSON_CHECK_MAX_KEYS)) {
      size += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
      if (size > JSON_CHECK_KEYS_MAX_BYTES) break;
      listed.push(key);
    }
    result.keys = listed;
    result.keyCount = keys.length;
  }
  const pretty = indentJson(text, JSON_CHECK_PRETTY_MAX_BYTES);
  if (pretty === null) result.prettyTooLarge = true;
  else result.pretty = pretty;
  return result;
}

/** text-stats: characters (code points), words, lines, sentences, mean word length, top words. */
export const textStatsKind = pureKind('text-stats', (value) =>
  jsonAnswer(textStats(String(value.text))),
);

/**
 * json-check: valid or not (JSON.parse decides), with the line and column of the first error, or
 * the type, top-level keys and an indented copy that keeps every token as written.
 */
export const jsonCheckKind = pureKind('json-check', (value) =>
  jsonAnswer(checkJson(String(value.text))),
);
