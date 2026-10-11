/*
 * The smooth reveal of an answer that is still being written (Elric's streamed replies).
 *
 * Text reaches the page in batches (a draft read every few hundred ms, then the posted message).
 * Shown as it arrives, the answer jumps by whole sentences and then pauses. Instead the page
 * reveals the text it has at an even pace, a few characters per frame, and adapts the pace to the
 * backlog: it speeds up when text piles up (so it never lags far behind) and, once the answer is
 * complete, finishes at a steady speed within REVEAL.doneS. Pure functions, no DOM: the React side
 * is Streaming.tsx.
 */

export const REVEAL = {
  /** The slowest pace (characters a second) while text is waiting: slow enough that a small
   * first draft keeps growing until the next one arrives instead of stopping. */
  minCps: 10,
  /** The fastest pace. */
  maxCps: 4000,
  /** The pace aims to stay about this far behind the newest text (seconds of backlog): a
   * little more than the draft cadence (500 ms), so the reveal never runs dry between drafts. */
  lagS: 0.7,
  /** How quickly the pace follows its aim (ms): no sudden speed changes. */
  easeMs: 200,
  /** Once the answer is complete, the rest shows within this many seconds, at a steady pace. */
  doneS: 0.8,
  /** ... and never slower than this, so short endings do not crawl. */
  doneMinCps: 120,
  /** A longer frame (a busy or throttled tab) counts as this long. */
  maxFrameMs: 100,
} as const;

export type RevealState = {
  /** Characters shown. */
  shown: number;
  /** The current pace, characters a second. */
  cps: number;
  /** The fraction of a character carried to the next frame. */
  carry: number;
};

export const START: RevealState = { shown: 0, cps: REVEAL.minCps, carry: 0 };

/**
 * One frame of the reveal: `target` characters are available (`done` when the answer is
 * complete), `dtMs` passed since the last frame. Never shows more than the target, never goes
 * back (a shorter target is the caller's business: see `rebase`).
 */
export function advance(
  state: RevealState,
  target: number,
  done: boolean,
  dtMs: number,
): RevealState {
  if (state.shown >= target) return { shown: target, cps: state.cps, carry: 0 };
  const frame = Math.max(0, Math.min(dtMs, REVEAL.maxFrameMs));
  const backlog = target - state.shown;
  const aim = Math.min(REVEAL.maxCps, Math.max(REVEAL.minCps, backlog / REVEAL.lagS));
  // Complete: a steady pace that only ever speeds up, so the ending neither crawls nor jerks.
  const cps = done
    ? Math.min(REVEAL.maxCps, Math.max(state.cps, REVEAL.doneMinCps, aim, backlog / REVEAL.doneS))
    : state.cps + (aim - state.cps) * Math.min(1, frame / REVEAL.easeMs);
  const exact = state.carry + (cps * frame) / 1000;
  const step = Math.floor(exact);
  const shown = Math.min(target, state.shown + step);
  return { shown, cps, carry: shown >= target ? 0 : exact - step };
}

/**
 * The text changed under the reveal (the posted message replaces the draft, or a new model step
 * starts over): keep what is still the same, and go back only where the text differs.
 */
export function rebase(state: RevealState, shownText: string, next: string): RevealState {
  let same = 0;
  const limit = Math.min(shownText.length, next.length);
  while (same < limit && shownText.charCodeAt(same) === next.charCodeAt(same)) same += 1;
  return same >= state.shown ? state : { ...state, shown: same, carry: 0 };
}

/**
 * Where to cut `text` to show about `n` characters: never inside a surrogate pair (an emoji) or
 * between \r and \n. The cut may be one character later than `n`, never earlier.
 */
export function cutAt(text: string, n: number): number {
  if (n <= 0) return 0;
  if (n >= text.length) return text.length;
  const before = text.charCodeAt(n - 1);
  const after = text.charCodeAt(n);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return n + 1;
  if (before === 13 && after === 10) return n + 1;
  return n;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that starts (or may still become) a list item: it belongs with the list above. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const MAYBE_LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)]?)?$/;

/**
 * Splits text being written into Markdown blocks that are complete (they will not change any
 * more, so each is parsed and rendered once) and the tail that is still growing. Blocks end at a
 * blank line outside a code fence, when the next line has started and clearly begins a new block
 * (not indented, not another item of the same list). When unsure it does not split: a bigger
 * tail only costs a little more work. `complete.join('') + tail === text`, always.
 */
export function splitBlocks(text: string): { complete: string[]; tail: string } {
  const complete: string[] = [];
  let start = 0;
  let fence: string | null = null;
  let blank = false;
  let pos = 0;
  while (pos < text.length) {
    const end = text.indexOf('\n', pos);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(pos, lineEnd).replace(/\r$/, '');
    const whole = end >= 0;
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && whole) {
        if (line.trim() === close[1]) fence = null;
      }
      blank = false;
    } else if (line.trim() === '') {
      if (whole) blank = true;
    } else {
      const starts =
        blank &&
        pos > start &&
        !/^[ \t]/.test(line) &&
        !LIST_ITEM.test(line) &&
        !(!whole && MAYBE_LIST_ITEM.test(line));
      if (starts) {
        complete.push(text.slice(start, pos));
        start = pos;
      }
      blank = false;
      const open = FENCE.exec(line);
      if (open && whole) fence = open[1]!;
      else if (open && !whole) break; // a fence line still being written: leave it in the tail
    }
    if (!whole) break;
    pos = end + 1;
  }
  return { complete, tail: text.slice(start) };
}

/**
 * The growing tail as it should be parsed: an emphasis or inline code that has opened but not
 * closed yet is closed for now, so the words show bold (or as code) while they are written instead
 * of with raw `**` that disappears a moment later. Inside a code fence nothing changes.
 */
export function closeOpenMarks(tail: string): string {
  if (/^ {0,3}(`{3,}|~{3,})/m.test(tail)) return tail;
  if ((tail.match(/`/g) ?? []).length % 2)
    return tail.endsWith('`') ? tail.slice(0, -1) : `${tail}\``;
  const code = tail.replace(/`[^`]*`/g, '');
  if ((code.match(/\*\*/g) ?? []).length % 2)
    return /\*\*$/.test(tail) ? tail.slice(0, -2) : `${tail.trimEnd()}**`;
  return tail;
}
