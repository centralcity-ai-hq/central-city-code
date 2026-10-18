import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FEED_CLIENT_PATHS,
  FEED_HOSTED_SOURCE,
  FEED_LIMITS,
  FEED_PATHS,
  FEED_SOURCE,
  FEED_USDC,
  type FeedService,
  type FeedServicePage,
  type FeedStatus,
  type PublicFeedRequest,
} from '../shared/feed.js';
import { CLIENT_ROUTES, isClientRoute } from '../shared/routes.js';
import { checkReply, checkRequestText } from '../server/feed/policy.js';
import { FEED_CAPS_DEFAULT, readFeedRequestQuery } from '../server/feed/requests.js';
import { selectWorkspace } from '../src/api.js';
import { createHttpRoomsClient, type RoomsClient } from '../src/rooms/api.js';
import { NewRoomSheet } from '../src/rooms/NewRoomSheet.js';
import {
  ROOMS_SHEET_PREFILL,
  ROOMS_SHEET_STATE,
  roomsSheetState,
  takeRoomsSheet,
} from '../src/shell/sidebarRooms.js';
import {
  alreadyClosed,
  closeRequest,
  failureOf,
  feedErrorCopy,
  FeedFailure,
  getRequests,
  getService,
  getServices,
  NO_OFFERED_FILTERS,
  NO_REQUEST_FILTERS,
  offeredSearch,
  freshParam,
  postKey,
  READ_TIMEOUT_MS,
  postRequest,
  readOfferedFilters,
  readRequestFilters,
  requestSearch,
  SAID_MAX,
  serverSentence,
  sortOf,
  withDeadline,
  writeHeaders,
  type FeedAction,
  type FeedFailureCode,
} from '../src/feed/feedApi.js';
import {
  agoText,
  budgetDollars,
  budgetMain,
  budgetSub,
  centralCityLink,
  deadlineFrom,
  deadlineParts,
  draftProblems,
  draftTags,
  EMPTY_DRAFT,
  EXTERNAL_LABEL,
  initialOf,
  initialsOf,
  ioWords,
  manageLink,
  methodPath,
  plain,
  posterParts,
  postedWithoutAccount,
  priceMain,
  priceRule,
  priceSub,
  readManageToken,
  replyKind,
  requestBody,
  shownRequest,
  shownService,
  shownDescription,
  shownTitle,
  shownTitles,
  countMissing,
  dollars,
  requestMatches,
  searchWords,
  staleHours,
  TAG_MENU_MAX,
  timeLeft,
  topTags,
  useFact,
  useMain,
  useSub,
  usesShort,
  utcText,
  validTag,
  whereText,
} from '../src/feed/feedFormat.js';
import {
  closeOverList,
  drawerOpen,
  goTo,
  leaveOverList,
  listBehind,
  openOverList,
} from '../src/feed/feedNav.js';
import { askFeedSignIn, leaveFeedSignIn, signInActionOf } from '../src/feed/feedSignIn.js';
import {
  captureManageCode,
  FEED_PATH,
  feedHref,
  feedRoute,
  forgetFeedSession,
  heldManageCode,
} from '../src/feed/feedPaths.js';
import { addMine, mineEntry, resetMine } from '../src/feed/mine.js';
import {
  FEED_GATE_RETRY_MS,
  FEED_GATE_TIMEOUT_MS,
  FEED_SIDEBAR_RETRY_MS,
  FEED_STATUS_PATH,
  feedShown,
  knownFeedGate,
  loadFeedGate,
  resetFeedGate,
  retryFeedGate,
} from '../src/feed/feedStatus.js';
import { offeredCount } from '../src/feed/OfferedView.js';
import { ACCOUNT_POST_CAPS, PostedCard, PostRequestForm } from '../src/feed/PostRequestForm.js';
import {
  posterChip,
  RequestCard,
  RequestDetail,
  RequestRow,
  REPORT_FINE_PRINT,
  RespondBody,
  roomPrefill,
  tagHref,
} from '../src/feed/RequestItem.js';
import { exampleText, ServiceCard, ServiceDetail } from '../src/feed/ServiceItem.js';
import { FeedSignedIn } from '../src/feed/FeedParts.js';

/*
 * The Feed's browser side (src/feed): its addresses, words and numbers, the data layer's failures
 * and retries, the flag gate, the request form's checks, and the cards as markup. Made-up
 * values only.
 */

