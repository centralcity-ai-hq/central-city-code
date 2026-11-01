/*
 * Confirmed Base IDs whose registration moved away from Central City after confirmation.
 *
 * Once confirmed, a Base ID sits in the agent's own wallet, which its owner's key controls: the
 * holder may point the ID's agent URI elsewhere (the registry's setAgentURI) or transfer the ID.
 * Central City then no longer vouches for it: an ID in `base_identity_moves` is left out of the
 * domain file (`/.well-known/agent-registration.json`), of the registrations its `/a/<short>` file
 * names, and of the passport its Agent Card carries, until a check at the finalized block finds it
 * back in the agent wallet with its `/a/<short>` URI (re-verified: the row is then deleted). The
 * identity row itself is never changed: Base is the record, and the explorer reads its owner there.
 *
 * Seen through the registry's logs, read over closed ranges up to the finalized block from a
 * cursor per chain (`base_identity_watch`): ERC-721 Transfer, ERC-4906 MetadataUpdate (written
 * with every tokenURI change) and ERC-8004 URIUpdated. A log of a confirmed ID in any transaction
 * but the ID's own mint and hand-over moves it at once ('seen'); its check follows and records
 * what differs ('owner', 'uri', or 'missing' when the ID no longer exists). Moved IDs are checked
 * again every RECHECK_EVERY_MS. Bounded per run: WATCH_BLOCKS_PER_RUN blocks in pages of at most
 * MAX_LOG_RANGE_BLOCKS, LOG_READS_PER_RUN log reads and RECHECKS_PER_RUN checks; the cursor
 * commits with the moves its range found, so a failed run loses nothing and the next one
 * continues.
 *
 * The first run on a chain starts at the earliest stored mint block of its confirmed IDs; an ID
 * confirmed before blocks were recorded is covered from there on.
 */
import {
  decodeEventLog,
  getAddress,
  hexToBigInt,
  parseAbi,
  toEventSelector,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import {
  BASE_MAINNET,
  BASE_NETWORKS,
  BASE_SEPOLIA,
  type BaseChainId,
} from '../../../shared/base/chains.js';
import {
  ARC_NETWORKS,
  chainFamily,
  type ArcChainId,
  type ChainId,
} from '../../../shared/chains.js';
import { MAX_LOG_RANGE_BLOCKS } from '../chain/rpc-budget.js';

export const IDENTITY_MOVE_TABLES = ['base_identity_moves', 'base_identity_watch'] as const;

/**
 * Migration 282 `base_identity_moves`: the moved IDs (above) and the log cursor of each chain.
 * Two new tables, no data change. Derived from Base: never exported; after a restore the next
 * runs read the logs again from the earliest stored block.
 */
export const BASE_IDENTITY_MOVES_SQL = `
CREATE TABLE IF NOT EXISTS base_identity_moves (
  agent_id text NOT NULL,
  chain_id integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('seen', 'owner', 'uri', 'missing')),
  moved_at bigint NOT NULL,
  block bigint,
  checked_at bigint,
  PRIMARY KEY (agent_id, chain_id)
);
CREATE INDEX IF NOT EXISTS base_identity_moves_due
  ON base_identity_moves (chain_id, checked_at NULLS FIRST);
CREATE TABLE IF NOT EXISTS base_identity_watch (
  chain_id integer PRIMARY KEY,
  scanned_block bigint NOT NULL CHECK (scanned_block >= 0),
  updated_at bigint NOT NULL
);`;

export const baseIdentityMovesMigration: Migration = {
  version: 282,
  name: 'base_identity_moves',
  sql: BASE_IDENTITY_MOVES_SQL,
};

/** Idempotent; call before runMigrations (after the Base migrations). */
export function registerBaseIdentityMovesMigration(): void {
  registerMigration(baseIdentityMovesMigration);
}

/** The condition "this identity has not moved", on base_identities aliased `i`. */
export const NOT_MOVED = `NOT EXISTS (SELECT 1 FROM base_identity_moves mv
  WHERE mv.agent_id = i.agent_id AND mv.chain_id = i.chain_id)`;

export const WATCH_BLOCKS_PER_RUN = 20_000n;
export const RECHECKS_PER_RUN = 10;
export const RECHECK_EVERY_MS = 10 * 60_000;
/** Smallest range a refused log read is split down to; below it the error stands. */
const MIN_LOG_RANGE = 8n;
/** Log reads one run may make, splits included. */
export const LOG_READS_PER_RUN = 40;

const registryEvents = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event MetadataUpdate(uint256 _tokenId)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
]);
export const WATCHED_TOPICS: readonly Hex[] = registryEvents.map((event) => toEventSelector(event));

