import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEED_SOURCE, FEED_USDC, type FeedService } from '../shared/feed.js';
import {
  FEED_PAY_CALL_STATES,
  FEED_PAY_ERRORS,
  FEED_PAY_LIMITS,
  FEED_PAY_NOT_PAYABLE,
  FEED_PAY_NOTICE,
  FEED_PAY_PATHS,
  type FeedPayCallState,
  type FeedPayErrorCode,
} from '../shared/feed-pay.js';
import {
  newCallId,
  PAY_AGENT_IDS,
  payAgent,
  payAgents,
  payCall,
  payHistory,
  payQuote,
  payResult,
} from '../e2e/feed-fixtures.js';
import { FEED_PATH, feedHref, feedRoute } from '../src/feed/feedPaths.js';
import { feedSignInContext } from '../src/feed/feedSignIn.js';
import {
  callService,
  getCall,
  getPayAgents,
  getServiceCalls,
  PayFailure,
  payFailureOf,
  quoteService,
  setPerCallMax,
} from '../src/feed/payApi.js';
import {
  agentLines,
  agentOrder,
  buildInputs,
  CALL_GONE,
  callLine,
  callPageSub,
  confirmText,
  draftFromExample,
  EMPTY_INPUT_DRAFT,
  firstChoice,
  historyLine,
  inputForm,
  limitStartsText,
  listingPayState,
  lostAnswer,
  maxProblemText,
  maxSavedText,
  moveLine,
  notPayableBody,
  notPayableText,
  notPayableView,
  paymentLine,
  paymentNote,
  payButtonText,
  PER_CALL_MAX_RANGE,
  perCallMaxRaw,
  priceRoseText,
  quoteCheck,
  recheckNote,
  refusalSentence,
  refusalText,
  RESULT_NOTICE,
  resultKeptText,
  resultNotes,
  resultText,
  serverProblems,
  sizeText,
  stillLostText,
  usdcText,
  vsListingText,
  withMoney,
} from '../src/feed/pay/payModel.js';
import {
  answeredPayment,
  endGoneCall,
  forgetOpenPayments,
  getOpenPayment,
  getSheetDraft,
  keepSheetDraft,
  setOpenPayment,
  sheetWanted,
  updateOpenCall,
  type OpenPayment,
} from '../src/feed/pay/openPayments.js';
import { CallCard, ResultBlock } from '../src/feed/pay/CallCard.js';
import { agentScreenHref, UseSheet } from '../src/feed/pay/UseSheet.js';
import { ServiceActions, ServiceDetail } from '../src/feed/ServiceItem.js';

/*
 * "Use with my agent" (src/feed/pay, docs/FEED_PAY.md section 15): the words and rules as pure
 * functions, the client's requests and failures, and the drawer's pieces rendered to HTML. The
 * browser specs (e2e/feed-pay.spec.ts) drive the same pieces against the mocked routes.
 */

const NOW = Date.UTC(2026, 9, 14, 12, 0);
/** Arrow characters and arrow-like quotes: none anywhere in the Feed. */
const ARROWS = /[\u2190-\u21ff\u2794-\u27bf\u2900-\u297f\u2b00-\u2bff\u00ab\u00bb\u2039\u203a]/;

function service(overrides: Partial<FeedService> = {}): FeedService {
  return {
    id: 'svc_abcdefghijklmnopqrst',
    kind: 'external_service',
    title: 'Domain lookup',
    capabilities: ['whois'],
    description: 'Registration data for any domain.',
    provider: { host: 'lookup.example.com', name: 'Lookup' },
    url: 'https://lookup.example.com/v1/whois',
    method: 'GET',
    protocol: 'x402',
    x402Version: 2,
    network: 'eip155:8453',
    asset: FEED_USDC,
    scheme: 'exact',
    price: { raw: '20000', decimals: 6, display: '0.02', unit: 'per_call' },
    payTo: '0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808',
    input: {
      format: 'json',
      fields: [
        { name: 'limit', in: 'query', type: 'integer', required: false, description: '' },
        { name: 'domain', in: 'query', type: 'string', required: true, description: 'The name' },
      ],
      more: 0,
      example: '{\n  "domain": "stripe.com",\n  "limit": 5\n}',
      exampleState: 'whole',
    },
    output: { format: 'json', fields: [], more: 0, example: null, exampleState: null },
    source: {
      name: FEED_SOURCE.name,
      credit: FEED_SOURCE.credit,
      url: FEED_SOURCE.url,
      recordId: 'https://lookup.example.com/v1/whois',
      fetchedAt: NOW,
      updatedAt: null,
    },
    usage: { paidCalls30d: 11, payers30d: 7, lastCalledAt: null, reportedBy: 'x402 Bazaar' },
    lastSeenAt: NOW,
    status: 'active',
    moreFromHost: 0,
    ...overrides,
  };
}

const postService = () =>
  service({
    id: 'svc_bbbbbbbbbbbbbbbbbbbb',
    method: 'POST',
    url: 'https://api.exa.ai/search',
    provider: { host: 'api.exa.ai', name: 'Exa' },
    input: {
      format: 'json',
      fields: [
        { name: 'query', in: 'body', type: 'string', required: true, description: 'Search query' },
        { name: 'numResults', in: 'body', type: 'number', required: false, description: '' },
        { name: 'contents', in: 'body', type: 'object', required: false, description: '' },
        { name: 'deep', in: 'body', type: 'boolean', required: false, description: '' },
        { name: 'x-api-key', in: 'header', type: 'string', required: false, description: '' },
        { name: 'id', in: 'path', type: 'string', required: false, description: '' },
      ],
      more: 2,
      example: '{"query":"example search query","numResults":10,"type":"auto"}',
      exampleState: 'whole',
    },
  });

const on = (agents = payAgents()) => ({
  phase: 'on' as const,
  list: {
    agents,
    defaultPerCallMaxRaw: '100000',
    floatTargetRaw: '1000000',
    readAt: NOW,
  },
  loading: false,
});

// -------------------------------------------------------------------------------------------
// Words

test('amounts are USDC with at least two decimals, never a float', () => {
  assert.equal(usdcText('100000'), '0.10');
  assert.equal(usdcText('20000'), '0.02');
  assert.equal(usdcText('7000'), '0.007');
  assert.equal(usdcText('1'), '0.000001');
  assert.equal(usdcText('25000000'), '25.00');
  assert.equal(usdcText('123456789012'), '123456.789012');
  assert.equal(usdcText(null), null);
  assert.equal(usdcText('1.5'), null);
  assert.equal(usdcText('-1'), null);
  assert.equal(sizeText(512), '512 bytes');
  assert.equal(sizeText(48_213), '47.1 KB');
  assert.equal(sizeText(1_048_576), '1 MB');
});

