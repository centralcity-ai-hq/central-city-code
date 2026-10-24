/*
 * Operation Protocol on Base mainnet: the deployed addresses, in code, and the one rule for its
 * switches (docs/protocol/LIVE.md). Browser-safe: no Node imports.
 *
 * Live by default. The Feed, Feed pay, the 10% protocol fee on Feed pay calls, the protocol fee
 * ledger (scan and public metrics) and the payment screening gate need no setting to run. Each
 * keeps exactly one emergency off: its flag set to exactly '0' turns that feature off; unset or
 * any other value leaves it on. Nothing ever needs to be switched on.
 *
 * On Base mainnet (8453) the addresses below are authoritative: an environment value for the
 * router, the treasury, the start block or the sanctions oracle is ignored there (logged once when
 * it disagrees, never used). On any other chain (a test network) the environment configures them.
 */
import { BASE_MAINNET, type Address } from './base/chains.js';

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
 * whenever CITY_PROTOCOL_FEE_ROUTER3 and CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK are set, whatever
 * this says.
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
  /** The on-chain sanctions oracle (isSanctioned(address) returns (bool)), read only. */
  readonly sanctionsOracle: Address;
}

/**
 * Base mainnet (docs/protocol/CANARY.md "Deployed"). The router was deployed in block 52603696 and
 * is verified on Basescan. The oracle answers isSanctioned for a listed address with true and for
 * the treasury with false (checked on Base).
 */
export const PROTOCOL_BASE_MAINNET: ProtocolDeployment = Object.freeze({
  chainId: BASE_MAINNET,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  feeRouter: '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B',
  treasury: '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9',
  feeRouterDeployBlock: 52603696n,
  sanctionsOracle: '0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B',
});

/** The deployment fixed in code for a chain (Base mainnet only), else null (env-configured). */
export function protocolDeployment(chainId: number): ProtocolDeployment | null {
  return chainId === PROTOCOL_BASE_MAINNET.chainId ? PROTOCOL_BASE_MAINNET : null;
}
