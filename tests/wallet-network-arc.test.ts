import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.js';
import {
  isArcNetwork,
  NOT_ON_ARC_YET,
  notOnArcYet,
  walletNetwork,
} from '../src/base/wallet/api.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';

/** Which networks a wallet screen names (Operation Arc: Arc next to Base). */

test('walletNetwork: the Base network of this build exactly as before', () => {
  const base =
    WALLET_CHAIN_ID === 8453
      ? { chainId: 8453, network: 'Base', testnet: false }
      : { chainId: 84532, network: 'Base Sepolia', testnet: true };
  assert.deepEqual(walletNetwork(base), base);
  assert.equal(isArcNetwork(walletNetwork(base)!), false);
  // The other Base network, or a wrong name or test flag, stays refused.
  const other =
    WALLET_CHAIN_ID === 8453
      ? { chainId: 84532, network: 'Base Sepolia', testnet: true }
      : { chainId: 8453, network: 'Base', testnet: false };
  assert.equal(walletNetwork(other), null);
  assert.equal(walletNetwork({ ...base, testnet: !base.testnet }), null);
  assert.equal(walletNetwork({ ...base, network: 'Ethereum' }), null);
});

test('walletNetwork: Arc and Arc Testnet, gas in USDC, links to the Arc explorers', () => {
  assert.deepEqual(
    walletNetwork({ chainId: 5042, network: 'Arc', testnet: false, gasAsset: 'USDC' }),
    {
      chainId: 5042,
      network: 'Arc',
      testnet: false,
      arc: true,
      gasAsset: 'USDC',
      explorerUrl: 'https://explorer.arc.io',
    },
  );
  const testnet = walletNetwork({
    chainId: 5042002,
    network: 'Arc Testnet',
    testnet: true,
    gasAsset: 'USDC',
  });
  assert.ok(testnet && isArcNetwork(testnet));
  assert.equal(testnet.network, 'Arc Testnet');
  assert.equal(testnet.explorerUrl, 'https://explorer.testnet.arc.io');
});

test('walletNetwork: Arc with ETH gas, a wrong flag or name, or an unknown chain is refused', () => {
  assert.equal(walletNetwork({ chainId: 5042, network: 'Arc', testnet: false }), null);
  assert.equal(
    walletNetwork({ chainId: 5042, network: 'Arc', testnet: false, gasAsset: 'ETH' }),
    null,
  );
  assert.equal(
    walletNetwork({ chainId: 5042, network: 'Arc', testnet: true, gasAsset: 'USDC' }),
    null,
  );
  assert.equal(
    walletNetwork({ chainId: 5042, network: 'Base', testnet: false, gasAsset: 'USDC' }),
    null,
  );
  assert.equal(walletNetwork({ chainId: 1, network: 'Ethereum', testnet: false }), null);
  assert.equal(
    walletNetwork({ chainId: 10, network: 'Arc', testnet: false, gasAsset: 'USDC' }),
    null,
  );
});

test('notOnArcYet: only a 409 with code not_on_arc_yet', () => {
  assert.equal(NOT_ON_ARC_YET, 'Not available on Arc yet.');
  assert.equal(notOnArcYet(new ApiError('x', 409, 'not_on_arc_yet')), true);
  assert.equal(notOnArcYet(new ApiError('x', 409, 'operation_pending')), false);
  assert.equal(notOnArcYet(new ApiError('x', 400, 'not_on_arc_yet')), false);
  assert.equal(notOnArcYet(new Error('not_on_arc_yet')), false);
});
