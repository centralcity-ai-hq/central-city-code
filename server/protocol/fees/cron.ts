/*
 * The scheduled protocol fee scan (vercel.json "crons", every 5 minutes): one scanFees run per call,
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
import { chainCountKey, countingFetch } from '../../base/chain/rpc-count.js';
import { ARC_MAINNET, ARC_USDC, arcNetwork, isRealMoneyChain } from '../../../shared/chains.js';
import { BASE_NETWORKS, type BaseNetwork } from '../../../shared/base/chains.js';
import {
  liveUnlessOff,
  PROTOCOL_CHAIN_ID,
  PROTOCOL_OFF_FLAGS,
  protocolDeployment,
  reservedPayees,
  type ProtocolDeployment,
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
 * `budgetMs`): well inside the function's time limit and the 5 minutes between runs, so a long
 * not-yet-final window drains in steps.
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

/** The values CITY_PROTOCOL_CHAIN_ID may take: Base mainnet and Base Sepolia. */
export const PROTOCOL_FEE_CHAIN_IDS: readonly number[] = [8453, 84532];
const invalidChainReported = new Set<string>();

/**
 * The fee chain: CITY_PROTOCOL_CHAIN_ID when set (8453 or 84532 exactly), else Base mainnet. A set
 * value that is neither ('base', '8453,', '1') never turns the fee off: it is logged once
 * (protocol.setting_invalid, the setting's name only) and the code-fixed Base mainnet deployment
 * applies (CCA-137).
 */
export function protocolFeeChainIdFromEnv(
  env: Record<string, string | undefined>,
  log: ProtocolLog = console.warn,
): number {
  const raw = env.CITY_PROTOCOL_CHAIN_ID?.trim();
  if (!raw) return PROTOCOL_CHAIN_ID;
  if (/^[0-9]{1,6}$/.test(raw) && PROTOCOL_FEE_CHAIN_IDS.includes(Number(raw))) return Number(raw);
  if (!invalidChainReported.has(raw)) {
    invalidChainReported.add(raw);
    log(JSON.stringify({ event: 'protocol.setting_invalid', setting: 'CITY_PROTOCOL_CHAIN_ID' }));
  }
  return PROTOCOL_CHAIN_ID;
}

/**
 * The ledger configuration. On Base mainnet (the default chain) it is the deployment fixed in code:
 * CITY_PROTOCOL_TREASURY, CITY_PROTOCOL_ROUTER and CITY_PROTOCOL_START_BLOCK (and the router 2 and
 * router 3 settings) are ignored there (logged once when they disagree). On a test network (CITY_PROTOCOL_CHAIN_ID 84532) they are read
 * from the environment and all three are needed. CITY_PROTOCOL_ESCROW_OPERATOR is optional on
 * both. Null when incomplete or for an unknown chain.
 */