export interface WatchLog {
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
}

/** The reads one chain's watch needs; tests pass a fake. */
export interface WatchChain {
  finalizedBlock(): Promise<bigint>;
  /** The registry's logs whose first topic is one of `topics`, over [fromBlock, toBlock]. */
  logs(input: { topics: readonly Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<WatchLog[]>;
  /** The ID's owner and tokenURI at the finalized block; 'missing' when it does not exist there. */
  identityAt(id: bigint): Promise<{ owner: string; tokenUri: string } | 'missing'>;
}

/** The token id a watched log is about, or null when it is not one of them. */
export function tokenIdOf(log: WatchLog): bigint | null {
  try {
    const decoded = decodeEventLog({
      abi: registryEvents,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    });
    const args = decoded.args as { tokenId?: bigint; _tokenId?: bigint; agentId?: bigint };
    return args.tokenId ?? args._tokenId ?? args.agentId ?? null;
  } catch {
    return null;
  }
}

type IdentityAt = (input: {
  chainId: ChainId;
  id: bigint;
  blockTag: 'finalized';
}) => Promise<{ owner: string; tokenUri: string }>;

/** A WatchChain over the network's read client and the identity port's finalized read. */
export function watchChainOf(
  chainId: ChainId,
  client: PublicClient,
  identityAt: IdentityAt,
): WatchChain | null {
  const registry = (
    chainFamily(chainId) === 'arc'
      ? ARC_NETWORKS[chainId as ArcChainId]
      : BASE_NETWORKS[chainId as BaseChainId]
  ).contracts.identityRegistry;
  if (!registry) return null;
  return {
    finalizedBlock: async () => {
      const block = await client.getBlock({ blockTag: 'finalized' });
      if (block.number === null || block.number === undefined) throw new Error('no block');
      return block.number;
    },
    logs: async ({ topics, fromBlock, toBlock }) => {
      // Raw eth_getLogs: one filter with the three event topics as alternatives.
      const logs = (await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: registry,
            fromBlock: toHex(fromBlock),
            toBlock: toHex(toBlock),
            topics: [[...topics]],
          },
        ],
      } as never)) as Array<{ topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex }>;
      return logs.map((log) => ({
        topics: log.topics,
        data: log.data,
        transactionHash: log.transactionHash,
        blockNumber: hexToBigInt(log.blockNumber),
      }));
    },
    identityAt: async (id) => {
      try {
        return await identityAt({ chainId, id, blockTag: 'finalized' });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'NOT_FOUND') return 'missing';
        throw error;
      }
    },
  };
}

export interface WatchRun {
  chainId: number;
  scannedTo: string | null;
  moved: number;
  checked: number;
  verified: number;
  error?: string;
}

const lower = (value: string | null | undefined) => (value ?? '').toLowerCase();

/**
 * One range's logs; a refused range is halved and each half read again, down to MIN_LOG_RANGE
 * (a node refuses an answer with too many logs). At most LOG_READS_PER_RUN reads per run, so a
 * node that refuses everything costs a few reads, never a cascade.
 */
async function splitLogs(
  chain: WatchChain,
  from: bigint,
  to: bigint,
  budget: { left: number },
): Promise<WatchLog[]> {
  if (budget.left <= 0) throw Object.assign(new Error('log reads spent'), { code: 'unavailable' });
  budget.left -= 1;
  try {
    return await chain.logs({ topics: WATCHED_TOPICS, fromBlock: from, toBlock: to });
  } catch (error) {
    if (to - from + 1n <= MIN_LOG_RANGE) throw error;
    const mid = from + (to - from) / 2n;
    return [
      ...(await splitLogs(chain, from, mid, budget)),
      ...(await splitLogs(chain, mid + 1n, to, budget)),
    ];
  }
}