test('the confirm names the amount, the agent and the host, and says it can’t be undone', () => {
  const quote = payQuote(service(), { amountRaw: '20000', host: 'www.ax1.vc' });
  assert.equal(
    confirmText(quote, 'hhuo'),
    'Pay 0.02 USDC from hhuo to www.ax1.vc? You can’t undo it.',
  );
  assert.equal(payButtonText(quote), 'Pay 0.02 USDC');
  // Provider and agent text is plain: no control or invisible characters.
  assert.equal(
    confirmText(quote, 'hh\u202Euo'),
    'Pay 0.02 USDC from hhuo to www.ax1.vc? You can’t undo it.',
  );
});

test('a live price above the listing is said before the confirm; the same or lower is not', () => {
  const s = service();
  assert.equal(
    vsListingText(payQuote(s, { amountRaw: '30000' })),
    'The service asks 0.03 USDC now. The listing says 0.02 USDC.',
  );
  assert.equal(vsListingText(payQuote(s)), null);
  assert.equal(vsListingText(payQuote(s, { amountRaw: '10000' })), null);
  assert.equal(vsListingText(payQuote(service({ price: null }))), null);
});

// -------------------------------------------------------------------------------------------
// The listing alone

test('the drawer offers Use with my agent only for a listing worth a live quote', () => {
  assert.deepEqual(listingPayState(service()), { kind: 'payable' });
  assert.deepEqual(listingPayState(service({ scheme: 'upto' })), {
    kind: 'own_setup',
    reason: 'upto_only',
  });
  assert.deepEqual(listingPayState(service({ method: 'DELETE' })), {
    kind: 'own_setup',
    reason: 'method_unsupported',
  });
  assert.deepEqual(listingPayState(service({ method: null })), {
    kind: 'own_setup',
    reason: 'method_unsupported',
  });
  assert.deepEqual(listingPayState(service({ url: 'https://x402-api.aubr.ai/v1/run' })), {
    kind: 'own_setup',
    reason: 'needs_own_setup',
  });
  const header = service({
    input: {
      format: 'json',
      fields: [{ name: 'key', in: 'header', type: 'string', required: true, description: '' }],
      more: 0,
      example: null,
      exampleState: null,
    },
  });
  assert.deepEqual(listingPayState(header), { kind: 'own_setup', reason: 'needs_own_setup' });
  // Withdrawn: no pay action at all.
  assert.deepEqual(listingPayState(service({ status: 'withdrawn' })), { kind: 'none' });
});

// -------------------------------------------------------------------------------------------
// Inputs

test('the form follows the listing: query for GET, typed body for POST, headers never sent', () => {
  const get = inputForm(service());
  assert.deepEqual(
    get.controls.map((control) => [control.key, control.kind, control.required, control.example]),
    [
      ['query:limit', 'integer', false, '5'],
      ['query:domain', 'text', true, 'stripe.com'],
    ],
  );
  assert.equal(get.extra, null);
  assert.deepEqual(get.unsent, []);

  const post = inputForm(postService());
  assert.deepEqual(
    post.controls.map((control) => [control.key, control.kind]),
    [
      ['body:query', 'text'],
      ['body:numResults', 'number'],
      ['body:contents', 'json'],
      ['body:deep', 'boolean'],
    ],
  );
  assert.deepEqual(
    post.unsent.map((field) => field.name),
    ['x-api-key', 'id'],
  );
  // Two fields the listing doesn't name: a JSON box for them, in the body.
  assert.equal(post.extra, 'body');

  // A body field on a GET is never sent.
  const odd = inputForm(
    service({
      input: {
        format: 'json',
        fields: [{ name: 'q', in: 'body', type: 'string', required: true, description: '' }],
        more: 0,
        example: null,
        exampleState: null,
      },
    }),
  );
  assert.deepEqual(odd.controls, []);
  assert.deepEqual(odd.unsent, [{ name: 'q', why: 'A GET call carries no body.' }]);
});

test('the example is a hint only: nothing is sent until Fill with example accepts it', () => {
  const form = inputForm(service());
  // Untouched, the required field is missing: the example is never sent by itself.
  const empty = buildInputs(form, EMPTY_INPUT_DRAFT);
  assert.deepEqual(empty.inputs, {});
  assert.deepEqual(empty.problems, [{ key: 'query:domain', text: 'Fill in domain.' }]);
  const accepted = draftFromExample(form);
  assert.deepEqual(accepted.values, { 'query:domain': 'stripe.com', 'query:limit': '5' });
  assert.deepEqual(buildInputs(form, accepted), {
    inputs: { query: { limit: '5', domain: 'stripe.com' } },
    problems: [],
  });
  // POST: typed values, and the example's unnamed keys go to the JSON box.
  const post = inputForm(postService());
  const draft = draftFromExample(post);
  assert.deepEqual(draft.values, { 'body:query': 'example search query', 'body:numResults': '10' });
  assert.deepEqual(JSON.parse(draft.extra), { type: 'auto' });
  assert.deepEqual(buildInputs(post, draft).inputs, {
    body: { type: 'auto', query: 'example search query', numResults: 10 },
  });
});

test('inputs are checked before anything is asked: types, required, JSON and size', () => {
  const post = inputForm(postService());
  const values = (entries: Record<string, string>, extra = '') => ({ values: entries, extra });
  assert.deepEqual(
    buildInputs(
      post,
      values({ 'body:numResults': 'ten', 'body:contents': '{bad', 'body:deep': 'yes' }),
    ).problems,
    [
      { key: 'body:query', text: 'Fill in query.' },
      { key: 'body:numResults', text: 'numResults must be a number.' },
      { key: 'body:contents', text: 'contents must be valid JSON.' },
      { key: 'body:deep', text: 'deep must be true or false.' },
    ],
  );
  assert.deepEqual(
    buildInputs(
      post,
      values({ 'body:query': 'pdf', 'body:contents': '{"text":true}', 'body:deep': 'false' }),
    ).inputs,
    { body: { query: 'pdf', contents: { text: true }, deep: false } },
  );
  assert.deepEqual(buildInputs(post, values({ 'body:query': 'a' }, '[1]')).problems, [
    { key: 'extra', text: 'More inputs must be a JSON object, like {"name": "value"}.' },
  ]);
  const get = inputForm(service());
  assert.deepEqual(
    buildInputs(get, values({ 'query:domain': 'a', 'query:limit': '1.5' })).problems,
    [{ key: 'query:limit', text: 'limit must be a whole number.' }],
  );
  const big = buildInputs(get, values({ 'query:domain': 'x'.repeat(2_001) }));
  assert.deepEqual(big.problems, [
    { key: '', text: 'The inputs are too long. Keep them under 16 KB.' },
  ]);
  // The server's problems land on the controls they name.
  assert.deepEqual(
    serverProblems(post, [
      { field: 'query', in: 'body', problem: 'wrong_type' },
      { field: 'secret', in: 'body', problem: 'not_allowed' },
      { field: '', in: null, problem: 'too_large' },
    ]),
    [
      { key: 'body:query', text: 'query must be text.' },
      { key: 'extra', text: 'This service doesn’t take secret.' },
      { key: '', text: 'The inputs are too long. Keep them under 16 KB.' },
    ],
  );
});

// -------------------------------------------------------------------------------------------
// Agents and limits

