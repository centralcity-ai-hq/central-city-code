import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_MAINNET } from '../shared/base/chains.js';
import { ARC_MAINNET, ARC_NETWORKS, ARC_TESTNET, chainNetwork } from '../shared/chains.js';
import { arcRuntimeEnv, bothUpkeeps, paymasterSide } from '../server/base/chain/arc-env.js';
import { ownPaymasterMode } from '../server/base/chain/own-paymaster-keys.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import { allowedToken, NATIVE_ETH } from '../shared/base/chains.js';

const FACTORY = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a';
const SPM = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const TESTNET_ON = { CITY_ARC: '1' };

test('Arc is no network at all unless CITY_ARC=1', () => {
  assert.equal(chainNetwork(ARC_TESTNET, {}), null);
  assert.equal(chainNetwork(ARC_TESTNET, { ...TESTNET_ON, CITY_ARC: undefined }), null);
});

test('Base goes on answering with its own network, untouched', () => {
  assert.equal(chainNetwork(BASE_MAINNET, {}), null);
  const base = chainNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
  assert.equal(base.chainId, BASE_MAINNET);
  assert.ok(base.tokens.ETH);
});

test('testnet: the contracts replayed there, at their Base addresses', () => {
  const arc = chainNetwork(ARC_TESTNET, TESTNET_ON)!;
  assert.equal(arc.contracts.smartWalletFactory, FACTORY);
  assert.equal(arc.contracts.spendPermissionManager, SPM);
  assert.equal(arc.tokens.USDC.address, ARC_NETWORKS[ARC_TESTNET].usdc.address);
  assert.deepEqual(arc.tokens.USDC.eip712, { name: 'USDC', version: '2' });
  assert.equal(arc.bundlerEnv, 'CITY_ARC_RPC_URL');
});

test('mainnet: off while Arc is off; on, the code names its SpendPermissionManager, never a setting', () => {
  const setting = { CITY_ARC_SPEND_PERMISSION_MANAGER: '0x00000000000000000000000000000000000000f2' };
  assert.equal(chainNetwork(ARC_MAINNET, {}), null);
  assert.equal(chainNetwork(ARC_MAINNET, setting), null);
  const arc = chainNetwork(ARC_MAINNET, { CITY_ARC: '1', ...setting })!;
  assert.equal(arc.chainId, ARC_MAINNET);
  // Recorded in shared/chains.ts after the owner's deploy, read back on chain 31 Oct 2026.
  assert.equal(arc.contracts.spendPermissionManager, SPM);
  assert.equal(arc.contracts.smartWalletFactory, FACTORY);
  assert.equal(arc.tokens.USDC.address, ARC_NETWORKS[ARC_MAINNET].usdc.address);
});

test('Arc has no second native token: a permission or payment cannot name native gas', () => {
  const arc = chainNetwork(ARC_TESTNET, TESTNET_ON)!;
  assert.equal(arc.tokens.ETH, undefined);
  assert.equal(allowedToken(arc, NATIVE_ETH), null);
  assert.ok(allowedToken(arc, arc.tokens.USDC.address));
});

