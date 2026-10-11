import type { Transaction as Tx } from '../database.js';
import { partsContainCredential } from '../rooms/contract.js';

/**
 * What Elric may post (docs/ELRIC.md):
 *
 * - no live @mentions: an Elric reply never pages a member or wakes an agent (its messages carry
 *   no responder stamp yet, so this is also the loop protection toward hosted responders);
 * - [#seq] citations only to messages that exist in THIS room and that Elric can see; others are
 *   stripped;
 * - never a credential: Central City credential prefixes (the room post path refuses them too)
 *   and common model-provider key shapes.
 */
const PROVIDER_KEY = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})/;

export function containsCredential(text: string): boolean {
  return partsContainCredential([{ type: 'text', text }]) || PROVIDER_KEY.test(text);
}

/**
 * "@Name" → "Name" wherever the room's mention parser would read a mention (not e-mail). The
 * text is NFKC-normalised first, the same folding the parser applies, so look-alikes such as
 * "＠" (U+FF20) and "﹫" (U+FE6B) become "@" and are stripped too.
 */
export function stripMentions(text: string): string {
  let out = text.normalize('NFKC');
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(/(^|[^\p{L}\p{N}_.+-])@+/gu, '$1');
  }
  return out;
}

const CITATION = /\[#(\d{1,15})\]/g;

/** Keeps [#seq] only for messages of this room with visibleFromSeq < seq <= upToSeq. */
export async function validateCitations(
  q: Pick<Tx, 'query'>,
  roomId: string,
  text: string,
  visibleFromSeq: number,
  upToSeq: number,
): Promise<{ text: string; kept: number[]; stripped: number[] }> {
  const cited = [...new Set([...text.matchAll(CITATION)].map((match) => Number(match[1])))];
  if (!cited.length) return { text, kept: [], stripped: [] };
  const candidates = cited.filter((seq) => seq > visibleFromSeq && seq <= upToSeq);
  const found = candidates.length
    ? new Set(
        (
          await q.query<{ seq: string | number }>(
            'SELECT seq FROM room_messages WHERE room_id=$1 AND seq = ANY($2::bigint[])',
            [roomId, candidates],
          )
        ).rows.map((row) => Number(row.seq)),
      )
    : new Set<number>();
  const stripped = cited.filter((seq) => !found.has(seq));
  const cleaned = text
    .replace(CITATION, (match, seq: string) => (found.has(Number(seq)) ? match : ''))
    .replace(/[ \t]+([.,;:!?)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
  return { text: cleaned, kept: cited.filter((seq) => found.has(seq)), stripped };
}

/**
 * A model answer that broke off mid-stream (docs/ELRIC.md): when at least this many visible
 * characters arrived, the room gets that text with ELRIC_CUT_SHORT_MARKER on its own line instead
 * of the "couldn't answer" line.
 */
export const ELRIC_PARTIAL_MIN_CHARS = 40;
export const ELRIC_CUT_SHORT_MARKER = '(cut short)';

/** Visible characters: code points of the text without whitespace. */
export function visibleChars(text: string): number {
  return [...text.replace(/\s+/gu, '')].length;
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Closes a code fence left open at the end of `text` (with the same fence string). */
export function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)?.[1];
    if (!fence) continue;
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = null;
  }
  return open === null ? text : `${text.replace(/\s+$/u, '')}\n${open}`;
}

/** Grapheme cluster boundaries of `text` (never inside a surrogate pair or a ZWJ sequence). */
function graphemeEnds(text: string): Set<number> {
  const ends = new Set<number>();
  for (const { index, segment } of new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(text))
    ends.add(index + segment.length);
  return ends;
}

/**
 * The cleanly cut prefix of a partial answer, or null when there is none: the text up to the
 * last complete sentence or line that keeps at least `minChars` visible characters, with an open
 * code fence closed. A sentence end counts only when something follows it in the stream (a space
 * or a line break after . ! ? …, anything after a full-width 。！？), so "costs 3." from "3.50"
 * is never taken as a sentence. The cut is always at a grapheme boundary.
 */
export function cutPartial(text: string, minChars = ELRIC_PARTIAL_MIN_CHARS): string | null {
  const ends = graphemeEnds(text);
  let best = -1;
  const take = (at: number) => {
    if (at > 0 && at < text.length && ends.has(at) && at > best) best = at;
  };
  for (const match of text.matchAll(/[.!?…]["'”’)\]]*(?=\s)/gu))
    take(match.index + match[0].length);
  for (const match of text.matchAll(/[。！？｡][」』）"'”’)\]]*/gu))
    take(match.index + match[0].length);
  for (const match of text.matchAll(/\n/gu)) take(match.index + 1);
  if (best <= 0) return null;
  const cut = text.slice(0, best).replace(/\s+$/u, '');
  if (visibleChars(cut) < minChars) return null;
  return closeOpenFence(cut);
}
