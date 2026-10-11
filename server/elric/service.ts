import { randomUUID } from 'node:crypto';
import { defaultPiiKeyring, isAdult } from '../google/pii.js';
import type { Database, Transaction as Tx } from '../database.js';
import { event, iso, type StoredAgent, type Workspace } from '../model.js';
import {
  eligibilityOf,
  elricEligibility,
  elricEligibilityRefusal,
  elricRoomAccess,
  type ElricAccess,
  type ElricAccessCode,
  type ElricEligibility,
} from './access.js';
import {
  AdapterError,
  type ElricMessage,
  type ModelAdapter,
  type ModelResponse,
} from './adapter.js';
import { anthropicUnits, anthropicWorstUnits, estimateTokens } from './token-cost.js';
import { killSwitchOn, reserve, setKillSwitch, settle, type ElricUsageView } from './budget.js';
import {
  ELRIC_CONFIG,
  ELRIC_STEP_CONTEXT_TOKENS,
  dayOf,
  resetAt,
  type ElricConfig,
  type ElricKind,
  type ElricTier,
} from './config.js';
import {
  contextRange,
  elricSystemPrompt,
  elricUserPrompt,
  loadRoomMessages,
  transcript,
} from './context.js';
import { ackElricMention } from './hook.js';
import { searchHelp } from './help.js';
import { ELRIC_DETERMINISTIC_MODEL, elricReplyLabel } from '../../shared/elric-copy.js';
import {
  approvePendingAction,
  createPendingAction,
  sweepStalePendingActions,
  type ElricPrincipal,
  type PendingExecutor,
  type PendingRunner,
} from './pending.js';
import { toolArgs } from './tools.js';
import {
  ELRIC_CUT_SHORT_MARKER,
  ELRIC_PARTIAL_MIN_CHARS,
  containsCredential,
  cutPartial,
  stripMentions,
  validateCitations,
  visibleChars,
} from './reply.js';
import { deleteDraft, draftWriter, sweepStaleDrafts, writeDraft } from './draft.js';
import { route, type ElricRoute } from './router.js';
import { titleConversation } from './titles.js';
import type { ElricOutcome } from './schema.js';
import { checkToolCall, ELRIC_TOOLS, toolSpecs, type CheckedCall } from './tools.js';
import {
  argsHash,
  listElricTurns,
  recordTurn,
  type ToolCallRecord,
  type TurnInput,
} from './turns.js';

/**
 * Elric, Central City's first-party agent: the server core of the Phase 2 slice
 * (docs/ELRIC.md). Behind CITY_ELRIC=1; the only model adapter wired is the mock.
 *
 * One invocation (queued by the room-post hook for an owner mention) runs:
 *   lease → expiry → kill switch → eligibility (every time) → agent-bound room access (write) →
 *   router (Tier 0 answers with no model and no cost) → atomic allowance + global reservation →
 *   bounded tool loop (≤ maxSteps adapter calls; a recheck under the room lock before every step
 *   and every tool call) → reply checks (mentions, citations, credentials) → post through the
 *   rooms post path with a precondition under the room lock → settle → one append-only turn row.
 */
type Q = Pick<Tx, 'query'>;
type Env = Record<string, string | undefined>;

export interface ElricPostArgs {
  ownerId: string;
  agentId: string;
  roomId: string;
  text: string;
  idempotencyKey: string;
  /** The public, server-stamped attribution (room_messages.auto_reply). */
  stamp: {
    provider: 'elric';
    model: string;
    label: string;
    pending_id?: string;
    /** The seq of the message this reply answers (the page matches it to the asker's post). */
    reply_to?: number;
  };
  /** Runs inside the post transaction under the room lock; a code refuses the post. */
  precondition: (tx: Q) => Promise<string | null>;
}
export type ElricPostResult = { ok: true; seq: number } | { ok: false; code: string };

export interface ElricTaskArgs {
  ownerId: string;
  agentId: string;
  roomId: string;
  title: string;
  body?: string;
  idempotencyKey: string;
  /** Runs inside the create transaction under the room lock; a code refuses the create. */
  precondition: (tx: Q) => Promise<string | null>;
}

export interface ElricDependencies {
  db: Pick<Database, 'query' | 'transaction'>;
  clock: () => number;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  /** The model per tier (the mock in tests; nothing real is wired in this slice). */
  adapterFor(tier: 1 | 2): ModelAdapter;
  /** The rooms post path (server/rooms/service.ts post), as the responder uses it. */
  postReply(args: ElricPostArgs): Promise<ElricPostResult>;
  /**
   * The room tasks create path (server/rooms/tasks-service.ts create) with Elric's agent-bound
   * recheck as its precondition, inside the create transaction under the room lock.
   */
  createTask?(args: ElricTaskArgs): Promise<{ id: string; number: number }>;
  tasksEnabled(): boolean;
  agentsPerWorkspace?: number;
  env?: Env;
  config?: Partial<ElricConfig>;
  /**
   * Tests only: awaited at fixed points of a run (after the reservation, before each tool call,
   * before the post), so a test can pause, revoke or remove Elric exactly there.
   */
  probe?: (point: 'reserved' | 'before_tool' | 'before_post') => Promise<void>;
  /** Wall time for the run budget (default Date.now); tests may inject it. */
  wallClock?: () => number;
  /** Waits before the one retry of a transient model error (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Operator log for a failed turn: one JSON line with codes only (default console.warn). */
  log?: (line: string) => void;
}

/**
 * Elric never names tools, functions or internal identifiers to people: the known tools become
 * plain words, and any other tool-like identifier (city_*, room_* in snake case) is dropped.
 */
