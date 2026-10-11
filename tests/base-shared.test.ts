import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANVIL,
  BASE_MAINNET,
  BASE_SEPOLIA,
  NATIVE_ETH,
  allowedToken,
  baseNetwork,
} from '../shared/base/chains.js';
import { amountFromJson, amountToJson } from '../shared/base/types.js';

test('Base Sepolia and the local fork are allowed; mainnet only behind the gate', () => {
  assert.equal(baseNetwork(BASE_SEPOLIA)?.name, 'Base Sepolia');
  assert.equal(baseNetwork(ANVIL)?.chainId, ANVIL);
  assert.equal(baseNetwork(BASE_MAINNET), null);
  assert.equal(baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })?.chainId, BASE_MAINNET);
  assert.equal(baseNetwork(1), null);
});

test('only allowlisted tokens are accepted, case-insensitively', () => {
  const sepolia = baseNetwork(BASE_SEPOLIA)!;
  assert.equal(allowedToken(sepolia, sepolia.tokens.USDC.address.toLowerCase())?.symbol, 'USDC');
  assert.equal(allowedToken(sepolia, NATIVE_ETH)?.symbol, 'ETH');
  assert.equal(allowedToken(sepolia, '0x0000000000000000000000000000000000000001'), null);
});

test('amounts are integer base units, strictly parsed', () => {
  assert.equal(amountToJson(1_000_000n), '1000000');
  assert.equal(amountFromJson('1000000'), 1_000_000n);
  for (const bad of ['-1', '1.5', '01', '', '1e6', 5, null])
    assert.throws(() => amountFromJson(bad));
});
