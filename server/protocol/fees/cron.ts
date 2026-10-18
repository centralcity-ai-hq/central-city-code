/*
 * The scheduled protocol fee scan (vercel.json "crons", every minute): one scanFees run per call,
 * at most SCAN_BLOCKS_PER_RUN blocks, so a run stays well inside the function's time limit and a
 * backlog drains over several runs.
 *
 * Live by default (docs/protocol/LIVE.md): on Base mainnet the router, the treasury and the start
 * block are fixed in code (shared/protocol.ts), so an empty environment scans. Vercel Cron calls GET
 * with `Authorization: Bearer <CRON_SECRET>`. Fail closed: without the secret, with
 * CITY_PROTOCOL_FEES set to '0' (the emergency off) or without a complete configuration (read per
 * request) the route answers 404, like an unknown path. Without a chain to read (no RPC URL) or
 * when a run fails, it answers 503 unavailable and nothing is lost: the next run starts from the
 * last checkpoint. The answer carries counts only.
 */
import type { FastifyInstance } from 'fastify';
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { CDP_RETRY } from '../../base/chain/rpc-budget.js';
import { countingFetch } from '../../base/chain/rpc-count.js';
import { BASE_NETWORKS, type BaseNetwork } from '../../../shared/base/chains.js';
import {
  liveUnlessOff,
  PROTOCOL_CHAIN_ID,
  PROTOCOL_OFF_FLAGS,
  protocolDeployment,
} from '../../../shared/protocol.js';
import type { Database } from '../../database.js';
import { cronAuthorized } from '../../wake/cron.js';
import { reportIgnoredSetting, type ProtocolLog } from '../mainnet.js';
import { scanFees, type FeeChain, type FeeLedgerConfig } from './ledger.js';

interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  blockNumber: Hex;
  blockHash: Hex;
}

export const PROTOCOL_FEE_SCAN_PATH = '/api/cron/protocol-fee-scan';
export const SCAN_BLOCKS_PER_RUN = 5_000n;
/**
 * Time one run may spend reading the chain before it commits what it confirmed (scanFees
 * `budgetMs`): well inside the minute between runs, so a long not-yet-final window drains in steps.
 */
export const SCAN_BUDGET_MS = 40_000;

/** USDC on a test network CITY_PROTOCOL_CHAIN_ID may name (Base mainnet's: shared/protocol.ts). */
const TEST_NETWORK_USDC: Record<number, Hex> = {
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const ESCROW_CONTRACT: Hex = '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c'; // same on 8453 and 84532

/** The protocol fee is live unless CITY_PROTOCOL_FEES is exactly '0' (read per request). */
export const protocolFeesEnabled = (env: Record<string, string | undefined>) =>
  liveUnlessOff(env, PROTOCOL_OFF_FLAGS.fees);

const address = (value: string | undefined): Hex | null =>
  value && isAddress(value.trim(), { strict: false }) && !/^0x0{40}$/i.test(value.trim())
    ? (getAddress(value.trim()) as Hex)
    : null;

/** The fee chain: CITY_PROTOCOL_CHAIN_ID when set (a test network), else Base mainnet. */
export function protocolFeeChainIdFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.CITY_PROTOCOL_CHAIN_ID?.trim();
  return raw ? Number(raw) : PROTOCOL_CHAIN_ID;
}

/**
 * The ledger configuration. On Base mainnet (the default chain) it is the deployment fixed in code:
 * CITY_PROTOCOL_TREASURY, CITY_PROTOCOL_ROUTER and CITY_PROTOCOL_START_BLOCK are ignored there
 * (logged once when they disagree). On a test network (CITY_PROTOCOL_CHAIN_ID 84532) they are read
 * from the environment and all three are needed. CITY_PROTOCOL_ESCROW_OPERATOR is optional on
 * both. Null when incomplete or for an unknown chain.
 */
