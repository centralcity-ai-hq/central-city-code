import { WAKE_LIMITS } from './contract.js';

/**
 * @mention parsing (docs/WAKE.md). Candidates are only the agents that can already read
 * the message (the recipient of a direct message; the active members of a room), so a mention
 * never grants access. Matching is ambiguity-safe: a mention that fits two different agents
 * equally well mentions neither.
 *
 * Accepted forms, case-insensitive: `@<agent id>`, `@<slug>` (the display name lowercased with
 * every run of other characters turned into `-`, e.g. `@city-desk`), `@<display name>` (longest
 * match wins, e.g. `@Build Desk`), and `@"<display name>"`. An `@` preceded by a letter, digit or
 * one of `._-+` (an email address) is not a mention.
 */
export interface MentionCandidate {
  id: string;
  name: string;
}
export interface MentionMatch {
  /** Distinct mentioned agent ids, in order of first mention, at most mentionsPerMessage. */
  ids: string[];
  /** Offset of each agent's first mention (for excerpts). */
  offsets: Map<string, number>;
  /** Mention texts that fit several agents and were ignored. */
  ambiguous: string[];
}

const WORD = /[\p{L}\p{N}_]/u;
const SLUG_CHAR = /[\p{L}\p{N}._-]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const fold = (value: string) => value.normalize('NFKC').toLowerCase();

export function slugOf(name: string): string {
  return fold(name)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** The form a display name is compared in (`@Name` prefixes and `@"Name"`). */
export function nameKeyOf(name: string): string {
  return fold(name).trim();
}

/** Lowercased slug token right after an `@` (the `@city-desk` form). */
function slugToken(rest: string): string {
  let token = '';
  for (const char of rest) {
    if (!SLUG_CHAR.test(char)) break;
    token += char;
  }
  return token.replace(/[._-]+$/, '');
}

export interface MentionKeys {
  /** nameKeyOf values a mentioned candidate's name may have. */
  names: string[];
  /** slugOf values a mentioned candidate's name may have. */
  slugs: string[];
  /** Lowercased agent ids written as `@<id>`. */
  ids: string[];
}

/**
 * Every key a candidate must have for findMentions(text, ...) to be able to match it, without
 * knowing the candidates: for each `@` findMentions would scan, the quoted label, the id, every
 * prefix of the following text that ends where a name match may end, and the slug token. A
 * candidate with none of these keys never affects the result (it is neither a hit nor part of an
 * ambiguity), so findMentions over only the candidates having one of them returns exactly what it
 * returns over all of them (server/wake/hooks.ts roomPosted, tests/mention-keys.test.ts).
 */
export function mentionKeys(text: string): MentionKeys {
  const names = new Set<string>();
  const slugs = new Set<string>();
  const ids = new Set<string>();
  if (!text.includes('@')) return { names: [], slugs: [], ids: [] };
  const folded = fold(text);
  let scanned = 0;
  for (let at = folded.indexOf('@'); at >= 0; at = folded.indexOf('@', at + 1)) {
    if (++scanned > WAKE_LIMITS.mentionScan) break;
    const before = at > 0 ? folded[at - 1]! : '';
    if (before && (WORD.test(before) || '.-+'.includes(before))) continue;
    const rest = folded.slice(at + 1, at + 1 + 200);
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end >= 1) names.add(rest.slice(1, end).trim());
      continue;
    }
    if (UUID.test(rest) && !WORD.test(rest[36] ?? '')) {
      ids.add(rest.slice(0, 36));
      continue;
    }
    for (let length = 1; length <= rest.length; length++) {
      const next = rest[length] ?? '';
      if (!WORD.test(next) && next !== '-') names.add(rest.slice(0, length));
    }
    const token = slugToken(rest);
    if (token) slugs.add(token);
  }
  return { names: [...names], slugs: [...slugs], ids: [...ids] };
}

export function findMentions(
  text: string,
  candidates: readonly MentionCandidate[],
  /**
   * `exclude`: ids that resolve as names but are never mentioned (the sender; for an agent
   * sender, also its owner's room host).
   */
  options: { exclude?: string | readonly string[]; max?: number } = {},
): MentionMatch {
  const max = options.max ?? WAKE_LIMITS.mentionsPerMessage;
  const excluded = new Set(
    options.exclude === undefined
      ? []
      : typeof options.exclude === 'string'
        ? [options.exclude]
        : options.exclude,
  );
  // The sender stays a candidate so "@its-own-name" resolves to it (and is then dropped)
  // instead of falling back to a shorter name that happens to be a prefix.
  const pool = candidates
    .map((item) => ({ id: item.id, name: nameKeyOf(item.name), slug: slugOf(item.name) }))
    .filter((item) => item.slug.length > 0);
  const result: MentionMatch = { ids: [], offsets: new Map(), ambiguous: [] };
  if (!pool.length || !text.includes('@')) return result;
  const folded = fold(text);
  let scanned = 0;
  for (let at = folded.indexOf('@'); at >= 0; at = folded.indexOf('@', at + 1)) {
    if (++scanned > WAKE_LIMITS.mentionScan || result.ids.length >= max) break;
    const before = at > 0 ? folded[at - 1]! : '';
    if (before && (WORD.test(before) || '.-+'.includes(before))) continue;
    const rest = folded.slice(at + 1, at + 1 + 200);
    let hits: string[] = [];
    let label = '';
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 1) continue;
      label = rest.slice(1, end).trim();
      hits = pool.filter((item) => item.name === label).map((item) => item.id);
    } else if (UUID.test(rest) && !WORD.test(rest[36] ?? '')) {
      label = rest.slice(0, 36);
      hits = pool.filter((item) => item.id.toLowerCase() === label).map((item) => item.id);
    } else {
      // Longest display-name prefix ending at a word boundary, or an exact slug token.
      let best = 0;
      for (const item of pool) {
        const length = item.name.length;
        const next = rest[length] ?? '';
        if (length && rest.startsWith(item.name) && !WORD.test(next) && next !== '-') {
          if (length > best) {
            best = length;
            hits = [item.id];
          } else if (length === best) hits.push(item.id);
        }
      }
      const token = slugToken(rest);
      const slugHits = token ? pool.filter((item) => item.slug === token) : [];
      if (slugHits.length && token.length >= best) {
        if (token.length > best) hits = slugHits.map((item) => item.id);
        else hits = [...new Set([...hits, ...slugHits.map((item) => item.id)])];
        best = token.length;
      }
      label = rest.slice(0, best);
    }
    const distinct = [...new Set(hits)];
    if (distinct.length > 1) {
      result.ambiguous.push(label);
      continue;
    }
    const id = distinct[0];
    if (!id || excluded.has(id) || result.offsets.has(id)) continue;
    result.ids.push(id);
    result.offsets.set(id, at);
  }
  return result;
}

/** Text of all text parts, joined with blank lines. */
export function textOf(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('\n\n');
}

/** Up to excerptChars characters around a mention (single line). */
export function excerptAt(text: string, offset: number): string {
  const size = WAKE_LIMITS.excerptChars;
  const start = Math.max(0, Math.min(offset - 80, text.length - size));
  const slice = [...text.slice(start, start + size + 16)].slice(0, size).join('');
  return `${start > 0 ? '…' : ''}${slice.replace(/\s+/g, ' ').trim()}${start + size < text.length ? '…' : ''}`;
}
