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
  return {
    ref: `sanctions-oracle:${input.chainId}:${oracle.toLowerCase()}`,
    supports: (chainId) => chainId === input.chainId,
    async check({ chainId, addresses, signal }): Promise<ScreeningProviderAnswer> {
      if (chainId !== input.chainId) throw new Error('unsupported chain');
      const client = await input.client();
      const results = await Promise.all(
        addresses.map((address) =>
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
      const listed: Record<string, unknown> = {};
      addresses.forEach((address, index) => {
        listed[address] = results[index];
      });
      return { listed, observedAt: now() };
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
