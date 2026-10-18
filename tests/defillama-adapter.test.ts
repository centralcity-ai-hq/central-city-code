import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { settledVolume } from '../scripts/protocol/defillama-volume.js';

/*
 * The DefiLlama adapter's volume rule (docs/protocol/DEFILLAMA_ADAPTER.md): a fee-on-top price is
 * volume only when matched to its seller payment in the same window, earlier in the chain; a fee
 * alone never makes volume and a payment never backs two fees, within a window or across windows.
 */

const PAYER = '0x00000000000000000000000000000000000000a1';
const PAYEE = '0x00000000000000000000000000000000000000b2';
const OTHER = '0x00000000000000000000000000000000000000c3';
const LOOKBACK = 900;
const fee = (block: number, index = 5, gross = 20000n, kind = 0) => ({
  kind,
  payer: PAYER,
  payee: PAYEE,
  gross,
  block,
  index,
});
const paid = (block: number, index = 1, value = 20000n, from = PAYER, to = PAYEE) => ({
  from,
  to,
  value,
  block,
  index,
  tx: `0x${block.toString(16).padStart(8, '0')}${index.toString(16).padStart(4, '0')}`,
});

test('a fee with its seller payment just before counts the price as volume', () => {
  assert.deepEqual(settledVolume([fee(1000)], [paid(995)], LOOKBACK), [20000n]);
});

test('a real fee with no seller payment counts no volume (the fee alone proves nothing)', () => {
  assert.deepEqual(settledVolume([fee(1000)], [], LOOKBACK), [0n]);
});

test('the payment must be the exact price, from the payer, to the payee', () => {
  assert.deepEqual(settledVolume([fee(1000)], [paid(995, 1, 19999n)], LOOKBACK), [0n]);
  assert.deepEqual(settledVolume([fee(1000)], [paid(995, 1, 20000n, OTHER)], LOOKBACK), [0n]);
  assert.deepEqual(settledVolume([fee(1000)], [paid(995, 1, 20000n, PAYER, OTHER)], LOOKBACK), [
    0n,
  ]);
  assert.deepEqual(
    settledVolume([fee(1000)], [paid(995, 1, 20000n, PAYER.toUpperCase())], LOOKBACK),
    [20000n],
  );
});

test('the payment must be earlier in the chain than the fee: block, then log index', () => {
  assert.deepEqual(settledVolume([fee(1000)], [paid(1001)], LOOKBACK), [0n]);
  // The same block: only a transfer logged before the fee counts.
  assert.deepEqual(settledVolume([fee(1000, 5)], [paid(1000, 6)], LOOKBACK), [0n]);
  assert.deepEqual(settledVolume([fee(1000, 5)], [paid(1000, 5)], LOOKBACK), [0n]);
  assert.deepEqual(settledVolume([fee(1000, 5)], [paid(1000, 4)], LOOKBACK), [20000n]);
  // Within the lookback.
  assert.deepEqual(settledVolume([fee(1000)], [paid(1000 - LOOKBACK - 1)], LOOKBACK), [0n]);
  assert.deepEqual(settledVolume([fee(1000)], [paid(1000 - LOOKBACK)], LOOKBACK), [20000n]);
});

test('one payment backs one fee: a second fee for the same price needs its own payment', () => {
  assert.deepEqual(settledVolume([fee(1000), fee(1010)], [paid(990)], LOOKBACK), [20000n, 0n]);
  assert.deepEqual(settledVolume([fee(1010), fee(1000)], [paid(990), paid(1005)], LOOKBACK), [
    20000n,
    20000n,
  ]);
  // The same transfer reported twice (overlapping reads) is still one payment.
  assert.deepEqual(settledVolume([fee(1000), fee(1010)], [paid(990), paid(990)], LOOKBACK), [
    20000n,
    0n,
  ]);
});

test('two windows never share a payment: each window sees only its own transfers', () => {
  // Window A: blocks 0..1799, window B: blocks 1800..3599 (hourly at 2 s).
  const payment = paid(1795);
  const inA = fee(1798);
  const inB = fee(1802);
  assert.deepEqual(settledVolume([inA], [payment], LOOKBACK), [20000n]);
  // Window B's fetch reads B's transfers only: the payment in A cannot back the fee in B.
  assert.deepEqual(settledVolume([inB], [], LOOKBACK), [0n]);
  // A fee in B whose real payment fell just before B's start is not matched: an undercount.
  assert.deepEqual(settledVolume([fee(1801)], [], LOOKBACK), [0n]);
});

test('a fee-included call (kind 1) moves the price in the router call: always volume', () => {
  assert.deepEqual(settledVolume([fee(1000, 5, 50000n, 1)], [], LOOKBACK), [50000n]);
});

test('the adapter in the doc carries exactly this rule', () => {
  const normalize = (text: string) => text.replace(/\r\n/g, '\n');
  const doc = normalize(readFileSync('docs/protocol/DEFILLAMA_ADAPTER.md', 'utf8'));
  const source = normalize(readFileSync('scripts/protocol/defillama-volume.ts', 'utf8'));
  const body = (text: string) => {
    const start = text.indexOf('function settledVolume(');
    assert.ok(start >= 0, 'settledVolume present');
    const end = text.indexOf('\n}\n', start);
    return text.slice(start, end + 2);
  };
  assert.equal(body(doc), body(source));
});