export function plainToolWords(text: string): string {
  return text
    .replace(/`?\broom_task_create\b(?:\s*\(\))?`?/g, 'create a task')
    .replace(/`?\broom_read\b(?:\s*\(\))?`?/g, 'read the room')
    .replace(/`?\b(?:city|room|elric)_[a-z0-9]+(?:_[a-z0-9]+)*\b(?:\s*\(\))?`?/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

/** The fixed tool result a consequential call gets: nothing ran, the owner decides. */
export const elricPendingToolText = (_id?: string) =>
  "Waiting for the owner's approval. Nothing was created yet; tell the owner it needs their approval.";
/**
 * The reply when a run queued a consequential action: never the raw id (it travels as
 * auto_reply.pending_id, for the UI's Approve/Reject card).
 */
export const ELRIC_PENDING_REPLY = 'Waiting for your approval.';

/** What the owner sees while an invocation waits for a self-hosted endpoint to start. */
export const ELRIC_WAKING_TEXT = 'Elric is waking up…';

export class ElricError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ElricStatus {
  agent_id: string | null;
  status: 'active' | 'paused' | 'revoked' | null;
  host_may_invoke: boolean;
  eligible: boolean;
  /**
   * Why not eligible, for the owner's own UI (null when eligible): 'age_unknown' means the date
   * of birth is still to be given, so "Add Elric" asks for it; 'unverified' (no Google) and
   * 'age_under_18' keep Add Elric hidden.
   */
  eligibility_reason: Extract<ElricEligibility, { eligible: false }>['reason'] | null;
  usage: ElricUsageView;
  /** One owner-visible notice per kind whose allowance is used up today. */
  limit_notices: string[];
  /** Running invocations waiting for the model endpoint to start (cold start). */
  waking: Array<{ room_id: string; source_seq: number; since: string; text: string }>;
}

export interface InvocationKey {
  agentId: string;
  roomId: string;
  sourceSeq: number;
}

export type InvocationResult = {
  /**
   * 'deferred': the run was put back (cold start, or too little time left in this function run)
   * with its reservation kept; a later drain resumes it. No turn row is written for a deferral.
   */
  outcome: ElricOutcome | 'deferred';
  reason: string | null;
  postedSeq: number | null;
  tier: ElricTier | null;
  /** Visible "limit reached" result: when the allowance resets (00:00 UTC). */
  resetsAt?: string;
  /** Owner-visible, ephemeral notice (never a room post), e.g. "Summaries used up for today…". */
  notice?: string;
};

const KIND_LABEL: Record<ElricKind, string> = {
  short: 'Short answers',
  summary: 'Summaries',
  tool: 'Tool tasks',
};
/** The owner-visible limit notice for one kind (or the global ceiling). */
export function elricLimitNotice(
  reason: 'owner_allowance' | 'global_ceiling',
  kind: ElricKind,
): string {
  return reason === 'global_ceiling'
    ? "Elric has reached today's limit for everyone. It resets at 00:00 UTC."
    : `${KIND_LABEL[kind]} used up for today. Resets at 00:00 UTC.`;
}

type InvocationRow = {
  agent_id: string;
  room_id: string;
  source_seq: string | number;
  owner_id: string;
  invoker_member_id: string;
  invoker_kind: 'owner' | 'host';
  status: 'queued' | 'running' | 'done' | 'cancelled';
  lease_id: string | null;
  locked_until: string | number | null;
  kind: ElricKind | null;
  reserved_units: string | number;
  usage_day: string | null;
  created_at: string | number;
  waking_since: string | number | null;
  deferred_at: string | number | null;
  spent_units: string | number;
  inflight_units: string | number;
};

/** Failures after the request was sent that may have used GPU time: the step's estimate counts. */
const CHARGED_FAILURES: ReadonlySet<string> = new Set([
  'timeout',
  'server_error',
  'bad_response',
  'too_large',
]);

/** Model errors worth one more try within the same run (overloaded, rate limited, 5xx, slow). */
export const ELRIC_RETRY_ON: ReadonlySet<string> = new Set([
  'rate_limited',
  'server_error',
  'timeout',
  'unreachable',
]);
/** The wait before that one retry. */
export const ELRIC_RETRY_BACKOFF_MS = 1_500;

const INACTIVE: ReadonlySet<ElricAccessCode> = new Set(['paused', 'revoked']);

/** A model id as shown publicly: printable, bounded. */
const cleanModel = (value: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 100);

export const ELRIC_STEP_LIMIT_TEXT =
  'I stopped after the step limit without finishing. Nothing else was done; ask me again with a narrower request.';

/** Posted (labelled "Elric · automated") when the model and any fallback both failed. */
export const ELRIC_MODEL_FAILED_REPLY = "Elric couldn't answer, try again.";

export function createElric(d: ElricDependencies) {
  const config: ElricConfig = { ...ELRIC_CONFIG, ...d.config };
  const env = () => d.env ?? process.env;

  /**
   * Units of one step: per token for a per-token provider (for the pre-call
   * `estimate`, its worst case with every input token cache-written), else the tier's GPU rate
   * (the self-hosted fallback).
   */
  function unitsOf(
    tier: 1 | 2,
    usage: ModelResponse['usage'],
    pricing?: ModelResponse['pricing'],
    estimate = false,
  ): number {
    if (pricing === 'anthropic')
      return estimate
        ? anthropicWorstUnits(usage.inputTokens, usage.outputTokens)
        : anthropicUnits(usage);
    const rate = config.unitsPer1kTokens[tier];
    return Math.max(
      1,
      Math.ceil(
        (usage.inputTokens / 1000) * rate.input + (usage.outputTokens / 1000) * rate.output,
      ),
    );
  }

  // ---------------------------------------------------------------- identity (owner console)

  async function addElric(
    ownerId: string,
    options: { name?: string } = {},
  ): Promise<{ agent_id: string; created: boolean }> {
    const eligibility = await elricEligibility(d.db, ownerId, d.clock());
    if (!eligibility.eligible)
      throw new ElricError(
        403,
        elricEligibilityRefusal(eligibility.reason).code,
        elricEligibilityRefusal(eligibility.reason).message,
      );
    const name = (options.name ?? 'Elric')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, 60);
    return d.mutate(ownerId, async (workspace, tx, time) => {
      const existing = (
        await tx.query<{ agent_id: string }>(
          "SELECT agent_id FROM elric_agents WHERE owner_id=$1 AND status <> 'revoked'",
          [ownerId],
        )
      ).rows[0];
      if (existing) return { agent_id: existing.agent_id, created: false };
      if (d.agentsPerWorkspace !== undefined && workspace.agents.length >= d.agentsPerWorkspace)
        throw new ElricError(409, 'agent_limit', 'Your workspace has no room for another agent.');
      const agent: StoredAgent = {
        id: randomUUID(),
        name: name || 'Elric',
        description: 'Central City agent',
        capability: 'research',
        mode: 'hosted',
        isDemo: false,
        lastSeenAt: null,
        createdAt: iso(time),
        revokedAt: null,
        lastSequence: -1,
        announcedOnline: false,
        createdBy: { kind: 'owner', id: ownerId },
      };
      workspace.agents.push(agent);
      await tx.query(
        `INSERT INTO elric_agents(agent_id,owner_id,status,host_may_invoke,created_at,updated_at,updated_by)
         VALUES($1,$2,'active',false,$3,$3,'the owner')`,
        [agent.id, ownerId, time],
      );
      event(workspace, time, 'elric.added', `${agent.name} (Central City agent) added.`, agent.id);
      return { agent_id: agent.id, created: true };
    });
  }

  /** `lock`: FOR UPDATE, so a pause or revoke waits for (and then stops) any recheck holding
   *  the row FOR SHARE, and every later recheck sees the new status. */
  async function ownElric(q: Q, ownerId: string, lock = false) {
    return (
      await q.query<{ agent_id: string; status: 'active' | 'paused'; host_may_invoke: boolean }>(
        `SELECT agent_id,status,host_may_invoke FROM elric_agents WHERE owner_id=$1 AND status <> 'revoked'${lock ? ' FOR UPDATE' : ''}`,
        [ownerId],
      )
    ).rows[0];
  }

  /** Cancels queued invocations (no reservation is held before a run). */
  async function cancelQueued(tx: Q, agentId: string, reason: string, time: number) {
    const rows = (
      await tx.query<InvocationRow>(
        `UPDATE elric_invocations SET status='cancelled', finished_at=$2
          WHERE agent_id=$1 AND status='queued' RETURNING *`,
        [agentId, time],
      )
    ).rows;
    for (const row of rows) {
      // A deferred invocation holds a reservation: release it, count what it spent, refund the
      // allowance.
      if (Number(row.reserved_units) > 0 && row.usage_day && row.kind) {
        await settle(tx, {
          ownerId: row.owner_id,
          kind: row.kind,
          day: row.usage_day,
          reserved: Number(row.reserved_units),
          spent: Number(row.spent_units),
          refund: true,
        });
        await tx.query(
          `UPDATE elric_invocations SET reserved_units=0 WHERE agent_id=$1 AND room_id=$2
              AND source_seq=$3`,
          [row.agent_id, row.room_id, row.source_seq],
        );
      }
      await ackElricMention(tx, row.agent_id, row.room_id, Number(row.source_seq), time);
      await recordTurn(
        tx,
        turnBase(row, {
          outcome: 'cancelled',
          reason,
          costUnits: Number(row.spent_units),
          reservedUnits: Number(row.reserved_units),
        }),
        time,
      );
    }
  }

  /** Owner console only: pause (stops reads and writes), resume, or revoke (final). */
  async function setStatus(
    ownerId: string,
    status: 'active' | 'paused' | 'revoked',
  ): Promise<{ agent_id: string; status: string }> {
    return d.mutate(ownerId, async (workspace, tx, time) => {
      const own = await ownElric(tx, ownerId, true);
      if (!own) throw new ElricError(404, 'elric_not_found', 'You have no Elric.');
      if (status === 'revoked') {
        await tx.query(
          `UPDATE elric_agents SET status='revoked', revoked_at=$2, revoked_by='the owner',
             updated_at=$2, updated_by='the owner' WHERE agent_id=$1`,
          [own.agent_id, time],
        );
        const agent = workspace.agents.find((item) => item.id === own.agent_id);
        if (agent && !agent.revokedAt) agent.revokedAt = iso(time);
        await cancelQueued(tx, own.agent_id, 'revoked', time);
        event(workspace, time, 'elric.revoked', 'Elric revoked by the owner.', own.agent_id);
      } else {
        await tx.query(
          `UPDATE elric_agents SET status=$2, updated_at=$3, updated_by='the owner' WHERE agent_id=$1`,
          [own.agent_id, status, time],
        );
        if (status === 'paused') await cancelQueued(tx, own.agent_id, 'paused', time);
        event(
          workspace,
          time,
          status === 'paused' ? 'elric.paused' : 'elric.resumed',
          status === 'paused' ? 'Elric paused by the owner.' : 'Elric resumed by the owner.',
          own.agent_id,
        );
      }
      return { agent_id: own.agent_id, status };
    });
  }

  async function setHostMayInvoke(ownerId: string, allowed: boolean) {
    const done = await d.db.query<{ agent_id: string }>(
      `UPDATE elric_agents SET host_may_invoke=$2, updated_at=$3, updated_by='the owner'
        WHERE owner_id=$1 AND status <> 'revoked' RETURNING agent_id`,
      [ownerId, allowed, d.clock()],
    );
    if (!done.rows.length) throw new ElricError(404, 'elric_not_found', 'You have no Elric.');
    return { agent_id: done.rows[0]!.agent_id, host_may_invoke: allowed };
  }

  async function usageView(ownerId: string): Promise<ElricUsageView> {
    const time = d.clock();
    const row = (
      await d.db.query<{ short: number; summary: number; tool: number }>(
        'SELECT short,summary,tool FROM elric_usage WHERE owner_id=$1 AND day=$2',
        [ownerId, dayOf(time)],
      )
    ).rows[0];
    return usageFrom(row, time);
  }
  function usageFrom(
    row: { short: number | null; summary: number | null; tool: number | null } | undefined,
    time: number,
  ): ElricUsageView {
    return {
      day: dayOf(time),
      used: { short: row?.short ?? 0, summary: row?.summary ?? 0, tool: row?.tool ?? 0 },
      allowance: { ...config.allowance },
      resets_at: iso(resetAt(time)),
    };
  }

  /**
   * GET /api/elric. One round trip: today's usage, the owner's Elric, the invocations waking up
   * and the identity row of the eligibility check, each read as usageView, ownElric, the waking
   * list and elricEligibility read them, and decided by the same code.
   */
  async function status(ownerId: string): Promise<ElricStatus> {
    const time = d.clock();
    const row = (
      await d.db.query<{
        short: number | null;
        summary: number | null;
        tool: number | null;
        has_usage: boolean;
        agent_id: string | null;
        status: 'active' | 'paused' | null;
        host_may_invoke: boolean | null;
        kind: string | null;
        provider: string | null;
        email: string | null;
        email_verified: boolean | null;
        verified_at: string | number | null;
        waking: { room_id: string; source_seq: string | number; waking_since: string | number }[];
      }>(
        `SELECT u.short, u.summary, u.tool, u.owner_id IS NOT NULL AS has_usage,
                e.agent_id, e.status, e.host_may_invoke,
                o.kind, v.provider, v.email, v.email_verified, v.verified_at,
                (SELECT COALESCE(json_agg(json_build_object('room_id', k.room_id,
                    'source_seq', k.source_seq, 'waking_since', k.waking_since)
                    ORDER BY k.waking_since), '[]'::json)
                   FROM (SELECT room_id, source_seq, waking_since FROM elric_invocations
                          WHERE owner_id=$1 AND waking_since IS NOT NULL
                            AND (status='queued' OR (status='running' AND locked_until > $3))
                          ORDER BY waking_since LIMIT 20) k) AS waking
           FROM (SELECT 1) one
           LEFT JOIN elric_usage u ON u.owner_id=$1 AND u.day=$2
           LEFT JOIN elric_agents e ON e.owner_id=$1 AND e.status <> 'revoked'
           LEFT JOIN operators o ON o.id=$1
           LEFT JOIN elric_verified_identities v ON v.operator_id=o.id`,
        [ownerId, dayOf(time), time],
      )
    ).rows[0]!;
    const usage = usageFrom(row.has_usage ? row : undefined, time);
    // The age check (server/google/pii.ts, the only reader of the date of birth) is one more
    // round trip, and only once the identity qualifies.
    const eligibility = await eligibilityOf(
      row.kind === null ? undefined : { ...row, kind: row.kind },
      () => isAdult(d.db, defaultPiiKeyring(), ownerId, time),
    );
    return {
      agent_id: row.agent_id ?? null,
      status: row.status ?? null,
      host_may_invoke: row.agent_id === null ? false : (row.host_may_invoke ?? false),
      eligible: eligibility.eligible,
      eligibility_reason: eligibility.eligible ? null : eligibility.reason,
      usage,
      limit_notices: (Object.keys(usage.used) as ElricKind[])
        .filter((kind) => usage.used[kind] >= usage.allowance[kind])
        .map((kind) => elricLimitNotice('owner_allowance', kind)),
      waking: row.waking.map((item) => ({
        room_id: item.room_id,
        source_seq: Number(item.source_seq),
        since: iso(Number(item.waking_since)),
        text: ELRIC_WAKING_TEXT,
      })),
    };
  }

  // ---------------------------------------------------------------- invocation

  function turnBase(
    row: Pick<
      InvocationRow,
      'owner_id' | 'agent_id' | 'room_id' | 'invoker_member_id' | 'invoker_kind' | 'source_seq'
    >,
    rest: Omit<
      TurnInput,
      'ownerId' | 'agentId' | 'roomId' | 'invokerMemberId' | 'invokerKind' | 'sourceSeq'
    >,
  ): TurnInput {
    return {
      ownerId: row.owner_id,
      agentId: row.agent_id,
      roomId: row.room_id,
      invokerMemberId: row.invoker_member_id,
      invokerKind: row.invoker_kind,
      sourceSeq: Number(row.source_seq),
      ...rest,
    };
  }

  async function takeLease(key: InvocationKey): Promise<InvocationRow | undefined> {
    const time = d.clock();
    return (
      await d.db.query<InvocationRow>(
        `UPDATE elric_invocations SET status='running', lease_id=$4, locked_until=$5
          WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3
            AND ((status='queued' AND (locked_until IS NULL OR locked_until <= $6))
              OR (status='running' AND locked_until < $6))
          RETURNING *`,
        [key.agentId, key.roomId, key.sourceSeq, randomUUID(), time + config.leaseMs, time],
      )
    ).rows[0];
  }

  /** Recheck under the room lock: still active, still a member, still allowed to write here,
   *  and this invocation still holds its lease (and its reservation, when it has one). */
  async function recheck(
    tx: Q,
    inv: InvocationRow,
    leaseId: string,
    reserved: boolean,
  ): Promise<
    { ok: true; access: Extract<ElricAccess, { ok: true }> } | { ok: false; code: string }
  > {
    const access = await elricRoomAccess(tx, inv.agent_id, inv.room_id, {
      mode: 'write',
      lock: true,
    });
    if (!access.ok) return { ok: false, code: access.code };
    // Holding the lease also renews it: a live run never loses it to another drain.
    const held = (
      await tx.query<{ reserved_units: string | number }>(
        `UPDATE elric_invocations SET locked_until=$5 WHERE agent_id=$1 AND room_id=$2
            AND source_seq=$3 AND status='running' AND lease_id=$4 RETURNING reserved_units`,
        [inv.agent_id, inv.room_id, inv.source_seq, leaseId, d.clock() + config.leaseMs],
      )
    ).rows[0];
    if (!held) return { ok: false, code: 'lease_lost' };
    if (reserved && Number(held.reserved_units) <= 0) return { ok: false, code: 'budget_released' };
    return { ok: true, access };
  }

  async function run(
    key: InvocationKey,
    options: { deadline?: number } = {},
  ): Promise<InvocationResult | null> {
    const leased = await takeLease(key);
    if (!leased) return null;
    const inv = leased;
    const leaseId = inv.lease_id!;
    const wall = d.wallClock ?? Date.now;
    /** This function run's wall-time deadline (the drain's), so no call outlives the platform. */
    const deadline = options.deadline ?? wall() + config.runBudgetMs;
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const log = d.log ?? ((line: string) => console.warn(line));
    /** The transient error code a model call of this run was retried after, if any. */
    let retried: string | null = null;
    /** The units reserved for this run's model calls (set once reserved). */
    let budgetUnits = Infinity;
    /** Resumed after a deferral: the reservation was made by an earlier run. */
    let resumed = false;
    /** Model steps that answered in this run (a deferral is only possible before the first). */
    let stepsDone = 0;
    const toolCalls: ToolCallRecord[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, units: 0 };
    let tier: ElricTier | null = null;
    let model: string | null = null;
    let range: { fromSeq: number | null; toSeq: number | null } = { fromSeq: null, toSeq: null };
    let reservation: { units: number; day: string; kind: ElricKind } | null = null;

    /** The streamed draft of this run (draft.ts), when the adapter streams. */
    const draftKey = {
      agentId: inv.agent_id,
      roomId: inv.room_id,
      sourceSeq: Number(inv.source_seq),
      leaseId,
    };
    let draftsOn = true;
    const drafts = draftWriter((text) => writeDraft(d.db, draftKey, text, d.clock()));
    /**
     * The answer so far, as room members will see it while it forms: mentions stripped, tool
     * names in plain words, and the reply's credential check. A credential stops drafting for
     * the run (the draft is deleted; the final check refuses the reply).
     */
    /** The raw text the current model call has streamed so far (kept for a cut-short answer). */
    let streamed = '';
    const onText = (text: string) => {
      streamed = text;
      if (!draftsOn) return;
      const shown = plainToolWords(stripMentions(text.normalize('NFKC'))).slice(
        0,
        config.replyChars,
      );
      if (containsCredential(shown)) {
        draftsOn = false;
        void drafts
          .close()
          .then(() => deleteDraft(d.db, draftKey))
          .catch(() => {});
        return;
      }
      drafts.update(shown);
    };

    /** The single terminal write: settle, close the invocation, ack, one turn row. */
    async function finish(
      outcome: ElricOutcome,
      reason: string | null,
      extra: {
        postedSeq?: number | null;
        refund?: boolean;
        resetsAt?: string;
        notice?: string;
      } = {},
    ): Promise<InvocationResult> {
      const time = d.clock();
      // A resumed run that ends before spending anything gives the allowance back.
      const refund = extra.refund ?? (resumed && usage.units === 0);
      // Nothing of the draft outlives the run: pending writes land first, then it is deleted.
      draftsOn = false;
      await drafts.close();
      await d.db.transaction(async (tx) => {
        await deleteDraft(tx, draftKey);
        const closed = await tx.query(
          `UPDATE elric_invocations SET status=$5, finished_at=$6, lease_id=NULL, locked_until=NULL,
             reserved_units=0
           WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$4 RETURNING 1`,
          [
            inv.agent_id,
            inv.room_id,
            inv.source_seq,
            leaseId,
            outcome === 'cancelled' ? 'cancelled' : 'done',
            time,
          ],
        );
        if (!closed.rows.length) return; // lease lost: another run owns it now
        if (reservation)
          await settle(tx, {
            ownerId: inv.owner_id,
            kind: reservation.kind,
            day: reservation.day,
            reserved: reservation.units,
            spent: usage.units,
            refund,
          });
        await ackElricMention(tx, inv.agent_id, inv.room_id, Number(inv.source_seq), time);
        const turnId = await recordTurn(
          tx,
          turnBase(inv, {
            contextFromSeq: range.fromSeq,
            contextToSeq: range.toSeq,
            tier,
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            costUnits: usage.units,
            reservedUnits: reservation?.units ?? 0,
            toolCalls,
            outcome,
            reason,
            postedSeq: extra.postedSeq ?? null,
          }),
          time,
        );
        if (extra.postedSeq !== undefined && extra.postedSeq !== null)
          await tx.query(
            `INSERT INTO elric_posts(room_id,seq,agent_id,owner_id,model,tier,turn_id)
             VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [inv.room_id, extra.postedSeq, inv.agent_id, inv.owner_id, model, tier ?? 0, turnId],
          );
      });
      return {
        outcome,
        reason,
        postedSeq: extra.postedSeq ?? null,
        tier,
        ...(extra.resetsAt ? { resetsAt: extra.resetsAt } : {}),
        ...(extra.notice ? { notice: extra.notice } : {}),
      };
    }

    const key4 = [inv.agent_id, inv.room_id, inv.source_seq, leaseId] as const;
    /** Records what this run has spent and the estimate of a call in flight (for a cut-off run). */
    const track = (inflight: number) =>
      d.db.query(
        `UPDATE elric_invocations SET spent_units=$5, inflight_units=$6
          WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$4`,
        [...key4, Math.ceil(usage.units), Math.ceil(inflight)],
      );
    /**
     * Puts the invocation back (status queued, lease released, reservation kept) for a later
     * drain, no sooner than `notBefore`. Only before this run's first model answer: the
     * conversation of a run is not stored, so a run with progress is never resumed.
     */
    const defer = async (
      reason: 'model_waking' | 'time_budget',
      notBefore: number,
      wakingSince: number | null,
    ): Promise<InvocationResult> => {
      await d.db.query(
        `UPDATE elric_invocations SET status='queued', lease_id=NULL, locked_until=$5,
            deferred_at=$6, inflight_units=0, spent_units=$7, waking_since=$8
          WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$4`,
        [...key4, notBefore, d.clock(), Math.ceil(usage.units), wakingSince],
      );
      return { outcome: 'deferred', reason, postedSeq: null, tier };
    };
    /**
     * One model call inside the run budget: capped at what is left of this function run (minus a
     * margin); with too little left it defers (before the first answer) or stops honestly. A cold
     * endpoint (`waking`) is never waited for here: the invocation is deferred and a later drain
     * retries it, giving up with a refund `wakeMaxMs` after the first `waking`.
     */
    const callModel = async (
      adapter: ModelAdapter,
      request: Parameters<ModelAdapter['complete']>[0],
      estimate: number,
    ): Promise<ModelResponse | InvocationResult | 'stop'> => {
      const remaining = deadline - wall() - config.callMarginMs;
      if (remaining < config.minCallMs) {
        if (stepsDone === 0 && !pendingIds.length)
          return defer(
            'time_budget',
            d.clock(),
            inv.waking_since === null ? null : Number(inv.waking_since),
          );
        return 'stop';
      }
      await track(estimate);
      retried = null;
      try {
        let response: ModelResponse;
        const attemptStarted = wall();
        try {
          response = await adapter.complete({ ...request, timeoutMs: remaining });
        } catch (first) {
          // One retry of a transient failure, after a backoff, when the run still has the time
          // and the turn budget for it. Anything else, or a second failure, is thrown.
          if (!(first instanceof AdapterError) || !ELRIC_RETRY_ON.has(first.code)) throw first;
          const charged = first.sent && CHARGED_FAILURES.has(first.code) ? estimate : 0;
          // A 429 says when to come back; otherwise the fixed backoff.
          const backoff = first.detail.retryAfterMs ?? ELRIC_RETRY_BACKOFF_MS;
          const left = deadline - wall() - config.callMarginMs - backoff;
          // A timed-out call needs at least as long again; anything else at least minCallMs.
          const needed =
            first.code === 'timeout'
              ? Math.max(config.minCallMs, wall() - attemptStarted)
              : config.minCallMs;
          if (left < needed || usage.units + charged + estimate > budgetUnits) throw first;
          usage.units += charged;
          // Recorded before the retry, so a run cut off during it settles both attempts.
          await track(estimate);
          retried = first.code;
          await sleep(backoff);
          try {
            response = await adapter.complete({
              ...request,
              timeoutMs: deadline - wall() - config.callMarginMs,
            });
          } catch (second) {
            // A retry that skipped a fallback known to be down keeps the first attempt's code.
            if (
              second instanceof AdapterError &&
              !second.detail.fallbackCode &&
              first.detail.fallbackCode
            )
              throw new AdapterError(second.code, second.sent, {
                ...second.detail,
                fallbackCode: first.detail.fallbackCode,
              });
            throw second;
          }
        }
        if (inv.waking_since !== null) {
          await d.db.query(
            `UPDATE elric_invocations SET waking_since=NULL
              WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$4`,
            [...key4],
          );
          inv.waking_since = null;
        }
        return response;
      } catch (error) {
        if (!(error instanceof AdapterError) || error.code !== 'waking') throw error;
        await track(0);
        const since = inv.waking_since === null ? d.clock() : Number(inv.waking_since);
        if (d.clock() - since >= config.wakeMaxMs || stepsDone > 0 || pendingIds.length)
          return finish('error', 'model_waking', { refund: true });
        return defer('model_waking', d.clock() + config.wakeRetryMs, since);
      }
    };

    const refused = (code: string): InvocationResult | Promise<InvocationResult> =>
      INACTIVE.has(code as ElricAccessCode)
        ? finish('refused_inactive', code, { refund: true })
        : finish('cancelled', code, { refund: true });
    /** One audited tool call: only allowlisted names are stored, never a model-chosen string. */
    const audit = (name: string, args: unknown, status: ToolCallRecord['status']) =>
      toolCalls.push({
        name: (ELRIC_TOOLS as readonly string[]).includes(name)
          ? (name as ToolCallRecord['name'])
          : 'other',
        name_hash: argsHash(name),
        args_hash: argsHash(args ?? null),
        status,
      });

    /**
     * The reply checks, the one path for everything a model wrote before it is posted (a whole
     * answer or a cut-short one): no credential (refused, nothing posted), no live mentions, tool
     * names in plain words, valid citations, the length cap. NFKC first (what the room parser and
     * credential patterns see), then check and strip.
     */
    async function checkReply(
      raw: string,
      maxChars: number,
    ): Promise<
      | { ok: true; text: string; stripped: number }
      | { ok: false; reason: 'credential_in_reply' | 'empty_reply' }
    > {
      const normalized = raw.normalize('NFKC');
      if (containsCredential(normalized)) return { ok: false, reason: 'credential_in_reply' };
      const cited = await validateCitations(
        d.db,
        inv.room_id,
        plainToolWords(stripMentions(normalized)).trim(),
        visibleFrom,
        Number(inv.source_seq),
      );
      const text = cited.text.trim().slice(0, maxChars);
      if (!text) return { ok: false, reason: 'empty_reply' };
      return { ok: true, text, stripped: cited.stripped.length };
    }
    /** Posts a reply under the run's label: the model's ("Elric · AI") or the automated one. */
    const postModelReply = (text: string) => {
      // One source for the public label (shared/elric-copy.ts): "Elric · AI", or
      // "Elric · automated" for a Tier 0 reply that no model wrote.
      const shown = model ?? ELRIC_DETERMINISTIC_MODEL;
      return d.postReply({
        ownerId: inv.owner_id,
        agentId: inv.agent_id,
        roomId: inv.room_id,
        text,
        idempotencyKey: `elric:${inv.agent_id}:${inv.room_id}:${inv.source_seq}`,
        stamp: {
          provider: 'elric',
          model: shown,
          label: elricReplyLabel(shown),
          reply_to: Number(inv.source_seq),
          ...(pendingIds.length ? { pending_id: pendingIds[0]! } : {}),
        },
        precondition: async (tx) => {
          const again = await recheck(tx, inv, leaseId, reservation !== null);
          return again.ok ? null : again.code;
        },
      });
    };
    /** Elric sees messages after this seq (set once room access is checked; none before). */
    let visibleFrom = Number.MAX_SAFE_INTEGER;

    const started = d.clock();
    if (Number(inv.reserved_units) > 0 && inv.usage_day && inv.kind) {
      reservation = { units: Number(inv.reserved_units), day: inv.usage_day, kind: inv.kind };
      usage.units = Number(inv.spent_units);
      if (inv.deferred_at === null) {
        // Its previous run was cut off mid-flight (its lease expired): it is not resumed. What it
        // recorded is spent, plus the estimate of a model call that was in flight; the allowance
        // comes back only when no call was in flight.
        const inflight = Number(inv.inflight_units);
        usage.units += inflight;
        return finish('error', 'lease_expired', { refund: inflight === 0 });
      }
      // A clean deferral: resume with the same reservation (from now on a loss is a real loss).
      resumed = true;
      await d.db.query(
        `UPDATE elric_invocations SET deferred_at=NULL
          WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$4`,
        [...key4],
      );
    }
    if (started - Number(inv.created_at) > config.expiryMs) return finish('expired', 'expired');
    if (await killSwitchOn(d.db, env())) return finish('refused_kill', 'kill_switch');
    const eligibility = await elricEligibility(d.db, inv.owner_id, d.clock());
    if (!eligibility.eligible) return finish('refused_ineligible', eligibility.reason);
    const access = await elricRoomAccess(d.db, inv.agent_id, inv.room_id, { mode: 'write' });
    if (!access.ok)
      return finish(INACTIVE.has(access.code) ? 'refused_inactive' : 'refused_access', access.code);
    visibleFrom = access.visibleFromSeq;
    const trigger = (
      await d.db.query<{ parts: unknown[]; sender_name: string; sender_agent_id: string }>(
        'SELECT parts,sender_name,sender_agent_id FROM room_messages WHERE room_id=$1 AND seq=$2',
        [inv.room_id, inv.source_seq],
      )
    ).rows[0];
    if (!trigger || Number(inv.source_seq) <= access.visibleFromSeq)
      return finish('refused_access', 'not_visible');
    // The invoker must still be the owner's (or host's) person member when the run starts.
    const invoker = (
      await d.db.query(
        // The invoker is still in the room: the owner's (or host's) person member, or the owner's
        // own host identity it posted as from the web app (hook.ts consoleHost).
        `SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2
            AND (kind='person' OR ($3='owner' AND role='host'))
            AND removed_at IS NULL AND owner_id = CASE WHEN $3='owner' THEN $4 ELSE $5 END`,
        [
          inv.room_id,
          inv.invoker_member_id,
          inv.invoker_kind,
          inv.owner_id,
          access.room.host_owner_id,
        ],
      )
    ).rows[0];
    if (!invoker) return finish('refused_access', 'invoker_left');
    const requestText = (Array.isArray(trigger.parts) ? trigger.parts : [])
      .map((part) =>
        part && typeof part === 'object' && (part as { type?: string }).type === 'text'
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('\n');
    /**
     * A reply is posted: name a private conversation after its first reply, in the background
     * (titles.ts checks the rest: first reply, fallback title, kill switch, status, ceiling).
     */
    const nameConversation = (replyText: string) => {
      const titling = titleConversation({
        db: d.db,
        adapter: d.adapterFor(1),
        config,
        clock: d.clock,
        env: env(),
        gpuUnits: (inputTokens, outputTokens) => unitsOf(1, { inputTokens, outputTokens }),
        ownerId: inv.owner_id,
        agentId: inv.agent_id,
        roomId: inv.room_id,
        userText: requestText,
        replyText,
        remainingMs: () => deadline - wall() - config.callMarginMs,
      })
        .then(() => undefined)
        .finally(() => titles.delete(titling));
      titles.add(titling);
    };
    const chosen: ElricRoute = route(requestText);
    tier = chosen.tier;

    let text: string;
    let outcome: ElricOutcome = 'ok';
    let reason: string | null = null;
    /** Pending actions this run created (consequential tools waiting for the owner). */
    const pendingIds: string[] = [];
    if (chosen.tier === 0) {
      model = null;
      text = await tierZero(chosen.handler, access);
      range = { fromSeq: null, toSeq: null };
    } else {
      const stepTier = chosen.tier;
      // Extended thinking on Tier 2 and on complex Tier 1 questions, fixed for the whole run (a
      // change between steps would invalidate the prompt cache).
      const thinking = stepTier === 2 || ('complex' in chosen && chosen.complex === true);
      const adapter = d.adapterFor(stepTier);
      model = cleanModel(adapter.model);
      // Per-token worst case for a per-token provider; with a GPU-priced fallback configured,
      // the larger of the two (either may answer a step).
      const perStep =
        adapter.pricing === 'anthropic'
          ? Math.max(
              anthropicWorstUnits(ELRIC_STEP_CONTEXT_TOKENS, config.maxOutputTokens),
              adapter.fallbackPricing === 'gpu' ? config.unitsPerStep[stepTier] : 0,
            )
          : config.unitsPerStep[stepTier];
      let units = perStep * config.maxSteps;
      const day = dayOf(started);
      if (resumed && reservation) units = (reservation as { units: number }).units;
      const reserved = resumed
        ? ({ ok: true, units, day } as const)
        : await reserve(
            d.db,
            config,
            {
              ownerId: inv.owner_id,
              kind: chosen.kind,
              units,
              day,
              invocation: { ...key, leaseId },
            },
            env(),
          );
      if (!reserved.ok) {
        if (reserved.reason === 'kill') return finish('refused_kill', 'kill_switch');
        return finish('limit', reserved.reason, {
          resetsAt: iso(resetAt(started)),
          ...(reserved.reason === 'unavailable'
            ? {}
            : { notice: elricLimitNotice(reserved.reason, chosen.kind) }),
        });
      }
      if (!resumed) reservation = { units, day, kind: chosen.kind };
      budgetUnits = units;
      await d.probe?.('reserved');
      const tasksOn = d.tasksEnabled() && !!d.createTask;
      const tools = toolSpecs(tasksOn);
      const messages = await loadRoomMessages(
        d.db,
        inv.room_id,
        access.visibleFromSeq,
        Number(inv.source_seq),
        config.contextMessages,
      );
      range = contextRange(messages);
      const system = elricSystemPrompt({
        agentName: access.agent.name,
        tools,
        maxSteps: config.maxSteps,
        privateChat: access.room.elric_private,
      });
      const conversation: ElricMessage[] = [
        {
          role: 'user',
          content: elricUserPrompt({
            room: access.room,
            lines: transcript(messages, Number(inv.source_seq), config.transcriptChars),
            triggerSeq: Number(inv.source_seq),
            triggerSender: trigger.sender_name,
          }),
        },
      ];
      /** Characters of tool results given to the model so far (bounded per invocation). */
      let resultChars = 0;
      let final: string | null = null;
      for (let step = 0; step < config.maxSteps && final === null; step++) {
        // Before every adapter call: kill switch, the budget, then the recheck under the lock.
        if (await killSwitchOn(d.db, env()))
          return finish('refused_kill', 'kill_switch', { refund: true });
        const stepTokens = {
          inputTokens: estimateTokens(
            system.length + JSON.stringify(conversation).length + JSON.stringify(tools).length,
          ),
          outputTokens: config.maxOutputTokens,
        };
        const nextEstimate = Math.max(
          unitsOf(stepTier, stepTokens, adapter.pricing, true),
          adapter.fallbackPricing === 'gpu' ? unitsOf(stepTier, stepTokens, undefined, true) : 0,
        );
        if (usage.units + nextEstimate > units) {
          outcome = 'step_limit';
          reason = 'turn_budget';
          break;
        }
        const before = await d.db.transaction((tx) => recheck(tx, inv, leaseId, true));
        if (!before.ok) return refused(before.code);
        // Only the text of the call that fails can become a cut-short answer.
        streamed = '';
        let response: ModelResponse;
        try {
          const answered = await callModel(
            adapter,
            {
              system,
              messages: conversation,
              tools,
              maxOutputTokens: config.maxOutputTokens,
              ...(thinking ? { thinking: true } : {}),
              onText,
            },
            nextEstimate,
          );
          if (answered === 'stop') {
            // Too little time left in this function run for another call, after progress.
            outcome = 'step_limit';
            reason = 'time_budget';
            break;
          }
          if ('outcome' in answered) return answered;
          response = answered;
        } catch (error) {
          const code = error instanceof AdapterError ? error.code : 'adapter_failed';
          // Sent, then failed (timeout, 5xx, a bad or oversized answer): the GPU may have worked,
          // so the step's estimate counts toward the owner's and the global spend. Failures
          // before anything was sent cost nothing. The allowance count is given back either way.
          if (error instanceof AdapterError && error.sent && CHARGED_FAILURES.has(code))
            usage.units += nextEstimate;
          // Operators see why a turn failed: codes only, never prompt text, names or ids of people.
          log(
            JSON.stringify({
              event: 'elric_turn_failed',
              code,
              primary_code: code,
              fallback_code:
                error instanceof AdapterError ? (error.detail.fallbackCode ?? null) : null,
              retried,
              tier: stepTier,
              step,
              sent: error instanceof AdapterError ? error.sent : false,
            }),
          );
          // The answer broke off after real text: post that text, cut cleanly and marked, through
          // the same reply checks as a whole answer. Billing: the units above are what the call
          // consumed (as for any failure; nothing more is charged). The allowance count is NOT
          // given back: the owner got an answer. Anything that fails the checks, or is too short,
          // falls through to the plain line below (and its refund).
          // The refusal checks run on the WHOLE streamed text, not only the part kept: a key
          // after the cut would have refused the full answer, so it refuses the partial too (as
          // does drafting having stopped for a credential).
          const whole = streamed.normalize('NFKC');
          const marker = `\n\n${ELRIC_CUT_SHORT_MARKER}`;
          const cut =
            !pendingIds.length && draftsOn && !containsCredential(whole)
              ? cutPartial(streamed.slice(0, config.replyChars - marker.length))
              : null;
          if (cut !== null) {
            const checked = await checkReply(cut, config.replyChars - marker.length);
            if (checked.ok && visibleChars(checked.text) >= ELRIC_PARTIAL_MIN_CHARS) {
              const posted = await postModelReply(`${checked.text}${marker}`);
              if (posted.ok) {
                log(
                  JSON.stringify({
                    event: 'elric_turn_partial',
                    code,
                    chars: [...checked.text].length,
                    tier: stepTier,
                    step,
                  }),
                );
                const done = await finish('error', `partial:${code}`, { postedSeq: posted.seq });
                nameConversation(checked.text);
                return done;
              }
            }
          }
          // Before any pending action, the owner gets a plain line instead of silence. No model
          // wrote it, so it carries the automated label.
          if (!pendingIds.length) {
            const posted = await d.postReply({
              ownerId: inv.owner_id,
              agentId: inv.agent_id,
              roomId: inv.room_id,
              text: ELRIC_MODEL_FAILED_REPLY,
              idempotencyKey: `elric:${inv.agent_id}:${inv.room_id}:${inv.source_seq}`,
              stamp: {
                provider: 'elric',
                model: ELRIC_DETERMINISTIC_MODEL,
                label: elricReplyLabel(ELRIC_DETERMINISTIC_MODEL),
                reply_to: Number(inv.source_seq),
              },
              precondition: async (tx) => {
                const again = await recheck(tx, inv, leaseId, reservation !== null);
                return again.ok ? null : again.code;
              },
            });
            if (posted.ok) return finish('error', code, { refund: true, postedSeq: posted.seq });
          }
          return finish('error', code, { refund: true });
        }
        stepsDone++;
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.cacheRead += response.usage.cacheReadInputTokens ?? 0;
        usage.cacheWrite += response.usage.cacheCreationInputTokens ?? 0;
        // No usage counts from the endpoint: charge the step's estimate, never a minimum.
        usage.units +=
          response.usage.reported === false
            ? nextEstimate
            : unitsOf(stepTier, response.usage, response.pricing ?? adapter.pricing);
        await track(0);
        // The label names the configured model, never a string the endpoint returned.
        if (!response.toolCalls.length) {
          final = response.text ?? '';
          break;
        }
        // Thinking blocks go back unchanged with the tool results (the API requires them on tool
        // turns); they live only in this run's memory and are never posted or stored.
        conversation.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls,
          ...(response.thinking?.length ? { thinking: response.thinking } : {}),
        });
        for (const [index, call] of response.toolCalls.entries()) {
          const toolReply = (content: unknown) =>
            conversation.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name.slice(0, 100),
              content: JSON.stringify(content),
            });
          // At most maxToolCallsPerStep calls of one response run; the rest are refused.
          const checked: CheckedCall =
            index >= config.maxToolCallsPerStep
              ? { ok: false, status: 'refused_cap' }
              : checkToolCall(call, inv.room_id, tasksOn);
          if (!checked.ok) {
            audit(call.name, call.args, checked.status);
            toolReply({ error: checked.status });
            continue;
          }
          await d.probe?.('before_tool');
          if (checked.name === 'city_help') {
            // Public docs only (help.ts): no room data, nothing to recheck. Counts against the
            // run's tool-result characters like a read.
            const found = searchHelp(checked.args.query, undefined, { self: true });
            const size = JSON.stringify(found).length;
            if (resultChars + size > config.toolResultChars) {
              audit(call.name, call.args, 'refused_cap');
              toolReply({ error: 'refused_cap', docs: found.docs });
              continue;
            }
            resultChars += size;
            audit(call.name, call.args, 'ok');
            toolReply(found);
            continue;
          }
          if (checked.name === 'room_read') {
            // The recheck under the room lock, and the read, in one transaction.
            const executed = await d.db.transaction(
              async (tx): Promise<{ refused: string } | { lines: string[] }> => {
                const again = await recheck(tx, inv, leaseId, true);
                if (!again.ok) return { refused: again.code };
                const since = Math.max(again.access.visibleFromSeq, checked.args.since ?? 0);
                const rows = await loadRoomMessages(
                  tx,
                  inv.room_id,
                  since,
                  Number(inv.source_seq),
                  checked.args.limit ?? config.contextMessages,
                );
                return { lines: transcript(rows, Number(inv.source_seq), config.transcriptChars) };
              },
            );
            if ('refused' in executed) {
              audit(call.name, call.args, 'cancelled');
              return refused(executed.refused);
            }
            // The per-invocation budget of tool-result characters: newest lines first.
            const lines: string[] = [];
            for (const line of [...executed.lines].reverse()) {
              if (resultChars + line.length + 1 > config.toolResultChars) break;
              resultChars += line.length + 1;
              lines.unshift(line);
            }
            if (!lines.length && executed.lines.length) {
              audit(call.name, call.args, 'refused_cap');
              toolReply({ error: 'refused_cap' });
              continue;
            }
            audit(call.name, call.args, 'ok');
            toolReply({ messages: lines });
            continue;
          }
          if (pendingIds.length >= config.maxPendingPerRun) {
            audit(call.name, call.args, 'refused_cap');
            toolReply({ error: 'refused_cap' });
            continue;
          }
          // A consequential tool (room_task_create) never runs from model output: after the
          // recheck under the room lock, its exact validated arguments become a pending action
          // in the same transaction, and the owner approves it in their console. Nothing is
          // created now; the model is told so, with a fixed text.
          const queued = await d.db.transaction(
            async (tx): Promise<{ refused: string } | { id: string }> => {
              const again = await recheck(tx, inv, leaseId, true);
              if (!again.ok) return { refused: again.code };
              const action = await createPendingAction(
                tx,
                {
                  ownerId: inv.owner_id,
                  agentId: inv.agent_id,
                  roomId: inv.room_id,
                  tool: checked.name,
                  args: checked.args,
                },
                d.clock(),
                config.pendingActionTtlMs,
              );
              return { id: action.id };
            },
          );
          if ('refused' in queued) {
            audit(call.name, call.args, 'cancelled');
            return refused(queued.refused);
          }
          pendingIds.push(queued.id);
          audit(call.name, call.args, 'refused_pending');
          toolReply({
            status: 'pending_approval',
            pending_id: queued.id,
            text: elricPendingToolText(queued.id),
          });
        }
      }
      if (final !== null) text = final;
      else {
        if (outcome === 'ok') {
          outcome = 'step_limit';
          reason = 'max_steps';
        }
        text = ELRIC_STEP_LIMIT_TEXT;
      }
      // The run asked for something consequential: the turn is 'pending' until the owner decides.
      if (pendingIds.length && outcome === 'ok') {
        outcome = 'pending';
        reason = reason ?? `pending_actions:${pendingIds.length}`;
      }
      // The owner sees a plain line; the id goes into the stamp, never into the text.
      if (pendingIds.length) text = ELRIC_PENDING_REPLY;
    }

    const checked = await checkReply(text, config.replyChars);
    if (!checked.ok)
      return checked.reason === 'credential_in_reply'
        ? finish('refused_credential', 'credential_in_reply')
        : finish('error', 'empty_reply', { refund: true });
    text = checked.text;
    if (checked.stripped) reason = reason ?? `citations_stripped:${checked.stripped}`;

    await d.probe?.('before_post');
    const posted = await postModelReply(text);
    if (!posted.ok) return refused(posted.code);
    const done = await finish(outcome, reason, { postedSeq: posted.seq });
    nameConversation(text);
    return done;
  }

  /** Tier 0: plain code over this room only (through the agent-bound access), no model. */
  async function tierZero(
    handler: 'members' | 'tasks',
    access: Extract<ElricAccess, { ok: true }>,
  ): Promise<string> {
    if (handler === 'members') {
      const members = (
        await d.db.query<{ name: string | null; kind: string }>(
          `SELECT CASE WHEN m.kind='person' THEN m.display_name ELSE (
                    SELECT a->>'name' FROM workspaces w
                      CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
                     WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id AND (a->>'revokedAt') IS NULL
                  ) END AS name, m.kind
             FROM room_members m WHERE m.room_id=$1 AND m.removed_at IS NULL
            ORDER BY m.joined_at LIMIT 51`,
          [access.room.id],
        )
      ).rows.filter((row) => row.name);
      const shown = members.slice(0, 50);
      const list = shown.map((row) => `${row.name} (${row.kind === 'person' ? 'person' : 'AI'})`);
      return `In this room: ${list.join(', ')}${members.length > 50 ? ', and more' : ''}.`;
    }
    if (!d.tasksEnabled()) return 'Room tasks are not turned on here.';
    const tasks = (
      await d.db.query<{ number: number; title: string; status: string }>(
        `SELECT number,title,status FROM room_tasks WHERE room_id=$1
            AND status IN ('open','claimed','in_review') ORDER BY number LIMIT 21`,
        [access.room.id],
      )
    ).rows;
    if (!tasks.length) return 'There are no open tasks in this room.';
    const lines = tasks
      .slice(0, 20)
      .map(
        (task) =>
          `- T${task.number} ${task.title.slice(0, 120)} (${task.status.replace('_', ' ')})`,
      );
    return ['Open tasks:', ...lines, ...(tasks.length > 20 ? ['- and more'] : [])].join('\n');
  }

  /** Title calls in flight (titles.ts); a drain waits for them so the platform keeps them. */
  const titles = new Set<Promise<void>>();
  const titlesSettled = async () => {
    while (titles.size) await Promise.allSettled([...titles]);
  };

  let draining: Promise<number> | null = null;
  /** Runs queued invocations (single-flight per instance) until none is left or the budget ends. */
  function drain(budgetMs = config.runBudgetMs): Promise<number> {
    draining ??= (async () => {
      const wall = d.wallClock ?? Date.now;
      // Never past the run budget: the platform cuts a function off at its limit.
      const deadline = wall() + Math.min(budgetMs, config.runBudgetMs);
      let handled = 0;
      try {
        await sweepStalePendingActions(d.db, d.clock()).catch(() => {});
        // Drafts of runs that died without cleaning up (draft.ts).
        await sweepStaleDrafts(d.db, d.clock()).catch(() => {});
        // A new invocation starts only while one model call still fits.
        while (deadline - wall() >= config.minCallMs + config.callMarginMs) {
          const due = (
            await d.db.query<{ agent_id: string; room_id: string; source_seq: string | number }>(
              `SELECT agent_id,room_id,source_seq FROM elric_invocations
                WHERE (status='queued' AND (locked_until IS NULL OR locked_until <= $1))
                   OR (status='running' AND locked_until < $1)
                ORDER BY created_at LIMIT 10`,
              [d.clock()],
            )
          ).rows;
          if (!due.length) break;
          let progressed = false;
          for (const row of due) {
            if (deadline - wall() < config.minCallMs + config.callMarginMs) break;
            const result = await run(
              { agentId: row.agent_id, roomId: row.room_id, sourceSeq: Number(row.source_seq) },
              { deadline },
            );
            if (result) {
              handled++;
              progressed = true;
            }
          }
          if (!progressed) break;
        }
      } finally {
        // The queue is done: a new message may start the next drain right away, without
        // waiting for a background title call (titles.ts).
        draining = null;
      }
      return handled;
    })();
    // The caller (one platform invocation) still waits for the title calls it started, so the
    // platform keeps them; each one is capped at its run's deadline.
    return draining.then(async (handled) => {
      await titlesSettled();
      return handled;
    });
  }

  async function killSwitch(enabled: boolean, actor: string): Promise<void> {
    await setKillSwitch(d.db, enabled, actor, d.clock());
  }

  /**
   * The executors of approved pending actions. `room_task_create` runs the STORED arguments
   * (validated again) through the tasks path, with the owner's eligibility and Elric's agent-bound
   * access rechecked inside the create transaction under the room lock. The idempotency key is the
   * pending id, so a retried approval never creates a second task.
   */
  const pendingRunners: Record<string, PendingRunner> = {
    room_task_create: {
      async run(action, precondition) {
        if (!d.tasksEnabled() || !d.createTask) throw new Error('tasks_disabled');
        const args = toolArgs.room_task_create.parse(action.args);
        if (args.room_id !== action.room_id) throw new Error('room_mismatch');
        const task = await d.createTask({
          ownerId: action.owner_id,
          agentId: action.agent_id,
          roomId: action.room_id,
          title: args.title,
          ...(args.body !== undefined ? { body: args.body } : {}),
          idempotencyKey: `elric-pending:${action.id}`,
          precondition,
        });
        return { task: `T${task.number}` };
      },
    },
  };

  /** Owner console only; executes the stored arguments of an approved action. */
  async function approve(
    principal: ElricPrincipal,
    id: string,
    hash: string,
    executors: Readonly<Record<string, PendingExecutor | PendingRunner>> = pendingRunners,
  ) {
    await sweepStalePendingActions(d.db, d.clock()).catch(() => {});
    return approvePendingAction(d.db, principal, { id, argsHash: hash }, executors, d.clock());
  }

  return {
    config,
    addElric,
    pause: (ownerId: string) => setStatus(ownerId, 'paused'),
    resume: (ownerId: string) => setStatus(ownerId, 'active'),
    revoke: (ownerId: string) => setStatus(ownerId, 'revoked'),
    setHostMayInvoke,
    status,
    usage: usageView,
    listTurns: (ownerId: string, options?: { cursor?: string; limit?: number; roomId?: string }) =>
      listElricTurns(d.db, ownerId, options),
    run,
    drain,
    titlesSettled,
    killSwitch,
    approve,
  };
}

export type ElricService = ReturnType<typeof createElric>;
