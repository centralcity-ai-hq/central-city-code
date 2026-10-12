/*
 * Identity service (docs/base/ARCHITECTURE.md §6.3, decision (b′)): turns an agent with a Base
 * wallet into a registered Base agent. The agent's spender account registers the ERC-8004 identity
 * with the short agent URI, then hands it to the agent's own wallet, so the owner holds it and we
 * never keep custody. Both steps are durable chain operations with stable keys; `advance` is a
 * step function: call it again until it reports `confirmed` or `failed`. Retries never send twice.
 *
 *   pending ──register op──▶ submitted (no id yet) ──included──▶ provisional id (fast path)
 *           ──transfer op──▶ submitted (hand-over on that id)
 *           ──mint and hand-over both at least SAFE──▶ submitted, stage 'registered' (shown only)
 *           ──both ops final, hand-over bound to the final id, destination checked──▶ confirmed
 *   any op finalized as failed ──▶ failed (a new attempt is a deliberate, separate decision)
 *
 * Finality: 'safe' is a distinct, owner-facing signal and never a substitute for 'final' (the
 * FINALIZED tag). It only drives the stage; the state stays 'submitted' and nothing downstream
 * moves until `confirmed`. Receipts are bound by block HASH (same-height reorgs), never by number.
 * Before `confirmed` on the fast path the service reads the id at the finalized block and requires
 * owner == the agent wallet (the hand-over destination) and tokenURI == this agent's URI; the
 * port's ownerOf == spender check is only the pre-send check of the hand-over.
 *
 * Fast path (the port offers `mintEvidence`): the id is read from the register operation's own
 * receipt as soon as it is INCLUDED, checked against this row (registry, tokenURI, owner), stored
 * as PROVISIONAL and the hand-over starts at once. `confirmed` still needs both operations final.
 * A mint whose receipt goes missing is AMBIGUOUS, never terminal: the register operation and its
 * nonce stay pinned (register() is never called again once `mint_op_id` is set), and while it is
 * missing no hand-over is sent or re-signed. A hand-over key encodes the id it moves, so a re-mint
 * with another id is re-bound to a new key and a stale hand-over can never be reported as done.
 * Nothing outside this service reads provisional state: passport, registration file and
 * authorization read only confirmed rows and only `erc8004_agent_id`.
 *
 * Without `mintEvidence` the original final-only flow runs (same keys, same calls).
 * Every write is fenced on the attempt (`op_id`) and the evidence (`evidence_rev`) it observed.
 */
import type { Database } from '../../database.js';
import type { BaseChainId } from '../../../shared/base/chains.js';
import { baseNetwork } from '../../../shared/base/chains.js';
import { shortAgentUri } from '../../../shared/base/short-id.js';
import { ensureShortId } from './short-links.js';

export type IdentityState = 'pending' | 'submitted' | 'confirmed' | 'failed';

/**
 * How deep an inclusion is, next to the status. 'final' means the FINALIZED tag (and only that);
 * 'safe' the SAFE tag. 'safe' is never treated as final.
 */
export type Finality = 'included' | 'safe' | 'final';

/** The part of a stored chain operation the identity service reads. */
export interface IdentityOp {
  idempotencyKey: string;
  status: 'queued' | 'submitted' | 'included' | 'reconciling' | 'unknown' | 'final' | 'failed';
  txHash: string | null;
  /**
   * Decimal inclusion block: for included, final, or failed after inclusion. transfer() reports it
   * for every included, final or failed-after-inclusion operation.
   */
  blockNumber?: string | null;
  /** The inclusion block's hash, next to `blockNumber` (receipts are bound by hash). */
  blockHash?: string | null;
  /** Optional depth of an included operation; a status 'final' is always finality 'final'. */
  finality?: Finality | null;
  /**
   * The operation was included but its execution REVERTED (USEROP_REVERTED), for an included,
   * final or failed operation. transfer() reports it: a reverted hand-over never moved the id.
   */
  reverted?: boolean;
}

/**
 * What the chain currently says about a register operation, read from its own receipt (fast path).
 * `minted` carries the receipt (tx hash, decimal block), the id it minted for `uri`, the registry
 * that emitted it, and the current tokenURI and owner of that id.
 */
export type MintObservation =
  | {
      kind: 'minted';
      /** The attempt that minted (an earlier attempt when it used this attempt's nonce). */
      opKey: string;
      status: 'included' | 'final';
      /** Depth next to the status: 'safe' while included at the SAFE tag. */
      finality?: Finality;
      txHash: string;
      blockNumber: string;
      /** The receipt's block hash: "the same receipt" is decided by tx and block hash. */
      blockHash: string;
      /** The minted id, decimal (the chain port's shape, #76). */
      id: string;
      registry: string;
      tokenUri: string;
      owner: string;
    }
  /** queued, submitted, unknown, reconciling or reorged: not included right now. */
  | { kind: 'pending'; reason?: string }
  /** Included but reverted (USEROP_REVERTED), not final yet. */
  | { kind: 'reverted' }
  /** Canonical final failure (final revert, or nonce consumed at finality). */
  | { kind: 'failed' }
  /** No stored operation under that key. */
  | { kind: 'none' };

/** What the chain says about an identity at one block (read-only). */
export interface IdentitySnapshot {
  owner: string;
  tokenUri: string;
  /** The block the read was made at (decimal) and its hash. */
  blockNumber: string;
  blockHash: string;
}

