import {
  FEED_LIMITS,
  FEED_SOURCE,
  feedRiskOf,
  rawToUsdc,
  usdcToRaw,
  type FeedBudget,
  type FeedField,
  type FeedPrice,
  type FeedService,
  type FeedServiceSort,
  type FeedUsage,
  type PostedFeedRequest,
  type PublicFeedRequest,
} from '../../shared/feed';
import type { FeedRequestPost } from './feedApi';
import { feedHref } from './feedPaths';

export { readManageToken } from './feedPaths';

/*
 * The Feed's words and numbers (docs: the Feed mockup of 13 Oct). Pure: no I/O and no globals,
 * so tests/feed-ui.test.ts checks every line the cards show.
 *
 * Money reads as dollars on cards, rows and chips, exact (rawToUsdc keeps every listed decimal):
 * a price per call as listed ("$0.007"), a budget in cents with thousands separated ("$25.00",
 * "$100,000.00"); the details say it is paid in USDC on Base. Unknown stays unknown: no price is
 * "Price unknown", never free; no use count is "Not reported", and no use yet is "New", never 0.
 */

export const number = new Intl.NumberFormat('en-US');

/** The source credit on every service (shared/feed.ts FEED_SOURCE). */
export const CREDIT = FEED_SOURCE.credit;

/** The full label in a service's details. A card carries the short "x402 Bazaar" credit. */
export const EXTERNAL_LABEL = `External service · listed by ${FEED_SOURCE.name} · not a Central City agent`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Characters that change how text reads without being visible (bidi overrides, zero-width). */
const INVISIBLE = /[\p{Cf}\u2028\u2029\0-\x08\x0B-\x1F\x7F-\x9F]/gu;

/**
 * Provider and poster text as plain text: no control or invisible characters, at most one empty
 * line in a row. React escapes it; nothing here is ever HTML, Markdown or a link.
 */