export function protocolFeeConfigFromEnv(
  env: Record<string, string | undefined>,
  options: { log?: ProtocolLog } = {},
): FeeLedgerConfig | null {
  const chainId = protocolFeeChainIdFromEnv(env);
  const operator = address(env.CITY_PROTOCOL_ESCROW_OPERATOR);
  const deployment = protocolDeployment(chainId);
  if (deployment) {
    const ignored = (setting: string, expected: string) =>
      reportIgnoredSetting(env, setting, expected, chainId, options.log);
    ignored('CITY_PROTOCOL_ROUTER', deployment.feeRouter);
    ignored('CITY_PROTOCOL_TREASURY', deployment.treasury);
    ignored('CITY_PROTOCOL_START_BLOCK', deployment.feeRouterDeployBlock.toString());
    // A malformed optional operator leaves the escrow path out instead of the whole fee.
    if (env.CITY_PROTOCOL_ESCROW_OPERATOR?.trim() && !operator)
      ignored('CITY_PROTOCOL_ESCROW_OPERATOR', '');
    return {
      chainId,
      usdc: deployment.usdc,
      treasury: deployment.treasury,
      router: deployment.feeRouter,
      ...addedRoutersFromEnv(env),
      escrow: operator ? { address: ESCROW_CONTRACT, operator } : null,
      startBlock: deployment.feeRouterDeployBlock,
    };
  }
  const usdc = TEST_NETWORK_USDC[chainId];
  const treasury = address(env.CITY_PROTOCOL_TREASURY);
  const router = address(env.CITY_PROTOCOL_ROUTER);
  const start = env.CITY_PROTOCOL_START_BLOCK?.trim() ?? '';
  if (!usdc || !treasury || !router || !/^\d{1,12}$/.test(start)) return null;
  if (env.CITY_PROTOCOL_ESCROW_OPERATOR && !operator) return null;
  return {
    chainId,
    usdc,
    treasury,
    router,
    ...addedRoutersFromEnv(env),
    escrow: operator ? { address: ESCROW_CONTRACT, operator } : null,
    startBlock: BigInt(start),
  };
}

/**
 * Router 2 for the ledger (Operation Fee Contract, docs/protocol/FEE_ROUTER_2.md):
 * CITY_PROTOCOL_FEE_ROUTER2 (address) and CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK (its deploy block).
 * Counted whenever both are valid, independent of CITY_PROTOCOL_FEE_ROUTER2_ENABLED (which only
 * routes new payments): a fee on router 2 is revenue however it got there. Empty when unset or
 * invalid, so the ledger reads router 1 alone, exactly as before.
 */
export function protocolRouter2FromEnv(
  env: Record<string, string | undefined>,
): { address: Hex; fromBlock: bigint }[] {
  const router2 = address(env.CITY_PROTOCOL_FEE_ROUTER2);
  const from = env.CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK?.trim() ?? '';
  if (!router2 || !/^\d{1,12}$/.test(from)) return [];
  return [{ address: router2, fromBlock: BigInt(from) }];
}

/** The config field only when router 2 is set: router 1 alone keeps exactly today's config. */
const addedRoutersFromEnv = (env: Record<string, string | undefined>) => {
  const added = protocolRouter2FromEnv(env);
  return added.length ? { addedRouters: added } : {};
};

/**
 * The treasury a fee on `chainId` must reach: the one fixed in code on Base mainnet, else
 * CITY_PROTOCOL_TREASURY when it is a valid address (lowercase), else null (nothing to compare).
 */
export function protocolTreasuryFor(
  env: Record<string, string | undefined>,
  chainId: number,
): string | null {
  const deployment = protocolDeployment(chainId);
  if (deployment) return deployment.treasury.toLowerCase();
  return address(env.CITY_PROTOCOL_TREASURY)?.toLowerCase() ?? null;
}

/** The chain reads a scan needs, from a viem client for the configured chain. */
export function viemFeeChain(client: PublicClient): FeeChain {
  return {
    latestBlock: () => client.getBlockNumber(),
    finalizedBlock: async () => (await client.getBlock({ blockTag: 'finalized' })).number,
    block: async (blockNumber) => {
      const b = await client.getBlock({ blockNumber });
      return { timestamp: b.timestamp, hash: b.hash as Hex };
    },
    // Raw eth_getLogs so the topic filter reaches the node (viem's getLogs takes events, not
    // raw topics): USDC is asked only for Transfer events to the treasury.
    getLogs: async ({ address: emitter, fromBlock, toBlock, topics }) => {
      const logs = (await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: emitter,
            fromBlock: toHex(fromBlock),
            toBlock: toHex(toBlock),
            ...(topics ? { topics } : {}),
          },
        ],
      } as never)) as RpcLog[];
      return logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        transactionHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
        blockNumber: BigInt(log.blockNumber),
        blockHash: log.blockHash,
      }));
    },
  };
}

export interface ProtocolFeeCronDeps {
  db: Database;
  cronSecret: string | undefined;
  /** Read per request (server/app.ts passes process.env). */
  env: Record<string, string | undefined>;
  /** The chain client for a chain id, or null when that chain has no RPC configured. */
  chainFor: (chainId: number) => FeeChain | null;
  log?: (line: string) => void;
}

