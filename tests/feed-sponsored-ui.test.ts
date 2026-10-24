import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEED_HOSTED_SOURCE, FEED_USDC, type FeedService } from '../shared/feed.js';
import {
  FEED_SPONSORED_REFUSALS,
  sponsoredSplit,
  type FeedSponsoredCall,
  type FeedSponsoredCredit,
  type FeedSponsoredCreditView,
} from '../shared/feed-sponsored.js';
import { payAgent } from '../e2e/feed-fixtures.js';
import { NO_OFFERED_FILTERS, offeredSearch, readOfferedFilters } from '../src/feed/feedApi.js';
import { PayFailure } from '../src/feed/payApi.js';
import { forgetOpenPayments } from '../src/feed/pay/openPayments.js';
import {
  afterFreeFailure,
  dropFreeKey,
  forgetSponsored,
  freeKey,
  getSponsoredCredit,
  primeSponsored,
  SponsoredFailure,
  startSponsoredCall,
} from '../src/feed/pay/sponsoredApi.js';
import {
  doneLine,
  freeCardBody,
  freeCardTitle,
  freeCovers,
  freeLines,
  PAUSED_TEXT,
  sponsoredRefusalText,
} from '../src/feed/pay/sponsoredModel.js';
import { FreeCallCard } from '../src/feed/pay/FreeCall.js';
import { UseSheet } from '../src/feed/pay/UseSheet.js';
import { ServiceCard, ServiceRow } from '../src/feed/ServiceItem.js';
import { FirstServiceCard } from '../src/agents/v4/FirstServiceCard.js';

/*
 * Free first buys in the page (the First service free mockup): the words, the client's requests
 * and refusals, and the pieces rendered to HTML (the agent page's card, the Feed's chip, the use
 * sheet's free price and Use free, the call after it). Synthetic data.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0);
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const SVC = 'svc_cccccccccccccccccccc';
const NOVA = 'agt-nova-0001';
const ORIN = 'agt-orin-0001';

function ccService(overrides: Partial<FeedService> = {}): FeedService {
  return {
    id: SVC,
    kind: 'external_service',
    title: 'Base USDC balance pro',
    capabilities: [],
    description: 'The USDC balance of a Base address.',
    provider: { host: 'centralcity.ai', name: 'Edward' },
    url: 'https://centralcity.ai/api/public/x402/off_cc1',
    method: 'POST',
    protocol: 'x402',
    x402Version: 2,
    network: 'eip155:8453',
    asset: FEED_USDC,
    scheme: 'exact',
    price: { raw: '1100000', decimals: 6, display: '1.1', unit: 'per_call' },
    payTo: '0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808',
    input: {
      format: 'json',
      fields: [
        { name: 'address', in: 'body', type: 'string', required: true, description: 'Address' },
      ],
      more: 0,
      example: null,
      exampleState: null,
    },
    output: { format: 'json', fields: [], more: 0, example: null, exampleState: null },
    source: {
      name: FEED_HOSTED_SOURCE.name,
      credit: FEED_HOSTED_SOURCE.credit,
      url: FEED_HOSTED_SOURCE.url,
      recordId: 'cc:off_cc1',
      fetchedAt: NOW,
      updatedAt: null,
    },
    usage: { paidCalls30d: 3, payers30d: 2, lastCalledAt: null, reportedBy: 'Central City' },
    lastSeenAt: NOW,
    status: 'active',
    moreFromHost: 0,
    ...overrides,
  };
}

const credits = (
  agents: Record<string, FeedSponsoredCredit>,
  serviceIds = [SVC],
): FeedSponsoredCreditView => ({
  agents: Object.entries(agents).map(([agentId, credit]) => ({ agentId, credit })),
  serviceIds,
  maxPriceRaw: '2000000',
});

/** Nova: new, no USDC (can't pay by itself), free first buy. Orin: ready, used its free buy. */
const agents = () => [
  payAgent({ agentId: ORIN, name: 'Orin' }),
  payAgent({
    agentId: NOVA,
    name: 'Nova',
    usdcRaw: '0',
    floatRaw: '0',
    ready: false,
    notReady: 'no_funds',
  }),
];
const on = (list = agents()) => ({
  phase: 'on' as const,
  list: { agents: list, defaultPerCallMaxRaw: '100000', floatTargetRaw: '1000000', readAt: NOW },
  loading: false,
});

