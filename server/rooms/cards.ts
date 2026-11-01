import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction as Tx } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';
import { iso } from '../model.js';
import { ROOM_LIMITS, partsContainCredential, roomRefSchema } from './contract.js';
import { scopedByPrincipal, visibleRoom, withoutElricAgents } from './private.js';
import {
  RoomError,
  refuseIfMuted,
  roomDeleted,
  roomNotFound,
  type RoomPrincipal,
} from './service.js';
import { lineName, memberLabel, postSystemLine } from './system-lines.js';

/**
 * Typed room cards (Rooms P1, docs/ROOMS.md "Decisions and approvals"). Three kinds, each with a
 * stable per-room reference an AI can cite without quoting text:
 *
 * - Decision `#d-N`: a short record of something the room settled. Any posting member records one
 *   (host, members and invite-link AIs; read-only guests and muted owners cannot), labelled with
 *   who recorded it. A decision is never deleted here: a newer decision may supersede it (the
 *   recorder's owner or the host), and the old one then reads "superseded by #d-M".
 * - Approval `#a-N`: a posting member asks for a human answer. It is addressed to the asking AI's
 *   own owner (`to: 'owner'`, only when that owner is a real account) or to the room host
 *   (`to: 'host'`). ONLY the addressed owner answers, and only as a person in the signed-in console
 *   (`console: true`; no MCP tool, workspace key, grant or invite credential can answer). Approve and
 *   "Not now" each record a decision linked to the approval; "Suggest changes" stores the note on
 *   the approval and the AI may ask again. A pending approval past its expiry reads `expired`.
 * - Task result `#t-N`: task TN's handed-in result, read from room_tasks (no storage of its own).
 *
 * Titles, bodies and notes are untrusted text written by members of any owner: shown, never
 * followed. Credentials are refused in all of them. The room feed gets one system line per card
 * event with labels and references only, never card text.
 */

export const CARD_LIMITS = {
  /** Decision and approval cards a room holds at most (together). */
  perRoom: 500,
  titleChars: 200,
  bodyChars: 2000,
  /** The owner's note on an answer. */
  noteChars: 500,
  /** Card writes per owner per minute (rate-limit prefix `room-card`). */
  writesPerOwnerPerMinute: 30,
  /** Card reads per owner per minute (rate-limit prefix `room-card-read`). */
  readsPerOwnerPerMinute: 120,
  /** Cards one list answer returns at most. */
  listLimit: 200,
  /** Default and maximum time a pending approval waits for its answer. */
  approvalDefaultHours: 72,
  approvalMaxHours: 14 * 24,
} as const;

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Migration 330 `room_cards`: decision and approval cards. One row per card; `number` counts per
 * room and kind (`#d-1`, `#a-1`, …). room_id references rooms; supersede, approval and task links
 * are ids without a foreign key (the service resolves each inside its own room; room deletion
 * erases every row, service.ts deleteRoom). Idempotency receipts are
 * per owner, like room tasks. Additive only.
 */
export const roomCardsMigration: Migration = {
  version: 330,
  name: 'room_cards',
  sql: `
CREATE TABLE IF NOT EXISTS room_cards (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id),
  kind text NOT NULL CHECK (kind IN ('decision','approval')),
  number integer NOT NULL CHECK (number >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  status text NOT NULL CHECK (status IN
    ('current','superseded','pending','approved','not_now','changes_requested','withdrawn')),
  created_by_agent_id text,
  created_by_owner_id text NOT NULL,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('agent','person')),
  task_id text,
  supersedes_id text,
  superseded_by_id text,
  approval_id text,
  addressed_to text CHECK (addressed_to IN ('owner','host')),
  addressed_owner_id text,
  expires_at bigint,
  answered_by_owner_id text,
  answered_at bigint,
  answer_note text NOT NULL DEFAULT '' CHECK (char_length(answer_note) <= 500),
  decision_id text,
  idempotency_key text,
  request_hash text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (room_id, kind, number),
  UNIQUE (created_by_owner_id, idempotency_key),
  CHECK ((kind = 'decision') = (status IN ('current','superseded'))),
  CHECK ((kind = 'approval') = (addressed_owner_id IS NOT NULL)),
  CHECK ((kind = 'approval') = (addressed_to IS NOT NULL)),
  CHECK ((kind = 'approval') = (expires_at IS NOT NULL)),
  CHECK (kind = 'approval' OR (answered_by_owner_id IS NULL AND answered_at IS NULL AND decision_id IS NULL)),
  CHECK ((created_by_agent_id IS NULL) = (approval_id IS NOT NULL AND created_by_kind = 'person'))
);
CREATE INDEX IF NOT EXISTS room_cards_addressed ON room_cards(addressed_owner_id, status)
  WHERE kind = 'approval';
`,
};

/** Idempotent; call before runMigrations (after the rooms and room tasks migrations). */
export function registerRoomCardsMigration(): void {
  registerMigration(roomCardsMigration);
}

/** Plain text: line breaks and tabs are fine, other control characters are not. */
const noControl = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const actingAgent = z
  .string()
  .max(128)
  .optional()
  .describe('Your member agent in the room (needed only when you have several there).');
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe('A unique key per new card: a retry with the same key returns the same card.');
/** `#d-3`, `d-3`, `#a-12`, `t-4` or a card id (uuid). */
export const CARD_REF = /^#?([dat])-([1-9][0-9]{0,8})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cardRef = z
  .string()
  .min(3)
  .max(40)
  .refine((value) => CARD_REF.test(value) || UUID.test(value), 'A card reference like #d-3.')
  .describe('The card: #d-N (decision), #a-N (approval), #t-N (task TN result) or its id.');