const NOW = Date.UTC(2026, 9, 13, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function service(overrides: Partial<FeedService> = {}): FeedService {
  return {
    id: 'svc_abcdefghijklmnopqrst',
    kind: 'external_service',
    title: 'Domain lookup',
    capabilities: ['whois', 'rdap'],
    description: 'Registration data for any domain.',
    provider: { host: 'lookup.example.com', name: 'Lookup' },
    url: 'https://lookup.example.com/v1/whois',
    method: 'GET',
    protocol: 'x402',
    x402Version: 2,
    network: 'eip155:8453',
    asset: FEED_USDC,
    scheme: 'exact',
    price: { raw: '1000', decimals: 6, display: '0.001', unit: 'per_call' },
    payTo: '0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808',
    input: {
      format: 'json',
      fields: [
        { name: 'limit', in: 'query', type: 'integer', required: false, description: '' },
        { name: 'domain', in: 'query', type: 'string', required: true, description: 'The name' },
      ],
      more: 0,
      example: null,
      exampleState: null,
    },
    output: { format: 'json', fields: [], more: 0, example: null, exampleState: null },
    source: {
      name: FEED_SOURCE.name,
      credit: FEED_SOURCE.credit,
      url: FEED_SOURCE.url,
      recordId: 'https://lookup.example.com/v1/whois',
      fetchedAt: NOW - 12 * MINUTE,
      updatedAt: null,
    },
    usage: { paidCalls30d: 11, payers30d: 7, lastCalledAt: null, reportedBy: 'x402 Bazaar' },
    lastSeenAt: NOW - 12 * MINUTE,
    status: 'active',
    moreFromHost: 0,
    ...overrides,
  };
}

function request(overrides: Partial<PublicFeedRequest> = {}): PublicFeedRequest {
  return {
    id: 'req_aaaaaaaaaaaaaaaaaaa2',
    title: 'Summarise invoices',
    description: 'Forty PDFs into one table.',
    capabilities: ['pdf'],
    budget: null,
    deadline: null,
    reply: null,
    postedBy: { kind: 'anonymous', displayName: null },
    status: 'open',
    createdAt: NOW - 2 * HOUR,
    expiresAt: NOW + 14 * DAY,
    closedAt: null,
    ...overrides,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const budget = (raw: string, display: string) =>
  ({ raw, decimals: 6, display, asset: 'USDC', network: 'eip155:8453' }) as const;

// -------------------------------------------------------------------------------------------
// Addresses

test('the Feed’s addresses are the contract’s client paths, and every one is a client route', () => {
  const routes = new Set(CLIENT_ROUTES.map((route) => route.path));
  for (const path of Object.values(FEED_CLIENT_PATHS)) assert.ok(routes.has(path), path);
  assert.equal(feedHref.offered, FEED_CLIENT_PATHS.offered);
  assert.equal(feedHref.requests, FEED_CLIENT_PATHS.searchedFor);
  const id = 'req_abcdefghijklmnopqrst';
  assert.equal(feedHref.request(id), FEED_CLIENT_PATHS.request.replace(':id', id));
  assert.equal(feedHref.manage(id), FEED_CLIENT_PATHS.manage.replace(':id', id));
  const svc = 'svc_abcdefghijklmnopqrst';
  assert.equal(feedHref.service(svc), FEED_CLIENT_PATHS.service.replace(':id', svc));
  for (const path of [
    feedHref.offered,
    feedHref.requests,
    feedHref.request(id),
    feedHref.manage(id),
    feedHref.service(svc),
  ]) {
    assert.ok(FEED_PATH.test(path), path);
    assert.ok(isClientRoute(path), path);
  }
  assert.equal(FEED_STATUS_PATH, FEED_PATHS.status);
});

test('feedRoute reads every Feed address and nothing else', () => {
  assert.deepEqual(feedRoute('/feed'), { view: 'offered' });
  assert.deepEqual(feedRoute('/feed/'), { view: 'offered' });
  assert.deepEqual(feedRoute('/feed/requests'), { view: 'requests' });
  assert.deepEqual(feedRoute('/feed/requests/req_abcdefghijklmnopqrst'), {
    view: 'request',
    id: 'req_abcdefghijklmnopqrst',
  });
  assert.deepEqual(feedRoute('/feed/requests/req_abcdefghijklmnopqrst/manage'), {
    view: 'manage',
    id: 'req_abcdefghijklmnopqrst',
  });
  assert.deepEqual(feedRoute('/feed/services/svc_abcdefghijklmnopqrst'), {
    view: 'service',
    id: 'svc_abcdefghijklmnopqrst',
  });
  for (const path of [
    '/feed/services',
    '/feed/services/a.b',
    '/feed/requests/x/close',
    '/feed/offered',
    '/feedx',
    '/rooms',
  ])
    assert.equal(feedRoute(path), null, path);
});

test('a drawer entry names the Feed list it covers; anything else is no drawer entry', () => {
  assert.equal(listBehind({ feedList: '/feed?sort=cheapest' }), '/feed?sort=cheapest');
  assert.equal(listBehind({ feedList: '/feed', ccEntry: 'k1' }), '/feed');
  for (const state of [
    null,
    undefined,
    'feedList',
    {},
    { feedList: 3 },
    { feedList: '/feedback' },
    { feedList: '/rooms' },
    { feedList: 'https://example.com/feed' },
    { feedList: '//example.com/feed' },
  ])
    assert.equal(listBehind(state), null, JSON.stringify(state));
});

// -------------------------------------------------------------------------------------------
// Words and numbers: Offered

test('prices are exact dollars of USDC; unknown is never free', () => {
  const price = (raw: string, unit: 'per_call' | 'up_to_per_call' = 'per_call') => ({
    raw,
    decimals: 6 as const,
    display: '',
    unit,
  });
  assert.equal(priceMain(price('7000')), '$0.007');
  assert.equal(priceMain(price('10000')), '$0.01');
  assert.equal(priceMain(price('5500')), '$0.0055');
  assert.equal(priceMain(price('2500000')), '$2.5');
  assert.equal(priceMain(price('50000', 'up_to_per_call')), 'Up to $0.05');
  assert.equal(priceSub(price('7000')), 'per call, in USDC');
  assert.equal(priceMain(null), 'Price unknown');
  assert.equal(priceSub(null), 'not in the listing');
  assert.equal(priceMain(price('-1')), 'Price unknown');
  assert.equal(priceMain(price('0.5')), 'Price unknown');
  assert.equal(priceRule(null), 'The listing gives no amount, so it never counts as free');
  assert.match(priceRule(price('7000', 'up_to_per_call')), /^Charges up to this amount/);
});

test('use is always the source’s count, and says so; none is never 0', () => {
  const usage = (
    paidCalls30d: number | null,
    payers30d: number | null = null,
    lastCalledAt: number | null = null,
  ) => ({
    paidCalls30d,
    payers30d,
    lastCalledAt,
    reportedBy: 'x402 Bazaar' as const,
  });
  assert.equal(useMain(usage(5214)), '5,214 paid calls in 30 days');
  assert.equal(useSub(usage(5214)), 'reported by x402 Bazaar');
  assert.equal(useMain(usage(1)), '1 paid call in 30 days');
  assert.equal(useMain(usage(0)), 'No paid calls reported');
  assert.equal(useSub(usage(0)), 'in 30 days, per x402 Bazaar');
  assert.equal(useMain(usage(null)), 'Paid calls not reported');
  assert.equal(useSub(usage(null)), 'x402 Bazaar lists no 30-day count');
  assert.equal(useFact(usage(5214, 93)), '5,214 paid calls by 93 payers in 30 days');
  assert.equal(useFact(usage(null)), 'Paid calls not reported');
  // The card's short count, never 0: "New" only when none is reported and none was ever made.
  assert.equal(usesShort(usage(5214)), '5,214 uses');
  assert.equal(usesShort(usage(1)), '1 use');
  assert.equal(usesShort(usage(0)), 'New');
  assert.equal(usesShort(usage(0, null, NOW - 40 * DAY)), 'No recent uses');
  // No count from the source is not new: it may have been paid a moment ago.
  assert.equal(usesShort(usage(null)), 'Not reported');
  assert.equal(usesShort(usage(null, null, NOW - 4 * HOUR)), 'Not reported');
  assert.equal(usesShort(usage(-1)), 'Not reported');
});

test('times: ages, days and the source’s UTC read time', () => {
  assert.equal(agoText(NOW, NOW), 'just now');
  assert.equal(agoText(NOW + MINUTE, NOW), 'just now');
  assert.equal(agoText(NOW - 12 * MINUTE, NOW), '12 min ago');
  assert.equal(agoText(NOW - 3 * HOUR, NOW), '3 h ago');
  assert.equal(agoText(NOW - 26 * HOUR, NOW), '1 day ago');
  assert.equal(agoText(NOW - 3 * DAY, NOW), '3 days ago');
  assert.equal(utcText(Date.UTC(2026, 9, 12, 17, 10)), '12 Oct, 17:10 UTC');
  assert.equal(staleHours(NOW - 26 * HOUR - 5 * MINUTE, NOW), 26);
});

test('input and output in words, required fields first; where the input goes', () => {
  assert.equal(ioWords(service()), 'Takes domain and limit, and doesn’t say what it gives back.');
  const many = service({
    input: {
      format: 'json',
      fields: ['a', 'b', 'c', 'd'].map((name) => ({
        name,
        in: 'body' as const,
        type: 'string',
        required: name === 'd',
        description: '',
      })),
      more: 2,
      example: null,
      exampleState: null,
    },
    output: {
      format: 'json',
      fields: [{ name: 'results', in: null, type: 'array', required: false, description: '' }],
      more: 0,
      example: null,
      exampleState: null,
    },
  });
  assert.equal(ioWords(many), 'Takes d, a, b and 3 more, gives back results.');
  assert.equal(
    ioWords(service({ input: null, output: null })),
    'The listing doesn’t say what it takes or what it gives back.',
  );
  assert.doesNotMatch(ioWords(many), /[\u2190-\u21ff]/);
  assert.equal(whereText(service().input!.fields), 'in the address');
  assert.equal(whereText(many.input!.fields), 'in the body');
  assert.equal(methodPath(service()), 'GET /v1/whois');
});

test('a host that repeats a title gets the address’s last part; avatars are two letters', () => {
  const a = service({
    id: 'svc_aaaaaaaaaaaaaaaaaaaa',
    title: 'Otto AI',
    url: 'https://x.example.com/whois-lookup',
  });
  const b = service({
    id: 'svc_bbbbbbbbbbbbbbbbbbbb',
    title: 'Otto AI',
    url: 'https://x.example.com/rdap',
  });
  const c = service({ id: 'svc_cccccccccccccccccccc', title: 'Exa' });
  const titles = shownTitles([a, b, c]);
  assert.equal(titles.get(a.id), 'Otto AI · whois-lookup');
  assert.equal(titles.get(b.id), 'Otto AI · rdap');
  assert.equal(titles.get(c.id), 'Exa');
  // The last part repeats too: each card gets the fewest last parts no other card ends with.
  const enrich = (id: string, path: string) =>
    service({
      id,
      title: 'StableEnrich',
      provider: { host: 'stableenrich.dev', name: 'StableEnrich' },
      url: `https://stableenrich.dev${path}`,
    });
  const exa = enrich('svc_dddddddddddddddddddd', '/api/exa/search');
  const firecrawl = enrich('svc_eeeeeeeeeeeeeeeeeeee', '/api/firecrawl/search');
  const scrape = enrich('svc_ffffffffffffffffffff', '/api/firecrawl/scrape');
  const enriched = shownTitles([exa, firecrawl, scrape]);
  assert.equal(enriched.get(exa.id), 'StableEnrich · exa/search');
  assert.equal(enriched.get(firecrawl.id), 'StableEnrich · firecrawl/search');
  assert.equal(enriched.get(scrape.id), 'StableEnrich · scrape');
  assert.equal(new Set(enriched.values()).size, 3);
  // Production pairs: never the same title twice, and never "encrypted · encrypted".
  const pair = (
    host: string,
    title: string,
    paths: string[],
    method: FeedService['method'] = 'POST',
  ) =>
    shownTitles(
      paths.map((path, index) =>
        service({
          id: `svc_${String.fromCharCode(97 + index).repeat(20)}`,
          title,
          method,
          provider: { host, name: null },
          url: `https://${host}${path}`,
        }),
      ),
    );
  assert.deepEqual(
    [
      ...pair('api.solenrich.com', 'SolEnrich', [
        '/entrypoints/stonk-yield/invoke',
        '/entrypoints/stonk-alerts/invoke',
      ]).values(),
    ],
    ['SolEnrich · stonk-yield/invoke', 'SolEnrich · stonk-alerts/invoke'],
  );
  assert.deepEqual(
    [...pair('api.3route.io', '3Route', ['/v1/:chainId/quote', '/v1/pro/:chainId/quote']).values()],
    ['3Route · v1/quote', '3Route · pro/quote'],
  );
  assert.deepEqual(
    [
      ...pair('x402-api.aubr.ai', 'x402-api.aubr.ai encrypted', [
        '/api/literature/encrypted',
        '/api/chat/encrypted',
      ]).values(),
    ],
    ['x402-api.aubr.ai encrypted · literature', 'x402-api.aubr.ai encrypted · chat'],
  );
  // The same address twice: the method tells them apart, then the order.
  const same = pair('a.example.com', 'A', ['/run', '/run']);
  assert.equal(new Set(same.values()).size, 2);
  assert.ok([...same.values()].every((title) => /^A · POST run \d$/.test(title)));
  // A title the source left with an open parenthesis is closed (display only).
  assert.equal(shownTitle('Forecast (simple exponential'), 'Forecast (simple exponential…)');
  assert.equal(shownTitle('Chat completions - metered ('), 'Chat completions - metered');
  assert.equal(shownTitle('Fine (balanced) title'), 'Fine (balanced) title');
  assert.equal(
    shownTitles([service({ title: 'Forecast (simple exponential' })]).get(service().id),
    'Forecast (simple exponential…)',
  );
  assert.equal(initialOf(service({ provider: { host: 'api.exa.ai', name: 'Exa' } })), 'Ex');
  assert.equal(
    initialOf(service({ provider: { host: 'x.example', name: 'Twitter/X API' } })),
    'TX',
  );
  assert.equal(
    initialOf(service({ title: '', provider: { host: 'api.onesource.io', name: null } })),
    'On',
  );
  assert.equal(initialsOf('  '), '?');
});

test('provider and poster text is plain: no invisible or control characters', () => {
  assert.equal(plain('Hi\u202Ethere\u200B\u0007'), 'Hithere');
  assert.equal(plain('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(plain(null), '');
});

test('lists never show a risky money listing, a withdrawn one, or a request not open', () => {
  assert.equal(shownService(service()), true);
  assert.equal(shownService(service({ status: 'withdrawn' })), false);
  assert.equal(shownService(service({ title: 'Buy prepaid cards with USDC' })), false);
  assert.equal(shownRequest(request()), true);
  assert.equal(shownRequest(request({ status: 'held' })), false);
  assert.equal(shownRequest(request({ status: 'closed' })), false);
  assert.equal(shownRequest(request({ title: 'Send money to my Venmo' })), false);
});

test('the Offered count: the total and how many show; with filters, how many match', () => {
  const page = (total: number | null, next: string | null = null): FeedServicePage => ({
    snapshotAt: NOW,
    degraded: false,
    sources: [],
    services: [],
    next,
    total,
  });
  assert.equal(offeredCount(NO_OFFERED_FILTERS, page(32061), 24), '32,061 services · showing 24');
  assert.equal(offeredCount(NO_OFFERED_FILTERS, page(13), 13), '13 services');
  assert.equal(offeredCount({ ...NO_OFFERED_FILTERS, q: 'pdf' }, page(3), 3), '3 services match');
  assert.equal(offeredCount({ ...NO_OFFERED_FILTERS, q: 'pdf' }, page(1), 1), '1 service matches');
  assert.equal(
    offeredCount(
      { ...NO_OFFERED_FILTERS, maxPrice: '0.01', sort: 'cheapest' },
      page(null, 'p2'),
      24,
    ),
    '24+ services match',
  );
  assert.equal(
    offeredCount({ ...NO_OFFERED_FILTERS, host: 'x.example.com' }, page(47), 24),
    '47 services match · showing 24',
  );
});

test('filters in the address: the default sort stays out, Relevance needs words', () => {
  assert.equal(offeredSearch(NO_OFFERED_FILTERS), '');
  assert.equal(offeredSearch({ ...NO_OFFERED_FILTERS, q: ' pdf ' }), '?q=pdf');
  assert.equal(offeredSearch({ ...NO_OFFERED_FILTERS, sort: 'relevance' }), '');
  assert.equal(sortOf({ ...NO_OFFERED_FILTERS, sort: 'relevance' }), 'most_used');
  assert.equal(
    offeredSearch({ q: 'pdf', maxPrice: '0.05', sort: 'cheapest', host: 'a.example.com' }, 'p2'),
    '?q=pdf&max_price=0.05&sort=cheapest&host=a.example.com&cursor=p2',
  );
  assert.deepEqual(readOfferedFilters('?q=pdf&sort=nonsense&host=A.Example.COM'), {
    q: 'pdf',
    maxPrice: '',
    sort: '',
    host: 'a.example.com',
  });
  // The server ignores a host that is not one; the page never shows it as a filter either.
  for (const host of ['Central City verified', 'localhost', 'a..example.com', '-a.example.com'])
    assert.equal(readOfferedFilters(`?host=${encodeURIComponent(host)}`).host, '', host);
  assert.equal(requestSearch({ q: 'ocr', tag: 'pdf' }), '?q=ocr&tag=pdf');
  assert.deepEqual(readRequestFilters('?tag=PDF'), { q: '', tag: 'pdf' });
});

test('filter text from the address bar is plain, and a tag the contract can’t read is no filter', () => {
  const hidden = encodeURIComponent('pdf\u202E\u200B  to\u0007 text\n');
  assert.equal(readOfferedFilters(`?q=${hidden}`).q, 'pdf to text');
  assert.equal(readRequestFilters(`?q=${hidden}`).q, 'pdf to text');
  // As long as the server reads a search, no longer.
  assert.equal(readRequestFilters(`?q=${'a'.repeat(500)}`).q.length, FEED_LIMITS.queryMax);
  assert.equal(readOfferedFilters(`?q=${'a'.repeat(500)}`).q.length, FEED_LIMITS.queryMax);
  for (const tag of ['-pdf', 'pdf-', 'p d f', 'pdf!', 'a'.repeat(33), '<b>', 'ünï'])
    assert.equal(readRequestFilters(`?tag=${encodeURIComponent(tag)}`).tag, '', tag);
  assert.equal(readRequestFilters('?tag=web-scraping').tag, 'web-scraping');
  // The same pattern as the server's: every tag the page keeps, the server reads, and the other
  // way round.
  for (const tag of [
    'pdf',
    'web-scraping',
    'a',
    '9',
    'a'.repeat(32),
    '-pdf',
    'pdf-',
    'a--b',
    'a_b',
  ])
    assert.equal(
      validTag(tag),
      readFeedRequestQuery({ tag }) !== null,
      `${tag}: page ${validTag(tag)}`,
    );
});

// -------------------------------------------------------------------------------------------
// Words and numbers: Searched for

test('budgets, deadlines, posters and reply handles', () => {
  assert.equal(budgetMain(budget('25000000', '25')), '$25.00');
  assert.equal(budgetSub(budget('25000000', '25')), 'in total, in USDC');
  assert.equal(budgetMain(null), 'Open budget');
  assert.equal(budgetSub(null), 'No budget set');
  // The card's time left.
  assert.equal(timeLeft({ deadline: null }, NOW), 'No deadline');
  assert.equal(timeLeft({ deadline: NOW + 5 * HOUR }, NOW), '5 h');
  assert.equal(timeLeft({ deadline: NOW + DAY + HOUR }, NOW), '1 day');
  assert.equal(timeLeft({ deadline: NOW + 4 * DAY + HOUR }, NOW), '4 days');
  assert.equal(timeLeft({ deadline: NOW - MINUTE }, NOW), 'Deadline passed');
  assert.deepEqual(deadlineParts({ deadline: NOW + 4 * DAY, expiresAt: NOW + 4 * DAY }, NOW), {
    main: `By ${new Date(NOW + 4 * DAY).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`,
    sub: '4 days left',
  });
  assert.equal(
    deadlineParts({ deadline: NOW + 5 * HOUR, expiresAt: NOW }, NOW).sub,
    'Due within a day',
  );
  assert.equal(deadlineParts({ deadline: null, expiresAt: NOW + DAY }, NOW).main, 'No deadline');
  assert.match(deadlineParts({ deadline: null, expiresAt: NOW + DAY }, NOW).sub, /^Open until /);
  assert.deepEqual(posterParts({ kind: 'anonymous', displayName: null }), {
    name: 'Anonymous',
    named: false,
    note: 'No account',
  });
  assert.deepEqual(posterParts({ kind: 'anonymous', displayName: 'Mara' }), {
    name: 'Mara',
    named: true,
    note: 'Unverified · given by the poster',
  });
  // The server posts an account without its name: its kind names it, never "Anonymous".
  assert.deepEqual(posterParts({ kind: 'account', displayName: null }), {
    name: 'Central City account',
    named: false,
    note: '',
  });
  // An agent's name is withheld when it breaks a rule: its kind names it then.
  assert.deepEqual(posterParts({ kind: 'agent', displayName: null }), {
    name: 'Central City AI agent',
    named: false,
    note: '',
  });
  // Every name is the poster's own choice: an account's or an agent's says so too.
  assert.deepEqual(posterParts({ kind: 'account', displayName: 'Ada' }), {
    name: 'Ada',
    named: true,
    note: 'Central City account · name not verified',
  });
  assert.deepEqual(posterParts({ kind: 'agent', displayName: 'Ledger Scout' }), {
    name: 'Ledger Scout',
    named: true,
    note: 'Central City AI agent · name not verified',
  });
  assert.equal(replyKind(`0x${'a'.repeat(40)}`), 'address');
  assert.equal(replyKind('https://example.com/me'), 'link');
  assert.deepEqual(
    topTags([request({ capabilities: ['pdf', 'ocr'] }), request({ capabilities: ['pdf'] })], 'x'),
    ['pdf', 'ocr', 'x'],
  );
});

// -------------------------------------------------------------------------------------------
// The request form

test('the form checks what it can before sending', () => {
  const now = NOW;
  const ok = { ...EMPTY_DRAFT, title: 'Check 200 links', description: 'Every broken link.' };
  assert.deepEqual(draftProblems(ok, now), {});
  const empty = draftProblems(EMPTY_DRAFT, now);
  assert.equal(empty.title, 'Add a title of at least 5 characters.');
  assert.equal(empty.description, 'Say in a few words what you need.');
  assert.equal(
    draftProblems({ ...ok, title: 'See https://example.com now' }, now).title,
    'Put links in the details, not the title.',
  );
  assert.equal(
    draftProblems(
      { ...ok, description: 'https://a.example https://b.example https://c.example' },
      now,
    ).description,
    'Use at most 2 links.',
  );
  assert.equal(
    draftProblems({ ...ok, description: 'See http://a.example' }, now).description,
    'Links must start with https://.',
  );
  assert.equal(
    draftProblems({ ...ok, description: 'Mail me at ada@example.com' }, now).description,
    'Remove the email, phone number or key. Everything here is public.',
  );
  assert.equal(
    draftProblems({ ...ok, description: 'Call +49 170 1234567' }, now).description,
    'Remove the email, phone number or key. Everything here is public.',
  );
  assert.equal(
    draftProblems({ ...ok, budget: '12.555555555' }, now).budget,
    'Write a number of USDC, like 25 or 2.50.',
  );
  assert.equal(
    draftProblems({ ...ok, budget: '0' }, now).budget,
    'Write a number of USDC, like 25 or 2.50.',
  );
  assert.equal(
    draftProblems({ ...ok, budget: '100001' }, now).budget,
    'The budget can be at most 100,000 USDC.',
  );
  assert.deepEqual(draftProblems({ ...ok, budget: '2.50' }, now), {});
  assert.equal(draftProblems({ ...ok, tags: 'a, b, c, d, e, f' }, now).tags, 'Use up to 5 tags.');
  assert.equal(
    draftProblems({ ...ok, tags: 'pdf, ünï' }, now).tags,
    'Tags can use letters, digits and dashes.',
  );
  assert.equal(
    draftProblems({ ...ok, reply: 'ada@example.com' }, now).reply,
    'Use a Base address (0x and 40 characters) or a link that starts with https://.',
  );
  assert.deepEqual(draftProblems({ ...ok, reply: `0x${'b'.repeat(40)}` }, now), {});
  assert.deepEqual(draftProblems({ ...ok, reply: 'https://example.com/me' }, now), {});
  const tomorrow = new Date(now + DAY);
  const day = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  assert.deepEqual(draftProblems({ ...ok, deadline: day(tomorrow) }, now), {});
  assert.equal(
    draftProblems({ ...ok, deadline: day(new Date(now + 40 * DAY)) }, now).deadline,
    'Pick a date within 30 days.',
  );
  assert.equal(draftProblems({ ...ok, deadline: '2026-02-30' }, now).deadline, 'Pick a date.');
});

test('the body: as the account or an agent, the reply handle, the hidden field only when filled', () => {
  const draft = {
    ...EMPTY_DRAFT,
    title: ' Check links ',
    description: 'All of them.',
    tags: 'Links, #docs, links',
    budget: '12.5',
    reply: ` 0x${'c'.repeat(40)} `,
  };
  assert.deepEqual(requestBody(draft, 'key-0001'), {
    title: 'Check links',
    description: 'All of them.',
    capabilities: ['links', 'docs'],
    budgetUsdc: '12.5',
    deadline: null,
    reply: `0x${'c'.repeat(40)}`,
    agentId: null,
    idempotencyKey: 'key-0001',
  });
  const asAgent = requestBody({ ...draft, postAs: 'agent-7' }, 'key-0002', 'filled by a script');
  assert.equal(asAgent.agentId, 'agent-7');
  assert.equal(asAgent.website, 'filled by a script');
  assert.ok(!('displayName' in asAgent), 'signed in, the server names the poster');
  const deadline = deadlineFrom('2026-10-24');
  assert.equal(new Date(deadline!).getHours(), 23);
});

test('the private link carries its token in the fragment only, and reads back', () => {
  const token = `ccf_${'A1_-'.repeat(10)}abc`;
  const link = manageLink('https://centralcity.ai', 'req_abcdefghijklmnopqrst', token);
  assert.equal(
    link,
    `https://centralcity.ai/feed/requests/req_abcdefghijklmnopqrst/manage#${token}`,
  );
  const url = new URL(link);
  assert.equal(url.search, '');
  assert.ok(!url.pathname.includes('ccf_'));
  assert.equal(readManageToken(url.hash), token);
  assert.equal(readManageToken('#close=req_x&code=y'), null);
  assert.equal(readManageToken(''), null);
});

// -------------------------------------------------------------------------------------------
// The flag gate

test('the gate: 200 is on, 404 is off, anything else is neither; a failed re-check keeps on', async () => {
  const status: FeedStatus = {
    snapshotAt: null,
    degraded: false,
    sources: [],
    services: 3,
    openRequests: 2,
  };
  resetFeedGate();
  assert.equal(knownFeedGate(), null);
  assert.equal(feedShown(knownFeedGate()), false);
  let asked = 0;
  const on = async () => {
    asked += 1;
    return json(200, status);
  };
  // The sidebar and the page share one request per page load.
  const [first, second] = await Promise.all([
    loadFeedGate({ fetcher: on }),
    loadFeedGate({ fetcher: on }),
  ]);
  assert.deepEqual(first, { phase: 'on', status });
  assert.equal(second, first);
  assert.equal(asked, 1);
  assert.equal(feedShown(knownFeedGate()), true);
  // A re-check that fails keeps the Feed this page load already saw on.
  await loadFeedGate({ fresh: true, fetcher: async () => json(500, {}), retryMs: [0, 0] });
  assert.equal(knownFeedGate()?.phase, 'on');
  // Turned off since: the page learns it, and the sidebar with it. The 404's body is read too:
  // an unread body keeps the request, and its connection, open.
  const off = json(404, { code: 'not_found' });
  await loadFeedGate({ fresh: true, fetcher: async () => off });
  assert.deepEqual(knownFeedGate(), { phase: 'off' });
  assert.equal(off.bodyUsed, true);
  assert.equal(feedShown(knownFeedGate()), false);
  // A question still on its way is shared, even by one that asks for a fresh answer; a recent
  // answer is reused by Root (maxAgeMs), an old one is not.
  resetFeedGate();
  asked = 0;
  const [plain1, fresh1] = await Promise.all([
    loadFeedGate({ fetcher: on }),
    loadFeedGate({ fresh: true, fetcher: on }),
  ]);
  assert.equal(fresh1, plain1);
  assert.equal(asked, 1);
  await loadFeedGate({ maxAgeMs: 60_000, fetcher: on });
  assert.equal(asked, 1);
  await loadFeedGate({ maxAgeMs: 0, fetcher: on });
  assert.equal(asked, 2);
  // A failed check is asked again (FEED_GATE_RETRY_MS) before the page says so.
  assert.deepEqual(FEED_GATE_RETRY_MS, [1_000, 3_000]);
  resetFeedGate();
  asked = 0;
  const failing = async () => {
    asked += 1;
    return json(500, {});
  };
  assert.deepEqual(await loadFeedGate({ fetcher: failing, retryMs: [0, 0] }), { phase: 'error' });
  assert.equal(asked, 3);
  resetFeedGate();
  asked = 0;
  const flaky = async () => {
    asked += 1;
    if (asked === 1) throw new TypeError('offline');
    return asked === 2 ? json(500, {}) : json(200, status);
  };
  assert.deepEqual(await loadFeedGate({ fetcher: flaky, retryMs: [0, 0] }), {
    phase: 'on',
    status,
  });
  assert.equal(asked, 3);
  // A 404 is an answer (off), never asked again.
  resetFeedGate();
  asked = 0;
  const offOnce = async () => {
    asked += 1;
    return json(404, { code: 'not_found' });
  };
  assert.deepEqual(await loadFeedGate({ fetcher: offOnce, retryMs: [0, 0] }), { phase: 'off' });
  assert.equal(asked, 1);
  resetFeedGate();
  assert.deepEqual(
    await loadFeedGate({
      fetcher: async () => {
        throw new TypeError('offline');
      },
      retryMs: [0, 0],
    }),
    { phase: 'error' },
  );
  resetFeedGate();
});

// -------------------------------------------------------------------------------------------
// Failures and retries

test('every failure becomes a code, and Retry-After is kept', async () => {
  const cases: Array<[Response, FeedFailureCode, boolean]> = [
    [json(429, { error: 'Slow down.' }, { 'Retry-After': '120' }), 'rate_limited', true],
    [json(401, { error: 'Sign in to continue.' }), 'signed_out', false],
    [json(409, { code: 'cursor_stale', retryable: true }), 'cursor_stale', true],
    [json(409, { code: 'request_closed', retryable: false }), 'request_closed', false],
    [json(503, { code: 'source_unavailable', retryable: true }), 'source_unavailable', true],
    [json(503, { code: 'busy', retryable: true }, { 'Retry-After': '5' }), 'busy', true],
    // Busy is retryable even from a body that leaves `retryable` out.
    [json(503, { code: 'busy' }), 'busy', true],
    [json(403, { code: 'not_poster' }), 'not_poster', false],
    [json(404, { code: 'agent_not_found' }), 'agent_not_found', false],
    [json(404, { error: 'Not found.' }), 'not_found', false],
    [json(400, { error: 'Bad.', code: 'something_new' }), 'invalid_request', false],
    [json(502, {}), 'server', true],
    [new Response('<html>', { status: 418 }), 'unknown', false],
  ];
  for (const [response, code, retryable] of cases) {
    const failure = await failureOf(response);
    assert.equal(failure.code, code, `${response.status}`);
    assert.equal(failure.retryable, retryable, code);
  }
  assert.equal((await failureOf(json(429, {}, { 'Retry-After': '120' }))).retryAfterMs, 120_000);
  assert.equal(
    (await failureOf(json(503, { code: 'busy', retryable: true }, { 'Retry-After': '5' })))
      .retryAfterMs,
    5_000,
  );
});

test('failure words are plain sentences: no codes, no server text', () => {
  const codes: FeedFailureCode[] = [
    'invalid_request',
    'not_found',
    'service_not_found',
    'request_not_found',
    'agent_not_found',
    'not_poster',
    'cursor_stale',
    'request_closed',
    'source_unavailable',
    'busy',
    'rate_limited',
    'signed_out',
    'network',
    'server',
    'unknown',
  ];
  const actions: FeedAction[] = ['list', 'service', 'request', 'post', 'report', 'close'];
  for (const action of actions)
    for (const code of codes) {
      const copy = feedErrorCopy(new FeedFailure(400, code, false), action);
      const text = `${copy.title} ${copy.detail}`;
      assert.doesNotMatch(text, /city_|[{}_]|idempoten|\b\d{3}\b/i, `${action} ${code}: ${text}`);
      assert.ok(copy.title.length > 0 && copy.detail.length > 0);
    }
  // The account's caps and the network's both answer 429: never "you" alone.
  assert.equal(
    feedErrorCopy(new FeedFailure(429, 'rate_limited', true, 20 * MINUTE), 'post').detail,
    'Try again in about 20 minutes.',
  );
  assert.equal(
    feedErrorCopy(new FeedFailure(429, 'rate_limited', true, 60_000), 'post').title,
    'Too many requests were posted from your account or network recently.',
  );
  // Without Retry-After, a refused post is the cap on open requests.
  const cap = feedErrorCopy(new FeedFailure(429, 'rate_limited', true), 'post');
  assert.equal(`${cap.title} ${cap.detail}`, 'You have too many open requests. Close one first.');
  assert.equal(
    feedErrorCopy(new FeedFailure(429, 'rate_limited', true), 'list').title,
    'Too many tries in a short time.',
  );
  assert.equal(
    feedErrorCopy(new FeedFailure(503, 'source_unavailable', true), 'list').title,
    "x402 Bazaar hasn't been read yet.",
  );
  // A moment of database load has the words of any failure on our side.
  for (const action of actions)
    assert.deepEqual(
      feedErrorCopy(new FeedFailure(503, 'busy', true, 5_000), action),
      feedErrorCopy(new FeedFailure(500, 'server', true), action),
      action,
    );
  // A search past its own time limit asks for a longer wait, and the words say how long.
  assert.deepEqual(feedErrorCopy(new FeedFailure(503, 'busy', true, 30_000), 'list'), {
    title: 'The Feed is busy right now.',
    detail: 'Nothing is wrong with your search. Try again in about 30 seconds.',
  });
  assert.equal(
    feedErrorCopy(new FeedFailure(403, 'not_poster', false), 'close').title,
    "This link can't close the request.",
  );
  assert.equal(
    feedErrorCopy(new TypeError('Failed to fetch'), 'list').title,
    "We couldn't reach Central City.",
  );
});

test('reads retry once after a network failure or a 5xx; writes never retry', async () => {
  const page = {
    snapshotAt: NOW,
    degraded: false,
    sources: [],
    services: [],
    next: null,
    total: 0,
  };
  let calls = 0;
  const flaky: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('reset');
    return json(200, page);
  };
  assert.deepEqual(
    await getServices(NO_OFFERED_FILTERS, null, { fetcher: flaky, retryDelayMs: 0 }),
    page,
  );
  assert.equal(calls, 2);

  calls = 0;
  const down: typeof fetch = async () => {
    calls += 1;
    return json(500, {});
  };
  await assert.rejects(getServices(NO_OFFERED_FILTERS, null, { fetcher: down, retryDelayMs: 0 }), {
    code: 'server',
  });
  assert.equal(calls, 2);

  // A contract answer is final: no retry for source_unavailable.
  calls = 0;
  const preparing: typeof fetch = async () => {
    calls += 1;
    return json(503, { code: 'source_unavailable', retryable: true });
  };
  await assert.rejects(
    getServices(NO_OFFERED_FILTERS, null, { fetcher: preparing, retryDelayMs: 0 }),
    {
      code: 'source_unavailable',
    },
  );
  assert.equal(calls, 1);

  // Busy asks for a wait (Retry-After): no quiet retry at once; the page offers Try again.
  calls = 0;
  const busy: typeof fetch = async () => {
    calls += 1;
    return json(503, { code: 'busy', retryable: true }, { 'Retry-After': '5' });
  };
  await assert.rejects(getServices(NO_OFFERED_FILTERS, null, { fetcher: busy, retryDelayMs: 0 }), {
    code: 'busy',
    retryable: true,
    retryAfterMs: 5_000,
  });
  assert.equal(calls, 1);

  calls = 0;
  const sent: RequestInit[] = [];
  const failing: typeof fetch = async (_url, init) => {
    calls += 1;
    sent.push(init!);
    return json(500, {});
  };
  await assert.rejects(
    postRequest(
      { title: 'Check links', description: 'All.', idempotencyKey: 'key-0001-test' },
      { fetcher: failing, retryDelayMs: 0 },
    ),
    { code: 'server' },
  );
  assert.equal(calls, 1);
  assert.equal(sent[0]!.method, 'POST');

  calls = 0;
  const offline: typeof fetch = async () => {
    calls += 1;
    throw new TypeError('offline');
  };
  await assert.rejects(
    closeRequest('req_aaaaaaaaaaaaaaaaaaa2', 'ccf_test-0001', { fetcher: offline }),
    {
      code: 'network',
    },
  );
  assert.equal(calls, 1);
});

test('writes carry the console’s request header and the workspace chosen in it', async () => {
  assert.deepEqual(writeHeaders(null), {
    accept: 'application/json',
    'Content-Type': 'application/json',
    'X-City-Request': '1',
  });
  selectWorkspace('ws_ai_1');
  try {
    let headers: Record<string, string> = {};
    let body = '';
    await closeRequest('req_aaaaaaaaaaaaaaaaaaa2', null, {
      fetcher: async (_url, init) => {
        headers = init!.headers as Record<string, string>;
        body = String(init!.body);
        return json(200, request({ status: 'closed' }));
      },
    });
    assert.equal(headers['X-City-Request'], '1');
    assert.equal(headers['X-City-Workspace'], 'ws_ai_1');
    // Signed in without a token: the session decides.
    assert.equal(body, '{}');
  } finally {
    selectWorkspace(null);
  }
});

test('an aborted read stays aborted; an impossible id is not asked for', async () => {
  const controller = new AbortController();
  const slow: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) =>
      init!.signal!.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      ),
    );
  const pending = getServices(NO_OFFERED_FILTERS, null, {
    fetcher: slow,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  let asked = false;
  await assert.rejects(
    getService('../admin', {
      fetcher: async () => {
        asked = true;
        return json(200, {});
      },
    }),
    { code: 'service_not_found' },
  );
  assert.equal(asked, false);
});

// -------------------------------------------------------------------------------------------
// Cards

const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;

test('a service card: avatar, title, site, price, uses and the credit; nothing else', () => {
  const html = renderToStaticMarkup(
    createElement(ServiceCard, {
      service: service({
        title: '<img src=x onerror=alert(1)> Lookup',
        description: 'Read [the docs](javascript:alert(1)) or <b>bold</b>',
        provider: { host: 'lookup.example.com', name: 'Lookup Co' },
        usage: { paidCalls30d: 5214, payers30d: 7, lastCalledAt: null, reportedBy: 'x402 Bazaar' },
      }),
      title: '<img src=x onerror=alert(1)> Lookup',
      colour: '#0f766e',
      onOpen: () => undefined,
    }),
  );
  assert.doesNotMatch(html, /<img|<b>bold|href="javascript:/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; Lookup/);
  // No description, no input or output, no links or buttons besides the card's own.
  assert.doesNotMatch(html, /Read \[the docs\]/);
  assert.doesNotMatch(html, /<a /);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.match(html, /<button type="button" class="fd-hit" id="fd-t-svc_abcdefghijklmnopqrst"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /lookup\.example\.com/);
  assert.match(html, /\$0\.001<span class="visually-hidden"> per call<\/span>/);
  assert.match(html, /5,214 uses/);
  // The palette colour with white initials, never Central City blue.
  assert.match(
    html,
    /class="fd-av xs" aria-hidden="true" style="background-color:#0f766e;color:#ffffff">LC</,
  );
  // The one small credit; screen readers hear "Listed by x402 Bazaar, external service".
  assert.match(
    html,
    /class="fd-xb"[^>]*><span class="visually-hidden">Listed by <\/span>x402 Bazaar/,
  );
  assert.doesNotMatch(html, />\s*(Pay|Rate)\s*</);
  assert.doesNotMatch(html, /passport/i);
  assert.doesNotMatch(html, ARROWS);
  const card = (usage: FeedService['usage']) =>
    renderToStaticMarkup(
      createElement(ServiceCard, {
        service: service({ usage }),
        title: 'Domain lookup',
        colour: '#0f766e',
        onOpen: () => undefined,
      }),
    );
  const fresh = card({
    paidCalls30d: 0,
    payers30d: 0,
    lastCalledAt: null,
    reportedBy: 'x402 Bazaar',
  });
  assert.match(
    fresh,
    /data-new="true">New<span class="visually-hidden">: no paid uses reported yet/,
  );
  // No count from the source: "Not reported", never "New" (it may have been paid an hour ago).
  const unreported = card({
    paidCalls30d: null,
    payers30d: null,
    lastCalledAt: NOW - HOUR,
    reportedBy: 'x402 Bazaar',
  });
  assert.match(
    unreported,
    /<span class="fd-uses">Not reported<span class="visually-hidden">: x402 Bazaar lists no 30-day count/,
  );
  assert.doesNotMatch(unreported, /data-new|>New</);
});

test('a service’s details: the full label, input and output in words, raw examples closed', () => {
  const html = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({
        output: {
          format: 'json',
          fields: [],
          more: 0,
          example: '{"ok":true}',
          exampleState: 'whole',
        },
        status: 'stale',
        lastSeenAt: NOW - 26 * HOUR,
        moreFromHost: 2,
      }),
      now: NOW,
      onHost: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.equal(
    EXTERNAL_LABEL,
    'External service · listed by x402 Bazaar · not a Central City agent',
  );
  assert.ok(html.includes(EXTERNAL_LABEL));
  assert.match(html, /Takes domain and limit/);
  assert.match(html, /Not confirmed for 26 h/);
  assert.match(html, /<details class="fd-raw">/);
  assert.doesNotMatch(html, /<details class="fd-raw" open/);
  assert.match(html, /Example result, as listed/);
  assert.match(html, /0x0E84…b808/);
  assert.match(html, /GET https:\/\/lookup\.example\.com\/v1\/whois/);
  assert.match(html, /Reported by x402 Bazaar, not measured by Central City/);
  assert.match(html, />All services from this site</);
  // Next to "All services from this site", and true on a page with no list too.
  assert.match(html, /2 more from this site</);
  assert.doesNotMatch(html, /not shown in the list/);
  assert.match(html, /Listed by <a href="https:\/\/docs\.cdp\.coinbase\.com\/x402\/bazaar"/);
  // The next step first: Copy service address is the primary button. Open service is gone (a
  // browser can't call a POST service, and it only ever answered Payment Required); until Feed
  // pay answers for the person (and on a server render) the drawer is today's, without it.
  const foot = html.slice(html.indexOf('<footer'));
  assert.match(
    foot,
    /^<footer class="fd-d-foot fd-service-foot"><button type="button" class="fd-btn primary">Copy service address<\/button>/,
  );
  assert.equal(html.match(/Copy service address/g)?.length, 1);
  assert.doesNotMatch(html, /Open service|Payment Required|fd-foot-note/);
  assert.doesNotMatch(html, /<a [^>]*href="https:\/\/lookup\.example\.com\/v1\/whois"/);
  assert.doesNotMatch(html, /Use with my agent|Sign in to use it/);
  assert.doesNotMatch(html, /Open endpoint|endpoint/i);
  assert.doesNotMatch(html, /href="https:\/\/lookup\.example\.com\/"/);
  assert.doesNotMatch(html, /Open site/);
  // The listed address as text; copying it is the footer's job.
  assert.match(
    html,
    /<code>GET https:\/\/lookup\.example\.com\/v1\/whois<\/code><span class="fd-fine">/,
  );
  // Paid to: the short address with the full one as its tooltip, no Copy, and why paying it
  // directly buys nothing.
  assert.match(
    html,
    /<dt>Paid to<\/dt><dd><code title="0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808">0x0E84…b808<\/code><span class="fd-fine">The address the service asks to be paid at in its payment request\. Sending USDC to it directly does not pay for a call\.<\/span><\/dd>/,
  );
  assert.doesNotMatch(html, /payee/);
  assert.equal(html.match(/>Copy</g), null);
  // How to use it, as information, just above Limitations.
  const how = html.indexOf('>How to use it</h3>');
  assert.ok(how > 0 && how < html.indexOf('>Limitations</h3>'));
  assert.ok(how > html.indexOf('>Source and freshness</h3>'));
  assert.match(
    html,
    /How to use it<\/h3><p>A program or AI with an x402 client and its own Base USDC wallet calls the service address and pays the payment request it answers with\. Central City can’t pay it for your agents yet\.<\/p>/,
  );
  // An address that is not https gets no link at all, and no line about one.
  const plainHttp = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({ url: 'http://lookup.example.com/v1/whois' }),
      now: NOW,
    }),
  );
  assert.doesNotMatch(plainHttp, /Open service|Payment Required/);
  assert.doesNotMatch(plainHttp, /<a [^>]*href="http:/);
  assert.match(plainHttp, /<code>GET http:\/\/lookup\.example\.com\/v1\/whois<\/code>/);
  assert.match(plainHttp, /class="fd-btn primary">Copy service address</);
  assert.match(html, />Copy link</);
  assert.doesNotMatch(html, />Close</);
  assert.doesNotMatch(html, />\s*(Pay|Rate)\s*</);
  assert.doesNotMatch(html, ARROWS);
});

test('in one site’s list the details leave out “N more from this site”; no count is never New', () => {
  const props = {
    service: service({
      moreFromHost: 556,
      usage: {
        paidCalls30d: null,
        payers30d: null,
        lastCalledAt: NOW - 4 * HOUR,
        reportedBy: 'x402 Bazaar' as const,
      },
    }),
    now: NOW,
    onHost: () => undefined,
  };
  const list = renderToStaticMarkup(createElement(ServiceDetail, props));
  assert.match(list, /556 more from this site</);
  // The list is this site's own (?host=): Load more shows the rest, so the line would mislead.
  const site = renderToStaticMarkup(createElement(ServiceDetail, { ...props, hostFiltered: true }));
  assert.doesNotMatch(site, /more from this site/);
  assert.match(site, />All services from this site</);
  // Uses: the source gives no count, and the last paid call was 4 h ago: not "New".
  assert.match(list, /<dt>uses, 30 days<\/dt><dd>Not reported<\/dd>/);
  assert.doesNotMatch(list, /No paid uses reported yet|>New</);
  assert.match(list, /Last paid call 4 h ago\. /);
  const fresh = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({
        usage: { paidCalls30d: 0, payers30d: 0, lastCalledAt: null, reportedBy: 'x402 Bazaar' },
      }),
      now: NOW,
    }),
  );
  assert.match(fresh, /<dt>uses, 30 days<\/dt><dd>New<\/dd>/);
});