const sheet = (service = ccService()) =>
  renderToStaticMarkup(createElement(UseSheet, { service, access: on(), onBack: () => undefined }));

test('words: the card, the free price, what it covers, the split', () => {
  assert.equal(freeCardTitle('Nova'), 'Nova’s first service is on Central City');
  assert.equal(
    freeCardBody('Nova', '2000000'),
    'Pick one Central City service up to 2 USDC. Nova pays nothing.',
  );
  assert.deepEqual(
    freeLines('1100000').map((line) => [line.label, line.value]),
    [
      ['Price', '1.10 USDC'],
      ['Central City pays', '1.10 USDC'],
      ['You pay', '0 USDC'],
    ],
  );
  assert.equal(freeCovers('1100000', '2000000'), true);
  assert.equal(freeCovers('2000000', '2000000'), true);
  assert.equal(freeCovers('2000001', '2000000'), false);
  assert.equal(freeCovers('0', '2000000'), false);
  assert.equal(freeCovers('1100000', null), false);
  assert.deepEqual(sponsoredSplit('1100000'), { sellerRaw: '990000', feeRaw: '110000' });
  assert.equal(
    doneLine('Nova', '1100000', 'Edward'),
    'Nova’s first service. 1.10 USDC: 0.99 to Edward, 0.11 fee.',
  );
});

test('refusals: every 402 reason has short words; 503 unavailable says paused', () => {
  for (const reason of FEED_SPONSORED_REFUSALS) {
    const text = sponsoredRefusalText(
      new SponsoredFailure(402, 'credit_unavailable', reason),
      'Nova',
    );
    assert.ok(text.length > 10 && text.length < 90, `${reason}: ${text}`);
    assert.doesNotMatch(text, ARROWS);
  }
  assert.equal(
    sponsoredRefusalText(new SponsoredFailure(402, 'credit_unavailable', 'used'), 'Nova'),
    'Nova already used its free first buy.',
  );
  assert.equal(sponsoredRefusalText(new SponsoredFailure(503, 'unavailable'), 'Nova'), PAUSED_TEXT);
  assert.equal(PAUSED_TEXT, 'Free first buys are paused right now. Try again in a few minutes.');
});

test('requests: the credits read and the sponsored call carry the request header; refusals map', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const got = await getSponsoredCredit({
    fetcher: answer(200, credits({ a: 'available' })) as typeof fetch,
  });
  assert.deepEqual(got.agents, [{ agentId: 'a', credit: 'available' }]);
  assert.equal(seen[0]!.url, '/api/feed/sponsored-credit');
  assert.equal((seen[0]!.init.headers as Record<string, string>)['X-City-Request'], '1');
  const body = {
    agent_id: NOVA,
    use_credit: true as const,
    idempotency_key: 'sfp-key-0001',
    inputs: { body: { address: '0x1' } },
    max_price_usdc: '1.1',
  };
  const refused = async (status: number, payload: unknown) =>
    startSponsoredCall(SVC, body, { fetcher: answer(status, payload) as typeof fetch }).then(
      () => assert.fail('refused'),
      (error: unknown) => error,
    );
  const used = (await refused(402, {
    error: 'No sponsored purchase: used.',
    code: 'credit_unavailable',
    reason: 'used',
    retryable: false,
  })) as SponsoredFailure;
  assert.ok(used instanceof SponsoredFailure);
  assert.deepEqual([used.code, used.reason, used.final], ['credit_unavailable', 'used', true]);
  assert.equal(seen.at(-1)!.url, `/api/feed/services/${SVC}/sponsored-call`);
  assert.equal(seen.at(-1)!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen.at(-1)!.init.body)), body);
  const paused = (await refused(503, { code: 'unavailable', retryable: true })) as SponsoredFailure;
  assert.equal(paused.code, 'unavailable');
  // The engine's own refusal of the inputs: Feed pay's failure, with its fields.
  const inputs = await refused(400, {
    error: 'Invalid inputs.',
    code: 'invalid_inputs',
    retryable: false,
    fields: [{ field: 'address', in: 'body', problem: 'missing' }],
  });
  assert.ok(inputs instanceof PayFailure);
  assert.equal((inputs as PayFailure).code, 'invalid_inputs');
  assert.equal(((await refused(404, null)) as SponsoredFailure).code, 'off');
  const lost = (await startSponsoredCall(SVC, body, {
    fetcher: (async () => {
      throw new TypeError('offline');
    }) as typeof fetch,
  }).then(
    () => assert.fail('lost'),
    (error: unknown) => error,
  )) as SponsoredFailure;
  assert.deepEqual([lost.code, lost.final], ['network', false]);
});

