/*
 * Operation Protocol on Base mainnet: the deployed addresses, in code, and the one rule for its
 * switches (docs/protocol/LIVE.md). Browser-safe: no Node imports.
 *
 * Live by default. The Feed, Feed pay, the 10% protocol fee on Feed pay calls, the protocol fee
 * ledger (scan and public metrics) and the payment screening gate need no setting to run. Each
 * keeps exactly one emergency off: its flag set to exactly '0' turns that feature off; unset or
 * any other value leaves it on. Nothing ever needs to be switched on.
 *
 * On Base mainnet (8453) the addresses below are authoritative: an environment value for a router
 * (1, 2 or 3) or its start block, the treasury or the sanctions oracle is ignored there (logged once
 * when it disagrees, never used). On any other chain (a test network) the environment configures
 * them. The *_ENABLED switches for routers 2 and 3 are read on every chain.
 */
import { BASE_MAINNET, BASE_NETWORKS, MULTICALL3, type Address } from './base/chains.js';
import { SPONSOR_PAYMASTERS } from './base/paymasters.js';
import { ARC_MAINNET, ARC_NETWORKS } from './chains.js';

/** The value that switches a live feature off. Anything else, or nothing, leaves it on. */
export const EMERGENCY_OFF = '0';

/**
 * True unless `flag` is set to exactly '0' in `env` (read per request or step, never cached).
 * The one reading of every Operation Protocol switch: CITY_FEED, CITY_FEED_PAY,
 * CITY_PROTOCOL_FEES and CITY_PROTOCOL_SCREENING.
 */
export function liveUnlessOff(
  env: Readonly<Record<string, string | undefined>>,
  flag: string,
): boolean {
  return env[flag] !== EMERGENCY_OFF;
}

/** The emergency-off flags, in one place (docs/protocol/LIVE.md). */
export const PROTOCOL_OFF_FLAGS = Object.freeze({
  /** The Feed itself (and everything on it, Feed pay included). */
  feed: 'CITY_FEED',
  /** Feed pay ("Use with my agent" and city_service_call): no new quotes or calls. */
  feedPay: 'CITY_FEED_PAY',
  /** The protocol fee on new Feed pay calls, the ledger scan and the public metrics. */
  fees: 'CITY_PROTOCOL_FEES',
  /** Payment screening before every new payment submission. */
  screening: 'CITY_PROTOCOL_SCREENING',
});

/**
 * The switch for fee router 2 (docs/protocol/FEE_ROUTER_2.md): totals above 0.10 USDC go to router 2
 * only while this is exactly '1'. Off by default: every total above 0.10 USDC is refused as before.
 */
export const FEE_ROUTER2_FLAG = 'CITY_PROTOCOL_FEE_ROUTER2_ENABLED';

/**
 * The switch for fee router 3 (docs/protocol/FEE_ROUTER_3.md, x402 settlement): new payments go to
 * router 3 only while this is exactly '1'. Off by default. The ledger counts router 3's fees
 * whatever this says: always on Base mainnet (pinned below), elsewhere whenever
 * CITY_PROTOCOL_FEE_ROUTER3 and CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK are set.
 */
export const FEE_ROUTER3_FLAG = 'CITY_PROTOCOL_FEE_ROUTER3_ENABLED';

/** The chain Operation Protocol runs on. */
export const PROTOCOL_CHAIN_ID = BASE_MAINNET;

export interface ProtocolDeployment {
  readonly chainId: number;
  /** Base USDC, the one token fees are paid in. */
  readonly usdc: Address;
  /** CentralCityFeeRouter (contracts/fees), immutable and without an owner. */
  readonly feeRouter: Address;
  /** The fee receiver the router pays (its immutable treasury()). */
  readonly treasury: Address;
  /** The router's deploy block: the ledger scan starts here. */
  readonly feeRouterDeployBlock: bigint;
  /** CentralCityFeeRouter2 (docs/protocol/FEE_ROUTER_2.md): the same contract, 100 USDC cap. */
  readonly feeRouter2: Address;
  /** Router 2's deploy block: its ledger scan starts here. */
  readonly feeRouter2DeployBlock: bigint;
  /** CentralCityFeeRouter3 (docs/protocol/FEE_ROUTER_3.md): x402 settlement, immutable. */
  readonly feeRouter3: Address;
  /** Router 3's deploy block: its ledger scan starts here. */
  readonly feeRouter3DeployBlock: bigint;
  /** The on-chain sanctions oracle (isSanctioned(address) returns (bool)), read only. */
  readonly sanctionsOracle: Address;
}