test('a request card: poster, title, budget and time left; its details hold the rest', () => {
  const leaked = {
    ...request({
      budget: budget('7500000', '7.5'),
      deadline: NOW + 4 * DAY + HOUR,
      postedBy: { kind: 'anonymous', displayName: 'Mara' },
      reply: `0x${'d'.repeat(40)}`,
    }),
    // A server that leaked a private contact would still not get it drawn.
    contact: 'private@example.com',
  } as PublicFeedRequest;
  const card = renderToStaticMarkup(
    createElement(RequestCard, {
      request: leaked,
      now: NOW,
      colour: '#6d28d9',
      onOpen: () => undefined,
    }),
  );
  assert.match(card, /Mara/);
  assert.match(card, /class="fd-clamp">Summarise invoices</);
  assert.match(card, /<span class="visually-hidden">Budget <\/span>\$7\.50</);
  assert.match(card, /<span class="visually-hidden">Time left: <\/span>4 days/);
  assert.equal(card.match(/class="fd-chip"/g)?.length, 2);
  assert.doesNotMatch(card, /Forty PDFs|Respond|Report|Copy link/);
  assert.doesNotMatch(card, /private@example\.com/);
  assert.match(card, /style="background-color:#6d28d9;color:#ffffff">Ma</);
  assert.doesNotMatch(card, ARROWS);

  const open = renderToStaticMarkup(
    createElement(RequestCard, {
      request: request(),
      now: NOW,
      colour: '#6d28d9',
      onOpen: () => undefined,
    }),
  );
  assert.match(open, /Anonymous/);
  assert.match(open, />Open budget</);
  assert.match(open, />No deadline</);

  const detail = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'fd-dh',
      request: leaked,
      now: NOW,
      onClose: () => undefined,
    }),
  );
  assert.match(detail, /Forty PDFs into one table\./);
  assert.match(detail, /unverified, given by the poster/);
  assert.match(detail, />Respond</);
  assert.match(detail, />Report</);
  assert.match(detail, />Copy link</);
  assert.doesNotMatch(detail, /Close request/);
  assert.doesNotMatch(detail, /private@example\.com/);
  assert.doesNotMatch(detail, ARROWS);

  const mine = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'fd-dh', request: request(), now: NOW, mine: true }),
  );
  assert.match(mine, />Close request</);
  assert.doesNotMatch(mine, />Respond</);
  // Posted without a reply handle: never told that people reach them by it.
  assert.match(mine, /nobody can reach you\. Add one to your next request\./);
  assert.doesNotMatch(mine, /reach you by your reply handle/);
  // Never advice the server refuses (the same title is a duplicate for 7 days, closed or not).
  assert.doesNotMatch(mine, /post again|close this/i);
  const mineWithReply = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'fd-dh',
      request: request({ reply: 'https://example.org/contact' }),
      now: NOW,
      mine: true,
    }),
  );
  assert.match(mineWithReply, /reach you by your reply handle/);
  assert.doesNotMatch(mineWithReply, /nobody can reach you/);
});

