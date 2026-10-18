import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { iso, type StoredAgent, type Workspace } from '../model.js';
import {
  RoomError,
  refuseIfMuted,
  roomDeleted,
  roomNotFound,
  type RoomPrincipal,
} from './service.js';
import { memberStatuses, touchMembers } from './member-status.js';
import { ROOM_LIMITS, partsContainCredential } from './contract.js';
import { lineName, lineTitle, memberLabel, postSystemLine } from './system-lines.js';
import { taskReviewNotice } from '../wake/hooks.js';
import { TASK_TEMPLATES, findTaskTemplate, taskTemplateBody } from '../../shared/task-templates.js';
import {
  TASK_LIMITS,
  graceForTtl,
  taskClaimInput,
  taskCommentAddInput,
  taskCommentDeleteInput,
  taskCommentListInput,
  taskCreateInput,
  taskEventsInput,
  taskGetInput,
  taskListInput,
  taskReleaseInput,
  taskRenewInput,
  taskResultInput,
  taskStagesInput,
  taskUpdateInput,
  taskPeerReviewInput,
  taskRequestReviewInput,
  type TaskCommentView,
  type TaskEvidence,
  type TaskPeerReviewView,
  type TaskReviewRequest,
  type TaskEventView,
  type TaskLimits,
  type TaskStatus,
  type TaskView,
} from './tasks-contract.js';
import { scopedByPrincipal, visibleRoom, withoutElricAgents } from './private.js';

export type { RoomPrincipal };
/**
 * A caller whose credential is re-checked inside each task transaction (an invited guest's
 * room credential, as the room post, members and leave paths do).
 */
export type TaskPrincipal = RoomPrincipal & {
  guard?: (tx: Tx, time: number) => Promise<void>;
};

/** One claim the lapse sweep cleared (PR2, plan §6 milestone 2). */
export interface LapsedTask {
  task_id: string;
  agent_id: string | null;
  generation: number;
}

/**
 * Room tasks service (claims core; docs/ROOM_TASKS.md). Standalone: it never edits the
 * rooms service, tools or app wiring; it only reads rooms, room_members and workspaces.
 *
 * Binding review notes, how each is honored:
 * 1. Presence: no new columns. Member activity reuses the rooms `room_members.last_active_at`
 *    (migration 21) through `touchMembers`; nothing here reads agent_presence heartbeats.
 * 2. The database clock stamps and compares every lease: `DBNOW` is
 *    `(EXTRACT(EPOCH FROM now())*1000)::bigint` inline in SQL. `d.clock()` is used only
 *    for `touchMembers` (the existing app-clock semantics) and never for a lease.
 * 3. Lazy lapse keeps the CHECK true: the lapse statements clear the whole `claim_*`
 *    group and set `status='open'` (plus a generation bump) in one UPDATE. No cron
 *    exists yet, so reads lapse inline and a post-grace claim takes over atomically.
 * 4. Claim tokens are 128-bit (`ccclaim_` + base64url of 16 random bytes, so a posted
 *    token trips the room credential filter); only the SHA-256 is stored, tokens never
 *    reach logs or errors, and every claim mints a NEW token. Renew keeps the token and
 *    returns expiries only, never a token.
 * 5. `attachment_ids` are validated against the step-1 attachments table (each id must
 *    belong to this room and be `ready`); anything else is `409 attachment_not_ready`.
 *    There is no foreign key. While migration 27 is not applied the table is absent and
 *    any non-empty list fails closed.
 * 6. Titles and bodies are returned verbatim as untrusted text; bodies share the 16 KB cap.
 * 7. `room_task_events` is append-only with an index on `(task_id, created_at)` and
 *    keyset-paged reads. Stale rejections ARE recorded (PR2, plan §4 A2): a 409 rolls
 *    its transaction back, so `auditStale` writes `stale_rejected` in its own
 *    statement after renew/release/result refuse a stale token.
 * 8. Claim is one conditional `UPDATE … RETURNING` (grace included). Rate limits are
 *    charged before any transaction: the hosted limiter needs its own pool client and
 *    the pool holds at most 3.
 */
const HOUR = 3_600_000;
/** Database clock in epoch milliseconds, for every lease stamp and comparison. */
const DBNOW = `(EXTRACT(EPOCH FROM now())*1000)::bigint`;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** A room-task failure. `details` carries the machine-readable 409 payloads. */
export class TaskError extends RoomError {
  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    public details?: unknown,
    retryAfterMs?: number,
  ) {
    super(statusCode, errorCode, message, retryAfterMs);
  }
}
const refuse = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
  retryAfterMs?: number,
): never => {
  throw new TaskError(status, code, message, details, retryAfterMs);
};
/** `409 claim_stale {current_holder, generation}`: nothing changed. */
const stale = (row: TaskRow): never =>
  refuse(409, 'claim_stale', 'The claim token is stale; the task changed hands or lapsed.', {
    current_holder: row.claim_agent_id,
    generation: Number(row.claim_generation),
  });

/** 128-bit claim token. The `ccclaim_` prefix trips the room credential filter. */
const mintClaimToken = () => `ccclaim_${randomBytes(16).toString('base64url')}`;
const tokenHashOf = (token: string) => sha(`room-task-claim:${token}`);

async function insertTaskEvent(
  q: Pick<Tx, 'query'>,
  taskId: string,
  action: string,
  generation: number,
  actor: string,
  agentId: string | null,
  details?: unknown,
): Promise<void> {
  await q.query(
    `INSERT INTO room_task_events(id,task_id,action,generation,actor,agent_id,details,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,${DBNOW})`,
    [
      randomUUID(),
      taskId,
      action,
      generation,
      actor,
      agentId,
      details === undefined ? null : JSON.stringify(details),
    ],
  );
}

/** The idempotency key hash of a room template's starter task (one per room and position). */
const starterKeyHash = (roomId: string, index: number) =>
  sha(`room-starter-task:${roomId}:${index}`);

/**
 * A room template's starter tasks (shared/room-templates.ts, docs/ROOMS.md "Room templates"),
 * written inside the room-create transaction: normal open tasks created by the host agent, each
 * with its `created` event and the usual thread line. The rooms service calls this only when room
 * tasks are on. Returns the new tasks' numbers and titles, in order. It skips the per-room task
 * create limit: a new room gets at most a template's few (3 or fewer) starter tasks, once.
 */
export async function insertStarterTasks(
  tx: Pick<Tx, 'query'>,
  input: {
    roomId: string;
    hostAgentId: string;
    ownerId: string;
    actor: string;
    time: number;
    tasks: ReadonlyArray<{
      title: string;
      body: string;
      template: { id: string; version: string } | null;
    }>;
  },
): Promise<Array<{ number: number; title: string }>> {
  const created: Array<{ number: number; title: string }> = [];
  const label = input.tasks.length ? await memberLabel(tx, input.roomId, input.hostAgentId) : '';
  for (const [index, task] of input.tasks.entries()) {
    const number = index + 1;
    const id = randomUUID();
    await tx.query(
      `INSERT INTO room_tasks(id,room_id,number,title,body,status,created_by_agent_id,
        created_by_owner_id,from_message_seq,attachment_ids,created_at,updated_at,
        idempotency_key,request_hash,template_id,template_version)
      VALUES($1,$2,$3,$4,$5,'open',$6,$7,NULL,'{}'::text[],${DBNOW},${DBNOW},$8,$9,$10,$11)`,
      [
        id,
        input.roomId,
        number,
        task.title,
        task.body,
        input.hostAgentId,
        input.ownerId,
        starterKeyHash(input.roomId, index),
        sha(canonical({ title: task.title, body: task.body, starter: index })),
        task.template?.id ?? null,
        task.template?.version ?? null,
      ],
    );
    await insertTaskEvent(tx, id, 'created', 0, input.actor, input.hostAgentId);
    await postSystemLine(
      tx,
      input.roomId,
      `${label} created task #${number}: ${lineTitle(task.title)}`,
      input.time,
      ROOM_LIMITS.messagesPerRoom,
    );
    created.push({ number, title: task.title });
  }
  return created;
}

/** The starter tasks a templated room was created with (a create replay reports them again). */
export async function existingStarterTasks(
  q: Pick<Tx, 'query'>,
  roomId: string,
  count: number,
): Promise<Array<{ number: number; title: string }>> {
  if (count < 1) return [];
  const keys = Array.from({ length: count }, (_, index) => starterKeyHash(roomId, index));
  const rows = (
    await q.query<{ number: string | number; title: string }>(
      'SELECT number,title FROM room_tasks WHERE room_id=$1 AND idempotency_key = ANY($2::text[]) ORDER BY number',
      [roomId, keys],
    )
  ).rows;
  return rows.map((row) => ({ number: Number(row.number), title: row.title }));
}

/**
 * Lapse sweep as a pure function (PR2, plan §6 milestone 2): one UPDATE ...
 * RETURNING lapses every past-grace claim (the same CHECK-safe clear as lazy
 * lapse), batch-limited, with one `lapsed` event each. No cron wiring here
 * (the wake cron runs it); lazy lapse stays. No limiter
 * inside: the caller (cron) is not request-charged. Database clock throughout.
 */
export async function sweepLapsedTasks(
  db: Database,
  limit: number,
): Promise<{ lapsed: LapsedTask[] }> {
  const batch = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 1000)) : 100;
  return db.transaction(async (tx) => {
    // One statement: the CTE picks the batch, the UPDATE clears it, and the outer
    // SELECT recovers the pre-update holders (RETURNING only sees the new row).
    const cleared = (
      await tx.query<{
        id: string;
        claim_generation: string | number;
        claim_agent_id: string | null;
      }>(
        `WITH due AS (
          SELECT id,claim_agent_id FROM room_tasks
          WHERE status='claimed' AND claim_expires_at + claim_grace_ms <= ${DBNOW}
          ORDER BY claim_expires_at LIMIT $1
        ), cleared AS (
          UPDATE room_tasks t SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}
          FROM due WHERE t.id=due.id AND t.status='claimed'
            AND t.claim_expires_at + t.claim_grace_ms <= ${DBNOW}
          RETURNING t.id, t.claim_generation
        )
        SELECT cleared.id, cleared.claim_generation, due.claim_agent_id
        FROM cleared JOIN due ON due.id=cleared.id`,
        [batch],
      )
    ).rows;
    for (const row of cleared)
      await insertTaskEvent(
        tx,
        row.id,
        'lapsed',
        Number(row.claim_generation),
        'system',
        row.claim_agent_id,
      );
    return {
      lapsed: cleared.map((row) => ({
        task_id: row.id,
        agent_id: row.claim_agent_id,
        generation: Number(row.claim_generation),
      })),
    };
  });
}

type RoomRow = {
  id: string;
  slug: string;
  host_owner_id: string;
  closed_at: string | number | null;
  /** Migration 54; absent before it is applied. */
  task_stages?: string[] | null;
};
type MemberRow = { agent_id: string; role: string; kind?: string };
/**
 * A live member of the caller: a person member (a signed-in person in the room as themselves,
 * rooms/person.ts) or a member agent still live in the caller's workspace.
 */
const isLiveMember = (agents: Map<string, unknown>) => (row: MemberRow) =>
  row.kind === 'person' || agents.has(row.agent_id);