export function registerProtocolFeeCron(app: FastifyInstance, deps: ProtocolFeeCronDeps): void {
  app.get(PROTOCOL_FEE_SCAN_PATH, async (request, reply) => {
    const notFound = () => reply.code(404).send({ error: 'Not found.' });
    if (!cronAuthorized(request.headers.authorization, deps.cronSecret)) return notFound();
    if (!protocolFeesEnabled(deps.env)) return notFound();
    const log = deps.log ?? console.info;
    const config = protocolFeeConfigFromEnv(deps.env, { log });
    if (!config) return notFound();
    // On, configured, but nothing to read the chain with (or the run failed): reported, never a
    // crash. Nothing is written by a failed run; the next one resumes from the checkpoint.
    const unavailable = (reason: 'no_rpc' | 'scan_failed') =>
      reply.code(503).header('Cache-Control', 'no-store').send({ error: 'unavailable', reason });
    const chain = deps.chainFor(config.chainId);
    if (!chain) return unavailable('no_rpc');
    let run: Awaited<ReturnType<typeof scanFees>>;
    try {
      run = await scanFees(deps.db, chain, config, {
        maxBlocks: SCAN_BLOCKS_PER_RUN,
        budgetMs: SCAN_BUDGET_MS,
      });
    } catch (error) {
      // The error's kind only: a message can carry an RPC URL.
      log(
        JSON.stringify({
          event: 'protocol.fee_scan_failed',
          error: error instanceof Error ? error.constructor.name : 'unknown',
        }),
      );
      return unavailable('scan_failed');
    }
    const result = run
      ? {
          from: run.from.toString(),
          to: run.to.toString(),
          written: run.written,
          removed: run.removed,
          busy: run.busy === true,
          ...(run.partial ? { partial: run.partial } : {}),
        }
      : { idle: true };
    if (run && (run.written || run.removed || run.busy || run.partial))
      log(JSON.stringify({ event: 'protocol.fee_scan', ...result }));
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}

/**
 * The RPC URL the fee scan reads `chainId` with: CITY_PROTOCOL_RPC_URL when set, else the RPC the
 * app already uses for that network's wallet reads (shared/base/chains.ts `bundlerEnv`:
 * CITY_BASE_CDP_RPC_URL on Base mainnet). Https only; null otherwise (the scan is unavailable).
 * Never logged.
 */
export function protocolFeeRpcUrl(
  env: Record<string, string | undefined>,
  chainId: number,
): string | null {
  const network = (BASE_NETWORKS as Record<number, BaseNetwork | undefined>)[chainId];
  const url =
    env.CITY_PROTOCOL_RPC_URL?.trim() || (network ? env[network.bundlerEnv]?.trim() : undefined);
  return url && url.startsWith('https://') ? url : null;
}

/**
 * The chain reader for the configured chain (protocolFeeRpcUrl), checked to be on that chain by
 * the first read. Null without an RPC URL (the scan answers 503 unavailable).
 */
export function protocolFeeChainFromEnv(
  env: Record<string, string | undefined>,
): (chainId: number) => FeeChain | null {
  const clients = new Map<string, FeeChain>();
  return (chainId) => {
    const url = protocolFeeRpcUrl(env, chainId);
    if (!url) return null;
    const key = `${chainId} ${url}`;
    let chain = clients.get(key);
    if (!chain) {
      const client = createPublicClient({
        // The shared CDP retry policy, not the library default of three: the scan often reads the
        // same endpoint as live payments, and the next run starts from the checkpoint anyway.
        transport: http(url, {
          timeout: 20_000,
          fetchFn: countingFetch('fees:configured'),
          ...CDP_RETRY,
        }),
      });
      const inner = viemFeeChain(client as PublicClient);
      let checked = false;
      const check = async () => {
        if (checked) return;
        if ((await client.getChainId()) !== chainId)
          throw new Error('The protocol fee RPC is not on the configured chain.');
        checked = true;
      };
      chain = {
        latestBlock: async () => (await check(), inner.latestBlock()),
        finalizedBlock: () => inner.finalizedBlock(),
        block: (n) => inner.block(n),
        getLogs: (input) => inner.getLogs(input),
      };
      clients.set(key, chain);
    }
    return chain;
  };
}

/** The fee chain id while fees are on and configured (Base mainnet by default), else null. */
export function protocolFeeChainId(env: Record<string, string | undefined>): number | null {
  if (!protocolFeesEnabled(env)) return null;
  return protocolFeeConfigFromEnv(env)?.chainId ?? null;
}