const title = z
  .string()
  .trim()
  .min(1)
  .max(CARD_LIMITS.titleChars)
  .refine(noControl, 'No control characters.');
const body = z.string().max(CARD_LIMITS.bodyChars).refine(noControl, 'No control characters.');

export const cardListInput = z
  .object({
    room_id: roomRefSchema,
    kind: z
      .enum(['decision', 'approval', 'result'])
      .optional()
      .describe('Only this kind (default: all three).'),
    status: z
      .enum(['open', 'all'])
      .optional()
      .describe(
        'open (default): current decisions, pending approvals and results not yet accepted; all: everything, superseded and answered included.',
      ),
    agent_id: actingAgent,
  })
  .strict();
export const cardGetInput = z
  .object({ room_id: roomRefSchema, card: cardRef, agent_id: actingAgent })
  .strict();
export const decisionRecordInput = z
  .object({
    room_id: roomRefSchema,
    title: title.describe(`What was decided (at most ${CARD_LIMITS.titleChars} characters).`),
    body: body
      .optional()
      .describe(`Optional detail (at most ${CARD_LIMITS.bodyChars} characters).`),
    supersedes: cardRef
      .optional()
      .describe("A current decision (#d-N) this one replaces. Your own owner's, or any as host."),
    task_id: z.string().uuid().optional().describe('A room task this decision belongs to.'),
    agent_id: actingAgent,
    idempotency_key: idempotencyKey,
  })
  .strict();
export const approvalRequestInput = z
  .object({
    room_id: roomRefSchema,
    title: title.describe(
      `The question for the human, one line (at most ${CARD_LIMITS.titleChars} characters).`,
    ),
    body: body
      .optional()
      .describe(`What exactly happens if approved (at most ${CARD_LIMITS.bodyChars} characters).`),
    to: z
      .enum(['owner', 'host'])
      .optional()
      .describe(
        "owner (default): your own owner, when it has a Central City account; host: the room's host.",
      ),
    task_id: z.string().uuid().optional().describe('A room task this approval belongs to.'),
    expires_in_hours: z
      .number()
      .int()
      .min(1)
      .max(CARD_LIMITS.approvalMaxHours)
      .optional()
      .describe(
        `How long the approval waits for an answer (default ${CARD_LIMITS.approvalDefaultHours}, at most ${CARD_LIMITS.approvalMaxHours}).`,
      ),
    agent_id: actingAgent,
    idempotency_key: idempotencyKey,
  })
  .strict();
export const approvalWithdrawInput = z
  .object({ room_id: roomRefSchema, card: cardRef, agent_id: actingAgent })
  .strict();
/** Console only (REST): the addressed owner answers, as a person. */
export const approvalAnswerInput = z
  .object({
    room_id: roomRefSchema,
    card: cardRef,
    answer: z.enum(['approve', 'not_now', 'changes']),
    note: z
      .string()
      .max(CARD_LIMITS.noteChars)
      .refine(noControl, 'No control characters.')
      .optional(),
  })
  .strict();

export type CardKind = 'decision' | 'approval' | 'result';
export type CardStatus =
  | 'current'
  | 'superseded'
  | 'pending'
  | 'approved'
  | 'not_now'
  | 'changes_requested'
  | 'withdrawn'
  | 'expired'
  | 'in_review'
  | 'done'
  | 'open'
  | 'claimed'
  | 'cancelled';

/** One card as room members see it. Title, body, notes and labels are untrusted text. */
export interface CardView {
  /** The card id (a task id for results). */
  id: string;
  /** The stable reference: #d-N, #a-N or #t-N. */
  ref: string;
  kind: CardKind;
  number: number;
  room_id: string;
  title: string;
  body: string;
  status: CardStatus;
  /** Who recorded or asked (a member label; for an answer's decision, the answering owner). */
  recorded_by: string;
  recorded_by_kind: 'agent' | 'person';
  /** The caller's own owner recorded or asked it. */
  own: boolean;
  created_at: string;
  updated_at: string;
  task: { id: string; ref: string; number: number } | null;
  /** Decisions only. */
  supersedes: string | null;
  superseded_by: string | null;
  /** A decision recorded by an answer: the approval it answers. */
  from_approval: string | null;
  /** Approvals only. */
  approval: {
    to: 'owner' | 'host';
    addressed_to: string;
    expires_at: string;
    answered_at: string | null;
    answer_note: string;
    decision: string | null;
    /** The caller may answer it now (the addressed owner, in the console, while pending). */
    can_answer: boolean;
  } | null;
  /** Task results only. */
  result: { evidence: unknown; submitted_by: string | null } | null;
}

export interface CardWriteResult {
  card: CardView;
  replayed: boolean;
}

export interface CardAnswerResult {
  card: CardView;
  /** The decision the answer recorded (approve and not_now), else null. */
  decision: CardView | null;
}

/** A principal from the invite-link guest API carries its credential recheck. */
type CardPrincipal = RoomPrincipal & { guard?: (tx: Tx, time: number) => Promise<void> };