type TaskRow = {
  id: string;
  room_id: string;
  number: string | number;
  title: string;
  body: string;
  status: string;
  created_by_agent_id: string;
  created_by_owner_id: string;
  from_message_seq: string | number | null;
  attachment_ids: string[] | null;
  claim_agent_id: string | null;
  claim_owner_id: string | null;
  claim_expires_at: string | number | null;
  claim_ttl_ms: string | number | null;
  claim_grace_ms: string | number | null;
  claim_token_hash: string | null;
  claim_generation: string | number;
  result: unknown;
  /** Migration 53; absent on rows read before it ran. */
  template_id?: string | null;
  template_version?: string | null;
  /** Migration 54; absent (undefined) before it is applied. */
  stage?: string | null;
  /** Migration 67; absent (undefined) before it is applied. */
  submitted_by?: string | null;
  created_at: string | number;
  updated_at: string | number;
  idempotency_key: string;
  request_hash: string;
};
type CommentRow = {
  id: string;
  task_id: string;
  room_id: string;
  author_kind: string;
  author_agent_id: string;
  author_owner_id: string;
  body: string;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string | number;
  edited_at: string | number | null;
};
type TaskEventRow = {
  id: string;
  task_id: string;
  action: string;
  generation: string | number | null;
  actor: string;
  agent_id: string | null;
  details: unknown;
  created_at: string | number;
};

export interface TaskDependencies {
  db: Database;
  /** App clock for member-activity touches only; leases always use the database clock. */
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  /** The rooms secret: keys the per-member bucket offsets in `memberStatuses`. */
  secret: string;
}

export type TaskCreateResult = { task: TaskView; replayed: boolean };
export interface TaskCreateOptions {
  precondition?: (tx: Pick<Tx, 'query'>) => Promise<string | null>;
  /** Internal action journal: runs under the room lock in the mutation transaction. */
  execute?: (
    tx: Pick<Tx, 'query'>,
    effect: () => Promise<TaskCreateResult>,
  ) => Promise<TaskCreateResult>;
}

