import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import qrcode from 'qrcode-generator';
import {
  DAY_MS,
  DECODE_MS,
  balanceAt,
  decodeFrame,
  isFinder,
  keyGroups,
  linePath,
  lineScale,
  lineTicks,
  odometerCells,
  odometerStartDigit,
  qrModules,
  scrubPoint,
  settleMs,
  windowTransfers,
  type WalletTransfer,
} from '../src/base/wallet/visual/walletVisualModel.js';
import { qrMatrix } from '../src/base/wallet/visual/qrMatrix.js';

// The components import their stylesheet (Vite bundles it); empty under Node.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { Odometer } = await import('../src/base/wallet/visual/Odometer.js');
const { BalanceLine } = await import('../src/base/wallet/visual/BalanceLine.js');
const { KeyReveal } = await import('../src/base/wallet/visual/KeyReveal.js');
const { AssembledQR, qrAddress } = await import('../src/base/wallet/visual/AssembledQR.js');

/*
 * Base Wallet visuals (src/base/wallet/visual): the odometer's columns, the 24-hour balance line,
 * the backup key's groups and decode, and the deposit QR. Synthetic values only.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 10, 15, 42);
const transfer = (
  hoursAgo: number,
  amount: number,
  kind: WalletTransfer['kind'] = amount > 0 ? 'received' : 'spent',
): WalletTransfer => ({ at: NOW - hoursAgo * HOUR, amount, kind, label: `test ${hoursAgo}h` });

/** Every number in an SVG path, in order. */
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const r2 = (n: number) => Math.round(n * 100) / 100;

test('odometer: digits roll, dots stay, keys count from the right with a 28 ms stagger', () => {
  assert.deepEqual(odometerCells('25.00'), [
    { kind: 'digit', digit: 2, key: 'd4', delayMs: 112 },
    { kind: 'digit', digit: 5, key: 'd3', delayMs: 84 },
    { kind: 'char', char: '.', key: 'c2' },
    { kind: 'digit', digit: 0, key: 'd1', delayMs: 28 },
    { kind: 'digit', digit: 0, key: 'd0', delayMs: 0 },
  ]);
  assert.deepEqual(
    odometerCells('18,402').map((cell) => cell.kind),
    ['digit', 'digit', 'char', 'digit', 'digit', 'digit'],
  );
  // 9.99 → 10.00: the new leading column starts at 0, the next at the old 9 (right-aligned).
  assert.equal(odometerStartDigit('9.99', 5, 0), 0);
  assert.equal(odometerStartDigit('9.99', 5, 1), 9);
  assert.equal(odometerStartDigit('9.99', 5, 4), 9);
  // A place that held a dot, or nothing, starts at 0.
  assert.equal(odometerStartDigit('9.99', 4, 1), 0);
  assert.equal(odometerStartDigit('', 4, 3), 0);
});

test('balanceAt: the start balance, a step at each transfer, the balance now after the last', () => {
  const list = [transfer(5, 28.2), transfer(3, -3), transfer(1, -5, 'withdrawn')];
  assert.equal(balanceAt(8, list, NOW - 24 * HOUR), 8);
  assert.equal(balanceAt(8, list, NOW - 5 * HOUR - 1), 8);
  assert.equal(balanceAt(8, list, NOW - 5 * HOUR), 36.2);
  assert.equal(balanceAt(8, list, NOW - 2 * HOUR), 33.2);
  assert.equal(balanceAt(8, list, NOW), 28.2);
  assert.equal(balanceAt(8, list, NOW + HOUR), 28.2);
  assert.equal(balanceAt(8, [], NOW), 8, 'no transfers: the start balance, never zero');
});

test('windowTransfers: only the last 24 hours, oldest first, with their place in the input', () => {
  const input = [
    transfer(1, -1.2),
    transfer(25, 100), // before the window: already in the start balance
    transfer(20, 28.2),
    transfer(-1, 50), // after now
    transfer(24, 7), // the window's first moment: already in the start balance
  ];
  const list = windowTransfers(input, NOW);
  assert.deepEqual(
    list.map((item) => [item.index, item.amount]),
    [
      [2, 28.2],
      [0, -1.2],
    ],
  );
  assert.deepEqual(
    windowTransfers(input, NOW, 2 * HOUR).map((item) => item.index),
    [0],
  );
  assert.deepEqual(windowTransfers([transfer(30, 5)], NOW), []);
});