test('an account’s request, posted without a name, says “Central City account”, never Anonymous', () => {
  const account = request({ postedBy: { kind: 'account', displayName: null } });
  const card = renderToStaticMarkup(
    createElement(RequestCard, { request: account, now: NOW, colour: '#6d28d9', onOpen: () => {} }),
  );
  assert.match(card, />Central City account<span class="visually-hidden"> · 2 h ago<\/span>/);
  assert.doesNotMatch(card, /Anonymous/);
  const detail = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'fd-dh', request: account, now: NOW }),
  );
  assert.match(detail, /<p class="fd-d-sub">Central City account · 2 h ago<\/p>/);
  assert.doesNotMatch(detail, /Anonymous/);
  // A signed-out poster without a name is still Anonymous, and says it had no account.
  const anonymous = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'fd-dh', request: request(), now: NOW }),
  );
  assert.match(anonymous, /<p class="fd-d-sub">Anonymous · No account · 2 h ago<\/p>/);
});

test('the form says an account posts without its name', () => {
  const html = renderToStaticMarkup(
    createElement(PostRequestForm, { onPosted: () => {}, onCancel: () => {} }),
  );
  assert.match(html, /<option value="" selected="">Me \(no name shown\)<\/option>/);
  assert.match(
    html,
    /Posted from your account without your name\. An agent posts under its own name\./,
  );
  assert.doesNotMatch(html, /Your name shows on the request/);
});

// -------------------------------------------------------------------------------------------
// Review fixes: refusals, fresh reads, keys, closing, sign-out

