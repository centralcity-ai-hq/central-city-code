import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeedServiceDetail } from '../shared/feed.js';
import {
  FEED_PAY_ERRORS,
  FEED_PAY_IDEMPOTENCY_KEY,
  feedPayCallDone,
  type FeedPayAgentList,
  type FeedPayCall,
  type FeedPayHistory,
  type FeedPayQuote,
} from '../shared/feed-pay.js';
import {
  notPayable,
  payAgent,
  payAgentList,
  payAgents,
  payCall,
  payHistory,
  PAID_RUN,
  payQuote,
  payRefusal,
  sampleServices,
} from '../e2e/feed-fixtures.js';
import { getService } from '../src/feed/feedApi.js';
import {
  callService,
  getCall,
  getPayAgents,
  getServiceCalls,
  PayFailure,
  payFailure,
  quoteService,
  setPerCallMax,
} from '../src/feed/payApi.js';
import {
  agentLines,
  buildInputs,
  callLine,
  confirmText,
  draftFromExample,
  firstChoice,
  historyLine,
  inputForm,
  lostAnswer,
  quoteCheck,
  refusalText,
  serverProblems,
} from '../src/feed/pay/payModel.js';
import { setup, SVC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed D6, the page against the real engine: the Feed's own data layer (src/feed/payApi.ts) and
 * the page's model (src/feed/pay/payModel.ts) driven through the real routes, engine and chain
 * side (tests/helpers/feed-pay-app.ts: a fake x402 service and a fake Base, no network, no real
 * payment). And the browser fixtures (e2e/feed-fixtures.ts) checked against the engine's real
 * answers, shape for shape, so the browser checks test the answers the server gives.
 */

type Fetcher = typeof fetch;

/** fetch for the page's own functions, answered by the app in process with the person's cookie. */
function fetcherFor(f: FeedPayApp, cookie: string | null = f.owner.cookie): Fetcher {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      ...(cookie ? { cookie } : {}),
    };
    const res = await f.app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: String(input),
      headers,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    const out = new Headers();
    for (const [name, value] of Object.entries(res.headers))
      if (typeof value === 'string' || typeof value === 'number') out.set(name, String(value));
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: out,
    });
  }) as Fetcher;
}

/** The type of every value, with object keys sorted: two answers of the same shape compare equal. */
function shape(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  return typeof value;
}

/** Waits (yielding to the worker in the background) until the page would stop reading the call. */
async function follow(f: FeedPayApp, fetcher: Fetcher, callId: string): Promise<FeedPayCall[]> {
  const seen: FeedPayCall[] = [];
  for (let i = 0; i < 400; i++) {
    const call = await getCall(callId, { fetcher });
    seen.push(call);
    if (feedPayCallDone(call) || call.done) return seen;
    f.advance(1_500);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the call did not finish');
}

const refused = async (promise: Promise<unknown>): Promise<PayFailure> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PayFailure, String(error));
    return error;
  }
  throw new Error('expected a refusal');
};

