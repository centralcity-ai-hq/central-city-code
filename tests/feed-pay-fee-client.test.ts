import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeedService } from '../shared/feed.js';
import type { FeedPayHistoryItem, FeedPayQuote } from '../shared/feed-pay.js';
import { payAgent, payCall, payFee, payQuote, sampleServices } from '../e2e/feed-fixtures.js';
import { getCall, getServiceCalls, quoteService, withFee } from '../src/feed/payApi.js';
import {
  callMoneyLines,
  confirmText,
  dollarText,
  FEE_LABEL,
  feeTxHref,
  historyAmountRaw,
  historyLine,
  historyMoneyText,
  maxFits,
  payButtonText,
  payeeLine,
  priceLine,
  quoteCheck,
  quoteFeeRaw,
  quoteLines,
  quoteTotalRaw,
  recheckNote,
} from '../src/feed/pay/payModel.js';
import { CallCard, MoneyLines } from '../src/feed/pay/CallCard.js';

/*
 * Central City's fee on top in "Use with my agent" (Operation Protocol Z2b, docs/protocol/FEES.md):
 * with protocol fees on, the quote shows the price, the fee (10%) and the total, the confirm names
 * all three, every cap holds for the total, and the call and the wallet History show price, fee
 * and total with their Base transactions. With fees off, everything reads exactly as before.
 */

/** Arrow characters and arrow-like quotes: none anywhere in the Feed. */
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const NOW = Date.UTC(2026, 9, 14, 12, 0);

function ax1(): FeedService {
  const base = sampleServices(NOW)[0]!;
  return {
    ...base,
    url: 'https://www.ax1.vc/api/lookup',
    provider: { host: 'www.ax1.vc', name: 'ax1' },
    price: { raw: '20000', decimals: 6, display: '0.02', unit: 'per_call' },
  };
}

const withFeeOn = (overrides: Parameters<typeof payQuote>[1] = {}) =>
  payQuote(ax1(), { amountRaw: '20000', fee: true, ...overrides });
const withFeeOff = (overrides: Parameters<typeof payQuote>[1] = {}) =>
  payQuote(ax1(), { amountRaw: '20000', ...overrides });

test('the quote: price, Central City fee (10%) and total; fees off, the one price as before', () => {
  const on = withFeeOn();
  assert.equal(quoteFeeRaw(on), '2000');
  assert.equal(quoteTotalRaw(on), '22000');
  assert.deepEqual(quoteLines(on), [
    { key: 'price', label: 'Price', value: '$0.02' },
    { key: 'fee', label: 'Central City fee (10%)', value: '$0.002' },
    { key: 'total', label: 'Total', value: '$0.022' },
  ]);
  assert.equal(FEE_LABEL, 'Central City fee (10%)');
  assert.equal(dollarText('100000'), '$0.10');
  const off = withFeeOff();
  assert.equal(quoteFeeRaw(off), null);
  assert.equal(quoteTotalRaw(off), '20000');
  assert.equal(quoteLines(off), null);
  assert.equal(priceLine(off), '0.02 USDC per call');
  // Where the money goes: the price to the listed host, the fee to Central City.
  assert.equal(payeeLine(off), 'Paid to www.ax1.vc, the address its listing names.');
  assert.equal(
    payeeLine(on),
    'The price goes to www.ax1.vc, the address its listing names. The fee goes to Central City.',
  );
  // The lines render as a list of terms: the label, then its amount.
  const html = renderToStaticMarkup(
    createElement(MoneyLines, { lines: quoteLines(on)!, label: 'What this call costs' }),
  );
  assert.match(html, /<dl class="fp-lines" aria-label="What this call costs">/);
  assert.match(html, /<dt>Price<\/dt><dd class="fp-line-v">\$0\.02<\/dd>/);
  assert.match(html, /<dt>Central City fee \(10%\)<\/dt><dd class="fp-line-v">\$0\.002<\/dd>/);
  assert.match(html, /data-k="total"><dt>Total<\/dt><dd class="fp-line-v">\$0\.022<\/dd>/);
  assert.doesNotMatch(html, ARROWS);
});