test('a post refused as invalid shows the server’s own sentence, plain and capped', async () => {
  const refused = await failureOf(
    json(400, {
      error: 'The title needs 5 to 100 characters.',
      code: 'invalid_request',
      retryable: false,
    }),
  );
  assert.equal(refused.code, 'invalid_request');
  assert.equal(refused.said, 'The title needs 5 to 100 characters.');
  assert.deepEqual(feedErrorCopy(refused, 'post'), {
    title: "Something in this form isn't right.",
    detail: 'The title needs 5 to 100 characters.',
  });
  // Elsewhere the words stay ours.
  assert.equal(feedErrorCopy(refused, 'list').detail, 'Change the filters and try again.');
  // Plain text, one line, capped.
  assert.equal(serverSentence('A\u202E line\u200B\n\nand more.'), 'A line and more.');
  const long = serverSentence(`${'Word '.repeat(80)}end.`)!;
  assert.equal(Array.from(long).length, SAID_MAX);
  assert.ok(long.endsWith('…'));
  // Text that reads like code is never shown: the plain fallback instead.
  for (const text of [
    'Send {title, description, idempotencyKey} and optionally capabilities.',
    'This idempotencyKey was already used for a different request.',
    'Send {reason: spam|scam} and optionally a note.',
    '<b>bold</b>',
    '',
    42,
  ])
    assert.equal(serverSentence(text), undefined, String(text));
  const machine = await failureOf(
    json(400, { error: 'Send {title} please.', code: 'invalid_request' }),
  );
  assert.equal(feedErrorCopy(machine, 'post').detail, 'Check it and try again.');
  // Only a 400 carries its sentence.
  assert.equal((await failureOf(json(404, { error: 'Agent not found.' }))).said, undefined);
});

test('a list read again skips the browser’s cache; an ordinary read does not', async () => {
  const seen: Array<RequestCache | undefined> = [];
  const fetcher: typeof fetch = async (url, init) => {
    seen.push(init?.cache);
    return String(url).includes('/requests')
      ? json(200, { requests: [], next: null })
      : json(200, {
          snapshotAt: NOW,
          degraded: false,
          sources: [],
          services: [],
          next: null,
          total: 0,
        });
  };
  await getServices(NO_OFFERED_FILTERS, null, { fetcher });
  await getServices(NO_OFFERED_FILTERS, null, { fetcher, cache: 'no-store' });
  await getRequests(NO_REQUEST_FILTERS, null, { fetcher });
  await getRequests(NO_REQUEST_FILTERS, null, { fetcher, cache: 'no-store' });
  assert.deepEqual(seen, [undefined, 'no-store', undefined, 'no-store']);
});

test('a retry of the same text keeps its key; edited text gets a new one', () => {
  let made = 0;
  const make = () => `key-${String(++made).padStart(4, '0')}`;
  const first = postKey(null, { title: 'Check links', description: 'All of them.' }, make);
  assert.equal(first.key, 'key-0001');
  // The answer was lost: the same request again, the same key.
  const again = postKey(first, { title: 'Check links', description: 'All of them.' }, make);
  assert.equal(again.key, 'key-0001');
  // The person edited it: a new request, a new key (the server refuses the old key for good).
  const edited = postKey(again, { title: 'Check links', description: 'Only the docs.' }, make);
  assert.equal(edited.key, 'key-0002');
  assert.equal(
    postKey(edited, { title: 'Check 9 links', description: 'Only the docs.' }, make).key,
    'key-0003',
  );
});

test('closing a request that is already closed counts as closed', async () => {
  const refused = await failureOf(
    json(409, {
      error: 'This request is already closed.',
      code: 'request_closed',
      retryable: false,
    }),
  );
  assert.equal(alreadyClosed(refused), true);
  assert.equal(alreadyClosed(new FeedFailure(403, 'not_poster', false)), false);
  assert.equal(alreadyClosed(new Error('request_closed')), false);
});

test('a session that ended mid-page: posted, but not from the account the form named', () => {
  const posted = (kind: 'account' | 'anonymous' | 'agent') => ({
    request: request({
      postedBy: { kind, displayName: kind === 'agent' ? 'Ledger Scout' : null },
    }),
    manageToken: 'ccf_test-0001',
  });
  assert.equal(postedWithoutAccount('', posted('account')), false);
  assert.equal(postedWithoutAccount('', posted('anonymous')), true);
  // Posting as an agent needs a session (401 otherwise): nothing to say.
  assert.equal(postedWithoutAccount('agent_1', posted('agent')), false);
  const html = renderToStaticMarkup(
    createElement(PostedCard, {
      posted: posted('anonymous'),
      lapsed: true,
      onSee: () => {},
      onAnother: () => {},
    }),
  );
  assert.match(html, /You were signed out, so it wasn’t posted from your account/);
  assert.match(html, /Only your private link can close it\./);
  const fine = renderToStaticMarkup(
    createElement(PostedCard, { posted: posted('account'), onSee: () => {}, onAnother: () => {} }),
  );
  assert.doesNotMatch(fine, /signed out/);
});

test('signing out forgets the private close tokens and the requests marked Yours', () => {
  const globals = globalThis as { window?: unknown };
  const before = globals.window;
  globals.window = { history: { state: null, replaceState: () => undefined } };
  try {
    resetMine();
    addMine({ request: request(), manageToken: 'ccf_test-0001' });
    captureManageCode({
      pathname: '/feed/requests/req_aaaaaaaaaaaaaaaaaaa2/manage',
      hash: '#ccf_held-code-0001',
      search: '',
    } as Location);
    assert.equal(heldManageCode('req_aaaaaaaaaaaaaaaaaaa2'), 'ccf_held-code-0001');
    assert.ok(mineEntry('req_aaaaaaaaaaaaaaaaaaa2'));
    forgetFeedSession();
    assert.equal(mineEntry('req_aaaaaaaaaaaaaaaaaaa2'), null);
    assert.equal(heldManageCode('req_aaaaaaaaaaaaaaaaaaa2'), null);
  } finally {
    globals.window = before;
    resetMine();
  }
});

// -------------------------------------------------------------------------------------------
// Journey fixes (the 13 Oct audit): requests

test('U7: budgets read in cents with thousands separated; prices per call stay as listed', () => {
  assert.equal(budgetMain(budget('2500000', '2.5')), '$2.50');
  assert.equal(budgetMain(budget('100000000000', '100000')), '$100,000.00');
  assert.equal(budgetMain(budget('1234560000', '1234.56')), '$1,234.56');
  // Never rounded away: a sub-cent budget keeps its digits.
  assert.equal(budgetDollars('5000'), '$0.005');
  assert.equal(budgetDollars('1'), '$0.000001');
  assert.equal(budgetDollars('-1'), null);
  assert.equal(budgetSub(budget('2500000', '2.5')), 'in total, in USDC');
  // A price per call keeps every listed decimal and no added zeros.
  assert.equal(priceMain({ raw: '7000', decimals: 6, display: '', unit: 'per_call' }), '$0.007');
  assert.equal(priceMain({ raw: '2500000', decimals: 6, display: '', unit: 'per_call' }), '$2.5');
});

test('U7: tags are split on commas only; spaces inside a tag become dashes', () => {
  assert.deepEqual(draftTags('machine learning, PDF,  data   entry ,#docs, pdf'), [
    'machine-learning',
    'pdf',
    'data-entry',
    'docs',
  ]);
  assert.deepEqual(draftTags('pdf ocr'), ['pdf-ocr']);
  assert.deepEqual(draftTags(' , ,'), []);
  const ok = { ...EMPTY_DRAFT, title: 'Check 200 links', description: 'Every broken link.' };
  // Two tags with spaces were five tags (and so refused); they are two.
  assert.deepEqual(draftProblems({ ...ok, tags: 'machine learning, data entry, ocr' }, NOW), {});
  assert.deepEqual(
    requestBody({ ...ok, tags: 'machine learning, data entry' }, 'k-0001').capabilities,
    ['machine-learning', 'data-entry'],
  );
});

test('U7: a Central City link as the reply handle gets its own clear sentence', () => {
  const ok = { ...EMPTY_DRAFT, title: 'Check 200 links', description: 'Every broken link.' };
  const said =
    'Only Central City result and agent links can be a reply handle. Use a Base address or another https page.';
  for (const reply of [
    'https://centralcity.ai/r/launch-room',
    'https://www.centralcity.ai/feed/requests/req_abcdefghijklmnopqrst',
    'https://app.centralcity.ai/join?code=abc',
    'https://CENTRALCITY.AI./passport/7',
  ])
    assert.equal(draftProblems({ ...ok, reply }, NOW).reply, said, reply);
  // A preview's own host is refused outright (its join links grant room access there too).
  assert.equal(
    draftProblems(
      { ...ok, reply: 'https://cc-preview.example.app/r/x' },
      NOW,
      'cc-preview.example.app',
    ).reply,
    said,
  );
  assert.equal(
    centralCityLink('https://cc-preview.example.app/r/x', 'cc-preview.example.app'),
    true,
  );
  for (const reply of [
    'https://example.com/centralcity.ai',
    'https://notcentralcity.ai/me',
    `0x${'b'.repeat(40)}`,
  ])
    assert.deepEqual(draftProblems({ ...ok, reply }, NOW, 'cc-preview.example.app'), {}, reply);
});

test('#332 re-review 4: Central City reply handles match the server: results and agents only', () => {
  const ok = { ...EMPTY_DRAFT, title: 'Check 200 links', description: 'Every broken link.' };
  const id = '3f2a6c1e-7b4d-4e8a-9c0f-a1b2c3d4e5f6';
  // The two shapes server/results/sources.ts APP_ALLOWED takes on centralcity.ai.
  const allowed = [
    `https://centralcity.ai/results/${id}`,
    `https://centralcity.ai/results/${id}/`,
    `https://www.centralcity.ai/results/${id.toUpperCase()}`,
    `https://app.centralcity.ai/a2a/${id}`,
    `https://centralcity.ai/a2a/${id}/.well-known/agent-card.json`,
    `https://centralcity.ai/results/${id}?from=feed#top`,
  ];
  const refused = [
    'https://centralcity.ai/',
    'https://centralcity.ai/feed',
    'https://centralcity.ai/r/launch-room',
    'https://centralcity.ai/j/abc123def456',
    'https://centralcity.ai/results/not-an-id',
    `https://centralcity.ai/results/${id}/edit`,
    `https://centralcity.ai/a2a/${id}/messages`,
    `https://centralcity.ai/agents/${id}`,
    `https://centralcity.ai/results/${id}/../../j/abc123def456`,
    `https://centralcity.ai/results/x/%2e%2e/%2e%2e/r/launch-room`,
  ];
  for (const reply of allowed) {
    assert.equal(centralCityLink(reply), false, reply);
    assert.deepEqual(draftProblems({ ...ok, reply }, NOW, 'centralcity.ai'), {}, reply);
    // The server takes it too.
    assert.equal(checkReply(reply).ok, true, reply);
  }
  for (const reply of refused) {
    assert.equal(centralCityLink(reply), true, reply);
    assert.match(draftProblems({ ...ok, reply }, NOW).reply ?? '', /^Only Central City result/);
    // And the server refuses it.
    assert.equal(checkReply(reply).ok, false, reply);
  }
});

test('#332 re-review 1: the report copy promises no review (no review queue is live yet)', () => {
  assert.equal(
    REPORT_FINE_PRINT,
    'Enough reports hide it from the lists. The poster isn’t told who reported it.',
  );
  assert.doesNotMatch(REPORT_FINE_PRINT, /check|review/i);
});

test('B6: cards and rows mark signed-out posters “Unverified”, agents “Agent”, and no handle', () => {
  const anonymous = request({ postedBy: { kind: 'anonymous', displayName: 'Mara' } });
  const agent = request({
    postedBy: { kind: 'agent', displayName: 'Ledger Scout' },
    reply: `0x${'d'.repeat(40)}`,
  });
  const account = request({
    postedBy: { kind: 'account', displayName: null },
    reply: 'https://example.com/me',
  });
  assert.equal(posterChip(anonymous), 'Unverified');
  assert.equal(posterChip(agent), 'Agent');
  assert.equal(posterChip(account), '');
  const card = (value: PublicFeedRequest) =>
    renderToStaticMarkup(
      createElement(RequestCard, { request: value, now: NOW, colour: '#6d28d9', onOpen: () => {} }),
    );
  const row = (value: PublicFeedRequest) =>
    renderToStaticMarkup(
      createElement(RequestRow, { request: value, now: NOW, colour: '#6d28d9', onOpen: () => {} }),
    );
  assert.match(card(anonymous), /<span class="fd-who" aria-hidden="true">Unverified<\/span>/);
  assert.match(card(agent), /<span class="fd-who" aria-hidden="true">Agent<\/span>/);
  assert.doesNotMatch(card(account), /fd-who/);
  assert.match(row(anonymous), /Mara <span class="fd-who">Unverified<\/span>/);
  assert.match(row(agent), /Ledger Scout <span class="fd-who">Agent<\/span>/);
  assert.match(row(agent), /Ledger Scout · Agent · No deadline/);
  assert.doesNotMatch(row(account), /fd-who/);
  // No reply handle: a third chip on the card, a quiet one beside the row's title.
  assert.match(card(anonymous), /<span class="fd-chip">No reply handle<\/span>/);
  assert.equal(card(anonymous).match(/class="fd-chip"/g)?.length, 3);
  assert.doesNotMatch(card(agent), /No reply handle/);
  assert.match(row(anonymous), /<\/h3><span class="fd-who">No reply handle<\/span>/);
  assert.doesNotMatch(row(account), /No reply handle/);
  for (const html of [card(anonymous), row(agent)]) assert.doesNotMatch(html, ARROWS);
});

test('U2: no Respond without a reply handle; the details say the poster can’t be reached', () => {
  const none = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'fd-dh',
      request: request(),
      now: NOW,
      onClose: () => {},
    }),
  );
  assert.doesNotMatch(none, />Respond</);
  assert.match(none, /No reply handle: the poster can’t be reached yet\./);
  assert.doesNotMatch(none, /Respond shows how to reach the poster/);
  assert.match(none, />Report</);
  const handle = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'fd-dh',
      request: request({ reply: 'https://example.com/me' }),
      now: NOW,
      onClose: () => {},
    }),
  );
  assert.match(handle, /class="fd-btn primary">Respond</);
  assert.match(handle, /Respond shows how to reach the poster/);
});

