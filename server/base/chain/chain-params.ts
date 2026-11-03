/*
 * The numbers a send path needs per chain: fee ceilings, gas reserves, budgets, hot-wallet limits,
 * the signing fee floor and whether an L1 data fee exists. Base's are the values the send paths
 * always had, unchanged; any chain not listed in shared/chains.ts gets them too (Anvil, tests), as
 * it did before there was a second chain. Asking here enables nothing: whether Arc is on is
 * arcNetwork's and baseNetwork's business.
 *
 * Arc pays gas in USDC. Its native balance has 18 decimals, so 10^18 native wei is 1 USDC (not 10^18
 * USDC base units, and not 1 ETH). No number below may be read across chains: Base's 0.02 ETH is
 * not 0.02 on Arc. The Arc values are set from a gas price of 25 gwei and 198k gas per settle from a
 * smart account, about 0.00495 USDC (measured on Arc testnet, docs/arc/TESTNET.md: 223k gas to a
 * seller with no balance yet). The gas caps are not measured prices: they are 100 gwei, 4 x that price, which
 * leaves room for 2 x base fee + tip and for replacements at +30%, and costs at most 0.04 USDC per
 * transaction at the 400k gas limit. The budget windows are Base's x 200 (the ratio of the fee caps,
 * 100 / 0.5 gwei), so the same number of operations fits in each at the fee cap.
 *
 * This module is a leaf: it only imports types from the server, so anything may import it.
 */
import { BASE_MAINNET, BASE_SEPOLIA } from '../../../shared/base/chains.js';
import { PUBLIC_BASE_RPC } from '../../../shared/base/on-base.js';
import {
  ARC_MAINNET,
  ARC_NETWORKS,
  ARC_TESTNET,
  isRealMoneyChain,
  type ArcChainId,
} from '../../../shared/chains.js';
import type { FacilitatorCaps } from '../../protocol/x402/facilitator.js';
import type { HotWalletCeilings } from './hot-wallets.js';
import type { BudgetLimits } from './own-paymaster-budget.js';
import type { GasCeilings } from './own-paymaster-policy.js';