test('linePath: starts at the start balance, ends at now, one corner pair per transfer', () => {
  const list = windowTransfers(
    [transfer(20, 28.2), transfer(9, -3), transfer(8.99, -2), transfer(0.5, -5)],
    NOW,
  );
  const scale = lineScale({
    startBalance: 8,
    transfers: list,
    from: NOW - DAY_MS,
    to: NOW,
    width: 320,
    height: 52,
  });
  const d = linePath(8, list, scale);
  assert.ok(d.startsWith(`M0 ${r2(scale.y(8))} `), d);
  assert.notEqual(scale.y(8), scale.y(0), 'the line starts at the real balance, not at zero');
  assert.ok(d.endsWith(` L320 ${r2(scale.y(balanceAt(8, list, NOW)))}`), d);
  assert.equal(d.match(/ C/g)?.length, list.length);
  assert.equal(d.match(/ L/g)?.length, list.length + 1);
  // x never goes back, even where two transfers are a pixel apart.
  const xs: number[] = [];
  for (const [, command, args] of d.matchAll(/([MLC])([^MLC]+)/g)) {
    const values = numbers(args);
    const points = command === 'C' ? [values[0], values[2], values[4]] : [values[0]];
    xs.push(...points);
  }
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] - 1e-9, `x at ${i}: ${xs}`);
  // The scale: oldest at 0, now at the full width; the highest balance under the top.
  assert.equal(scale.x(NOW - DAY_MS), 0);
  assert.equal(scale.x(NOW), 320);
  assert.ok(scale.y(36.2) > 0 && scale.y(36.2) < 52);
});

test('scrub: snaps to a transfer within 10 px, else shows the balance at the pointer', () => {
  const list = windowTransfers([transfer(12, 10), transfer(6, -4)], NOW);
  const scale = lineScale({
    startBalance: 2,
    transfers: list,
    from: NOW - DAY_MS,
    to: NOW,
    width: 240,
    height: 52,
  });
  // 240 px for 24 h: 10 px is an hour.
  const near = scrubPoint(2, list, scale, NOW - 12.5 * HOUR);
  assert.deepEqual(near, { at: NOW - 12 * HOUR, balance: 12, near: 0 });
  const between = scrubPoint(2, list, scale, NOW - 9 * HOUR);
  assert.deepEqual(between, { at: NOW - 9 * HOUR, balance: 12, near: -1 });
  assert.equal(scrubPoint(2, list, scale, NOW - 20 * HOUR).balance, 2);
  assert.equal(scrubPoint(2, list, scale, NOW).balance, 8);
  assert.deepEqual(lineTicks(), ['24h ago', '12h', 'Now']);
});

// Synthetic, low-entropy key: every group has a letter, so none can hide in a number.
const KEY = `0x${'a1b2c3d4e5a6a7b8'.repeat(4)}` as const;

test('backup key: 16 groups of 4, decoded one character at a time', () => {
  const groups = keyGroups(KEY);
  assert.equal(groups.length, 16);
  assert.ok(groups.every((group) => group.length === 4));
  assert.equal(groups.join(''), KEY.slice(2));
  assert.equal(settleMs(0), 220);
  assert.equal(DECODE_MS, 63 * 16 + 220);
  // The key has no "f", so noise from random() = 0.999 is always "f".
  const noise = () => 0.999;
  const start = decodeFrame(groups, 0, noise);
  assert.equal(start.done, false);
  assert.ok(start.cells.every((cell) => cell === 'ffff'));
  const partway = decodeFrame(groups, settleMs(5), noise);
  assert.equal(partway.cells[0], groups[0]);
  assert.equal(partway.cells[1], `${groups[1].slice(0, 2)}ff`);
  assert.equal(partway.done, false);
  const end = decodeFrame(groups, DECODE_MS, noise);
  assert.equal(end.done, true);
  assert.deepEqual(end.cells, groups);
});