test('U2: Respond guides by the kind of handle: a link, or a Central City agent’s wallet', () => {
  const link = renderToStaticMarkup(
    createElement(RespondBody, {
      request: request({ reply: 'https://example.com/contact' }),
      onBack: () => {},
    }),
  );
  assert.match(link, /<b>Send the poster the room link<\/b> by their reply handle\./);
  assert.match(
    link,
    /Room links expire after 24 hours\. Make a new one if the poster answers later\./,
  );
  assert.doesNotMatch(link, /Agent Explorer|On Base/);
  const address = renderToStaticMarkup(
    createElement(RespondBody, {
      request: request({ reply: `0x${'a'.repeat(40)}` }),
      onBack: () => {},
    }),
  );
  assert.match(address, /<b>If this is a Central City agent’s wallet,<\/b> look it up in the/);
  // One name for the agents-on-Base page: the Agent Explorer (its heading and the Feed guide).
  assert.match(
    address,
    /<a href="\/explorer\/base" target="_blank" rel="noopener noreferrer nofollow">Agent Explorer/,
  );
  assert.doesNotMatch(address, /On Base/);
  assert.match(
    address,
    /and invite that agent to your room by its passport\. Other Base addresses can’t receive messages\./,
  );
  assert.doesNotMatch(address, /Send the poster the room link|Room links expire/);
  for (const html of [link, address]) {
    assert.match(html, /<a class="fd-btn primary" href="\/rooms">Start a room<\/a>/);
    assert.doesNotMatch(html, ARROWS);
    assert.doesNotMatch(html, />\s*(Pay|Rate)\s*</);
  }
});

test('U3: Start a room fills New room with the request: its title, and a topic linking back', () => {
  const value = request({ title: 'Summarise‮ invoices' });
  assert.deepEqual(roomPrefill(value, 'https://centralcity.ai'), {
    name: 'Summarise invoices',
    topic:
      'Feed request: Summarise invoices · https://centralcity.ai/feed/requests/req_aaaaaaaaaaaaaaaaaaa2',
  });
  // Through the history entry of /rooms, read once.
  const globals = globalThis as { window?: unknown };
  const before = globals.window;
  let state: unknown = roomsSheetState('new', roomPrefill(value, 'https://centralcity.ai'));
  globals.window = {
    history: {
      get state() {
        return state;
      },
      replaceState: (next: unknown) => {
        state = next;
      },
    },
  };
  try {
    assert.deepEqual(takeRoomsSheet(), {
      sheet: 'new',
      prefill: roomPrefill(value, 'https://centralcity.ai'),
    });
    assert.deepEqual(state, {});
    assert.equal(takeRoomsSheet(), null);
    // The sidebar's own New room and Join a room carry nothing to fill in.
    state = { [ROOMS_SHEET_STATE]: 'join', [ROOMS_SHEET_PREFILL]: { name: 'x', topic: 'y' } };
    assert.deepEqual(takeRoomsSheet(), { sheet: 'join', prefill: null });
    state = roomsSheetState('new');
    assert.deepEqual(takeRoomsSheet(), { sheet: 'new', prefill: null });
  } finally {
    globals.window = before;
  }
});

test('U3: New room starts with the name cut to a room name, and shows the topic it will set', async () => {
  const client = { listAgents: () => new Promise(() => {}) } as unknown as RoomsClient;
  const long = `${'Proofread a grant proposal '.repeat(4)}😀 end`;
  // The sheet notes which element had focus as it opens (useDialogFocus).
  const globals = globalThis as { document?: unknown };
  const before = globals.document;
  globals.document = { activeElement: null };
  const render = (props: { initialName?: string; initialTopic?: string }) => {
    try {
      return renderToStaticMarkup(
        createElement(NewRoomSheet, { client, onCreated: () => {}, onClose: () => {}, ...props }),
      );
    } finally {
      globals.document = before;
    }
  };
  const html = render({
    initialName: long,
    initialTopic: 'Feed request: Proofread · https://centralcity.ai/feed/requests/req_x',
  });
  const name =
    /placeholder="e\.g\. Launch week" maxLength="80" value="([^"]*)"/.exec(html)?.[1] ?? '';
  assert.ok(name.length <= 80 && name.length > 70, name);
  assert.ok(long.startsWith(name));
  assert.match(
    html,
    /<span>Topic<\/span><textarea class="rm-input" rows="3" maxLength="280">Feed request: Proofread · https:\/\/centralcity\.ai\/feed\/requests\/req_x<\/textarea>/,
  );
  // The sidebar's New room has no topic field.
  globals.document = { activeElement: null };
  const plainSheet = render({});
  assert.doesNotMatch(plainSheet, /Topic/);
  assert.match(plainSheet, /placeholder="e\.g\. Launch week" maxLength="80" value=""/);
  // The rooms client sends the topic with the room.
  const original = globalThis.fetch;
  let sent: unknown = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return json(201, { room: { id: 'room-1', name: 'Proofread', topic: 'Feed request: x' } });
  }) as typeof fetch;
  try {
    await createHttpRoomsClient().create({
      agent_id: 'agent-1',
      name: 'Proofread',
      topic: 'Feed request: x',
      idempotency_key: 'key-00000001',
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent, {
    agent_id: 'agent-1',
    name: 'Proofread',
    topic: 'Feed request: x',
    idempotency_key: 'key-00000001',
  });
});

test('B1 and B6: held is “in review”, the bare request has no responder words, account caps', () => {
  const held = renderToStaticMarkup(
    createElement(PostedCard, {
      posted: { request: request({ status: 'held' }), manageToken: 'ccf_test-0001' },
      onSee: () => {},
      onAnother: () => {},
    }),
  );
  assert.match(
    held,
    /“Summarise invoices” is in review and isn’t listed in Searched for\. A request still in review after 7 days is deleted\./,
  );
  assert.doesNotMatch(held, /once we have looked/);
  const bare = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'fd-manage-r',
      request: request({ reply: 'https://example.com/me' }),
      now: NOW,
      bare: true,
    }),
  );
  assert.doesNotMatch(bare, /Respond shows|reach the poster|reach you/);
  assert.match(bare, /Budgets are information only: no money moves through the Feed\./);
  // Signed in, the form names the account's caps, the ones that apply (not the signed-out ones).
  assert.deepEqual(ACCOUNT_POST_CAPS, {
    perHour: FEED_CAPS_DEFAULT.postsPerOwnerHour,
    perDay: FEED_CAPS_DEFAULT.postsPerOwnerDay,
  });
  const form = renderToStaticMarkup(
    createElement(PostRequestForm, { onPosted: () => {}, onCancel: () => {} }),
  );
  assert.match(form, /Up to 30 requests an hour and 100 a day\./);
  assert.doesNotMatch(form, /Up to 3 requests/);
});

test('U8: a request’s tags link to the requests with each; the menu offers more of them', () => {
  assert.equal(tagHref('pdf'), '/feed/requests?tag=pdf');
  const html = renderToStaticMarkup(
    createElement(RequestDetail, {
      headId: 'fd-dh',
      request: request({ capabilities: ['pdf', 'data-entry'] }),
      now: NOW,
    }),
  );
  assert.match(
    html,
    /<a class="fd-kw" href="\/feed\/requests\?tag=pdf">pdf<span class="visually-hidden">: requests with this tag<\/span><\/a>/,
  );
  assert.match(html, /href="\/feed\/requests\?tag=data-entry"/);
  const many = Array.from({ length: 40 }, (_, index) =>
    request({ id: `req_${String(index).padStart(20, 'a')}`, capabilities: [`tag-${index}`] }),
  );
  assert.equal(TAG_MENU_MAX, 30);
  assert.equal(topTags(many, '').length, 30);
  assert.equal(topTags(many, 'tag-39').length, 31);
});

test('U8: a request opened from Searched for is a history entry over the list it came from', () => {
  const globals = globalThis as { window?: unknown; PopStateEvent?: unknown };
  const before = { window: globals.window, PopStateEvent: globals.PopStateEvent };
  const entries: Array<{ state: unknown; url: string }> = [
    { state: null, url: '/feed/requests?tag=pdf' },
  ];
  const events: string[] = [];
  const listeners = new Map<string, () => void>();
  globals.PopStateEvent = class extends Event {};
  const popstate = () => {
    events.push('popstate');
    listeners.get('popstate')?.();
  };
  globals.window = {
    location: {
      get pathname() {
        return entries.at(-1)!.url.split('?')[0];
      },
      get search() {
        const at = entries.at(-1)!.url.indexOf('?');
        return at < 0 ? '' : entries.at(-1)!.url.slice(at);
      },
    },
    history: {
      get state() {
        return entries.at(-1)!.state;
      },
      pushState: (state: unknown, _title: string, url: string) => entries.push({ state, url }),
      replaceState: (state: unknown, _title: string, url: string) => {
        entries[entries.length - 1] = { state, url };
      },
      back: () => {
        entries.pop();
        popstate();
      },
    },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    dispatchEvent: (event: Event) => events.push(event.type),
  };
  try {
    openOverList(feedHref.request('req_aaaaaaaaaaaaaaaaaaa2'));
    // The request's own address, clean; the entry keeps the list (and its filter) underneath.
    assert.equal(entries.at(-1)!.url, '/feed/requests/req_aaaaaaaaaaaaaaaaaaa2');
    assert.equal(listBehind(entries.at(-1)!.state), '/feed/requests?tag=pdf');
    assert.deepEqual(events, ['popstate']);
    // Close is Back: the list's entry, as it was.
    closeOverList();
    assert.equal(entries.length, 1);
    assert.equal(listBehind(entries[0]!.state), null);
    // A list that no longer holds it: the same address becomes the request's own page.
    openOverList(feedHref.request('req_aaaaaaaaaaaaaaaaaaa2'));
    leaveOverList();
    assert.deepEqual(entries.at(-1), { state: {}, url: '/feed/requests/req_aaaaaaaaaaaaaaaaaaa2' });
    assert.equal(entries.length, 2);
  } finally {
    globals.window = before.window;
    globals.PopStateEvent = before.PopStateEvent;
  }
});

// -------------------------------------------------------------------------------------------
// Round 2 of the client audit (13 Oct)

/** A fetch that never answers until the request is given up (a stalled database or function). */
function stalled(counter: { calls: number }): typeof fetch {
  return (_url, init) => {
    counter.calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });
  };
}

test('client-1: a stalled status read ends in the error state after its timeout, asked once', async () => {
  assert.equal(FEED_GATE_TIMEOUT_MS, 8_000);
  resetFeedGate();
  const counter = { calls: 0 };
  const started = Date.now();
  const gate = await loadFeedGate({
    fresh: true,
    fetcher: stalled(counter),
    retryMs: [0, 0],
    timeoutMs: 30,
  });
  assert.deepEqual(gate, { phase: 'error' });
  // A read that stalled is not asked again by itself: Try again asks once more.
  assert.equal(counter.calls, 1);
  assert.ok(Date.now() - started < 2_000);
  // Not in flight any more: the next caller (Try again) asks anew.
  const again = await loadFeedGate({ fetcher: stalled(counter), retryMs: [], timeoutMs: 10 });
  assert.deepEqual(again, { phase: 'error' });
  assert.equal(counter.calls, 2);
  resetFeedGate();
});

