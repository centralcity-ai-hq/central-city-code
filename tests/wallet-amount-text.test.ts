import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ethAmountText,
  usdcAmountText,
  usdcValueText,
  type WalletView,
} from '../src/base/wallet/api.js';
import { walletRowValue } from '../src/base/wallet/useWalletRow.js';

/** USDC amounts a person reads are exact: sub-cent service payments never round to cents. */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('usdcAmountText is exact to the base unit, with at least two decimals', () => {
  assert.equal(usdcAmountText({ raw: '7700', decimals: 6 }), '0.0077');
  assert.equal(usdcAmountText({ raw: '4000', decimals: 6 }), '0.004');
  assert.equal(usdcAmountText({ raw: '1', decimals: 6 }), '0.000001');
  assert.equal(usdcAmountText({ raw: '20000000', decimals: 6 }), '20.00');
  assert.equal(usdcAmountText({ raw: '0', decimals: 6 }), '0.00');
  assert.equal(usdcAmountText({ raw: '10005000', decimals: 6 }), '10.005');
});

test('usdcValueText shows a computed balance to six decimals, not cents', () => {
  assert.equal(usdcValueText(0.0077), '0.0077');
  assert.equal(usdcValueText(1.1 + 0.2), '1.30');
  assert.equal(usdcValueText(0), '0.00');
});

test('the agent pane Wallet row shows a sub-cent balance exactly', () => {
  const wallet = { usdc: { raw: '4000', decimals: 6 } } as unknown as WalletView;
  assert.equal(walletRowValue({ kind: 'wallet', wallet }), '0.004 USDC');
});

test('the Wallet screen formats balance, scrub label and transfer rows from base units', () => {
  const screen = read('src/agents/v4/WalletScreen.tsx');
  assert.doesNotMatch(screen, /Math\.round\([^)]*\* 100\) \/ 100/, 'no rounding to cents');
  assert.match(screen, /const current = usdcAmountText\(wallet\.usdc\);/);
  assert.match(screen, /text: usdcAmountText\(transfer\.amount\)/);
  assert.match(screen, /\{usdcAmountText\(transfer\.amount\)\}/);
  assert.match(screen, /usdcValueText\(scrub\.balance\)/);
});

test('ethAmountText never leaves a trailing dot on whole or near-whole amounts', () => {
  assert.equal(ethAmountText('1'), '1');
  assert.equal(ethAmountText('0.99999'), '1');
  assert.equal(ethAmountText('2.5'), '2.5');
  assert.equal(ethAmountText('0.0012'), '0.0012');
  assert.equal(ethAmountText('10.10'), '10.1');
  assert.equal(ethAmountText('0'), '0');
  assert.equal(ethAmountText('0.00001'), '<0.0001');
});