test('the page against the real engine: agents, form, price check, confirm, pay, follow, History', async (t) => {
  const f = await setup(t);
  await f.list();
  const fetcher = fetcherFor(f);

  // The listing as the drawer reads it, and the form the use sheet builds from it.
  const detail = (await getService(SVC, { fetcher })) as FeedServiceDetail;
  const service = detail.service;
  const form = inputForm(service);
  assert.deepEqual(
    form.controls.map((control) => [control.key, control.kind, control.required]),
    [
      ['body:tokenAddress', 'text', true],
      ['body:chain', 'text', false],
    ],
  );
  assert.equal(form.extra, null);

  // No spending limit yet: the agent card says so, and nothing is picked for the person.
  let list = await getPayAgents({ fetcher });
  assert.equal(list.agents.length, 1);
  assert.deepEqual(agentLines(list.agents[0]!).blocked, {
    text: 'hhuo needs a spending limit first.',
    action: 'limit',
    label: 'Set a spending limit',
  });
  assert.equal(firstChoice(list.agents), null);
  await f.limit();
  list = await getPayAgents({ fetcher });
  const agent = list.agents[0]!;
  assert.equal(agentLines(agent).blocked, null);
  assert.equal(agentLines(agent).max, 'Per-call maximum: 0.10 USDC');
  assert.equal(firstChoice(list.agents), f.agentId);

  // The empty form: the page's own check and the server's say the same field is missing.
  const empty = buildInputs(form, { values: {}, extra: '' });
  assert.deepEqual(empty.problems, [{ key: 'body:tokenAddress', text: 'Fill in tokenAddress.' }]);
  f.advance(6_100);
  const missing = await refused(quoteService(SVC, empty.inputs, { fetcher }));
  assert.equal(missing.code, 'invalid_inputs');
  assert.deepEqual(serverProblems(form, missing.detail.fields ?? []), empty.problems);

  // Use example, then the price check: what the person confirms is what the engine quoted.
  const typed = buildInputs(form, draftFromExample(form));
  assert.deepEqual(typed, { inputs: { body: { tokenAddress: '0x0' } }, problems: [] });
  f.advance(6_100);
  const answer = await quoteService(SVC, typed.inputs, { fetcher });
  assert.equal(answer.payable, true);
  const quote = answer as FeedPayQuote;
  assert.deepEqual(quoteCheck(quote, agent), { kind: 'ok' });
  assert.equal(
    confirmText(quote, agent.name),
    'Pay 0.02 USDC from hhuo to www.ax1.example? You can’t undo it.',
  );

  // Pay: one confirm click, one key; the answer is followed until Base decided.
  const key = crypto.randomUUID();
  assert.match(key, FEED_PAY_IDEMPOTENCY_KEY);
  const body = {
    agentId: agent.agentId,
    inputs: typed.inputs,
    quoteId: quote.quoteId,
    maxAmountRaw: quote.amount.raw,
    idempotencyKey: key,
  };
  f.advance(12_100);
  const first = await callService(SVC, body, { fetcher });
  const run = [first, ...(first.done ? [] : await follow(f, fetcher, first.callId))];
  const last = run.at(-1)!;
  assert.equal(last.state, 'result_saved');
  assert.equal(last.moneyMoved, 'yes');
  assert.equal(callLine(last).text, 'Paid 0.02 USDC to www.ax1.example.');
  assert.equal(f.service.paid().length, 1);
  // Every state the page saw is one the engine's run goes through (never 'settled').
  const states = new Set<string>(PAID_RUN.map((step) => step.state));
  for (const call of run) assert.ok(states.has(call.state), call.state);

  // A lost answer: "Check again" sends the same key and gets the same call, never a second payment.
  f.advance(12_100);
  const again = await callService(SVC, body, { fetcher });
  assert.equal(again.callId, first.callId);
  assert.equal(f.service.paid().length, 1);

  // The wallet's Services: the call, with its result still kept, and the float moves.
  const history = (await getServiceCalls(f.agentId, { fetcher }))!;
  assert.equal(history.calls[0]!.callId, first.callId);
  assert.equal(history.calls[0]!.resultAvailable, true);
  assert.match(historyLine(history.calls[0]!), /0\.02 USDC/);
  assert.equal(history.perCallMax.raw, '100000');
});

test('the page’s own checks and the engine’s refusals agree: per-call maximum, limit, price', async (t) => {
  const f = await setup(t, { cap: 30_000n });
  await f.list();
  await f.limit();
  const fetcher = fetcherFor(f);
  const inputs = { body: { tokenAddress: '0x0' } };
  const quoteNow = async () => {
    f.advance(6_100);
    return (await quoteService(SVC, inputs, { fetcher })) as FeedPayQuote;
  };
  const pay = async (quote: FeedPayQuote, maxAmountRaw = quote.amount.raw) => {
    f.advance(12_100);
    return callService(
      SVC,
      {
        agentId: f.agentId,
        inputs,
        quoteId: quote.quoteId,
        maxAmountRaw,
        idempotencyKey: crypto.randomUUID(),
      },
      { fetcher },
    );
  };

  // A per-call maximum below the price: "Change maximum" in place, and the engine refuses it too.
  const lowered = await setPerCallMax(f.agentId, '10000', { fetcher });
  assert.equal(lowered.perCallMaxIsDefault, false);
  let quote = await quoteNow();
  assert.equal(quoteCheck(quote, lowered).kind, 'over_max');
  const overMax = await refused(pay(quote));
  assert.equal(overMax.code, 'over_per_call_max');
  assert.equal(overMax.status, FEED_PAY_ERRORS.over_per_call_max);
  assert.deepEqual(overMax.detail, { neededRaw: '20000', perCallMaxRaw: '10000' });
  assert.equal(lostAnswer(overMax), false);
  assert.match(
    refusalText(overMax, { agentName: 'hhuo' }),
    /above hhuo’s per-call maximum of 0\.01 USDC\. Nothing was paid\.$/,
  );
  const reset = await setPerCallMax(f.agentId, null, { fetcher });
  assert.equal(reset.perCallMaxIsDefault, true);

  // One payment of the 0.03 USDC cap: the page sees 0.01 left and gives no confirm; the engine refuses.
  quote = await quoteNow();
  const paid = await pay(quote);
  if (!paid.done) await follow(f, fetcher, paid.callId);
  const [agent] = (await getPayAgents({ fetcher })).agents;
  assert.equal(agent!.limitLeftRaw, '10000');
  quote = await quoteNow();
  assert.equal(quoteCheck(quote, agent!).kind, 'over_limit');
  const overLimit = await refused(pay(quote));
  assert.equal(overLimit.code, 'over_limit');
  assert.equal(overLimit.detail.neededRaw, '20000');

  // The price rose after the confirm: refused with the fresh price check, nothing paid.
  await f.list({ amount: '5000' });
  const cheap = await quoteNow();
  await f.list({ amount: '6000' });
  const rose = await refused(pay(cheap));
  assert.equal(rose.code, 'price_above_max');
  assert.equal(rose.detail.quote?.payable, true);
  assert.equal(rose.detail.quote?.amount.raw, '6000');
  assert.equal(f.service.paid().length, 1);

  // A price check that expired is refused as such (the page checks the price again by itself).
  const old = await quoteNow();
  f.advance(5 * 60_000 + 1);
  assert.equal((await refused(pay(old))).code, 'quote_expired');
});