/** The cursor of a chain, created on its first run (see the header). */
async function cursorOf(
  db: Pick<Database, 'query'>,
  chainId: number,
  finalized: bigint,
  now: number,
): Promise<bigint> {
  const stored = (
    await db.query<{ scanned_block: string }>(
      'SELECT scanned_block::text AS scanned_block FROM base_identity_watch WHERE chain_id = $1',
      [chainId],
    )
  ).rows[0]?.scanned_block;
  if (stored !== undefined) return BigInt(stored);
  const first = (
    await db.query<{ block: string | null }>(
      `SELECT (min(COALESCE(mint_block, handover_block)) - 1)::text AS block
       FROM base_identities WHERE chain_id = $1 AND state = 'confirmed'`,
      [chainId],
    )
  ).rows[0]?.block;
  const start =
    first !== null && first !== undefined && BigInt(first) >= 0n ? BigInt(first) : finalized;
  await db.query(
    `INSERT INTO base_identity_watch (chain_id, scanned_block, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (chain_id) DO NOTHING`,
    [chainId, start.toString(), now],
  );
  return start;
}

/**
 * One run on one chain: the next log ranges, then the due checks. Throws nothing: a failed read
 * ends the run with `error` (a code, never the node's message), and what was committed stays.
 */
export async function watchIdentities(
  db: Pick<Database, 'query' | 'transaction'>,
  chainId: number,
  chain: WatchChain,
  options: { now?: () => number; blocksPerRun?: bigint; recheckLimit?: number } = {},
): Promise<WatchRun> {
  const now = options.now ?? Date.now;
  const run: WatchRun = { chainId, scannedTo: null, moved: 0, checked: 0, verified: 0 };
  try {
    const finalized = await chain.finalizedBlock();
    const cursor = await cursorOf(db, chainId, finalized, now());
    const last = cursor + (options.blocksPerRun ?? WATCH_BLOCKS_PER_RUN);
    const to = finalized < last ? finalized : last;
    const budget = { left: LOG_READS_PER_RUN };
    for (let start = cursor + 1n; start <= to; start += MAX_LOG_RANGE_BLOCKS) {
      const page = start + MAX_LOG_RANGE_BLOCKS - 1n;
      const end = page < to ? page : to;
      // Per token id: the newest block it was seen in, and every transaction it was seen in.
      const seen = new Map<string, { block: bigint; txs: Set<string> }>();
      for (const log of await splitLogs(chain, start, end, budget)) {
        const id = tokenIdOf(log);
        if (id === null) continue;
        const entry = seen.get(id.toString()) ?? { block: 0n, txs: new Set<string>() };
        if (log.blockNumber > entry.block) entry.block = log.blockNumber;
        entry.txs.add(lower(log.transactionHash));
        seen.set(id.toString(), entry);
      }
      await db.transaction(async (tx) => {
        if (seen.size) {
          const { rows } = await tx.query<{
            agent_id: string;
            id: string;
            tx_hash: string | null;
            mint_tx_hash: string | null;
            handover_tx_hash: string | null;
          }>(
            `SELECT agent_id, erc8004_agent_id::text AS id, tx_hash, mint_tx_hash, handover_tx_hash
             FROM base_identities
             WHERE chain_id = $1 AND state = 'confirmed' AND erc8004_agent_id = ANY($2::numeric[])`,
            [chainId, [...seen.keys()]],
          );
          for (const row of rows) {
            const entry = seen.get(row.id);
            if (!entry) continue;
            // The ID's own mint and hand-over are how it got here.
            const own = new Set([row.tx_hash, row.mint_tx_hash, row.handover_tx_hash].map(lower));
            if ([...entry.txs].every((hash) => own.has(hash))) continue;
            // A new log of an ID already moved asks for its check again at once.
            await tx.query(
              `INSERT INTO base_identity_moves (agent_id, chain_id, reason, moved_at, block)
               VALUES ($1, $2, 'seen', $3, $4)
               ON CONFLICT (agent_id, chain_id) DO UPDATE SET checked_at = NULL,
                 block = GREATEST(base_identity_moves.block, EXCLUDED.block)`,
              [row.agent_id, chainId, now(), entry.block.toString()],
            );
            run.moved += 1;
          }
        }
        await tx.query(
          `UPDATE base_identity_watch SET scanned_block = $2, updated_at = $3
           WHERE chain_id = $1 AND scanned_block < $2`,
          [chainId, end.toString(), now()],
        );
      });
      run.scannedTo = end.toString();
    }
    const due = (
      await db.query<{
        agent_id: string;
        id: string;
        uri: string;
        wallet: string | null;
        block: string | null;
        checked_at: string | null;
      }>(
        `SELECT mv.agent_id, i.erc8004_agent_id::text AS id, i.agent_card_uri AS uri,
           w.address AS wallet, mv.block::text AS block, mv.checked_at::text AS checked_at
         FROM base_identity_moves mv
         JOIN base_identities i ON i.agent_id = mv.agent_id AND i.chain_id = mv.chain_id
         LEFT JOIN base_wallets w ON w.agent_id = mv.agent_id AND w.chain_id = mv.chain_id
         WHERE mv.chain_id = $1 AND (mv.checked_at IS NULL OR mv.checked_at <= $2)
         ORDER BY mv.checked_at NULLS FIRST, mv.moved_at LIMIT $3`,
        [chainId, now() - RECHECK_EVERY_MS, options.recheckLimit ?? RECHECKS_PER_RUN],
      )
    ).rows;
    for (const row of due) {
      const at = await chain.identityAt(BigInt(row.id));
      run.checked += 1;
      const reason =
        at === 'missing'
          ? 'missing'
          : !row.wallet || lower(getAddress(at.owner)) !== lower(row.wallet)
            ? 'owner'
            : at.tokenUri !== row.uri
              ? 'uri'
              : null;
      if (reason === null) {
        // Back in the agent wallet with its own URI at the finalized block: re-verified, listed
        // again; unless a newer log of it was stored meanwhile (its own check comes next).
        const removed = await db.query(
          `DELETE FROM base_identity_moves WHERE agent_id = $1 AND chain_id = $2
             AND block IS NOT DISTINCT FROM $3::bigint AND checked_at IS NOT DISTINCT FROM $4::bigint
           RETURNING agent_id`,
          [row.agent_id, chainId, row.block, row.checked_at],
        );
        run.verified += removed.rows.length;
      } else
        await db.query(
          `UPDATE base_identity_moves SET reason = $3, checked_at = $4
           WHERE agent_id = $1 AND chain_id = $2`,
          [row.agent_id, chainId, reason, now()],
        );
    }
  } catch (error) {
    // The code only, never the node's message (it can carry the RPC URL).
    const code = (error as { code?: unknown }).code;
    run.error = typeof code === 'string' ? code : 'unavailable';
  }
  return run;
}