test('one attempt, one key: the same agent, service and inputs keep it until dropped', () => {
  forgetSponsored();
  const inputs = { body: { address: '0x1' } };
  const key = freeKey(SVC, NOVA, inputs);
  assert.equal(freeKey(SVC, NOVA, { body: { address: '0x1' } }), key);
  assert.notEqual(freeKey(SVC, NOVA, { body: { address: '0x2' } }), key);
  assert.notEqual(freeKey(SVC, ORIN, inputs), key);
  dropFreeKey(SVC, NOVA, inputs);
  assert.notEqual(freeKey(SVC, NOVA, inputs), key);
  assert.ok(key.length <= 200);
});

test('the use sheet on a Central City service: First buy free and Used, the free price, Use free', () => {
  forgetOpenPayments();
  forgetSponsored();
  primeSponsored(credits({ [NOVA]: 'available', [ORIN]: 'used' }));
  const html = sheet();
  assert.match(html, /<b id="[^"]+">Nova<\/b><small class="fp-a-free">First buy free<\/small>/);
  assert.match(
    html,
    /<b id="[^"]+">Orin<\/b><small class="fp-a-free" data-used="true">Used<\/small>/,
  );
  // Nova has no USDC, but Central City pays: it can be picked, comes first, and is picked.
  const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
  assert.equal(radios.length, 2);
  assert.ok(radios.every((radio) => !radio.includes('disabled')));
  assert.match(radios[0]!, new RegExp(`checked="" value="${NOVA}"`));
  assert.doesNotMatch(html, /Nova has no USDC yet/);
  // Price 1.10 / Central City pays 1.10 / You pay 0 USDC, and the action is Use free.
  assert.match(html, /<dt>Price<\/dt><dd class="fp-line-v">1\.10 USDC<\/dd>/);
  assert.match(html, /<dt>Central City pays<\/dt><dd class="fp-line-v">1\.10 USDC<\/dd>/);
  assert.match(html, /<dt>You pay<\/dt><dd class="fp-line-v">0 USDC<\/dd>/);
  assert.match(html, /<button type="button" class="fd-btn primary fp-main">Use free<\/button>/);
  assert.doesNotMatch(html, /Check price|Pay 1\.10/);
  assert.doesNotMatch(html, ARROWS);
});