export interface ChainParams {
  /** viem's chain description of the gas asset. */
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
  /** What the gas balance is called in a hot-wallet log line. */
  gasLabel: string;
  /** Under this a transaction is dropped without an error: never built, signed or sent. */
  minMaxFeePerGasWei: bigint;
  /** Whether this chain charges an L1 data fee read from the OP-stack oracle. */
  l1FeeOracle: boolean;
  /** Real money: the per-operation fee budgets are mandatory (runtime.ts). */
  feeBudgetRequired: boolean;
  /** The settings that hold this chain's values, so a value in one asset never reaches another. */
  settings: {
    maxFeePerGas: string;
    identityFeeCap: string;
    walletFeeCap: string;
    sponsoredSenderMin: string;
    /** CITY_HOT_CEILING_* / CITY_HOT_OUTFLOW_* with this prefix (hot-wallets.ts). */
    hotWalletPrefix: string;
    /** The gas balance's name in those settings. */
    hotWalletGasAsset: string;
  };
  /** Highest fee quote taken from a second read endpoint (read-transport.ts). */
  fallbackQuoteCeilingWei: bigint;
  /**
   * Settlement gas above this share of the protocol fee it carries, in basis points, is an ALERT
   * in the economics watch (CCA-754).
   */
  settleGasAlertBps: bigint;
  /**
   * Highest tip on a first send, under the tip ceiling so a stuck send can still be replaced (a
   * replacement must raise the tip). Absent: the first send may use the whole ceiling.
   */
  firstSendTipWei?: bigint;
  /**
   * The least a replacement raises the tip by (own bundler): a factor alone leaves a tip of 0 at 0,
   * which can never be replaced. Still within the tip ceiling.
   */
  minBumpWei: bigint;
  /**
   * A node that holds only a few nonces ahead of the mined head (own bundler): what lies past
   * `windowNonces` is refused, so it is not offered yet, and upkeep works the window until the lane
   * stops moving. `stuckMs` replaces STUCK_MS for a head the node knows but does not mine. Unset
   * (Base): one pass, lane head first, with no window. `capPerLane` is the most unmined sends one
   * submitter may have: past it nothing is signed or sponsored, and the caller hears "busy".
   */
  lanePool?: { windowNonces: number; stuckMs: number; capPerLane: number };
  /**
   * How old a deposit reading the sponsorship budget may decide on, in ms. Set, the reading is taken
   * before the budget lock and shared, so the lock is not held across RPC calls. Unset (Base): a
   * fresh read inside the lock at every admission.
   */
  depositMaxAgeMs?: number;
  /** The longest a transaction waits for the budget lock, in ms. Unset (Base): no limit of its own. */
  budgetLockTimeoutMs?: number;
  /** How old the budget's settled and exit-day sums may be, in ms. Unset (Base): counted under the lock. */
  budgetHistoryMaxAgeMs?: number;
  /** Settles without the budget lock (own-paymaster-budget.ts settleUnlocked). Unset (Base): under it. */
  budgetSettleUnlocked?: boolean;
  /** How often the hot paths lapse never-sent reservations, in ms. Unset (Base): every time. */
  budgetExpireEveryMs?: number;
  /** The keyless public RPC used as the second read endpoint when hosted. */
  publicReadRpc: string | undefined;
  facilitator: {
    /** Least gas balance for a new settlement to be stored. */
    minBalanceWei: bigint;
    caps: FacilitatorCaps;
  };
  gasCeilings: GasCeilings;
  /** What the bundler's submitter keeps beyond one transaction's worst case. */
  submitterReserveWei: bigint;
  budget: BudgetLimits;
  hotWallets: HotWalletCeilings;
  /** First buys pause under this sender balance: the default, and what a setting may choose. */
  sponsoredSenderMinWei: { fallback: bigint; min: bigint; max: bigint };
  /** Owner withdrawals and payments (wallet/withdrawals.ts). */
  ownerOps: {
    /** The smallest withdrawal: below it the fee the sponsor pays is more than what moves. */
    withdrawalMinUsdcRaw: bigint;
    /** The same in the native token; null where it is never withdrawn. */
    withdrawalMinNativeWei: bigint | null;
    /** The sponsor's gas in flight: the defaults, in the gas asset, and the settings over them. */
    inflightPerWalletWei: bigint;
    inflightTotalWei: bigint;
    inflightPerWalletSetting: string;
    inflightTotalSetting: string;
    /** Of it, what one owner's unsigned operations may hold. */
    unsignedPerAccountWei: bigint;
    /** The advisory lock over this chain's exposure ledger ("cc-spons" as a 64-bit key on Base). */
    exposureLockKey: string;
  };
  /**
   * USDC base units per 1 whole native token when that is a fact of the chain, for the settlement
   * economics watch. Null: a market price, from CITY_X402_FACILITATOR_ETH_USD.
   */
  usdcPerNative: bigint | null;
}

const ETH = 10n ** 18n;
const USDC_RAW = 1_000_000n;

/**
 * What the admin wallet already paid out of the ordinary ceiling before this budget existed: the gas
 * of the paymaster deploy, the submitter allowlist and the three funding transfers, in exact wei from
 * their Base receipts (L2 + L1). The ceiling is inclusive of it, so it is subtracted, never re-granted.
 */
export const PRIOR_ORDINARY_FEES_WEI = 20_773_789_406_452n;

