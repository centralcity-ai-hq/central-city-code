import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SERVICE_CALLS_PATH, type ServiceCall } from '../shared/explorer-calls';

// The page imports its stylesheets (Vite bundles them); under Node a .css import is empty.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { agoText, loadServiceCalls, SearchRefused, shortHex } =
  await import('../src/verify/serviceCallsData.js');
const { ExplorerSwitch } = await import('../src/verify/ExplorerSwitch.js');
const { CallSheet, ServiceCalls } = await import('../src/verify/ServiceCalls.js');

/*
 * The Service calls view on the client (src/verify/ServiceCalls.tsx, serviceCallsData.ts): what it
 * asks the public route, the switch's third view, the page's copy and the details sheet.
 */

/** No arrow glyphs anywhere (they read as machine-made): →, ↗, ›, », ⟶ and friends. */
const ARROWS = /[←-⇿›»⟶➜➔]/;

const CALL: ServiceCall = {
  tx_hash: `0x${'ab'.repeat(32)}`,
  block: 52_693_856,
  time: Date.now() - 12_000,
  payer: `0x${'12'.repeat(20)}`,
  provider: `0x${'34'.repeat(20)}`,
  service: 'Page reader, fast',
  amount: '0.05',
  provider_amount: '0.045',
  fee: { model: 'included', amount: '0.005', tx_hash: `0x${'ab'.repeat(32)}`, block: 52_693_856 },
  status: 'settled',
  ref: `0x${'cd'.repeat(32)}`,
};

test('the client asks the public route: a trimmed search, the cursor, and a refused search', async (t) => {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    asked.push(path);
    const q = new URL(path, 'https://x').searchParams.get('q');
    return new Response(JSON.stringify({ items: [] }), { status: q === 'nope' ? 400 : 200 });
  });
  await loadServiceCalls();
  await loadServiceCalls({ q: '  52693856 ', cursor: `1_0x${'a'.repeat(64)}` });
  await loadServiceCalls({ q: ` ${'0x'.padEnd(120, 'a')} ` });
  await assert.rejects(loadServiceCalls({ q: 'nope' }), SearchRefused);
  assert.equal(asked[0], SERVICE_CALLS_PATH);
  const second = new URL(asked[1]!, 'https://x').searchParams;
  assert.equal(second.get('q'), '52693856');
  assert.equal(second.get('cursor'), `1_0x${'a'.repeat(64)}`);
  assert.equal(new URL(asked[2]!, 'https://x').searchParams.get('q')!.length, 66);
});

test('short hashes and ages', () => {
  assert.equal(shortHex(`0x${'ab'.repeat(20)}`), '0xabab…abab');
  assert.equal(agoText(12_400), '12 sec ago');
  assert.equal(agoText(-5_000), '0 sec ago');
  assert.equal(agoText(5 * 60_000), '5 min ago');
  assert.equal(agoText(3 * 3_600_000), '3 h ago');
});

test('the explorer switch has three views, the current one marked, counts when known', () => {
  const html = renderToStaticMarkup(
    createElement(ExplorerSwitch, { current: 'calls', all: 1732720, onBase: 55201, calls: 7040 }),
  );
  assert.match(html, /href="\/explorer"[^>]*>All agents<small> · 1,732,720<\/small>/);
  assert.match(html, /href="\/explorer\/base"[^>]*>On Base<small> · 55,201<\/small>/);
  assert.match(
    html,
    /href="\/explorer\/calls" aria-current="page">Service calls<small> · 7,040<\/small>/,
  );
  const unknown = renderToStaticMarkup(
    createElement(ExplorerSwitch, { current: 'all', all: null, onBase: null }),
  );
  assert.match(unknown, />Service calls<\/a>/);
});

test('the page: its copy, the three numbers, the columns, and no arrows', () => {
  const html = renderToStaticMarkup(createElement(ServiceCalls));
  for (const text of [
    'Every paid service call on Central City, live from Base. Each row is the onchain transaction that paid for it; open any of them on BaseScan.',
    'Paid service calls',
    'Last 24 h',
    'Per minute now',
    'Paid in USDC on Base mainnet. New payments appear within seconds.',
    'Latest transactions',
    'placeholder="Transaction hash, block or address"',
    '>Find<',
  ])
    assert.ok(html.includes(text), text);
  const columns = [...html.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(columns, [
    'Tx hash',
    'Service',
    'Time',
    'Block',
    'Payer',
    'Provider',
    'Amount',
    'Status',
  ]);
  // The page's own part (the shared site header is not this page's).
  assert.doesNotMatch(html.slice(html.indexOf('<main')), ARROWS);
});

test('the sheet: the transaction, where the payment went, and BaseScan', () => {
  const html = renderToStaticMarkup(
    createElement(CallSheet, { call: CALL, now: CALL.time + 12_000, onClose: () => undefined }),
  );
  for (const text of [
    'Settled on Base',
    '0.05 <small>USDC</small>',
    'Page reader, fast',
    'Base mainnet',
    'Where the payment went',
    '0.045 USDC',
    'Central City protocol',
    '10% fee, included in the price',
    '0.005 USDC',
    '12 sec ago',
    `href="https://basescan.org/tx/${CALL.tx_hash}"`,
    'href="https://basescan.org/block/52693856"',
    'View on BaseScan',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, ARROWS);
  // No fee leg on Base: no protocol line.
  const plain = renderToStaticMarkup(
    createElement(CallSheet, {
      call: { ...CALL, fee: null, amount: '0.05', provider_amount: '0.05' },
      now: CALL.time,
      onClose: () => undefined,
    }),
  );
  assert.ok(!plain.includes('Central City protocol'));
  // A fee on top names its own transaction.
  const onTop = renderToStaticMarkup(
    createElement(CallSheet, {
      call: {
        ...CALL,
        fee: { model: 'on_top', amount: '0.005', tx_hash: `0x${'cd'.repeat(32)}`, block: null },
      },
      now: CALL.time,
      onClose: () => undefined,
    }),
  );
  assert.ok(onTop.includes('10% fee, on top of the price'));
  assert.ok(onTop.includes(`https://basescan.org/tx/0x${'cd'.repeat(32)}`));
});
