/*
 * The first screening provider (docs/protocol/SCREENING-GATE.md): an on-chain sanctions oracle
 * with the read-only `isSanctioned(address) returns (bool)`, called through the chain runtime's
 * public client. On Base mainnet its address is fixed in code (shared/protocol.ts; a
 * CITY_PROTOCOL_SCREENING_ORACLE there is ignored, logged once when it disagrees). On another chain
 * it comes only from CITY_PROTOCOL_SCREENING_ORACLE; without it the gate has no provider there and
 * every new submission is refused (fail closed).
 *
 * Only reads. The contract covers its maintainer's sanctions list; it is not a KYT service and not
 * a legal determination (SCREENING.md, "Coverage and responsibility").
 */
import { getAddress, isAddress, parseAbi, type Hex, type PublicClient } from 'viem';
import { protocolDeployment } from '../../../shared/protocol.js';
import { reportIgnoredSetting, type ProtocolLog } from '../mainnet.js';
import {
  SCREENING_ORACLE_FLAG,
  type ScreeningProvider,
  type ScreeningProviderAnswer,
} from './gate.js';

export const sanctionsOracleAbi = parseAbi([
  'function isSanctioned(address addr) view returns (bool)',
]);

export type OracleReader = Pick<PublicClient, 'readContract'>;

/** The waits before reading the oracle again after a failed read: two more tries in ~1 s. */
export const ORACLE_READ_WAITS_MS = [250, 750] as const;
/** How long one address's oracle answer is reused (well inside SCREENING_MAX_AGE_MS). */
export const ORACLE_CACHE_MS = 60_000;
/** At most this many addresses are remembered; past it the cache starts over. */
export const ORACLE_CACHE_MAX = 10_000;

/**
 * One oracle read, asked again after a short wait when the node did not answer (a throttled or
 * dropped read), within the gate's own deadline (`signal`). Only the read is repeated: an answer is
 * never reinterpreted, and when every try fails the error stands, so the gate still fails closed.
 */
async function readWithRetry<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (signal.aborted || attempt >= ORACLE_READ_WAITS_MS.length) throw error;
      await wait(ORACLE_READ_WAITS_MS[attempt]!);
      if (signal.aborted) throw error;
    }
  }
}

export function sanctionsOracleProvider(input: {
  chainId: number;
  oracle: Hex;
  /** The chain's read client; throws (or rejects) when the chain is not configured. */
  client: () => Promise<OracleReader>;
  now?: () => number;
  /** Waits between read attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}): ScreeningProvider {
  const now = input.now ?? Date.now;
  const wait = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const oracle = getAddress(input.oracle);
  // The oracle's answer per address, reused for ORACLE_CACHE_MS. The same wallets, floats and
  // sellers are screened on every payment; at Block D's volume one read per party per payment
  // flooded the RPC (screening_unavailable). The answer still carries the time of its oldest read,
  // so the gate's SCREENING_MAX_AGE_MS applies unchanged.
  const cache = new Map<string, { listed: unknown; at: number }>();
  return {
    ref: `sanctions-oracle:${input.chainId}:${oracle.toLowerCase()}`,
    supports: (chainId) => chainId === input.chainId,
    async check({ chainId, addresses, signal }): Promise<ScreeningProviderAnswer> {
      if (chainId !== input.chainId) throw new Error('unsupported chain');
      // Taken once per check, so a cache that starts over below cannot drop an answer in use.
      const answers = new Map<string, { listed: unknown; at: number }>();
      for (const address of addresses) {
        const hit = cache.get(address.toLowerCase());
        if (hit && now() - hit.at < ORACLE_CACHE_MS) answers.set(address, hit);
      }
      const missing = addresses.filter((address) => !answers.has(address));
      if (missing.length) {
        const client = await input.client();
        const at = now();
        const results = await Promise.all(
          missing.map((address) =>
            readWithRetry(
              () =>
                client.readContract({
                  address: oracle,
                  abi: sanctionsOracleAbi,
                  functionName: 'isSanctioned',
                  args: [getAddress(address)],
                }),
              signal,
              wait,
            ),
          ),
        );
        if (signal.aborted) throw new Error('aborted');
        if (cache.size + missing.length > ORACLE_CACHE_MAX) cache.clear();
        missing.forEach((address, index) => {
          const answer = { listed: results[index], at };
          cache.set(address.toLowerCase(), answer);
          answers.set(address, answer);
        });
      }
      const listed: Record<string, unknown> = {};
      let observedAt = now();
      for (const address of addresses) {
        const hit = answers.get(address)!;
        listed[address] = hit.listed;
        observedAt = Math.min(observedAt, hit.at);
      }
      return { listed, observedAt };
    },
  };
}

/**
 * The sanctions oracle for `chainId`: on Base mainnet the one fixed in code, elsewhere the one
 * CITY_PROTOCOL_SCREENING_ORACLE names, or null when that is missing or not an address.
 */
export function sanctionsOracleFor(
  env: Record<string, string | undefined>,
  chainId: number,
  client: () => Promise<OracleReader>,
  options: { log?: ProtocolLog } = {},
): ScreeningProvider | null {
  const deployment = protocolDeployment(chainId);
  if (deployment) {
    reportIgnoredSetting(
      env,
      SCREENING_ORACLE_FLAG,
      deployment.sanctionsOracle,
      chainId,
      options.log,
    );
    return sanctionsOracleProvider({ chainId, oracle: deployment.sanctionsOracle, client });
  }
  const value = env[SCREENING_ORACLE_FLAG]?.trim();
  if (!value || !isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) return null;
  return sanctionsOracleProvider({ chainId, oracle: value as Hex, client });
}