const BASE_COMMON: Omit<ChainParams, 'feeBudgetRequired' | 'publicReadRpc'> = {
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  gasLabel: 'eth',
  minMaxFeePerGasWei: 0n,
  l1FeeOracle: true,
  settings: {
    maxFeePerGas: 'CITY_BASE_MAX_FEE_PER_GAS_WEI',
    identityFeeCap: 'CITY_BASE_IDENTITY_FEE_CAP_WEI',
    walletFeeCap: 'CITY_BASE_WALLET_FEE_CAP_WEI',
    sponsoredSenderMin: 'CITY_SFP_SENDER_MIN_ETH_WEI',
    hotWalletPrefix: 'CITY_HOT',
    hotWalletGasAsset: 'ETH',
  },
  // 1 gwei, many times Base's usual fee.
  fallbackQuoteCeilingWei: 1_000_000_000n,
  settleGasAlertBps: 5_000n, // 50%
  // 0.001 gwei, what Base includes at. Far under the 0.05 gwei tip ceiling: a step that reached the
  // ceiling would end every later replacement, and with them the cancel of a send that lapsed.
  minBumpWei: 1_000_000n,
  // Longer than Arc's: Base still reads the deposit inside the budget lock, two RPC calls an admission.
  budgetLockTimeoutMs: 5_000,
  facilitator: {
    minBalanceWei: 500_000_000_000_000n, // 0.0005 ETH
    caps: {
      maxFeePerGasWei: 500_000_000n, // 0.5 gwei (Base runs around 0.006 gwei)
      maxPriorityFeePerGasWei: 50_000_000n, // 0.05 gwei
      maxGasLimit: 400_000n, // one settle measured 164k-185k on a Base fork
      maxReplacements: 3,
      reserveWei: 200_000_000_000_000n, // 0.0002 ETH
    },
  },
  gasCeilings: {
    callGasLimit: 1_500_000n,
    verificationGasLimit: 300_000n,
    verificationGasLimitWithInit: 700_000n,
    preVerificationGas: 200_000n,
    maxFeePerGas: 500_000_000n, // 0.5 gwei (Base runs around 0.006 gwei), like the router-3 facilitator
    maxPriorityFeePerGas: 50_000_000n, // 0.05 gwei
  },
  submitterReserveWei: 100_000_000_000_000n, // 0.0001 ETH
  budget: {
    ordinaryCeilingWei: (93n * ETH) / 100n - PRIOR_ORDINARY_FEES_WEI, // 0.929979226210593548 ETH (24 Oct: deposit topped up to 0.988)
    hourlyOrdinaryWei: ETH / 10n, // 0.1 ETH (24 Oct: worst-case accounting; backlog mints + hand-overs + 500/h + 50 ratings/h; real spend ~0.003 ETH/h)
    protectedWei: (5n * ETH) / 100n, // 0.05 ETH
    // Per-account sponsorship budgets (25 Oct), the same worst-case accounting as the hourly cap: one
    // account at most a tenth of the shared hour, one sender half of that; exits 0.02 ETH/h in all,
    // 0.005 per account, 0.0025 per sender; at most 10 never-sent owner handouts per account, of
    // them 2 exits (an honest owner rarely has more than a withdrawal and a cancel unsigned at once).
    hourlyExitWei: (2n * ETH) / 100n, // 0.02 ETH
    // Exits per day: the protected reserve in all, 0.005 ETH per account (one hour of its own cap;
    // about 350 exits at Base's usual fees, 9 at the 0.5 gwei fee ceiling, settled ones at their
    // actual cost), so it takes 10 accounts at their own day to reach the shared one, and past it
    // every account still has its first 3 exits of the day: not a ceiling (the exit hour bounds the
    // day at 24 × 0.02 = 0.48 ETH worst case).
    dailyExitWei: (5n * ETH) / 100n, // 0.05 ETH
    handoutShareBps: 3_000, // 30%
    accountHourlyOrdinaryWei: ETH / 100n, // 0.01 ETH
    senderHourlyOrdinaryWei: (5n * ETH) / 1000n, // 0.005 ETH
    accountHourlyExitWei: (5n * ETH) / 1000n, // 0.005 ETH
    senderHourlyExitWei: (25n * ETH) / 10_000n, // 0.0025 ETH
    accountDailyExitWei: (5n * ETH) / 1000n, // 0.005 ETH
    freeDailyExitsPerAccount: 3,
    unsignedOpenPerAccount: 10,
    unsignedOpenExitPerAccount: 2,
  },
  // The stated defaults: a few days of gas or sponsored buys, never a treasury.
  hotWallets: {
    sfp_sponsor: {
      usdc: { ceiling: 500n * USDC_RAW, outflowPerHour: 100n * USDC_RAW },
      eth: { ceiling: ETH / 20n, outflowPerHour: ETH / 200n },
    },
    router3_facilitator: { eth: { ceiling: ETH / 20n, outflowPerHour: ETH / 200n } },
    public_settle: { eth: { ceiling: ETH / 20n, outflowPerHour: ETH / 200n } },
    // Its readiness floor is 0.02 ETH (server/feed/offers/public-pay.ts), so a little more room.
    public_offer: { eth: { ceiling: ETH / 10n, outflowPerHour: ETH / 200n } },
    paymaster_submitter: { eth: { ceiling: ETH / 10n, outflowPerHour: ETH / 100n } },
    // Signs sponsorships only and holds no funds (audit report, Wallets and keys).
    paymaster_signer: { eth: { ceiling: 0n, outflowPerHour: 0n } },
  },
  // 0.02 ETH, within 0.001 to 1 ETH.
  sponsoredSenderMinWei: {
    fallback: 20_000_000_000_000_000n,
    min: 1_000_000_000_000_000n,
    max: 1_000_000_000_000_000_000n,
  },
  ownerOps: {
    withdrawalMinUsdcRaw: 10_000n, // 0.01 USDC
    withdrawalMinNativeWei: 10_000_000_000_000n, // 0.00001 ETH
    inflightPerWalletWei: ETH / 10n, // 0.1 ETH
    inflightTotalWei: 3n * ETH, // 3 ETH, about USD 10k
    inflightPerWalletSetting: 'CITY_BASE_SPONSOR_INFLIGHT_WEI_PER_WALLET',
    inflightTotalSetting: 'CITY_BASE_SPONSOR_INFLIGHT_WEI_TOTAL',
    unsignedPerAccountWei: (2n * ETH) / 100n, // 0.02 ETH
    exposureLockKey: '7161117711238328179',
  },
  usdcPerNative: null,
};

