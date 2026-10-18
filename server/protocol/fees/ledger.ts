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
 * checkpoint, replaces every row in the rescanned range with what the chain says now (so a reorged
 * log disappears), and advances the checkpoint in the same transaction. Unwired for now: nothing
 * registers the migration or runs a scan until Phase 0 wires it behind its flag.
 */
import {
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem';
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

/** Migration 113 `protocol_fee_ledger`. Not registered until the ledger is wired (Phase 0). */
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
   * Fee routers added after the first (router 2, payments above 0.10 USDC): the same FeeCharged
   * event from another address, read and counted exactly like router 1 from its deploy block.
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
  return rows.filter((row) => {
    if (row.fee <= 0n || row.fee > row.gross) return false;
    const pool = transfers.get(`${row.txHash}:${row.blockHash}`);
    const at = pool?.indexOf(row.fee) ?? -1;
    if (!pool || at < 0) return false;
    pool.splice(at, 1);
    return true;
  });
}

async function rangeLogs(
  chain: FeeChain,
  config: FeeLedgerConfig,
  from: bigint,
  to: bigint,
  pastDeadline: () => boolean = () => false,
): Promise<{ logs: ChainLog[]; through: bigint }> {
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
  for (let start = from; start <= to; start += MAX_LOG_RANGE) {
    if (through >= from && pastDeadline()) break;
    const end = start + MAX_LOG_RANGE - 1n < to ? start + MAX_LOG_RANGE - 1n : to;
    for (const source of sources)
      logs.push(...(await chain.getLogs({ ...source, fromBlock: start, toBlock: end })));
    through = end;
  }
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  return { logs, through };
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
   * The run stopped short of the range it planned (out of time, or a block it could not confirm)
   * and committed the confirmed prefix [from, to]; the next run continues from there.
   */
  partial?: 'deadline' | 'reorg' | 'error';
}

/** Advisory lock key for fee scans (one scan per database at a time). */
export const PROTOCOL_FEE_SCAN_LOCK_KEY = 1347568710;

/**
 * Scans from the earlier of (checkpoint - REORG_DEPTH) and the first block not yet verified as
 * final, up to the latest block, at most `maxBlocks` per call. Rows in the rescanned range are
 * replaced by what the chain returns now; the checkpoint moves in the same transaction. A row is
 * promoted to final only inside the range this run rescanned and only up to the chain's finalized
 * block, so every final row was re-read from the canonical chain after its block became final.
 *
 * With `budgetMs`, a run that runs out of time (or, after it confirmed at least one block, meets a
 * block it cannot confirm or cannot read) commits the prefix it confirmed: rows, finality and
 * finalized_through up to there. A long not-yet-final window (a finality stall) then drains over
 * several runs instead of failing every one. A block that is not final yet and is already stored
 * with the same hash keeps its stored time without a block read; a block that this run promotes
 * is always checked against the canonical chain.
 */
export async function scanFees(
  db: Database,
  chain: FeeChain,
  config: FeeLedgerConfig,
  options: { maxBlocks?: bigint; now?: () => number; budgetMs?: number } = {},
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
  const read = await rangeLogs(chain, config, from, to, pastDeadline);
  let partial: ScanResult['partial'];
  if (read.through < to) {
    to = read.through;
    partial = 'deadline';
  }
  let rows = feeRowsFromLogs(config, read.logs);
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
      stopAt(row.blockNumber, 'error');
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
    const gone = await tx.query<{ key: string; service_verified: boolean }>(
      `DELETE FROM protocol_fee_events WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3
       RETURNING tx_hash || ':' || log_index || ':' || block_hash || ':' || payer || ':' || payee
         || ':' || ref || ':' || kind || ':' || gross::text || ':' || fee::text AS key, service_verified`,
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
    const promoteTo = to < finalized ? to : finalized;
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
 * A router added after the scan already passed its deploy block (router 2 is configured after it is
 * deployed): the first scan that sees it records it in protocol_fee_router_starts (migration 232)
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
  /** Every fee recorded (fees and revenue count all of them). */
  feeCount: number;
  /** Sum of service prices of calls whose service is proven (USDC units). */
  volume: bigint;
  /** Sum of protocol fees (USDC units); fees = revenue = protocol revenue. */
  fees: bigint;
}

/** Daily totals for public metrics: every paid call counts the same way. */
export async function dailyFees(
  db: Pick<Database, 'query'>,
  chainId: number,
  fromTime: number,
  toTime: number,
  options: { finalizedOnly?: boolean } = {},
): Promise<DailyFees[]> {
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
      GROUP BY 1 ORDER BY 1`,
    [chainId, fromTime, toTime],
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
 * (which already carries its treasury-transfer proof). Used by the daily reconcile of settled
 * calls (FEES.md); `finalizedOnly` for anything reported as final.
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
 * Marks a fee-on-top call's service as proven once its seller settlement is matched (Z2: the x402
 * settlement moved exactly `gross` USDC from the payer to the payee). Only then does its price
 * count as volume. A rescan keeps the mark of a row that is still there; a row it replaced or
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