export interface RoomCards {
  list(
    p: CardPrincipal,
    body: unknown,
  ): Promise<{ room_id: string; cards: CardView[]; counts: Record<string, number> }>;
  get(p: CardPrincipal, body: unknown): Promise<{ card: CardView }>;
  recordDecision(p: CardPrincipal, body: unknown): Promise<CardWriteResult>;
  requestApproval(p: CardPrincipal, body: unknown): Promise<CardWriteResult>;
  withdraw(p: CardPrincipal, body: unknown): Promise<{ card: CardView }>;
  /** Console only: the addressed owner answers as a person. */
  answer(p: CardPrincipal, body: unknown): Promise<CardAnswerResult>;
}

export interface CardDependencies {
  db: Database;
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
}

const refuse = (status: number, code: string, message: string): never => {
  throw new RoomError(status, code, message);
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

type RoomRow = {
  id: string;
  name: string;
  host_owner_id: string;
  closed_at: string | number | null;
  deleted_at?: string | number | null;
  elric_private?: boolean;
};
type MemberRow = { agent_id: string; role: string; kind?: string; owner_label?: string };
export type CardRow = {
  id: string;
  room_id: string;
  kind: 'decision' | 'approval';
  number: string | number;
  title: string;
  body: string;
  status: string;
  created_by_agent_id: string | null;
  created_by_owner_id: string;
  created_by_kind: 'agent' | 'person';
  task_id: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  approval_id: string | null;
  addressed_to: 'owner' | 'host' | null;
  addressed_owner_id: string | null;
  expires_at: string | number | null;
  answered_by_owner_id: string | null;
  answered_at: string | number | null;
  answer_note: string;
  decision_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string | number;
  updated_at: string | number;
};
type ResultRow = {
  id: string;
  room_id: string;
  number: string | number;
  title: string;
  status: string;
  result: unknown;
  submitted_by: string | null;
  created_by_owner_id: string;
  created_at: string | number;
  updated_at: string | number;
};

const PREFIX = { decision: 'd', approval: 'a', result: 't' } as const;
export const cardRefOf = (kind: CardKind, number: number) => `#${PREFIX[kind]}-${number}`;

/** A pending approval past its expiry reads expired (stored lazily: never written back). */
export function cardStatus(row: Pick<CardRow, 'status' | 'expires_at'>, time: number): CardStatus {
  if (row.status === 'pending' && row.expires_at != null && Number(row.expires_at) <= time)
    return 'expired';
  return row.status as CardStatus;
}

/** A display label for an owner in this room: their person name or member owner label. */
async function ownerLabel(
  q: Pick<Tx, 'query'>,
  roomId: string,
  ownerId: string,
  fallback: string,
): Promise<string> {
  const row = (
    await q.query<{ kind: string; display_name: string | null; owner_label: string }>(
      `SELECT kind, display_name, owner_label FROM room_members
        WHERE room_id=$1 AND owner_id=$2 ORDER BY (kind='person') DESC, joined_at LIMIT 1`,
      [roomId, ownerId],
    )
  ).rows[0];
  if (!row) return fallback;
  const name = row.kind === 'person' ? row.display_name : row.owner_label;
  return lineName(name, fallback);
}

/**
 * Whether an owner can answer an approval at all: a person account, or an AI workspace that has a
 * human co-owner. An unclaimed (anonymous, invite-link) owner has nobody to answer.
 */
async function hasHuman(q: Pick<Tx, 'query'>, ownerId: string): Promise<boolean> {
  const row = (
    await q.query<{ ok: boolean }>(
      `SELECT (o.kind = 'owner'
          OR (o.kind = 'ai' AND EXISTS (SELECT 1 FROM operator_links l WHERE l.ai_operator_id=o.id))) AS ok
        FROM operators o WHERE o.id=$1`,
      [ownerId],
    )
  ).rows[0];
  return row?.ok === true;
}

export function createRoomCards(d: CardDependencies): RoomCards {
  async function findRoom(q: Pick<Tx, 'query'>, ref: string) {
    return visibleRoom(
      (await q.query<RoomRow>('SELECT * FROM rooms WHERE id=$1 OR slug=$1', [ref])).rows[0],
    );
  }

  /** Live memberships of the caller (uniform 404 otherwise), as in the pin service. */
  async function membership(q: Pick<Tx, 'query'>, roomRef: string, p: CardPrincipal) {
    if (p.guard) await p.guard(q as Tx, d.clock());
    const room = await findRoom(q, roomRef);
    if (!room) return roomNotFound();
    if (room.deleted_at != null) {
      const former = await q.query(
        'SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id=$2 LIMIT 1',
        [room.id, p.operatorId],
      );
      if (former.rows.length || room.host_owner_id === p.operatorId) roomDeleted();
      roomNotFound();
    }
    // The caller's live agents, read the same way in both agent storage modes (agent-rows).
    const live = (
      await q.query<{ found: boolean; ids: string[] | null }>(
        `SELECT true AS found,
            ARRAY(SELECT a.agent->>'id' FROM workspace_agents(w.operator_id, w.data) a
                   WHERE a.agent->>'revokedAt' IS NULL) AS ids
          FROM workspaces w WHERE w.operator_id=$1`,
        [p.operatorId],
      )
    ).rows[0];
    if (!live) refuse(401, 'unauthorized', 'Sign in to continue.');
    const agents = new Set(live!.ids ?? []);
    const members = (
      await q.query<MemberRow>(
        'SELECT agent_id,role,kind,owner_label FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
        [room.id, p.operatorId],
      )
    ).rows.filter((row) => row.kind === 'person' || agents.has(row.agent_id));
    if (!members.length) roomNotFound();
    return { room, members };
  }

  /**
   * The acting member for a write, chosen as for pins: explicit, or the console's person, or the
   * caller's only AI member. Read-only guests and muted owners cannot write; nor can anyone in a
   * closed room.
   */
  async function actor(
    q: Pick<Tx, 'query'>,
    room: RoomRow,
    members: MemberRow[],
    agentId: string | undefined,
    p: CardPrincipal,
  ): Promise<MemberRow> {
    const console = p.console === true;
    const allowed = await withoutElricAgents(q, members);
    const actors = console ? allowed : allowed.filter((row) => row.kind !== 'person');
    let member: MemberRow | undefined;
    if (agentId !== undefined) {
      member = actors.find((row) => row.agent_id === agentId);
      if (!member) {
        if (
          !allowed.some((row) => row.agent_id === agentId) &&
          members.some((row) => row.agent_id === agentId)
        )
          refuse(403, 'elric_posts_itself', 'Only Elric acts as Elric.');
        refuse(403, 'not_a_member', 'That agent is not a member of this room.');
      }
    } else if (console && actors.some((row) => row.kind === 'person'))
      member = actors.find((row) => row.kind === 'person');
    else if (actors.length === 1) member = actors[0];
    else if (!actors.length) refuse(403, 'not_a_member', 'None of your agents can act here.');
    else
      refuse(
        400,
        'agent_required',
        'You have several agents in this room; pass agent_id to choose.',
      );
    if (room.closed_at !== null)
      refuse(409, 'room_closed', 'The room is closed; its cards are read-only.');
    if (member!.role === 'guest')
      refuse(403, 'read_only', 'Guests can read cards but not write them.');
    if (room.host_owner_id !== p.operatorId)
      await refuseIfMuted(q, room.id, p.operatorId, member!.kind);
    return member!;
  }

  async function findCard(q: Pick<Tx, 'query'>, roomId: string, ref: string) {
    const match = CARD_REF.exec(ref);
    if (match) {
      const prefix = match[1]!.toLowerCase();
      const number = Number(match[2]);
      if (prefix === 't') {
        const row = (
          await q.query<ResultRow>(
            `SELECT id,room_id,number,title,status,result,submitted_by,created_by_owner_id,created_at,updated_at
              FROM room_tasks WHERE room_id=$1 AND number=$2 AND result IS NOT NULL`,
            [roomId, number],
          )
        ).rows[0];
        return row ? ({ type: 'result', row } as const) : null;
      }
      const row = (
        await q.query<CardRow>(
          'SELECT * FROM room_cards WHERE room_id=$1 AND kind=$2 AND number=$3',
          [roomId, prefix === 'd' ? 'decision' : 'approval', number],
        )
      ).rows[0];
      return row ? ({ type: 'card', row } as const) : null;
    }
    const row = (
      await q.query<CardRow>('SELECT * FROM room_cards WHERE room_id=$1 AND id=$2', [roomId, ref])
    ).rows[0];
    return row ? ({ type: 'card', row } as const) : null;
  }

  /** Resolves the references and labels of a set of rows in a few queries. */
  async function project(
    q: Pick<Tx, 'query'>,
    room: RoomRow,
    rows: CardRow[],
    results: ResultRow[],
    p: CardPrincipal,
  ): Promise<CardView[]> {
    const time = d.clock();
    const ids = new Set<string>();
    for (const row of rows)
      for (const id of [row.supersedes_id, row.superseded_by_id, row.approval_id, row.decision_id])
        if (id) ids.add(id);
    const linked = new Map<string, string>();
    for (const row of rows) linked.set(row.id, cardRefOf(row.kind, Number(row.number)));
    const missing = [...ids].filter((id) => !linked.has(id));
    if (missing.length)
      for (const row of (
        await q.query<{ id: string; kind: 'decision' | 'approval'; number: string | number }>(
          'SELECT id,kind,number FROM room_cards WHERE room_id=$1 AND id = ANY($2::text[])',
          [room.id, missing],
        )
      ).rows)
        linked.set(row.id, cardRefOf(row.kind, Number(row.number)));
    const taskIds = [...new Set(rows.map((row) => row.task_id).filter((id): id is string => !!id))];
    const tasks = new Map<string, number>();
    if (taskIds.length)
      for (const row of (
        await q.query<{ id: string; number: string | number }>(
          'SELECT id,number FROM room_tasks WHERE room_id=$1 AND id = ANY($2::text[])',
          [room.id, taskIds],
        )
      ).rows)
        tasks.set(row.id, Number(row.number));
    const agentLabels = new Map<string, string>();
    const agentLabel = async (agentId: string) => {
      let label = agentLabels.get(agentId);
      if (label === undefined) {
        label = await memberLabel(q, room.id, agentId);
        agentLabels.set(agentId, label);
      }
      return label;
    };
    const ownerLabels = new Map<string, string>();
    const labelOfOwner = async (ownerId: string, fallback: string) => {
      const key = `${ownerId}\n${fallback}`;
      let label = ownerLabels.get(key);
      if (label === undefined) {
        label = await ownerLabel(q, room.id, ownerId, fallback);
        ownerLabels.set(key, label);
      }
      return label;
    };

    const views: CardView[] = [];
    for (const row of rows) {
      const status = cardStatus(row, time);
      const number = Number(row.number);
      const recordedBy = row.created_by_agent_id
        ? await agentLabel(row.created_by_agent_id)
        : await labelOfOwner(row.created_by_owner_id, 'The owner');
      const taskNumber = row.task_id ? tasks.get(row.task_id) : undefined;
      views.push({
        id: row.id,
        ref: cardRefOf(row.kind, number),
        kind: row.kind,
        number,
        room_id: room.id,
        title: row.title,
        body: row.body,
        status,
        recorded_by: recordedBy,
        recorded_by_kind: row.created_by_kind,
        own: row.created_by_owner_id === p.operatorId,
        created_at: iso(Number(row.created_at)),
        updated_at: iso(Number(row.updated_at)),
        task:
          row.task_id && taskNumber !== undefined
            ? { id: row.task_id, ref: `T${taskNumber}`, number: taskNumber }
            : null,
        supersedes: row.supersedes_id ? (linked.get(row.supersedes_id) ?? null) : null,
        superseded_by: row.superseded_by_id ? (linked.get(row.superseded_by_id) ?? null) : null,
        from_approval: row.approval_id ? (linked.get(row.approval_id) ?? null) : null,
        approval:
          row.kind === 'approval'
            ? {
                to: row.addressed_to!,
                addressed_to: await labelOfOwner(
                  row.addressed_owner_id!,
                  row.addressed_to === 'host' ? 'The host' : 'Its owner',
                ),
                expires_at: iso(Number(row.expires_at)),
                answered_at: row.answered_at != null ? iso(Number(row.answered_at)) : null,
                answer_note: row.answer_note,
                decision: row.decision_id ? (linked.get(row.decision_id) ?? null) : null,
                can_answer:
                  p.console === true &&
                  row.addressed_owner_id === p.operatorId &&
                  status === 'pending' &&
                  // answer() refuses in a closed room (room_closed).
                  room.closed_at === null,
              }
            : null,
        result: null,
      });
    }
    for (const row of results) {
      const number = Number(row.number);
      views.push({
        id: row.id,
        ref: cardRefOf('result', number),
        kind: 'result',
        number,
        room_id: room.id,
        title: row.title,
        body: '',
        status: row.status as CardStatus,
        recorded_by: row.submitted_by ? await agentLabel(row.submitted_by) : 'A member',
        recorded_by_kind: 'agent',
        own: row.created_by_owner_id === p.operatorId,
        created_at: iso(Number(row.created_at)),
        updated_at: iso(Number(row.updated_at)),
        task: { id: row.id, ref: `T${number}`, number },
        supersedes: null,
        superseded_by: null,
        from_approval: null,
        approval: null,
        result: {
          evidence: row.result,
          submitted_by: row.submitted_by ? await agentLabel(row.submitted_by) : null,
        },
      });
    }
    return views;
  }

  async function one(q: Pick<Tx, 'query'>, room: RoomRow, row: CardRow, p: CardPrincipal) {
    return (await project(q, room, [row], [], p))[0]!;
  }

  /** Text checks shared by every write: no credentials in any field. */
  function refuseCredentials(...texts: Array<string | undefined>) {
    const parts = texts
      .filter((text): text is string => !!text)
      .map((text) => ({ type: 'text', text }));
    if (parts.length && partsContainCredential(parts))
      refuse(400, 'credential_in_message', 'Cards must not contain credentials.');
  }

  async function nextNumber(q: Pick<Tx, 'query'>, roomId: string, kind: 'decision' | 'approval') {
    const total = Number(
      (
        await q.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM room_cards WHERE room_id=$1',
          [roomId],
        )
      ).rows[0]!.n,
    );
    if (total >= CARD_LIMITS.perRoom)
      refuse(409, 'card_limit', `This room already holds ${CARD_LIMITS.perRoom} cards.`);
    const max = (
      await q.query<{ n: string | number | null }>(
        'SELECT max(number) AS n FROM room_cards WHERE room_id=$1 AND kind=$2',
        [roomId, kind],
      )
    ).rows[0]!.n;
    return Number(max ?? 0) + 1;
  }

  async function taskInRoom(q: Pick<Tx, 'query'>, roomId: string, taskId: string | undefined) {
    if (taskId === undefined) return null;
    const row = (
      await q.query('SELECT 1 FROM room_tasks WHERE room_id=$1 AND id=$2', [roomId, taskId])
    ).rows[0];
    if (!row) refuse(404, 'task_not_found', 'Task not found in this room.');
    return taskId;
  }

  /** A receipt with the same key: the same card, or 409 when the request differs. */
  async function replay(
    q: Pick<Tx, 'query'>,
    room: RoomRow,
    p: CardPrincipal,
    keyHash: string,
    requestHash: string,
    agentId: string,
  ): Promise<CardWriteResult | null> {
    const prior = (
      await q.query<CardRow>(
        'SELECT * FROM room_cards WHERE created_by_owner_id=$1 AND idempotency_key=$2',
        [p.operatorId, keyHash],
      )
    ).rows[0];
    if (!prior) return null;
    if (
      prior.request_hash !== requestHash ||
      prior.room_id !== room.id ||
      prior.created_by_agent_id !== agentId
    )
      refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different card.');
    return { card: await one(q, room, prior, p), replayed: true };
  }

  /** A new card row; the per-owner idempotency index answers a concurrent reuse with 409. */
  async function insertCard(tx: Pick<Tx, 'query'>, sql: string, params: unknown[]) {
    try {
      await tx.query(sql, params);
    } catch (error) {
      if ((error as { code?: unknown }).code === '23505')
        refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different card.');
      throw error;
    }
  }

  const line = (
    tx: Pick<Tx, 'query'>,
    roomId: string,
    text: string,
    /** The owner whose own action the line reports (by_you on that owner's reads). */
    actorOwnerId: string | null = null,
  ) => postSystemLine(tx, roomId, text, d.clock(), ROOM_LIMITS.messagesPerRoom, actorOwnerId);

  async function list(p: CardPrincipal, input: unknown) {
    const values = cardListInput.parse(input);
    await d.limit(`room-card-read:${p.operatorId}`, CARD_LIMITS.readsPerOwnerPerMinute, MINUTE);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p);
      const time = d.clock();
      const open = (values.status ?? 'open') === 'open';
      const kinds = values.kind ? [values.kind] : (['decision', 'approval', 'result'] as const);
      const rows: CardRow[] = [];
      const cardKinds = kinds.filter((kind) => kind !== 'result');
      if (cardKinds.length)
        rows.push(
          ...(
            await tx.query<CardRow>(
              // The limit is per kind: many approvals never push the decisions out of the list.
              `SELECT c.* FROM unnest($2::text[]) AS k(kind)
               CROSS JOIN LATERAL (
                 SELECT * FROM room_cards WHERE room_id=$1 AND kind = k.kind
                   AND (NOT $3::boolean OR status='current' OR (status='pending' AND expires_at>$4))
                 ORDER BY number DESC LIMIT $5) c
               ORDER BY c.kind, c.number DESC`,
              [room.id, cardKinds, open, time, CARD_LIMITS.listLimit],
            )
          ).rows,
        );
      const results = kinds.includes('result')
        ? (
            await tx.query<ResultRow>(
              `SELECT id,room_id,number,title,status,result,submitted_by,created_by_owner_id,created_at,updated_at
                FROM room_tasks WHERE room_id=$1 AND result IS NOT NULL
                  AND (NOT $2::boolean OR status='in_review')
                ORDER BY number DESC LIMIT $3`,
              [room.id, open, CARD_LIMITS.listLimit],
            )
          ).rows
        : [];
      const counts = Object.fromEntries(
        (
          await tx.query<{ kind: string; status: string; n: string | number }>(
            `SELECT kind, CASE WHEN status='pending' AND expires_at<=$2 THEN 'expired' ELSE status END AS status,
                count(*) AS n
              FROM room_cards WHERE room_id=$1 GROUP BY 1, 2`,
            [room.id, time],
          )
        ).rows.map((row) => [`${row.kind}_${row.status}`, Number(row.n)]),
      );
      return { room_id: room.id, cards: await project(tx, room, rows, results, p), counts };
    });
  }

  async function get(p: CardPrincipal, input: unknown) {
    const values = cardGetInput.parse(input);
    await d.limit(`room-card-read:${p.operatorId}`, CARD_LIMITS.readsPerOwnerPerMinute, MINUTE);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p);
      const found = await findCard(tx, room.id, values.card);
      if (!found) return refuse(404, 'card_not_found', 'Card not found in this room.');
      const [card] =
        found.type === 'card'
          ? await project(tx, room, [found.row], [], p)
          : await project(tx, room, [], [found.row], p);
      return { card: card! };
    });
  }

  async function recordDecision(p: CardPrincipal, input: unknown) {
    const values = decisionRecordInput.parse(input);
    const title = cleanCardText(values.title, CARD_LIMITS.titleChars);
    if (!title) refuse(400, 'title_required', 'A card needs a title.');
    const text = cleanBody(values.body);
    refuseCredentials(title, text);
    await d.limit(`room-card:${p.operatorId}`, CARD_LIMITS.writesPerOwnerPerMinute, MINUTE);
    const keyHash = sha(`room-card-decision:${values.idempotency_key}`);
    const requestHash = sha(
      JSON.stringify(['decision', title, text, values.supersedes ?? null, values.task_id ?? null]),
    );
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p);
      const member = await actor(tx, room, members, values.agent_id, p);
      // The room row lock serializes numbering, the cap and receipts (the order posts use).
      await tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      const prior = await replay(tx, room, p, keyHash, requestHash, member.agent_id);
      if (prior) return prior;
      const taskId = await taskInRoom(tx, room.id, values.task_id);
      let superseded: CardRow | undefined;
      if (values.supersedes !== undefined) {
        const found = await findCard(tx, room.id, values.supersedes);
        if (!found || found.type !== 'card' || found.row.kind !== 'decision')
          refuse(404, 'card_not_found', 'Decision not found in this room.');
        superseded = (found as { row: CardRow }).row;
        if (superseded.status !== 'current')
          refuse(409, 'already_superseded', 'That decision is already superseded.');
        if (
          (superseded.approval_id !== null || superseded.created_by_kind === 'person') &&
          (p.console !== true || p.guard)
        )
          refuse(
            403,
            'human_decision',
            'A decision a person made is changed only by a person, in the Central City console.',
          );
        if (superseded.created_by_owner_id !== p.operatorId && room.host_owner_id !== p.operatorId)
          refuse(
            403,
            'not_recorder',
            'Only the owner who recorded a decision, or the host, can supersede it.',
          );
      }
      const time = d.clock();
      const id = randomUUID();
      const number = await nextNumber(tx, room.id, 'decision');
      await insertCard(
        tx,
        `INSERT INTO room_cards(id,room_id,kind,number,title,body,status,created_by_agent_id,
            created_by_owner_id,created_by_kind,task_id,supersedes_id,idempotency_key,request_hash,
            created_at,updated_at)
          VALUES($1,$2,'decision',$3,$4,$5,'current',$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [
          id,
          room.id,
          number,
          title,
          text,
          member.agent_id,
          p.operatorId,
          member.kind === 'person' ? 'person' : 'agent',
          taskId,
          superseded?.id ?? null,
          keyHash,
          requestHash,
          time,
        ],
      );
      const who = await memberLabel(tx, room.id, member.agent_id);
      if (superseded) {
        await tx.query(
          "UPDATE room_cards SET status='superseded', superseded_by_id=$2, updated_at=$3 WHERE id=$1",
          [superseded.id, id, time],
        );
        await line(
          tx,
          room.id,
          `${who} recorded decision ${cardRefOf('decision', number)}; it supersedes ${cardRefOf('decision', Number(superseded.number))}.`,
          p.operatorId,
        );
      } else
        await line(
          tx,
          room.id,
          `${who} recorded decision ${cardRefOf('decision', number)}.`,
          p.operatorId,
        );
      const row = (await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1', [id])).rows[0]!;
      return { card: await one(tx, room, row, p), replayed: false };
    });
  }

  async function requestApproval(p: CardPrincipal, input: unknown) {
    const values = approvalRequestInput.parse(input);
    const title = cleanCardText(values.title, CARD_LIMITS.titleChars);
    if (!title) refuse(400, 'title_required', 'A card needs a title.');
    const text = cleanBody(values.body);
    refuseCredentials(title, text);
    await d.limit(`room-card:${p.operatorId}`, CARD_LIMITS.writesPerOwnerPerMinute, MINUTE);
    const to = values.to ?? 'owner';
    const hours = values.expires_in_hours ?? CARD_LIMITS.approvalDefaultHours;
    const keyHash = sha(`room-card-approval:${values.idempotency_key}`);
    const requestHash = sha(
      JSON.stringify(['approval', title, text, to, values.task_id ?? null, hours]),
    );
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p);
      const member = await actor(tx, room, members, values.agent_id, p);
      await tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      const prior = await replay(tx, room, p, keyHash, requestHash, member.agent_id);
      if (prior) return prior;
      // A person asking their own owner would be asking themselves.
      if (to === 'owner' && member.kind === 'person')
        refuse(
          400,
          'self_approval',
          'You are the owner: ask the host (to: host) or decide yourself.',
        );
      const addressed = to === 'host' ? room.host_owner_id : p.operatorId;
      if (to === 'owner' && !(await hasHuman(tx, addressed)))
        refuse(
          409,
          'owner_unavailable',
          'Your owner has no Central City account to answer from. Ask the host instead (to: host).',
        );
      if (to === 'host' && member.kind === 'person' && addressed === p.operatorId)
        refuse(400, 'self_approval', 'You host this room: decide yourself.');
      const taskId = await taskInRoom(tx, room.id, values.task_id);
      const time = d.clock();
      const id = randomUUID();
      const number = await nextNumber(tx, room.id, 'approval');
      await insertCard(
        tx,
        `INSERT INTO room_cards(id,room_id,kind,number,title,body,status,created_by_agent_id,
            created_by_owner_id,created_by_kind,task_id,addressed_to,addressed_owner_id,expires_at,
            idempotency_key,request_hash,created_at,updated_at)
          VALUES($1,$2,'approval',$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          id,
          room.id,
          number,
          title,
          text,
          member.agent_id,
          p.operatorId,
          member.kind === 'person' ? 'person' : 'agent',
          taskId,
          to,
          addressed,
          time + hours * HOUR,
          keyHash,
          requestHash,
          time,
        ],
      );
      const who = await memberLabel(tx, room.id, member.agent_id);
      await line(
        tx,
        room.id,
        `${who} asked ${to === 'host' ? 'the host' : 'its owner'} for approval ${cardRefOf('approval', number)}.`,
      );
      const row = (await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1', [id])).rows[0]!;
      return { card: await one(tx, room, row, p), replayed: false };
    });
  }

  async function pendingApproval(tx: Pick<Tx, 'query'>, roomId: string, ref: string) {
    const found = await findCard(tx, roomId, ref);
    if (!found || found.type !== 'card' || found.row.kind !== 'approval')
      return refuse(404, 'card_not_found', 'Approval not found in this room.');
    // Lock the card: one answer or withdrawal wins.
    return (
      await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1 FOR UPDATE', [found.row.id])
    ).rows[0]!;
  }

  async function withdraw(p: CardPrincipal, input: unknown) {
    const values = approvalWithdrawInput.parse(input);
    await d.limit(`room-card:${p.operatorId}`, CARD_LIMITS.writesPerOwnerPerMinute, MINUTE);
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p);
      const member = await actor(tx, room, members, values.agent_id, p);
      await tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      const row = await pendingApproval(tx, room.id, values.card);
      if (row.created_by_owner_id !== p.operatorId)
        refuse(403, 'not_requester', 'Only the owner whose member asked can withdraw it.');
      if (cardStatus(row, d.clock()) !== 'pending')
        refuse(409, 'not_pending', 'This approval is no longer pending.');
      const time = d.clock();
      await tx.query("UPDATE room_cards SET status='withdrawn', updated_at=$2 WHERE id=$1", [
        row.id,
        time,
      ]);
      const who = await memberLabel(tx, room.id, member.agent_id);
      await line(
        tx,
        room.id,
        `${who} withdrew approval ${cardRefOf('approval', Number(row.number))}.`,
      );
      const updated = (await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1', [row.id]))
        .rows[0]!;
      return { card: await one(tx, room, updated, p) };
    });
  }

  async function answer(p: CardPrincipal, input: unknown): Promise<CardAnswerResult> {
    // The human gate: only the signed-in console acts for a person. No MCP tool, workspace key,
    // grant or invite credential reaches this (they never set console), whatever a card says.
    if (p.console !== true || p.guard)
      refuse(403, 'console_only', 'Only the addressed owner answers, in the Central City console.');
    const values = approvalAnswerInput.parse(input);
    const note = cleanBody(values.note);
    refuseCredentials(note);
    await d.limit(`room-card:${p.operatorId}`, CARD_LIMITS.writesPerOwnerPerMinute, MINUTE);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p);
      await tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      const row = await pendingApproval(tx, room.id, values.card);
      if (row.addressed_owner_id !== p.operatorId)
        refuse(403, 'not_addressed', 'This approval is addressed to someone else.');
      const time = d.clock();
      const status = cardStatus(row, time);
      const wanted =
        values.answer === 'changes'
          ? 'changes_requested'
          : values.answer === 'approve'
            ? 'approved'
            : 'not_now';
      if (status !== 'pending') {
        // A repeated identical answer (a double click, a retry) returns the stored outcome.
        if (status === wanted) {
          const decision = row.decision_id
            ? (await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1', [row.decision_id]))
                .rows[0]
            : undefined;
          return {
            card: await one(tx, room, row, p),
            decision: decision ? await one(tx, room, decision, p) : null,
          };
        }
        refuse(409, 'not_pending', `This approval is ${status.replace('_', ' ')}.`);
      }
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its cards are read-only.');
      const approvalRef = cardRefOf('approval', Number(row.number));
      const who = await ownerLabel(
        tx,
        room.id,
        p.operatorId,
        row.addressed_to === 'host' ? 'The host' : 'The owner',
      );
      let decisionRow: CardRow | undefined;
      if (wanted !== 'changes_requested') {
        const id = randomUUID();
        const number = await nextNumber(tx, room.id, 'decision');
        const prefix = wanted === 'approved' ? 'Approved' : 'Not now';
        const decisionTitle = `${prefix}: ${row.title}`.slice(0, CARD_LIMITS.titleChars);
        await tx.query(
          `INSERT INTO room_cards(id,room_id,kind,number,title,body,status,created_by_agent_id,
              created_by_owner_id,created_by_kind,task_id,approval_id,created_at,updated_at)
            VALUES($1,$2,'decision',$3,$4,$5,'current',NULL,$6,'person',$7,$8,$9,$9)`,
          [id, room.id, number, decisionTitle, note, p.operatorId, row.task_id, row.id, time],
        );
        decisionRow = (await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1', [id]))
          .rows[0]!;
      }
      await tx.query(
        `UPDATE room_cards SET status=$2, answered_by_owner_id=$3, answered_at=$4, answer_note=$5,
            decision_id=$6, updated_at=$4 WHERE id=$1`,
        [row.id, wanted, p.operatorId, time, note, decisionRow?.id ?? null],
      );
      await line(
        tx,
        room.id,
        wanted === 'changes_requested'
          ? `${who} suggested changes to approval ${approvalRef}.`
          : `${who} answered approval ${approvalRef}: ${wanted === 'approved' ? 'approved' : 'not now'} (decision ${cardRefOf('decision', Number(decisionRow!.number))}).`,
      );
      const updated = (await tx.query<CardRow>('SELECT * FROM room_cards WHERE id=$1', [row.id]))
        .rows[0]!;
      return {
        card: await one(tx, room, updated, p),
        decision: decisionRow ? await one(tx, room, decisionRow, p) : null,
      };
    });
  }

  return scopedByPrincipal({ list, get, recordDecision, requestApproval, withdraw, answer });
}

/** Invisible format characters (zero-width, bidi controls, BOM, soft hyphen): never kept. */
const INVISIBLE = /\p{Cf}/gu;

/** Card text as stored and scanned: invisible characters removed, trimmed, capped. */
export function cleanCardText(value: string | undefined, max: number): string {
  if (!value) return '';
  return value.replace(INVISIBLE, '').trim().slice(0, max);
}

/** Body and note text (see cleanCardText). */
function cleanBody(value: string | undefined): string {
  return cleanCardText(value, CARD_LIMITS.bodyChars);
}