/** 1 USDC of gas on Arc, in native wei. */
const USDC_GAS = 10n ** 18n;
const GWEI = 1_000_000_000n;
/** Hundredths of a USDC of gas, in native wei: usdcGas(5n) is 0.05 USDC. */
const usdcGas = (hundredths: bigint) => (hundredths * USDC_GAS) / 100n;

const ARC_COMMON: Omit<ChainParams, 'feeBudgetRequired' | 'publicReadRpc'> = {
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  gasLabel: 'usdc-gas',
  minMaxFeePerGasWei: ARC_NETWORKS[ARC_MAINNET].minMaxFeePerGasWei, // 20 gwei
  // Arc is a Layer 1: no data fee, and no oracle at the OP-stack address.
  l1FeeOracle: false,
  settings: {
    maxFeePerGas: 'CITY_ARC_MAX_FEE_PER_GAS_WEI',
    identityFeeCap: 'CITY_ARC_IDENTITY_FEE_CAP_WEI',
    walletFeeCap: 'CITY_ARC_WALLET_FEE_CAP_WEI',
    sponsoredSenderMin: 'CITY_ARC_SFP_SENDER_MIN_GAS_WEI',
    hotWalletPrefix: 'CITY_ARC_HOT',
    hotWalletGasAsset: 'GAS',
  },
  // 200 gwei, twice the fee cap, as Base's 1 gwei is twice its 0.5 gwei.
  fallbackQuoteCeilingWei: 200n * GWEI,
  // 100%: a settle at the 0.05 USDC minimum measured 81-111% of its fee at 20.5-25 gwei, so Base's
  // 50% would alert on every one of them. The alert here means what it costs: gas above the fee.
  settleGasAlertBps: 10_000n,
  // At 1 gwei a settle stays under the 0.005 fee at the 0.05 floor (docs/arc/TESTNET.md). Measured on
  // a quiet testnet only; inclusion under load is still to be proven.
  firstSendTipWei: GWEI,
  minBumpWei: GWEI,
  // Measured on Arc testnet, 1 Nov: 16 held past a gap, then "txpool is full" (once 17); blocks
  // every 0.5 s mined 18 of one key's transactions in 1.3 s, so 30 s without a move is not traffic.
  // The cap stays under the node's limit of 16, so every send is held at once. The time window
  // does not bind: 12 sends fit the 7 minutes a sponsorship can be sent in even at the slowest pace
  // seen on mainnet in a backlog (174 nonces in 14 minutes, about 0.2 per second, 84 in 7 minutes).
  lanePool: { windowNonces: 16, stuckMs: 30_000, capPerLane: 12 },
  // 100k registrations a day is 2.3 operations a second, each admitted twice: at about 0.1 s per RPC
  // call, two calls per fresh read inside the lock would cap the whole chain near that rate.
  depositMaxAgeMs: 8_000,
  // Half of the age above stays above this, so a reading does not age out in the queue.
  budgetLockTimeoutMs: 3_000,
  // At 100k a day about 400k rows are added daily, and these two sums read them all: spent in this
  // time passes the 10,000 ceiling at most by the hourly cap's share, about 17 USDC.
  budgetHistoryMaxAgeMs: 120_000,
  // 2 Nov at ~86 registrations a minute: lock waits of 0.5-3.4 s, the queue held at ~2.2 operations
  // a second whatever the number of creators. An operation took the lock four times (reserve, send,
  // two settles), each held for its round trips to the database, not its SQL (sums 20 ms, lapse
  // 0.2 ms). Settles leave the queue, and the send's lapse runs once a second per instance.
  budgetSettleUnlocked: true,
  budgetExpireEveryMs: 1_000,
  facilitator: {
    minBalanceWei: usdcGas(100n), // 1 USDC, about 202 settles at 25 gwei
    caps: {
      maxFeePerGasWei: 100n * GWEI, // about 0.0198 USDC per settle at most (198k gas)
      maxPriorityFeePerGasWei: 10n * GWEI, // a tenth of the fee cap, as on Base
      maxGasLimit: 400_000n,
      maxReplacements: 3,
      reserveWei: usdcGas(10n), // 0.1 USDC, about 20 settles at 25 gwei
    },
  },
  gasCeilings: {
    callGasLimit: 1_500_000n,
    verificationGasLimit: 300_000n,
    verificationGasLimitWithInit: 700_000n,
    preVerificationGas: 200_000n,
    maxFeePerGas: 100n * GWEI, // like the router-3 facilitator
    maxPriorityFeePerGas: 10n * GWEI,
  },
  submitterReserveWei: usdcGas(5n), // 0.05 USDC, about 10 settles at 25 gwei
  budget: {
    // The owner's decision (1 Nov): 10,000 USDC, so the deposit is the real limit.
    ordinaryCeilingWei: usdcGas(1_000_000n), // 10,000 USDC
    hourlyOrdinaryWei: usdcGas(50_000n), // 500 USDC (the owner's decision, 1 Nov)
    // Ordinary flows are refused until the deposit is above this (seen on testnet at 2 USDC).
    protectedWei: usdcGas(1_000n), // 10 USDC
    hourlyExitWei: usdcGas(400n), // 4 USDC
    dailyExitWei: usdcGas(1_000n), // 10 USDC
    handoutShareBps: 3_000, // 30%
    accountHourlyOrdinaryWei: usdcGas(200n), // 2 USDC
    senderHourlyOrdinaryWei: usdcGas(100n), // 1 USDC
    accountHourlyExitWei: usdcGas(100n), // 1 USDC
    senderHourlyExitWei: usdcGas(50n), // 0.5 USDC
    accountDailyExitWei: usdcGas(100n), // 1 USDC
    freeDailyExitsPerAccount: 3,
    unsignedOpenPerAccount: 10,
    unsignedOpenExitPerAccount: 2,
  },
  hotWallets: {
    // Its USDC and its gas are ONE balance on Arc, read at 6 and at 18 decimals: the same limit in
    // each. A smaller gas limit would alert on every sponsor that holds its buying money.
    // Sized for the 40 USDC sponsored first buys on Arc (2 Nov 2026: up to ~200 a minute, funded by
    // the owner); alerts only (hot-wallets.ts), nothing is refused by them.
    sfp_sponsor: {
      usdc: { ceiling: 250_000n * USDC_RAW, outflowPerHour: 200_000n * USDC_RAW },
      eth: { ceiling: 250_000n * USDC_GAS, outflowPerHour: 200_000n * USDC_GAS },
    },
    // The key 'eth' is the role's gas balance on every chain; on Arc it is shown as usdc-gas.
    router3_facilitator: { eth: { ceiling: 50n * USDC_GAS, outflowPerHour: 5n * USDC_GAS } }, // about 1010 settles/h
    public_settle: { eth: { ceiling: 50n * USDC_GAS, outflowPerHour: 5n * USDC_GAS } },
    // Base only (runtime.ts publicOfferLane): no such wallet on Arc, so nothing to hold to a limit.
    public_offer: {},
    paymaster_submitter: { eth: { ceiling: 100n * USDC_GAS, outflowPerHour: 10n * USDC_GAS } },
    paymaster_signer: { eth: { ceiling: 0n, outflowPerHour: 0n } },
  },
  // 5 USDC, about 1010 settles at 25 gwei; within 2 to 50 USDC.
  sponsoredSenderMinWei: { fallback: 5n * USDC_GAS, min: 2n * USDC_GAS, max: 50n * USDC_GAS },
  ownerOps: {
    // One operation costs at most 0.04 USDC at the 400k gas limit (see above), so the smallest
    // withdrawal is above that, not Base's 0.01. Native gas is never a withdrawal.
    withdrawalMinUsdcRaw: 50_000n, // 0.05 USDC
    withdrawalMinNativeWei: null,
    // Below Base's x 200 for a first small fleet: the total is the paymaster's ordinary ceiling.
    inflightPerWalletWei: 5n * USDC_GAS,
    inflightTotalWei: 50n * USDC_GAS,
    inflightPerWalletSetting: 'CITY_ARC_SPONSOR_INFLIGHT_WEI_PER_WALLET',
    inflightTotalSetting: 'CITY_ARC_SPONSOR_INFLIGHT_WEI_TOTAL',
    unsignedPerAccountWei: 4n * USDC_GAS, // Base's x 200
    // Its own lock: an operation on Arc never waits on Base's exposure ledger, nor the other way.
    exposureLockKey: '7161117711238328180',
  },
  // A whole native token IS one USDC.
  usdcPerNative: USDC_RAW,
};

