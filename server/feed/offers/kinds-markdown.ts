/*
 * markdown-to-text: Markdown to plain text in one pass per line, with no regular expression that
 * can backtrack over a line: block markers are read by hand or by patterns anchored at the start
 * with bounded runs, and inline syntax by a scanner whose searches for a closing character only
 * move forward (finder), so a line costs time linear in its length whatever it holds.
 *
 * Kept: the text of headings, paragraphs, lists, quotes and tables, link text, code (fenced,
 * indented and inline) as written, and the address of an autolink. Removed: images (alt text
 * too), link and image addresses, reference definitions, emphasis and strike markers, HTML tags
 * and comments, horizontal rules, table separator rows, heading and list markers, and escapes.
 * Blank line runs become one blank line.
 */
import { pureKind, textAnswer } from './kind-core.js';

/**
 * Finds `needle` at or after a position. While the positions asked for do not decrease, every
 * search starts past the last answer (or reuses it), so all searches of a line scan it once.
 */
function finder(text: string, needle: string) {
  let lastFrom = -1;
  let last = -2;
  return (from: number): number => {
    if (from >= lastFrom) {
      if (last === -1) return -1;
      if (last >= from) return last;
    }
    lastFrom = from;
    last = text.indexOf(needle, from);
    return last;
  };
}

const isSpace = (char: string | undefined) =>
  char === undefined || char === ' ' || char === '\t' || char === ' ';
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/** The inline text of one line (or of a link's text). */
export function inlineText(text: string): string {
  // One finder per kind of search, so each is asked at positions that never decrease.
  const closeBracket = finder(text, ']');
  const refBracket = finder(text, ']');
  const closeParen = finder(text, ')');
  const closeAngle = finder(text, '>');
  const closeComment = finder(text, '-->');
  const ticks = new Map<number, ReturnType<typeof finder>>();
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const char = text[i]!;
    if (char === '\\' && i + 1 < n && PUNCTUATION.includes(text[i + 1]!)) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (char === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      let find = ticks.get(run);
      if (!find) ticks.set(run, (find = finder(text, '`'.repeat(run))));
      const close = find(i + run);
      if (close < 0) {
        out += text.slice(i, i + run);
        i += run;
        continue;
      }
      // Code as written; one space just inside each end is padding.
      let code = text.slice(i + run, close);
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
      out += code;
      i = close + run;
      continue;
    }
    if (char === '!' && text[i + 1] === '[') {
      const close = closeBracket(i + 2);
      if (close >= 0 && text[close + 1] === '(') {
        const end = closeParen(close + 2);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      } else if (close >= 0 && text[close + 1] === '[') {
        const end = refBracket(close + 2);
        if (end >= 0) {
          i = end + 1;
          continue;
        }
      }
      out += char;
      i++;
      continue;
    }
    if (char === '[') {
      const close = closeBracket(i + 1);
      if (close >= 0 && text[close + 1] === '(') {
        const end = closeParen(close + 2);
        if (end >= 0) {
          out += inlineText(text.slice(i + 1, close));
          i = end + 1;
          continue;
        }
      } else if (close >= 0 && text[close + 1] === '[') {
        const end = refBracket(close + 2);
        if (end >= 0) {
          out += inlineText(text.slice(i + 1, close));
          i = end + 1;
          continue;
        }
      }
      out += char;
      i++;
      continue;
    }
    if (char === '<') {
      if (text.startsWith('<!--', i)) {
        const end = closeComment(i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const next = text[i + 1];
      if (next !== undefined && (/[A-Za-z]/.test(next) || next === '/')) {
        const end = closeAngle(i + 1);
        if (end >= 0) {
          const inner = text.slice(i + 1, end);
          // An autolink keeps its address; any other tag is dropped.
          if (/^(?:https?:\/\/|mailto:)\S+$/i.test(inner)) out += inner;
          i = end + 1;
          continue;
        }
      }
      out += char;
      i++;
      continue;
    }
    if (char === '*' || char === '_' || (char === '~' && text[i + 1] === '~')) {
      let run = 1;
      while (text[i + run] === char) run++;
      const before = text[i - 1];
      const after = text[i + run];
      // A marker touches a word on one side; a run between spaces ("2 * 3") is text, and so is
      // an underscore inside a word (snake_case).
      const keep =
        (isSpace(before) && isSpace(after)) ||
        (char === '_' && isWordChar(before) && isWordChar(after));
      if (keep) out += text.slice(i, i + run);
      i += run;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?=[ \t]|$)/;
const QUOTE = / {0,3}> ?/y;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const REFERENCE = /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*\S/;

/** Three or more of one of - * _ with only spaces between: a horizontal rule. */
function isRule(line: string): boolean {
  const marks = line.replace(/[ \t]/g, '');
  return marks.length >= 3 && /^(?:-+|\*+|_+)$/.test(marks) && /^ {0,3}[-*_]/.test(line);
}

/** A setext underline (=== or ---) or a table separator row (| --- | :-: |). */
function isUnderline(line: string): boolean {
  const trimmed = line.trim();
  if (/^=+$/.test(trimmed)) return true;
  if (!trimmed.includes('-')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/** A heading without its closing #s ("# Title ##" is "Title"). */
function headingText(rest: string): string {
  let end = rest.length;
  while (end > 0 && isSpace(rest[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === '#') hashes--;
  if (hashes < end && (hashes === 0 || isSpace(rest[hashes - 1]))) end = hashes;
  return rest.slice(0, end);
}

export function markdownToText(markdown: string): string {
  const lines = markdown.split(/\r\n|\r|\n/);
  const out: string[] = [];
  let fence: string | null = null;
  lines.forEach((raw, index) => {
    if (fence !== null) {
      const close = FENCE.exec(raw);
      if (
        close &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        !raw.slice(close[0].length).trim()
      )
        fence = null;
      else out.push(raw);
      return;
    }
    const open = FENCE.exec(raw);
    if (open) {
      fence = open[1]!;
      return;
    }
    // Quote markers, nested ones too, read in one forward pass.
    let quoted = 0;
    for (;;) {
      QUOTE.lastIndex = quoted;
      const marker = QUOTE.exec(raw);
      if (!marker) break;
      quoted += marker[0].length;
    }
    let line = raw.slice(quoted);
    // A rule separates paragraphs; a reference definition, a setext underline or a table's
    // separator row is markup only.
    if (isRule(line)) {
      out.push('');
      return;
    }
    if (REFERENCE.test(line) || isUnderline(line)) return;
    const heading = HEADING.exec(line);
    if (heading) line = headingText(line.slice(heading[0].length));
    else line = line.replace(LIST, '');
    // A table row: its cells, separated by spaces.
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1)
      line = trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .join(' ');
    out.push(inlineText(line).trim());
  });
  // Blank line runs become one blank line; none at either end.
  const kept: string[] = [];
  for (const line of out) {
    if (line.trim() === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line.trim() === '' ? '' : line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

export const markdownToTextKind = pureKind('markdown-to-text', (value) =>
  textAnswer(markdownToText(String(value.text))),
);