test('the use sheet stays the paid flow: no free agent, another service, or a price above the credit', () => {
  forgetOpenPayments();
  forgetSponsored();
  // Nothing known (or nothing free): today's sheet.
  let html = sheet();
  assert.doesNotMatch(html, /First buy free|Use free|Central City pays/);
  assert.match(html, /Check price/);
  // A service that is not on the list: no chips at all.
  primeSponsored(credits({ [NOVA]: 'available', [ORIN]: 'used' }));
  html = sheet(ccService({ id: 'svc_dddddddddddddddddddd' }));
  assert.doesNotMatch(html, /First buy free|>Used<|Use free/);
  // Above the credit's 2 USDC: the chip says it, but the price is the paid one.
  html = sheet(
    ccService({ price: { raw: '2500000', decimals: 6, display: '2.5', unit: 'per_call' } }),
  );
  assert.match(html, /First buy free/);
  assert.doesNotMatch(html, /Use free|Central City pays/);
  forgetSponsored();
});

test('the Feed chip: First buy free on the card and the row only when asked', () => {
  const props = {
    service: ccService(),
    title: 'Base USDC balance pro',
    colour: '',
    onOpen: () => {},
  };
  const card = renderToStaticMarkup(createElement(ServiceCard, { ...props, freeBuy: true }));
  assert.match(card, /<span class="fd-free-chip">First buy free<\/span>/);
  const row = renderToStaticMarkup(createElement(ServiceRow, { ...props, freeBuy: true }));
  assert.match(row, /<span class="fd-free-chip">First buy free<\/span>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ServiceCard, props)), /fd-free-chip/);
});

test('the free filter lives in the address (?free=1)', () => {
  assert.deepEqual(readOfferedFilters('?free=1'), { ...NO_OFFERED_FILTERS, free: true });
  assert.deepEqual(readOfferedFilters('?free=0'), NO_OFFERED_FILTERS);
  assert.equal(offeredSearch({ ...NO_OFFERED_FILTERS, free: true }), '?free=1');
  assert.equal(offeredSearch(NO_OFFERED_FILTERS), '');
});

test('the agent page: one card while the first buy is free, nothing otherwise', () => {
  forgetSponsored();
  primeSponsored(credits({ [NOVA]: 'available', [ORIN]: 'used' }));
  const html = renderToStaticMarkup(
    createElement(FirstServiceCard, { agentId: NOVA, name: 'Nova' }),
  );
  assert.match(html, /<p class="ap4-label">First service<\/p>/);
  assert.match(html, /<b id="[^"]+">Nova’s first service is on Central City<\/b>/);
  assert.match(html, /Pick one Central City service up to 2 USDC\. Nova pays nothing\./);
  assert.match(html, /<a class="ap4-btn" data-k="first-service" href="\/feed\?free=1">Choose<\/a>/);
  assert.doesNotMatch(html, ARROWS);
  assert.equal(
    renderToStaticMarkup(createElement(FirstServiceCard, { agentId: ORIN, name: 'Orin' })),
    '',
  );
  assert.equal(
    renderToStaticMarkup(createElement(FirstServiceCard, { agentId: 'agt-unknown', name: 'X' })),
    '',
  );
  // No Central City service listed for it: nothing to choose, no card.
  primeSponsored(credits({ [NOVA]: 'available' }, []));
  assert.equal(
    renderToStaticMarkup(createElement(FirstServiceCard, { agentId: NOVA, name: 'Nova' })),
    '',
  );
  forgetSponsored();
});