export interface RoomTasks {
  /**
   * `precondition` is internal only (Elric, docs/ELRIC.md): it runs under the room lock inside the
   * create transaction, and a returned code refuses the create (409).
   */
  create(
    p: TaskPrincipal,
    body: unknown,
    options?: TaskCreateOptions,
  ): Promise<{ task: TaskView; replayed: boolean }>;
  get(p: TaskPrincipal, body: unknown): Promise<{ task: TaskView }>;
  /** `stages` is the room's stage list (empty when the room uses none). */
  list(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{
    room_id: string;
    tasks: TaskView[];
    stages: string[];
    next_after: number | null;
    has_more: boolean;
  }>;
  claim(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{
    task: TaskView;
    claim_token: string;
    generation: number;
    expires_at: string;
    grace_until: string;
  }>;
  renew(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{ task: TaskView; expires_at: string; grace_until: string }>;
  release(p: TaskPrincipal, body: unknown): Promise<{ task: TaskView; released: boolean }>;
  result(p: TaskPrincipal, body: unknown): Promise<{ task: TaskView }>;
  update(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{
    task: TaskView;
    /** Absent for a stage-only update. */
    decision?: 'approve' | 'reject' | 'cancel';
    applied: boolean;
  }>;
  /** Peer review request (host or claimer), or `cancel: true` to withdraw the active one. */
  requestReview(p: RoomPrincipal, body: unknown): Promise<{ task: TaskView; requested: boolean }>;
  /** The requested reviewer's advisory verdict. */
  peerReview(
    p: RoomPrincipal,
    body: unknown,
  ): Promise<{ task: TaskView; verdict: 'approve' | 'changes_requested' }>;
  /** Any member: the room's stage list. */
  stages(p: TaskPrincipal, body: unknown): Promise<{ room_id: string; stages: string[] }>;
  /** Host only: replace the room's stage list; tasks at a removed stage lose it (with an event). */
  setStages(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{ room_id: string; stages: string[]; cleared: number }>;
  events(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{
    task_id: string;
    events: TaskEventView[];
    next_after: string | null;
    has_more: boolean;
  }>;
  /** Comments on a task (docs/ROOM_TASKS.md "Comments"): members of the room only. */
  commentAdd(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{ comment: TaskCommentView; replayed: boolean }>;
  commentList(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{
    task_id: string;
    comments: TaskCommentView[];
    next_after: string | null;
    has_more: boolean;
  }>;
  commentDelete(
    p: TaskPrincipal,
    body: unknown,
  ): Promise<{ comment: TaskCommentView; deleted: true }>;
  limits: TaskLimits;
}

function project(row: TaskRow): TaskView {
  return {
    id: row.id,
    room_id: row.room_id,
    number: Number(row.number),
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    created_by_agent_id: row.created_by_agent_id,
    from_message_seq: row.from_message_seq === null ? null : Number(row.from_message_seq),
    attachment_ids: [...(row.attachment_ids ?? [])],
    claim:
      row.claim_agent_id === null
        ? null
        : {
            agent_id: row.claim_agent_id,
            expires_at: iso(Number(row.claim_expires_at)),
            grace_until: iso(Number(row.claim_expires_at) + Number(row.claim_grace_ms)),
            generation: Number(row.claim_generation),
          },
    result: (row.result as TaskEvidence | null) ?? null,
    // Hidden by withSubmitters while that member is removed from the room.
    submitted_by: row.submitted_by ?? null,
    template:
      row.template_id && row.template_version
        ? { id: row.template_id, version: row.template_version }
        : null,
    stage: row.stage ?? null,
    // Filled in by withCommentCounts before any view leaves the service.
    comment_count: 0,
    created_at: iso(Number(row.created_at)),
    updated_at: iso(Number(row.updated_at)),
  };
}

function projectEvent(row: TaskEventRow): TaskEventView {
  // `details` arrives parsed from jsonb (or null); pass it through as-is. Older
  // rows predate migration 30 and select as null/undefined.
  const raw = (row as { details?: unknown }).details ?? null;
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as unknown;
  // `stale_rejected` keys its dedupe on `attempted_by` (an opaque per-task HMAC of the owner):
  // internal only, never shown. `attempted_by_owner` is dropped too, so no operator id ever
  // reaches room members.
  let details = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const {
      attempted_by: _key,
      attempted_by_owner: _owner,
      ...shown
    } = parsed as Record<string, unknown>;
    details = shown;
  }
  return {
    id: row.id,
    task_id: row.task_id,
    action: row.action as TaskEventView['action'],
    generation: row.generation === null ? null : Number(row.generation),
    actor: row.actor,
    agent_id: row.agent_id,
    details,
    created_at: iso(Number(row.created_at)),
  };
}

/**
 * PR2 additions (plan §6 milestone 2), same rules as PR1: database clock, no limiter
 * inside transactions, low-entropy literals, exported types.
 * - `result`/`update`: claimed -> in_review (holder posts revision-bound evidence,
 *   inside lease + grace only, 06c) -> done (host approves) or open (host
 *   rejects, evidence cleared from the task but copied to the `rejected` event
 *   payload marked `untrusted: true`, 06c, PR3); host cancels.
 * - `stale_rejected` events: every `claim_stale` 409 from renew/release/result is
 *   audited in a separate statement after the refused transaction rolls back,
 *   deduplicated to one per (task, attempting owner/agent, generation) per
 *   minute (06c, PR3: the actor label is not unique, so the attempter is keyed
 *   in `details`).
 * - Claim-stale matrix on every touch: past-grace lapse (kept), removed holders and
 *   `access_expired` holders (via `memberStatuses`, read at read time)
 *   released with an event, closed rooms release all claims on read.
 */
export function createRoomTasks(d: TaskDependencies): RoomTasks {
  const limits: TaskLimits = { ...TASK_LIMITS };
  /**
   * A short plain-language line in the room thread for a task change (system-lines.ts; no
   * ids or tokens, no wake, mention or auto-reply). Callers hold the room row lock first.
   */
  const taskRef = (row: Pick<TaskRow, 'number' | 'title'>) =>
    `task #${Number(row.number)}: ${lineTitle(row.title)}`;
  const taskLine = (tx: Pick<Tx, 'query'>, roomId: string, text: string) =>
    postSystemLine(tx, roomId, text, d.clock(), ROOM_LIMITS.messagesPerRoom);
  /** The room row lock, taken before any task row lock (the order post and create use). */
  const lockRoom = (tx: Pick<Tx, 'query'>, roomId: string) =>
    tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);

  /** The room's stage list (migration 54), empty when the room uses none. */
  const stagesOf = (room: RoomRow) => [...(room.task_stages ?? [])];
  /** One of the room's stages, matched without case; anything else is `400 unknown_stage`. */
  function resolveStage(room: RoomRow, name: string): string {
    const stages = stagesOf(room);
    const found = stages.find((item) => item.toLowerCase() === name.trim().toLowerCase());
    if (found !== undefined) return found;
    return refuse(
      400,
      'unknown_stage',
      stages.length
        ? `Unknown stage. This room's stages are: ${stages.join(', ')}.`
        : 'This room has no stages; the host sets them in the room settings.',
      { stages },
    );
  }

  async function findRoom(q: Pick<Tx, 'query'>, ref: string) {
    // A private Elric chat: only the owner console and Elric (rooms/private.ts).
    return visibleRoom(
      (
        await q.query<RoomRow & { elric_private?: boolean }>(
          'SELECT * FROM rooms WHERE id=$1 OR slug=$1',
          [ref],
        )
      ).rows[0],
    );
  }

  async function liveAgents(
    q: Pick<Tx, 'query'>,
    operatorId: string,
  ): Promise<Map<string, StoredAgent>> {
    const data = (
      await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0]?.data;
    if (!data) refuse(401, 'unauthorized', 'Sign in to continue.');
    return new Map(
      data!.agents.filter((agent) => !agent.revokedAt).map((agent) => [agent.id, agent]),
    );
  }

  /**
   * The caller's live memberships in the room. Unknown rooms and non-members share one
   * answer (`404 room_not_found`) so task ids cannot be probed.
   */
  async function membership(
    q: Pick<Tx, 'query'>,
    roomRef: string,
    operatorId: string,
    p?: TaskPrincipal,
  ) {
    if (p?.guard) await p.guard(q as Tx, d.clock());
    const room = await findRoom(q, roomRef);
    if (!room) roomNotFound();
    // A deleted room (migration 35): 410 for its host and former members, 404 for anyone else.
    if ((room as { deleted_at?: unknown }).deleted_at != null) {
      const former = await q.query(
        'SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id=$2 LIMIT 1',
        [room!.id, operatorId],
      );
      if (former.rows.length || room!.host_owner_id === operatorId) roomDeleted();
      roomNotFound();
    }
    const agents = await liveAgents(q, operatorId);
    const members = (
      await q.query<MemberRow>(
        'SELECT agent_id,role,kind FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
        [room!.id, operatorId],
      )
    ).rows.filter(isLiveMember(agents));
    if (!members.length) roomNotFound();
    // Reads keep every membership (a host whose only member is their Elric still reads tasks);
    // writes act only through `actors`: never an agent that is or was an Elric, except Elric's
    // own runtime.
    const actors = await withoutElricAgents(q, members);
    return { room: room!, members, actors };
  }

  /**
   * The acting member: explicit, or the caller's default. Only the person themselves (the
   * console) acts as its person member; an AI of the same account (MCP, a grant, a key) never
   * does, as for posts. Without agent_id the console acts as its person when it is in the room as
   * themselves (the host is, from creation); any other caller as its only AI member, so a host's
   * person never makes an AI pass agent_id. Otherwise the caller's only member, as before.
   */
  function actingAgent(
    members: MemberRow[],
    agentId: string | undefined,
    actors: MemberRow[] = members,
    console = false,
  ) {
    const eligible = console ? actors : actors.filter((row) => row.kind !== 'person');
    if (agentId !== undefined) {
      const member = eligible.find((row) => row.agent_id === agentId);
      if (member) return member;
      if (
        !actors.some((row) => row.agent_id === agentId) &&
        members.some((row) => row.agent_id === agentId)
      )
        refuse(403, 'elric_posts_itself', 'Only Elric acts as Elric.');
      return refuse(403, 'not_a_member', 'That agent is not a member of this room.');
    }
    const person = console ? eligible.find((row) => row.kind === 'person') : undefined;
    if (person) return person;
    if (eligible.length === 1) return eligible[0]!;
    if (!eligible.length && actors.length)
      refuse(403, 'not_a_member', 'None of your agents is a member of this room.');
    return refuse(
      400,
      'agent_required',
      'You have several agents in this room; pass agent_id to choose.',
    );
  }

  /** Writes need a posting member in an open room. */
  function writeGuards(room: RoomRow, member: MemberRow) {
    if (room.closed_at !== null)
      refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
    if (member.role === 'guest') refuse(403, 'read_only', 'Guests can read but not claim.');
  }

  function missingTable(error: unknown): boolean {
    const code = (error as { code?: unknown }).code;
    if (code === '42P01') return true;
    return /relation .* does not exist|undefined table/i.test((error as Error).message ?? '');
  }

  /**
   * Every attachment id must belong to this room and be `ready` (the attachments table,
   * migration 27). No foreign key: the check lives here. While that table is absent
   * any non-empty list fails closed.
   */
  async function assertAttachmentsReady(
    tx: Pick<Tx, 'query'>,
    roomId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    let ready: { id: string }[];
    try {
      ready = (
        await tx.query<{ id: string }>(
          'SELECT id FROM room_attachments WHERE room_id=$1 AND id = ANY($2::text[]) AND status=$3',
          [roomId, unique, 'ready'],
        )
      ).rows;
    } catch (error) {
      if (missingTable(error))
        refuse(
          409,
          'attachment_not_ready',
          'The task references attachments that are not ready in this room.',
        );
      throw error;
    }
    if (ready!.length !== unique.length)
      refuse(
        409,
        'attachment_not_ready',
        'The task references attachments that are not ready in this room.',
      );
  }

  async function recordEvent(
    tx: Pick<Tx, 'query'>,
    taskId: string,
    action: TaskEventRow['action'],
    generation: number,
    actor: string,
    agentId: string | null,
    details?: unknown,
  ): Promise<void> {
    await insertTaskEvent(tx, taskId, action, generation, actor, agentId, details);
  }

  /**
   * `stale_rejected` audit (PR2, deferred from PR1): a 409 rolls its own
   * transaction back, so the event is written here in a separate statement after
   * the refusal, and the original 409 still reaches the caller. Audit only: a
   * failed audit row never masks the 409 the caller already earned. Deduplicated
   * (PR3): at most one row per (task, attempting owner/agent,
   * generation) per minute, so a token flood cannot write ~120 rows/min. The
   * actor LABEL ('the owner', 'invited AI') is not unique across owners, so the
   * attempting owner id (and best-effort agent id) are recorded in the existing
   * `details` jsonb (migration 30; no new migration) and keyed there; the
   * `actor` column keeps the label and `agent_id` keeps the current holder.
   */
  async function auditStale(roomRef: string, taskId: string, p: RoomPrincipal): Promise<void> {
    try {
      const room = await findRoom(d.db, roomRef);
      if (!room) return;
      const current = (
        await d.db.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
          taskId,
          room.id,
        ])
      ).rows[0];
      if (!current) return;
      const generation = Number(current.claim_generation);
      // Best-effort attempting agent: the caller's only live member agent, else
      // null (renew/release/result carry no agent_id). The owner id is exact.
      let attemptingAgent: string | null = null;
      try {
        const mine = (
          await d.db.query<{ agent_id: string }>(
            'SELECT agent_id FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
            [room.id, p.operatorId],
          )
        ).rows.map((row) => row.agent_id);
        if (mine.length === 1) attemptingAgent = mine[0]!;
      } catch {
        attemptingAgent = null;
      }
      // Opaque per-task owner key: dedupes per owner without storing or showing the operator id.
      const attemptedBy = createHmac('sha256', d.secret)
        .update(`room-task-stale:${taskId}:${p.operatorId}`)
        .digest('base64url')
        .slice(0, 22);
      const recent = (
        await d.db.query<{ one: number }>(
          `SELECT 1 AS one FROM room_task_events
            WHERE task_id=$1 AND action='stale_rejected' AND generation=$2
              AND details->>'attempted_by'=$3
              AND COALESCE(details->>'attempted_by_agent','')=COALESCE($4,'')
              AND created_at > ${DBNOW} - 60000
            LIMIT 1`,
          [taskId, generation, attemptedBy, attemptingAgent],
        )
      ).rows[0];
      if (recent) return;
      await insertTaskEvent(
        d.db,
        taskId,
        'stale_rejected',
        generation,
        p.actor,
        current.claim_agent_id,
        {
          attempted_by: attemptedBy,
          attempted_by_agent: attemptingAgent,
        },
      );
    } catch {
      // Audit only; the 409 below is the contract.
    }
  }

  /**
   * Claim-stale matrix, holder half (PR2, plan §4 A2): on every touch, release
   * claims whose holder is gone or locked out, with one `released` event each:
   * - the holder's membership was removed (or was never live);
   * - the rooms service reports the holder `access_expired`, derived here from the credential
   *   row at read time through `memberStatuses` (binding review note
   *   1: no new columns, and no new view fields either).
   * Past-grace lapse stays separate (lapseTask/lapseRoom); room-closed release
   * lives in releaseClosedClaims.
   */
  async function releaseInvalidHolders(tx: Tx, room: RoomRow, taskId?: string): Promise<void> {
    const held = (
      await tx.query<{ id: string; claim_agent_id: string }>(
        `SELECT id,claim_agent_id FROM room_tasks WHERE room_id=$1 AND status='claimed'
          AND ($2::text IS NULL OR id=$2)`,
        [room.id, taskId ?? null],
      )
    ).rows;
    if (!held.length) return;
    const holders = [...new Set(held.map((row) => row.claim_agent_id))];
    const live = new Set(
      (
        await tx.query<{ agent_id: string }>(
          'SELECT agent_id FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[]) AND removed_at IS NULL',
          [room.id, holders],
        )
      ).rows.map((row) => row.agent_id),
    );
    const liveHolders = holders.filter((id) => live.has(id));
    const rows = liveHolders.length
      ? (
          await tx.query<{
            agent_id: string;
            owner_id: string;
            joined_at: string | number;
          }>(
            'SELECT agent_id,owner_id,joined_at FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[]) AND removed_at IS NULL',
            [room.id, liveHolders],
          )
        ).rows
      : [];
    const now = Number(
      (await tx.query<{ now: string | number }>(`SELECT ${DBNOW} AS now`)).rows[0]!.now,
    );
    const statuses = await memberStatuses(
      tx,
      { id: room.id, host_owner_id: room.host_owner_id },
      rows,
      room.host_owner_id,
      now,
      d.secret,
    );
    const invalid = new Set(
      held
        .filter(
          (row) =>
            !live.has(row.claim_agent_id) ||
            statuses.get(row.claim_agent_id)?.status === 'access_expired',
        )
        .map((row) => row.claim_agent_id),
    );
    if (!invalid.size) return;
    for (const row of held.filter((item) => invalid.has(item.claim_agent_id))) {
      const cleared = (
        await tx.query<{ id: string; claim_generation: string | number }>(
          `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}
          WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_agent_id=$3
          RETURNING id, claim_generation`,
          [row.id, room.id, row.claim_agent_id],
        )
      ).rows[0];
      if (cleared)
        await recordEvent(
          tx,
          cleared.id,
          'released',
          Number(cleared.claim_generation),
          'system',
          row.claim_agent_id,
        );
    }
  }

  /**
   * Claim-stale matrix, room half (PR2): room closed -> claims released. Close
   * itself stays in the rooms service (this module never edits it), so the next
   * read on a closed room releases every remaining claim with one `released`
   * event each. Open rooms return at once.
   */
  async function releaseClosedClaims(tx: Tx, room: RoomRow): Promise<void> {
    if (room.closed_at === null) return;
    const holders = new Map(
      (
        await tx.query<{ id: string; claim_agent_id: string | null }>(
          `SELECT id,claim_agent_id FROM room_tasks WHERE room_id=$1 AND status='claimed'`,
          [room.id],
        )
      ).rows.map((row) => [row.id, row.claim_agent_id] as const),
    );
    if (!holders.size) return;
    const cleared = (
      await tx.query<{ id: string; claim_generation: string | number }>(
        `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
          claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
          claim_generation=claim_generation+1, updated_at=${DBNOW}
        WHERE room_id=$1 AND status='claimed'
        RETURNING id, claim_generation`,
        [room.id],
      )
    ).rows;
    for (const row of cleared)
      await recordEvent(
        tx,
        row.id,
        'released',
        Number(row.claim_generation),
        'system',
        holders.get(row.id) ?? null,
      );
  }

  /**
   * Lapse one task whose lease ran past grace: clear the whole `claim_*` group and set
   * `status='open'` in the same statement (binding review note 3), then record `lapsed`.
   */
  async function lapseTask(tx: Tx, roomId: string, taskId: string): Promise<void> {
    const holder = (
      await tx.query<{ claim_agent_id: string | null }>(
        `SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2 AND status='claimed'
          AND claim_expires_at + claim_grace_ms <= ${DBNOW}`,
        [taskId, roomId],
      )
    ).rows[0];
    if (!holder) return;
    const lapsed = (
      await tx.query<{ id: string; claim_generation: string | number }>(
        `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
          claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
          claim_generation=claim_generation+1, updated_at=${DBNOW}
        WHERE id=$1 AND room_id=$2 AND status='claimed'
          AND claim_expires_at + claim_grace_ms <= ${DBNOW}
        RETURNING id, claim_generation`,
        [taskId, roomId],
      )
    ).rows[0];
    if (lapsed)
      await recordEvent(
        tx,
        lapsed.id,
        'lapsed',
        Number(lapsed.claim_generation),
        'system',
        holder.claim_agent_id,
      );
  }

  /** Lapse every past-grace claim in the room (list path), with one `lapsed` event each. */
  async function lapseRoom(tx: Tx, roomId: string): Promise<void> {
    const holders = new Map(
      (
        await tx.query<{ id: string; claim_agent_id: string | null }>(
          `SELECT id,claim_agent_id FROM room_tasks WHERE room_id=$1 AND status='claimed'
            AND claim_expires_at + claim_grace_ms <= ${DBNOW}`,
          [roomId],
        )
      ).rows.map((row) => [row.id, row.claim_agent_id] as const),
    );
    if (!holders.size) return;
    const lapsed = (
      await tx.query<{ id: string; claim_generation: string | number }>(
        `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
          claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
          claim_generation=claim_generation+1, updated_at=${DBNOW}
        WHERE room_id=$1 AND status='claimed'
          AND claim_expires_at + claim_grace_ms <= ${DBNOW}
        RETURNING id, claim_generation`,
        [roomId],
      )
    ).rows;
    for (const row of lapsed)
      await recordEvent(
        tx,
        row.id,
        'lapsed',
        Number(row.claim_generation),
        'system',
        holders.get(row.id) ?? null,
      );
  }

  /** Best-effort acting agent for pre-transaction rate charging (rechecked inside). */
  async function plainAgent(
    q: Pick<Tx, 'query'>,
    roomRef: string,
    operatorId: string,
    agentId: string | undefined,
  ): Promise<string | null> {
    try {
      const room = await findRoom(q, roomRef);
      if (!room) return null;
      const agents = await liveAgents(q, operatorId);
      const members = (
        await q.query<MemberRow>(
          'SELECT agent_id,role,kind FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
          [room.id, operatorId],
        )
      ).rows.filter(isLiveMember(agents));
      if (agentId !== undefined)
        return members.some((row) => row.agent_id === agentId) ? agentId : null;
      return members.length === 1 ? members[0]!.agent_id : null;
    } catch {
      return null;
    }
  }

  async function create(p: TaskPrincipal, body: unknown, options: TaskCreateOptions = {}) {
    const values = taskCreateInput.parse(body);
    // A template only fills defaults: the caller's title and body win (shared/task-templates.ts).
    const template =
      values.template_id === undefined ? undefined : findTaskTemplate(values.template_id);
    if (values.template_id !== undefined && !template)
      refuse(400, 'unknown_template', 'Unknown task template.', {
        templates: TASK_TEMPLATES.map((item) => item.id),
      });
    const title = values.title ?? template?.name;
    if (title === undefined) refuse(400, 'title_required', 'A task needs a title or a template.');
    const taskBody = values.body ?? (template ? taskTemplateBody(template) : '');
    const keyHash = sha(`room-task-create:${values.idempotency_key}`);
    const requestHash = sha(
      canonical({
        title,
        body: taskBody,
        from: values.from_message_seq ?? null,
        attachments: [...(values.attachment_ids ?? [])].sort(),
        ...(values.review ? { review: values.review } : {}),
        // Only present for template creates, so earlier receipts keep their hash.
        ...(template ? { template: `${template.id}@${template.version}` } : {}),
      }),
    );
    await d.limit(
      `room-task-create:${p.operatorId}:${values.room_id}`,
      limits.createsPerOwnerPerRoomPerHour,
      HOUR,
    );
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId, p);
      const agent = actingAgent(members, values.agent_id, actors, p.console === true);
      writeGuards(room, agent);
      // The host muted this owner (migration 35): no task writes either.
      await refuseIfMuted(tx, room.id, p.operatorId, agent.kind);
      const attachmentIds = [...new Set(values.attachment_ids ?? [])];
      await assertAttachmentsReady(tx, room.id, attachmentIds);
      // Serialize the receipt lookup as well as number allocation and the journal outcome.
      await tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      // The key is unique per owner across all rooms (tasks-schema.ts), so the lookup is too:
      // the same key in another room is a conflict, never a fresh insert that hits 23505.
      const replayPrior = async (): Promise<TaskCreateResult | undefined> => {
        const prior = (
          await tx.query<TaskRow>(
            'SELECT * FROM room_tasks WHERE created_by_owner_id=$1 AND idempotency_key=$2',
            [p.operatorId, keyHash],
          )
        ).rows[0];
        if (!prior) return undefined;
        if (prior.request_hash !== requestHash || prior.room_id !== room.id)
          refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different task.');
        return { task: (await withReviews(tx, [project(prior)]))[0]!, replayed: true };
      };
      const effect = async (): Promise<TaskCreateResult> => {
        const replay = await replayPrior();
        if (replay) return replay;
        if (options.precondition) {
          const refused = await options.precondition(tx);
          if (refused) refuse(409, refused, 'This task can no longer be created here.');
        }
        const maxNumber = (
          await tx.query<{ n: string | number | null }>(
            'SELECT max(number) AS n FROM room_tasks WHERE room_id=$1',
            [room.id],
          )
        ).rows[0]?.n;
        const inserted = (
          await tx.query<TaskRow>(
            `INSERT INTO room_tasks(id,room_id,number,title,body,status,created_by_agent_id,
            created_by_owner_id,from_message_seq,attachment_ids,created_at,updated_at,
            idempotency_key,request_hash,template_id,template_version)
          VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9::text[],${DBNOW},${DBNOW},$10,$11,$12,$13)
          ON CONFLICT (created_by_owner_id, idempotency_key) DO NOTHING
          RETURNING *`,
            [
              randomUUID(),
              room.id,
              Number(maxNumber ?? 0) + 1,
              title,
              taskBody,
              agent.agent_id,
              p.operatorId,
              values.from_message_seq ?? null,
              attachmentIds,
              keyHash,
              requestHash,
              template?.id ?? null,
              template?.version ?? null,
            ],
          )
        ).rows[0];
        if (!inserted) {
          // A concurrent create with this key (another room's lock) committed first: replay it
          // or refuse it, never a 500.
          const replay = await replayPrior();
          if (replay) return replay;
          refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different task.');
        }
        const row = inserted!;
        await recordEvent(
          tx,
          row.id,
          'created',
          Number(row.claim_generation),
          p.actor,
          agent.agent_id,
        );
        await taskLine(
          tx,
          room.id,
          `${await memberLabel(tx, room.id, agent.agent_id)} created ${taskRef(row)}`,
        );
        if (values.review) await openReview(tx, p, room, row, agent, values.review);
        await touchMembers(tx, room.id, [agent.agent_id], d.clock());
        if (values.review) {
          const [task] = await withReviews(tx, [project(row)]);
          return { task: task!, replayed: false };
        }
        return { task: project(row), replayed: false };
      };
      return options.execute ? options.execute(tx, effect) : effect();
    });
  }

  async function get(p: TaskPrincipal, body: unknown) {
    const values = taskGetInput.parse(body);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId, p);
      if (room.closed_at !== null) await releaseClosedClaims(tx, room);
      else {
        await releaseInvalidHolders(tx, room, values.task_id);
        await lapseTask(tx, room.id, values.task_id);
      }
      const row = (
        await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
          values.task_id,
          room.id,
        ])
      ).rows[0];
      if (!row) refuse(404, 'task_not_found', 'Task not found in this room.');
      const [task] = await withReviews(tx, [project(row!)]);
      return { task: task! };
    });
  }

  async function list(p: TaskPrincipal, body: unknown) {
    const values = taskListInput.parse(body);
    const size = Math.min(values.limit ?? limits.defaultPageSize, limits.pageSize);
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p.operatorId, p);
      if (room.closed_at !== null) await releaseClosedClaims(tx, room);
      else {
        await releaseInvalidHolders(tx, room);
        await lapseRoom(tx, room.id);
      }
      const params: unknown[] = [room.id];
      let where = 'room_id=$1';
      if (values.status !== undefined) {
        params.push(values.status);
        where += ` AND status=$${params.length}`;
      }
      if (values.mine === true) {
        params.push(members.map((row) => row.agent_id));
        where += ` AND claim_agent_id = ANY($${params.length}::text[])`;
      }
      if (values.stage !== undefined) {
        params.push(resolveStage(room, values.stage));
        where += ` AND stage=$${params.length}`;
      }
      if (values.after_number !== undefined) {
        params.push(values.after_number);
        where += ` AND number > $${params.length}`;
      }
      // One row past the page tells whether another page follows.
      params.push(size + 1);
      const rows = (
        await tx.query<TaskRow>(
          `SELECT * FROM room_tasks WHERE ${where} ORDER BY number LIMIT $${params.length}`,
          params,
        )
      ).rows;
      const shown = rows.slice(0, size);
      return {
        room_id: room.id,
        tasks: await withReviews(tx, shown.map(project)),
        stages: stagesOf(room),
        next_after: shown.length ? Number(shown.at(-1)!.number) : null,
        has_more: rows.length > size,
      };
    });
  }

  async function claim(p: TaskPrincipal, body: unknown) {
    const values = taskClaimInput.parse(body);
    // Charged before the transaction (pool rule); the agent is rechecked under the lock.
    const probe = await plainAgent(d.db, values.room_id, p.operatorId, values.agent_id);
    await d.limit(`room-task-claim:${probe ?? p.operatorId}`, limits.claimsPerAgentPerHour, HOUR);
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId, p);
      const agent = actingAgent(members, values.agent_id, actors, p.console === true);
      writeGuards(room, agent);
      // The host muted this owner (migration 35): no task writes either.
      await refuseIfMuted(tx, room.id, p.operatorId, agent.kind);
      await lockRoom(tx, room.id);
      // A removed or access-expired holder is released first, so this claim can
      // take the task over in its single UPDATE below.
      await releaseInvalidHolders(tx, room, values.task_id);
      // Whether this is a new claim (a line in the thread) or the holder re-issuing (no line).
      const before = (
        await tx.query<{ status: string; claim_agent_id: string | null }>(
          'SELECT status, claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2',
          [values.task_id, room.id],
        )
      ).rows[0];
      const ttlMs = (values.ttl_minutes ?? limits.claimTtlMinutesDefault) * 60_000;
      const graceMs = graceForTtl(ttlMs);
      const token = mintClaimToken();
      // One conditional UPDATE, grace included: open, past grace (takeover), or the
      // holding agent re-issuing (which mints a NEW token, never the old one).
      // Statuses done/cancelled/in_review never match, so a claim can never reopen
      // a closed task; the follow-up SELECT reports those as 409 task_not_claimable.
      const row = (
        await tx.query<TaskRow>(
          `UPDATE room_tasks SET status='claimed', claim_agent_id=$3, claim_owner_id=$4,
            claim_expires_at=${DBNOW}+($5::bigint), claim_ttl_ms=$5, claim_grace_ms=$6,
            claim_token_hash=$7, claim_generation=claim_generation+1, updated_at=${DBNOW}
          WHERE id=$1 AND room_id=$2
            AND status IN ('open','claimed')
            AND (claim_agent_id IS NULL
              OR claim_expires_at + claim_grace_ms <= ${DBNOW}
              OR claim_agent_id=$3)
          RETURNING *`,
          [
            values.task_id,
            room.id,
            agent.agent_id,
            p.operatorId,
            ttlMs,
            graceMs,
            tokenHashOf(token),
          ],
        )
      ).rows[0];
      if (!row) {
        const current = (
          await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
            values.task_id,
            room.id,
          ])
        ).rows[0];
        if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
        if (
          current!.status === 'done' ||
          current!.status === 'cancelled' ||
          current!.status === 'in_review'
        )
          refuse(409, 'task_not_claimable', 'The task is closed and cannot be claimed.', {
            status: current!.status,
          });
        refuse(409, 'task_claimed', 'The task is already claimed.', {
          claimed_by: current!.claim_agent_id,
          expires_at: iso(Number(current!.claim_expires_at)),
          grace_until: iso(Number(current!.claim_expires_at) + Number(current!.claim_grace_ms)),
        });
      }
      await recordEvent(
        tx,
        row!.id,
        'claimed',
        Number(row!.claim_generation),
        p.actor,
        agent.agent_id,
      );
      if (before?.status !== 'claimed' || before.claim_agent_id !== agent.agent_id)
        await taskLine(
          tx,
          room.id,
          `${await memberLabel(tx, room.id, agent.agent_id)} claimed ${taskRef(row!)}`,
        );
      if (values.review) await openReview(tx, p, room, row!, agent, values.review);
      await touchMembers(tx, room.id, [agent.agent_id], d.clock());
      return {
        task: (await withReviews(tx, [project(row!)]))[0]!,
        claim_token: token,
        generation: Number(row!.claim_generation),
        expires_at: iso(Number(row!.claim_expires_at)),
        grace_until: iso(Number(row!.claim_expires_at) + Number(row!.claim_grace_ms)),
      };
    });
  }

  async function renew(p: TaskPrincipal, body: unknown) {
    const values = taskRenewInput.parse(body);
    const hash = tokenHashOf(values.claim_token);
    const holder = await (async () => {
      try {
        const room = await findRoom(d.db, values.room_id);
        if (!room) return null;
        const row = (
          await d.db.query<{ claim_agent_id: string | null }>(
            'SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2 AND claim_token_hash=$3',
            [values.task_id, room.id, hash],
          )
        ).rows[0];
        return row?.claim_agent_id ?? null;
      } catch {
        return null;
      }
    })();
    await d.limit(`room-task-claim:${holder ?? p.operatorId}`, limits.claimsPerAgentPerHour, HOUR);
    try {
      return await d.db.transaction(async (tx) => {
        const { room, members } = await membership(tx, values.room_id, p.operatorId, p);
        if (room.closed_at !== null)
          refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
        await refuseIfMuted(
          tx,
          room.id,
          p.operatorId,
          await claimHolderKind(tx, room.id, values.task_id, hash, members),
        );
        await releaseInvalidHolders(tx, room, values.task_id);
        const ttlMs = (values.ttl_minutes ?? limits.claimTtlMinutesDefault) * 60_000;
        const graceMs = graceForTtl(ttlMs);
        // Renewal is explicit only and allowed inside grace. It keeps the token and the
        // generation; the response carries expiries, never a token.
        const row = (
          await tx.query<TaskRow>(
            `UPDATE room_tasks SET claim_expires_at=${DBNOW}+($4::bigint),
              claim_ttl_ms=$4, claim_grace_ms=$5, updated_at=${DBNOW}
            WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_token_hash=$3
              AND claim_expires_at + claim_grace_ms > ${DBNOW}
            RETURNING *`,
            [values.task_id, room.id, hash, ttlMs, graceMs],
          )
        ).rows[0];
        if (!row) {
          const current = (
            await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
              values.task_id,
              room.id,
            ])
          ).rows[0];
          if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
          stale(current!);
        }
        await recordEvent(
          tx,
          row!.id,
          'renewed',
          Number(row!.claim_generation),
          p.actor,
          row!.claim_agent_id,
        );
        await touchMembers(tx, room.id, [row!.claim_agent_id!], d.clock());
        return {
          task: (await withReviews(tx, [project(row!)]))[0]!,
          expires_at: iso(Number(row!.claim_expires_at)),
          grace_until: iso(Number(row!.claim_expires_at) + Number(row!.claim_grace_ms)),
        };
      });
    } catch (error) {
      if (error instanceof TaskError && error.errorCode === 'claim_stale')
        await auditStale(values.room_id, values.task_id, p);
      throw error;
    }
  }

  async function release(p: TaskPrincipal, body: unknown) {
    const values = taskReleaseInput.parse(body);
    try {
      return await d.db.transaction(async (tx) => {
        const { room } = await membership(tx, values.room_id, p.operatorId, p);
        if (room.closed_at !== null)
          refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
        await releaseInvalidHolders(tx, room, values.task_id);
        const current = (
          await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
            values.task_id,
            room.id,
          ])
        ).rows[0];
        if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
        const clear = `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}`;
        if (values.claim_token !== undefined) {
          const row = (
            await tx.query<TaskRow>(
              `${clear} WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_token_hash=$3 RETURNING *`,
              [values.task_id, room.id, tokenHashOf(values.claim_token)],
            )
          ).rows[0];
          if (!row) stale(current!);
          await recordEvent(
            tx,
            row!.id,
            'released',
            Number(row!.claim_generation),
            p.actor,
            current!.claim_agent_id,
          );
          await touchMembers(tx, room.id, [current!.claim_agent_id!], d.clock());
          return { task: (await withReviews(tx, [project(row!)]))[0]!, released: true };
        }
        // Host force-release (plan §3): no token, host authority only.
        if (room.host_owner_id !== p.operatorId)
          refuse(400, 'claim_token_required', 'Pass the claim token to release this task.');
        if (current!.status !== 'claimed')
          return { task: (await withReviews(tx, [project(current!)]))[0]!, released: false };
        const row = (
          await tx.query<TaskRow>(
            `${clear} WHERE id=$1 AND room_id=$2 AND status='claimed' RETURNING *`,
            [values.task_id, room.id],
          )
        ).rows[0]!;
        await recordEvent(
          tx,
          row.id,
          'released',
          Number(row.claim_generation),
          p.actor,
          current!.claim_agent_id,
        );
        return { task: (await withReviews(tx, [project(row)]))[0]!, released: true };
      });
    } catch (error) {
      if (error instanceof TaskError && error.errorCode === 'claim_stale')
        await auditStale(values.room_id, values.task_id, p);
      throw error;
    }
  }

  /**
   * Result binding (PR2, plan §6 milestone 2): the current token holder — and only
   * it — attaches step-2 evidence bound to a revision, moving claimed -> in_review.
   * The UPDATE matches the live token inside the lease + grace window (06c, the
   * same window as renew) and clears the whole `claim_*` group in the same
   * statement (CHECK-safe); the old token dies at once. No limiter charge:
   * one result per claim needs no budget.
   */
  async function result(p: TaskPrincipal, body: unknown) {
    const values = taskResultInput.parse(body);
    const hash = tokenHashOf(values.claim_token);
    try {
      return await d.db.transaction(async (tx) => {
        const { room, members } = await membership(tx, values.room_id, p.operatorId, p);
        if (room.closed_at !== null)
          refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
        await refuseIfMuted(
          tx,
          room.id,
          p.operatorId,
          await claimHolderKind(tx, room.id, values.task_id, hash, members),
        );
        await lockRoom(tx, room.id);
        await releaseInvalidHolders(tx, room, values.task_id);
        const holder = (
          await tx.query<{ claim_agent_id: string | null }>(
            'SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2',
            [values.task_id, room.id],
          )
        ).rows[0]?.claim_agent_id;
        // Accepted only inside the lease + grace window (the same window as
        // renew): past grace the token is stale and the write is a 409.
        const row = (
          await tx.query<TaskRow>(
            `UPDATE room_tasks SET status='in_review', result=$4::jsonb,
              submitted_by=claim_agent_id, claim_agent_id=NULL, claim_owner_id=NULL, claim_expires_at=NULL,
              claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
              claim_generation=claim_generation+1, updated_at=${DBNOW}
            WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_token_hash=$3
              AND claim_expires_at + claim_grace_ms > ${DBNOW}
            RETURNING *`,
            [values.task_id, room.id, hash, JSON.stringify(values.evidence)],
          )
        ).rows[0];
        if (!row) {
          const current = (
            await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
              values.task_id,
              room.id,
            ])
          ).rows[0];
          if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
          stale(current!);
        }
        await recordEvent(
          tx,
          row!.id,
          'result_posted',
          Number(row!.claim_generation),
          p.actor,
          holder ?? null,
        );
        await taskLine(
          tx,
          room.id,
          `${await memberLabel(tx, room.id, holder)} submitted a result for ${taskRef(row!)}`,
        );
        if (holder) await touchMembers(tx, room.id, [holder], d.clock());
        return { task: (await withReviews(tx, [project(row!)]))[0]! };
      });
    } catch (error) {
      if (error instanceof TaskError && error.errorCode === 'claim_stale')
        await auditStale(values.room_id, values.task_id, p);
      throw error;
    }
  }

  /**
   * Review and cancel (PR2): the host — and only the host — approves an in_review
   * task to done, rejects it back to open (clearing the evidence for a fresh
   * attempt), or cancels an open/claimed/in_review task. Closed rooms are
   * read-only, so review refuses there; done is terminal (409) and an already
   * cancelled task reports `applied: false`, mirroring release.
   */
  async function update(p: TaskPrincipal, body: unknown) {
    const values = taskUpdateInput.parse(body);
    if (values.decision !== undefined && values.stage !== undefined)
      refuse(400, 'invalid_request', 'Send either a decision or a stage, not both.');
    if (values.decision === undefined) {
      if (values.stage === undefined) refuse(400, 'invalid_request', 'Send a decision or a stage.');
      return moveStage(p, values.room_id, values.task_id, values.stage!);
    }
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId, p);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
      if (room.host_owner_id !== p.operatorId)
        refuse(403, 'host_required', 'Only the room host can review or cancel tasks.');
      await lockRoom(tx, room.id);
      if (values.decision === 'approve' || values.decision === 'reject') {
        // Read the posted evidence first: reject clears it from the task but
        // keeps a copy in the `rejected` event payload, marked
        // `untrusted: true` (PR3: kept evidence is another owner's agent text).
        const pending =
          values.decision === 'reject'
            ? ((
                await tx.query<{ result: unknown }>(
                  'SELECT result FROM room_tasks WHERE id=$1 AND room_id=$2',
                  [values.task_id, room.id],
                )
              ).rows[0]?.result ?? null)
            : null;
        const row = (
          await tx.query<TaskRow>(
            values.decision === 'approve'
              ? `UPDATE room_tasks SET status='done',
                  claim_generation=claim_generation+1, updated_at=${DBNOW}
                WHERE id=$1 AND room_id=$2 AND status='in_review' RETURNING *`
              : `UPDATE room_tasks SET status='open', result=NULL,
                  claim_generation=claim_generation+1, updated_at=${DBNOW}
                WHERE id=$1 AND room_id=$2 AND status='in_review' RETURNING *`,
            [values.task_id, room.id],
          )
        ).rows[0];
        if (!row) {
          const current = (
            await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
              values.task_id,
              room.id,
            ])
          ).rows[0];
          if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
          refuse(409, 'task_not_in_review', 'Only tasks in review can be approved or rejected.', {
            status: current!.status,
          });
        }
        await recordEvent(
          tx,
          row!.id,
          values.decision === 'approve' ? 'approved' : 'rejected',
          Number(row!.claim_generation),
          p.actor,
          null,
          values.decision === 'reject' ? { evidence: pending, untrusted: true } : undefined,
        );
        await taskLine(
          tx,
          room.id,
          values.decision === 'approve'
            ? `The host accepted ${taskRef(row!)}`
            : `The host sent back ${taskRef(row!)}`,
        );
        return {
          task: (await withReviews(tx, [project(row!)]))[0]!,
          decision: values.decision,
          applied: true as const,
        };
      }
      const current = (
        await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
          values.task_id,
          room.id,
        ])
      ).rows[0];
      if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
      if (current!.status === 'cancelled')
        return {
          task: (await withReviews(tx, [project(current!)]))[0]!,
          decision: values.decision,
          applied: false as const,
        };
      if (current!.status === 'done')
        refuse(409, 'task_closed', 'The task is done and cannot be cancelled.', {
          status: current!.status,
        });
      // Cancel keeps the posted evidence (if any) for the audit trail and clears the
      // claim group CHECK-safely when one is held.
      const row = (
        await tx.query<TaskRow>(
          `UPDATE room_tasks SET status='cancelled', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}
          WHERE id=$1 AND room_id=$2 AND status IN ('open','claimed','in_review')
          RETURNING *`,
          [values.task_id, room.id],
        )
      ).rows[0]!;
      await recordEvent(
        tx,
        row.id,
        'cancelled',
        Number(row.claim_generation),
        p.actor,
        current!.claim_agent_id,
      );
      await taskLine(tx, room.id, `The host cancelled ${taskRef(row)}`);
      return {
        task: (await withReviews(tx, [project(row)]))[0]!,
        decision: values.decision,
        applied: true as const,
      };
    });
  }

  /**
   * Peer review (docs/ROOM_TASKS.md "Peer review", migration 56). Advisory only: a request and a
   * verdict never move the task, and the host's approve / send back is unchanged.
   */
  type ReviewRow = {
    id: string;
    task_id: string;
    reviewer_agent_id: string;
    reviewer_owner_id: string;
    requested_by_agent_id: string;
    requested_by_owner_id: string;
    checklist: unknown;
    status: string;
    comment: string | null;
    ticks: unknown;
    requested_at: string | number;
    decided_at: string | number | null;
  };
  const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
  function projectReview(row: ReviewRow): TaskPeerReviewView {
    const items = (json(row.checklist) as string[] | null) ?? [];
    const ticks = (json(row.ticks) as boolean[] | null) ?? null;
    return {
      id: row.id,
      status: row.status as TaskPeerReviewView['status'],
      reviewer_agent_id: row.reviewer_agent_id,
      requested_by_agent_id: row.requested_by_agent_id,
      checklist: items.map((item, index) => ({
        item,
        checked: ticks ? (ticks[index] ?? null) : null,
      })),
      comment: row.comment,
      requested_at: iso(Number(row.requested_at)),
      decided_at: row.decided_at === null ? null : iso(Number(row.decided_at)),
    };
  }
  /** The latest review of each task (null when none). Tolerates a database before migration 56. */
  async function latestReviews(
    q: Pick<Tx, 'query'>,
    taskIds: readonly string[],
  ): Promise<Map<string, TaskPeerReviewView>> {
    if (!taskIds.length) return new Map();
    try {
      const rows = (
        await q.query<ReviewRow>(
          `SELECT DISTINCT ON (task_id) * FROM room_task_reviews WHERE task_id = ANY($1::text[])
            ORDER BY task_id, requested_at DESC, id DESC`,
          [[...taskIds]],
        )
      ).rows;
      return new Map(rows.map((row) => [row.task_id, projectReview(row)]));
    } catch (error) {
      if (missingTable(error)) return new Map();
      throw error;
    }
  }
  async function withReviews(q: Pick<Tx, 'query'>, tasks: TaskView[]): Promise<TaskView[]> {
    const reviews = await latestReviews(
      q,
      tasks.map((task) => task.id),
    );
    // Absent when nobody asked for a review, so task views stay as they were.
    return tasks.map((task) => {
      const review = reviews.get(task.id);
      return review ? { ...task, peer_review: review } : task;
    });
  }

  /**
   * Who did the work: the claim holder, else the agent that posted the latest result (also after
   * the host sent it back, so its author never reviews its own earlier work).
   */
  async function claimerOf(
    q: Pick<Tx, 'query'>,
    room: RoomRow,
    task: TaskRow,
  ): Promise<{ agentId: string; ownerId: string | null } | null> {
    if (task.claim_agent_id) return { agentId: task.claim_agent_id, ownerId: task.claim_owner_id };
    // No claim (open again after a send back, or in review): the author of the latest result
    // is still the one whose work is under review.
    const posted = (
      await q.query<{ agent_id: string | null }>(
        `SELECT agent_id FROM room_task_events WHERE task_id=$1 AND action='result_posted'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [task.id],
      )
    ).rows[0]?.agent_id;
    if (!posted) return null;
    const owner = (
      await q.query<{ owner_id: string }>(
        'SELECT owner_id FROM room_members WHERE room_id=$1 AND agent_id=$2',
        [room.id, posted],
      )
    ).rows[0]?.owner_id;
    return { agentId: posted, ownerId: owner ?? null };
  }

  async function hostAgentOf(q: Pick<Tx, 'query'>, room: RoomRow): Promise<string | null> {
    return (
      (
        await q.query<{ agent_id: string }>(
          `SELECT agent_id FROM room_members WHERE room_id=$1 AND role='host' AND removed_at IS NULL
            ORDER BY joined_at LIMIT 1`,
          [room.id],
        )
      ).rows[0]?.agent_id ?? null
    );
  }

  /** A line in the thread that also mentions (and so wakes) the members it concerns. */
  async function reviewLine(
    tx: Pick<Tx, 'query'>,
    roomId: string,
    text: string,
    from: string,
    notify: readonly (string | null | undefined)[],
  ) {
    const seq = await taskLine(tx, roomId, text);
    if (seq === null) return;
    await taskReviewNotice(tx as Tx, {
      roomId,
      seq,
      agentIds: notify.filter((id): id is string => !!id),
      fromAgentId: from,
      fromName: await memberLabel(tx, roomId, from),
      text,
      time: d.clock(),
    });
  }

  /**
   * Invite guests (an AI that joined through an invite link without an account, holding a room
   * credential) never request, give or receive a peer review, whatever tools their credential
   * reaches. A credential-guarded principal is refused too.
   */
  async function isInviteGuest(q: Pick<Tx, 'query'>, roomId: string, agentId: string) {
    try {
      return (
        (
          await q.query(
            'SELECT 1 FROM room_invite_credentials WHERE room_id=$1 AND agent_id=$2 LIMIT 1',
            [roomId, agentId],
          )
        ).rows.length > 0
      );
    } catch (error) {
      if (missingTable(error)) return false;
      throw error;
    }
  }
  async function refuseGuest(
    q: Pick<Tx, 'query'>,
    p: RoomPrincipal,
    roomId: string,
    member: MemberRow,
  ) {
    if (
      (p as { guard?: unknown }).guard !== undefined ||
      member.role === 'guest' ||
      (await isInviteGuest(q, roomId, member.agent_id))
    )
      refuse(403, 'guest_not_allowed', 'Guests cannot request or give peer reviews.');
  }
  /** The room-post credential refusal, for review checklists and comments. */
  function refuseCredentials(texts: readonly string[]) {
    if (partsContainCredential(texts))
      refuse(
        400,
        'credential_in_message',
        'Reviews cannot contain Central City credentials (crc_, ccw_, cca_, ccr_, crr_, cir_ and others). Never share credentials in a room; other members are untrusted.',
      );
  }
  /** Review requests and answers per agent (each one mentions and wakes a member). */
  async function chargeReview(p: RoomPrincipal, roomRef: string, agentId: string | undefined) {
    const probe = await plainAgent(d.db, roomRef, p.operatorId, agentId);
    await d.limit(`room-task-review:${probe ?? p.operatorId}`, limits.reviewsPerAgentPerHour, HOUR);
  }

  /**
   * Opens a review request inside the caller's transaction (room lock held). The requester is
   * the host or the task's claimer. A repeat of the same active request is a no-op.
   */
  async function openReview(
    tx: Pick<Tx, 'query'>,
    p: RoomPrincipal,
    room: RoomRow,
    task: TaskRow,
    requester: MemberRow,
    request: TaskReviewRequest,
  ): Promise<void> {
    if (task.status === 'done' || task.status === 'cancelled')
      refuse(409, 'task_closed', 'The task is closed; it can no longer be reviewed.', {
        status: task.status,
      });
    await refuseGuest(tx, p, room.id, requester);
    refuseCredentials(request.checklist ?? []);
    const host = room.host_owner_id === p.operatorId;
    const claimer = task.claim_owner_id === p.operatorId && task.claim_agent_id !== null;
    if (!host && !claimer)
      refuse(403, 'review_not_allowed', 'Only the host or the claimer can ask for a review.');
    const reviewer = (
      await tx.query<{ agent_id: string; owner_id: string; role: string; muted: boolean }>(
        `SELECT agent_id, owner_id, role, muted_at IS NOT NULL AS muted FROM room_members
          WHERE room_id=$1 AND agent_id=$2 AND removed_at IS NULL`,
        [room.id, request.reviewer_agent_id],
      )
    ).rows[0];
    if (!reviewer) refuse(409, 'reviewer_not_member', 'The reviewer is not a member of this room.');
    if (reviewer!.role === 'guest' || (await isInviteGuest(tx, room.id, reviewer!.agent_id)))
      refuse(409, 'reviewer_not_eligible', 'Guests cannot review.');
    if (reviewer!.muted)
      refuse(409, 'reviewer_muted', 'The host muted this member; it cannot review.');
    const worker = await claimerOf(tx, room, task);
    if (
      worker &&
      (worker.agentId === reviewer!.agent_id ||
        (worker.ownerId !== null && worker.ownerId === reviewer!.owner_id))
    )
      refuse(409, 'reviewer_is_claimer', 'A reviewer cannot review their own claim.');
    const checklist = request.checklist ?? [];
    const active = (
      await tx.query<ReviewRow>(
        `SELECT * FROM room_task_reviews WHERE task_id=$1 AND status='requested' FOR UPDATE`,
        [task.id],
      )
    ).rows[0];
    if (active) {
      if (
        active.reviewer_agent_id === reviewer!.agent_id &&
        JSON.stringify(json(active.checklist)) === JSON.stringify(checklist)
      )
        return;
      refuse(409, 'review_active', 'This task already has an open review request.', {
        reviewer_agent_id: active.reviewer_agent_id,
      });
    }
    await tx.query(
      `INSERT INTO room_task_reviews(id,task_id,room_id,reviewer_agent_id,reviewer_owner_id,
        requested_by_agent_id,requested_by_owner_id,checklist,status,requested_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'requested',${DBNOW})`,
      [
        randomUUID(),
        task.id,
        room.id,
        reviewer!.agent_id,
        reviewer!.owner_id,
        requester.agent_id,
        p.operatorId,
        JSON.stringify(checklist),
      ],
    );
    await recordEvent(
      tx,
      task.id,
      'review_requested',
      Number(task.claim_generation),
      p.actor,
      requester.agent_id,
      { reviewer_agent_id: reviewer!.agent_id, checklist, untrusted: true },
    );
    await reviewLine(
      tx,
      room.id,
      `${await memberLabel(tx, room.id, requester.agent_id)} asked ${await memberLabel(tx, room.id, reviewer!.agent_id)} to review ${taskRef(task)}`,
      requester.agent_id,
      [reviewer!.agent_id],
    );
  }

  async function taskRow(tx: Pick<Tx, 'query'>, roomId: string, taskId: string) {
    const row = (
      await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2 FOR UPDATE', [
        taskId,
        roomId,
      ])
    ).rows[0];
    if (!row) refuse(404, 'task_not_found', 'Task not found in this room.');
    return row!;
  }

  async function requestReview(p: RoomPrincipal, body: unknown) {
    const values = taskRequestReviewInput.parse(body);
    if (!values.cancel && values.reviewer_agent_id === undefined)
      refuse(400, 'reviewer_required', 'Pass reviewer_agent_id to ask for a review.');
    refuseCredentials(values.checklist ?? []);
    await chargeReview(p, values.room_id, values.agent_id);
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId);
      const agent = actingAgent(members, values.agent_id, actors, p.console === true);
      await refuseGuest(tx, p, room.id, agent);
      writeGuards(room, agent);
      await refuseIfMuted(tx, room.id, p.operatorId, agent.kind);
      await lockRoom(tx, room.id);
      await releaseInvalidHolders(tx, room, values.task_id);
      const task = await taskRow(tx, room.id, values.task_id);
      if (values.cancel) {
        const active = (
          await tx.query<ReviewRow>(
            `SELECT * FROM room_task_reviews WHERE task_id=$1 AND status='requested' FOR UPDATE`,
            [task.id],
          )
        ).rows[0];
        if (!active) {
          const [view] = await withReviews(tx, [project(task)]);
          return { task: view!, requested: false };
        }
        if (
          room.host_owner_id !== p.operatorId &&
          active.requested_by_owner_id !== p.operatorId &&
          task.claim_owner_id !== p.operatorId
        )
          refuse(403, 'review_not_allowed', 'Only the host or the claimer can withdraw a review.');
        await tx.query(
          `UPDATE room_task_reviews SET status='cancelled', decided_at=${DBNOW} WHERE id=$1`,
          [active.id],
        );
        await recordEvent(
          tx,
          task.id,
          'review_cancelled',
          Number(task.claim_generation),
          p.actor,
          agent.agent_id,
          { reviewer_agent_id: active.reviewer_agent_id },
        );
        const [view] = await withReviews(tx, [project(task)]);
        return { task: view!, requested: false };
      }
      await openReview(tx, p, room, task, agent, {
        reviewer_agent_id: values.reviewer_agent_id!,
        ...(values.checklist ? { checklist: values.checklist } : {}),
      });
      await touchMembers(tx, room.id, [agent.agent_id], d.clock());
      const [view] = await withReviews(tx, [project(task)]);
      return { task: view!, requested: true };
    });
  }

  async function peerReview(p: RoomPrincipal, body: unknown) {
    const values = taskPeerReviewInput.parse(body);
    refuseCredentials(values.comment === undefined ? [] : [values.comment]);
    await chargeReview(p, values.room_id, values.agent_id);
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
      await lockRoom(tx, room.id);
      const task = await taskRow(tx, room.id, values.task_id);
      const active = (
        await tx.query<ReviewRow>(
          `SELECT * FROM room_task_reviews WHERE task_id=$1 AND status='requested' FOR UPDATE`,
          [task.id],
        )
      ).rows[0];
      // With several agents in the room and none named, act as the requested reviewer.
      const agentId =
        values.agent_id ??
        (active && actors.some((row) => row.agent_id === active.reviewer_agent_id)
          ? active.reviewer_agent_id
          : undefined);
      const agent = actingAgent(members, agentId, actors, p.console === true);
      await refuseGuest(tx, p, room.id, agent);
      writeGuards(room, agent);
      // The host muted this owner (migration 35); a bulk AI mute spares a person reviewer.
      await refuseIfMuted(tx, room.id, p.operatorId, agent.kind);
      if (!active) refuse(409, 'no_review_requested', 'Nobody asked for a review of this task.');
      if (active!.reviewer_agent_id !== agent.agent_id)
        refuse(403, 'not_the_reviewer', 'Only the requested reviewer can review this task.');
      if (task.status === 'done' || task.status === 'cancelled')
        refuse(409, 'task_closed', 'The task is closed; it can no longer be reviewed.', {
          status: task.status,
        });
      const worker = await claimerOf(tx, room, task);
      if (worker && (worker.agentId === agent.agent_id || worker.ownerId === p.operatorId))
        refuse(403, 'own_claim', 'A reviewer cannot review their own claim.');
      const items = (json(active!.checklist) as string[] | null) ?? [];
      if (values.checklist !== undefined && values.checklist.length !== items.length)
        refuse(400, 'checklist_mismatch', 'Send one tick per checklist item, in order.', {
          items: items.length,
        });
      const status = values.verdict === 'approve' ? 'approved' : 'changes_requested';
      const comment = values.comment?.trim() ? values.comment.trim() : null;
      await tx.query(
        `UPDATE room_task_reviews SET status=$2, comment=$3, ticks=$4::jsonb, decided_at=${DBNOW}
          WHERE id=$1 AND status='requested'`,
        [
          active!.id,
          status,
          comment,
          values.checklist === undefined ? null : JSON.stringify(values.checklist),
        ],
      );
      await recordEvent(
        tx,
        task.id,
        'peer_reviewed',
        Number(task.claim_generation),
        p.actor,
        agent.agent_id,
        {
          verdict: values.verdict,
          comment,
          checklist: items.map((item, index) => ({
            item,
            checked: values.checklist?.[index] ?? null,
          })),
          untrusted: true,
        },
      );
      const reviewer = await memberLabel(tx, room.id, agent.agent_id);
      await reviewLine(
        tx,
        room.id,
        values.verdict === 'approve'
          ? `${reviewer} approved ${taskRef(task)} in a peer review`
          : `${reviewer} asked for changes on ${taskRef(task)} in a peer review`,
        agent.agent_id,
        [worker?.agentId, await hostAgentOf(tx, room)],
      );
      await touchMembers(tx, room.id, [agent.agent_id], d.clock());
      const [view] = await withReviews(tx, [project(task)]);
      return { task: view!, verdict: values.verdict };
    });
  }

  /**
   * Stage move (migration 54): the host, or the owner of the agent holding the claim, moves the
   * task to one of the room's stages (null clears it). The status never changes. Each change
   * writes one `stage_changed` event (actor, agent, `{from, to}`); the same stage is a no-op
   * (`applied: false`, no event).
   */
  async function moveStage(
    p: TaskPrincipal,
    roomRef: string,
    taskId: string,
    stage: string | null,
  ): Promise<{ task: TaskView; applied: boolean }> {
    return d.db.transaction(async (tx) => {
      const { room, actors } = await membership(tx, roomRef, p.operatorId, p);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
      await lockRoom(tx, room.id);
      // The stage list as of the room lock (a concurrent list edit holds the same lock).
      room.task_stages = (
        await tx.query<{ task_stages: string[] | null }>(
          'SELECT task_stages FROM rooms WHERE id=$1',
          [room.id],
        )
      ).rows[0]?.task_stages;
      await releaseInvalidHolders(tx, room, taskId);
      await lapseTask(tx, room.id, taskId);
      const current = (
        await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2 FOR UPDATE', [
          taskId,
          room.id,
        ])
      ).rows[0];
      if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
      const host = room.host_owner_id === p.operatorId;
      const holder =
        current!.status === 'claimed' &&
        current!.claim_owner_id === p.operatorId &&
        actors.some((row) => row.agent_id === current!.claim_agent_id);
      if (!host && !holder)
        refuse(
          403,
          'stage_not_allowed',
          'Only the host or the member working on this task can change its stage.',
        );
      // The host muted this owner (migration 35): no task writes either.
      if (!host)
        await refuseIfMuted(
          tx,
          room.id,
          p.operatorId,
          actors.find((row) => row.agent_id === current!.claim_agent_id)?.kind,
        );
      const next = stage === null ? null : resolveStage(room, stage);
      const from = current!.stage ?? null;
      if (from === next)
        return { task: (await withReviews(tx, [project(current!)]))[0]!, applied: false };
      const row = (
        await tx.query<TaskRow>(
          `UPDATE room_tasks SET stage=$3, updated_at=${DBNOW} WHERE id=$1 AND room_id=$2 RETURNING *`,
          [taskId, room.id, next],
        )
      ).rows[0]!;
      await recordEvent(
        tx,
        row.id,
        'stage_changed',
        Number(row.claim_generation),
        p.actor,
        holder && !host ? current!.claim_agent_id : null,
        { from, to: next },
      );
      return { task: (await withReviews(tx, [project(row)]))[0]!, applied: true };
    });
  }

  async function stages(p: TaskPrincipal, body: unknown) {
    const values = taskGetInput.pick({ room_id: true }).parse(body);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId, p);
      return { room_id: room.id, stages: stagesOf(room) };
    });
  }

  /**
   * Host only: replace the stage list. Names are trimmed and must be unique without case. Tasks
   * at a stage that is no longer on the list lose their stage, each with a `stage_changed` event
   * (`reason: 'stage_removed'`).
   */
  async function setStages(p: TaskPrincipal, body: unknown) {
    const values = taskStagesInput.parse(body);
    const seen = new Set<string>();
    for (const name of values.stages) {
      const key = name.toLowerCase();
      if (seen.has(key))
        refuse(400, 'duplicate_stage', `The stage "${name}" is listed twice.`, { stage: name });
      seen.add(key);
    }
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId, p);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its settings cannot change.');
      if (room.host_owner_id !== p.operatorId)
        refuse(403, 'host_required', 'Only the room host can change the task stages.');
      await lockRoom(tx, room.id);
      await tx.query('UPDATE rooms SET task_stages=$2::text[] WHERE id=$1', [
        room.id,
        values.stages,
      ]);
      // A case-only rename ("testing" -> "Testing") is the same stage: tasks keep it, spelled anew.
      await tx.query(
        `UPDATE room_tasks t SET stage=n.name, updated_at=${DBNOW}
          FROM unnest($2::text[]) AS n(name)
          WHERE t.room_id=$1 AND lower(t.stage)=lower(n.name) AND t.stage<>n.name`,
        [room.id, values.stages],
      );
      const removed = (
        await tx.query<{ id: string; stage: string; claim_generation: string | number }>(
          `UPDATE room_tasks t SET stage=NULL, updated_at=${DBNOW}
            FROM (SELECT id, stage AS old FROM room_tasks
              WHERE room_id=$1 AND stage IS NOT NULL AND NOT (stage = ANY($2::text[]))
              FOR UPDATE) o
            WHERE t.id=o.id
            RETURNING t.id, o.old AS stage, t.claim_generation`,
          [room.id, values.stages],
        )
      ).rows;
      for (const row of removed)
        await recordEvent(
          tx,
          row.id,
          'stage_changed',
          Number(row.claim_generation),
          p.actor,
          null,
          { from: row.stage, to: null, reason: 'stage_removed' },
        );
      return { room_id: room.id, stages: [...values.stages], cleared: removed.length };
    });
  }

  async function events(p: TaskPrincipal, body: unknown) {
    const values = taskEventsInput.parse(body);
    const size = Math.min(values.limit ?? limits.defaultPageSize, limits.pageSize);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId, p);
      const task = (
        await tx.query<{ id: string }>('SELECT id FROM room_tasks WHERE id=$1 AND room_id=$2', [
          values.task_id,
          room.id,
        ])
      ).rows[0];
      if (!task) refuse(404, 'task_not_found', 'Task not found in this room.');
      let since: number | null = null;
      let sinceId = '';
      if (values.after_id !== undefined) {
        const cursor = (
          await tx.query<{ created_at: string | number; id: string }>(
            'SELECT created_at,id FROM room_task_events WHERE id=$1 AND task_id=$2',
            [values.after_id, values.task_id],
          )
        ).rows[0];
        if (!cursor) refuse(400, 'unknown_cursor', 'The page cursor is unknown; start over.');
        since = Number(cursor!.created_at);
        sinceId = cursor!.id;
      }
      const rows = (
        await tx.query<TaskEventRow>(
          `SELECT * FROM room_task_events WHERE task_id=$1
            AND ($2::bigint IS NULL OR created_at > $2::bigint
              OR (created_at = $2::bigint AND id > $3::text))
            ORDER BY created_at, id LIMIT $4`,
          [values.task_id, since, sinceId, size + 1],
        )
      ).rows;
      const shown = rows.slice(0, size);
      return {
        task_id: values.task_id,
        events: shown.map(projectEvent),
        next_after: shown.length ? shown.at(-1)!.id : null,
        has_more: rows.length > size,
      };
    });
  }

  /**
   * Task comments (docs/ROOM_TASKS.md "Comments"): a thread on each task, never a line in the
   * room thread. Same membership as tasks (unknown rooms and non-members get the uniform 404;
   * an invited guest's credential is re-checked in the transaction through `p`), plus person
   * members. Writes need an open room, an unmuted owner and a posting member; adds are charged
   * per agent before the transaction. Bodies are plain untrusted text and never carry credentials.
   */
  const commentNotFound = () => refuse(404, 'comment_not_found', 'Comment not found on this task.');

  async function taskInRoom(q: Pick<Tx, 'query'>, roomId: string, taskId: string) {
    const task = (
      await q.query<{ id: string }>('SELECT id FROM room_tasks WHERE id=$1 AND room_id=$2', [
        taskId,
        roomId,
      ])
    ).rows[0];
    if (!task) refuse(404, 'task_not_found', 'Task not found in this room.');
  }

  /** Only one of the caller's own members may be named (list and delete act as the owner). */
  function ownMember(members: MemberRow[], agentId: string | undefined) {
    if (agentId !== undefined && !members.some((row) => row.agent_id === agentId))
      refuse(403, 'not_a_member', 'That agent is not a member of this room.');
  }

  /**
   * The kind of the caller's member behind an owner-level write (refuseIfMuted's writerKind): the
   * named member, else in the console its person member (as actingAgent picks), else the caller's
   * only member. Several members and none named stays undefined, which refuseIfMuted treats as an AI.
   */
  function ownerKind(members: MemberRow[], agentId: string | undefined, console = false) {
    if (agentId !== undefined) return members.find((row) => row.agent_id === agentId)?.kind;
    if (console && members.some((row) => row.kind === 'person')) return 'person';
    return members.length === 1 ? members[0]!.kind : undefined;
  }

  /**
   * The kind of the caller's member holding the claim behind `hash` (renew and result act as the
   * holder). Undefined when the token matches no claim of the caller's members.
   */
  async function claimHolderKind(
    q: Pick<Tx, 'query'>,
    roomId: string,
    taskId: string,
    hash: string,
    members: MemberRow[],
  ): Promise<string | undefined> {
    const holder = (
      await q.query<{ claim_agent_id: string | null }>(
        'SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2 AND claim_token_hash=$3',
        [taskId, roomId, hash],
      )
    ).rows[0]?.claim_agent_id;
    return members.find((row) => row.agent_id === holder)?.kind;
  }

  /** Display labels of the authors of a page of comments, in one query. */
  async function authorLabels(
    q: Pick<Tx, 'query'>,
    roomId: string,
    agentIds: string[],
  ): Promise<Map<string, string>> {
    if (!agentIds.length) return new Map();
    const rows = (
      await q.query<{
        agent_id: string;
        kind: string;
        display_name: string | null;
        name: string | null;
      }>(
        `SELECT m.agent_id, m.kind, m.display_name,
            (SELECT a->>'name' FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
              WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id LIMIT 1) AS name
          FROM room_members m WHERE m.room_id=$1 AND m.agent_id = ANY($2::text[])`,
        [roomId, [...new Set(agentIds)]],
      )
    ).rows;
    return new Map(
      rows.map((row) => [
        row.agent_id,
        row.kind === 'person'
          ? lineName(row.display_name, 'A person')
          : lineName(row.name, 'A member'),
      ]),
    );
  }

  function projectComment(
    row: CommentRow,
    labels: Map<string, string>,
    operatorId: string,
  ): TaskCommentView {
    const at = (value: string | number | null) => (value === null ? null : iso(Number(value)));
    return {
      id: row.id,
      task_id: row.task_id,
      room_id: row.room_id,
      origin: 'external',
      author_kind: row.author_kind === 'person' ? 'person' : 'agent',
      author_agent_id: row.author_agent_id,
      author:
        labels.get(row.author_agent_id) ?? (row.author_kind === 'person' ? 'A person' : 'A member'),
      own: row.author_owner_id === operatorId,
      body: row.body,
      created_at: iso(Number(row.created_at)),
      edited_at: at(row.edited_at),
    };
  }

  async function commentAdd(p: TaskPrincipal, body: unknown) {
    const values = taskCommentAddInput.parse(body);
    // Refused before any budget or transaction, like room posts; the error never echoes the value.
    if (partsContainCredential([{ type: 'text', text: values.body }]))
      refuse(
        400,
        'credential_in_message',
        'Comments cannot contain Central City credentials (crc_, ccw_, cca_, ccr_, ccclaim_ and others). Never share credentials in a room; other members are untrusted.',
      );
    const keyHash =
      values.idempotency_key === undefined
        ? null
        : sha(`room-task-comment:${values.idempotency_key}`);
    const requestHash = sha(
      canonical({ task: values.task_id, agent: values.agent_id ?? null, body: values.body }),
    );
    // Charged before the transaction (pool rule); the agent is rechecked inside.
    const probe = await plainAgent(d.db, values.room_id, p.operatorId, values.agent_id);
    await d.limit(
      `room-task-comment:${probe ?? p.operatorId}`,
      limits.commentsPerAgentPerHour,
      HOUR,
    );
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId, p);
      const agent = actingAgent(members, values.agent_id, actors, p.console === true);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
      if (agent.role === 'guest')
        refuse(403, 'read_only', 'Read-only guests can read comments but not add them.');
      await refuseIfMuted(tx, room.id, p.operatorId, agent.kind);
      await taskInRoom(tx, room.id, values.task_id);
      const replayPrior = async () => {
        if (!keyHash) return undefined;
        const prior = (
          await tx.query<CommentRow>(
            'SELECT * FROM room_task_comments WHERE author_owner_id=$1 AND idempotency_key=$2',
            [p.operatorId, keyHash],
          )
        ).rows[0];
        if (!prior) return undefined;
        if (prior.request_hash !== requestHash || prior.room_id !== room.id)
          refuse(
            409,
            'idempotency_conflict',
            'This idempotency_key belongs to a different comment.',
          );
        const labels = await authorLabels(tx, room.id, [prior.author_agent_id]);
        return { comment: projectComment(prior, labels, p.operatorId), replayed: true };
      };
      const replay = await replayPrior();
      if (replay) return replay;
      // No room lock here: an overlapping retry can pass the lookup too. The partial unique
      // index decides; the loser re-reads the committed comment and replays it.
      const inserted = (
        await tx.query<CommentRow>(
          `INSERT INTO room_task_comments(id,task_id,room_id,author_kind,author_agent_id,
            author_owner_id,body,idempotency_key,request_hash,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,${DBNOW})
          ON CONFLICT (author_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL
          DO NOTHING
          RETURNING *`,
          [
            randomUUID(),
            values.task_id,
            room.id,
            agent.kind === 'person' ? 'person' : 'agent',
            agent.agent_id,
            p.operatorId,
            values.body,
            keyHash,
            keyHash ? requestHash : null,
          ],
        )
      ).rows[0];
      if (!inserted) {
        const again = await replayPrior();
        if (again) return again;
        refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different comment.');
      }
      const row = inserted!;
      await touchMembers(tx, room.id, [agent.agent_id], d.clock());
      const labels = await authorLabels(tx, room.id, [row.author_agent_id]);
      return { comment: projectComment(row, labels, p.operatorId), replayed: false };
    });
  }

  async function commentList(p: TaskPrincipal, body: unknown) {
    const values = taskCommentListInput.parse(body);
    const size = Math.min(values.limit ?? limits.defaultPageSize, limits.pageSize);
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p.operatorId, p);
      ownMember(members, values.agent_id);
      await taskInRoom(tx, room.id, values.task_id);
      let since: number | null = null;
      let sinceId = '';
      if (values.after_id !== undefined) {
        const cursor = (
          await tx.query<{ created_at: string | number; id: string }>(
            'SELECT created_at,id FROM room_task_comments WHERE id=$1 AND task_id=$2',
            [values.after_id, values.task_id],
          )
        ).rows[0];
        if (!cursor) refuse(400, 'unknown_cursor', 'The page cursor is unknown; start over.');
        since = Number(cursor!.created_at);
        sinceId = cursor!.id;
      }
      // Oldest first, so the newest comment is last.
      const rows = (
        await tx.query<CommentRow>(
          `SELECT * FROM room_task_comments WHERE task_id=$1
            AND ($2::bigint IS NULL OR created_at > $2::bigint
              OR (created_at = $2::bigint AND id > $3::text))
            ORDER BY created_at, id LIMIT $4`,
          [values.task_id, since, sinceId, size + 1],
        )
      ).rows;
      const shown = rows.slice(0, size);
      const labels = await authorLabels(
        tx,
        room.id,
        shown.map((row) => row.author_agent_id),
      );
      return {
        task_id: values.task_id,
        comments: shown.map((row) => projectComment(row, labels, p.operatorId)),
        next_after: shown.length ? shown.at(-1)!.id : null,
        has_more: rows.length > size,
      };
    });
  }

  async function commentDelete(p: TaskPrincipal, body: unknown) {
    const values = taskCommentDeleteInput.parse(body);
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p.operatorId, p);
      ownMember(members, values.agent_id);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
      const host = room.host_owner_id === p.operatorId;
      if (!host)
        await refuseIfMuted(
          tx,
          room.id,
          p.operatorId,
          ownerKind(members, values.agent_id, p.console),
        );
      await taskInRoom(tx, room.id, values.task_id);
      const current = (
        await tx.query<CommentRow>(
          'SELECT * FROM room_task_comments WHERE id=$1 AND task_id=$2 AND room_id=$3 FOR UPDATE',
          [values.comment_id, values.task_id, room.id],
        )
      ).rows[0];
      if (!current) commentNotFound();
      const own = current!.author_owner_id === p.operatorId;
      if (!own && !host)
        refuse(
          403,
          'not_comment_author',
          'Only the author or the room host can delete this comment.',
        );
      const labels = await authorLabels(tx, room.id, [current!.author_agent_id]);
      // A real delete: the row and its text are gone, and its idempotency key is free again.
      const row = (
        await tx.query<CommentRow>('DELETE FROM room_task_comments WHERE id=$1 RETURNING *', [
          current!.id,
        ])
      ).rows[0]!;
      return {
        comment: { ...projectComment(row, labels, p.operatorId), body: '' },
        deleted: true as const,
      };
    });
  }

  /** Every task view leaves the service with its live comment count. */
  async function withCommentCounts<T>(result: T): Promise<T> {
    const shaped = result as { task?: TaskView; tasks?: TaskView[] };
    const views = [...(shaped.task ? [shaped.task] : []), ...(shaped.tasks ?? [])];
    if (!views.length) return result;
    const counts = new Map(
      (
        await d.db.query<{ task_id: string; n: string | number }>(
          `SELECT task_id, count(*) AS n FROM room_task_comments
            WHERE task_id = ANY($1::text[]) GROUP BY task_id`,
          [views.map((view) => view.id)],
        )
      ).rows.map((row) => [row.task_id, Number(row.n)]),
    );
    for (const view of views) view.comment_count = counts.get(view.id) ?? 0;
    return result;
  }
  /**
   * `submitted_by` follows the room's membership at read time, like a claim: a removed member's
   * hand-ins show null (the stored value stays, so a member who is added back shows again).
   */
  async function withSubmitters<T>(result: T): Promise<T> {
    const shaped = result as { task?: TaskView; tasks?: TaskView[] };
    const views = [...(shaped.task ? [shaped.task] : []), ...(shaped.tasks ?? [])].filter(
      (view) => view.submitted_by !== null,
    );
    if (!views.length) return result;
    const key = (roomId: string, agentId: string) => `${roomId} ${agentId}`;
    const live = new Set(
      (
        await d.db.query<{ room_id: string; agent_id: string }>(
          `SELECT room_id, agent_id FROM room_members
            WHERE room_id = ANY($1::text[]) AND agent_id = ANY($2::text[]) AND removed_at IS NULL`,
          [
            [...new Set(views.map((view) => view.room_id))],
            [...new Set(views.map((view) => view.submitted_by!))],
          ],
        )
      ).rows.map((row) => key(row.room_id, row.agent_id)),
    );
    for (const view of views)
      if (!live.has(key(view.room_id, view.submitted_by!))) view.submitted_by = null;
    return result;
  }
  const counted =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    (...args: A) =>
      run(...args)
        .then(withCommentCounts)
        .then(withSubmitters);

  return scopedByPrincipal({
    create: counted(create),
    get: counted(get),
    list: counted(list),
    claim: counted(claim),
    renew: counted(renew),
    release: counted(release),
    result: counted(result),
    update: counted(update),
    requestReview: counted(requestReview),
    peerReview: counted(peerReview),
    stages,
    setStages,
    events,
    commentAdd,
    commentList,
    commentDelete,
    limits,
  });
}