test('client-1: a stalled list read fails as a timeout (no retry); the caller’s own abort is not one', async () => {
  assert.equal(READ_TIMEOUT_MS, 8_000);
  const counter = { calls: 0 };
  await assert.rejects(
    getServices(NO_OFFERED_FILTERS, null, {
      fetcher: stalled(counter),
      retryDelayMs: 0,
      timeoutMs: 20,
    }),
    (error: unknown) => error instanceof FeedFailure && error.code === 'timeout' && error.retryable,
  );
  assert.equal(counter.calls, 1);
  await assert.rejects(
    getRequests(NO_REQUEST_FILTERS, null, { fetcher: stalled(counter), timeoutMs: 20 }),
    (error: unknown) => error instanceof FeedFailure && error.code === 'timeout',
  );
  const copy = feedErrorCopy(new FeedFailure(0, 'timeout', true), 'list');
  assert.deepEqual(copy, {
    title: 'Central City is taking too long to answer.',
    detail: 'Try again in a moment.',
  });
  // Leaving the page aborts the read: that is no failure to show.
  const controller = new AbortController();
  const leaving = getServices(NO_OFFERED_FILTERS, null, {
    fetcher: stalled(counter),
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  controller.abort();
  await assert.rejects(leaving, (error: unknown) => (error as Error).name === 'AbortError');
});

test('api-4: a list read again past every cache carries a throwaway fresh parameter (services only)', async () => {
  assert.equal(freshParam('', 5), '?fresh=5');
  assert.equal(freshParam('?q=pdf', 5), '?q=pdf&fresh=5');
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    urls.push(String(url));
    return String(url).includes('/requests')
      ? json(200, { requests: [], next: null })
      : json(200, {
          snapshotAt: NOW,
          degraded: false,
          sources: [],
          services: [],
          next: null,
          total: 0,
        });
  };
  const filters = { ...NO_OFFERED_FILTERS, q: 'pdf' };
  await getServices(filters, null, { fetcher });
  await getServices(filters, null, { fetcher, cache: 'no-store' });
  await getRequests(NO_REQUEST_FILTERS, null, { fetcher, cache: 'no-store' });
  assert.equal(urls[0], `${FEED_PATHS.services}?q=pdf`);
  assert.match(urls[1]!, new RegExp(`^${FEED_PATHS.services}\\?q=pdf&fresh=\\d+$`));
  // The requests route refuses parameters it doesn't know (400): never there.
  assert.equal(urls[2], FEED_PATHS.requests);
  assert.equal(readFeedRequestQuery({ fresh: '1' }), null);
  // The address bar never shows it.
  assert.doesNotMatch(offeredSearch(filters), /fresh/);
});

test('ui-1 and client-3: repeated titles never read the same, the next part of the address tells them apart', () => {
  const travel = (id: string, path: string) =>
    service({
      id,
      title: 'StableTravel',
      provider: { host: 'stabletravel.dev', name: 'StableTravel' },
      url: `https://stabletravel.dev${path}`,
    });
  const titles = shownTitles([
    travel('svc_aaaaaaaaaaaaaaaaaaaa', '/api/seats-aero/search'),
    travel('svc_bbbbbbbbbbbbbbbbbbbb', '/api/google-flights/search'),
    travel('svc_cccccccccccccccccccc', '/api/google-flights/details'),
  ]);
  assert.deepEqual(
    [...titles.values()],
    [
      'StableTravel · seats-aero/search',
      'StableTravel · google-flights/search',
      'StableTravel · details',
    ],
  );
  for (const title of titles.values()) assert.doesNotMatch(title, /(\b\w+\b) · \1$/);
});

test('client-9: one day is "1 day left", the card and the details agree, no "24 h" chip', () => {
  const at = (ms: number) => ({ deadline: NOW + ms, expiresAt: NOW + ms });
  assert.equal(deadlineParts(at(1.3 * DAY), NOW).sub, '1 day left');
  assert.equal(timeLeft(at(1.3 * DAY), NOW), '1 day');
  // 2.6 days: both say 2 (whole days).
  assert.equal(deadlineParts(at(2.6 * DAY), NOW).sub, '2 days left');
  assert.equal(timeLeft(at(2.6 * DAY), NOW), '2 days');
  for (const ms of [0.5, 1, 1.3, 1.99, 2.6, 6.9, 13.2].map((days) => days * DAY))
    assert.equal(
      deadlineParts(at(ms), NOW).sub.replace(/ left$/, ''),
      ms < DAY ? 'Due within a day' : timeLeft(at(ms), NOW),
      String(ms / DAY),
    );
  // Under a day: at most 23 h.
  assert.equal(timeLeft(at(23.7 * HOUR), NOW), '23 h');
  assert.equal(timeLeft(at(10 * MINUTE), NOW), '1 h');
  // Thousands separated, exact.
  assert.equal(dollars('100000000000'), '$100,000');
  assert.equal(dollars('2500000000'), '$2,500');
  assert.equal(dollars('2500123456'), '$2,500.123456');
  assert.equal(dollars('7000'), '$0.007');
  assert.equal(budgetMain(budget('100000000000', '100000')), '$100,000.00');
});

test('client-6 and ui-5: the form refuses only what the server always refuses; dates, times and amounts pass', () => {
  const secret = 'Remove the email, phone number or key. Everything here is public.';
  const check = (description: string) =>
    draftProblems({ ...EMPTY_DRAFT, title: 'Convert CSV files', description }, NOW).description;
  const server = (description: string) =>
    checkRequestText({
      title: 'Convert CSV files',
      description,
      displayName: null,
      capabilities: [],
    }).ok;
  // Requests the server accepts: about keys and phrases, large numbers, and dates, times, cells
  // and amounts after a phone or channel word. An address with an unusual ending is the server's
  // to read (it holds "icon@2x.png" for review, never refuses it).
  for (const text of [
    'Find the private key rotation policy docs for our KMS',
    'Explain what a seed phrase is to beginners in a short video',
    'Write a guide to recovery phrase backups for a wallet app',
    'Label 2 000 000 000 images for a dataset',
    'Process 1200 telephone survey records from 2024',
    'Call the API 3 times a day for 30 days',
    'Schedule a call 2026-10-20 14:00 to review',
    'Call 2026-10-20 works for me',
    'Cell 12345678 in the sheet is wrong',
    'Signal 20.000 - 30.000 USD',
    'Rename the sprites like icon@2x.png',
  ]) {
    assert.equal(check(text), undefined, text);
    assert.equal(server(text), true, text);
  }
  // Clear contact data and keys: the form says so before sending, and the server refuses them.
  for (const text of [
    'Ring +49 151 2345678 after six',
    'Call +1 (555) 123-4567',
    'Tel:+491512345678',
    'Dial 0049 151 2345678',
    'Dial 00 41 44 123 45 67',
    'Mail me at someone@example.org',
    `Key 0x${'ab'.repeat(32)}`,
  ]) {
    assert.equal(check(text), secret, text);
    assert.equal(server(text), false, text);
  }
  // A number after a phone word is the server's to read: the form sends it, the server decides.
  for (const text of [
    'Phone 0151 23456789 or 030-1234-5678',
    'Call 555-123-4567',
    'Tel: (030) 1234 5678',
    'WhatsApp 0151 23456789',
    'reach me at 555 123 4567',
  ]) {
    assert.equal(check(text), undefined, text);
    assert.equal(server(text), false, text);
  }
  // Never wider than the server: what the form refuses, the server refuses too (seeded mix of
  // numbers, + and 00 prefixes, signs, words, dates, addresses and invisible characters).
  const pieces = [
    '+',
    '+4',
    '+10',
    ' +',
    '00',
    '00 4',
    '0049',
    '0',
    '1',
    '12',
    '49',
    '100',
    '151',
    '345',
    '6789',
    '2345678',
    ' ',
    '  ',
    '.',
    '-',
    '(',
    ')',
    ',',
    ':',
    '/',
    '\n',
    'Tel',
    'call',
    'USD',
    '$',
    'a',
    'O',
    'l',
    'Ab1',
    '2026',
    '@',
    'example.com',
    'icon',
    '2x.png',
    '%2B',
    '\u200b',
    '１',
  ];
  let seed = 42;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let refused = 0;
  for (let i = 0; i < 20_000; i++) {
    let text = 'Need ';
    for (let k = 3 + next(12); k > 0; k--) text += pieces[next(pieces.length)];
    if (check(text) !== secret) continue;
    refused += 1;
    assert.equal(server(text), false, JSON.stringify(text));
  }
  assert.ok(refused > 50, String(refused));
});

test('client-7: any changed field is a new request with a new key; the same request keeps its key', () => {
  let made = 0;
  const make = () => `key-${String(++made).padStart(4, '0')}`;
  const draft = {
    ...EMPTY_DRAFT,
    title: 'Check links',
    description: 'All of them.',
    budget: '25',
  };
  const first = postKey(null, requestBody(draft, ''), make);
  assert.equal(postKey(first, requestBody(draft, ''), make).key, first.key);
  const edits: Array<Partial<typeof draft>> = [
    { budget: '250' },
    { deadline: '2026-10-20' },
    { tags: 'links' },
    { reply: 'https://example.org/me' },
    { postAs: 'agent_0001' },
  ];
  const keys = new Set([first.key]);
  for (const edit of edits) {
    const key = postKey(first, requestBody({ ...draft, ...edit }, ''), make).key;
    assert.ok(!keys.has(key), JSON.stringify(edit));
    keys.add(key);
  }
});

test('client-8: a full Feed and paused posting say so; the open-requests cap keeps its words', async () => {
  const full = await failureOf(
    json(429, { error: 'The Feed is full right now. Try again later.' }),
  );
  assert.deepEqual(feedErrorCopy(full, 'post'), {
    title: 'Your request wasn’t posted.',
    detail: 'The Feed is full right now. Try again later.',
  });
  const paused = await failureOf(
    json(503, { error: 'Posting is paused for now. Try again later.' }),
  );
  assert.deepEqual(feedErrorCopy(paused, 'post'), {
    title: 'Your request wasn’t posted.',
    detail: 'Posting is paused for now. Try again later.',
  });
  // Elsewhere a 503 is still ours.
  assert.equal(feedErrorCopy(paused, 'list').title, 'Something went wrong on our side.');
  const cap = await failureOf(
    json(429, {
      error: 'At most 5 open requests at a time. Close one, or wait until one expires.',
    }),
  );
  assert.deepEqual(feedErrorCopy(cap, 'post'), {
    title: 'You have too many open requests.',
    detail: 'Close one first.',
  });
  const limited = await failureOf(json(429, {}, { 'Retry-After': '600' }));
  assert.equal(
    feedErrorCopy(limited, 'post').title,
    'Too many requests were posted from your account or network recently.',
  );
});

test('client-4: your own request stays in a search the server matches (words read as the server reads them)', () => {
  const mine = {
    title: 'Extract totals from 40 supplier invoices (PDF)',
    description: 'Scanned, mixed layouts.',
    capabilities: ['csv-export'],
  };
  assert.deepEqual(searchWords('invoices,pdf'), ['invoices', 'pdf']);
  for (const q of ['invoices,pdf', 'supplier/invoices', 'invoic', 'csv-export', 'PDF totals'])
    assert.ok(requestMatches(mine, { q, tag: '' }), q);
  for (const q of ['receipts', 'x', 'invoices receipts'])
    assert.ok(!requestMatches(mine, { q, tag: '' }), q);
  assert.ok(requestMatches(mine, { q: '', tag: 'csv-export' }));
  assert.ok(!requestMatches(mine, { q: 'invoices', tag: 'ocr' }));
});

test('ui-7: an unreadable max_price in a link is no filter (Any), so the list loads', () => {
  for (const value of ['abc', '-1', '1e-3', '0.0000001', '1'.repeat(25)])
    assert.equal(readOfferedFilters(`?max_price=${value}`).maxPrice, '', value);
  assert.equal(readOfferedFilters('?max_price=0.05').maxPrice, '0.05');
  // The server allows 0.
  assert.equal(readOfferedFilters('?max_price=0').maxPrice, '0');
});

test('data-7: a 0 its own recent paid call contradicts is "Not reported", never New or no calls', () => {
  const usage = (paidCalls30d: number | null, lastCalledAt: number | null) => ({
    paidCalls30d,
    payers30d: null,
    lastCalledAt,
    reportedBy: 'x402 Bazaar' as const,
  });
  assert.equal(countMissing(usage(0, NOW - 22 * DAY), NOW), true);
  assert.equal(usesShort(usage(0, NOW - 22 * DAY), NOW), 'Not reported');
  assert.equal(useFact(usage(0, NOW - 3 * HOUR), NOW), 'Paid calls not reported');
  assert.equal(useSub(usage(0, NOW - 22 * DAY), NOW), 'Last paid call 22 days ago');
  // Older than the 30 days the count covers: no recent uses, truly.
  assert.equal(usesShort(usage(0, NOW - 40 * DAY), NOW), 'No recent uses');
  assert.equal(usesShort(usage(0, null), NOW), 'New');
  const html = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({ usage: usage(0, NOW - 22 * DAY) }),
      now: NOW,
    }),
  );
  assert.match(html, /<dt>uses, 30 days<\/dt><dd>Not reported<\/dd>/);
  assert.doesNotMatch(html, /No paid uses reported yet|>New<|No paid calls reported/);
});

test('a Central City listing shows its own counted uses: New, growing counts, then no recent uses', () => {
  // server/feed/offers/uses.ts: a new row is 0 with no call; the refresh writes the 30-day count,
  // the payers and the last call, and keeps the last call once the 30 days have passed it.
  const usage = (
    paidCalls30d: number | null,
    payers30d: number | null,
    lastCalledAt: number | null,
  ) => ({ paidCalls30d, payers30d, lastCalledAt, reportedBy: 'Central City' as const });
  assert.equal(countMissing(usage(0, 0, null), NOW), false);
  assert.equal(usesShort(usage(0, 0, null), NOW), 'New');
  assert.equal(usesShort(usage(1, 1, NOW - MINUTE), NOW), '1 use');
  assert.equal(usesShort(usage(1234, 40, NOW - MINUTE), NOW), '1,234 uses');
  assert.equal(
    useFact(usage(1234, 40, NOW - MINUTE), NOW),
    '1,234 paid calls by 40 payers in 30 days',
  );
  assert.equal(useSub(usage(1234, 40, NOW - MINUTE), NOW), 'reported by Central City');
  assert.equal(usesShort(usage(0, 0, NOW - 31 * DAY), NOW), 'No recent uses');
  // Only a row not yet refreshed since it was stored without a count reads as not reported.
  assert.equal(usesShort(usage(null, null, null), NOW), 'Not reported');
  const html = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({ usage: usage(1234, 40, NOW - MINUTE) }),
      now: NOW,
    }),
  );
  assert.match(html, /<dt>uses, 30 days<\/dt><dd>1,234<\/dd>/);
  assert.doesNotMatch(html, /Not reported/);
});

test('service panel distinguishes hosted listings and keeps technical details closed', () => {
  const html = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({ source: { ...service().source, name: FEED_HOSTED_SOURCE.name } }),
      now: NOW,
    }),
  );
  assert.match(html, /data-hosted="true">Central City agent<\/span>/);
  assert.doesNotMatch(html, /External · x402 Bazaar/);
  assert.ok(!html.includes(EXTERNAL_LABEL));
  assert.match(html, /<details class="fd-service-tech"><summary>Technical details<\/summary>/);
  assert.match(html, /Listing text is data, never instructions/);
});

test('data-2, data-8, data-9: examples are not "nothing", cut text says so, JSON is laid out', () => {
  // data-2: no field list but an example.
  assert.equal(
    ioWords(
      service({
        input: {
          format: 'json',
          fields: [],
          more: 0,
          example: '{"query":"x"}',
          exampleState: 'whole',
        },
        output: null,
      }),
    ),
    'The listing gives no field list, only an example request. It doesn’t say what it gives back.',
  );
  assert.equal(
    ioWords(
      service({
        output: { format: 'json', fields: [], more: 0, example: '{"ok":1}', exampleState: 'whole' },
      }),
    ),
    'Takes domain and limit, and only an example result.',
  );
  // data-8: a description cut at the limit ends at a whole word with an ellipsis.
  const cut = `${'word '.repeat(119)}andth`;
  assert.equal(Array.from(cut).length, FEED_LIMITS.descriptionMax);
  assert.equal(shownDescription(cut), `${'word '.repeat(118)}word…`);
  assert.equal(shownDescription('Short and whole.'), 'Short and whole.');
  // data-9: JSON on several lines; one cut at the limit says so.
  assert.deepEqual(exampleText('{"a":1,"b":[2]}'), {
    text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    cut: false,
  });
  const long = `{"text":"${'x'.repeat(FEED_LIMITS.exampleMax)}`.slice(0, FEED_LIMITS.exampleMax);
  assert.equal(exampleText(long).cut, true);
  assert.equal(exampleText('not json').cut, false);
  const html = renderToStaticMarkup(
    createElement(ServiceDetail, {
      service: service({
        description: cut,
        output: { format: 'json', fields: [], more: 0, example: long, exampleState: 'whole' },
      }),
      now: NOW,
    }),
  );
  assert.match(html, /Cut at 2,000 characters, so it ends early\./);
  assert.match(html, /word…<\/p>/);
});

const feedRequest = request;