test('no setting of Base reaches a runtime on Arc, except what is shared on purpose', () => {
  const scoped = arcRuntimeEnv({
    CITY_BASE_CDP_RPC_URL: 'https://base.invalid/key',
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '500000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '1',
    CITY_BASE_READ_FALLBACK_RPC_URL: 'https://base.invalid/read',
    CITY_BASE_PAYMASTER_ADDRESS: '0x00000000000000000000000000000000000000b1',
    CITY_BASE_OWN_PAYMASTER: 'on',
    CITY_BASE_BUNDLER: 'cdp',
    CITY_FEED_PAY_CDP_RPC_URL: 'https://base.invalid/feed',
    CITY_PROTOCOL_FEE_ROUTER3: '0x00000000000000000000000000000000000000b3',
    CITY_PROTOCOL_TREASURY: '0x00000000000000000000000000000000000000b4',
    CITY_X402_FACILITATOR_KEY_REF: 'base-facilitator',
    CITY_X402_PUBLIC_SETTLE_KEY_REF: 'base-public',
    CITY_SFP_SPONSOR_KEY_REF: 'base-sponsor',
    CITY_BASE_SPENDER_KEK: 'shared-kek',
    CITY_BASE_SUBMITTER_KEY_REFS: 'base-submitter',
    CITY_BASE_PAYMASTER_SIGNER_KEY_REF: 'base-signer',
    CITY_ARC_SUBMITTER_KEY_REFS: 'arc-submitter',
    CITY_ARC_RPC_URL: 'https://arc.invalid',
    CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
    CITY_ARC_PAYMASTER: '0x00000000000000000000000000000000000000a1',
    CITY_ARC_OWN_PAYMASTER: 'on',
    CITY_ARC_FEE_ROUTER3: '0x00000000000000000000000000000000000000a3',
    CITY_ARC_FACILITATOR_KEY_REF: 'arc-facilitator',
  });
  for (const gone of [
    'CITY_BASE_CDP_RPC_URL',
    'CITY_BASE_MAX_FEE_PER_GAS_WEI',
    'CITY_BASE_IDENTITY_FEE_CAP_WEI',
    'CITY_BASE_READ_FALLBACK_RPC_URL',
    'CITY_FEED_PAY_CDP_RPC_URL',
    'CITY_PROTOCOL_TREASURY',
    'CITY_X402_PUBLIC_SETTLE_KEY_REF',
    'CITY_SFP_SPONSOR_KEY_REF',
  ]) {
    assert.equal(scoped[gone], undefined, gone);
  }
  assert.equal(scoped.CITY_BASE_SPENDER_KEK, 'shared-kek');
  assert.equal(scoped.CITY_BASE_SUBMITTER_KEY_REFS, 'arc-submitter');
  // Arc's own keys only: optional, and Base's never stand in for them.
  assert.equal(scoped.CITY_BASE_PAYMASTER_SIGNER_KEY_REF, undefined);
  assert.equal(scoped.CITY_BASE_BUNDLER, 'direct');
  assert.equal(scoped.CITY_BASE_OWN_PAYMASTER, 'on');
  assert.equal(scoped.CITY_BASE_PAYMASTER_ADDRESS, '0x00000000000000000000000000000000000000a1');
  assert.equal(scoped.CITY_PROTOCOL_FEE_ROUTER3, '0x00000000000000000000000000000000000000a3');
  assert.equal(scoped.CITY_X402_FACILITATOR_KEY_REF, 'arc-facilitator');
  assert.equal(scoped.CITY_ARC_RPC_URL, 'https://arc.invalid');
});

test('a runtime on Arc refuses to start while Arc is off or incomplete', () => {
  const db = {} as never;
  assert.throws(() => createChainRuntime({ db, env: {}, chainId: ARC_TESTNET }), /network/);
  assert.throws(() => createChainRuntime({ db, env: {}, chainId: ARC_MAINNET }), /network/);
  assert.throws(() => createChainRuntime({ db, env: {}, chainId: 1 as never }), /network/);
  // Mainnet on, but incomplete: still no runtime.
  assert.throws(
    () => createChainRuntime({ db, env: { CITY_ARC: '1' }, chainId: ARC_MAINNET }),
    /CITY_ARC_RPC_URL/,
  );
  // Complete, but no endpoint of its own: Base's is not used instead.
  assert.throws(
    () =>
      createChainRuntime({
        db,
        env: { ...TESTNET_ON, CITY_BASE_CDP_RPC_URL: 'https://base.invalid/key' },
        chainId: ARC_TESTNET,
      }),
    /CITY_ARC_RPC_URL/,
  );
});

const KEK = `v1:${Buffer.alloc(32, 7).toString('base64')}`;
const COMPLETE = {
  ...TESTNET_ON,
  CITY_ARC_RPC_URL: 'https://arc.invalid/rpc',
  CITY_BASE_SPENDER_KEK: KEK,
  CITY_ARC_MAX_FEE_PER_GAS_WEI: '100000000000',
};