export function protocolFeeConfigFromEnv(
  env: Record<string, string | undefined>,
  options: { log?: ProtocolLog } = {},
): FeeLedgerConfig | null {
  const chainId = protocolFeeChainIdFromEnv(env, options.log);
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
      ...addedRoutersFromEnv(env, options.log),
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
 * An added router from `setting` (address) and `${setting}_FROM_BLOCK` (its deploy block). On Base
 * mainnet it is the one fixed in code (`pinned`): both settings are ignored there (logged once when
 * they disagree), so unsetting or changing them never drops a router calls are pinned to. On a test
 * network both are read from the environment; empty when unset or invalid.
 */
function addedRouterFromEnv(
  env: Record<string, string | undefined>,
  setting: string,
  pinned: (d: ProtocolDeployment) => { address: string; fromBlock: bigint },
  log?: ProtocolLog,
): { address: Hex; fromBlock: bigint }[] {
  const chainId = protocolFeeChainIdFromEnv(env);
  const deployment = protocolDeployment(chainId);
  if (deployment) {
    const fixed = pinned(deployment);
    reportIgnoredSetting(env, setting, fixed.address, chainId, log);
    reportIgnoredSetting(env, `${setting}_FROM_BLOCK`, fixed.fromBlock.toString(), chainId, log);
    return [{ address: getAddress(fixed.address) as Hex, fromBlock: fixed.fromBlock }];
  }
  const router = address(env[setting]);
  const from = env[`${setting}_FROM_BLOCK`]?.trim() ?? '';
  if (!router || !/^\d{1,12}$/.test(from)) return [];
  return [{ address: router, fromBlock: BigInt(from) }];
}

/**
 * Router 2 for the ledger (Operation Fee Contract, docs/protocol/FEE_ROUTER_2.md): fixed in code on
 * Base mainnet; on a test network CITY_PROTOCOL_FEE_ROUTER2 (address) and
 * CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK (its deploy block). Counted whenever known, independent of
 * CITY_PROTOCOL_FEE_ROUTER2_ENABLED (which only routes new payments): a fee on router 2 is revenue
 * however it got there. Empty on a test network when unset or invalid, so the ledger reads router 1
 * alone there.
 */
export function protocolRouter2FromEnv(
  env: Record<string, string | undefined>,
  options: { log?: ProtocolLog } = {},
): { address: Hex; fromBlock: bigint }[] {
  return addedRouterFromEnv(
    env,
    'CITY_PROTOCOL_FEE_ROUTER2',
    (d) => ({ address: d.feeRouter2, fromBlock: d.feeRouter2DeployBlock }),
    options.log,
  );
}

/**
 * Router 3 for the ledger (x402 settlement, docs/protocol/FEE_ROUTER_3.md): the same FeeCharged
 * event (kind 1, fee included) from another address, configured exactly like router 2 (fixed in
 * code on Base mainnet; on a test network CITY_PROTOCOL_FEE_ROUTER3 and
 * CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK). Counted whenever known, independent of
 * CITY_PROTOCOL_FEE_ROUTER3_ENABLED (which only routes new payments).
 */
export function protocolRouter3FromEnv(
  env: Record<string, string | undefined>,
  options: { log?: ProtocolLog } = {},
): { address: Hex; fromBlock: bigint }[] {
  return addedRouterFromEnv(
    env,
    'CITY_PROTOCOL_FEE_ROUTER3',
    (d) => ({ address: d.feeRouter3, fromBlock: d.feeRouter3DeployBlock }),
    options.log,
  );
}

/**
 * The config field only when router 2 or router 3 is known: router 1 alone keeps exactly the old
 * config. One entry per address (the first wins), so a router never read twice.
 */
const addedRoutersFromEnv = (env: Record<string, string | undefined>, log?: ProtocolLog) => {
  const added: { address: Hex; fromBlock: bigint }[] = [];
  for (const r of [
    ...protocolRouter2FromEnv(env, { log }),
    ...protocolRouter3FromEnv(env, { log }),
  ])
    if (!added.some((a) => a.address.toLowerCase() === r.address.toLowerCase())) added.push(r);
  return added.length ? { addedRouters: added } : {};
};

/**
 * The payees no payment may name (shared/protocol.ts reservedPayees): Base mainnet's fixed
 * addresses plus, on a test network, its configured routers, treasury and USDC.
 */
export function protocolReservedPayees(
  env: Record<string, string | undefined>,
): ReadonlySet<string> {
  const config = protocolFeeConfigFromEnv(env);
  // The public x402 facilitator's sender is a facilitator too, never a seller.
  const publicSettle = address(env.CITY_X402_PUBLIC_SETTLE_ADDRESS);
  const arcRouter = address(env.CITY_ARC_FEE_ROUTER3);
  return reservedPayees(
    config
      ? [
          arcRouter,
          config.router,
          config.treasury,
          config.usdc,
          ...(config.addedRouters ?? []).map((r) => r.address),
          publicSettle,
        ]
      : [address(env.CITY_PROTOCOL_TREASURY), publicSettle, arcRouter],
  );
}

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
      return logs.map(chainLog);
    },
    // Every log of one block from its receipts (no per-answer log cap); a node without
    // eth_getBlockReceipts throws and the scan fails as before.
    blockLogs: async (blockNumber) => {
      const receipts = (await client.request({
        method: 'eth_getBlockReceipts',
        params: [toHex(blockNumber)],
      } as never)) as { logs: RpcLog[] }[] | null;
      if (!Array.isArray(receipts)) throw new Error('No receipts for this block.');
      return receipts.flatMap((receipt) => receipt.logs.map(chainLog));
    },
    header: async (blockNumber) => {
      const b = await client.getBlock({ blockNumber });
      return { hash: b.hash as Hex, logsBloom: b.logsBloom as Hex };
    },
    // By hash: a correctly behaving node without that block answers an error, not an empty list
    // (CCA-107). This is a trust assumption on the endpoint: a backend answering empty here AND for
    // the range read still lets a bloom-matching block finalise (stated in docs/protocol/FEES.md).
    logsAtHash: async (blockHash, addresses) => {
      const logs = (await client.request({
        method: 'eth_getLogs',
        params: [{ blockHash, address: [...addresses] }],
      } as never)) as RpcLog[];
      return logs.map(chainLog);
    },
  };
}