/**
 * One run on every network that has confirmed IDs (Base, Base Sepolia, then Arc's network while Arc
 * is on, `arcChainId`; one chain's reads failing never stops another's). A network whose
 * runtime or reads are not configured is skipped with `error: 'not_configured'`.
 */
export async function watchConfirmedIdentities(
  db: Pick<Database, 'query' | 'transaction'>,
  runtime: (chainId: ChainId) => Promise<{
    readClient?: PublicClient;
    identityPort: { identityAt?: IdentityAt };
  }>,
  options: { now?: () => number; arcChainId?: number | null } = {},
): Promise<WatchRun[]> {
  const { rows } = await db.query<{ chain_id: number }>(
    `SELECT u.c AS chain_id FROM unnest($1::int[]) WITH ORDINALITY AS u(c, n)
     WHERE EXISTS (SELECT 1 FROM base_identities WHERE chain_id = u.c AND state = 'confirmed')
     ORDER BY u.n`,
    [[BASE_MAINNET, BASE_SEPOLIA, ...(options.arcChainId ? [options.arcChainId] : [])]],
  );
  const runs: WatchRun[] = [];
  for (const { chain_id: chainId } of rows) {
    const id = chainId as ChainId;
    let chain: WatchChain | null = null;
    try {
      const built = await runtime(id);
      const identityAt = built.identityPort.identityAt?.bind(built.identityPort);
      chain =
        built.readClient && identityAt ? watchChainOf(id, built.readClient, identityAt) : null;
    } catch {
      chain = null;
    }
    runs.push(
      chain
        ? await watchIdentities(db, chainId, chain, options)
        : { chainId, scannedTo: null, moved: 0, checked: 0, verified: 0, error: 'not_configured' },
    );
  }
  return runs;
}
