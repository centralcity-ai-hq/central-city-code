/**
 * Elric's help tool (N5): read-only search over Central City's public docs, the same pages
 * https://centralcity.ai/docs serves (scripts/public-docs/build.ts, its allow-list and public-safety
 * guard). The index is generated (scripts/elric-help-index.ts) and committed; a test fails when
 * it is stale. No room data, no network, no owner data: Elric answers "how does Central City
 * work" from these sections and links the page instead of guessing.
 */
import { HELP_INDEX } from './help-index.js';

export const ELRIC_DOCS_URL = 'https://centralcity.ai/docs';

export interface HelpSection {
  slug: string;
  title: string;
  url: string;
  heading: string;
  text: string;
}
export interface HelpResult {
  results: Array<{ page: string; section: string; url: string; text: string }>;
  /** Always present: where to read more (and the only link when nothing matched). */
  docs: string;
}

export const HELP_LIMITS = { results: 3, sectionChars: 1_500, queryChars: 200 } as const;

const SECTIONS: readonly HelpSection[] = HELP_INDEX;
const STOP = new Set(
  'the and for with that this from what how can does do you your are is was will into about which who why when where there their them they have has had not but our out use using get set'.split(
    ' ',
  ),
);

/** Lower-case words of 3+ letters, stop words dropped, light plural folding. */
export function helpTerms(query: string, self = false): string[] {
  const words = query
    .toLowerCase()
    .normalize('NFKC')
    .match(/[\p{L}\p{N}]{3,}/gu);
  const terms = new Set<string>();
  for (const word of words ?? []) {
    if (STOP.has(word)) continue;
    terms.add(word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
  }
  // Asked by Elric about itself ("how do I stop you?"): "you" means Elric.
  if (self && /\byou(?:rs?|rself)?\b/i.test(query)) terms.add('elric');
  return [...terms].slice(0, 12);
}

/** Occurrences of the term at the start of a word (so "age" never matches "page"), max 10. */
function count(haystack: string, term: string): number {
  let n = 0;
  for (let at = haystack.indexOf(term); at !== -1 && n < 10; at = haystack.indexOf(term, at + 1))
    if (at === 0 || !/[\p{L}\p{N}]/u.test(haystack[at - 1]!)) n++;
  return n;
}

/** The best sections for a question, each with its public link; never more than 3. */
export function searchHelp(
  query: string,
  sections: readonly HelpSection[] = SECTIONS,
  options: { self?: boolean } = {},
): HelpResult {
  const terms = helpTerms(query.slice(0, HELP_LIMITS.queryChars), options.self ?? false);
  // Rare words weigh more (inverse document frequency over the sections).
  const texts = sections.map((section) => ({
    section,
    heading: `${section.title} ${section.heading}`.toLowerCase(),
    body: section.text.toLowerCase(),
  }));
  const weight = new Map(
    terms.map((term) => {
      const df = texts.filter((t) => count(t.heading, term) || count(t.body, term)).length;
      return [term, df ? Math.log(1 + sections.length / df) : 0];
    }),
  );
  const scored = texts
    .map(({ section, heading, body }) => {
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const inHeading = count(heading, term);
        const inBody = count(body, term);
        if (inHeading || inBody) matched++;
        score += (inHeading * 4 + Math.min(inBody, 5)) * weight.get(term)!;
      }
      // Sections that match more of the question rank first.
      // Elric asking about itself: its own page ranks a little higher.
      const own = options.self && section.slug === 'elric' ? 1.5 : 1;
      // The Security Audit is a report, not a how-to: its long findings tables name almost every
      // feature, so it ranks below the guide pages that explain them.
      const report = section.slug === 'audit' ? 0.5 : 1;
      return { section, score: score * matched * own * report };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, HELP_LIMITS.results);
  return {
    results: scored.map(({ section }) => ({
      page: section.title,
      section: section.heading,
      url: section.url,
      text:
        section.text.length > HELP_LIMITS.sectionChars
          ? `${section.text.slice(0, HELP_LIMITS.sectionChars)}…`
          : section.text,
    })),
    docs: ELRIC_DOCS_URL,
  };
}