const chainLog = (log: RpcLog) => ({
  address: log.address,
  topics: log.topics,
  data: log.data,
  transactionHash: log.transactionHash,
  logIndex: Number(BigInt(log.logIndex)),
  blockNumber: BigInt(log.blockNumber),
  blockHash: log.blockHash,
});

export interface ProtocolFeeCronDeps {
  db: Database;
  cronSecret: string | undefined;
  /** Read per request (server/app.ts passes process.env). */
  env: Record<string, string | undefined>;
  /** The chain client for a chain id, or null when that chain has no RPC configured. */
  chainFor: (chainId: number) => FeeChain | null;
  log?: (line: string) => void;
  /**
   * The Arc chain reader (default protocolArcFeeChainFromEnv(env)). Asked only when the Arc pass
   * has a config (CITY_ARC=1 and a router 3 on Arc).
   */
  arcChainFor?: (chainId: number) => FeeChain | null;
}

/** The Arc pass's own limits: after the Base pass, never in its time. */
export const ARC_SCAN_BUDGET_MS = 15_000;
export const ARC_SCAN_TIMEOUT_MS = 30_000;
/**
 * The widest eth_getLogs range of the Arc pass: production reads Arc's public node, which refuses
 * wide ranges and rate-limits (ledger.ts GentleScan).
 */
export const ARC_LOG_RANGE = 500n;

/** Arc's network id while Arc is on (CITY_ARC=1; CITY_ARC_CHAIN_ID, default Arc mainnet), else null. */
export function protocolArcChainIdFromEnv(env: Record<string, string | undefined>): number | null {
  const id = Number(env.CITY_ARC_CHAIN_ID?.trim() || ARC_MAINNET);
  return arcNetwork(id, env) ? id : null;
}

/**
 * Router 3 on an Arc network, from where the ledger takes it: the deployment fixed in code for that
 * id when there is one, else CITY_ARC_FEE_ROUTER3. Null when neither names one.
 */
export function protocolArcRouter3Address(
  env: Record<string, string | undefined>,
  chainId: number,
  deploymentFor: (chainId: number) => ProtocolDeployment | null = protocolDeployment,
): Hex | null {
  const deployment = deploymentFor(chainId);
  return deployment
    ? (getAddress(deployment.feeRouter3) as Hex)
    : address(env.CITY_ARC_FEE_ROUTER3);
}

/**
 * The treasury a fee on an Arc network must reach: Base mainnet's, the owner's decision. A test
 * network may name a throwaway one (CITY_ARC_TREASURY); a real-money network can't. Never nothing:
 * Arc has no deployment fixed in code to fall back on.
 */
export function arcTreasuryFor(
  env: Record<string, string | undefined>,
  chainId: number,
): string | null {
  const own = env.CITY_ARC_TREASURY?.trim().toLowerCase();
  if (!isRealMoneyChain(chainId) && own && /^0x[0-9a-f]{40}$/.test(own)) return own;
  return protocolTreasuryFor(env, PROTOCOL_CHAIN_ID);
}

/**
 * The ledger configuration for Arc, or null (no Arc pass at all: no query, no RPC). Arc has router
 * 3 only (no router 1/2, no escrow): the deployment fixed in code for the Arc id when there is one,
 * else CITY_ARC_FEE_ROUTER3 and CITY_ARC_FEE_ROUTER3_FROM_BLOCK. Router 3 takes the router slot, so
 * its FeeCharged rows are read exactly as on Base (source 'router', its address as emitter). The
 * treasury is the one its fees reach (arcTreasuryFor): the ledger needs its transfer to back each
 * fee; USDC is Arc's.
 */
export function protocolArcFeeConfigFromEnv(
  env: Record<string, string | undefined>,
  deploymentFor: (chainId: number) => ProtocolDeployment | null = protocolDeployment,
): FeeLedgerConfig | null {
  const chainId = protocolArcChainIdFromEnv(env);
  if (chainId === null) return null;
  const deployment = deploymentFor(chainId);
  let router: { address: Hex; fromBlock: bigint } | null = null;
  if (deployment) {
    router = {
      address: getAddress(deployment.feeRouter3) as Hex,
      fromBlock: deployment.feeRouter3DeployBlock,
    };
  } else {
    const addr = address(env.CITY_ARC_FEE_ROUTER3);
    const from = env.CITY_ARC_FEE_ROUTER3_FROM_BLOCK?.trim() ?? '';
    if (addr && /^\d{1,12}$/.test(from)) router = { address: addr, fromBlock: BigInt(from) };
  }
  const treasury = address(arcTreasuryFor(env, chainId) ?? undefined);
  if (!router || !treasury) return null;
  return {
    chainId,
    usdc: ARC_USDC as Hex,
    treasury,
    router: router.address,
    escrow: null,
    startBlock: router.fromBlock,
  };
}