test('the confirm names the total, the price to the host and the fee; fees off, as before', () => {
  assert.equal(
    confirmText(withFeeOn(), 'hhuo'),
    'Pay 0.022 USDC from hhuo: 0.02 to www.ax1.vc and 0.002 Central City fee? You can’t undo it.',
  );
  assert.equal(payButtonText(withFeeOn()), 'Pay 0.022 USDC');
  assert.equal(
    confirmText(withFeeOff(), 'hhuo'),
    'Pay 0.02 USDC from hhuo to www.ax1.vc? You can’t undo it.',
  );
  assert.equal(payButtonText(withFeeOff()), 'Pay 0.02 USDC');
  // The agent's name is plain text here too.
  assert.equal(
    confirmText(withFeeOn(), 'hh‮uo'),
    'Pay 0.022 USDC from hhuo: 0.02 to www.ax1.vc and 0.002 Central City fee? You can’t undo it.',
  );
});

test('the per-call maximum, the limit left and the funds hold for the total, fee included', () => {
  // Exactly the price fits a 0.02 maximum while fees are off; with the fee it doesn't.
  const max = payAgent({ perCallMaxRaw: '20000', perCallMaxIsDefault: false });
  assert.deepEqual(quoteCheck(withFeeOff(), max), { kind: 'ok' });
  assert.deepEqual(quoteCheck(withFeeOn(), max), {
    kind: 'over_max',
    text: '0.022 USDC in total is above hhuo’s per-call maximum of 0.02 USDC.',
  });
  assert.equal(maxFits(withFeeOn(), '20000'), false);
  assert.equal(maxFits(withFeeOn(), '22000'), true);
  assert.equal(maxFits(withFeeOff(), '20000'), true);
  // The limit left.
  const left = payAgent({ limitLeftRaw: '21000' });
  assert.deepEqual(quoteCheck(withFeeOff(), left), { kind: 'ok' });
  assert.deepEqual(quoteCheck(withFeeOn(), left), {
    kind: 'over_limit',
    text: '0.022 USDC in total is more than hhuo may still spend today.',
  });
  // What the agent has (its wallet plus Ready for services).
  const poor = payAgent({ usdcRaw: '21000', floatRaw: '0' });
  assert.deepEqual(quoteCheck(withFeeOff(), poor), { kind: 'ok' });
  assert.deepEqual(quoteCheck(withFeeOn(), poor), {
    kind: 'no_funds',
    text: 'hhuo has 0.021 USDC, less than this call costs.',
  });
  // Above $0.10 with the fee: no per-call maximum can allow it (no Change maximum).
  assert.deepEqual(quoteCheck(withFeeOn({ amountRaw: '95000' }), payAgent()), {
    kind: 'over_cap',
    text: '0.1045 USDC in total is above 0.10 USDC, the most an agent pays for one call.',
  });
  assert.deepEqual(quoteCheck(withFeeOn({ amountRaw: '90909' }), payAgent()), { kind: 'ok' });
  assert.deepEqual(quoteCheck(withFeeOff({ amountRaw: '95000' }), payAgent()), { kind: 'ok' });
  // A price whose fee rounds down to nothing is refused by the server: said before the confirm.
  assert.deepEqual(quoteCheck(withFeeOn({ amountRaw: '9' }), payAgent()), {
    kind: 'fee_too_small',
    text: 'This price is too small to pay with Central City’s fee on top.',
  });
});