/** What the identity service needs from the chain module (server/base/chain/identity-chain.ts). */
export interface IdentityChainPort {
  /**
   * Exactly these fields: the service never passes a nonce, a 'force' flag or any other hint. A
   * retry only names the next attempt key; the port's replacing() pins the nonce of any
   * non-terminal signed sibling of the step, so time never authorizes a fresh nonce.
   */
  register(input: {
    operationKey: string;
    chainId: BaseChainId;
    spenderKeyRef: string;
    spender: string;
    uri: string;
  }): Promise<IdentityOp>;
  /** The id minted by a final registration for this URI (read from that operation's receipt). */
  registeredId(op: IdentityOp, chainId: BaseChainId, uri: string): Promise<bigint>;
  /**
   * Checks before sending that the spender holds `id` (ownerOf == spender; refused otherwise, e.g.
   * IDENTITY_NOT_HELD). Reports blockNumber, blockHash and `reverted` for included, final and
   * failed-after-inclusion operations.
   */
  transfer(input: {
    operationKey: string;
    chainId: BaseChainId;
    spenderKeyRef: string;
    spender: string;
    id: bigint;
    to: string;
  }): Promise<IdentityOp>;
  /**
   * Fast path: the evidence of the register operation stored under `operationKey` or of any
   * earlier signed attempt of its step that landed on the pinned nonce (reported under its own
   * key). The service always asks with the NEWEST attempt the row asked for, so the look-back
   * covers every signed sibling. Read-only: never signs, never sends.
   */
  mintEvidence?(input: {
    operationKey: string;
    chainId: BaseChainId;
    uri: string;
  }): Promise<MintObservation>;
  /**
   * Fast path, required before `confirmed`: the id's owner and tokenURI at the FINALIZED block,
   * with that block's number and hash. Read-only.
   */
  identityAt?(input: {
    chainId: BaseChainId;
    id: bigint;
    blockTag: 'finalized';
  }): Promise<IdentitySnapshot>;
}

/** One JSON line per event; never keys, signatures or secrets. */
export interface IdentityEvent {
  event: string;
  agentId: string;
  chainId: number;
  code?: string;
  txHash?: string;
  latencyMs?: number;
}

export interface IdentityServiceDeps {
  db: Database;
  chain: IdentityChainPort;
  env?: { CITY_BASE_MAINNET?: string };
  now?: () => number;
  log?: (event: IdentityEvent) => void;
}

export class IdentityServiceError extends Error {
  constructor(
    readonly code: 'network_unavailable' | 'wallet_missing' | 'wallet_frozen',
    message: string,
  ) {
    super(message);
  }
}

/** A `base_identities` row as selected with IDENTITY_COLUMNS (numbers as decimal text). */
export interface IdentityRow {
  agent_id: string;
  chain_id: number;
  state: IdentityState;
  op_id: string | null;
  tx_hash: string | null;
  updated_at: string;
  erc8004_agent_id: string | null;
  agent_card_uri: string;
  registry_address: string;
  register_op_id: string | null;
  mint_op_id: string | null;
  provisional_agent_id: string | null;
  mint_tx_hash: string | null;
  mint_block: string | null;
  mint_seen_at: string | null;
  mint_lost_at: string | null;
  transfer_op_id: string | null;
  handover_id: string | null;
  handover_tx_hash: string | null;
  evidence_rev: string;
  started_at: string | null;
  mint_block_hash: string | null;
  mint_finality: Finality | null;
  handover_block: string | null;
  handover_block_hash: string | null;
  handover_finality: Finality | null;
  destination_mismatch: string | null;
}

/** The columns IdentityRow needs; shared by the service and the status route (DB only). */
export const IDENTITY_COLUMNS = `agent_id, chain_id, state, op_id, tx_hash,
  updated_at::text AS updated_at, erc8004_agent_id::text AS erc8004_agent_id, agent_card_uri,
  registry_address, register_op_id, mint_op_id,
  provisional_agent_id::text AS provisional_agent_id, mint_tx_hash, mint_block::text AS mint_block,
  mint_seen_at::text AS mint_seen_at, mint_lost_at::text AS mint_lost_at, transfer_op_id,
  handover_id::text AS handover_id, handover_tx_hash, evidence_rev::text AS evidence_rev,
  started_at::text AS started_at, mint_block_hash, mint_finality,
  handover_block::text AS handover_block, handover_block_hash, handover_finality,
  destination_mismatch`;

export type IdentityStage =
  | 'registering'
  | 'rechecking'
  | 'handing_over'
  | 'finalizing'
  /** Mint and hand-over both at least SAFE: "Registered on Base"; fully final in ~15 minutes. */
  | 'registered'
  | 'confirmed'
  | 'failed';

export interface IdentityView {
  agentId: string;
  chainId: number;
  state: IdentityState;
  /** The FINAL id (from a final register receipt), or null. */
  erc8004AgentId: string | null;
  agentUri: string;
  /** The id read from an included (not yet final) receipt; shown, never used downstream. */
  provisionalAgentId: string | null;
  stage: IdentityStage;
  /** The owner may press "Try again" (retry: true) now. */
  canRetry: boolean;
  /** When the panel should ask again; null once the state is final. */
  pollAfterMs: number | null;
  /** The registration's transaction while it is open. */
  mintTxHash: string | null;
  /** When an id was first seen on chain (ms). */
  idSeenAt: number | null;
  /** When the current registration attempt started (ms), or null for rows from before it was kept. */
  startedAt: number | null;
}

/** Operation keys; a deliberate retry after a failure uses the next attempt number. */
export const registerKey = (agentId: string, chainId: number, attempt = 0) =>
  `identity:register:${chainId}:${agentId}${attempt ? `:${attempt}` : ''}`;
export const transferKey = (agentId: string, chainId: number, attempt = 0) =>
  `identity:transfer:${chainId}:${agentId}${attempt ? `:${attempt}` : ''}`;