test('each agent says what it has, and why it can’t pay with the link that fixes it', () => {
  const [ready, noLimit, noFunds, paused, unknown] = payAgents();
  // The limit left shows the limit too when less of it is usable now (the half model on Base).
  assert.deepEqual(agentLines(ready!), {
    usdc: '4.25 USDC',
    left: '3.50 of 5.00 USDC left today',
    ready: 'Ready for services: 1.00 USDC',
    max: 'Per-call maximum: 0.10 USDC',
    blocked: null,
    unknown: false,
  });
  assert.equal(
    agentLines(payAgent({ limitRaw: '1000000', limitLeftRaw: '500000' })).left,
    '0.50 of 1.00 USDC left today',
  );
  assert.equal(
    agentLines(payAgent({ limitRaw: '3500000', limitLeftRaw: '3500000', limitPeriod: 'month' }))
      .left,
    '3.50 USDC left this month',
  );
  assert.deepEqual(agentLines(noLimit!).blocked, {
    text: 'Ledger Scout needs a spending limit first.',
    action: 'limit',
    label: 'Set a spending limit',
  });
  assert.equal(agentLines(noLimit!).left, 'No spending limit');
  assert.deepEqual(agentLines(noFunds!).blocked, {
    text: 'Night Owl has no USDC yet.',
    action: 'funds',
    label: 'Add funds',
  });
  // Every blocked agent has a next step: its own screen when nothing else fixes it.
  assert.deepEqual(agentLines(paused!).blocked, {
    text: 'Paused Pat is paused.',
    action: 'agent',
    label: 'Open Paused Pat',
  });
  // An agent that has a limit and used it changes it; it doesn't set one.
  assert.deepEqual(agentLines(payAgent({ notReady: 'limit_used', limitPeriod: 'week' })).blocked, {
    text: 'hhuo has used its limit for this week.',
    action: 'limit',
    label: 'Change the spending limit',
  });
  assert.equal(
    agentLines(payAgent({ notReady: 'limit_used', limitPeriod: 'day' })).blocked?.text,
    'hhuo has used its limit for today.',
  );
  assert.deepEqual(agentLines(payAgent({ notReady: 'wallet_not_usable' })).blocked, {
    text: 'hhuo’s wallet can’t pay right now.',
    action: 'agent',
    label: 'Open hhuo',
  });
  // Unknown balances: said, and the person may still try.
  const slow = agentLines(unknown!);
  assert.equal(slow.usdc, 'Balance not available right now.');
  assert.equal(slow.ready, 'Ready for services: not known now');
  assert.equal(slow.blocked, null);
  assert.equal(slow.unknown, true);
  // The only agent that can pay is picked first; with two, the person picks.
  assert.equal(firstChoice([ready!, noLimit!, noFunds!, paused!]), PAY_AGENT_IDS.ready);
  assert.equal(firstChoice(payAgents()), null);
  assert.equal(firstChoice([noLimit!]), null);
  assert.equal(
    agentScreenHref(PAY_AGENT_IDS.noLimit, 'wallet-limits'),
    `/agents#agent=${PAY_AGENT_IDS.noLimit}:wallet-limits`,
  );
  assert.equal(agentScreenHref(PAY_AGENT_IDS.paused), `/agents#agent=${PAY_AGENT_IDS.paused}`);
  // Agents that can pay come first, each group in the server's order.
  assert.deepEqual(
    agentOrder([noLimit!, ready!, paused!, unknown!, noFunds!]).map((agent) => agent.agentId),
    [ready!.agentId, unknown!.agentId, noLimit!.agentId, paused!.agentId, noFunds!.agentId],
  );
});

