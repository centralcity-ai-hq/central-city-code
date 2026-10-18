/*
 * keyword-density and text-diff: pure functions over at most 64 KiB of text each
 * (OFFER_KIND_SPECS), the same answer for the same input on every run.
 *
 * keyword-density counts the words of a text the way text-stats reads a word (letters, marks and
 * digits with inner apostrophes or hyphens), folded to lower case with ’ read as ', and the
 * two-word phrases of words that stand next to each other (punctuation or a line break between them
 * breaks a phrase). With `stopwords` (the default) common
 * English words are left out of both lists, and a left-out word breaks a phrase ("cup of coffee"
 * gives no phrase "cup coffee"). Words longer than KEYWORD_MAX_LENGTH still count towards the
 * total, but are not listed, so the answer stays small. Ties are in code point order.
 *
 * text-diff splits both texts into lines (LF, CR LF or CR; a final line break ends the last line)
 * and finds the shortest edit between them with Myers' O(ND) algorithm, after the common first and
 * last lines are set aside. The work is bounded before it starts: at most TEXT_DIFF_MAX_LINES lines
 * per text and at most TEXT_DIFF_MAX_EDITS changed lines; a pair past either bound is refused as an
 * input error (before payment), never cut. The answer is the counts and a unified diff with
 * `context` unchanged lines around each change, as `diff -u` writes it (without file names'
 * times), at most 64 KiB like every answer.
 */
import { jsonAnswer, OfferKindInputError, pureKind } from './kind-core.js';
import { compareCodePoints } from './kinds-text.js';

// ---------------------------------------------------------------------------------------------
// keyword-density

/** The same word as text-stats reads it (kinds-text.ts WORD): no match ever backtracks. */
const WORD =
  /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+|(?<=\p{N})[.,](?=\p{N})[\p{L}\p{M}\p{N}]+)*/gu;

/** The longest word listed, in UTF-16 units (a longer one only counts towards the total). */
export const KEYWORD_MAX_LENGTH = 64;
export const KEYWORD_DEFAULT_TOP = 20;
/** Punctuation or a line break between two words: they are not a phrase. */
const PHRASE_BREAK = /[.!?;:,()[\]{}"\u3002\uff01\uff1f\r\n\u2028\u2029]/;

/** Common English words left out with `stopwords` (lower case, ' as the apostrophe). */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can could did do does doing down during each few for from further ' +
    'had has have having he her here hers herself him himself his how i if in into is it its ' +
    'itself just me more most my myself no nor not now of off on once only or other our ours ' +
    'ourselves out over own same she should so some such than that the their theirs them ' +
    'themselves then there these they this those through to too under until up very was we were ' +
    'what when where which while who whom why will with would you your yours yourself yourselves ' +
    "i'm you're he's she's it's we're they're i've you've we've they've i'd you'd he'd she'd " +
    "we'd they'd i'll you'll he'll she'll we'll they'll isn't aren't wasn't weren't hasn't " +
    "haven't hadn't doesn't don't didn't won't wouldn't can't cannot couldn't shouldn't let's " +
    "that's there's what's who's here's also may might must shall us"
  ).split(' '),
);

export interface KeywordEntry {
  count: number;
  /** count / total * 100, two decimals. */
  percent: number;
}

export interface KeywordDensity {
  /** Every word of the text, stopwords and long words included. */
  total_words: number;
  /** The words counted (stopwords left out when removed). */
  counted_words: number;
  unique_words: number;
  /** The two-word phrases counted. */
  total_phrases: number;
  stopwords_removed: boolean;
  words: Array<{ word: string } & KeywordEntry>;
  phrases: Array<{ phrase: string } & KeywordEntry>;
}

const percent = (count: number, total: number) =>
  total ? Math.round((count / total) * 10_000) / 100 : 0;

function top<K extends string>(
  counts: Map<string, number>,
  total: number,
  n: number,
  key: K,
): Array<Record<K, string> & KeywordEntry> {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || compareCodePoints(a, b))
    .slice(0, n)
    .map(
      ([text, count]) =>
        ({ [key]: text, count, percent: percent(count, total) }) as Record<K, string> &
          KeywordEntry,
    );
}

export function keywordDensity(text: string, n: number, removeStopwords: boolean): KeywordDensity {
  const words = new Map<string, number>();
  const phrases = new Map<string, number>();
  let total = 0;
  let counted = 0;
  let pairs = 0;
  /** The previous word, while it may start a phrase. */
  let previous: string | null = null;
  /** Where the previous word ended: what lies between two words may break a phrase. */
  let end = 0;
  WORD.lastIndex = 0;
  for (let match = WORD.exec(text); match; match = WORD.exec(text)) {
    total++;
    if (previous !== null && PHRASE_BREAK.test(text.slice(end, match.index))) previous = null;
    end = match.index + match[0].length;
    const word = match[0].toLowerCase().replace(/’/g, "'");
    if (removeStopwords && ENGLISH_STOPWORDS.has(word)) {
      previous = null;
      continue;
    }
    counted++;
    if (word.length > KEYWORD_MAX_LENGTH) {
      previous = null;
      continue;
    }
    words.set(word, (words.get(word) ?? 0) + 1);
    if (previous !== null) {
      const phrase = `${previous} ${word}`;
      phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
      pairs++;
    }
    previous = word;
  }
  return {
    total_words: total,
    counted_words: counted,
    unique_words: words.size,
    total_phrases: pairs,
    stopwords_removed: removeStopwords,
    words: top(words, counted, n, 'word'),
    phrases: top(phrases, pairs, n, 'phrase'),
  };
}

