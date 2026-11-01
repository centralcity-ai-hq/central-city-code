import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_MAINNET, BASE_NETWORKS, baseNetwork } from '../shared/base/chains.js';
import {
  ARC_MAINNET,
  ARC_NETWORKS,
  ARC_TESTNET,
  ARC_USDC,
  arcNetwork,
  chainFamily,
  chainView,
  gasAssetOf,
  isRealMoneyChain,
  sanctionsOracleChainId,
  usdcOf,
  usdcRawFromNativeWei,
} from '../shared/chains.js';
import { reservedPayees } from '../shared/protocol.js';
import { protocolReservedPayees } from '../server/protocol/fees/cron.js';

test('Arc is off unless CITY_ARC=1, and is never a Base network', () => {
  assert.equal(arcNetwork(ARC_MAINNET), null);
  assert.equal(arcNetwork(ARC_MAINNET, { CITY_ARC: '0' }), null);
  assert.equal(arcNetwork(ARC_MAINNET, { CITY_ARC: '1' })?.name, 'Arc');
  assert.equal(arcNetwork(ARC_TESTNET, { CITY_ARC: '1' })?.name, 'Arc Testnet');
  assert.equal(arcNetwork(BASE_MAINNET, { CITY_ARC: '1' }), null);
  assert.equal(baseNetwork(ARC_MAINNET, { CITY_BASE_MAINNET: '1' }), null);
});

test('chains are told apart; gas is ETH on Base and USDC on Arc', () => {
  assert.equal(chainFamily(BASE_MAINNET), 'base');
  assert.equal(chainFamily(ARC_MAINNET), 'arc');
  assert.equal(chainFamily(1), null);
  assert.equal(gasAssetOf(BASE_MAINNET)?.symbol, 'ETH');
  assert.equal(gasAssetOf(ARC_MAINNET)?.symbol, 'USDC');
  assert.equal(gasAssetOf(1), null);
});

test('one USDC on Arc: 18 native decimals over 6 ERC-20 decimals, rounded down', () => {
  assert.equal(usdcRawFromNativeWei(1_000_000_000_000_000_000n), 1_000_000n);
  assert.equal(usdcRawFromNativeWei(999_999_999_999n), 0n);
  assert.equal(ARC_NETWORKS[ARC_MAINNET].usdc.decimals, 6);
});

test('USDC signs under a different name on Arc than on Base mainnet', () => {
  assert.equal(ARC_NETWORKS[ARC_MAINNET].usdc.eip712.name, 'USDC');
  assert.equal(BASE_NETWORKS[BASE_MAINNET].tokens.USDC.eip712?.name, 'USD Coin');
});

test('Arc reads sanctions on Base mainnet; other chains read their own', () => {
  assert.equal(sanctionsOracleChainId(ARC_MAINNET), BASE_MAINNET);
  assert.equal(sanctionsOracleChainId(ARC_TESTNET), BASE_MAINNET);
  assert.equal(sanctionsOracleChainId(BASE_MAINNET), BASE_MAINNET);
});

test('a chain as shown: slug, explorer, finality, gas', () => {
  const arc = chainView(ARC_MAINNET)!;
  assert.deepEqual(
    [arc.slug, arc.explorerUrl, arc.finality, arc.gasAsset.symbol],
    ['arc', 'https://explorer.arc.io', 'instant', 'USDC'],
  );
  const base = chainView(BASE_MAINNET)!;
  assert.deepEqual(
    [base.slug, base.explorerUrl, base.finality, base.gasAsset.symbol],
    ['base', 'https://basescan.org', 'finalized-tag', 'ETH'],
  );
  assert.equal(chainView(1), null);
});

test('RPC count keys: Base unchanged, Arc prefixed', async () => {
  const { chainCountKey } = await import('../server/base/chain/rpc-count.js');
  assert.equal(chainCountKey(8453, 'feed-pay:bundler'), 'feed-pay:bundler');
  assert.equal(chainCountKey(84532, 'fees:configured'), 'fees:configured');
  assert.equal(chainCountKey(5042, 'feed-pay:bundler'), 'arc:feed-pay:bundler');
  assert.equal(chainCountKey(5042002, 'fees:configured'), 'arc:fees:configured');
});

test('real money: both mainnets, never a testnet or fork', () => {
  for (const chain of [BASE_MAINNET, ARC_MAINNET]) assert.equal(isRealMoneyChain(chain), true);
  for (const chain of [84532, 31337, ARC_TESTNET, 1]) assert.equal(isRealMoneyChain(chain), false);
});

test('USDC per chain: each chain has its own signing name, and nothing else has USDC', () => {
  assert.deepEqual(usdcOf(BASE_MAINNET)?.eip712, { name: 'USD Coin', version: '2' });
  assert.deepEqual(usdcOf(ARC_MAINNET)?.eip712, { name: 'USDC', version: '2' });
  assert.deepEqual(usdcOf(ARC_TESTNET)?.eip712, { name: 'USDC', version: '2' });
  assert.equal(usdcOf(ARC_MAINNET)?.address, ARC_USDC);
  assert.equal(usdcOf(1), null);
});

test('no payment may name Arc USDC or an Arc contract, on either Arc chain', () => {
  const reserved = reservedPayees();
  for (const arc of Object.values(ARC_NETWORKS)) {
    assert.ok(reserved.has(arc.usdc.address.toLowerCase()));
    for (const contract of Object.values(arc.contracts)) {
      if (contract) assert.ok(reserved.has(contract.toLowerCase()), contract);
    }
  }
});

test('a router set for Arc may not be paid as a seller', () => {
  const router = '0x00000000000000000000000000000000000a4c03';
  assert.ok(!protocolReservedPayees({}).has(router));
  assert.ok(protocolReservedPayees({ CITY_ARC_FEE_ROUTER3: router }).has(router));
});

test("no payment may name Arc mainnet's own paymaster, pinned or not checksummed", () => {
  const reserved = reservedPayees();
  assert.ok(reserved.has('0x271bfb75ca5741875f1c69bf478252133896fada'));
});