test('switched off (0) or signed out, as the page reads it', async (t) => {
  const f = await setup(t, { env: { CITY_FEED_PAY: '0' } });
  await f.list();
  const off = await refused(getPayAgents({ fetcher: fetcherFor(f) }));
  assert.equal(off.code, 'not_found');
  process.env.CITY_FEED_PAY = '1';
  const out = payFailure(await refused(getPayAgents({ fetcher: fetcherFor(f, null) })));
  assert.equal(out.code, 'signed_out');
  // A malformed call id never leaves the page; an unknown one is the engine's call_not_found.
  assert.equal((await refused(getCall('nope', { fetcher: fetcherFor(f) }))).code, 'call_not_found');
  assert.equal(
    (await refused(getCall(`fc_${'a'.repeat(20)}`, { fetcher: fetcherFor(f) }))).code,
    'call_not_found',
  );
  // The wallet's Services before any call: an empty History, not an error.
  const history = await getServiceCalls(f.agentId, { fetcher: fetcherFor(f) });
  assert.deepEqual([history?.calls, history?.moves], [[], []]);
});

test('the browser fixtures answer in the engine’s shapes', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.list({
    id: 'svc_bbbbbbbbbbbbbbbbbbbb',
    url: 'https://www.ax2.example/x',
    scheme: 'upto',
  });
  const service = sampleServices()[0]!;

  const unlimited = (await f.agents()).json() as FeedPayAgentList;
  assert.deepEqual(shape(payAgents()[1]), shape(unlimited.agents[0]));
  await f.limit();
  const real = (await f.agents()).json() as FeedPayAgentList;
  assert.deepEqual(shape(payAgentList([payAgent()])), shape(real));

  const quoted = (await f.quote()).json();
  assert.deepEqual(shape(payQuote(service)), shape(quoted));
  const upto = (await f.quote(undefined, 'svc_bbbbbbbbbbbbbbbbbbbb')).json();
  assert.deepEqual(notPayable(service, 'upto_only'), { ...upto, serviceId: service.id });

  const paid = await f.pay();
  assert.equal(paid.statusCode, 200, paid.body);
  const done = await f.settled(paid.json().callId);
  assert.deepEqual(shape(payCall('result_saved', { service })), shape(done));

  const history = (await f.history()).json() as FeedPayHistory;
  const fixture = payHistory(service);
  const fixturePaid = fixture.calls.find((item) => item.state === 'result_saved')!;
  assert.deepEqual(shape(fixturePaid), shape(history.calls[0]));
  const topUp = fixture.moves.find((move) => move.kind === 'top_up')!;
  assert.deepEqual(shape(topUp), shape(history.moves.find((move) => move.kind === 'top_up')));
  assert.deepEqual(
    shape({ ...fixture, calls: [], moves: [] }),
    shape({ ...history, calls: [], moves: [] }),
  );

  // Refusals: the same status, sentence, retryable and details as the engine's.
  const invalid = await f.quote({ body: {} });
  assert.deepEqual(
    payRefusal({
      code: 'invalid_inputs',
      fields: [{ field: 'tokenAddress', in: 'body', problem: 'missing' }],
    }),
    { status: invalid.statusCode, json: invalid.json() },
  );
  const off = await f.app.inject({
    method: 'PUT',
    url: '/api/feed/pay/agents/unknown-agent',
    headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie: f.owner.cookie },
    payload: JSON.stringify({ perCallMaxRaw: null }),
  });
  assert.deepEqual(payRefusal({ code: 'agent_not_found' }), {
    status: off.statusCode,
    json: off.json(),
  });
});