export function plain(text: string | null | undefined): string {
  return (text ?? '')
    .replace(INVISIBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const codePoints = (text: string) => Array.from(text).length;

/**
 * A listing's description as shown: one the source may have cut at the limit (descriptionMax code
 * points, mid-word) ends at the last whole word with "…", so it never reads as complete. The
 * source's cut drops a trailing space (server/feed/bazaar.ts cut), so one a point short of the
 * limit may be cut too: it ended at a space, so its last word is whole and stays. Display only.
 */
export function shownDescription(text: string): string {
  const shown = plain(text);
  const length = Array.from(shown).length;
  if (length < FEED_LIMITS.descriptionMax - 1) return shown;
  const cut = length >= FEED_LIMITS.descriptionMax ? shown.replace(/\s+\S*$/, '') : shown;
  return `${(cut || shown).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * A listing's title as shown: a parenthesis the source left open ("Forecast (simple exponential")
 * is closed with "…)", and an empty one at the end ("Chat (") is dropped. Display only.
 */
export function shownTitle(text: string): string {
  const title = plain(text);
  let depth = 0;
  let open = -1;
  Array.from(title).forEach((char, index) => {
    if (char === '(') {
      if (depth === 0) open = index;
      depth += 1;
    } else if (char === ')' && depth > 0) depth -= 1;
  });
  if (depth === 0) return title;
  const points = Array.from(title);
  const inside = points
    .slice(open + 1)
    .join('')
    .trim();
  const before = points.slice(0, open).join('').trimEnd();
  if (!inside) return before.replace(/[\s,;:·-]+$/, '') || title;
  return `${before} (${inside}…)`;
}

export function plural(count: number, one: string, many: string) {
  return `${number.format(count)} ${count === 1 ? one : many}`;
}

/** "10000" is "0.01 USDC"; null for anything that is not a whole number of base units. */
export function usdc(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !/^\d{1,30}$/.test(raw)) return null;
  return `${rawToUsdc(raw)} USDC`;
}

/** "10000" is "$0.01" (USDC, one to one), thousands separated ("$2,500"); null like `usdc`. */
export function dollars(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !/^\d{1,30}$/.test(raw)) return null;
  const [whole = '0', fraction] = rawToUsdc(raw).split('.');
  return `$${number.format(BigInt(whole))}${fraction ? `.${fraction}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Times

/** "just now", "12 min ago", "3 h ago", "1 day ago", "4 days ago". A future time is "just now". */
export function agoText(then: number, now: number): string {
  const minutes = Math.round(Math.max(0, now - then) / MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** "Fri 17 Oct", local time. */
export function dayText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

/** "17:10 UTC": when the source was read. */
export function utcTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** "12 Oct, 17:10 UTC". */
export function utcText(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ${utcTime(ms)}`;
}

// ---------------------------------------------------------------------------------------------
// Offered: services

/** "$0.007", "Up to $0.05" or "Price unknown". */
export function priceMain(price: FeedPrice | null): string {
  const amount = price ? dollars(price.raw) : null;
  if (!price || !amount) return 'Price unknown';
  return `${price.unit === 'up_to_per_call' ? 'Up to ' : ''}${amount}`;
}

export function priceSub(price: FeedPrice | null): string {
  return price && dollars(price.raw) ? 'per call, in USDC' : 'not in the listing';
}

/** The rule behind a price, for the detail. */
export function priceRule(price: FeedPrice | null): string {
  if (!price || !usdc(price.raw)) return 'The listing gives no amount, so it never counts as free';
  return price.unit === 'up_to_per_call'
    ? 'Charges up to this amount per call, in USDC on Base mainnet'
    : 'Fixed price per call, in USDC on Base mainnet';
}

/** The 30 days a source's paid-call count covers. */
const USE_WINDOW_MS = 30 * DAY;

/**
 * The source's count can't be used: none given, or 0 although it reports a paid call within the
 * 30 days the count covers (the two disagree, so neither "New" nor "No paid calls" is said).
 */
export function countMissing(usage: FeedUsage, now: number): boolean {
  const calls = usage.paidCalls30d;
  if (calls === null || calls < 0) return true;
  return calls === 0 && usage.lastCalledAt !== null && now - usage.lastCalledAt < USE_WINDOW_MS;
}

/**
 * The card's count: "5,214 uses" or "1 use"; "Not reported" when the source gives no count (or
 * a 0 its own last paid call contradicts); "New" only when it reports none and no paid call ever;
 * "No recent uses" when the last paid call was more than 30 days ago.
 */
export function usesShort(usage: FeedUsage, now = Date.now()): string {
  const calls = usage.paidCalls30d;
  if (calls === null || calls < 0 || countMissing(usage, now)) return 'Not reported';
  if (calls === 0) return usage.lastCalledAt ? 'No recent uses' : 'New';
  return plural(calls, 'use', 'uses');
}

/** Always the source's own count, always said so. */
export function useMain(usage: FeedUsage, now = Date.now()): string {
  const calls = usage.paidCalls30d;
  if (calls === null || calls < 0 || countMissing(usage, now)) return 'Paid calls not reported';
  if (calls === 0) return 'No paid calls reported';
  return `${plural(calls, 'paid call', 'paid calls')} in 30 days`;
}

export function useSub(usage: FeedUsage, now = Date.now()): string {
  const calls = usage.paidCalls30d;
  if (calls === null || calls < 0) return `${usage.reportedBy} lists no 30-day count`;
  if (countMissing(usage, now) && usage.lastCalledAt !== null)
    return `Last paid call ${agoText(usage.lastCalledAt, now)}`;
  if (calls === 0) return `in 30 days, per ${usage.reportedBy}`;
  return `reported by ${usage.reportedBy}`;
}

/** The detail's line: "5,214 paid calls by 93 payers in 30 days". */
export function useFact(usage: FeedUsage, now = Date.now()): string {
  const calls = usage.paidCalls30d;
  if (!calls || calls < 0) return useMain(usage, now);
  const payers = usage.payers30d;
  return `${plural(calls, 'paid call', 'paid calls')}${
    payers && payers > 0 ? ` by ${plural(payers, 'payer', 'payers')}` : ''
  } in 30 days`;
}

/** "query", "query and type", "query, type and limit", "query, type and 3 more". */
function nameList(fields: FeedField[], more: number, requiredFirst: boolean): string | null {
  const ordered = requiredFirst
    ? [...fields.filter((field) => field.required), ...fields.filter((field) => !field.required)]
    : fields;
  const names = ordered.map((field) => plain(field.name)).filter(Boolean);
  if (!names.length) return null;
  const rest = names.length - Math.min(names.length, 3) + more;
  if (rest > 0) return `${names.slice(0, 3).join(', ')} and ${number.format(rest)} more`;
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Input and output in words, for the details: "Takes domain and limit, gives back results."
 * Required fields come first. A side with no field list but an example says it has only the
 * example (shown below under "Show the raw examples"), never that the listing says nothing.
 */
export function ioWords(service: Pick<FeedService, 'input' | 'output'>): string {
  const takes = service.input ? nameList(service.input.fields, service.input.more, true) : null;
  const gives = service.output ? nameList(service.output.fields, service.output.more, false) : null;
  const inExample = !takes && Boolean(service.input?.example);
  const outExample = !gives && Boolean(service.output?.example);
  if (!takes && !gives) {
    if (inExample && outExample)
      return 'The listing gives no field list, only an example request and an example result.';
    if (inExample)
      return 'The listing gives no field list, only an example request. It doesn’t say what it gives back.';
    if (outExample)
      return 'The listing gives no field list, only an example result. It doesn’t say what it takes.';
    return 'The listing doesn’t say what it takes or what it gives back.';
  }
  const first = takes
    ? `Takes ${takes}`
    : inExample
      ? 'The listing gives only an example request'
      : 'The listing doesn’t say what it takes';
  const second = gives
    ? `gives back ${gives}`
    : outExample
      ? 'and only an example result'
      : 'and doesn’t say what it gives back';
  return `${first}, ${second}.`;
}

/** Where the input goes: "in the address", "in the body" or both. */
export function whereText(fields: FeedField[]): string {
  const where = new Set(fields.map((field) => field.in));
  if (where.has('body') && (where.has('query') || where.has('path')))
    return 'in the address and the body';
  if (where.has('body')) return 'in the body';
  if (where.has('query') || where.has('path')) return 'in the address';
  return '';
}

/** "4 fields, in the body". */
export function fieldsHeadNote(summary: FeedService['input']): string {
  if (!summary) return '';
  const count = summary.fields.length + summary.more;
  return [count ? plural(count, 'field', 'fields') : '', whereText(summary.fields)]
    .filter(Boolean)
    .join(', ');
}

/** "string · query · required", the field's facts in plain words. */
export function fieldMeta(field: FeedField): string {
  return [plain(field.type) || 'unknown', field.in ?? ''].filter(Boolean).join(' · ');
}

/** The service address's path parts, without ":param" placeholders ("v1", "pro", "quote"). */
const pathParts = (url: string): string[] => {
  try {
    return new URL(url).pathname
      .split('/')
      .filter((part) => part && !part.startsWith(':'))
      .map((part) => plain(part));
  } catch {
    return [];
  }
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The titles a list shows: a host that repeats one title on several cards ("Otto AI" three times)
 * gets the shortest end of each service's address that tells them apart ("Otto AI ·
 * whois-lookup"; "StableEnrich · exa/search" and "StableEnrich · firecrawl/search"; "3Route ·
 * pro/quote" and "3Route · v1/quote"). A part the title already ends with is not said again
 * ("x402-api.aubr.ai encrypted · literature", never "encrypted · encrypted"). Addresses that are
 * the same to the end are told apart by the method ("GET" and "POST"), then by their order.
 */
export function shownTitles(services: FeedService[]): Map<string, string> {
  const shown = new Map<string, string>();
  const groups = new Map<string, FeedService[]>();
  for (const service of services) {
    const title = shownTitle(service.title) || service.provider.host;
    shown.set(service.id, title);
    const key = `${service.provider.host}\n${title}`;
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const title = shown.get(group[0]!.id)!;
    const titleWords = words(title);
    const parts = group.map((service) => {
      const all = pathParts(service.url);
      // The server's fallback title ("<host> <last part>") already says the last part, so it is
      // not said again, even when it is the only part ("Foo search", never "Foo search · search").
      const last = all.at(-1);
      return last && titleWords.at(-1) === last.toLowerCase() ? all.slice(0, -1) : all;
    });
    // Each service: the fewest last parts that no other service in the group ends with.
    const suffix = (each: string[], count: number) => each.slice(-count).join('/');
    let labels = parts.map((each, index) => {
      for (let count = 1; count < each.length; count++) {
        const mine = suffix(each, count);
        if (parts.every((other, at) => at === index || suffix(other, count) !== mine)) return mine;
      }
      return each.join('/');
    });
    if (new Set(labels).size < labels.length)
      labels = labels.map((label, index) =>
        [group[index]!.method ?? '', label].filter(Boolean).join(' '),
      );
    const seen = new Map<string, number>();
    group.forEach((service, index) => {
      let label = labels[index]!;
      const again = (seen.get(label) ?? 0) + 1;
      seen.set(label, again);
      if (labels.filter((each) => each === label).length > 1) label = `${label} ${again}`.trim();
      shown.set(service.id, label ? `${title} · ${label}` : title);
    });
  }
  return shown;
}

/**
 * Two letters for an avatar (never a picture: no provider images are loaded): the first letters
 * of the first two words ("Twitter/X API" is "TX"), else the first two of one word ("Exa" is
 * "Ex").
 */
export function initialsOf(text: string): string {
  const words = plain(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length > 1) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  const [first = '', second = ''] = Array.from(words[0]!);
  return `${first.toUpperCase()}${second.toLowerCase()}`;
}

/** A service's avatar letters: its listed name, else its title, else its host's first name. */
export function initialOf(service: Pick<FeedService, 'title' | 'provider'>): string {
  return initialsOf(
    plain(service.provider.name) ||
      plain(service.title) ||
      (service.provider.host.replace(/^(?:api|www|x402|app|pro-api)\./, '').split('.')[0] ?? ''),
  );
}

/** "GET /whois-lookup": the service address's method and path, as text. */
export function methodPath(service: Pick<FeedService, 'method' | 'url'>): string {
  let path = '';
  try {
    path = new URL(service.url).pathname;
  } catch {
    path = '';
  }
  return [service.method ?? '', path].filter(Boolean).join(' ');
}

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A provider host as the contract reads one (shared/feed.ts readFeedServiceQuery's HOST). */
export const validHost = (host: string) => HOST.test(host);

/** Hours since the last full read that listed it: the "Not confirmed for 26 h" label. */
export function staleHours(lastSeenAt: number, now: number): number {
  return Math.max(1, Math.floor((now - lastSeenAt) / HOUR));
}

/**
 * Lists never show a risky money listing, whatever the server sends (it hides them too):
 * gold, prepaid cards, money transfers and yield entry (shared/feed.ts feedRiskOf).
 */
export function shownService(service: FeedService): boolean {
  return (
    service.kind === 'external_service' &&
    service.status !== 'withdrawn' &&
    !feedRiskOf(service.title, service.description, service.capabilities.join('\n'))
  );
}

export const SORT_WORDS: Record<FeedServiceSort, string> = {
  relevance: 'most relevant first',
  most_used: 'most used first',
  cheapest: 'cheapest first',
  newest: 'newest first',
};

// ---------------------------------------------------------------------------------------------
// Searched for: requests

/** Whole dollars with thousands separators ("$100,000"); budgetDollars adds the cents. */
const WHOLE_DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * A budget in dollars of USDC: always cents, thousands separated ("$2.50", "$100,000.00"), and
 * exact (a sub-cent budget keeps its digits: "$0.005"). Prices per call stay `dollars`.
 */
export function budgetDollars(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !/^\d{1,30}$/.test(raw)) return null;
  const value = BigInt(raw);
  const cents = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${WHOLE_DOLLARS.format(value / 1_000_000n)}.${cents}`;
}

/** "$25.00" or "Open budget". */
export function budgetMain(budget: FeedBudget | null): string {
  return (budget ? budgetDollars(budget.raw) : null) ?? 'Open budget';
}

export function budgetSub(budget: FeedBudget | null): string {
  return budget && budgetDollars(budget.raw) ? 'in total, in USDC' : 'No budget set';
}

/** The card's time left: "5 h", "1 day", "4 days", "No deadline" or "Deadline passed". */
export function timeLeft(request: Pick<PublicFeedRequest, 'deadline'>, now: number): string {
  if (request.deadline === null) return 'No deadline';
  const left = request.deadline - now;
  if (left <= 0) return 'Deadline passed';
  // Under a day is at most "23 h": "24 h" would read as a day.
  if (left < DAY) return `${Math.min(23, Math.max(1, Math.round(left / HOUR)))} h`;
  const days = Math.floor(left / DAY);
  return days === 1 ? '1 day' : `${days} days`;
}

/** "By Fri 17 Oct" with "4 days left", or "No deadline" with "Open until Mon 27 Oct". */
export function deadlineParts(
  request: Pick<PublicFeedRequest, 'deadline' | 'expiresAt'>,
  now: number,
): { main: string; sub: string } {
  if (request.deadline === null)
    return { main: 'No deadline', sub: `Open until ${dayText(request.expiresAt)}` };
  const left = request.deadline - now;
  // Whole days, as the card's chip counts them (timeLeft): the two always agree.
  const days = Math.floor(left / DAY);
  return {
    main: `By ${dayText(request.deadline)}`,
    sub:
      left <= 0
        ? 'Deadline passed'
        : left < DAY
          ? 'Due within a day'
          : days === 1
            ? '1 day left'
            : `${days} days left`,
  };
}

/**
 * Who posted it, as cards and details name them. The server names the poster from the session:
 * an account posts without a name (displayName null, so "Central City account", never
 * "Anonymous"), an agent under its own name (self-chosen, so "name not verified"; withheld when
 * it breaks a rule), and a signed-out poster under the name they typed, if any ("Unverified ·
 * given by the poster"). `named` says whether `name` is the poster's own words; `note` is what
 * kind of poster, '' when the name already says it.
 */
export function posterParts(postedBy: PublicFeedRequest['postedBy']): {
  name: string;
  named: boolean;
  note: string;
} {
  const given = plain(postedBy.displayName);
  if (postedBy.kind === 'account')
    return given
      ? { name: given, named: true, note: 'Central City account · name not verified' }
      : { name: 'Central City account', named: false, note: '' };
  if (postedBy.kind === 'agent')
    return given
      ? { name: given, named: true, note: 'Central City AI agent · name not verified' }
      : { name: 'Central City AI agent', named: false, note: '' };
  return given
    ? { name: given, named: true, note: 'Unverified · given by the poster' }
    : { name: 'Anonymous', named: false, note: 'No account' };
}

const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HTTPS_LINK = /^https:\/\/[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$/i;

/** A reply handle as the poster gave it: a Base address or a link, both shown as text. */
export function replyKind(reply: string): 'address' | 'link' {
  return BASE_ADDRESS.test(reply.trim()) ? 'address' : 'link';
}

/** Requests the lists show: open, and never a risky money request (the server holds those). */
export function shownRequest(request: PublicFeedRequest): boolean {
  return (
    request.status === 'open' &&
    !feedRiskOf(request.title, request.description, request.capabilities.join('\n'))
  );
}

/**
 * Search words as the server reads them (server/feed/requests.ts tsQuery): runs of letters and
 * digits, two or more long ("invoices,pdf" is "invoices" and "pdf"; at most 8).
 */
export function searchWords(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => Array.from(word).length >= 2)
    .slice(0, 8);
}

/**
 * Whether a request belongs in a list with these filters, read as the server reads them: each
 * search word starts a word of the title, details or tags, and the tag is one of its tags. The
 * tags mirror the server once its search reads them too (#336, migration 105, "text search
 * matches tags"); until that is live the server matches the title and details only.
 */
export function requestMatches(
  request: Pick<PublicFeedRequest, 'title' | 'description' | 'capabilities'>,
  filters: { q: string; tag: string },
): boolean {
  if (filters.tag && !request.capabilities.includes(filters.tag)) return false;
  if (!filters.q.trim()) return true;
  const wanted = searchWords(filters.q);
  // Only one-letter words: the server finds nothing, and so does this.
  if (!wanted.length) return false;
  const have =
    `${request.title} ${request.description} ${request.capabilities.join(' ')}`
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return wanted.every((word) => have.some((each) => each.startsWith(word)));
}

/** How many tags the tag menu offers (a native select: a long list scrolls). */
export const TAG_MENU_MAX = 30;

/** The most used tags of the requests shown, for the tag menu (the chosen one stays). */
export function topTags(
  requests: PublicFeedRequest[],
  chosen: string,
  max = TAG_MENU_MAX,
): string[] {
  const counts = new Map<string, number>();
  for (const request of requests)
    for (const tag of request.capabilities) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
    .filter(validTag)
    .slice(0, max);
  return chosen && !tags.includes(chosen) ? [...tags, chosen] : tags;
}

// ---------------------------------------------------------------------------------------------
// The request form

export interface RequestDraft {
  title: string;
  description: string;
  budget: string;
  /** YYYY-MM-DD from the date field, or ''. */
  deadline: string;
  tags: string;
  /** '' = posted as the signed-in account; else one of its agents' ids. */
  postAs: string;
  /** The public reply handle: a Base address or an https link, or ''. */
  reply: string;
}

export type DraftField = Exclude<keyof RequestDraft, 'postAs'>;

export const EMPTY_DRAFT: RequestDraft = {
  title: '',
  description: '',
  budget: '',
  deadline: '',
  tags: '',
  postAs: '',
  reply: '',
};

/** The order the form shows its fields (and its error summary lists them). */
export const DRAFT_ORDER: DraftField[] = [
  'title',
  'description',
  'budget',
  'deadline',
  'tags',
  'reply',
];

export const FIELD_LABELS: Record<DraftField, string> = {
  title: 'What do you need?',
  description: 'Details',
  budget: 'Budget',
  deadline: 'Deadline',
  tags: 'Tags',
  reply: 'Reply handle',
};

/**
 * A tag as the contract reads one (server/feed/requests.ts TAG; tests/feed-ui.test.ts keeps the
 * two in step): lowercase letters, digits and inner dashes, 1 to 32 characters.
 */
const TAG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const validTag = (tag: string) => TAG.test(tag);

/**
 * The tags as typed: separated by commas only, so "machine learning" is one tag
 * ("machine-learning"), never two.
 */
export function draftTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim().toLowerCase().replace(/^#\s*/, '').replace(/\s+/g, '-'))
        .filter(Boolean),
    ),
  ];
}

/** "2026-10-24" is that day's last minute, local time; null when it is not a date. */
export function deadlineFrom(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 0, 0);
  return Number.isNaN(date.getTime()) || date.getDate() !== Number(match[3])
    ? null
    : date.getTime();
}

/** "YYYY-MM-DD" in local time, for the date field's min and max. */
export function dayValue(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/*
 * The form's contact check is strictly narrower than the server's (server/feed/policy.ts
 * checkRequestText): it flags only what the server always refuses, so it never stops a request
 * the server would take. Everything else (a number after "Call", "Cell" or "Signal", dates, times,
 * grouped amounts, an address with an unusual ending) goes to the server, which decides.
 */

/**
 * A clear international phone number: + or 00 and a country code, then 9 to 15 digits in groups
 * joined by one or two spaces, dots, dashes or brackets ("+49 151 2345678", "+1 (555) 123-4567",
 * "0049 151 2345678", "00 41 44 123 45 67"). It starts the number: nothing but a space, a colon
 * or an opening bracket right before it, and no number earlier in the same run of signs ("10 +49
 * …" is one chain to the server, which may read it as amounts).
 */
const INTERNATIONAL =
  /(?<![\p{N}][\p{L}\p{N}]*[^\p{L}\p{N}]*)(?<=^|[ \t\r\n:([])(?:\+[1-9]|00 ?[1-9])\d*(?:[ .()-]{1,2}\d+)*/gu;

/**
 * Whether a match is a number the server refuses whatever surrounds it. A +: not a list of round
 * increments ("+1000, +2500" stays open), so a first group ending in 00 is left to the server. A 00:
 * the country code is its own group, as the server reads it, and the groups are no rising list of
 * equal length ("001 002 003" are episodes).
 */
function phoneIn(text: string): boolean {
  for (const [match] of text.matchAll(INTERNATIONAL)) {
    const groups = match.match(/\d+/g) ?? [];
    const digits = groups.join('').length;
    if (digits < 9 || digits > 15) continue;
    if (match.startsWith('+')) {
      if (Number(groups[0]) % 100 !== 0) return true;
      continue;
    }
    const prefix =
      groups.length > 1 &&
      (/^00[1-9]\d{0,2}$/.test(groups[0]!) || (groups[0] === '00' && /^[1-9]/.test(groups[1]!)));
    const rising =
      groups.every((group) => group.length === groups[0]!.length) &&
      groups.every((group, i) => i === 0 || Number(group) > Number(groups[i - 1]));
    if (prefix && !rising) return true;
  }
  return false;
}

/**
 * Email endings the server always refuses an address with (a few of its EMAIL_TLDS: an address
 * with another ending, or none, is the server's to read).
 */
const EMAIL_ENDINGS = new Set([
  'com',
  'net',
  'org',
  'info',
  'io',
  'ai',
  'dev',
  'app',
  'co',
  'me',
  'de',
  'uk',
  'us',
  'eu',
  'ch',
  'fr',
  'nl',
  'at',
  'be',
  'it',
  'es',
  'edu',
  'gov',
]);

/** An email address with one of those endings in its domain (a name, an at sign, then example.com; never an image name such as icon, an at sign, 2x.png). */
function emailIn(text: string): boolean {
  if (!text.includes('@')) return false;
  for (const [address] of text.matchAll(
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
  ))
    if (
      address
        .slice(address.indexOf('@') + 1)
        .split('.')
        .slice(1)
        .some((label) => EMAIL_ENDINGS.has(label.toLowerCase()))
    )
      return true;
  return false;
}

/**
 * The text as the server checks it (server/feed/policy.ts cleanText, then foldForChecks): blank
 * looking letters a space, invisible characters dropped, spaces collapsed, NFKC, ideographic full
 * stops a dot. Nothing hidden between two characters makes this check see more than the server.
 */
const checkedCopy = (text: string) =>
  text
    .normalize('NFC')
    .replace(/[\u115f\u1160\u2800\u3164\uffa0]/gu, ' ')
    .replace(
      /[\p{Cf}\p{Default_Ignorable_Code_Point}\u034f\u17b4\u17b5\u2028\u2029]|(?![\n\t])\p{Cc}/gu,
      '',
    )
    .replace(/[^\S\n]+/g, ' ')
    .normalize('NFKC')
    .replace(/[。．｡]/g, '.');

/**
 * Contact data and secrets: everything in a request is public (the server refuses them too). Only
 * the shapes are checked here (an email address, a clear international phone number, a 64-hex
 * private key): words such as "private key" or "seed phrase" are fine in a request about them.
 */
function contactIn(text: string): boolean {
  const copy = checkedCopy(text);
  return emailIn(copy) || phoneIn(copy) || /\b0x[0-9a-f]{64}\b/i.test(copy);
}

/** Central City's own domain and its subdomains (server/results/sources.ts APP_DOMAIN). */
const CENTRAL_CITY_DOMAIN = 'centralcity.ai';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * The only Central City paths the server takes as a reply handle (server/results/sources.ts
 * APP_ALLOWED): a published result and an agent's A2A address (or its agent card).
 */
const CENTRAL_CITY_ALLOWED = [
  new RegExp(`^/results/${UUID}/?$`, 'i'),
  new RegExp(`^/a2a/${UUID}(?:/\\.well-known/agent-card\\.json)?/?$`, 'i'),
];

const hostOf = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^www\./, '');

/**
 * A Central City link that can't be a reply handle. On centralcity.ai and its subdomains the
 * server (server/feed/policy.ts checkReply, by the results source rules) refuses every path but a
 * result (/results/<id>) and an agent (/a2a/<id>), so a join or room link never grants access
 * through a public request; the form allows exactly those two. This site's own host when it is
 * another deployment (a preview) is refused outright: its join links grant room access there too.
 */
export function centralCityLink(reply: string, siteHost = ''): boolean {
  if (!/^https:\/\//i.test(reply.trim())) return false;
  let url: URL;
  try {
    url = new URL(reply.trim());
  } catch {
    return false;
  }
  const host = hostOf(url.hostname);
  const own = hostOf(siteHost);
  if (host === CENTRAL_CITY_DOMAIN || host.endsWith(`.${CENTRAL_CITY_DOMAIN}`))
    return !CENTRAL_CITY_ALLOWED.some((pattern) => pattern.test(url.pathname));
  return own !== '' && host === own;
}

/**
 * What the form checks before it sends (the server checks again): a plain sentence per field.
 * `siteHost` is this site's own host name (a preview's own links are refused as a reply handle).
 */
export function draftProblems(
  draft: RequestDraft,
  now: number,
  siteHost = '',
): Partial<Record<DraftField, string>> {
  const problems: Partial<Record<DraftField, string>> = {};
  const title = draft.title.trim();
  const description = draft.description.trim();
  if (codePoints(title) < FEED_LIMITS.requestTitleMin)
    problems.title = `Add a title of at least ${FEED_LIMITS.requestTitleMin} characters.`;
  else if (codePoints(title) > FEED_LIMITS.requestTitleMax)
    problems.title = `Keep the title to ${FEED_LIMITS.requestTitleMax} characters.`;
  else if (/https?:\/\/|www\./i.test(title))
    problems.title = 'Put links in the details, not the title.';
  if (!description) problems.description = 'Say in a few words what you need.';
  else if (codePoints(description) > FEED_LIMITS.requestDescriptionMax)
    problems.description = `Keep the details to ${number.format(FEED_LIMITS.requestDescriptionMax)} characters.`;
  else {
    const links = description.match(/https?:\/\/\S+/gi) ?? [];
    if (links.length > 2) problems.description = 'Use at most 2 links.';
    else if (links.some((link) => !/^https:\/\//i.test(link)))
      problems.description = 'Links must start with https://.';
  }
  const secret = 'Remove the email, phone number or key. Everything here is public.';
  if (!problems.title && contactIn(title)) problems.title = secret;
  if (!problems.description && contactIn(description)) problems.description = secret;
  if (draft.budget.trim()) {
    const raw = usdcToRaw(draft.budget);
    const cap = BigInt(usdcToRaw(FEED_LIMITS.budgetMaxUsdc)!);
    if (raw === null || BigInt(raw) <= 0n)
      problems.budget = 'Write a number of USDC, like 25 or 2.50.';
    else if (BigInt(raw) > cap)
      problems.budget = `The budget can be at most ${number.format(Number(FEED_LIMITS.budgetMaxUsdc))} USDC.`;
  }
  if (draft.deadline) {
    const deadline = deadlineFrom(draft.deadline);
    if (deadline === null) problems.deadline = 'Pick a date.';
    else if (deadline < now + FEED_LIMITS.deadlineMinMs)
      problems.deadline = 'Pick a date at least an hour from now.';
    else if (deadline > now + FEED_LIMITS.requestTtlMaxMs)
      problems.deadline = 'Pick a date within 30 days.';
  }
  const tags = draftTags(draft.tags);
  if (tags.length > FEED_LIMITS.requestTagsMax)
    problems.tags = `Use up to ${FEED_LIMITS.requestTagsMax} tags.`;
  else if (tags.some((tag) => !TAG.test(tag)))
    problems.tags = 'Tags can use letters, digits and dashes.';
  else if (contactIn(draft.tags)) problems.tags = secret;
  const reply = draft.reply.trim();
  if (
    reply &&
    (codePoints(reply) > FEED_LIMITS.replyMax ||
      !(BASE_ADDRESS.test(reply) || HTTPS_LINK.test(reply)))
  )
    problems.reply =
      'Use a Base address (0x and 40 characters) or a link that starts with https://.';
  else if (reply && centralCityLink(reply, siteHost))
    problems.reply =
      'Only Central City result and agent links can be a reply handle. Use a Base address or another https page.';
  return problems;
}

/**
 * The session ended while the form was open: the form said "Posted from your account" (no agent
 * chosen), but the server, which names the poster from the session, did not post as an account.
 */
export function postedWithoutAccount(postAs: string, posted: PostedFeedRequest): boolean {
  return !postAs && posted.request.postedBy.kind !== 'account';
}

/** The body the form sends. `website` is the hidden field: sent only when something filled it. */
export function requestBody(
  draft: RequestDraft,
  idempotencyKey: string,
  website = '',
): FeedRequestPost {
  const tags = draftTags(draft.tags);
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    ...(tags.length ? { capabilities: tags } : {}),
    budgetUsdc: draft.budget.trim() || null,
    deadline: draft.deadline ? deadlineFrom(draft.deadline) : null,
    reply: draft.reply.trim() || null,
    agentId: draft.postAs || null,
    idempotencyKey,
    ...(website ? { website } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The private link that closes a request

/** `${origin}/feed/requests/<id>/manage#ccf_…`: the token rides in the fragment, never sent. */
export function manageLink(origin: string, requestId: string, manageToken: string): string {
  return `${origin}${feedHref.manage(requestId)}#${manageToken}`;
}
