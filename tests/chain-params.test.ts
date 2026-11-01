/*
 * Per-chain send parameters (server/base/chain/chain-params.ts). Base's numbers are written out here
 * as the literal values the send paths had before they moved, so a change to any of them fails. Arc:
 * its fee floor, no L1 fee oracle, and its gas asset (USDC at 18 decimals), where a 10^12 mistake
 * between its two views of one balance must fail too. Fakes only; nothing here turns Arc on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  http,
  keccak256,
  parseTransaction,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { UserOperation } from 'viem/account-abstraction';
import type { Database } from '../server/database.js';
import { ANVIL, BASE_MAINNET, BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import {
  ARC_MAINNET,
  ARC_NATIVE_PER_USDC_RAW,
  ARC_TESTNET,
  arcNetwork,
  usdcRawFromNativeWei,
} from '../shared/chains.js';
import {
  assertFeeFloor,
  chainParams,
  FeeFloorError,
  PRIOR_ORDINARY_FEES_WEI,
} from '../server/base/chain/chain-params.js';
import {
  createHotWalletWatch,
  DEFAULT_HOT_WALLET_CEILINGS,
  hotWalletCeilingsFromEnv,
} from '../server/base/chain/hot-wallets.js';
import {
  BUDGET_LIMITS,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';
import { GAS_CEILINGS, type GasCeilings } from '../server/base/chain/own-paymaster-policy.js';
import { baseReadUrls, FALLBACK_QUOTE_CEILING_WEI } from '../server/base/chain/read-transport.js';
import {
  ChainRuntimeError,
  identityFeeCapFromEnv,
  maxFeePerGasCapFromEnv,
  WALLET_FEE_CAP_SETTING,
  walletFeeCap,
} from '../server/base/chain/runtime.js';
import {
  DIRECT_BUNDLER_FINALITY_SQL,
  DIRECT_BUNDLER_SQL,
  directBundler,
  SUBMITTER_RESERVE_WEI,
} from '../server/base/chain/direct-bundler.js';
import { rpcBundler } from '../server/base/chain/rpc-bundler.js';
import {
  SFP_SENDER_MIN_ETH_DEFAULT,
  SFP_SENDER_MIN_ETH_SETTING,
  sponsoredSenderMinEthWei,
} from '../server/feed/pay/sponsored.js';
import {
  createRouter3Facilitator,
  DEFAULT_MIN_BALANCE_WEI,
  FEE_CAPS,
  GAS_FEE_ALERT_BPS,
} from '../server/protocol/x402/facilitator.js';
import {
  X402_FACILITATOR_BATCH_SQL,
  X402_FACILITATOR_SQL,
} from '../server/protocol/x402/facilitator-schema.js';
import { FakeBase, INTENT, ROUTER, settlement } from './helpers/x402-fake-base.js';

const GWEI = 1_000_000_000n;
const USDC_GAS = 10n ** 18n;
const FLOOR = 20n * GWEI;

test('every Base parameter is exactly the literal value it had before it moved', () => {
  const base = chainParams(BASE_MAINNET);
  assert.deepEqual(base.nativeCurrency, { name: 'Ether', symbol: 'ETH', decimals: 18 });
  assert.equal(base.gasLabel, 'eth');
  assert.equal(base.minMaxFeePerGasWei, 0n);
  assert.equal(base.l1FeeOracle, true);
  assert.equal(base.feeBudgetRequired, true);
  assert.deepEqual(base.settings, {
    maxFeePerGas: 'CITY_BASE_MAX_FEE_PER_GAS_WEI',
    identityFeeCap: 'CITY_BASE_IDENTITY_FEE_CAP_WEI',
    walletFeeCap: 'CITY_BASE_WALLET_FEE_CAP_WEI',
    sponsoredSenderMin: 'CITY_SFP_SENDER_MIN_ETH_WEI',
    hotWalletPrefix: 'CITY_HOT',
    hotWalletGasAsset: 'ETH',
  });
  assert.equal(base.fallbackQuoteCeilingWei, 1_000_000_000n);
  assert.equal(base.publicReadRpc, 'https://mainnet.base.org');
  assert.deepEqual(base.facilitator, {
    minBalanceWei: 500_000_000_000_000n,
    caps: {
      maxFeePerGasWei: 500_000_000n,
      maxPriorityFeePerGasWei: 50_000_000n,
      maxGasLimit: 400_000n,
      maxReplacements: 3,
      reserveWei: 200_000_000_000_000n,
    },
  });
  assert.deepEqual(base.gasCeilings, {
    callGasLimit: 1_500_000n,
    verificationGasLimit: 300_000n,
    verificationGasLimitWithInit: 700_000n,
    preVerificationGas: 200_000n,
    maxFeePerGas: 500_000_000n,
    maxPriorityFeePerGas: 50_000_000n,
  });
  assert.equal(base.submitterReserveWei, 100_000_000_000_000n);
  assert.equal(PRIOR_ORDINARY_FEES_WEI, 20_773_789_406_452n);
  assert.deepEqual(base.budget, {
    ordinaryCeilingWei: 929_979_226_210_593_548n,
    hourlyOrdinaryWei: 100_000_000_000_000_000n,
    protectedWei: 50_000_000_000_000_000n,
    hourlyExitWei: 20_000_000_000_000_000n,
    dailyExitWei: 50_000_000_000_000_000n,
    handoutShareBps: 3_000,
    accountHourlyOrdinaryWei: 10_000_000_000_000_000n,
    senderHourlyOrdinaryWei: 5_000_000_000_000_000n,
    accountHourlyExitWei: 5_000_000_000_000_000n,
    senderHourlyExitWei: 2_500_000_000_000_000n,
    accountDailyExitWei: 5_000_000_000_000_000n,
    freeDailyExitsPerAccount: 3,
    unsignedOpenPerAccount: 10,
    unsignedOpenExitPerAccount: 2,
  });
  assert.deepEqual(base.hotWallets, {
    sfp_sponsor: {
      usdc: { ceiling: 500_000_000n, outflowPerHour: 100_000_000n },
      eth: { ceiling: 50_000_000_000_000_000n, outflowPerHour: 5_000_000_000_000_000n },
    },
    router3_facilitator: {
      eth: { ceiling: 50_000_000_000_000_000n, outflowPerHour: 5_000_000_000_000_000n },
    },
    public_settle: {
      eth: { ceiling: 50_000_000_000_000_000n, outflowPerHour: 5_000_000_000_000_000n },
    },
    public_offer: {
      eth: { ceiling: 100_000_000_000_000_000n, outflowPerHour: 5_000_000_000_000_000n },
    },
    paymaster_submitter: {
      eth: { ceiling: 100_000_000_000_000_000n, outflowPerHour: 10_000_000_000_000_000n },
    },
    paymaster_signer: { eth: { ceiling: 0n, outflowPerHour: 0n } },
  });
  assert.deepEqual(base.sponsoredSenderMinWei, {
    fallback: 20_000_000_000_000_000n,
    min: 1_000_000_000_000_000n,
    max: 1_000_000_000_000_000_000n,
  });
  assert.equal(base.usdcPerNative, null);
});

test('the old exports still read Base, at the same values', () => {
  const base = chainParams(BASE_MAINNET);
  assert.deepEqual(FEE_CAPS, base.facilitator.caps);
  assert.equal(DEFAULT_MIN_BALANCE_WEI, 500_000_000_000_000n);
  assert.deepEqual(GAS_CEILINGS, base.gasCeilings);
  assert.deepEqual(BUDGET_LIMITS, base.budget);
  assert.deepEqual(DEFAULT_HOT_WALLET_CEILINGS, base.hotWallets);
  assert.equal(SUBMITTER_RESERVE_WEI, 100_000_000_000_000n);
  assert.equal(FALLBACK_QUOTE_CEILING_WEI, 1_000_000_000n);
  assert.equal(WALLET_FEE_CAP_SETTING, 'CITY_BASE_WALLET_FEE_CAP_WEI');
  assert.equal(SFP_SENDER_MIN_ETH_SETTING, 'CITY_SFP_SENDER_MIN_ETH_WEI');
  assert.equal(SFP_SENDER_MIN_ETH_DEFAULT, 20_000_000_000_000_000n);
});

test('Base Sepolia, Anvil and any unlisted chain keep Base numbers, each with its old differences', () => {
  for (const id of [BASE_SEPOLIA, ANVIL, 1]) {
    const params = chainParams(id);
    assert.equal(params.feeBudgetRequired, false);
    assert.deepEqual(params.facilitator, chainParams(BASE_MAINNET).facilitator);
    assert.equal(params.minMaxFeePerGasWei, 0n);
    assert.equal(params.l1FeeOracle, true);
  }
  assert.equal(chainParams(BASE_SEPOLIA).publicReadRpc, 'https://sepolia.base.org');
  assert.equal(chainParams(ANVIL).publicReadRpc, undefined);
  // The same refusals as before on each.
  assert.equal(walletFeeCap({}, BASE_MAINNET), null);
  assert.deepEqual(walletFeeCap({}, BASE_SEPOLIA), { cap: undefined });
  assert.equal(walletFeeCap({ CITY_BASE_WALLET_FEE_CAP_WEI: 'x' }, BASE_SEPOLIA), null);
  assert.throws(() => identityFeeCapFromEnv({}, BASE_MAINNET), ChainRuntimeError);
  assert.equal(identityFeeCapFromEnv({}, BASE_SEPOLIA), undefined);
  // Base has no floor: a cap of 1 wei stays allowed.
  assert.equal(maxFeePerGasCapFromEnv({ CITY_BASE_MAX_FEE_PER_GAS_WEI: '1' }, BASE_MAINNET), 1n);
  assert.throws(() => maxFeePerGasCapFromEnv({}, BASE_MAINNET), ChainRuntimeError);
});

test('asking for Arc parameters enables nothing', () => {
  assert.equal(baseNetwork(ARC_MAINNET as never, {}), null);
  assert.equal(arcNetwork(ARC_MAINNET, {}), null);
});

test("Arc's numbers are USDC at 18 decimals: 10^12 away from raw USDC is a failure", () => {
  // One settle from a smart account (198k gas, measured on testnet) at 25 gwei costs about 0.00495
  // USDC, in both views of the balance.
  const settle = 198_000n * 25n * GWEI;
  assert.equal(settle, 4_950_000_000_000_000n);
  assert.equal(usdcRawFromNativeWei(settle), 4_950n); // 0.00495 USDC in base units
  assert.equal(ARC_NATIVE_PER_USDC_RAW, 10n ** 12n);

  const arc = chainParams(ARC_MAINNET);
  assert.equal(usdcRawFromNativeWei(arc.facilitator.minBalanceWei), 1_000_000n); // 1 USDC
  assert.equal(usdcRawFromNativeWei(arc.facilitator.caps.reserveWei), 100_000n); // 0.1 USDC
  assert.equal(usdcRawFromNativeWei(arc.submitterReserveWei), 50_000n); // 0.05 USDC
  assert.equal(usdcRawFromNativeWei(arc.sponsoredSenderMinWei.fallback), 5_000_000n); // 5 USDC
  assert.equal(usdcRawFromNativeWei(arc.budget.ordinaryCeilingWei), 10_000_000_000n); // 10,000 USDC
  assert.equal(usdcRawFromNativeWei(arc.budget.protectedWei), 10_000_000n); // 10 USDC
  assert.equal(usdcRawFromNativeWei(arc.budget.accountHourlyExitWei), 1_000_000n); // 1 USDC

  // The reserves buy settles, not fractions of one or astronomically many.
  assert.equal(arc.facilitator.minBalanceWei / settle, 202n);
  assert.equal(arc.facilitator.caps.reserveWei / settle, 20n);
  assert.equal(arc.submitterReserveWei / settle, 10n);

  // Base's numbers were never carried over: 0.02 "ETH" is not 0.02 USDC of gas.
  const base = chainParams(BASE_MAINNET);
  assert.notEqual(arc.sponsoredSenderMinWei.fallback, base.sponsoredSenderMinWei.fallback);
  assert.notEqual(arc.facilitator.minBalanceWei, base.facilitator.minBalanceWei);
  assert.notEqual(arc.budget.protectedWei, base.budget.protectedWei);

  // A whole native token is one USDC, for the settlement economics watch.
  assert.equal((settle * arc.usdcPerNative!) / 10n ** 18n, 4_950n);
});

test("Arc's caps sit above its floor, with room for its usual price and replacements", () => {
  for (const id of [ARC_MAINNET, ARC_TESTNET]) {
    const arc = chainParams(id);
    assert.equal(arc.minMaxFeePerGasWei, FLOOR);
    assert.equal(arc.l1FeeOracle, false);
    // 2 x base fee + tip at 25 gwei fits under every cap.
    assert.ok(arc.facilitator.caps.maxFeePerGasWei >= 2n * 25n * GWEI + 10n * GWEI);
    assert.ok(arc.gasCeilings.maxFeePerGas >= 2n * 25n * GWEI + 10n * GWEI);
    assert.ok(arc.fallbackQuoteCeilingWei >= arc.facilitator.caps.maxFeePerGasWei);
    assert.equal(arc.nativeCurrency.symbol, 'USDC');
    assert.ok(!JSON.stringify(arc.settings).includes('BASE'));
    assert.ok(!JSON.stringify(arc.settings).includes('ETH'));
  }
  assert.equal(chainParams(ARC_MAINNET).feeBudgetRequired, true);
  assert.equal(chainParams(ARC_TESTNET).feeBudgetRequired, false);
  assert.equal(chainParams(ARC_MAINNET).publicReadRpc, 'https://rpc.mainnet.arc.io');
  assert.equal(chainParams(ARC_TESTNET).publicReadRpc, 'https://rpc.testnet.arc.io');
});

test('the fee settings do not cross chains, and a cap under the floor is refused', () => {
  const baseSettings = {
    CITY_BASE_MAX_FEE_PER_GAS_WEI: '500000000',
    CITY_BASE_IDENTITY_FEE_CAP_WEI: '1',
    CITY_BASE_WALLET_FEE_CAP_WEI: '1',
  };
  assert.throws(() => maxFeePerGasCapFromEnv(baseSettings, ARC_MAINNET), ChainRuntimeError);
  assert.throws(() => identityFeeCapFromEnv(baseSettings, ARC_MAINNET), ChainRuntimeError);
  assert.equal(walletFeeCap(baseSettings, ARC_MAINNET), null);
  assert.equal(
    maxFeePerGasCapFromEnv({ CITY_ARC_MAX_FEE_PER_GAS_WEI: FLOOR.toString() }, ARC_MAINNET),
    FLOOR,
  );
  assert.throws(
    () =>
      maxFeePerGasCapFromEnv(
        { CITY_ARC_MAX_FEE_PER_GAS_WEI: (FLOOR - 1n).toString() },
        ARC_MAINNET,
      ),
    (e: unknown) => e instanceof ChainRuntimeError && e.setting === 'CITY_ARC_MAX_FEE_PER_GAS_WEI',
  );
  assert.throws(() => assertFeeFloor(chainParams(ARC_MAINNET), FLOOR - 1n, 'x'), FeeFloorError);
  assert.doesNotThrow(() => assertFeeFloor(chainParams(BASE_MAINNET), 0n, 'x'));
});

test('sponsored sender minimum: per chain, in that chain’s asset, other chains’ setting ignored', () => {
  const wei = 3n * USDC_GAS;
  assert.equal(sponsoredSenderMinEthWei({}, ARC_MAINNET), 5n * USDC_GAS);
  assert.equal(
    sponsoredSenderMinEthWei({ CITY_ARC_SFP_SENDER_MIN_GAS_WEI: wei.toString() }, ARC_MAINNET),
    wei,
  );
  // A Base value (0.5 "ETH") never reaches Arc, and an Arc value never reaches Base.
  const baseValue = { CITY_SFP_SENDER_MIN_ETH_WEI: (5n * 10n ** 17n).toString() };
  assert.equal(sponsoredSenderMinEthWei(baseValue, ARC_MAINNET), 5n * USDC_GAS);
  assert.equal(sponsoredSenderMinEthWei(baseValue), 5n * 10n ** 17n);
  assert.equal(
    sponsoredSenderMinEthWei({ CITY_ARC_SFP_SENDER_MIN_GAS_WEI: wei.toString() }),
    SFP_SENDER_MIN_ETH_DEFAULT,
  );
  // Raw USDC (6 decimals) by mistake is out of bounds: the default, never a tiny floor.
  assert.equal(
    sponsoredSenderMinEthWei({ CITY_ARC_SFP_SENDER_MIN_GAS_WEI: '3000000' }, ARC_MAINNET),
    5n * USDC_GAS,
  );
});

test('hot wallets on Arc: limits in native USDC, labels and settings never say ETH', () => {
  const ceilings = hotWalletCeilingsFromEnv(
    {
      CITY_ARC_HOT_CEILING_PUBLIC_SETTLE_GAS: (7n * USDC_GAS).toString(),
      // Base's setting, in wei of ETH, has no say here.
      CITY_HOT_CEILING_ROUTER3_FACILITATOR_ETH: '1',
    },
    ARC_MAINNET,
  );
  assert.equal(ceilings.public_settle.eth!.ceiling, 7n * USDC_GAS);
  assert.equal(ceilings.router3_facilitator.eth!.ceiling, 50n * USDC_GAS);
  // Base is the default, and does not read Arc's settings.
  assert.equal(
    hotWalletCeilingsFromEnv({ CITY_ARC_HOT_CEILING_PUBLIC_SETTLE_GAS: '1' }).public_settle.eth!
      .ceiling,
    10n ** 18n / 20n,
  );
  // The sponsor's USDC and gas are one balance on Arc: one limit in its two units.
  const sponsor = ceilings.sfp_sponsor;
  assert.equal(sponsor.usdc!.ceiling * ARC_NATIVE_PER_USDC_RAW, sponsor.eth!.ceiling);
  assert.equal(sponsor.usdc!.outflowPerHour * ARC_NATIVE_PER_USDC_RAW, sponsor.eth!.outflowPerHour);

  const lines: string[] = [];
  const clock = { at: 1_000_000 };
  const watch = createHotWalletWatch({
    ceilings,
    log: (line) => void lines.push(line),
    now: () => clock.at,
    chainId: ARC_MAINNET,
  });
  // 1 USDC of gas is well under a 50 USDC ceiling; 60 is above it.
  assert.equal(watch.observe('router3_facilitator', 'eth', USDC_GAS).aboveCeiling, false);
  assert.equal(watch.observe('router3_facilitator', 'eth', 60n * USDC_GAS).aboveCeiling, true);
  clock.at += 1_000;
  watch.observe('router3_facilitator', 'eth', 40n * USDC_GAS);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.match(line, /usdc-gas/);
    assert.doesNotMatch(line, /\beth\b/i);
  }

  const baseLines: string[] = [];
  createHotWalletWatch({
    ceilings: hotWalletCeilingsFromEnv({}),
    log: (line) => void baseLines.push(line),
  }).observe('public_settle', 'eth', 10n ** 18n);
  assert.match(baseLines[0]!, /public_settle eth balance/);
});

test("Arc's public RPC is the second read endpoint when hosted; Base's is unchanged", () => {
  const primary = 'https://example.invalid/rpc';
  assert.deepEqual(baseReadUrls(primary, {}, ARC_MAINNET, { hosted: true }), [
    primary,
    'https://rpc.mainnet.arc.io',
  ]);
  assert.deepEqual(baseReadUrls(primary, {}, BASE_MAINNET, { hosted: true }), [
    primary,
    'https://mainnet.base.org',
  ]);
  assert.deepEqual(baseReadUrls(primary, {}, ANVIL, { hosted: true }), [primary]);
});

async function facilitatorOn(
  t: { after: (fn: () => Promise<unknown>) => void },
  chainId: number,
  options: {
    caps?: { maxFeePerGasWei: bigint };
    usdcPerEth?: bigint;
    log?: (line: string) => void;
  } = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(X402_FACILITATOR_BATCH_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const account = privateKeyToAccount(generatePrivateKey());
  const chain = new FakeBase();
  chain.balance = 100n * USDC_GAS;
  chain.baseFee = 25n * GWEI;
  chain.priority = GWEI;
  const facilitator = createRouter3Facilitator({
    db,
    client: chain.client as PublicClient,
    keystore: { withSigner: async (_ref, use) => use(account) },
    keyRef: `v1:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
    router: ROUTER,
    chainId,
    log: () => {},
    ...options,
  });
  return { chain, facilitator };
}

const submit = (facilitator: ReturnType<typeof createRouter3Facilitator>) =>
  facilitator.submit({
    key: 'k1',
    intentHash: INTENT,
    settlement: settlement(),
    beforeBroadcast: async () => {},
  });

test('the settlement gas alert: Base at half the fee, Arc only when gas passes the fee', async (t) => {
  assert.equal(chainParams(BASE_MAINNET).settleGasAlertBps, 5_000n);
  assert.equal(GAS_FEE_ALERT_BPS, 5_000n);
  assert.equal(chainParams(ARC_MAINNET).settleGasAlertBps, 10_000n);
  assert.equal(chainParams(ARC_TESTNET).settleGasAlertBps, 10_000n);

  // Measured on Arc testnet at 25 gwei against the 0.005 USDC fee of a 0.05 USDC price.
  const run = async (chainId: number, gasUsed: bigint) => {
    const lines: string[] = [];
    const { chain, facilitator } = await facilitatorOn(t, chainId, {
      usdcPerEth: chainParams(ARC_TESTNET).usdcPerNative!,
      log: (line) => lines.push(line),
    });
    const op = await facilitator.submit({
      key: 'k1',
      intentHash: INTENT,
      settlement: settlement(50_000n),
      beforeBroadcast: async () => {},
    });
    chain.mine(op.txHash!, 60n, 'success', { gasUsed, effectiveGasPrice: 25n * GWEI });
    await facilitator.status('k1');
    assert.ok(
      lines.some((line) => line.includes('economics k1')),
      lines.join('\n'),
    );
    return lines.filter((line) => line.includes('ALERT'));
  };
  assert.deepEqual(await run(ARC_TESTNET, 197_818n), []);
  assert.deepEqual(await run(ARC_TESTNET, 222_818n), [
    'x402 facilitator: ALERT k1 gas 5570 above 100% of fee 5000 (USDC units)',
  ]);
  // The same settle against Base's threshold.
  assert.deepEqual(await run(BASE_MAINNET, 197_818n), [
    'x402 facilitator: ALERT k1 gas 4945 above 50% of fee 5000 (USDC units)',
  ]);
});

test('facilitator on Arc: never asks the L1 oracle, and spends at Arc prices', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, ARC_MAINNET);
  const op = await submit(facilitator);
  assert.equal(op.status, 'submitted');
  assert.equal(chain.l1Asked.length, 0);
  const tx = parseTransaction(chain.sends[0] as Hex);
  assert.equal(tx.chainId, ARC_MAINNET);
  assert.equal(tx.maxFeePerGas, 51n * GWEI);
});

test('facilitator on Arc: a low quote is signed at the floor, never below', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, ARC_MAINNET);
  chain.baseFee = 1n * GWEI;
  chain.priority = GWEI;
  await submit(facilitator);
  assert.equal(parseTransaction(chain.sends[0] as Hex).maxFeePerGas, FLOOR);
});

test('facilitator on Arc: a quote above the cap clamps to the cap, which is above the floor', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, ARC_MAINNET);
  chain.baseFee = 500n * GWEI;
  await submit(facilitator);
  assert.equal(parseTransaction(chain.sends[0] as Hex).maxFeePerGas, 100n * GWEI);
});

test('facilitator on Arc: a cap that would clamp under the floor fails loudly at once', async (t) => {
  await assert.rejects(
    facilitatorOn(t, ARC_MAINNET, { caps: { maxFeePerGasWei: FLOOR - 1n } }),
    FeeFloorError,
  );
  // The same cap on Base, which has no floor, is a cap like any other.
  const { facilitator } = await facilitatorOn(t, BASE_MAINNET, {
    caps: { maxFeePerGasWei: FLOOR - 1n },
  });
  assert.ok(facilitator);
});

test('facilitator on Base: the oracle is asked as before', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, BASE_MAINNET);
  chain.baseFee = 1_000_000n;
  chain.priority = 100_000n;
  await submit(facilitator);
  assert.equal(chain.l1Asked.length, 1);
  assert.equal(parseTransaction(chain.sends[0] as Hex).maxFeePerGas, 2_100_000n);
});

test('facilitator on Arc: below its gas minimum (1 USDC) nothing is stored', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, ARC_MAINNET);
  chain.balance = USDC_GAS - 1n;
  assert.equal(await facilitator.canPay(), false);
  chain.balance = USDC_GAS;
  assert.equal(await facilitator.canPay(), true);
  // A balance read as raw USDC (6 decimals) would look like nothing, never like plenty.
  chain.balance = 100_000_000n;
  assert.equal(await facilitator.canPay(), false);
});

async function bundlerOn(
  t: { after: (fn: () => Promise<unknown>) => void },
  chainId: number,
  options: { baseFee?: bigint; l1FeeWei?: (unsignedTx: Hex) => Promise<bigint> } = {},
  ceilings?: GasCeilings,
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
  await pg.exec(DIRECT_BUNDLER_SQL);
  await pg.exec(DIRECT_BUNDLER_FINALITY_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  const submitter = privateKeyToAccount(generatePrivateKey());
  const state = { oracleCalls: 0, balance: 100n * USDC_GAS, sent: [] as Hex[] };
  const client = Object.assign(createPublicClient({ transport: http('http://127.0.0.1:1') }), {
    estimateMaxPriorityFeePerGas: async () => GWEI,
    getBlock: async () => ({ baseFeePerGas: options.baseFee ?? 25n * GWEI, number: 100n }),
    estimateGas: async () => 186_000n,
    readContract: async (args: { functionName: string }) => {
      assert.equal(args.functionName, 'getL1Fee');
      state.oracleCalls++;
      return 7n;
    },
    getTransactionCount: async () => 0,
    getBalance: async () => state.balance,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      state.sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
  }) as unknown as PublicClient;
  const address = `0x${'7'.repeat(40)}` as const;
  const bundler = directBundler({
    db,
    client,
    chainId,
    entryPoint: `0x${'5'.repeat(40)}`,
    mode: 'prepare',
    paymaster: null,
    keystore: { withSigner: async (_ref, use) => use(submitter) },
    signer: { keyRef: 'v1:signer', address },
    submitter: { keyRef: 'v1:submitter', address: submitter.address },
    budget: ownPaymasterBudget({ db, deposit: async () => ({ wei: 0n, block: 0n }) }),
    policy: {
      addresses: {
        usdc: address,
        spendPermissionManager: address,
        identityRegistry: address,
        reputationRegistry: address,
        smartWalletFactory: address,
        feeRouters: [],
      },
      ...(ceilings ? { ceilings } : {}),
    },
    autoMaintain: false,
    log: () => {},
    ...(options.l1FeeWei ? { l1FeeWei: options.l1FeeWei } : {}),
  });
  return { bundler, state };
}

const selfPaidOp = (extra: Partial<UserOperation<'0.6'>> = {}): UserOperation<'0.6'> => ({
  sender: `0x${'6'.repeat(40)}`,
  nonce: 0n,
  initCode: '0x',
  callData: '0x',
  callGasLimit: 0n,
  verificationGasLimit: 0n,
  preVerificationGas: 0n,
  maxFeePerGas: 0n,
  maxPriorityFeePerGas: 0n,
  paymasterAndData: '0x',
  signature: '0x',
  ...extra,
});

test('own bundler on Arc: no L1 oracle, Arc prices, and it sends within its USDC reserve', async (t) => {
  const { bundler, state } = await bundlerOn(t, ARC_MAINNET);
  const op = await bundler.prepare(selfPaidOp(), { sponsor: false });
  assert.equal(op.maxFeePerGas, 51n * GWEI);
  // No L1 fee in preVerificationGas: only the base overhead and the calldata.
  assert.ok(op.preVerificationGas < 60_000n);
  await bundler.send({ ...op, signature: `0x${'11'.repeat(65)}` });
  assert.equal(state.oracleCalls, 0);
  assert.equal(state.sent.length, 1);
  assert.equal(parseTransaction(state.sent[0]!).maxFeePerGas, 51n * GWEI);
});

test('own bundler on Arc: a low quote is prepared at the floor, a low fee is never sent', async (t) => {
  const { bundler, state } = await bundlerOn(t, ARC_MAINNET, { baseFee: GWEI });
  const op = await bundler.prepare(selfPaidOp(), { sponsor: false });
  assert.equal(op.maxFeePerGas, FLOOR);
  await assert.rejects(
    bundler.send({
      ...op,
      maxFeePerGas: FLOOR - 1n,
      maxPriorityFeePerGas: GWEI,
      signature: `0x${'11'.repeat(65)}`,
    }),
    /under this chain's floor/,
  );
  assert.equal(state.sent.length, 0);
});

test('own bundler on Arc: a base fee past the ceiling refuses, a ceiling under the floor fails loudly', async (t) => {
  const { bundler } = await bundlerOn(t, ARC_MAINNET, { baseFee: 60n * GWEI });
  await assert.rejects(bundler.prepare(selfPaidOp(), { sponsor: false }), /above the configured/);
  await assert.rejects(
    bundlerOn(t, ARC_MAINNET, {}, { ...GAS_CEILINGS, maxFeePerGas: FLOOR - 1n }),
    FeeFloorError,
  );
});

test('own bundler on Arc: it holds less than its reserve, 0.05 USDC plus the transaction: not sent', async (t) => {
  const { bundler, state } = await bundlerOn(t, ARC_MAINNET);
  const op = await bundler.prepare(selfPaidOp(), { sponsor: false });
  // 186k x 1.3 at 51 gwei.
  const worst = 241_800n * 51n * GWEI;
  state.balance = worst + 5n * 10n ** 16n - 1n;
  await assert.rejects(
    bundler.send({ ...op, signature: `0x${'11'.repeat(65)}` }),
    /low on gas funds/,
  );
  assert.equal(state.sent.length, 0);
  state.balance = worst + 5n * 10n ** 16n;
  await bundler.send({ ...op, signature: `0x${'11'.repeat(65)}` });
  assert.equal(state.sent.length, 1);
});

test('own bundler: the L1 fee is injectable, and Base still asks the oracle', async (t) => {
  const asked: Hex[] = [];
  const injected = await bundlerOn(t, ARC_MAINNET, {
    l1FeeWei: async (unsignedTx) => {
      asked.push(unsignedTx);
      return 0n;
    },
  });
  await injected.bundler.prepare(selfPaidOp(), { sponsor: false });
  assert.equal(asked.length, 1);
  assert.equal(parseTransaction(asked[0]!).chainId, ARC_MAINNET);
  assert.equal(injected.state.oracleCalls, 0);

  const base = await bundlerOn(t, BASE_MAINNET, { baseFee: 5_000_000n });
  const low = await bundlerOn(t, BASE_SEPOLIA, { baseFee: 1n });
  const op = await base.bundler.prepare(selfPaidOp(), { sponsor: false });
  assert.equal(base.state.oracleCalls, 1);
  // Base has no floor: fees stay what the quote says (the suggested tip, capped at 0.05 gwei).
  assert.equal(op.maxPriorityFeePerGas, 50_000_000n);
  assert.equal(op.maxFeePerGas, 60_000_000n);
  const lowOp = await low.bundler.prepare(selfPaidOp(), { sponsor: false });
  assert.equal(lowOp.maxFeePerGas, 50_000_002n);
});

test('the CDP-style bundler: on Arc a fee under the floor is raised before the cap sees it', async () => {
  const client = {
    estimateFeesPerGas: async () => ({ maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 10n }),
    getBlock: async () => ({ baseFeePerGas: GWEI / 2n }),
  } as unknown as PublicClient;
  const prepared = (chainId: number, cap: bigint) => {
    const bundler = rpcBundler({
      url: 'https://example.invalid/rpc',
      entryPoint: `0x${'5'.repeat(40)}`,
      chainId,
      client,
      maxFeePerGasCap: cap,
      stubSignature: '0x',
    });
    return bundler.prepare(
      {
        sender: `0x${'6'.repeat(40)}`,
        nonce: 0n,
        callData: '0x',
        callGasLimit: 0n,
        verificationGasLimit: 0n,
        preVerificationGas: 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        signature: '0x',
      },
      { sponsor: false },
    );
  };
  // Under the floor the fee guard sees the raised fee, so a cap under the floor refuses.
  await assert.rejects(prepared(ARC_MAINNET, FLOOR - 1n), /above the configured cap/);
});

test('first send on Arc: the tip stops at 1 gwei, whatever the node suggests', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, ARC_MAINNET);
  chain.priority = 5n * GWEI;
  await submit(facilitator);
  assert.equal(parseTransaction(chain.sends[0] as Hex).maxPriorityFeePerGas, GWEI);
});

test('first send on Base: the tip is what it was, up to the ceiling', async (t) => {
  const { chain, facilitator } = await facilitatorOn(t, BASE_MAINNET);
  chain.baseFee = 1_000_000n;
  chain.priority = 3_000_000n;
  await submit(facilitator);
  assert.equal(parseTransaction(chain.sends[0] as Hex).maxPriorityFeePerGas, 3_000_000n);
});

test('a stuck first send on Arc can still be replaced: the ceiling stays above the first tip', () => {
  const arc = chainParams(ARC_MAINNET);
  assert.equal(arc.firstSendTipWei, GWEI);
  assert.equal(arc.facilitator.caps.maxPriorityFeePerGasWei, 10n * GWEI);
  assert.equal(arc.gasCeilings.maxPriorityFeePerGas, 10n * GWEI);
  assert.equal(chainParams(BASE_MAINNET).firstSendTipWei, undefined);
});