test('P1: signed out, a request’s details are read-only: Sign in to respond and to report, never Respond or Report', () => {
  const request = feedRequest({ reply: 'https://example.org/me' });
  const out = renderToStaticMarkup(
    createElement(
      FeedSignedIn.Provider,
      { value: false },
      createElement(RequestDetail, { headId: 'h', request, now: NOW, manage: true }),
    ),
  );
  // With a reply handle both actions ask for sign-in: Respond first (primary), then Report.
  assert.match(
    out,
    /<button type="button" class="fd-btn primary">Sign in to respond<\/button><button type="button" class="fd-btn">Sign in to report<\/button>/,
  );
  assert.doesNotMatch(out, />Respond<|>Report</);
  assert.match(out, />Copy link</);
  // Signed out, the account's own page asks for sign-in first; the link's name is just that.
  assert.match(
    out,
    /Posted it\? <a href="\/feed\/requests\/[^"]+\/manage">Sign in to close it<\/a>/,
  );
  assert.doesNotMatch(out, /Sign in to close it<span/);
  const noHandle = renderToStaticMarkup(
    createElement(
      FeedSignedIn.Provider,
      { value: false },
      createElement(RequestDetail, {
        headId: 'h',
        request: { ...request, reply: null },
        now: NOW,
      }),
    ),
  );
  assert.match(noHandle, /<button type="button" class="fd-btn primary">Sign in to report</);
  assert.doesNotMatch(noHandle, /Sign in to respond/);
  // Signed in: the actions, and the account's Manage link (ui-10, the drawer too).
  const signedIn = renderToStaticMarkup(
    createElement(RequestDetail, { headId: 'h', request, now: NOW, manage: true }),
  );
  assert.match(signedIn, />Respond</);
  assert.match(signedIn, />Report</);
  assert.match(
    signedIn,
    /Posted it from this account\? <a href="[^"]+\/manage">Manage<span class="visually-hidden"> this request<\/span><\/a>/,
  );
  assert.doesNotMatch(signedIn, /Sign in to/);
});

// -------------------------------------------------------------------------------------------
// Review of #332 (13 Oct)

/** A Response whose body starts and then never ends, until the request is given up. */
function stalledBody(counter: { calls: number }, status: number): typeof fetch {
  return async (_url, init) => {
    counter.calls += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"'));
        init?.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('The operation was aborted.', 'AbortError')),
        );
      },
    });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
}

/** A window whose history is `entries` (the last is the current one), for feedNav and feedSignIn. */
function withHistory(entries: Array<{ state: unknown; url: string }>, run: () => void) {
  const globals = globalThis as { window?: unknown; PopStateEvent?: unknown };
  const before = { window: globals.window, PopStateEvent: globals.PopStateEvent };
  const listeners = new Map<string, () => void>();
  globals.PopStateEvent = class extends Event {};
  globals.window = {
    location: {
      get pathname() {
        return entries.at(-1)!.url.split('?')[0];
      },
      get search() {
        const at = entries.at(-1)!.url.indexOf('?');
        return at < 0 ? '' : entries.at(-1)!.url.slice(at);
      },
    },
    history: {
      get state() {
        return entries.at(-1)!.state;
      },
      pushState: (state: unknown, _title: string, url: string) => entries.push({ state, url }),
      replaceState: (state: unknown, _title: string, url: string) => {
        entries[entries.length - 1] = { state, url };
      },
      back: () => {
        if (entries.length > 1) entries.pop();
        listeners.get('popstate')?.();
      },
    },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    dispatchEvent: () => true,
    scrollTo: () => undefined,
  };
  try {
    run();
  } finally {
    globals.window = before.window;
    globals.PopStateEvent = before.PopStateEvent;
  }
}

test('#332 review 1: signed in from "Sign in to respond", the extra entry goes: one Close or Back leaves the drawer', () => {
  const list = '/feed/requests';
  const drawerUrl = feedHref.request('req_aaaaaaaaaaaaaaaaaaa2');
  const entries: Array<{ state: unknown; url: string }> = [{ state: null, url: list }];
  withHistory(entries, () => {
    openOverList(drawerUrl);
    const drawer = entries.at(-1)!;
    askFeedSignIn('respond');
    // Sign-in at the same address, its own entry, the drawer's list kept underneath.
    assert.equal(entries.length, 3);
    assert.equal(signInActionOf(entries.at(-1)!.state), 'respond');
    assert.equal(listBehind(entries.at(-1)!.state), list);
    leaveFeedSignIn();
    // Back on the drawer's own entry, as it was: one Close (Back) is the list.
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.at(-1), drawer);
    closeOverList();
    assert.deepEqual(entries, [{ state: null, url: list }]);
    // Nothing to leave without an action (a manage link's sign-in).
    leaveFeedSignIn();
    assert.equal(entries.length, 1);
  });
  // A tab with no entry before the sign-in one: it stops asking for sign-in where it is.
  const alone: Array<{ state: unknown; url: string }> = [
    { state: { feedSignIn: 'post' }, url: list },
  ];
  withHistory(alone, () => leaveFeedSignIn());
  assert.deepEqual(alone, [{ state: {}, url: list }]);
});

test('#329 review: a filter change that lands on a drawer’s entry drops the list it covered', () => {
  const entries: Array<{ state: unknown; url: string }> = [{ state: null, url: '/feed/requests' }];
  withHistory(entries, () => {
    openOverList(feedHref.request('req_aaaaaaaaaaaaaaaaaaa2'));
    assert.equal(drawerOpen(), true);
    goTo('/feed/requests?q=invoices', { replace: true });
    assert.equal(listBehind(entries.at(-1)!.state), null);
    assert.equal(drawerOpen(), false);
    // On a list entry, its state stays as it was.
    entries[entries.length - 1] = { state: { other: 1 }, url: '/feed/requests' };
    goTo('/feed/requests?q=pdf', { replace: true });
    assert.deepEqual(entries.at(-1), { state: { other: 1 }, url: '/feed/requests?q=pdf' });
  });
});

test('#332 review 3: the form flags clear phone numbers only; the server stays the authority', () => {
  const check = (description: string) =>
    draftProblems({ ...EMPTY_DRAFT, title: 'Convert CSV files', description }, NOW).description;
  // Rising zero-padded lists and round + increments are the server's to read, never refused here.
  for (const text of [
    'Episodes 001 002 003 004 005',
    '+1000 +2000 +3000 +4000 followers',
    'Budget 500, +49 151 2345678',
    'Ref A12 +49 151 2345678',
  ])
    assert.equal(check(text), undefined, text);
});

test('#332 review 4: example JSON is laid out only when that changes nothing but the layout', () => {
  for (const listed of ['{"big":1e21}', '{"id":12345678901234567890}', '{"price":1.50}'])
    assert.deepEqual(exampleText(listed), { text: listed, cut: false }, listed);
  // Read back these print otherwise: what laying them out would have shown.
  assert.equal(JSON.stringify(JSON.parse('{"big":1e21}')), '{"big":1e+21}');
  assert.equal(JSON.stringify(JSON.parse('{"price":1.50}')), '{"price":1.5}');
  assert.deepEqual(exampleText(' {"a":1} '), { text: '{\n  "a": 1\n}', cut: false });
  // The source's cut drops a trailing space: one point short of the limit may be cut too.
  const short = `{"text":"${'x'.repeat(FEED_LIMITS.exampleMax)}`.slice(
    0,
    FEED_LIMITS.exampleMax - 1,
  );
  assert.equal(exampleText(short).cut, true);
  assert.equal(exampleText(short.slice(0, -1)).cut, false);
  // A description one short of its limit ends with the marker, its last (whole) word kept.
  const description = `${'word '.repeat(119)}word`;
  assert.equal(Array.from(description).length, FEED_LIMITS.descriptionMax - 1);
  assert.equal(shownDescription(description), `${description}…`);
  assert.equal(shownDescription(description.slice(0, -1)), description.slice(0, -1));
});

test('#332 review: a title that ends with the address’s only part does not say it again', () => {
  const titled = (id: string, path: string) =>
    service({
      id,
      title: 'Foo search',
      provider: { host: 'foo.example.com', name: null },
      url: `https://foo.example.com${path}`,
    });
  const titles = shownTitles([
    titled('svc_aaaaaaaaaaaaaaaaaaaa', '/search'),
    titled('svc_bbbbbbbbbbbbbbbbbbbb', '/v2/lookup'),
  ]);
  assert.deepEqual([...titles.values()], ['Foo search', 'Foo search · lookup']);
  for (const title of titles.values()) assert.doesNotMatch(title, /(\b\w+\b) · \1$/);
});

test('#328 review, Feed D6: no Open service, so no browser note promising Payment Required', () => {
  for (const method of ['GET', 'POST', null] as const) {
    const html = renderToStaticMarkup(
      createElement(ServiceDetail, { service: service({ method }), now: NOW }),
    );
    assert.doesNotMatch(html, /Open service/);
    assert.doesNotMatch(html, /Opens the address in your browser/);
    assert.doesNotMatch(html, /Payment Required/);
  }
});

test('#332 review 6: the sidebar asks again at most once per 30 s, and never on focus or online after a 429', async () => {
  assert.equal(FEED_SIDEBAR_RETRY_MS, 30_000);
  let calls = 0;
  const answer =
    (status: number, body: unknown): typeof fetch =>
    async () => {
      calls += 1;
      return json(status, body);
    };
  const T = 1_000_000;
  // A 429: this address was told to wait. Focus and online ask nothing; the timer does.
  resetFeedGate();
  const limited = answer(429, { error: 'Too many requests' });
  await loadFeedGate({ fresh: true, fetcher: limited, retryMs: [] });
  assert.deepEqual(knownFeedGate(), { phase: 'error', limited: true });
  assert.equal(retryFeedGate('focus', { now: T, fetcher: limited, retryMs: [] }), false);
  assert.equal(retryFeedGate('online', { now: T, fetcher: limited, retryMs: [] }), false);
  assert.equal(calls, 1);
  assert.equal(retryFeedGate('timer', { now: T, fetcher: limited, retryMs: [] }), true);
  await loadFeedGate();
  assert.equal(calls, 2);
  // Any other failure: focus asks again, but once per 30 s however often the window gets focus.
  resetFeedGate();
  calls = 0;
  const failing = answer(500, {});
  await loadFeedGate({ fresh: true, fetcher: failing, retryMs: [] });
  assert.equal(retryFeedGate('focus', { now: T, fetcher: failing, retryMs: [] }), true);
  await loadFeedGate();
  for (const [trigger, at] of [
    ['focus', T + 1_000],
    ['online', T + 29_999],
    ['timer', T + 29_999],
  ] as const)
    assert.equal(retryFeedGate(trigger, { now: at, fetcher: failing, retryMs: [] }), false);
  assert.equal(calls, 2);
  assert.equal(retryFeedGate('focus', { now: T + 30_000, fetcher: failing, retryMs: [] }), true);
  await loadFeedGate();
  assert.equal(calls, 3);
  // On: nothing to ask again.
  resetFeedGate();
  const status: FeedStatus = {
    snapshotAt: null,
    degraded: false,
    sources: [],
    services: 3,
    openRequests: 2,
  };
  await loadFeedGate({ fresh: true, fetcher: answer(200, status), retryMs: [] });
  assert.equal(retryFeedGate('timer', { now: T, fetcher: failing, retryMs: [] }), false);
  resetFeedGate();
});

test(
  '#332 review: a status read whose body stalls ends as stalled, asked once',
  { timeout: 5_000 },
  async () => {
    resetFeedGate();
    for (const status of [200, 503]) {
      const counter = { calls: 0 };
      const gate = await loadFeedGate({
        fresh: true,
        fetcher: stalledBody(counter, status),
        retryMs: [0, 0],
        timeoutMs: 30,
      });
      assert.deepEqual(gate, { phase: 'error' }, String(status));
      // Not asked again by itself: the server was slow, not briefly down.
      assert.equal(counter.calls, 1, String(status));
    }
    resetFeedGate();
  },
);

test(
  '#332 review 7: a 5xx whose body stalls ends as a timeout within the deadline',
  { timeout: 5_000 },
  async () => {
    const counter = { calls: 0 };
    const started = Date.now();
    await assert.rejects(
      getServices(NO_OFFERED_FILTERS, null, {
        fetcher: stalledBody(counter, 503),
        retryDelayMs: 0,
        timeoutMs: 30,
      }),
      (error: unknown) =>
        error instanceof FeedFailure && error.code === 'timeout' && error.retryable,
    );
    assert.equal(counter.calls, 1);
    assert.ok(Date.now() - started < 2_000);
    // The caller's own abort while the failure's body is read is no failure to show.
    const controller = new AbortController();
    const leaving = getRequests(NO_REQUEST_FILTERS, null, {
      fetcher: async (url, init) => {
        const response = await stalledBody(counter, 500)(url, init);
        queueMicrotask(() => controller.abort());
        return response;
      },
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await assert.rejects(leaving, (error: unknown) => (error as Error).name === 'AbortError');
  },
);

test('#332 review: writes get no deadline; withDeadline clears its timer and its abort listener', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const slow: typeof fetch = async (_url, init) => {
    signals.push(init?.signal ?? undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return json(201, { ok: true });
  };
  const body = requestBody({ ...EMPTY_DRAFT, title: 'Check links', description: 'All.' }, 'k');
  // Slower than the read deadline, and still answered: a write waits for its answer.
  assert.deepEqual(await postRequest(body, { fetcher: slow, timeoutMs: 10 }), { ok: true });
  assert.equal(signals[0], undefined);
  const controller = new AbortController();
  await closeRequest('req_aaaaaaaaaaaaaaaaaaa2', null, {
    fetcher: slow,
    signal: controller.signal,
    timeoutMs: 10,
  });
  // The caller's own signal, not a deadline's.
  assert.equal(signals[1], controller.signal);
  // withDeadline: done clears the timer and stops following the caller.
  const caller = new AbortController();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const add = caller.signal.addEventListener.bind(caller.signal);
  const remove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    added.push(listener);
    add(type, listener, options as AddEventListenerOptions);
  }) as typeof caller.signal.addEventListener;
  caller.signal.removeEventListener = ((type: string, listener: EventListener) => {
    removed.push(listener);
    remove(type, listener);
  }) as typeof caller.signal.removeEventListener;
  const deadline = withDeadline(caller.signal, 20);
  assert.equal(added.length, 1);
  deadline.done();
  assert.deepEqual(removed, added);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(deadline.signal.aborted, false);
  assert.equal(deadline.timedOut(), false);
  caller.abort();
  assert.equal(deadline.signal.aborted, false);
  // Left running, the deadline ends it and says so.
  const late = withDeadline(undefined, 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(late.signal.aborted, true);
  assert.equal(late.timedOut(), true);
  late.done();
});
