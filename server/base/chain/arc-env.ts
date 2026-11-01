/*
 * The settings a chain runtime on Arc sees. The send paths read their settings by Base's names, so
 * Arc's runtime gets a view: Arc's own values under those names, and nothing of Base's. A cap in wei
 * of ETH, a CDP URL or a Base router must not reach a chain whose gas is USDC. Only what is shared on
 * purpose passes: the key-encryption keys and who the fleet operators are. Arc's paymaster keys are
 * its own (own-paymaster-keys.ts). Arc has no CDP, so its bundler is always our own.
 */
import { BASE_MAINNET } from '../../../shared/base/chains.js';
import { ARC_MAINNET, ARC_TESTNET } from '../../../shared/chains.js';
import { protocolArcChainIdFromEnv } from '../../protocol/fees/cron.js';
import type { OwnBundlerUpkeep } from './direct-bundler.js';
import {
  ARC_PAYMASTER_SIGNER_KEY_REF_SETTING,
  ARC_SUBMITTER_KEY_REFS_SETTING,
  ownPaymasterMode,
} from './own-paymaster-keys.js';

const SHARED_BASE_SETTINGS = new Set([
  'CITY_BASE_SPENDER_KEK',
  'CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS',
  'CITY_BASE_SPONSOR_OPERATOR_OWNERS',
]);

/** Not on Arc for now: each of these names a Base endpoint, key or lane. */
const NOT_ON_ARC =
  /^(CITY_FEED_PAY_CDP_RPC_URL|CITY_X402_PUBLIC_|CITY_X402_FACILITATOR_ETH_USD|CITY_SFP_|CITY_PROTOCOL_(ROUTER|RPC_URL|START_BLOCK|CHAIN_ID|FEE_ROUTER2|ESCROW_OPERATOR))/;

/** Base's name for a setting -> Arc's. */
const ARC_SETTINGS: Readonly<Record<string, string>> = {
  CITY_BASE_OWN_PAYMASTER: 'CITY_ARC_OWN_PAYMASTER',
  CITY_BASE_PAYMASTER_ADDRESS: 'CITY_ARC_PAYMASTER',
  CITY_BASE_PAYMASTER_SIGNER_KEY_REF: ARC_PAYMASTER_SIGNER_KEY_REF_SETTING,
  CITY_BASE_SUBMITTER_KEY_REFS: ARC_SUBMITTER_KEY_REFS_SETTING,
  CITY_BASE_READ_FALLBACK_RPC_URL: 'CITY_ARC_READ_FALLBACK_RPC_URL',
  CITY_X402_FACILITATOR_KEY_REF: 'CITY_ARC_FACILITATOR_KEY_REF',
  CITY_PROTOCOL_FEE_ROUTER3: 'CITY_ARC_FEE_ROUTER3',
  CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: 'CITY_ARC_FEE_ROUTER3_FROM_BLOCK',
  CITY_PROTOCOL_FEE_ROUTER3_ENABLED: 'CITY_ARC_FEE_ROUTER3_ENABLED',
  CITY_PROTOCOL_TREASURY: 'CITY_ARC_TREASURY',
};

export function arcRuntimeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const scoped: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CITY_BASE_') && !SHARED_BASE_SETTINGS.has(name)) continue;
    if (NOT_ON_ARC.test(name) || name in ARC_SETTINGS) continue;
    scoped[name] = value;
  }
  for (const [baseName, arcName] of Object.entries(ARC_SETTINGS)) {
    if (env[arcName] !== undefined) scoped[baseName] = env[arcName];
  }
  scoped.CITY_BASE_BUNDLER = 'direct';
  return scoped;
}

/**
 * Which chain's paymaster the public route serves: Base whenever Base has one or Arc is off, exactly
 * as before; Arc on a server that runs Arc's alone.
 */
export function paymasterSide(env: Record<string, string | undefined>): {
  env: Record<string, string | undefined>;
  chainId: number;
} {
  const arc = protocolArcChainIdFromEnv(env);
  if (arc === null || ownPaymasterMode(env) !== 'off') return { env, chainId: BASE_MAINNET };
  return { env: arcRuntimeEnv(env), chainId: arc };
}

/**
 * Arc's side, else null: its own settings and its own keys. When Arc is on, and also while it's off
 * if CITY_ARC_OWN_PAYMASTER is set: the keys must exist before the paymaster is deployed, and turning
 * Arc on for that would offer a chain nobody can use yet. This makes keys and shows their addresses;
 * nothing else of Arc wakes up.
 */
export function arcPaymasterSide(
  env: Record<string, string | undefined>,
): { env: Record<string, string | undefined>; chainId: number } | null {
  const arc = protocolArcChainIdFromEnv(env);
  if (arc !== null) return { env: arcRuntimeEnv(env), chainId: arc };
  const scoped = arcRuntimeEnv(env);
  if (ownPaymasterMode(scoped) === 'off') return null;
  return {
    env: scoped,
    chainId: Number(env.CITY_ARC_CHAIN_ID?.trim()) === ARC_TESTNET ? ARC_TESTNET : ARC_MAINNET,
  };
}

/**
 * Whose keys the server provisions at start: Base's, and Arc's when Arc is on. Each side's own mode
 * decides (provisionPaymasterKeysAtStart: 'off' makes nothing).
 */
export function paymasterSides(
  env: Record<string, string | undefined>,
): { env: Record<string, string | undefined>; chainId: number }[] {
  const arc = arcPaymasterSide(env);
  return [{ env, chainId: BASE_MAINNET }, ...(arc ? [arc] : [])];
}

/**
 * Base's upkeep and Arc's as one, for the one upkeep cron: each runs whatever the other does, and a
 * failure in either still answers as a failure once both are done.
 */
export function bothUpkeeps(
  base: OwnBundlerUpkeep | undefined,
  arc: OwnBundlerUpkeep | undefined,
): OwnBundlerUpkeep | undefined {
  if (!base || !arc) return base ?? arc;
  const both = async (run: (upkeep: OwnBundlerUpkeep) => Promise<number>) => {
    const results = await Promise.allSettled([run(base), run(arc)]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    return results.reduce((sum, r) => sum + (r as PromiseFulfilledResult<number>).value, 0);
  };
  return {
    mode: base.mode,
    maintain: (limit) => both((upkeep) => upkeep.maintain(limit)),
    open: () => both((upkeep) => upkeep.open()),
  };
}