test('a runtime on Arc never runs on a CDP bundler: no paymaster of its own, no runtime', () => {
  const db = {} as never;
  assert.throws(
    () => createChainRuntime({ db, env: COMPLETE, chainId: ARC_TESTNET }),
    /CITY_ARC_PAYMASTER/,
  );
  // Base's paymaster and bundler settings don't count on Arc.
  assert.throws(
    () =>
      createChainRuntime({
        db,
        env: {
          ...COMPLETE,
          CITY_BASE_BUNDLER: 'direct',
          CITY_BASE_OWN_PAYMASTER: 'on',
          CITY_BASE_PAYMASTER_ADDRESS: '0x00000000000000000000000000000000000000b1',
        },
        chainId: ARC_TESTNET,
      }),
    /CITY_ARC_PAYMASTER/,
  );
});

test('with its own settings, a runtime on Arc builds', () => {
  const runtime = createChainRuntime({
    db: {} as never,
    env: {
      ...COMPLETE,
      CITY_ARC_OWN_PAYMASTER: 'on',
      CITY_ARC_PAYMASTER: '0x00000000000000000000000000000000000000a1',
    },
    chainId: ARC_TESTNET,
  });
  assert.ok(runtime.identityPort);
});

test('paymasterSide: Base unless a server runs Arc alone', () => {
  assert.equal(paymasterSide({}).chainId, BASE_MAINNET);
  assert.equal(paymasterSide({ CITY_BASE_OWN_PAYMASTER: 'on' }).chainId, BASE_MAINNET);
  // Arc on next to Base's paymaster: Base's answer, its settings untouched.
  const both = {
    CITY_BASE_OWN_PAYMASTER: 'on',
    CITY_ARC: '1',
    CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
  };
  assert.equal(paymasterSide(both).chainId, BASE_MAINNET);
  assert.equal(paymasterSide(both).env, both);
  // Arc alone: Arc's mode reaches the provisioning, under Base's name.
  const alone = paymasterSide({
    CITY_ARC: '1',
    CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
    CITY_ARC_OWN_PAYMASTER: 'prepare',
  });
  assert.equal(alone.chainId, ARC_TESTNET);
  assert.equal(ownPaymasterMode(alone.env), 'prepare');
});

test('bothUpkeeps: each chain runs whatever the other does, and a failure still shows', async () => {
  const upkeep = (maintain: () => Promise<number>) => ({
    mode: 'direct' as const,
    maintain,
    open: async () => 1,
  });
  const ok = upkeep(async () => 2);
  const ran: string[] = [];
  const failing = upkeep(async () => {
    ran.push('failed');
    throw new Error('down');
  });
  const other = upkeep(async () => {
    ran.push('ran');
    return 3;
  });
  assert.equal(bothUpkeeps(undefined, undefined), undefined);
  assert.equal(bothUpkeeps(ok, undefined), ok);
  assert.equal(bothUpkeeps(undefined, ok), ok);
  assert.equal(await bothUpkeeps(ok, other)!.maintain(), 5);
  assert.equal(await bothUpkeeps(ok, other)!.open(), 2);
  await assert.rejects(bothUpkeeps(failing, other)!.maintain(), /down/);
  assert.ok(ran.includes('ran'));
});

test('a bundler that cannot be built on Arc refuses: nothing falls back to a CDP there', async () => {
  const runtime = createChainRuntime({
    db: {
      query: async () => {
        throw new Error('no keys');
      },
    } as never,
    env: {
      ...COMPLETE,
      CITY_ARC_OWN_PAYMASTER: 'on',
      CITY_ARC_PAYMASTER: '0x00000000000000000000000000000000000000a1',
    },
    chainId: ARC_TESTNET,
    log: () => {},
  });
  await assert.rejects(runtime.arcOwnerBundler!.prepare({} as never), /not available now/);
  assert.notEqual(await runtime.ownBundlerEffective?.(), 'cdp_fallback');
});