export const keywordDensityKind = pureKind('keyword-density', (value) =>
  jsonAnswer(
    keywordDensity(
      String(value.text),
      value.top === undefined ? KEYWORD_DEFAULT_TOP : Number(value.top),
      value.stopwords !== false,
    ),
  ),
);

// ---------------------------------------------------------------------------------------------
// text-diff

/** The most lines per text. */
export const TEXT_DIFF_MAX_LINES = 20_000;
/**
 * The most changed lines (added plus removed) a diff may have. Myers' algorithm keeps one row of
 * at most 2D+1 positions per step, so this bounds both its time and its memory (about 2000^2
 * 32-bit integers, 16 MB, at the very worst).
 */
export const TEXT_DIFF_MAX_EDITS = 2_000;
export const TEXT_DIFF_DEFAULT_CONTEXT = 3;

/** The lines of a text: LF, CR LF or CR end a line; a final break ends the last one. */
export function diffLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** One line of the edit script: kept (' '), removed ('-') or added ('+'). */
type Op = { op: ' ' | '-' | '+'; line: string };

/**
 * The shortest edit script from a to b (lines as numbers), by Myers' greedy O(ND) algorithm with
 * one saved row per step for the walk back. null when it needs more than maxEdits changes.
 */
function myers(a: Int32Array, b: Int32Array, maxEdits: number): Array<' ' | '-' | '+'> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    // Row d is read only at diagonals -d..d: save just that slice.
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk back from (n, m), one step per saved row.
  const ops: Array<' ' | '-' | '+'> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const row = trace[d - 1]!;
    const at = (k: number) => row[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(' ');
      x--;
      y--;
    }
    ops.push(down ? '+' : '-');
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    ops.push(' ');
    x--;
    y--;
  }
  return ops.reverse();
}

export interface TextDiff {
  identical: boolean;
  added: number;
  removed: number;
  unchanged: number;
  /** The unified diff ('' when the texts have the same lines). */
  unified: string;
}

const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;

/** The unified diff of an edit script, with `context` kept lines around each change. */
function unified(ops: Op[], context: number): string {
  const out: string[] = ['--- a', '+++ b'];
  let i = 0;
  // Positions in a and b (1-based) of ops[i].
  const aAt: number[] = [];
  const bAt: number[] = [];
  let ai = 1;
  let bi = 1;
  for (const { op } of ops) {
    aAt.push(ai);
    bAt.push(bi);
    if (op !== '+') ai++;
    if (op !== '-') bi++;
  }
  while (i < ops.length) {
    if (ops[i]!.op === ' ') {
      i++;
      continue;
    }
    // A hunk: from `context` lines before this change to `context` lines after the last change
    // that is at most 2 * context kept lines further.
    const start = Math.max(0, i - context);
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end]!.op !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next]!.op === ' ') next++;
      if (next < ops.length && next - end <= 2 * context) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const slice = ops.slice(start, stop);
    const aCount = slice.filter((item) => item.op !== '+').length;
    const bCount = slice.filter((item) => item.op !== '-').length;
    out.push(`@@ -${range(aAt[start]!, aCount)} +${range(bAt[start]!, bCount)} @@`);
    for (const item of slice) out.push(`${item.op}${item.line}`);
    i = stop;
  }
  return `${out.join('\n')}\n`;
}

export function textDiff(a: string, b: string, context: number): TextDiff {
  const left = diffLines(a);
  const right = diffLines(b);
  if (left.length > TEXT_DIFF_MAX_LINES || right.length > TEXT_DIFF_MAX_LINES)
    throw new OfferKindInputError(`a and b may have at most ${TEXT_DIFF_MAX_LINES} lines each.`);
  // The common first and last lines need no search.
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head++;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  )
    tail++;
  const midA = left.slice(head, left.length - tail);
  const midB = right.slice(head, right.length - tail);
  // Lines as numbers: equal lines, equal numbers.
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let value = ids.get(line);
    if (value === undefined) ids.set(line, (value = ids.size));
    return value;
  };
  const script = myers(Int32Array.from(midA, id), Int32Array.from(midB, id), TEXT_DIFF_MAX_EDITS);
  if (!script)
    throw new OfferKindInputError(
      `The texts differ in more than ${TEXT_DIFF_MAX_EDITS} lines; send texts closer to each other.`,
    );
  const ops: Op[] = left.slice(0, head).map((line) => ({ op: ' ', line }));
  let x = 0;
  let y = 0;
  for (const op of script) {
    if (op === '+') ops.push({ op, line: midB[y++]! });
    else {
      ops.push({ op, line: midA[x]! });
      x++;
      if (op === ' ') y++;
    }
  }
  for (const line of left.slice(left.length - tail)) ops.push({ op: ' ', line });
  const added = ops.filter((item) => item.op === '+').length;
  const removed = ops.filter((item) => item.op === '-').length;
  const identical = added === 0 && removed === 0;
  return {
    identical,
    added,
    removed,
    unchanged: ops.length - added - removed,
    unified: identical ? '' : unified(ops, context),
  };
}

export const textDiffKind = pureKind('text-diff', (value) =>
  jsonAnswer(
    textDiff(
      String(value.a),
      String(value.b),
      value.context === undefined ? TEXT_DIFF_DEFAULT_CONTEXT : Number(value.context),
    ),
  ),
);