test('after Use free: paying, then Done. Paid by Central City. with the split and the result', () => {
  const call = (over: Partial<FeedSponsoredCall>): FeedSponsoredCall => ({
    callId: 'sp_aaaaaaaaaaaaaaaaaaaa',
    agentId: NOVA,
    serviceId: SVC,
    offerId: 'off_cc1',
    state: 'sent',
    sponsored: true,
    priceRaw: '1100000',
    payment: { payer: '0x1', router: 'router3', txHash: null },
    failure: null,
    result: null,
    ...over,
  });
  const render = (c: FeedSponsoredCall) =>
    renderToStaticMarkup(
      createElement(FreeCallCard, {
        call: c,
        agentName: 'Nova',
        seller: 'Edward',
        host: 'centralcity.ai',
        headingId: 'h',
      }),
    );
  assert.match(render(call({})), /Central City is paying for Nova’s first service…/);
  assert.match(render(call({ state: 'paid' })), /Paid by Central City\. Waiting for the result…/);
  const done = render(
    call({
      state: 'delivered',
      payment: { payer: '0x1', router: 'router3', txHash: `0x${'ab'.repeat(32)}` },
      result: { format: 'json', mime: 'application/json', text: '{"balance":"9214.51"}' },
    }),
  );
  assert.match(
    done,
    /<b>Done\. Paid by Central City\.<\/b><span>Nova’s first service\. 1\.10 USDC: 0\.99 to Edward, 0\.11 fee\.<\/span>/,
  );
  // No Base transaction link: on Basescan the payer is the sponsor, which stays private.
  assert.doesNotMatch(done, /Base transaction|basescan/);
  assert.match(done, /&quot;balance&quot;: &quot;9214\.51&quot;/);
  assert.match(done, /External/);
  assert.match(render(call({ state: 'paid_no_result' })), /The service sent no result\./);
  assert.match(
    render(call({ state: 'failed', failure: 'expired' })),
    /This free first buy didn’t go through\. Nothing was paid\./,
  );
  assert.doesNotMatch(done, ARROWS);
});

test('in progress reads In progress, unavailable shows nothing, and off is nothing free', () => {
  forgetOpenPayments();
  forgetSponsored();
  primeSponsored(credits({ [NOVA]: 'in_progress', [ORIN]: 'unavailable' }));
  let html = sheet();
  assert.match(html, /<small class="fp-a-free" data-used="true">In progress<\/small>/);
  assert.doesNotMatch(html, /First buy free|>Used<|Use free/);
  assert.equal(
    renderToStaticMarkup(createElement(FirstServiceCard, { agentId: NOVA, name: 'Nova' })),
    '',
  );
  // Off: no services, no maximum.
  primeSponsored({
    agents: [{ agentId: NOVA, credit: 'available' }],
    serviceIds: [],
    maxPriceRaw: '0',
  });
  html = sheet();
  assert.doesNotMatch(html, /First buy free|Use free/);
  forgetSponsored();
});

test('a busy or lost Use free keeps its key: the retry sends the same one; a refusal drops it', async () => {
  forgetSponsored();
  const inputs = { body: { address: '0x1' } };
  const answer = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  const failureOf = async (fetcher: typeof fetch) =>
    (await startSponsoredCall(
      SVC,
      {
        agent_id: NOVA,
        use_credit: true,
        idempotency_key: freeKey(SVC, NOVA, inputs),
        inputs,
        max_price_usdc: '1.1',
      },
      { fetcher },
    ).then(
      () => assert.fail('refused'),
      (error: unknown) => error,
    )) as SponsoredFailure;
  const key = freeKey(SVC, NOVA, inputs);
  // A connection dropped at commit can answer 503 busy after the buy began: same key again.
  for (const fetcher of [
    answer(503, { error: 'Busy, try again shortly.', code: 'busy', retryable: true }),
    answer(503, { error: 'unavailable', code: 'unavailable', retryable: true }),
    answer(500, { error: 'The operation could not be completed.' }),
    answer(502, null),
    (async () => {
      throw new TypeError('offline');
    }) as typeof fetch,
  ]) {
    const failure = await failureOf(fetcher);
    assert.equal(failure.final, false, `${failure.status} ${failure.code}`);
    afterFreeFailure(SVC, NOVA, inputs, failure);
    assert.equal(
      freeKey(SVC, NOVA, inputs),
      key,
      `${failure.status} ${failure.code} keeps the key`,
    );
  }
  // A definite refusal (402 used) started nothing: the next try takes a new key.
  const used = await failureOf(
    answer(402, { code: 'credit_unavailable', reason: 'used', retryable: false }),
  );
  assert.equal(used.final, true);
  afterFreeFailure(SVC, NOVA, inputs, used);
  assert.notEqual(freeKey(SVC, NOVA, inputs), key);
});