/**
 * The Arc chain reader: CITY_ARC_RPC_URL, else Arc's public RPC (https only), counted under Arc's
 * own key. Arc is final at inclusion, so the head is the final block (no 'finalized' tag wait).
 */
export function protocolArcFeeChainFromEnv(
  env: Record<string, string | undefined>,
): (chainId: number) => FeeChain | null {
  const clients = new Map<string, FeeChain>();
  return (chainId) => {
    const network = arcNetwork(chainId, env);
    if (!network) return null;
    const url = env.CITY_ARC_RPC_URL?.trim() || network.publicRpcUrl;
    if (!url.startsWith('https://')) return null;
    const key = `${chainId} ${url}`;
    let chain = clients.get(key);
    if (!chain) {
      const client = createPublicClient({
        transport: http(url, {
          timeout: 20_000,
          fetchFn: countingFetch(chainCountKey(chainId, 'fees:configured')),
          ...CDP_RETRY,
        }),
      });
      chain = arcFeeChain(viemFeeChain(client as PublicClient), () => client.getChainId(), chainId);
      clients.set(key, chain);
    }
    return chain;
  };
}

/** A reader checked to be on `chainId` by its first read, whose final block is the head. */
export function arcFeeChain(
  inner: FeeChain,
  getChainId: () => Promise<number>,
  chainId: number,
): FeeChain {
  let checked = false;
  let head: bigint | null = null;
  return {
    latestBlock: async () => {
      if (!checked) {
        if ((await getChainId()) !== chainId)
          throw new Error('The Arc RPC is not on the configured chain.');
        checked = true;
      }
      head = await inner.latestBlock();
      return head;
    },
    // Final at inclusion: the head this run read is final (one read, never above the scan's head).
    finalizedBlock: async () => head ?? inner.latestBlock(),
    block: (n) => inner.block(n),
    getLogs: (input) => inner.getLogs(input),
    ...(inner.blockLogs ? { blockLogs: (n: bigint) => inner.blockLogs!(n) } : {}),
    header: (n) => inner.header(n),
    logsAtHash: (hash, addresses) => inner.logsAtHash(hash, addresses),
  };
}

/** The Arc pass: never throws, never runs without a config; one line when it fails. */
async function arcPass(deps: ProtocolFeeCronDeps, log: (line: string) => void) {
  const config = protocolArcFeeConfigFromEnv(deps.env);
  if (!config) return undefined;
  const failed = (error: unknown) => {
    log(
      JSON.stringify({
        event: 'protocol_fee_scan.arc_failed',
        error: error instanceof Error ? error.constructor.name : 'unknown',
      }),
    );
    return { failed: true as const };
  };
  try {
    const chain = (deps.arcChainFor ?? protocolArcFeeChainFromEnv(deps.env))(config.chainId);
    if (!chain) return failed(new Error('no_rpc'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = await Promise.race([
      scanFees(deps.db, chain, config, {
        maxBlocks: SCAN_BLOCKS_PER_RUN,
        budgetMs: ARC_SCAN_BUDGET_MS,
        log,
        gentle: { logRange: ARC_LOG_RANGE },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ARC_SCAN_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!run) return { idle: true };
    return {
      from: run.from.toString(),
      to: run.to.toString(),
      written: run.written,
      removed: run.removed,
      busy: run.busy === true,
      ...(run.partial ? { partial: run.partial } : {}),
    };
  } catch (error) {
    return failed(error);
  }
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
        log,
      });
    } catch (error) {
      // The error's kind only: a message can carry an RPC URL.
      log(
        JSON.stringify({
          event: 'protocol.fee_scan_failed',
          error: error instanceof Error ? error.constructor.name : 'unknown',
        }),
      );
      await arcPass(deps, log);
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
    // After the Base pass, never before it; present in the answer only when Arc ran.
    const arc = await arcPass(deps, log);
    if (arc) return reply.header('Cache-Control', 'no-store').send({ ...result, arc });
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
        // The ledger's fallback for a range the node still refuses (ledger.ts splitLogs).
        blockLogs: (n) => inner.blockLogs!(n),
        // The confirmation of blocks without a fee log (ledger.ts emptyBlocksConfirmed).
        header: (n) => inner.header(n),
        logsAtHash: (hash, addresses) => inner.logsAtHash(hash, addresses),
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
