/*
 * Protocol fee ledger (docs/protocol/FEES.md, "Ledger"). One row per on-chain fee, keyed by
 * (chain_id, tx_hash, log_index), built only from logs of the allowed emitters:
 * - CentralCityFeeRouter `FeeCharged` (fee on top, or fee included through the router);
 * - AuthCaptureEscrow `PaymentCharged` whose operator is ours, token is USDC and fee receiver is
 *   the treasury (fee included through auth-capture).
 * A row is only written when the same transaction also carries the USDC Transfer of exactly the
 * fee to the treasury: an event alone is not proof that the fee moved.
 *
 * Scans are resumable and idempotent: each scan starts `REORG_DEPTH` blocks before the stored
 * checkpoint, or at the first block not verified as final when that is earlier, never inside the
 * verified final prefix; it replaces every row in the rescanned range with what the chain says now
 * (so a reorged log disappears), and advances the checkpoint in the same transaction. A block is
 * promoted to final only after a second run's read agrees with the first and, for a block with no
 * log of a fee source, after its logsBloom (or a read by its hash) rules a fee out (CCA-107,
 * scanFees). Live: server/app.ts
 * registers the migration and the scheduled scan (cron.ts) runs it.
 */
import {
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  hexToBytes,
  keccak256,
  pad,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem';
import { protocolDeployment } from '../../../shared/protocol.js';
import type { Database } from '../../database.js';
import type { Migration } from '../../migrations.js';

export const PROTOCOL_FEE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS protocol_fee_events (
  chain_id integer NOT NULL CHECK (chain_id IN (8453,84532,31337)),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  emitter text NOT NULL CHECK (emitter ~ '^0x[0-9a-f]{40}$'),
  source text NOT NULL CHECK (source IN ('router','escrow')),
  kind smallint NOT NULL CHECK (kind IN (0,1)),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_time bigint NOT NULL CHECK (block_time >= 0),
  payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  payee text NOT NULL CHECK (payee ~ '^0x[0-9a-f]{40}$'),
  ref text NOT NULL CHECK (ref ~ '^0x[0-9a-f]{64}$'),
  gross numeric(78,0) NOT NULL CHECK (gross > 0),
  fee numeric(78,0) NOT NULL CHECK (fee > 0 AND fee <= gross),
  finalized boolean NOT NULL DEFAULT false,
  -- The service behind the fee is proven: atomic for kind 1 (router pay, escrow charge); for a
  -- fee-on-top call (kind 0) only once its seller settlement is matched. Volume counts only these.
  service_verified boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS protocol_fee_events_block ON protocol_fee_events(chain_id, block_number);
CREATE INDEX IF NOT EXISTS protocol_fee_events_ref ON protocol_fee_events(chain_id, payer, ref);
CREATE TABLE IF NOT EXISTS protocol_fee_scan_state (
  chain_id integer PRIMARY KEY CHECK (chain_id IN (8453,84532,31337)),
  next_block bigint NOT NULL CHECK (next_block >= 0),
  finalized_through bigint CHECK (finalized_through >= 0),
  -- The last scan reached the chain head: history is complete from the start block. After a
  -- restore (no row) or while a backlog drains, public totals are labelled incomplete.
  caught_up boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL
);`;

/** Migration 113 `protocol_fee_ledger` (registered in server/app.ts). */
export const protocolFeeLedgerMigration: Migration = {
  version: 113,
  name: 'protocol_fee_ledger',
  sql: PROTOCOL_FEE_LEDGER_SQL,
};

export const PROTOCOL_FEE_TABLES = ['protocol_fee_events', 'protocol_fee_scan_state'] as const;

/** Blocks rescanned before the checkpoint on every scan, so a reorg inside them is corrected. */
export const REORG_DEPTH = 64n;
/** Largest getLogs range per request (public Base RPCs refuse wider ranges). */
export const MAX_LOG_RANGE = 1_000n;
/** Rows per INSERT statement of a scan. */
const INSERT_BATCH = 200;

const PAYMENT_INFO =
  '(address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt)';
export const FEE_EVENTS_ABI = parseAbi([
  'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)',
  `event PaymentCharged(bytes32 indexed paymentInfoHash, ${PAYMENT_INFO} paymentInfo, uint256 amount, address tokenCollector, uint256 feeAmount, address feeReceiver)`,
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export interface FeeLedgerConfig {
  chainId: number;
  usdc: Hex;
  treasury: Hex;
  /** CentralCityFeeRouter address, or null before it is deployed. */
  router: Hex | null;
  /**
   * Fee routers added after the first (router 2, payments above 0.10 USDC; router 3, x402
   * settlement): the same FeeCharged event from another address, read and counted exactly like
   * router 1 from its deploy block.
   */
  addedRouters?: readonly { address: Hex; fromBlock: bigint }[];
  /** AuthCaptureEscrow and the operator whose charges are ours, or null when unused. */
  escrow: { address: Hex; operator: Hex } | null;
  /** First block worth scanning (the router's deployment block). */
  startBlock: bigint;
}

export interface ChainLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
}

/** The chain reads a scan needs; a viem PublicClient satisfies it through a thin adapter. */
export interface FeeChain {
  latestBlock(): Promise<bigint>;
  finalizedBlock(): Promise<bigint>;
  /** The canonical block at a height: its timestamp and hash. */
  block(blockNumber: bigint): Promise<{ timestamp: bigint; hash: Hex }>;
  /** Logs of one emitter; `topics` filters like eth_getLogs (null = any value at that position). */
  getLogs(input: {
    address: Hex;
    fromBlock: bigint;
    toBlock: bigint;
    topics?: (Hex | null)[];
  }): Promise<ChainLog[]>;
  /**
   * Every log of one block, from its receipts (eth_getBlockReceipts: no cap on the number of
   * logs). Optional: read only when a range of MIN_LOG_RANGE blocks or fewer is still refused.
   */
  blockLogs?(blockNumber: bigint): Promise<ChainLog[]>;
  /**
   * The canonical header at a height: its hash and logsBloom (CCA-107: an empty answer for a
   * block is final only when its bloom rules out a fee of ours, see emptyBlocksConfirmed).
   */
  header(blockNumber: bigint): Promise<{ hash: Hex; logsBloom: Hex }>;
  /**
   * The logs of `addresses` in the block with this hash (eth_getLogs by blockHash): a node that
   * does not have that block answers an error, not an empty list.
   */
  logsAtHash(blockHash: Hex, addresses: readonly Hex[]): Promise<ChainLog[]>;
}

export interface FeeRow {
  chainId: number;
  txHash: Hex;
  logIndex: number;
  emitter: Hex;
  source: 'router' | 'escrow';
  kind: 0 | 1;
  blockNumber: bigint;
  blockHash: Hex;
  payer: Hex;
  payee: Hex;
  ref: Hex;
  gross: bigint;
  fee: bigint;
}

const lower = (a: string) => a.toLowerCase() as Hex;
const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/** Turns raw logs of one range into fee rows; rows without a matching treasury transfer are dropped. */
/** The log comes from one of the configured fee routers (router 1 or an added one). */
function isFeeRouter(config: FeeLedgerConfig, emitter: Hex, blockNumber: bigint): boolean {
  if (config.router && same(emitter, config.router)) return true;
  // An added router counts only from its configured deploy block on.
  return (config.addedRouters ?? []).some(
    (r) => same(emitter, r.address) && blockNumber >= r.fromBlock,
  );
}

export function feeRowsFromLogs(config: FeeLedgerConfig, logs: readonly ChainLog[]): FeeRow[] {
  return feeRowsAndGaps(config, logs).rows;
}

/**
 * feeRowsFromLogs, plus the lowest block holding a fee event of ours (a configured router's
 * FeeCharged, or our escrow charge) that passes every check but its treasury transfer. Every such
 * event moves its fee to the treasury in the same transaction, so a missing transfer means the
 * USDC log read was incomplete (a backend behind the others), not that no fee moved (CCA-107).
 */
export function feeRowsAndGaps(
  config: FeeLedgerConfig,
  logs: readonly ChainLog[],
): { rows: FeeRow[]; unbacked: bigint | null } {
  const transfers = new Map<string, bigint[]>();
  const rows: FeeRow[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: FEE_EVENTS_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName === 'Transfer') {
      if (!same(log.address, config.usdc) || !same(decoded.args.to, config.treasury)) continue;
      const key = `${lower(log.transactionHash)}:${lower(log.blockHash)}`;
      transfers.set(key, [...(transfers.get(key) ?? []), decoded.args.value]);
      continue;
    }
    const base = {
      chainId: config.chainId,
      txHash: lower(log.transactionHash),
      logIndex: log.logIndex,
      emitter: lower(log.address),
      blockNumber: log.blockNumber,
      blockHash: lower(log.blockHash),
    };
    if (decoded.eventName === 'FeeCharged') {
      if (!isFeeRouter(config, log.address, log.blockNumber)) continue;
      const a = decoded.args;
      if (a.kind !== 0 && a.kind !== 1) continue;
      rows.push({
        ...base,
        source: 'router',
        kind: a.kind,
        payer: lower(a.payer),
        payee: lower(a.payee),
        ref: lower(a.ref),
        gross: a.gross,
        fee: a.fee,
      });
    } else if (decoded.eventName === 'PaymentCharged') {
      if (!config.escrow || !same(log.address, config.escrow.address)) continue;
      const a = decoded.args;
      const info = a.paymentInfo;
      if (!same(info.operator, config.escrow.operator)) continue;
      if (!same(info.token, config.usdc) || !same(a.feeReceiver, config.treasury)) continue;
      rows.push({
        ...base,
        source: 'escrow',
        kind: 1,
        payer: lower(info.payer),
        payee: lower(info.receiver),
        ref: lower(a.paymentInfoHash),
        gross: a.amount,
        fee: a.feeAmount,
      });
    }
  }
  // Each fee needs its own treasury transfer of exactly that amount in the same transaction, from
  // the same block (hash) as the event.
  let unbacked: bigint | null = null;
  const backed = rows.filter((row) => {
    if (row.fee <= 0n || row.fee > row.gross) return false;
    // A fee the treasury pays to itself moves nothing and is no revenue (the routers accept it).
    if (same(row.payer, config.treasury)) return false;
    // Nor is a payer paying itself (routers 1 and 2 accept payer == payee; router 3 refuses it):
    // no sale took place, so it is left out of the totals like the treasury's own (CCA-122).
    if (row.source === 'router' && same(row.payer, row.payee)) return false;
    const pool = transfers.get(`${row.txHash}:${row.blockHash}`);
    const at = pool?.indexOf(row.fee) ?? -1;
    if (!pool || at < 0) {
      if (unbacked === null || row.blockNumber < unbacked) unbacked = row.blockNumber;
      return false;
    }
    pool.splice(at, 1);
    return true;
  });
  return { rows: backed, unbacked };
}

/**
 * Smallest range a refused getLogs is split down to; still refused there, the blocks are read from
 * their receipts (blockLogs) when the chain can, else the error stands (Base itself down).
 */
export const MIN_LOG_RANGE = 8n;

/**
 * A node refusing an answer for its size (too many logs or too much data), as opposed to a rate
 * limit, a timeout or a node that is down: only that is worth reading block by block instead.
 * Throttling wins over everything (-32005 is also used for rate limits), and a size refusal needs
 * the message to say so: an error code alone is not evidence.
 */
export const isLogLimitError = (error: unknown) => {
  const code = (error as { code?: unknown; status?: unknown })?.code;
  const status = (error as { status?: unknown })?.status;
  const message = String((error as Error)?.message ?? error);
  if (
    code === 429 ||
    status === 429 ||
    /\b429\b|rate.?limit|too many requests|request rate|throttl|timed? ?out|timeout/i.test(message)
  )
    return false;
  return /more than \d+ results|too many (?:logs|results)|log response size|response size (?:exceeded|too large|limit)|query exceeds max(?:imum)? results/i.test(
    message,
  );
};

/**
 * A node saying "too many requests" (HTTP 429, -32005 without a size message, or the words), seen
 * through viem's wrapping. Only a gentle scan (ScanOptions.gentle) acts on it.
 */
export const isRateLimitError = (error: unknown) => {
  if (isLogLimitError(error)) return false;
  let at = error as { code?: unknown; status?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; at && depth < 4; depth++) {
    if (at.code === 429 || at.status === 429 || at.code === -32005) return true;
    at = at.cause as typeof at;
  }
  return /\b429\b|rate.?limit|too many requests|request rate|throttl/i.test(
    String((error as Error)?.message ?? error),
  );
};

/** A log of `source`: its emitter, and every topic the source filters on (null: any). */
const fromSource = (log: ChainLog, source: { address: Hex; topics?: (Hex | null)[] }) =>
  log.address.toLowerCase() === source.address.toLowerCase() &&
  (source.topics ?? []).every(
    (topic, i) => topic === null || log.topics[i]?.toLowerCase() === topic.toLowerCase(),
  );

/**
 * One source's logs over [from, to]. A node refuses an answer with too many logs (22 Oct: ~15,000
 * router-3 FeeCharged events in one 1,000-block range at peak volume, every scan failed from 12:10
 * UTC on): the range is then halved and each half read again, down to MIN_LOG_RANGE. A range that
 * small still refused (a cheap log flood packs one block) is read block by block from the blocks'
 * receipts when the chain can (blockLogs), filtered to the source; otherwise the error stands.
 */
export async function splitLogs(
  chain: FeeChain,
  source: { address: Hex; topics?: (Hex | null)[] },
  from: bigint,
  to: bigint,
  /**
   * range: set to the smallest range that had to be split down to (none split: unchanged);
   * receiptBlocks: blocks read from their receipts.
   */
  fit: { range: bigint | null; receiptBlocks: number },
  /** A gentle scan: a rate limit is never answered with more requests. */
  gentle = false,
): Promise<ChainLog[]> {
  try {
    return await chain.getLogs({ ...source, fromBlock: from, toBlock: to });
  } catch (error) {
    if (gentle && isRateLimitError(error)) throw error;
    if (to - from + 1n <= MIN_LOG_RANGE) {
      if (!chain.blockLogs || !isLogLimitError(error)) throw error;
      const logs: ChainLog[] = [];
      for (let block = from; block <= to; block++) {
        logs.push(...(await chain.blockLogs(block)).filter((log) => fromSource(log, source)));
        fit.receiptBlocks++;
      }
      return logs;
    }
    const mid = from + (to - from) / 2n;
    const half = mid - from + 1n;
    if (fit.range === null || half < fit.range) fit.range = half;
    return [
      ...(await splitLogs(chain, source, from, mid, fit, gentle)),
      ...(await splitLogs(chain, source, mid + 1n, to, fit, gentle)),
    ];
  }
}

/**
 * The range the next chunk starts with, learned across chunks and runs of this instance: after a
 * split the next chunk is read at the size that worked (no refused full-size read first), and it
 * doubles back towards MAX_LOG_RANGE after GROW_AFTER chunks in a row read whole. Dense hours then cost about one
 * request per chunk instead of a cascade of refusals (22 Oct: 180 blocks per run while catching up).
 */
let learnedRange = MAX_LOG_RANGE;
/** Chunks read whole in a row since the last split: the range doubles again only after GROW_AFTER. */
let wholeChunks = 0;
const GROW_AFTER = 8;
/** A gentle scan's learned range, per chain: its refusals never shape another chain's reads. */
const gentleRanges = new Map<number, { range: bigint; whole: number }>();
/** Tests only: forget the learned range. */
export function resetLearnedLogRange(): void {
  learnedRange = MAX_LOG_RANGE;
  wholeChunks = 0;
  gentleRanges.clear();
}

async function rangeLogs(
  chain: FeeChain,
  config: FeeLedgerConfig,
  from: bigint,
  to: bigint,
  pastDeadline: () => boolean = () => false,
  gentle?: GentleScan,
): Promise<{ logs: ChainLog[]; through: bigint; receiptBlocks: number; rateLimited: boolean }> {
  // USDC is read only for Transfer events TO the treasury (topic-filtered: on Base mainnet an
  // unfiltered USDC scan would be millions of logs); the fee contracts are read whole.
  const transferTopic = encodeEventTopics({ abi: FEE_EVENTS_ABI, eventName: 'Transfer' })[0] as Hex;
  const treasuryTopic = pad(config.treasury.toLowerCase() as Hex, { size: 32 });
  const sources: { address: Hex; topics?: (Hex | null)[] }[] = [
    { address: config.usdc, topics: [transferTopic, null, treasuryTopic] },
    ...(config.router ? [{ address: config.router }] : []),
    ...(config.addedRouters ?? []).map((r) => ({ address: r.address })),
    ...(config.escrow ? [{ address: config.escrow.address }] : []),
  ];
  const logs: ChainLog[] = [];
  // Out of time after a whole chunk: the range read so far is returned and the run stops there.
  let through = from - 1n;
  let receiptBlocks = 0;
  let own = gentle ? gentleRanges.get(config.chainId) : undefined;
  if (gentle && !own)
    gentleRanges.set(config.chainId, (own = { range: gentle.logRange, whole: 0 }));
  for (let start = from; start <= to;) {
    if (through >= from && pastDeadline()) break;
    const step = own ? own.range : learnedRange;
    const end = start + step - 1n < to ? start + step - 1n : to;
    const fit = { range: null as bigint | null, receiptBlocks: 0 };
    // Whole chunks only: a chunk cut short by a rate limit leaves no log behind. `through` stays
    // before it, so the cursor can never pass a block with an unread source.
    const chunk: ChainLog[] = [];
    try {
      for (const source of sources)
        chunk.push(...(await splitLogs(chain, source, start, end, fit, Boolean(gentle))));
    } catch (error) {
      if (!gentle || !isRateLimitError(error) || through < from) throw error;
      return { logs: sortedLogs(logs), through, receiptBlocks, rateLimited: true };
    }
    logs.push(...chunk);
    receiptBlocks += fit.receiptBlocks;
    if (own) {
      if (fit.range !== null) {
        own.range = fit.range;
        own.whole = 0;
      } else if (++own.whole >= GROW_AFTER) {
        own.range = step * 2n < gentle!.logRange ? step * 2n : gentle!.logRange;
        own.whole = 0;
      }
    } else if (fit.range !== null) {
      learnedRange = fit.range;
      wholeChunks = 0;
    } else if (++wholeChunks >= GROW_AFTER) {
      learnedRange = step * 2n < MAX_LOG_RANGE ? step * 2n : MAX_LOG_RANGE;
      wholeChunks = 0;
    }
    through = end;
    start = end + 1n;
  }
  return { logs: sortedLogs(logs), through, receiptBlocks, rateLimited: false };
}

const sortedLogs = (logs: ChainLog[]) =>
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );

/**
 * CCA-107, empty blocks. A block becomes final when a later scan reads the same fees as an earlier
 * one; for a block where the read found no log of a fee source, two agreeing empty answers are not
 * proof (a backend whose log index lags or misses the block answers empty every time). Such a block
 * is final only when its header's logsBloom rules the fee out: a counted fee needs the source's
 * address and event topic AND its USDC Transfer to the treasury (the USDC address, the Transfer
 * topic and the treasury topic) in the same block. A bloom never misses what the block holds but
 * can match what it does not (on a busy chain often): when it may hold a fee, the block's logs are
 * read again by its hash (eth_getLogs blockHash, another path than a range read; a node without
 * the block answers an error, not an empty list), and the block is final only when that read finds
 * no log of the source either. Otherwise it stays non-final and is checked again by the next run.
 */
/**
 * Headers read per run for blocks to promote with no log of a fee source: at most the blocks one
 * run scans (cron.ts SCAN_BLOCKS_PER_RUN). In steady state a run promotes only the blocks that
 * became final since the last one (on Base about 150 every 5 minutes).
 */
export const BLOOM_BLOCKS_PER_RUN = 5_000;
/** Header and by-hash reads in flight at once (the endpoint is shared with live payments). */
const READS_AT_ONCE = 5;
/**
 * Time these reads may take in a run with a budget (scanFees `budgetMs`), counted from their
 * start: past it, the rest is left to the next run (always at least one group is read).
 */
export const BLOOM_BUDGET_MS = 20_000;
/** Runs a block may stay unconfirmed before the line carries level ALERT. */
export const BLOOM_ALERT_TRIES = 3;
/** Runs each unconfirmed block has failed so far, per instance (a cold start counts again). */
const bloomTries = new Map<string, number>();
/** Tests only: forget the unconfirmed-block counts. */
export function resetBloomTries(): void {
  bloomTries.clear();
}

/**
 * Whether an Ethereum logsBloom (2048 bits) may contain `value`, an address or a topic: the three
 * bits named by the low 11 bits of the first three byte pairs of keccak256(value). An unreadable
 * bloom may contain anything.
 */
export function bloomMayContain(bloom: Hex, value: Hex): boolean {
  if (!/^0x[0-9a-fA-F]{512}$/.test(bloom)) return true;
  const filter = hexToBytes(bloom);
  const h = hexToBytes(keccak256(value));
  for (let i = 0; i < 6; i += 2) {
    const bit = ((h[i]! << 8) | h[i + 1]!) & 0x7ff;
    if ((filter[255 - (bit >> 3)]! & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/**
 * The first block of [from, through] that may not be promoted for lack of proof that it holds no
 * fee of ours (see above), or null when every block may be. Reads at most BLOOM_BLOCKS_PER_RUN
 * headers; the first block past that is returned unchecked (checked by a later run).
 */
async function emptyBlocksConfirmed(
  chain: FeeChain,
  config: FeeLedgerConfig,
  logs: readonly ChainLog[],
  from: bigint,
  through: bigint,
  log: (line: string) => void,
  pastBudget: () => boolean,
  /** A gentle scan reads only the headers of blocks where the read found a log (ScanOptions). */
  onlyLogged = false,
): Promise<bigint | null> {
  const topic = (eventName: 'FeeCharged' | 'PaymentCharged' | 'Transfer') =>
    lower(encodeEventTopics({ abi: FEE_EVENTS_ABI, eventName })[0] as Hex);
  const sources = [
    ...(config.router
      ? [
          {
            address: lower(config.router),
            topic: topic('FeeCharged'),
            fromBlock: config.startBlock,
          },
        ]
      : []),
    ...(config.addedRouters ?? []).map((r) => ({
      address: lower(r.address),
      topic: topic('FeeCharged'),
      fromBlock: r.fromBlock,
    })),
    ...(config.escrow
      ? [
          {
            address: lower(config.escrow.address),
            topic: topic('PaymentCharged'),
            fromBlock: config.startBlock,
          },
        ]
      : []),
  ];
  type Source = (typeof sources)[number];
  const transferProof = [
    lower(config.usdc),
    topic('Transfer'),
    lower(pad(lower(config.treasury), { size: 32 })),
  ];
  const isEvent = (l: ChainLog, s: Source) =>
    lower(l.address) === s.address && l.topics[0]?.toLowerCase() === s.topic;
  const seen = new Map<bigint, Set<Source>>();
  for (const l of logs)
    for (const s of sources)
      if (isEvent(l, s)) {
        let set = seen.get(l.blockNumber);
        if (!set) seen.set(l.blockNumber, (set = new Set()));
        set.add(s);
      }
  const logged = new Set(onlyLogged ? logs.map((l) => l.blockNumber) : []);
  const checks: { block: bigint; sources: Source[] }[] = [];
  let unchecked: bigint | null = null;
  for (let block = from; block <= through; block++) {
    if (onlyLogged && !logged.has(block)) continue;
    const open = sources.filter((s) => block >= s.fromBlock && !seen.get(block)?.has(s));
    if (open.length === 0) continue;
    if (checks.length >= BLOOM_BLOCKS_PER_RUN) {
      unchecked = block;
      break;
    }
    checks.push({ block, sources: open });
  }
  let stop: bigint | null = null;
  let reason: 'logs_missing' | 'read_failed' = 'read_failed';
  for (let i = 0; i < checks.length && stop === null; i += READS_AT_ONCE) {
    if (i > 0 && pastBudget()) {
      unchecked = checks[i]!.block;
      break;
    }
    const group = checks.slice(i, i + READS_AT_ONCE);
    const verdicts = await Promise.all(
      group.map(async ({ block, sources: open }) => {
        try {
          const header = await chain.header(block);
          const bloom = header.logsBloom;
          if (!transferProof.every((v) => bloomMayContain(bloom, v))) return null;
          const may = open.filter(
            (s) => bloomMayContain(bloom, s.address) && bloomMayContain(bloom, s.topic),
          );
          if (may.length === 0) return null;
          const again = await chain.logsAtHash(
            header.hash,
            may.map((s) => s.address),
          );
          return again.some((l) => may.some((s) => isEvent(l, s))) ? 'logs_missing' : null;
        } catch {
          return 'read_failed';
        }
      }),
    );
    const at = verdicts.findIndex((v) => v !== null);
    if (at >= 0) {
      stop = group[at]!.block;
      reason = verdicts[at]!;
    }
  }
  const boundary = stop ?? unchecked ?? through + 1n;
  for (const key of bloomTries.keys()) {
    const [chainId, block] = key.split(':');
    if (Number(chainId) === config.chainId && BigInt(block!) < boundary) bloomTries.delete(key);
  }
  if (stop === null) return unchecked;
  const key = `${config.chainId}:${stop}`;
  const tries = (bloomTries.get(key) ?? 0) + 1;
  if (bloomTries.size >= 1_000) bloomTries.clear();
  bloomTries.set(key, tries);
  log(
    JSON.stringify({
      event: 'protocol.fee_scan_bloom_unconfirmed',
      ...(tries >= BLOOM_ALERT_TRIES ? { level: 'ALERT' } : {}),
      chainId: config.chainId,
      block: stop.toString(),
      reason,
      tries,
    }),
  );
  return stop;
}

/** A row's identity and fields, as the scan's DELETE ... RETURNING spells them. */
const feeRowKey = (row: FeeRow) =>
  [
    row.txHash,
    row.logIndex,
    row.blockHash,
    row.payer,
    row.payee,
    row.ref,
    row.kind,
    row.gross,
    row.fee,
  ].join(':');

/**
 * The fee-on-top rows (kind 0) of a scan whose service the call record already proved: a Feed pay
 * call on this chain with fee_verified (the engine matched the seller settlement and marked the
 * row once), its payment settled and its fee charged, whose ref (keccak256 of the call id), payer
 * (its spender), payee, router, price and fee are exactly the row's. A row that a rescan replaced
 * (re-included in another block) or that one run missed gets its mark back this way. Keys as in
 * scanFees. Read before the scan's transaction; without the Feed pay tables, or on any error,
 * nothing (the row then waits for the next run, as before).
 */
async function verifiedByCalls(
  db: Database,
  chainId: number,
  rows: readonly FeeRow[],
): Promise<Set<string>> {
  const marked = new Set<string>();
  const open = rows.filter((row) => row.kind === 0);
  if (open.length === 0) return marked;
  try {
    const present = await db.query<{ ok: boolean }>(
      `SELECT to_regclass('feed_pay_calls') IS NOT NULL AND to_regclass('base_wallets') IS NOT NULL
         AS ok`,
    );
    if (present.rows[0]?.ok !== true) return marked;
    const calls = await db.query<{
      call_id: string;
      payer: string;
      payee: string;
      emitter: string;
      gross: string;
      fee: string;
    }>(
      `SELECT c.call_id, lower(w.spender_address) AS payer, lower(c.pay_to) AS payee,
              lower(c.fee_router) AS emitter, c.amount_raw::text AS gross, c.fee_raw::text AS fee
         FROM feed_pay_calls c JOIN base_wallets w ON w.wallet_id = c.wallet_id
        WHERE c.chain_id = $1 AND c.fee_verified AND c.payment_state = 'settled'
          AND c.fee_state = 'charged' AND lower(c.pay_to) = ANY($2::text[])`,
      [chainId, [...new Set(open.map((row) => row.payee))]],
    );
    const byRef = new Map(calls.rows.map((c) => [lower(keccak256(stringToHex(c.call_id))), c]));
    for (const row of open) {
      const call = byRef.get(row.ref);
      if (
        call &&
        call.payer === row.payer &&
        call.payee === row.payee &&
        call.emitter === row.emitter &&
        call.gross === row.gross.toString() &&
        call.fee === row.fee.toString()
      )
        marked.add(feeRowKey(row));
    }
  } catch {
    // Never fails a scan: the mark is re-applied on a later run.
  }
  return marked;
}

export interface ScanResult {
  from: bigint;
  to: bigint;
  written: number;
  removed: number;
  /** Another scan held the lock or moved the checkpoint meanwhile; nothing was written. */
  busy?: true;
  /**
   * The run stopped short of the range it planned (out of time, a block it could not confirm, or
   * a gentle scan told to slow down) and committed the confirmed prefix [from, to], which may be
   * empty (to < from); the next run continues from there.
   */
  partial?: 'deadline' | 'reorg' | 'error' | 'rate_limit';
}

/**
 * A scan for a shared public node (Arc's): reads no header for a block where the range reads found
 * no log, asks for at most `logRange` blocks at a time, and ends the run on a rate limit, resuming
 * from the cursor. What it gives up: a backend answering empty for every source of a block, in two
 * scans, finalises it without the bloom's word (CCA-107, docs/protocol/FEES.md).
 */
export interface GentleScan {
  logRange: bigint;
}

/** Advisory lock key for fee scans (one scan per database at a time). */
export const PROTOCOL_FEE_SCAN_LOCK_KEY = 1347568710;

/**
 * Scans from the earlier of (checkpoint - REORG_DEPTH) and the first block not yet verified as
 * final, but never below that first block (rows already final are never rewritten), up to the
 * latest block, at most `maxBlocks` per call. Rows in the rescanned range are
 * replaced by what the chain returns now; the checkpoint moves in the same transaction. A row is
 * promoted to final only inside the range this run rescanned and only up to the chain's finalized
 * block, so every final row was re-read from the canonical chain after its block became final.
 * A block is also promoted only when an earlier run read it (below that run's checkpoint) and this
 * run's read finds exactly the rows stored (CCA-107): one run of finality delay, so a single empty
 * answer cannot finalise a block without its fees. A block where the read found no log of a fee
 * source is promoted only when its header's logsBloom rules out a fee of ours, or, when the bloom
 * may hold one, a read of the block by its hash finds none either (emptyBlocksConfirmed): repeated
 * empty answers alone never finalise it. Such a block stays non-final, is checked again each run,
 * and the line protocol.fee_scan_bloom_unconfirmed carries level ALERT from the
 * BLOOM_ALERT_TRIES-th run on. What remains: a read that returns SOME of a block's logs of one fee
 * source but misses others, the same way twice, is still taken as complete (the bloom cannot tell).
 *
 * With `budgetMs`, a run that runs out of time (or, after it confirmed at least one block, meets a
 * block it cannot confirm or cannot read) commits the prefix it confirmed: rows, finality and
 * finalized_through up to there. A long not-yet-final window (a finality stall) then drains over
 * several runs instead of failing every one. A block that is not final yet and is already stored
 * with the same hash keeps its stored time without a block read; a block that this run promotes
 * is always checked against the canonical chain.
 *
 * A range the node refuses even at MIN_LOG_RANGE blocks is read from the blocks' receipts when the
 * chain can (logged protocol.fee_scan_receipts_fallback, alertable). A run that fails clears
 * caught_up, so the public totals stop claiming complete history until a run reaches the head again
 * (the cron logs protocol.fee_scan_failed).
 */
export async function scanFees(
  db: Database,
  chain: FeeChain,
  config: FeeLedgerConfig,
  options: ScanOptions = {},
): Promise<ScanResult | null> {
  try {
    return await scanOnce(db, chain, config, options);
  } catch (error) {
    await db
      .query('UPDATE protocol_fee_scan_state SET caught_up = false WHERE chain_id = $1', [
        config.chainId,
      ])
      .catch(() => {});
    if (!options.gentle || !isRateLimitError(error)) throw error;
    // Told to slow down before anything could be committed: not a failure, nothing was written.
    const { rows } = await db.query<{ next_block: string }>(
      'SELECT next_block FROM protocol_fee_scan_state WHERE chain_id = $1',
      [config.chainId],
    );
    const at = rows[0] ? BigInt(rows[0].next_block) : config.startBlock;
    (options.log ?? console.warn)(
      JSON.stringify({
        event: 'protocol.fee_scan_rate_limited',
        chainId: config.chainId,
        block: at.toString(),
      }),
    );
    return { from: at, to: at - 1n, written: 0, removed: 0, partial: 'rate_limit' };
  }
}

interface ScanOptions {
  maxBlocks?: bigint;
  now?: () => number;
  budgetMs?: number;
  /** One JSON line per notable event (never an address or a URL). */
  log?: (line: string) => void;
  /** Read a shared public node gently (GentleScan); absent, every read is as it always was. */
  gentle?: GentleScan;
}

async function scanOnce(
  db: Database,
  chain: FeeChain,
  config: FeeLedgerConfig,
  options: ScanOptions,
): Promise<ScanResult | null> {
  const now = options.now ?? Date.now;
  const deadline = options.budgetMs === undefined ? null : now() + options.budgetMs;
  const pastDeadline = () => deadline !== null && now() >= deadline;
  const readState = async (q: Pick<Database, 'query'>) => {
    const state = await q.query<{
      next_block: string;
      finalized_through: string | null;
      caught_up: boolean;
    }>(
      'SELECT next_block, finalized_through, caught_up FROM protocol_fee_scan_state WHERE chain_id = $1',
      [config.chainId],
    );
    const row = state.rows[0];
    return {
      checkpoint: row ? BigInt(row.next_block) : config.startBlock,
      finalizedThrough: row?.finalized_through != null ? BigInt(row.finalized_through) : null,
      caughtUp: row?.caught_up === true,
    };
  };
  await startAddedRouters(db, config, now);
  const { checkpoint, finalizedThrough } = await readState(db);
  const unverified = finalizedThrough === null ? config.startBlock : finalizedThrough + 1n;
  const reorgFrom = checkpoint - REORG_DEPTH;
  let from = reorgFrom < unverified ? reorgFrom : unverified;
  if (from < config.startBlock) from = config.startBlock;
  // Never below the verified final prefix (CCA-106): a rescan replaces rows with finalized = false
  // and promotes only up to this run's finalized height, so re-reading final blocks with a node
  // that answers an older 'finalized' block left them non-final for good.
  if (from < unverified) from = unverified;
  const latest = await chain.latestBlock();
  if (latest < from) return null;
  // The cap bounds the NEW blocks past the checkpoint; the not-yet-final interval before it is
  // always re-read in full (on Base it is the few hundred blocks behind finality).
  const cap = options.maxBlocks ?? 10_000n;
  const base = checkpoint > from ? checkpoint : from;
  let to = latest - base + 1n > cap ? base + cap - 1n : latest;

  // Finalized height BEFORE the logs: nothing read before a block became final is promoted by
  // height alone, and every row's block hash is checked against the canonical block below.
  const finalized = await chain.finalizedBlock();
  const read = await rangeLogs(chain, config, from, to, pastDeadline, options.gentle);
  if (read.receiptBlocks > 0)
    (options.log ?? console.warn)(
      JSON.stringify({
        event: 'protocol.fee_scan_receipts_fallback',
        chainId: config.chainId,
        blocks: read.receiptBlocks,
        from: from.toString(),
        to: read.through.toString(),
      }),
    );
  let partial: ScanResult['partial'];
  if (read.through < to) {
    to = read.through;
    partial = read.rateLimited ? 'rate_limit' : 'deadline';
    if (read.rateLimited)
      (options.log ?? console.warn)(
        JSON.stringify({
          event: 'protocol.fee_scan_rate_limited',
          chainId: config.chainId,
          block: (to + 1n).toString(),
        }),
      );
  }
  const parsed = feeRowsAndGaps(config, read.logs);
  let rows = parsed.rows;
  // A block not final yet whose rows are stored with the same hash keeps its stored time.
  const stored = new Map<string, bigint>();
  const known = await db.query<{ block_number: string; block_hash: string; block_time: string }>(
    `SELECT DISTINCT block_number::text AS block_number, block_hash, block_time::text AS block_time
       FROM protocol_fee_events
      WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3 AND block_number > $4`,
    [config.chainId, from.toString(), to.toString(), finalized.toString()],
  );
  for (const r of known.rows) stored.set(`${r.block_number}:${r.block_hash}`, BigInt(r.block_time));
  const times = new Map<bigint, bigint>();
  // Stops before `blockNumber`: only the blocks below it are committed by this run.
  const stopAt = (blockNumber: bigint, why: NonNullable<ScanResult['partial']>) => {
    to = blockNumber - 1n;
    rows = rows.filter((r) => r.blockNumber <= to);
    partial = why;
  };
  // A fee event of ours without its treasury transfer: the logs of that block are incomplete
  // (CCA-107). The run commits only the blocks before it, or fails when there are none, and the
  // block is read again by the next run, never promoted without its fee.
  if (parsed.unbacked !== null) {
    (options.log ?? console.warn)(
      JSON.stringify({
        event: 'protocol.fee_scan_unbacked',
        chainId: config.chainId,
        block: parsed.unbacked.toString(),
      }),
    );
    if (parsed.unbacked <= from)
      throw new Error('A fee event without its treasury transfer: the log read was incomplete.');
    stopAt(parsed.unbacked, 'error');
  }
  for (const row of rows) {
    if (times.has(row.blockNumber)) continue;
    const reuse =
      row.blockNumber > finalized ? stored.get(`${row.blockNumber}:${row.blockHash}`) : undefined;
    if (reuse !== undefined) {
      times.set(row.blockNumber, reuse);
      continue;
    }
    if (times.size > 0 && pastDeadline()) {
      stopAt(row.blockNumber, 'deadline');
      break;
    }
    let canonical;
    try {
      canonical = await chain.block(row.blockNumber);
    } catch (error) {
      // A failed read after confirmed blocks commits those; with none, the run fails as before.
      if (times.size === 0) throw error;
      stopAt(row.blockNumber, options.gentle && isRateLimitError(error) ? 'rate_limit' : 'error');
      break;
    }
    if (lower(canonical.hash) !== row.blockHash) {
      // The logs came from a branch that is no longer canonical: try again next run.
      if (times.size === 0) return { from, to, written: 0, removed: 0, busy: true };
      stopAt(row.blockNumber, 'reorg');
      break;
    }
    times.set(row.blockNumber, canonical.timestamp);
  }
  // The highest block this run may promote: re-read now, final, and below the checkpoint (an
  // earlier run read it too). Blocks in it with no log of a fee source need their bloom's word
  // (CCA-107, emptyBlocksConfirmed), read here, before the transaction.
  let promoteLimit = to < finalized ? to : finalized;
  if (promoteLimit >= checkpoint) promoteLimit = checkpoint - 1n;
  const bloomEnd = deadline === null ? null : now() + BLOOM_BUDGET_MS;
  const emptyStop =
    promoteLimit >= from
      ? await emptyBlocksConfirmed(
          chain,
          config,
          read.logs,
          from,
          promoteLimit,
          options.log ?? console.warn,
          () => bloomEnd !== null && now() >= bloomEnd,
          Boolean(options.gentle),
        )
      : null;
  const fromCalls = await verifiedByCalls(db, config.chainId, rows);

  return db.transaction(async (tx) => {
    const locked = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [
      PROTOCOL_FEE_SCAN_LOCK_KEY,
    ]);
    const current = await readState(tx);
    if (
      locked.rows[0]?.ok !== true ||
      current.checkpoint !== checkpoint ||
      current.finalizedThrough !== finalizedThrough
    )
      return { from, to, written: 0, removed: 0, busy: true as const };
    // Rows of the rescanned range are replaced by what the chain says now; a row that is still
    // there (same tx, log, block and fields) keeps its service-verified mark.
    const gone = await tx.query<{ key: string; service_verified: boolean; block_number: string }>(
      `DELETE FROM protocol_fee_events WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3
       RETURNING tx_hash || ':' || log_index || ':' || block_hash || ':' || payer || ':' || payee
         || ':' || ref || ':' || kind || ':' || gross::text || ':' || fee::text AS key, service_verified,
         block_number::text AS block_number`,
      [config.chainId, from.toString(), to.toString()],
    );
    const verifiedBefore = new Set(gone.rows.filter((r) => r.service_verified).map((r) => r.key));
    // Several rows per INSERT: a long window is a few statements, not one per row.
    const createdAt = now();
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH);
      const values = batch.map(
        (_, b) => `(${Array.from({ length: 17 }, (_, c) => `$${b * 17 + c + 1}`).join(',')})`,
      );
      await tx.query(
        `INSERT INTO protocol_fee_events (chain_id, tx_hash, log_index, emitter, source, kind, block_number,
           block_hash, block_time, payer, payee, ref, gross, fee, finalized, service_verified, created_at)
         VALUES ${values.join(',')}`,
        batch.flatMap((row) => [
          row.chainId,
          row.txHash,
          row.logIndex,
          row.emitter,
          row.source,
          row.kind,
          row.blockNumber.toString(),
          row.blockHash,
          (times.get(row.blockNumber) ?? 0n).toString(),
          row.payer,
          row.payee,
          row.ref,
          row.gross.toString(),
          row.fee.toString(),
          false,
          row.kind === 1 || verifiedBefore.has(feeRowKey(row)) || fromCalls.has(feeRowKey(row)),
          createdAt,
        ]),
      );
    }
    // Promote only what this run re-read: [from, min(to, finalized)]. from never lies above the
    // first unverified block, so final rows form one contiguous, re-verified prefix.
    // CCA-107: and only a block an EARLIER run read too (below its checkpoint) whose rows this
    // read confirms exactly. A backend that answers no logs at all for a block (behind the
    // others) disagrees with a read that found its fees, so the block waits for a read that
    // agrees. Costs one run of finality delay. A block with no log of a fee source is promoted
    // only when its bloom rules a fee out or a read by its hash finds none (emptyStop): repeated
    // empty answers alone never finalise it.
    let promoteTo = promoteLimit;
    const keysByBlock = (entries: Iterable<[string, string]>) => {
      const map = new Map<string, Set<string>>();
      for (const [block, key] of entries) {
        let set = map.get(block);
        if (!set) map.set(block, (set = new Set()));
        set.add(key);
      }
      return map;
    };
    const before = keysByBlock(gone.rows.map((r) => [r.block_number, r.key]));
    const after = keysByBlock(rows.map((row) => [row.blockNumber.toString(), feeRowKey(row)]));
    const disputed = [...new Set([...before.keys(), ...after.keys()])]
      .map((block) => BigInt(block))
      .filter((block) => {
        if (block < from || block > promoteTo) return false;
        const a = before.get(block.toString()) ?? new Set<string>();
        const b = after.get(block.toString()) ?? new Set<string>();
        return a.size !== b.size || [...a].some((key) => !b.has(key));
      })
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (disputed.length > 0) {
      (options.log ?? console.warn)(
        JSON.stringify({
          event: 'protocol.fee_scan_unconfirmed',
          chainId: config.chainId,
          block: disputed[0]!.toString(),
          blocks: disputed.length,
        }),
      );
      promoteTo = disputed[0]! - 1n;
    }
    if (emptyStop !== null && promoteTo >= emptyStop) promoteTo = emptyStop - 1n;
    let through = finalizedThrough;
    if (promoteTo >= from) {
      await tx.query(
        'UPDATE protocol_fee_events SET finalized = true WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3',
        [config.chainId, from.toString(), promoteTo.toString()],
      );
      if (through === null || promoteTo > through) through = promoteTo;
    }

    await tx.query(
      `INSERT INTO protocol_fee_scan_state (chain_id, next_block, finalized_through, caught_up,
         updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (chain_id) DO UPDATE SET next_block = GREATEST(protocol_fee_scan_state.next_block, EXCLUDED.next_block),
         finalized_through = EXCLUDED.finalized_through, caught_up = EXCLUDED.caught_up,
         updated_at = EXCLUDED.updated_at`,
      [
        config.chainId,
        (to + 1n).toString(),
        through === null ? null : through.toString(),
        // Caught up = the scanned history reaches the head. A partial run that stopped before the
        // checkpoint read no new blocks, so it leaves the mark as the last full run set it.
        to >= latest || (to < checkpoint && current.caughtUp),
        now(),
      ],
    );
    const removed = Math.max(0, gone.rows.length - rows.length);
    return { from, to, written: rows.length, removed, ...(partial ? { partial } : {}) };
  });
}

/**
 * One-off repair (CCA-106): rows inside the verified final prefix (at or below finalized_through)
 * that are not final. Before scans stopped re-reading final blocks, a rescan of the 64 blocks
 * before the checkpoint could rewrite final rows as not final while a node answered an older
 * 'finalized' block, and nothing promoted them again, so they dropped out of the final totals.
 * Each such row was checked against the canonical block when it was written, at a height already
 * final. Runs under the scan lock; returns the rows promoted. Never part of a scan (it reads the
 * whole prefix): run it once after the deploy.
 */
export async function repairFinalPrefix(db: Database, chainId: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [PROTOCOL_FEE_SCAN_LOCK_KEY]);
    const fixed = await tx.query(
      `UPDATE protocol_fee_events e SET finalized = true
         FROM protocol_fee_scan_state s
        WHERE s.chain_id = $1 AND e.chain_id = s.chain_id AND s.finalized_through IS NOT NULL
          AND NOT e.finalized AND e.block_number <= s.finalized_through
        RETURNING e.tx_hash`,
      [chainId],
    );
    return fixed.rows.length;
  });
}

/**
 * A router added after the scan already passed its deploy block (router 2 or 3 is configured after
 * it is deployed): the first scan that sees it records it in protocol_fee_router_starts (migration 232)
 * and lowers finalized_through to just before its deploy block, in one transaction. scanFees then
 * re-reads that range once (rows replaced by what the chain says, finality re-verified), so every
 * fee of the new router from its first block is counted. Exactly once per router; a router whose
 * deploy block the scan has not reached yet needs no rewind but is recorded too.
 */
async function startAddedRouters(
  db: Database,
  config: FeeLedgerConfig,
  now: () => number,
): Promise<void> {
  const added = config.addedRouters ?? [];
  if (added.length === 0) {
    // Nothing added now: a router that was read before is marked inactive (no rewind), so that
    // configuring it again later re-reads its history (a scan without it replaced its rows).
    const present = await db.query<{ ok: boolean }>(
      "SELECT to_regclass('protocol_fee_router_starts') IS NOT NULL AS ok",
    );
    if (present.rows[0]?.ok !== true) return;
    await db.query(
      'UPDATE protocol_fee_router_starts SET active = false WHERE chain_id = $1 AND active',
      [config.chainId],
    );
    return;
  }
  const known = await db.query<{ router: string; active: boolean }>(
    'SELECT router, active FROM protocol_fee_router_starts WHERE chain_id = $1',
    [config.chainId],
  );
  const state = new Map(known.rows.map((r) => [r.router, r.active]));
  const configured = new Set(added.map((r) => lower(r.address)));
  // A router to (re)start: never read, or read before and dropped from the config since.
  const start = added.filter((r) => state.get(lower(r.address)) !== true);
  const dropped = [...state].filter(([router, active]) => active && !configured.has(router as Hex));
  if (start.length === 0 && dropped.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [PROTOCOL_FEE_SCAN_LOCK_KEY]);
    for (const [router] of dropped)
      await tx.query(
        'UPDATE protocol_fee_router_starts SET active = false WHERE chain_id = $1 AND router = $2',
        [config.chainId, router],
      );
    for (const router of start) {
      const changed = await tx.query(
        `INSERT INTO protocol_fee_router_starts (chain_id, router, from_block, started_at, active)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (chain_id, router) DO UPDATE
           SET active = true, from_block = EXCLUDED.from_block, started_at = EXCLUDED.started_at
           WHERE NOT protocol_fee_router_starts.active
         RETURNING router`,
        [config.chainId, lower(router.address), router.fromBlock.toString(), now()],
      );
      if (changed.rows.length === 0 || router.fromBlock === 0n) continue;
      await tx.query(
        `UPDATE protocol_fee_scan_state
            SET finalized_through = LEAST(finalized_through, $2::bigint), updated_at = $3
          WHERE chain_id = $1 AND finalized_through IS NOT NULL`,
        [config.chainId, (router.fromBlock - 1n).toString(), now()],
      );
    }
  });
}

export interface DailyFees {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Paid calls whose service is proven (the calls the volume counts). */
  payments: number;
  /**
   * The fees `fees` sums (the same rows, CCA-127): every counted fee, also a fee-on-top fee whose
   * service is not proven. An event count, not a count of paid calls (routers 1 and 2 accept a
   * fee-on-top fee of one unit from anyone); `payments` counts paid calls.
   */
  feeCount: number;
  /** Sum of service prices of calls whose service is proven (USDC units). */
  volume: bigint;
  /** Sum of protocol fees (USDC units); fees = revenue = protocol revenue. */
  fees: bigint;
}

/**
 * The rows no total may count, applied when reading as well as when writing (feeRowsFromLogs):
 * a fee the treasury pays itself (CCA-126) and a router fee whose payer pays itself (CCA-105,
 * CCA-122). Rows stored before those write-time rules existed are never rewritten, so the read
 * leaves them out too. $4: the chain's treasury (lowercase), or null when none is known.
 */
const COUNTED_FEE_ROWS = `($4::text IS NULL OR payer <> $4::text)
        AND NOT (source = 'router' AND payer = payee)`;

/** Daily totals for public metrics: every paid call counts the same way. */
export async function dailyFees(
  db: Pick<Database, 'query'>,
  chainId: number,
  fromTime: number,
  toTime: number,
  options: {
    finalizedOnly?: boolean;
    /**
     * The treasury whose own payments are left out; default the one fixed in code for `chainId`
     * (Base mainnet), else none. A test network passes its configured treasury.
     */
    treasury?: string | null;
  } = {},
): Promise<DailyFees[]> {
  const treasury =
    options.treasury !== undefined
      ? options.treasury
      : (protocolDeployment(chainId)?.treasury ?? null);
  const result = await db.query<{
    day: string;
    payments: string;
    fee_count: string;
    volume: string;
    fees: string;
  }>(
    `SELECT to_char(to_timestamp(block_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE service_verified)::text AS payments, count(*)::text AS fee_count,
            COALESCE(sum(gross) FILTER (WHERE service_verified), 0)::text AS volume,
            sum(fee)::text AS fees
       FROM protocol_fee_events
      WHERE chain_id = $1 AND block_time >= $2 AND block_time < $3 ${options.finalizedOnly ? 'AND finalized' : ''}
        AND ${COUNTED_FEE_ROWS}
      GROUP BY 1 ORDER BY 1`,
    [chainId, fromTime, toTime, treasury ? treasury.toLowerCase() : null],
  );
  return result.rows.map((r) => ({
    day: r.day,
    payments: Number(r.payments),
    feeCount: Number(r.fee_count),
    volume: BigInt(r.volume),
    fees: BigInt(r.fees),
  }));
}

export interface ExpectedFee {
  chainId: number;
  emitter: Hex;
  payer: Hex;
  payee: Hex;
  ref: Hex;
  kind: 0 | 1;
  gross: bigint;
  fee: bigint;
}

/**
 * Whether the exact fee a call owes is in the ledger: every field must match one canonical row
 * (which already carries its treasury-transfer proof); `finalizedOnly` for anything reported as
 * final. No scan or cron calls it: it is the matcher for the manual review of a failed fee
 * (FEES.md, "Fee on top is not atomic with the seller payment"), nothing scheduled.
 */
export async function feeOnChain(
  db: Database,
  expected: ExpectedFee,
  options: { finalizedOnly?: boolean } = {},
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM protocol_fee_events
      WHERE chain_id = $1 AND emitter = $2 AND payer = $3 AND payee = $4 AND ref = $5 AND kind = $6
        AND gross = $7 AND fee = $8 ${options.finalizedOnly ? 'AND finalized' : ''} LIMIT 1`,
    [
      expected.chainId,
      lower(expected.emitter),
      lower(expected.payer),
      lower(expected.payee),
      lower(expected.ref),
      expected.kind,
      expected.gross.toString(),
      expected.fee.toString(),
    ],
  );
  return result.rows.length > 0;
}

/**
 * Marks a fee-on-top call's service as proven once its seller settlement is on Base: the engine
 * calls it for a call whose payment is 'settled', which FeedPayChain.outcome() sets only from
 * USDC's AuthorizationUsed for the payer and the call's own nonce in a canonical block. That
 * authorization is the one the payer signed, for exactly `gross` to the payee, and USDC's
 * transferWithAuthorization moves exactly that in the same call. Only then does its price count
 * as volume. A rescan keeps the mark of a row that is still there; a row it replaced or
 * brought back gets it again from the call record (verifiedByCalls: the call's fee_verified).
 */
export async function markServiceVerified(db: Database, expected: ExpectedFee): Promise<boolean> {
  const result = await db.query(
    `UPDATE protocol_fee_events SET service_verified = true
      WHERE chain_id = $1 AND emitter = $2 AND payer = $3 AND payee = $4 AND ref = $5 AND kind = $6
        AND gross = $7 AND fee = $8 RETURNING 1`,
    [
      expected.chainId,
      lower(expected.emitter),
      lower(expected.payer),
      lower(expected.payee),
      lower(expected.ref),
      expected.kind,
      expected.gross.toString(),
      expected.fee.toString(),
    ],
  );
  return result.rows.length > 0;
}

/** How far the ledger has read the chain, for the freshness of public totals. */
export async function scanProgress(
  db: Pick<Database, 'query'>,
  chainId: number,
): Promise<{
  scannedThroughBlock: string | null;
  finalizedThroughBlock: string | null;
  lastScanAt: number | null;
}> {
  const { rows } = await db.query<{
    next_block: string;
    finalized_through: string | null;
    updated_at: string;
  }>(
    'SELECT next_block::text, finalized_through::text, updated_at::text FROM protocol_fee_scan_state WHERE chain_id = $1',
    [chainId],
  );
  const row = rows[0];
  if (!row) return { scannedThroughBlock: null, finalizedThroughBlock: null, lastScanAt: null };
  return {
    scannedThroughBlock: (BigInt(row.next_block) - 1n).toString(10),
    finalizedThroughBlock: row.finalized_through,
    lastScanAt: Number(row.updated_at),
  };
}

/** Whether the ledger holds the full history from its start block (the last scan reached the head). */
export async function historyComplete(
  db: Pick<Database, 'query'>,
  chainId: number,
): Promise<boolean> {
  const { rows } = await db.query<{ caught_up: boolean }>(
    'SELECT caught_up FROM protocol_fee_scan_state WHERE chain_id = $1',
    [chainId],
  );
  return rows[0]?.caught_up === true;
}