/** Fast-path hand-over keys encode the id they move: one key is only ever sent with one id. */
export const handoverKey = (agentId: string, chainId: number, id: bigint, attempt = 0) =>
  `identity:transfer:${chainId}:${agentId}~${id.toString(10)}${attempt ? `:${attempt}` : ''}`;

/** The attempt number of a stored key for this stage, or 0 when it belongs to another stage. */
function attemptOf(opId: string | null, stage: 'register' | 'transfer'): number {
  const parts = opId?.split(':') ?? [];
  if (parts[0] !== 'identity' || parts[1] !== stage) return 0;
  return parts.length === 5 ? Number(parts[4]) : 0;
}
/** A key's family: its first four parts (stage, chain, agent and, for hand-overs, the id). */
const familyOf = (key: string) => key.split(':').slice(0, 4).join(':');
/** The next attempt of a key's family. */
const nextAttempt = (key: string) =>
  `${familyOf(key)}:${attemptOf(key, key.split(':')[1] === 'register' ? 'register' : 'transfer') + 1}`;

/** How long a registration may sit before minting until the owner may retry it. */
export const STUCK_RETRY_MS = 10 * 60 * 1000;
/**
 * How long a pinned mint may stay missing (a seen one, or one fenced at 'included' and never
 * verified) until the owner may retry the registration.
 */
export const LOST_RETRY_MS = 30 * 60_000;

const num = (value: string | null) => (value === null ? null : Number(value));
const isOpen = (state: IdentityState) => state === 'pending' || state === 'submitted';

function stuckBeforeMint(row: IdentityRow, now: number): boolean {
  return (
    row.state === 'submitted' &&
    row.mint_op_id === null &&
    row.erc8004_agent_id === null &&
    row.tx_hash === null &&
    now - Number(row.updated_at) >= STUCK_RETRY_MS
  );
}
function lostTooLong(row: IdentityRow, now: number): boolean {
  return (
    row.state === 'submitted' &&
    row.erc8004_agent_id === null &&
    row.mint_lost_at !== null &&
    now - Number(row.mint_lost_at) >= LOST_RETRY_MS
  );
}

const settled = (finality: Finality | null) => finality === 'safe' || finality === 'final';

/**
 * The stage, decided on the state and the final id first: a migrated legacy row (no mint columns,
 * a final id from a final receipt) is in the hand-over stages, never 'registering'.
 */
function stageOf(row: IdentityRow): IdentityStage {
  if (row.state === 'confirmed') return 'confirmed';
  if (row.state === 'failed') return 'failed';
  if (row.erc8004_agent_id === null) {
    // A verified mint that went missing is rechecked; one never verified is still registering
    // (its ambiguity clock runs all the same, see markLost).
    if (row.mint_op_id !== null && row.mint_lost_at !== null)
      return row.mint_seen_at !== null ? 'rechecking' : 'registering';
    if (row.mint_op_id === null || row.provisional_agent_id === null) return 'registering';
  }
  const id = row.erc8004_agent_id ?? row.provisional_agent_id;
  if (row.destination_mismatch !== null) return 'rechecking';
  if (row.transfer_op_id === null || row.handover_id !== id || row.handover_tx_hash === null)
    return 'handing_over';
  if (settled(row.mint_finality) && settled(row.handover_finality)) return 'registered';
  return 'finalizing';
}

/**
 * How soon the owner's page asks again. Finality takes 15–30 minutes and one finalizing poll costs
 * about 14 RPC calls on the shared endpoint, so the settling stages ask every 30 s.
 */
const POLL_AFTER: Record<IdentityStage, number | null> = {
  registering: 2000,
  handing_over: 3000,
  rechecking: 5000,
  finalizing: 30000,
  registered: 30000,
  confirmed: null,
  failed: null,
};

/** The owner-facing view of a row. Pure; never exposes op ids or the evidence revision. */
export function identityViewOf(row: IdentityRow, now: number): IdentityView {
  const open = isOpen(row.state);
  const stage = stageOf(row);
  return {
    agentId: row.agent_id,
    chainId: row.chain_id,
    state: row.state,
    erc8004AgentId: row.erc8004_agent_id,
    agentUri: row.agent_card_uri,
    provisionalAgentId:
      open && row.erc8004_agent_id === null && row.mint_lost_at === null
        ? row.provisional_agent_id
        : null,
    stage,
    canRetry: row.state === 'failed' || stuckBeforeMint(row, now) || lostTooLong(row, now),
    pollAfterMs: POLL_AFTER[stage],
    mintTxHash: open ? row.mint_tx_hash : null,
    idSeenAt: num(row.mint_seen_at),
    startedAt: num(row.started_at),
  };
}

/** One write to base_identities. Every field is optional except the state. */
interface Patch {
  state: IdentityState;
  /** Sets op_id and (first time only) tx_hash. */
  op?: IdentityOp;
  /** Sets op_id without a transaction. */
  opKey?: string;
  owner?: string;
  registerOpId?: string;
  /** The FINAL id (write-once). */
  finalId?: bigint;
  /** A verified receipt: the provisional id, bound by tx and block hash, with its finality. */
  mint?: {
    opKey: string;
    id: bigint;
    txHash: string | null;
    blockNumber: string | null;
    blockHash: string | null;
    finality: Finality;
  };
  /** The register operation whose receipt is the evidence, nothing verified yet. */
  mintOpId?: string;
  /** The verified receipt is missing now (ambiguous, never terminal). */
  lost?: true;
  clearMint?: true;
  /** The hand-over key and the id it is bound to (clears where it landed and any recheck). */
  bind?: { key: string; id: string };
  /** Where the bound hand-over landed (executed, never reverted), or null: not landed now. */
  handover?: {
    txHash: string | null;
    blockNumber: string | null;
    blockHash: string | null;
    finality: Finality;
  } | null;
  /** The post-transfer destination check's open mismatch, or null once it is closed. */
  recheck?: string | null;
  /** An evidence or binding change: every concurrent poller's later write is refused. */
  bump?: true;
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
};