test('the call card: price, fee and total, each with its Base transaction; fees off, one line', () => {
  const s = ax1();
  const paid = payCall('result_saved', { service: s, fee: true });
  assert.deepEqual(
    callMoneyLines(paid)!.map((line) => [line.label, line.value, line.sub, line.note]),
    [
      ['Price', '$0.02', 'to www.ax1.vc', null],
      ['Central City fee (10%)', '$0.002', null, null],
      ['Total', '$0.022', 'from hhuo', null],
    ],
  );
  const html = renderToStaticMarkup(
    createElement(CallCard, { call: paid, heading: 'Your call', now: NOW }),
  );
  assert.match(html, /Paid 0\.02 USDC to www\.ax1\.vc\./);
  assert.match(html, /<dl class="fp-lines" aria-label="Payment" data-money="yes">/);
  assert.match(html, /href="https:\/\/basescan\.org\/tx\/0x7{64}"[^>]*>Base transaction/);
  assert.match(html, /href="https:\/\/basescan\.org\/tx\/0x5{64}"[^>]*>Fee transaction/);
  assert.match(html, /\$0\.022/);
  assert.doesNotMatch(html, /fp-pay"/);
  assert.doesNotMatch(html, ARROWS);
  // While Base decides: the price is confirming, the fee comes after it.
  const running = payCall('result_saved', { service: s, paymentState: 'sent', fee: true });
  assert.deepEqual(
    callMoneyLines(running)!.map((line) => line.note),
    ['Confirming on Base', 'After the price is paid', null],
  );
  // Paid, the fee on its way.
  assert.deepEqual(
    callMoneyLines(payCall('result_saved', { service: s, fee: 'sent' }))!.map((l) => l.note),
    [null, 'Confirming on Base', null],
  );
  // A fee that failed is not in the total.
  const failed = callMoneyLines(payCall('result_saved', { service: s, fee: 'failed' }))!;
  assert.deepEqual(
    failed.map((line) => [line.value, line.note]),
    [
      ['$0.02', null],
      ['$0.002', 'Not charged'],
      ['$0.02', null],
    ],
  );
  // Nothing paid, or no fee owed: the one payment line, as before.
  assert.equal(callMoneyLines(payCall('cancelled', { service: s, fee: true })), null);
  assert.equal(callMoneyLines(payCall('refused', { service: s, fee: true })), null);
  const off = payCall('result_saved', { service: s });
  assert.equal(callMoneyLines(off), null);
  const offHtml = renderToStaticMarkup(
    createElement(CallCard, { call: off, heading: 'Your call', now: NOW }),
  );
  assert.match(
    offHtml,
    /<p class="fp-pay" data-money="yes"><span>0\.02 USDC from hhuo to www\.ax1\.vc/,
  );
  assert.doesNotMatch(offHtml, /Central City fee|fp-lines|Fee transaction/);
});

test('the wallet History: the total spent, and price, fee and total under the call', () => {
  const s = ax1();
  const item = (call: ReturnType<typeof payCall>): FeedPayHistoryItem => ({
    callId: call.callId,
    origin: call.origin,
    state: call.state,
    moneyMoved: call.moneyMoved,
    service: { id: call.service.id, title: call.service.title, host: call.service.host },
    payment: call.payment,
    protocolFee: call.protocolFee,
    resultAvailable: true,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  });
  const paid = item(payCall('result_saved', { service: s, fee: true }));
  assert.equal(historyLine(paid), 'Paid www.ax1.vc 0.02 USDC');
  assert.equal(historyMoneyText(paid), 'Price 0.02 · Central City fee (10%) 0.002 · Total 0.022');
  assert.equal(historyAmountRaw(paid), '22000');
  assert.equal(feeTxHref(paid), `https://basescan.org/tx/0x${'5'.repeat(64)}`);
  const failed = item(payCall('result_saved', { service: s, fee: 'failed' }));
  assert.equal(
    historyMoneyText(failed),
    'Price 0.02 · Central City fee (10%) 0.002, not charged · Total 0.02',
  );
  assert.equal(historyAmountRaw(failed), '20000');
  assert.equal(feeTxHref(failed), null);
  // Fees off: the price, as before, and no extra line.
  const off = item(payCall('result_saved', { service: s }));
  assert.equal(historyMoneyText(off), null);
  assert.equal(historyAmountRaw(off), '20000');
  // Nothing paid: no fee line, and the amount it would have been.
  const cancelled = item(payCall('cancelled', { service: s, fee: true }));
  assert.equal(historyMoneyText(cancelled), null);
  assert.equal(historyAmountRaw(cancelled), '20000');
  assert.equal(payFee(true, '20000', 'no').state, 'not_owed');
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const fetcherOf = (body: unknown) => (async () => json(200, body)) as unknown as typeof fetch;

test('an answer without the fee fields reads as fees off; with them, as the server sent them', async () => {
  const s = ax1();
  const { protocolFee: _fee, total: _total, ...old } = withFeeOff();
  const read = (await quoteService(s.id, {}, { fetcher: fetcherOf(old) })) as FeedPayQuote;
  assert.equal(read.protocolFee, null);
  assert.deepEqual(read.total, read.amount);
  const on = withFeeOn();
  assert.deepEqual(await quoteService(s.id, {}, { fetcher: fetcherOf(on) }), on);
  // A fee without a total: the total is the price plus the fee.
  const { total: _t, ...noTotal } = on;
  assert.deepEqual(withFee(noTotal as FeedPayQuote).total, {
    raw: '22000',
    decimals: 6,
    display: '0.022',
  });
  const call = payCall('result_saved', { service: s });
  const { protocolFee: _p, ...oldCall } = call;
  assert.equal((await getCall(call.callId, { fetcher: fetcherOf(oldCall) })).protocolFee, null);
  const history = await getServiceCalls('agent', {
    fetcher: fetcherOf({
      calls: [{ callId: call.callId, payment: call.payment }],
      moves: [],
      readyForServices: null,
      perCallMax: call.maxAmount,
    }),
  });
  assert.equal(history!.calls[0]!.protocolFee, null);
});

test('a fee that applies only since the confirm: checked again, the note names the fee', () => {
  const before = withFeeOff();
  const now = withFeeOn();
  // The call sent the total confirmed (no fee): 0.02 USDC. The server refused quote_mismatch.
  assert.equal(quoteTotalRaw(before), '20000');
  assert.equal(
    recheckNote('mismatch', before.amount.raw, now.amount.raw, {
      beforeRaw: quoteFeeRaw(before),
      nowRaw: quoteFeeRaw(now),
    }),
    'The price check didn’t match this payment, so we checked again. Central City’s fee of 0.002 USDC now comes on top. Confirm to pay.',
  );
  // The new confirm names the price, the fee and the total.
  assert.equal(
    confirmText(now, 'hhuo'),
    'Pay 0.022 USDC from hhuo: 0.02 to www.ax1.vc and 0.002 Central City fee? You can’t undo it.',
  );
  // An expired check that finds the price changed and the fee gone says both.
  assert.equal(
    recheckNote('expired', '20000', '30000', { beforeRaw: '2000', nowRaw: null }),
    'The price check expired, so we checked again. It was 0.02 USDC, now 0.03 USDC. Central City’s fee no longer applies. Confirm to pay.',
  );
  // The same fee before and now (or none): nothing more than before.
  assert.equal(
    recheckNote('expired', '20000', '20000', { beforeRaw: '2000', nowRaw: '2000' }),
    'The price check expired, so we checked again. Confirm to pay.',
  );
  assert.equal(
    recheckNote('mismatch', null, '20000'),
    'The price check didn’t match this payment, so we checked again. Confirm to pay.',
  );
  assert.doesNotMatch(
    recheckNote('mismatch', '1', '1', { beforeRaw: null, nowRaw: '2000' }),
    ARROWS,
  );
});

/*
 * A service sold by a Central City agent is fee included: the buyer pays exactly the listed price,
 * 90% goes to the seller and 10% to Central City in the same transaction. Nothing may read as the
 * price plus the fee (0.055 for a 0.05 call), and there is no fee transaction of its own.
 */

/** A 0.05 USDC call, fee included, as the server answers it (price = total). */
const includedQuote = () => {
  const quote = payQuote(ax1(), { amountRaw: '50000', fee: true });
  return { ...quote, total: quote.amount, feeIncluded: true as const };
};

function includedCall(fee: true | 'failed' = true): ReturnType<typeof payCall> {
  const call = payCall('result_saved', { service: ax1(), amountRaw: '50000', fee });
  return {
    ...call,
    // The fee went in the payment's own transaction.
    protocolFee: {
      ...call.protocolFee!,
      txHash: (call.payment!.txHash ?? null) as `0x${string}` | null,
      included: true,
    },
  };
}

test('fee included: the quote shows the price and its 10%, no total; the confirm says included', () => {
  const quote = includedQuote();
  assert.equal(quoteFeeRaw(quote), '5000');
  assert.equal(quoteTotalRaw(quote), '50000');
  // Without the server's total too: the price, never the price plus the fee.
  const { total: _total, ...noTotal } = quote;
  assert.equal(quoteTotalRaw(noTotal as FeedPayQuote), '50000');
  assert.deepEqual(quoteLines(quote), [
    { key: 'price', label: 'Price, fee included', value: '$0.05' },
    { key: 'fee', label: 'Central City fee (10%, included)', value: '$0.005' },
  ]);
  assert.equal(
    payeeLine(quote),
    "One payment: 90% of the price goes to the selling agent's wallet, the address its listing names, and 10% to Central City.",
  );
  assert.equal(
    confirmText(quote, 'hhuo'),
    'Pay 0.05 USDC from hhuo to the selling agent, fee included (0.005 to Central City)? You can’t undo it.',
  );
  assert.equal(payButtonText(quote), 'Pay 0.05 USDC');
  // The caps hold for the price: exactly 0.05 fits a 0.05 maximum.
  const max = payAgent({ perCallMaxRaw: '50000', perCallMaxIsDefault: false });
  assert.deepEqual(quoteCheck(quote, max), { kind: 'ok' });
  assert.equal(maxFits(quote, '50000'), true);
  assert.deepEqual(
    quoteCheck(
      {
        ...quote,
        amount: { ...quote.amount, raw: '9' },
        protocolFee: { ...quote.protocolFee!, raw: '0' },
        total: { ...quote.total, raw: '9' },
      },
      payAgent(),
    ),
    {
      kind: 'fee_too_small',
      text: 'This price is too small to pay with Central City’s fee included.',
    },
  );
  assert.equal(
    recheckNote('mismatch', null, '50000', { beforeRaw: null, nowRaw: '5000', included: true }),
    'The price check didn’t match this payment, so we checked again. Central City’s fee of 0.005 USDC is now included in the price. Confirm to pay.',
  );
  const all = [
    quoteLines(quote)!
      .map((l) => `${l.label} ${l.value}`)
      .join(' '),
    payeeLine(quote),
    confirmText(quote, 'hhuo'),
  ].join(' ');
  assert.doesNotMatch(all, /0\.055|on top|Total/);
  assert.doesNotMatch(all, ARROWS);
});

test('fee included: the call card and the History show the price, its 10%, and one transaction', () => {
  const call = includedCall();
  assert.deepEqual(
    callMoneyLines(call)!.map((line) => [line.label, line.value, line.sub, line.note, line.tx]),
    [
      [
        'Price, fee included',
        '$0.05',
        'from hhuo to www.ax1.vc',
        null,
        { href: call.payment!.explorerUrl, label: 'Base transaction' },
      ],
      ['Central City fee (10%, included)', '$0.005', null, null, null],
    ],
  );
  const html = renderToStaticMarkup(
    createElement(CallCard, { call, heading: 'Your call', now: NOW }),
  );
  assert.doesNotMatch(html, /Fee transaction|0\.055|data-k="total"/);
  assert.equal((html.match(/Base transaction/g) ?? []).length, 1);
  const item: FeedPayHistoryItem = {
    callId: call.callId,
    origin: call.origin,
    state: call.state,
    moneyMoved: call.moneyMoved,
    service: { id: call.service.id, title: call.service.title, host: call.service.host },
    payment: call.payment,
    protocolFee: call.protocolFee,
    resultAvailable: true,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
  assert.equal(historyMoneyText(item), '0.05 USDC, fee included (0.005 to Central City)');
  assert.equal(historyAmountRaw(item), '50000');
  assert.equal(feeTxHref(item), null);
  assert.doesNotMatch(historyMoneyText(item)!, ARROWS);
  // A fee that was not charged says so, and the amount stays the price.
  const failed = includedCall('failed');
  assert.equal(
    historyMoneyText({ ...item, protocolFee: failed.protocolFee }),
    '0.05 USDC, fee included (0.005 to Central City, not charged)',
  );
  assert.equal(historyAmountRaw({ ...item, protocolFee: failed.protocolFee }), '50000');
});