const ADDRESS = `0x${'12ab'.repeat(10)}`;
const URI = `ethereum:${ADDRESS}@84532`;

test('QR: the matrix is square and its three finder patterns are dark squares', () => {
  const code = qrcode(0, 'M');
  code.addData(URI);
  code.make();
  const n = code.getModuleCount();
  assert.equal((n - 17) % 4, 0, `a QR version is 21, 25, 29 … modules wide, not ${n}`);
  const matrix = qrMatrix(URI);
  assert.equal(matrix.length, n);
  assert.ok(
    matrix.every((row) => row.length === n),
    'square',
  );
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) assert.equal(matrix[r][c], code.isDark(r, c));
  for (const [top, left] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ]) {
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(
          matrix[top + r][left + c],
          ring || core,
          `finder at ${top},${left}: ${r},${c}`,
        );
        assert.ok(isFinder(top + r, left + c, n));
      }
  }
  assert.equal(isFinder(n - 1, n - 1, n), false, 'no finder bottom right');
});

test('QR: every dark module flies in, finders first, and settles on its cell', () => {
  const matrix = qrMatrix(URI);
  const n = matrix.length;
  const size = 184;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const modules = qrModules(matrix, size, random);
  assert.equal(modules.length, matrix.flat().filter(Boolean).length);
  const cell = size / n;
  for (const piece of modules) {
    const c = Math.round(piece.x / cell);
    const r = Math.round(piece.y / cell);
    assert.ok(matrix[r][c]);
    assert.equal(piece.finder, isFinder(r, c, n));
    if (piece.finder) assert.ok(piece.delay < 120);
    else assert.ok(piece.delay >= 160);
    const flight = Math.hypot(piece.fx - piece.x, piece.fy - piece.y);
    assert.ok(flight >= 60 - 1e-9 && flight <= 200 + 1e-9);
  }
  assert.equal(qrAddress(URI), ADDRESS);
});

test('render: the odometer reads as plain text, the columns are hidden', () => {
  const html = renderToStaticMarkup(createElement(Odometer, { value: '25.00', instant: true }));
  assert.match(html, /<span class="visually-hidden">25\.00<\/span>/);
  assert.equal(html.match(/class="wv-odo-col" aria-hidden="true"/g)?.length, 4);
  assert.match(html, /class="wv-odo-char" aria-hidden="true">\.</);
  assert.match(html, /translateY\(-2em\)/);
  assert.match(html, /translateY\(-5em\)/);
});

test('render: the key is not in the page before it is held to show', () => {
  const html = renderToStaticMarkup(createElement(KeyReveal, { privateKey: KEY }));
  assert.match(html, /data-state="hidden"/);
  assert.match(html, /data-revealed="false"/);
  assert.equal(html.match(/••••/g)?.length, 16);
  assert.ok(!html.includes(KEY.slice(2)));
  for (const group of keyGroups(KEY)) assert.ok(!html.includes(group), group);
  assert.match(html, /Press and hold to show/);
});

test('render: the QR names the address; the line renders nothing without a transfer', () => {
  const qr = renderToStaticMarkup(createElement(AssembledQR, { value: URI }));
  assert.match(qr, /<canvas[^>]*role="img"/);
  assert.ok(qr.includes(`aria-label="QR code of the address ${ADDRESS}"`));
  assert.match(qr, /width:184px;height:184px/);

  const none = renderToStaticMarkup(
    createElement(BalanceLine, { startBalance: 25, transfers: [transfer(30, 5)], now: NOW }),
  );
  assert.equal(none, '');
  const line = renderToStaticMarkup(
    createElement(BalanceLine, { startBalance: 25, transfers: [transfer(3, -2)], now: NOW }),
  );
  assert.match(line, /class="wv-line"/);
  assert.match(line, /role="img"/);
  assert.match(line, /<span>24h ago<\/span><span>12h<\/span><span>Now<\/span>/);
});