/**
 * A chain answer that is not the shape the port promises (a node or proxy that answered with
 * nothing usable): read as "unavailable", like a failed read, never as evidence either way.
 */
function answered<T>(value: T, ...fields: string[]): T {
  const ok =
    value !== null &&
    typeof value === 'object' &&
    fields.every((field) => typeof (value as Record<string, unknown>)[field] === 'string');
  if (!ok)
    throw Object.assign(new Error('The chain answered with nothing usable.'), {
      code: 'MALFORMED',
    });
  return value;
}

/** A decimal block number as canonical text, or null when it is not one. */
function blockText(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return value;
}

const lower = (value: string | null | undefined) => (value ?? '').toLowerCase();
/** Two block hashes name the same block; an unknown hash never matches. */
const sameHash = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && lower(a) === lower(b);
/** The depth of an inclusion: status 'final' is the only 'final'; 'safe' never promotes further. */
function depthOf(status: IdentityOp['status'], finality: Finality | null | undefined): Finality {
  if (status === 'final') return 'final';
  return finality === 'safe' || finality === 'final' ? 'safe' : 'included';
}

/**
 * Whether a finally failed hand-over executed (and reverted) before the re-included mint existed.
 * Only for the first attempt of a family, only on the reverted marker (a failure without it never
 * executed), and never on numbers alone when both block hashes are known: at the same height the
 * hashes must name the same block (the revert came first in it), otherwise nothing is concluded.
 */
function executedBeforeMint(
  bound: string,
  op: IdentityOp,
  row: IdentityRow,
): 'yes' | 'no' | 'unknown' {
  const at = blockText(op.blockNumber);
  if (attemptOf(bound, 'transfer') !== 0 || op.reverted !== true) return 'no';
  if (at === null || row.mint_block === null) return 'no';
  const delta = BigInt(at) - BigInt(row.mint_block);
  if (delta < 0n) return 'yes';
  if (delta > 0n) return 'no';
  // Same height: only matching canonical hashes on both sides prove the same block. A missing
  // hash (a read error, or not canonical) is no evidence: hold and recheck, never replace.
  if (op.blockHash && row.mint_block_hash)
    return sameHash(op.blockHash, row.mint_block_hash) ? 'yes' : 'unknown';
  return 'unknown';
}