/**
 * Base mainnet (docs/protocol/CANARY.md "Deployed"). The router was deployed in block 52603696,
 * router 2 in block 52767258 and router 3 in block 52804453, all verified on Basescan. The oracle
 * answers isSanctioned for a listed address with true and for the treasury with false (checked on
 * Base).
 */
export const PROTOCOL_BASE_MAINNET: ProtocolDeployment = Object.freeze({
  chainId: BASE_MAINNET,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  feeRouter: '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B',
  treasury: '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9',
  feeRouterDeployBlock: 52603696n,
  feeRouter2: '0xb1945a2aF160e84E34F7C0FB0E4dD94fd4c0AF0D',
  feeRouter2DeployBlock: 52767258n,
  feeRouter3: '0xE807A76385EC3d76D17aB955091C12329d0A1403',
  feeRouter3DeployBlock: 52804453n,
  sanctionsOracle: '0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B',
});

/** The deployment fixed in code for a chain (Base mainnet only), else null (env-configured). */
export function protocolDeployment(chainId: number): ProtocolDeployment | null {
  return chainId === PROTOCOL_BASE_MAINNET.chainId ? PROTOCOL_BASE_MAINNET : null;
}

/** Central City's own x402 facilitator on Base mainnet (an EOA that sends router 3 settlements). */
export const X402_FACILITATOR_BASE_MAINNET: Address = '0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC';

/** The sponsored first purchase's sponsor wallet on Base mainnet (an EOA; public on Basescan). */
export const SFP_SPONSOR_BASE_MAINNET: Address = '0x64e8FFB436a236da487d1c20fF2548A70cf82C13';

/**
 * Addresses no payment may name as its payee (seller or pay-to): the zero address, every fee router,
 * the treasury, the sanctions oracle, USDC, the facilitator and the sponsor wallet. USDC sent to a
 * router or to the token is stranded there for good (the routers have no withdrawal); the treasury,
 * the facilitator and the sponsor are never sellers.
 * Also the other pinned Base contracts where USDC would be stranded or could be taken by anyone
 * (CCA-123): both EntryPoints, the SpendPermissionManager, the smart wallet factory, Multicall3,
 * the ERC-8004 identity and reputation registries and the pinned paymasters.
 * Base mainnet's are always included; `extra` adds a test network's configured ones. Lowercase.
 */
/** The pinned Base mainnet contracts that are never a payee (reservedPayees). */
function pinnedContracts(): (string | null)[] {
  const c = BASE_NETWORKS[BASE_MAINNET].contracts;
  return [
    c.entryPointV06,
    c.entryPointV07,
    c.spendPermissionManager,
    c.smartWalletFactory,
    c.identityRegistry,
    c.reputationRegistry,
    MULTICALL3,
    ...(SPONSOR_PAYMASTERS[BASE_MAINNET] ?? []),
    // Arc's own paymaster too: a seller naming it as pay_to would send fees into the paymaster.
    ...(SPONSOR_PAYMASTERS[ARC_MAINNET] ?? []),
  ];
}

/** Arc's USDC and contracts, on both Arc chains: nothing sent to them comes back. */
function arcContracts(): Array<string | null> {
  return Object.values(ARC_NETWORKS).flatMap((arc) => [
    arc.usdc.address,
    ...Object.values(arc.contracts),
  ]);
}

export function reservedPayees(
  extra: Iterable<string | null | undefined> = [],
): ReadonlySet<string> {
  const d = PROTOCOL_BASE_MAINNET;
  const all = new Set<string>([`0x${'0'.repeat(40)}`]);
  for (const a of [
    d.usdc,
    d.feeRouter,
    d.feeRouter2,
    d.feeRouter3,
    d.treasury,
    // The sanctions list contract: it moves no token, anything sent there is lost (MPR-2).
    d.sanctionsOracle,
    X402_FACILITATOR_BASE_MAINNET,
    SFP_SPONSOR_BASE_MAINNET,
    ...pinnedContracts(),
    ...arcContracts(),
    ...extra,
  ])
    if (a) all.add(a.toLowerCase());
  return all;
}

/** True when `payee` may never be paid (reservedPayees), or is not an address at all. */
export function isReservedPayee(
  payee: string,
  reserved: ReadonlySet<string> = reservedPayees(),
): boolean {
  return !/^0x[0-9a-fA-F]{40}$/.test(payee) || reserved.has(payee.toLowerCase());
}