test('a limit that hasn’t started: the card says when, it can’t be picked, a refusal says so', async () => {
  // Fixed periods start at 00:00 Berlin: shown in Berlin time, summer and winter.
  assert.equal(
    limitStartsText('2026-10-14T22:00:00.000Z'),
    'Spending limit starts at 00:00 (Berlin), 15 Oct.',
  );
  assert.equal(
    limitStartsText('2026-12-31T23:00:00.000Z'),
    'Spending limit starts at 00:00 (Berlin), 1 Jan.',
  );
  assert.equal(limitStartsText('not a time'), null);
  assert.equal(limitStartsText(null), null);
  const ready = payAgent();
  const notStarted = payAgent({
    agentId: PAY_AGENT_IDS.noLimit,
    name: 'Early Bird',
    limitLeftRaw: null,
    limitStartsAt: '2026-10-14T22:00:00.000Z',
    ready: false,
    notReady: 'limit_not_started',
  });
  assert.deepEqual(agentLines(notStarted), {
    usdc: '4.25 USDC',
    left: null,
    ready: 'Ready for services: 1.00 USDC',
    max: 'Per-call maximum: 0.10 USDC',
    blocked: {
      text: 'Spending limit starts at 00:00 (Berlin), 15 Oct.',
      action: null,
      label: null,
    },
    unknown: false,
  });
  assert.equal(
    agentLines(payAgent({ notReady: 'limit_not_started', limitStartsAt: null })).blocked?.text,
    'This agent’s spending limit hasn’t started yet.',
  );
  // Never picked to pay: not first, not alone.
  assert.equal(firstChoice([notStarted]), null);
  assert.equal(firstChoice([notStarted, ready]), ready.agentId);
  assert.deepEqual(
    agentOrder([notStarted, ready]).map((agent) => agent.agentId),
    [ready.agentId, notStarted.agentId],
  );
  // The sheet: the sentence on its card, and its radio disabled.
  const html = renderToStaticMarkup(
    createElement(UseSheet, {
      service: service(),
      access: on([ready, notStarted]),
      onBack: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.ok(html.includes('Spending limit starts at 00:00 (Berlin), 15 Oct.'));
  const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((match) =>
    match[0].includes('disabled=""'),
  );
  assert.deepEqual(radios, [false, true]);
  assert.doesNotMatch(html, ARROWS);

  // A call refused for it: the server's answer for sure (nothing was paid), never "no answer".
  const failure = await payFailureOf(
    json(409, {
      error: "This agent's spending limit hasn't started yet.",
      code: 'limit_not_started',
      retryable: false,
      startsAt: '2026-10-14T22:00:00.000Z',
    }),
  );
  assert.equal(failure.code, 'limit_not_started');
  assert.equal(failure.detail.startsAt, '2026-10-14T22:00:00.000Z');
  assert.equal(lostAnswer(failure), false);
  assert.equal(lostAnswer(failure, true), false);
  assert.equal(
    refusalText(failure, { agentName: 'Early Bird' }),
    'Spending limit starts at 00:00 (Berlin), 15 Oct. Nothing was paid.',
  );
  assert.doesNotMatch(refusalText(failure), /can’t tell|didn’t get an answer/);
  // A start that isn't a time is dropped; the sentence still says it hasn't started.
  const odd = await payFailureOf(
    json(409, { error: 'x', code: 'limit_not_started', retryable: false, startsAt: 'soon' }),
  );
  assert.equal(odd.detail.startsAt, undefined);
  assert.equal(
    refusalText(odd),
    'This agent’s spending limit hasn’t started yet. Nothing was paid.',
  );
});

test('the lowest limit wins before any confirm: per-call maximum, then the limit left', () => {
  const s = service();
  const agent = payAgent();
  assert.deepEqual(quoteCheck(payQuote(s, { amountRaw: '20000' }), agent), { kind: 'ok' });
  assert.deepEqual(quoteCheck(payQuote(s, { amountRaw: '100000' }), agent), { kind: 'ok' });
  assert.deepEqual(quoteCheck(payQuote(s, { amountRaw: '150000' }), agent), {
    kind: 'over_max',
    text: '0.15 USDC is above hhuo’s per-call maximum of 0.10 USDC.',
  });
  assert.deepEqual(
    quoteCheck(
      payQuote(s, { amountRaw: '150000' }),
      payAgent({ perCallMaxRaw: '500000', limitLeftRaw: '120000' }),
    ),
    { kind: 'over_limit', text: '0.15 USDC is more than hhuo may still spend today.' },
  );
  // A limit left that isn't known is not a refusal here: the call checks for real.
  assert.deepEqual(quoteCheck(payQuote(s), payAgent({ limitLeftRaw: null })), { kind: 'ok' });
  // Too little USDC (the wallet plus Ready for services) is said before the confirm.
  assert.deepEqual(quoteCheck(payQuote(s), payAgent({ usdcRaw: '10000', floatRaw: '0' })), {
    kind: 'no_funds',
    text: 'hhuo has 0.01 USDC, less than this call costs.',
  });
  assert.deepEqual(quoteCheck(payQuote(s), payAgent({ usdcRaw: '10000', floatRaw: '10000' })), {
    kind: 'ok',
  });
  assert.deepEqual(quoteCheck(payQuote(s), payAgent({ usdcRaw: null, floatRaw: '0' })), {
    kind: 'ok',
  });
  const most = BigInt(FEED_PAY_LIMITS.perCallMaxMaxRaw);
  assert.equal(perCallMaxRaw('0.05'), '50000');
  assert.equal(perCallMaxRaw(usdcText(most.toString())!), most.toString());
  assert.equal(perCallMaxRaw(usdcText((most + 1n).toString())!), null);
  assert.equal(
    PER_CALL_MAX_RANGE,
    `Use an amount from 0.000001 to ${usdcText(most.toString())} USDC.`,
  );
  // 0.10 USDC is the hard maximum (FEED_PAY_LIMITS.perCallMaxMaxRaw).
  assert.equal(perCallMaxRaw('0.1'), '100000');
  assert.equal(PER_CALL_MAX_RANGE, 'Use an amount from 0.000001 to 0.10 USDC.');
  assert.equal(perCallMaxRaw('0.25'), null);
  assert.equal(perCallMaxRaw('100'), null);
  assert.equal(perCallMaxRaw('0.100001'), null);
  assert.equal(perCallMaxRaw('0'), null);
  assert.equal(perCallMaxRaw('0.0000001'), null);
  assert.equal(perCallMaxRaw('abc'), null);
});

// -------------------------------------------------------------------------------------------
// Refusals

test('every quote and call refusal says that nothing was paid; a lost answer says it can’t tell', () => {
  // Once, and last: a sentence that already says it (payee_mismatch) gets nothing more.
  const codes = [
    ...(Object.keys(FEED_PAY_ERRORS) as FeedPayErrorCode[]),
    'network',
    'rate_limited',
    'signed_out',
    'server',
    'unknown',
  ] as const;
  for (const code of codes) {
    const text = refusalText(new PayFailure(400, code, false));
    assert.match(text, /nothing was paid\.$/i, code);
    assert.equal(text.match(/nothing was paid/gi)?.length, 1, code);
    assert.doesNotMatch(text, /[{}_]|city_/, code);
    assert.equal(
      withMoney(refusalSentence(new PayFailure(400, code, false)), 'Nothing was paid.'),
      text,
    );
  }
  for (const reason of FEED_PAY_NOT_PAYABLE) {
    const text = refusalText(new PayFailure(409, 'not_payable', false, { reason }));
    assert.equal(text.match(/nothing was paid/gi)?.length, 1, reason);
  }
  assert.equal(
    refusalText(new PayFailure(409, 'payee_mismatch', false)),
    'This service asks to be paid at another address than its listing. We stopped before paying. Nothing was paid.',
  );
  assert.equal(
    refusalText(new PayFailure(429, 'rate_limited', true)),
    'Too many tries in a short time. Try again in a minute. Nothing was paid.',
  );
  assert.equal(
    refusalText(new PayFailure(0, 'network', true)),
    'We couldn’t reach Central City. Check your connection and try again. Nothing was paid.',
  );
  assert.equal(
    refusalText(
      new PayFailure(409, 'over_per_call_max', false, {
        neededRaw: '150000',
        perCallMaxRaw: '100000',
      }),
      { agentName: 'hhuo' },
    ),
    '0.15 USDC is above hhuo’s per-call maximum of 0.10 USDC. Nothing was paid.',
  );
  assert.equal(
    refusalText(
      new PayFailure(409, 'over_limit', false, { neededRaw: '150000', limitLeftRaw: '0' }),
      {
        agentName: 'hhuo',
        period: 'week',
      },
    ),
    '0.15 USDC is more than hhuo may still spend this week. Nothing was paid.',
  );
  assert.equal(
    refusalText(new PayFailure(409, 'not_payable', false, { reason: 'free_answer' })),
    'This service answered without asking for payment. Use its address directly. Nothing was paid.',
  );
  assert.equal(
    refusalText(new PayFailure(409, 'insufficient_funds', false)),
    'This agent doesn’t have enough USDC. Nothing was paid.',
  );
  // The first send: no answer, or busy or Base unavailable (both may come after the work
  // started): it may have started.
  for (const code of ['network', 'server', 'unknown', 'busy', 'unavailable'] as const)
    assert.equal(lostAnswer(new PayFailure(0, code, true)), true, code);
  for (const code of [
    'over_limit',
    'signed_out',
    'rate_limited',
    'not_found',
    'invalid_request',
  ] as const)
    assert.equal(lostAnswer(new PayFailure(400, code, false)), false, code);
  // Asking again about a lost answer: anything answered before the key was looked up says
  // nothing about the first send; only the engine's own answer after that is for sure.
  for (const code of [
    'network',
    'server',
    'unknown',
    'busy',
    'unavailable',
    'rate_limited',
    'signed_out',
    'not_found',
    'invalid_request',
  ] as const)
    assert.equal(lostAnswer(new PayFailure(400, code, false), true), true, code);
  for (const code of [
    'insufficient_funds',
    'quote_expired',
    'agent_paused',
    'service_not_found',
    'over_limit',
    'idempotency_conflict',
  ] as const)
    assert.equal(lostAnswer(new PayFailure(409, code, false), true), false, code);
  // Still not known: never "Nothing was paid."
  for (const code of ['rate_limited', 'busy', 'signed_out', 'not_found', 'network']) {
    const text = stillLostText(code, 'hhuo');
    assert.match(text, /can’t tell/);
    assert.doesNotMatch(text, /Nothing was paid|nothing was paid/);
  }
  assert.equal(
    stillLostText('rate_limited', 'hhuo'),
    'We still can’t tell whether the payment started. Check again in a minute: it never pays twice.',
  );
  assert.equal(
    stillLostText('signed_out', 'hhuo'),
    'You’re signed out, so we can’t tell yet whether the payment started. After you sign in, look in hhuo’s wallet before you pay again.',
  );
  // The per-call maximum's editor: no money in its words.
  assert.equal(maxProblemText(new PayFailure(400, 'invalid_request', false)), PER_CALL_MAX_RANGE);
  assert.equal(
    maxProblemText(new PayFailure(404, 'not_found', false)),
    'Paying services is not available right now.',
  );
  assert.equal(maxSavedText('hhuo', '250000'), 'Saved. hhuo now pays at most 0.25 USDC per call.');
});

test('a price checked again says what changed; a payee stop is not a setup matter', () => {
  assert.equal(
    priceRoseText('15000', '25000'),
    'The price went up from 0.015 to 0.025 USDC. Nothing was paid. Confirm the new price.',
  );
  assert.equal(
    recheckNote('expired', '10000', '10000'),
    'The price check expired, so we checked again. Confirm to pay.',
  );
  assert.equal(
    recheckNote('expired', '10000', '20000'),
    'The price check expired, so we checked again. It was 0.01 USDC, now 0.02 USDC. Confirm to pay.',
  );
  assert.equal(
    recheckNote('mismatch', null, '20000'),
    'The price check didn’t match this payment, so we checked again. Confirm to pay.',
  );
  assert.deepEqual(notPayableView('payee_mismatch'), {
    title: 'We stopped before paying.',
    tone: 'bad',
    copy: false,
    checkAgain: false,
  });
  // The title is said once: the box's words name the reason, then that nothing was paid.
  assert.equal(
    notPayableBody('payee_mismatch'),
    'This service asks to be paid at another address than its listing. Nothing was paid.',
  );
  assert.equal(notPayableBody('upto_only'), notPayableText('upto_only'));
  assert.deepEqual(notPayableView('no_payment_request'), {
    title: 'This one needs its own setup.',
    tone: 'warn',
    copy: true,
    checkAgain: true,
  });
  assert.deepEqual(notPayableView('upto_only'), {
    title: 'This one needs its own setup.',
    tone: 'warn',
    copy: true,
    checkAgain: false,
  });
});

// -------------------------------------------------------------------------------------------
// The call

test('every call state has its line, by state and then by whether money moved', () => {
  const s = service({ provider: { host: 'www.ax1.vc', name: null } });
  const expected: Record<FeedPayCallState, string> = {
    reserved: 'Starting…',
    float_topup: 'Getting USDC ready for services…',
    authorized: 'Paying www.ax1.vc…',
    calling: 'Waiting for www.ax1.vc…',
    reconciling: 'Checking on Base whether the payment went through…',
    settled: 'Paid. Saving the result…',
    not_settled: 'www.ax1.vc didn’t take the payment. Cancelling it…',
    result_saved: 'Paid 0.02 USDC to www.ax1.vc.',
    paid_no_result: 'Paid 0.02 USDC to www.ax1.vc, but it sent no result. We told our team.',
    cancelled: 'The service answered with an error. No money moved.',
    expired: 'The service didn’t answer in time. No money moved.',
    refused: 'The agent’s wallet doesn’t have enough USDC. Nothing was paid.',
  };
  for (const state of FEED_PAY_CALL_STATES) {
    const call = payCall(state, { service: s });
    assert.equal(callLine(call).text, expected[state], state);
    assert.doesNotMatch(callLine(call).text, ARROWS);
  }
  // A result before Base decided; a result with no money moved.
  assert.equal(
    callLine(payCall('result_saved', { service: s, paymentState: 'sent' })).text,
    'Result received. Confirming the payment on Base…',
  );
  assert.equal(
    callLine(payCall('result_saved', { service: s, paymentState: 'cancelled' })).text,
    'Result received. No money moved.',
  );
  // Cancelled, while our cancel races the service: not "no money moved" yet.
  assert.equal(
    callLine(payCall('cancelled', { service: s, paymentState: 'cancelling' })).text,
    'Checking on Base whether the payment went through…',
  );
  assert.equal(
    callLine(payCall('refused', { service: s, failure: 'paused' })).text,
    'Paying services was paused before this payment was signed. Nothing was paid.',
  );
  // A failure sentence that already says it: said once.
  assert.equal(
    callLine(payCall('refused', { service: s, failure: 'payee_mismatch' })).text,
    'This service asks to be paid at another address than its listing. We stopped before paying. Nothing was paid.',
  );
  // Done only when terminal and Base decided.
  assert.equal(payCall('result_saved', { service: s }).done, true);
  assert.equal(payCall('result_saved', { service: s, paymentState: 'sent' }).done, false);
  assert.equal(payCall('calling', { service: s }).done, false);
  const paid = payCall('result_saved', { service: s });
  assert.equal(paymentLine(paid), '0.02 USDC from hhuo to www.ax1.vc');
  assert.equal(paymentNote(paid), null);
  assert.equal(paymentNote(payCall('calling', { service: s })), 'Confirming on Base');
  assert.equal(paymentNote(payCall('expired', { service: s })), 'Not paid');
  assert.equal(paymentLine(payCall('refused', { service: s })), null);
  assert.equal(resultKeptText(paid, paid.updatedAt), 'Kept for 7 more days.');
  // A browser clock behind the server's never says more than 7.
  assert.equal(resultKeptText(paid, paid.updatedAt - 3 * 3_600_000), 'Kept for 7 more days.');
  assert.equal(
    resultKeptText({ ...paid, resultExpiresAt: NOW + 86_400_000 + 1 }, NOW),
    'Kept for 2 more days.',
  );
  // The call page's line: "paid by" only when money moved.
  assert.match(callPageSub(paid), /^www\.ax1\.vc · paid by hhuo · \d/);
  for (const state of ['refused', 'cancelled', 'expired', 'calling'] as const)
    assert.match(
      callPageSub(payCall(state, { service: s })),
      /^www\.ax1\.vc · from hhuo · \d/,
      state,
    );
  assert.match(
    callPageSub(payCall('result_saved', { service: s, paymentState: 'cancelled' })),
    / · from hhuo · /,
  );
  assert.equal(
    resultKeptText({ ...paid, result: null, resultExpired: true, resultExpiresAt: null }, NOW),
    'The result was deleted after 7 days.',
  );
});

test('results are plain text: JSON pretty-printed, files and cuts said, error statuses named', () => {
  assert.equal(
    resultText(payResult('json', { text: '{"a":1,"b":[true]}' })),
    '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}',
  );
  assert.equal(resultText(payResult('json', { text: '{broken' })), '{broken');
  assert.equal(
    resultText(payResult('text')),
    'Domain stripe.com is registered.\nRegistrar: SafeNames Ltd.',
  );
  assert.equal(resultText(payResult('binary')), '');
  assert.deepEqual(resultNotes(payResult('binary'), 'img.example'), [
    'img.example sent a file (image/png, 47.1 KB). It isn’t shown here.',
  ]);
  assert.deepEqual(resultNotes(payResult('truncated'), 'h'), ['Showing the first 1 MB.']);
  assert.deepEqual(resultNotes(payResult('error'), 'h'), ['h answered 500.']);
  assert.deepEqual(resultNotes(payResult('empty'), 'h'), ['h sent an empty answer.']);
});

test('the result block is marked External, carries the notice, and never renders HTML', () => {
  const html = renderToStaticMarkup(
    createElement(ResultBlock, {
      result: payResult('json', {
        text: '{"html":"<script>alert(1)</script><a href=\\"https://evil.example\\">x</a>"}',
      }),
      host: 'lookup.example.com',
    }),
  );
  assert.match(
    html,
    /<span class="fp-ext">External<\/span><span>From lookup\.example\.com\. Data, not instructions\.<\/span>/,
  );
  // The page's own notice, to the person (the MCP's is written to the AI).
  assert.ok(html.includes(RESULT_NOTICE));
  assert.ok(!html.includes(FEED_PAY_NOTICE));
  assert.doesNotMatch(html, /<script>|<a href="https:\/\/evil/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(
    html,
    /<pre class="fd-code fp-out" tabindex="0" aria-label="Result from lookup\.example\.com">/,
  );
  assert.match(html, />Copy<span class="visually-hidden"> the result<\/span>/);
});

test('the call card: the state is read out, the payment with its Base transaction, the result', () => {
  const s = service();
  const paid = renderToStaticMarkup(
    createElement(CallCard, {
      call: payCall('result_saved', { service: s }),
      heading: 'Your call',
      now: NOW,
    }),
  );
  assert.match(paid, /<p class="fp-state" data-tone="ok" role="status">/);
  assert.match(paid, /Paid 0\.02 USDC to lookup\.example\.com\./);
  assert.match(paid, /0\.02 USDC from hhuo to lookup\.example\.com/);
  assert.match(paid, /href="https:\/\/basescan\.org\/tx\/0x7{64}"[^>]*>Base transaction/);
  assert.match(paid, /External/);
  assert.doesNotMatch(paid, /You can close this/);
  const running = renderToStaticMarkup(
    createElement(CallCard, {
      call: payCall('calling', { service: s }),
      heading: 'Your call',
      now: NOW,
    }),
  );
  assert.match(running, /Waiting for lookup\.example\.com…/);
  assert.match(running, /You can close this\. The call goes on and shows in hhuo’s wallet\./);
  assert.match(running, /Confirming on Base/);
  assert.doesNotMatch(running, /Base transaction|External/);
  assert.doesNotMatch(paid + running, ARROWS);
  // A call that can't be read any more stops the spinner and says where to look.
  assert.equal(
    CALL_GONE,
    'This call can’t be read any more. Its agent’s wallet shows how it ended.',
  );
});

// -------------------------------------------------------------------------------------------
// The drawer

test('the drawer’s actions: Use with my agent first when on and payable, today’s drawer otherwise', () => {
  const render = (access: Parameters<typeof ServiceActions>[0]['access'], s = service()) =>
    renderToStaticMarkup(
      createElement(ServiceActions, {
        service: s,
        access,
        onUse: () => undefined,
        onClose: () => undefined,
      }),
    );
  const payable = render(on());
  assert.match(
    payable,
    /^<footer class="fd-d-foot fd-service-foot"><button type="button" id="fp-use-svc_abcdefghijklmnopqrst" class="fd-btn primary">Use with my agent<\/button>/,
  );
  assert.match(payable, /title="Copy service address"/);
  assert.match(payable, />Copy link</);
  assert.doesNotMatch(payable, /Open service|Sign in to use it|own setup/);
  // Not payable as listed: why, in one line, and Copy service address first.
  const upto = render(on(), service({ scheme: 'upto' }));
  assert.match(
    upto,
    /<p class="fd-fine fd-foot-note fp-setup"[^>]*><b>This one needs its own setup\.<\/b> This service only takes pay-per-use payments\. Your agent pays fixed prices only\.<\/p><button type="button" class="fd-btn primary">Copy service address/,
  );
  assert.doesNotMatch(upto, /Use with my agent/);
  // Off, not allowed, not known yet: today's drawer, without Open service.
  for (const access of [{ phase: 'off' }, { phase: 'unknown' }] as const) {
    const html = render(access);
    assert.match(
      html,
      /^<footer class="fd-d-foot fd-service-foot"><button type="button" class="fd-btn primary">Copy service address/,
    );
    assert.doesNotMatch(html, /Use with my agent|Open service|own setup|Sign in/);
  }
  // The session lapsed: said, and Sign in to use it comes first; read-only stays.
  const out = render({ phase: 'signed_out' });
  assert.match(out, /<b>You were signed out\.<\/b> Sign in again to use it with your agent\./);
  assert.match(
    out,
    /<button type="button" class="fd-btn primary"[^>]*>Sign in to use it<\/button>/,
  );
  assert.match(out, /<button type="button" class="fd-btn" title="Copy service address"/);
  assert.ok(out.indexOf('Sign in to use it') < out.indexOf('Copy service address'));
  // Withdrawn: no pay action at all.
  assert.doesNotMatch(
    render(on(), service({ status: 'withdrawn' })),
    /Use with my agent|own setup/,
  );
});

test('the details say how to use it with pay on, and keep the old words with pay off', () => {
  const html = renderToStaticMarkup(createElement(ServiceDetail, { service: service(), now: NOW }));
  // A server render never knows the person: today's drawer.
  assert.match(html, /Central City can’t pay it for your agents yet\./);
  assert.match(html, /Nothing is paid through the Feed\./);
  assert.match(html, /Central City hasn’t called this service\./);
  assert.match(html, /The price is as listed\./);
  assert.doesNotMatch(html, /Use with my agent|you see it before you confirm/);
});

test('the use sheet: inputs from the listing, the example as a hint, the agents with reasons', () => {
  const html = renderToStaticMarkup(
    createElement(UseSheet, {
      service: service(),
      access: on(),
      onBack: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(html, /<h3 id="[^"]+" tabindex="-1">Use with my agent<\/h3>/);
  // The intro holds with Central City's fee on top and without it: never "the price" alone.
  assert.match(
    html,
    /<p class="fd-fine">Your agent pays from its own wallet\. You see what it pays, and to whom, before anything is paid\.<\/p>/,
  );
  assert.doesNotMatch(html, /You see the price before|pays [a-z0-9.-]+ from its own wallet/);
  assert.match(html, />What to send</);
  assert.match(
    html,
    /Example: <code>\{ &quot;domain&quot;: &quot;stripe\.com&quot;, &quot;limit&quot;: 5 \}<\/code>/,
  );
  assert.match(html, />Fill with example<\/button>/);
  // Required marked; the example is a hint under the field, the field itself empty.
  assert.match(html, /<code>domain<\/code><span class="fp-req" data-req="true">Required<\/span>/);
  assert.match(html, /<code>limit<\/code><span class="fp-req">Optional<\/span>/);
  assert.match(html, /The name · Example: stripe\.com/);
  assert.doesNotMatch(html, /value="stripe\.com"/);
  assert.match(html, /<legend>Agent that pays<\/legend>/);
  for (const line of [
    '4.25 USDC',
    '3.50 of 5.00 USDC left today',
    'Ready for services: 1.00 USDC',
    'Per-call maximum: 0.10 USDC',
    'Ledger Scout needs a spending limit first.',
    'Night Owl has no USDC yet.',
    'Paused Pat is paused.',
    'Balance not available right now.',
  ])
    assert.ok(html.includes(line), line);
  assert.match(
    html,
    new RegExp(
      `href="/agents#agent=${PAY_AGENT_IDS.noLimit}:wallet-limits">Set a spending limit</a>`,
    ),
  );
  assert.match(
    html,
    new RegExp(`href="/agents#agent=${PAY_AGENT_IDS.noFunds}:wallet-add">Add funds</a>`),
  );
  assert.match(
    html,
    new RegExp(`href="/agents#agent=${PAY_AGENT_IDS.paused}">Open Paused Pat</a>`),
  );
  // Blocked agents can't be picked; the others can, and they come first.
  assert.equal(html.match(/<input type="radio"[^>]* disabled=""/g)?.length, 3);
  const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((match) =>
    match[0].includes('disabled=""'),
  );
  assert.deepEqual(radios, [false, false, true, true, true]);
  assert.match(html, /<button type="submit" class="fd-btn primary fp-main">Check price<\/button>/);
  assert.doesNotMatch(html, /Pay 0|You can’t undo it/);
  assert.doesNotMatch(html, ARROWS);
  // No agents at all: where to make one, and nothing to check yet.
  const none = renderToStaticMarkup(
    createElement(UseSheet, { service: service(), access: on([]), onBack: () => undefined }),
  );
  assert.match(none, /You have no agent with a wallet on Base yet\./);
  assert.match(none, /<a class="fd-link" href="\/agents">Go to My agents<\/a>/);
  assert.doesNotMatch(none, /Check price/);
});

test('a payment that may have started is kept outside the sheet, with its key, until it ends', () => {
  forgetOpenPayments();
  const s = service();
  const quote = payQuote(s);
  const body = {
    agentId: PAY_AGENT_IDS.ready,
    inputs: { query: { domain: 'stripe.com' } },
    quoteId: quote.quoteId,
    maxAmountRaw: quote.amount.raw,
    idempotencyKey: 'k-0001',
  };
  const lost: OpenPayment = {
    phase: 'lost',
    body,
    quote,
    agentName: 'hhuo',
    call: null,
    stillLost: null,
    asking: false,
    problem: '',
  };
  assert.equal(sheetWanted(s.id), false);
  setOpenPayment(s.id, lost);
  assert.equal(sheetWanted(s.id), true);
  // The sheet opened again shows the same payment: its confirm and Check again, never Pay.
  keepSheetDraft(s.id, { draft: { values: { 'query:domain': 'stripe.com' }, extra: '' } });
  const html = renderToStaticMarkup(
    createElement(UseSheet, { service: s, access: on(), onBack: () => undefined }),
  );
  assert.match(html, /We didn’t get an answer, so we can’t tell yet whether the payment started\./);
  assert.match(html, />Check again<\/button>/);
  assert.doesNotMatch(html, /Nothing was paid|>Pay 0|Check price|Fill with example/);
  assert.match(html, /value="stripe\.com"/);
  // Asked again, still not known: said so, still with Check again.
  setOpenPayment(s.id, { ...lost, stillLost: 'rate_limited' });
  const still = renderToStaticMarkup(
    createElement(UseSheet, { service: s, access: on(), onBack: () => undefined }),
  );
  assert.match(still, /We still can’t tell whether the payment started\./);
  assert.match(still, />Check again<\/button>/);
  assert.doesNotMatch(still, /Nothing was paid/);
  // A call that answered: the sheet opens on it; once done, the payment is no longer open.
  const running = payCall('calling', { service: s });
  setOpenPayment(s.id, { ...lost, phase: 'call', call: running });
  const card = renderToStaticMarkup(
    createElement(UseSheet, { service: s, access: on(), onBack: () => undefined }),
  );
  assert.match(card, /Waiting for lookup\.example\.com…/);
  updateOpenCall(s.id, { ...running, state: 'calling' });
  assert.equal(getOpenPayment(s.id)?.phase, 'call');
  updateOpenCall(s.id, payCall('result_saved', { service: s, callId: running.callId }));
  assert.equal(getOpenPayment(s.id), null);
  assert.equal(sheetWanted(s.id), false);
  // A call that finished while the sheet was closed stays open until a sheet shows it: the
  // next sheet opens on that call (Use it again), never on the confirm of the quote just paid.
  const sending: OpenPayment = { ...lost, phase: 'sending' };
  const finished = payCall('result_saved', { service: s });
  assert.equal(answeredPayment(sending, finished, true), null);
  assert.deepEqual(answeredPayment(sending, finished, false), {
    ...sending,
    phase: 'call',
    call: finished,
  });
  assert.equal(answeredPayment(sending, running, true)?.phase, 'call');
  setOpenPayment(s.id, answeredPayment(sending, finished, false));
  assert.equal(sheetWanted(s.id), true);
  const reopened = renderToStaticMarkup(
    createElement(UseSheet, { service: s, access: on(), onBack: () => undefined }),
  );
  assert.match(reopened, />Use it again<\/button>/);
  assert.doesNotMatch(reopened, />Pay 0|You can’t undo it|Check price/);
  // A call that can't be read any more (call_not_found) ends its payment, and only that one:
  // the sheet is not locked on it until a reload.
  setOpenPayment(s.id, { ...lost, phase: 'call', call: running });
  endGoneCall(s.id, 'call_someoneelse');
  assert.equal(getOpenPayment(s.id)?.phase, 'call');
  endGoneCall(s.id, running.callId);
  assert.equal(getOpenPayment(s.id), null);
  assert.equal(sheetWanted(s.id), false);
  setOpenPayment(s.id, lost);
  endGoneCall(s.id, running.callId);
  assert.equal(getOpenPayment(s.id)?.phase, 'lost');
  // A refusal that came after the sheet closed is no reason to open it by itself.
  setOpenPayment(s.id, { ...lost, phase: 'refused', problem: 'x' });
  assert.equal(sheetWanted(s.id), false);
  // A link to the wallet (Set a spending limit, Add funds): the sheet opens again on Back.
  keepSheetDraft(s.id, { reopen: true });
  assert.equal(sheetWanted(s.id), true);
  assert.equal(getSheetDraft(s.id)?.draft.values['query:domain'], 'stripe.com');
  // Sign-out forgets it all.
  forgetOpenPayments();
  assert.equal(getOpenPayment(s.id), null);
  assert.equal(getSheetDraft(s.id), null);
});

// -------------------------------------------------------------------------------------------
// Addresses

test('a call has its own Feed address', () => {
  const id = newCallId();
  assert.match(id, /^fc_[a-z2-7]{20}$/);
  assert.notEqual(newCallId(), id);
  assert.equal(feedHref.call(id), `/feed/calls/${id}`);
  assert.ok(FEED_PATH.test(feedHref.call(id)));
  assert.deepEqual(feedRoute(`/feed/calls/${id}`), { view: 'call', id });
  assert.equal(feedRoute('/feed/calls'), null);
  assert.equal(feedRoute('/feed/calls/a.b'), null);
  assert.equal(feedSignInContext(`/feed/calls/${id}`)?.line, 'Sign in to see this call.');
});

// -------------------------------------------------------------------------------------------
// The client

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { seen, fetcher };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('every request is signed in (the request header, reads too), never cached, never repeated', async () => {
  const { seen, fetcher } = recorder(() => json(200, { ok: true }));
  const s = service();
  await getPayAgents({ fetcher });
  await setPerCallMax(PAY_AGENT_IDS.ready, '250000', { fetcher });
  await quoteService(s.id, { query: { domain: 'a' } }, { fetcher });
  await callService(
    s.id,
    {
      agentId: 'a',
      inputs: {},
      quoteId: 'fq_x',
      maxAmountRaw: '1',
      idempotencyKey: crypto.randomUUID(),
    },
    { fetcher },
  );
  await getCall('fc_aaaaaaaaaaaaaaaaaaab', { fetcher });
  await getServiceCalls(PAY_AGENT_IDS.ready, { fetcher });
  assert.deepEqual(
    seen.map(({ url, init }) => `${init.method} ${url}`),
    [
      `GET ${FEED_PAY_PATHS.agents}`,
      `PUT /api/feed/pay/agents/${PAY_AGENT_IDS.ready}`,
      `POST /api/feed/services/${s.id}/quote`,
      `POST /api/feed/services/${s.id}/call`,
      'GET /api/feed/calls/fc_aaaaaaaaaaaaaaaaaaab',
      `GET /api/base/agents/${PAY_AGENT_IDS.ready}/wallet/service-calls`,
    ],
  );
  for (const { init } of seen) {
    assert.equal((init.headers as Record<string, string>)['X-City-Request'], '1');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
  }
  assert.deepEqual(JSON.parse(seen[1]!.init.body as string), { perCallMaxRaw: '250000' });
  assert.deepEqual(JSON.parse(seen[2]!.init.body as string), {
    inputs: { query: { domain: 'a' } },
  });
  // An id that can't be one is the same answer as an unknown one, without a request.
  await assert.rejects(
    getCall('nope', { fetcher }),
    (error: unknown) => (error as PayFailure).code === 'call_not_found',
  );
  await assert.rejects(
    quoteService('nope', {}, { fetcher }),
    (error: unknown) => (error as PayFailure).code === 'service_not_found',
  );
  assert.equal(seen.length, 6);
  // A failed call is never sent again by the client.
  const failing = recorder(() => json(503, { error: 'x', code: 'unavailable', retryable: true }));
  await assert.rejects(
    callService(
      s.id,
      { agentId: 'a', inputs: {}, quoteId: 'q', maxAmountRaw: '1', idempotencyKey: 'k-12345678' },
      { fetcher: failing.fetcher },
    ),
  );
  assert.equal(failing.seen.length, 1);
});

test('failures carry the contract’s code and details; 404 is off, 401 signed out', async () => {
  const quote = payQuote(service(), { amountRaw: '30000' });
  const failure = await payFailureOf(
    json(409, {
      error: 'The service now asks more than you confirmed.',
      code: 'price_above_max',
      retryable: false,
      quote,
      neededRaw: '30000',
      perCallMaxRaw: 'not-a-number',
    }),
  );
  assert.equal(failure.code, 'price_above_max');
  assert.equal(failure.detail.quote?.quoteId, quote.quoteId);
  assert.equal(failure.detail.neededRaw, '30000');
  assert.equal(failure.detail.perCallMaxRaw, undefined);
  assert.equal(
    (await payFailureOf(json(404, { error: 'Not found.', code: 'not_found' }))).code,
    'not_found',
  );
  assert.equal((await payFailureOf(json(404, { error: 'Not found.' }))).code, 'not_found');
  assert.equal(
    (await payFailureOf(json(401, { error: 'Sign in to continue.' }))).code,
    'signed_out',
  );
  const limited = await payFailureOf(json(429, { error: 'Slow down.' }, { 'Retry-After': '30' }));
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.retryAfterMs, 30_000);
  assert.equal((await payFailureOf(json(502, { error: 'Bad gateway' }))).code, 'server');
  assert.deepEqual(
    (
      await payFailureOf(
        json(400, {
          error: 'x',
          code: 'invalid_inputs',
          retryable: false,
          fields: [{ field: 'domain', in: 'query', problem: 'missing' }],
        }),
      )
    ).detail.fields,
    [{ field: 'domain', in: 'query', problem: 'missing' }],
  );
  // History: a 404 is nothing to show, not an error.
  const missing = recorder(() => json(404, { error: 'Not found.' }));
  assert.equal(await getServiceCalls('x', { fetcher: missing.fetcher }), null);
});

// -------------------------------------------------------------------------------------------
// History

test('History lines: paid, paying, didn’t go through, and moves between the agent’s own accounts', () => {
  const s = service({ provider: { host: 'www.ax1.vc', name: null } });
  const history = payHistory(s);
  assert.deepEqual(history.calls.map(historyLine), [
    'Paying www.ax1.vc',
    'Paid www.ax1.vc 0.02 USDC',
    'Paid www.ax1.vc 0.002 USDC',
    'Call to www.ax1.vc didn’t go through',
  ]);
  const free = { ...history.calls[1]!, moneyMoved: 'no' as const };
  assert.equal(historyLine(free), 'Called www.ax1.vc, no money moved');
  // Paid with no result: never shown like a call that worked.
  assert.equal(
    historyLine({ ...history.calls[1]!, state: 'paid_no_result', moneyMoved: 'yes' }),
    'Paid www.ax1.vc 0.02 USDC, no result',
  );
  assert.equal(
    historyLine({ ...history.calls[3]!, state: 'cancelled', moneyMoved: 'pending' }),
    'Paying www.ax1.vc',
  );
  assert.deepEqual(history.moves.map(moveLine), [
    'Moved 1.00 USDC to Ready for services',
    'Moved 0.98 USDC back to the wallet',
  ]);
  assert.equal(
    moveLine({ ...history.moves[0]!, state: 'pending' }),
    'Moving 1.00 USDC to Ready for services',
  );
  assert.equal(
    moveLine({ ...history.moves[1]!, state: 'failed' }),
    'Moving 0.98 USDC back to the wallet didn’t go through',
  );
});