const BASE_PUBLIC_RPC: Readonly<Record<number, string>> = Object.freeze({
  [BASE_MAINNET]: PUBLIC_BASE_RPC,
  [BASE_SEPOLIA]: 'https://sepolia.base.org',
});

const arcParams = (chainId: ArcChainId): ChainParams => ({
  ...ARC_COMMON,
  feeBudgetRequired: isRealMoneyChain(chainId),
  publicReadRpc: ARC_NETWORKS[chainId].publicRpcUrl,
});

/** A chain's parameters. Says nothing about whether the chain is on. */
export function chainParams(chainId: number): ChainParams {
  if (chainId === ARC_MAINNET || chainId === ARC_TESTNET) return arcParams(chainId);
  return {
    ...BASE_COMMON,
    feeBudgetRequired: isRealMoneyChain(chainId),
    publicReadRpc: BASE_PUBLIC_RPC[chainId],
  };
}

/** A fee a chain would drop without an error: nothing was signed or sent. */
export class FeeFloorError extends Error {
  constructor(readonly what: string) {
    super(`${what} is under this chain's signing fee floor: nothing is signed.`);
    this.name = 'FeeFloorError';
  }
}

/** Refuses a maxFeePerGas (or a cap on it) under the chain's floor. Base's floor is 0. */
export function assertFeeFloor(params: ChainParams, maxFeePerGas: bigint, what: string): void {
  if (maxFeePerGas < params.minMaxFeePerGasWei) throw new FeeFloorError(what);
}