export function createIdentityService(deps: IdentityServiceDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((event: IdentityEvent) => console.info(JSON.stringify(event)));

  /**
   * The one writer. Fenced on the attempt (op_id) and the evidence revision this advance observed;
   * a newer attempt or newer evidence wins over it. Returns whether the row was written.
   */
  async function save(
    agentId: string,
    chainId: number,
    patch: Patch,
    observed: { opId: string | null; rev: string },
  ): Promise<boolean> {
    const params: unknown[] = [agentId, chainId];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const state = p(patch.state);
    const at = p(now());
    // Column -> expression; a later assignment of the same column replaces an earlier one.
    const sets = new Map<string, string>([['state', `${state}::text`]]);
    const moved = [`state IS DISTINCT FROM ${state}::text`];
    const where: string[] = [];
    let newOpKey: string | null = null;
    if (patch.op) {
      newOpKey = patch.op.idempotencyKey;
      const tx = p(patch.op.txHash ?? null);
      sets.set('op_id', `${p(newOpKey)}::text`).set('tx_hash', `COALESCE(${tx}::text, tx_hash)`);
      moved.push(`(${tx}::text IS NOT NULL AND tx_hash IS NULL)`);
    } else if (patch.opKey !== undefined) {
      newOpKey = patch.opKey;
      sets.set('op_id', `${p(newOpKey)}::text`);
    }
    if (patch.owner !== undefined) sets.set('owner_of_identity', `${p(patch.owner)}::text`);
    if (patch.registerOpId !== undefined)
      sets.set('register_op_id', `${p(patch.registerOpId)}::text`);
    if (patch.finalId !== undefined) {
      const id = p(patch.finalId.toString(10));
      sets.set('erc8004_agent_id', `${id}::numeric`);
      moved.push('erc8004_agent_id IS NULL');
      // Write-once: a different final id is never stored over an existing one.
      where.push(`(erc8004_agent_id IS NULL OR erc8004_agent_id = ${id}::numeric)`);
    }
    if (patch.clearMint)
      for (const column of [
        'mint_op_id',
        'provisional_agent_id',
        'mint_tx_hash',
        'mint_block',
        'mint_block_hash',
        'mint_finality',
        'mint_seen_at',
        'mint_lost_at',
        'destination_mismatch',
      ])
        sets.set(column, 'NULL');
    if (patch.mint) {
      sets
        .set('mint_op_id', `${p(patch.mint.opKey)}::text`)
        .set('provisional_agent_id', `${p(patch.mint.id.toString(10))}::numeric`)
        .set('mint_tx_hash', `${p(patch.mint.txHash)}::text`)
        .set('mint_block', `${p(blockText(patch.mint.blockNumber))}::bigint`)
        .set('mint_block_hash', `${p(patch.mint.blockHash)}::text`)
        .set('mint_finality', `${p(patch.mint.finality)}::text`)
        .set('mint_seen_at', `COALESCE(mint_seen_at, ${at}::bigint)`)
        .set('mint_lost_at', 'NULL')
        .set('destination_mismatch', 'NULL');
    } else if (patch.mintOpId !== undefined) {
      sets.set('mint_op_id', `${p(patch.mintOpId)}::text`);
    }
    if (patch.lost) sets.set('mint_lost_at', `COALESCE(mint_lost_at, ${at}::bigint)`);
    if (patch.bind)
      sets
        .set('transfer_op_id', `${p(patch.bind.key)}::text`)
        .set('handover_id', `${p(patch.bind.id)}::numeric`)
        .set('handover_tx_hash', 'NULL')
        .set('handover_block', 'NULL')
        .set('handover_block_hash', 'NULL')
        .set('handover_finality', 'NULL')
        .set('destination_mismatch', 'NULL');
    if (patch.handover !== undefined) {
      const landed = patch.handover;
      sets
        .set('handover_tx_hash', `${p(landed?.txHash ?? null)}::text`)
        .set('handover_block', `${p(blockText(landed?.blockNumber))}::bigint`)
        .set('handover_block_hash', `${p(landed?.blockHash ?? null)}::text`)
        .set('handover_finality', `${p(landed?.finality ?? null)}::text`);
    }
    if (patch.recheck !== undefined) sets.set('destination_mismatch', `${p(patch.recheck)}::text`);
    if (patch.bump) {
      sets.set('evidence_rev', 'evidence_rev + 1');
      moved.push('TRUE');
    }
    if (patch.state === 'confirmed')
      // Confirmed only on the canonical binding: the final id, handed over under the bound key.
      where.push(
        'erc8004_agent_id IS NOT NULL',
        'handover_id = erc8004_agent_id',
        `transfer_op_id = ${p(newOpKey)}::text`,
      );
    // Only a real change moves the timestamp, so polling never resets the stuck timer.
    sets.set(
      'updated_at',
      `CASE WHEN ${moved.join(' OR ')} THEN ${at}::bigint ELSE updated_at END`,
    );
    const assignments = [...sets].map(([column, value]) => `${column} = ${value}`).join(', ');
    const { rows } = await deps.db.query(
      `UPDATE base_identities SET ${assignments}
       WHERE agent_id = $1 AND chain_id = $2 AND state NOT IN ('confirmed','failed')
         AND (op_id IS NOT DISTINCT FROM ${p(observed.opId)}::text OR op_id = ${p(newOpKey)}::text)
         AND evidence_rev = ${p(observed.rev)}::bigint
         ${where.map((clause) => `AND ${clause}`).join(' ')}
       RETURNING 1`,
      params,
    );
    return rows.length > 0;
  }

  return {
    /** Moves the agent's registration one step forward; safe to call any number of times. */
    async advance(
      agentId: string,
      chainId: BaseChainId,
      options: { retry?: boolean } = {},
    ): Promise<IdentityView> {
      const network = baseNetwork(chainId, deps.env);
      if (!network?.contracts.identityRegistry)
        throw new IdentityServiceError('network_unavailable', 'Network not available.');
      const wallets = await deps.db.query<{
        operator_id: string;
        address: string;
        spender_address: string;
        spender_key_ref: string;
        state: string;
      }>(
        `SELECT operator_id, address, spender_address, spender_key_ref, state
         FROM base_wallets WHERE agent_id = $1 AND chain_id = $2`,
        [agentId, chainId],
      );
      const wallet = wallets.rows[0];
      if (!wallet) throw new IdentityServiceError('wallet_missing', 'The agent has no wallet.');
      if (wallet.state === 'frozen' || wallet.state === 'closed')
        throw new IdentityServiceError('wallet_frozen', 'The wallet is frozen or closed.');

      const uri = shortAgentUri(await ensureShortId(deps.db, agentId, now()));
      await deps.db.query(
        `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
           agent_card_uri, owner_of_identity, state, updated_at, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7) ON CONFLICT (agent_id, chain_id) DO NOTHING`,
        [
          agentId,
          chainId,
          wallet.operator_id,
          network.contracts.identityRegistry,
          uri,
          wallet.spender_address,
          now(),
        ],
      );
      const read = async (): Promise<IdentityRow> => {
        const { rows } = await deps.db.query<IdentityRow>(
          `SELECT ${IDENTITY_COLUMNS} FROM base_identities WHERE agent_id = $1 AND chain_id = $2`,
          [agentId, chainId],
        );
        return rows[0];
      };
      const view = (row: IdentityRow) => identityViewOf(row, now());
      const current = async () => view(await read());
      const fenceOf = (row: IdentityRow) => ({ opId: row.op_id, rev: row.evidence_rev });
      const write = (patch: Patch, row: IdentityRow) => save(agentId, chainId, patch, fenceOf(row));
      const emit = (event: string, extra: Omit<IdentityEvent, 'event' | 'agentId' | 'chainId'>) =>
        log({ event, agentId, chainId, ...extra });
      const fast = typeof deps.chain.mintEvidence === 'function';
      const registerFamily = registerKey(agentId, chainId);
      const isRegisterFamily = (key: string) => familyOf(key) === registerFamily;

      let S = await read();

      // E. Retries: only on the owner's explicit "Try again", one fenced statement per stage,
      // with the gate re-checked in SQL. A failed operation itself is never sent again.
      if (options.retry) {
        const at = now();
        if (
          S.erc8004_agent_id === null &&
          (S.state === 'failed' || stuckBeforeMint(S, at) || lostTooLong(S, at))
        ) {
          // Register stage. R1 failed; R2 stuck before minting (at worst the old operation lands
          // later and mints a second, unused id; no funds move); R3 a pinned mint (seen, or
          // fenced and never verified) missing for 30 minutes. R3 is the only path to a new
          // register signature once a mint is pinned; it is safe because every attempt of the
          // step shares the first attempt's pinned nonce, so at most one mint lands, and when the
          // old one lands instead it is reported and bound.
          // Time NEVER authorizes a fresh nonce: the retry only selects the next attempt key and
          // the register stage below calls register() with it (no 'force', no nonce hint); the
          // port's replacing() pins the nonce of any non-terminal signed sibling.
          // The hand-over binding is kept; fresh evidence re-binds it.
          const next = registerKey(
            agentId,
            chainId,
            attemptOf(S.register_op_id ?? S.op_id, 'register') + 1,
          );
          await deps.db.query(
            `UPDATE base_identities SET state = 'pending', op_id = $3, register_op_id = $3,
               mint_op_id = NULL, provisional_agent_id = NULL, mint_tx_hash = NULL,
               mint_block = NULL, mint_block_hash = NULL, mint_finality = NULL,
               mint_seen_at = NULL, mint_lost_at = NULL,
               started_at = $4::bigint, updated_at = $4::bigint, evidence_rev = evidence_rev + 1
             WHERE agent_id = $1 AND chain_id = $2 AND erc8004_agent_id IS NULL
               AND state = $5 AND op_id IS NOT DISTINCT FROM $6::text
               AND tx_hash IS NOT DISTINCT FROM $7::text AND updated_at = $8::bigint
               AND evidence_rev = $9::bigint
               AND (state = 'failed'
                 OR (state = 'submitted' AND mint_op_id IS NULL AND tx_hash IS NULL
                     AND $4::bigint - updated_at >= $10::bigint)
                 OR (state = 'submitted' AND mint_lost_at IS NOT NULL
                     AND $4::bigint - mint_lost_at >= $11::bigint))`,
            [
              agentId,
              chainId,
              next,
              at,
              S.state,
              S.op_id,
              S.tx_hash,
              S.updated_at,
              S.evidence_rev,
              STUCK_RETRY_MS,
              LOST_RETRY_MS,
            ],
          );
        } else if (S.state === 'failed' && S.erc8004_agent_id !== null) {
          // Transfer stage: the next attempt of the bound family, on the final id.
          const next = nextAttempt(S.transfer_op_id ?? transferKey(agentId, chainId));
          await deps.db.query(
            `UPDATE base_identities SET state = 'pending', op_id = $3, transfer_op_id = $3,
               handover_id = erc8004_agent_id, handover_tx_hash = NULL, handover_block = NULL,
               handover_block_hash = NULL, handover_finality = NULL, destination_mismatch = NULL,
               evidence_rev = evidence_rev + 1, updated_at = $4::bigint
             WHERE agent_id = $1 AND chain_id = $2 AND state = 'failed'
               AND erc8004_agent_id = $5::numeric AND op_id IS NOT DISTINCT FROM $6::text
               AND evidence_rev = $7::bigint`,
            [agentId, chainId, next, now(), S.erc8004_agent_id, S.op_id, S.evidence_rev],
          );
        }
        S = await read();
      }
      if (!isOpen(S.state)) return view(S);
      const spender = { spenderKeyRef: wallet.spender_key_ref, spender: wallet.spender_address };

      // F. Register stage: only while no register operation is pinned as evidence.
      if (S.mint_op_id === null && S.erc8004_agent_id === null) {
        // The row keeps the attempt it asked for, even when the chain reports an earlier attempt
        // of the step (one that landed under its own key): the next retry then gets a new number.
        const key =
          S.register_op_id ?? registerKey(agentId, chainId, attemptOf(S.op_id, 'register'));
        const reported = await deps.chain.register({
          operationKey: key,
          chainId,
          uri: S.agent_card_uri,
          ...spender,
        });
        const op = { ...reported, idempotencyKey: key };
        if (reported.status === 'failed') {
          await write({ state: 'failed', op, registerOpId: key, bump: true }, S);
          return current();
        }
        if (
          fast &&
          (reported.status === 'included' || reported.status === 'final') &&
          isRegisterFamily(reported.idempotencyKey)
        ) {
          // Fence first: from here on register() is never called again for this row (only the
          // owner's gated retry clears it), even when the evidence below does not hold.
          const fenced = await write(
            {
              state: 'submitted',
              op,
              registerOpId: key,
              mintOpId: reported.idempotencyKey,
              bump: true,
            },
            S,
          );
          // A stale result (a newer attempt owns the row) never starts the next stage.
          if (!fenced) return current();
          S = await read();
        } else if (!fast && reported.status === 'final') {
          const id = await deps.chain.registeredId(reported, chainId, S.agent_card_uri);
          const saved = await write(
            {
              state: 'submitted',
              op,
              registerOpId: key,
              mint: {
                opKey: isRegisterFamily(reported.idempotencyKey) ? reported.idempotencyKey : key,
                id,
                txHash: reported.txHash,
                blockNumber: reported.blockNumber ?? null,
                blockHash: reported.blockHash ?? null,
                finality: 'final',
              },
              finalId: id,
              bump: true,
            },
            S,
          );
          if (!saved) return current();
          S = await read();
        } else {
          await write({ state: 'submitted', op, registerOpId: key }, S);
          return current();
        }
      }

      // G. Evidence stage (fast path): what the pinned register operation's receipt says now.
      let fresh: bigint | null = null;
      if (fast && S.mint_op_id !== null && S.erc8004_agent_id === null) {
        let obs: MintObservation;
        try {
          // Asked by the newest attempt the row asked for (a register retry moves it on), so the
          // port's look-back covers every signed sibling; mint_op_id stays the key that landed.
          obs = answered(
            await deps.chain.mintEvidence!({
              operationKey: S.register_op_id ?? S.mint_op_id,
              chainId,
              uri: S.agent_card_uri,
            }),
            'kind',
          );
        } catch (error) {
          // Nothing is concluded from an unavailable read.
          emit('identity.evidence_unavailable', { code: errorCode(error) });
          return current();
        }
        // The ambiguity clock starts for ANY pinned mint whose evidence does not verify now, seen
        // before or not: a register operation fenced at 'included' whose receipt is reorged out
        // (or reads as a mismatch) before it was ever verified is otherwise a dead end, since
        // register() is never called again once mint_op_id is set. After LOST_RETRY_MS the
        // owner's gated retry (R3) selects the next attempt key; the nonce stays pinned.
        const markLost = async (row: IdentityRow) => {
          if (row.mint_lost_at === null)
            await write({ state: 'submitted', lost: true, bump: true }, row);
        };
        if (obs.kind === 'failed') {
          // Canonical: the registration can never land. The hand-over binding is kept (a new
          // mint re-binds it); the owner retries the register stage.
          await write({ state: 'failed', clearMint: true, bump: true }, S);
          emit('identity.register_failed', {});
          return current();
        }
        if (obs.kind !== 'minted') {
          // Ambiguous, never terminal: no register, no transfer, nothing cleared.
          await markLost(S);
          return current();
        }
        // The port reports the id as a decimal string; anything else is not evidence.
        if (!/^(0|[1-9][0-9]{0,77})$/.test(obs.id)) {
          emit('identity.evidence_mismatch', { code: 'bad_id' });
          await markLost(S);
          return current();
        }
        const mintedId = BigInt(obs.id);
        // The same receipt: same tx in the same block, decided by HASH (same-height reorgs).
        const sameReceipt =
          obs.txHash === S.mint_tx_hash && sameHash(obs.blockHash, S.mint_block_hash);
        const mismatch = !isRegisterFamily(obs.opKey)
          ? 'foreign_operation'
          : lower(obs.registry) !== lower(S.registry_address)
            ? 'registry_mismatch'
            : obs.tokenUri !== S.agent_card_uri
              ? 'uri_mismatch'
              : // The id comes from our own register receipt with our tokenURI, so it was minted
                // to the spender, and only our hand-over moves it, only to this agent's wallet.
                // The wallet is accepted whatever hand-over is bound now: after an id flip the
                // branch where an earlier hand-over (~obs.id) executed can still win, and H then
                // derives that same key again and only reconciles it.
                !(
                    sameReceipt ||
                    lower(obs.owner) === lower(wallet.spender_address) ||
                    lower(obs.owner) === lower(wallet.address)
                  )
                ? 'owner_mismatch'
                : blockText(obs.blockNumber) === null || !obs.blockHash
                  ? 'bad_receipt'
                  : null;
        if (mismatch) {
          emit('identity.evidence_mismatch', { code: mismatch, txHash: obs.txHash });
          await markLost(S);
          return current();
        }
        const final = obs.status === 'final';
        const depth = depthOf(obs.status, obs.finality);
        const changed =
          !sameReceipt ||
          S.provisional_agent_id !== obs.id ||
          S.mint_lost_at !== null ||
          S.mint_op_id !== obs.opKey ||
          S.mint_finality !== depth ||
          final;
        if (changed) {
          // Same tx and block hash promoted (safe or final): no new owner read is needed.
          const saved = await write(
            {
              state: 'submitted',
              mint: {
                opKey: obs.opKey,
                id: mintedId,
                txHash: obs.txHash,
                blockNumber: obs.blockNumber,
                blockHash: obs.blockHash,
                finality: depth,
              },
              finalId: final ? mintedId : undefined,
              bump: true,
            },
            S,
          );
          if (!saved) {
            // A stale poller, or (critical) a different final id already stored.
            const latest = await read();
            if (final && latest.erc8004_agent_id !== null && latest.erc8004_agent_id !== obs.id)
              emit('identity.final_id_conflict', { code: 'critical', txHash: obs.txHash });
            return view(latest);
          }
          if (S.mint_seen_at === null)
            emit('identity.provisional_bound', {
              txHash: obs.txHash,
              latencyMs: now() - Number(S.started_at ?? S.updated_at),
            });
          S = await read();
        }
        fresh = mintedId;
      }

      /** The post-transfer destination check at the finalized block (fast path). */
      const destinationCheck = async (
        finalId: bigint,
        row: IdentityRow,
        handover: IdentityOp,
      ): Promise<'ok' | 'unavailable' | string> => {
        if (typeof deps.chain.identityAt !== 'function') {
          emit('identity.destination_unavailable', { code: 'not_supported' });
          return 'unavailable';
        }
        let at: IdentitySnapshot;
        try {
          at = answered(
            await deps.chain.identityAt({ chainId, id: finalId, blockTag: 'finalized' }),
            'owner',
            'tokenUri',
          );
        } catch (error) {
          emit('identity.destination_unavailable', { code: errorCode(error) });
          return 'unavailable';
        }
        const block = blockText(at.blockNumber);
        const behind = (landedAt: string | null | undefined) =>
          blockText(landedAt) !== null && BigInt(block!) < BigInt(landedAt!);
        const code =
          block === null || !at.blockHash
            ? 'bad_evidence'
            : behind(row.mint_block) || behind(handover.blockNumber)
              ? 'evidence_behind'
              : at.tokenUri !== row.agent_card_uri
                ? 'uri_mismatch'
                : lower(at.owner) !== lower(wallet.address)
                  ? 'owner_mismatch'
                  : null;
        if (code === null) return 'ok';
        emit('identity.destination_mismatch', { code, txHash: handover.txHash ?? undefined });
        return code;
      };

      // H. Hand-over stage: only on the final id, or on an id this call just verified.
      const id =
        S.erc8004_agent_id ??
        (fresh !== null && S.provisional_agent_id === fresh.toString(10) && S.mint_lost_at === null
          ? S.provisional_agent_id
          : null);
      if (id === null || !isOpen(S.state)) return view(S);
      if (S.transfer_op_id === null || S.handover_id !== id || S.op_id !== S.transfer_op_id) {
        // First binding, a re-binding after the id changed, or back from a register retry. The
        // old key is never discarded: when the chain flips back to its id it is derived again
        // and only reconciled. A key already bound to this id is kept whatever its family (a
        // pre-85 hand-over under identity:transfer:<chain>:<agent> is in flight on its own nonce
        // lane; a new key would sign a second hand-over); otherwise a key of the wanted family
        // is reused; otherwise the wanted key.
        const want = fast
          ? handoverKey(agentId, chainId, BigInt(id))
          : transferKey(agentId, chainId, attemptOf(S.op_id, 'transfer'));
        const key =
          S.transfer_op_id !== null && S.handover_id === id
            ? S.transfer_op_id
            : S.transfer_op_id !== null && familyOf(S.transfer_op_id) === familyOf(want)
              ? S.transfer_op_id
              : want;
        // Write-ahead: the binding is stored before anything is sent under the key.
        if (!(await write({ state: 'submitted', opKey: key, bind: { key, id }, bump: true }, S)))
          return current();
        S = await read();
      }
      const bound = S.transfer_op_id!;
      let t: IdentityOp;
      try {
        // The port's pre-send check (ownerOf == spender) lives in transfer(); it is never the
        // evidence for `confirmed` (see the destination check below).
        t = answered(
          await deps.chain.transfer({
            operationKey: bound,
            chainId,
            id: BigInt(S.handover_id!),
            to: wallet.address,
            ...spender,
          }),
          'idempotencyKey',
          'status',
        );
      } catch (error) {
        // Refused before storing (e.g. IDENTITY_NOT_HELD on a lagging read): the same key is
        // tried again on the next call, never a new one.
        emit('identity.handover_refused', { code: errorCode(error) });
        return current();
      }
      const ours = familyOf(t.idempotencyKey) === familyOf(bound);
      if (!ours) emit('identity.handover_foreign_report', { code: 'foreign_operation' });
      const top: IdentityOp = ours
        ? { ...t, idempotencyKey: bound }
        : { idempotencyKey: bound, status: 'submitted', txHash: null };
      const canonical = S.erc8004_agent_id !== null && S.handover_id === S.erc8004_agent_id;
      // A reverted inclusion never moved the id: it is never recorded as the hand-over.
      const reverted = top.reverted === true;
      const landed = (finality: Finality) => ({
        txHash: top.txHash,
        blockNumber: top.blockNumber ?? null,
        blockHash: top.blockHash ?? null,
        finality,
      });
      if (top.status === 'final' && !reverted) {
        // A stale or provisional hand-over is never reported done.
        if (!canonical) {
          await write({ state: 'submitted', handover: landed('final'), recheck: null }, S);
          return current();
        }
        if (fast) {
          // Destination check: at the settled (finalized) block the id must be held by the agent
          // wallet with this agent's URI. The same spender can hold more than one identity, so a
          // final hand-over alone is not that evidence. A mismatch is never terminal.
          const verdict = await destinationCheck(BigInt(S.erc8004_agent_id!), S, top);
          if (verdict !== 'ok') {
            await write(
              {
                state: 'submitted',
                handover: landed('final'),
                ...(verdict === 'unavailable' ? {} : { recheck: verdict }),
              },
              S,
            );
            return current();
          }
        }
        await write(
          {
            state: 'confirmed',
            owner: wallet.address,
            op: top,
            handover: landed('final'),
            recheck: null,
            bump: true,
          },
          S,
        );
      } else if (top.status === 'failed' || top.status === 'final') {
        const before = executedBeforeMint(bound, top, S);
        if (!canonical) {
          // Fenced: decided only once the register operation is final.
          await write({ state: 'submitted', handover: null, recheck: null }, S);
        } else if (before === 'yes') {
          // It executed (and reverted) before the re-included mint existed and its failure is
          // final, so the next nonce is safe; the next call sends it (the id is final).
          const next = nextAttempt(bound);
          await write(
            {
              state: 'submitted',
              opKey: next,
              bind: { key: next, id: S.erc8004_agent_id! },
              bump: true,
            },
            S,
          );
        } else if (before === 'unknown') {
          // Same height, different blocks: one of the receipts is not canonical. Nothing is
          // concluded; the next read decides.
          emit('identity.handover_block_conflict', { code: 'block_hash_mismatch' });
          await write({ state: 'submitted', handover: null, recheck: null }, S);
        } else {
          await write({ state: 'failed', op: top, handover: null, bump: true }, S);
        }
      } else if (top.status === 'included') {
        await write(
          {
            state: 'submitted',
            op: top,
            handover: reverted ? null : landed(depthOf('included', top.finality)),
            recheck: null,
          },
          S,
        );
      } else {
        // queued, submitted, unknown or reconciling: an orphaned hand-over keeps its key; the
        // port rebroadcasts the stored operation.
        await write({ state: 'submitted', op: top, handover: null, recheck: null }, S);
      }
      return current();
    },
  };
}
