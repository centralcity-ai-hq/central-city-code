import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { hasPermission, iso, type StoredAgent, type Workspace } from '../model.js';
import { messageDelivered } from '../wake/hooks.js';
import { feedEnabled } from '../feed/flag.js';
import {
  HIDES_PER_MINUTE,
  MESSAGE_LIMITS,
  RECIPIENT_CAP,
  UNREAD_CAP,
  type AgentMessage,
  type ConversationSummary,
  type DirectParty,
  type DirectRecipient,
  type DirectThread,
  type InboxAck,
  type InboxPage,
  type InboxSummary,
  type InboxSummaryPage,
  type MessagePart,
} from './contract.js';
import { authorizeRoomPair, roomMemberNames, type RoomPair } from './room-direct.js';

/**
 * Agent messaging v0 (docs/MESSAGING.md). Every operation runs in one short transaction that
 * never locks the owner's workspace row: the workspace document is read with a plain MVCC
 * snapshot (agents, pause state, connections), and the only rows locked are the recipient's
 * inbox cursor (sequence allocation) and the sender's idempotency receipt.
 */

/**
 * How many inbox depths a person's cursor span may reach. Read messages above an old unread one
 * do not count toward its capacity, but the scans walk them, so the span is capped.
 */
export const PERSON_SPAN_DEPTHS = 4;

/** Error with an HTTP status and a stable machine-readable code (surfaced as `code`). */
export class MessagingError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string, retryAfterMs?: number): never => {
  throw new MessagingError(status, code, message, retryAfterMs);
};

/** Who is acting. `runtimeCredentialHash` binds a runtime caller to its current credential. */
export interface MessagingPrincipal {
  operatorId: string;
  /** The owner console (a signed-in person): the only principal that may write as a person member. */
  console?: boolean;
  runtime?: { agentId: string; credentialHash: string };
}
/** Extra authority check run first inside the operation's transaction (e.g. the current grant). */
export type Guard = (tx: Tx, time: number) => Promise<void>;
export interface SendInput {
  to_agent_id: string;
  text?: string;
  parts?: MessagePart[];
  context_id?: string;
  reply_to?: string;
  /** A private message to a member of this room (room-direct.ts), authorized by shared membership. */
  room_id?: string;
  idempotency_key: string;
}
export interface InboxQuery {
  since?: number;
  before?: number;
  limit?: number;
  /** Without since/before: 'acked' continues after the acknowledged seq, 'latest' shows the newest page. */
  start: 'acked' | 'latest';
}
export interface MessagingDependencies {
  db: Database;
  clock: () => number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  inboxDepth?: number;
  sendsPerMinute?: number;
  /** Cross-owner sends per (sender, recipient) pair per minute (F4 §5; default 30). */
  crossPairPerMinute?: number;
  /** Inbound cross-owner sends per recipient owner per minute (F4 §5; default 600). */
  crossInboundPerMinute?: number;
}
export interface Messaging {
  send(
    principal: MessagingPrincipal,
    senderId: string,
    input: SendInput,
    guard?: Guard,
  ): Promise<{ message: AgentMessage }>;
  readInbox(
    principal: MessagingPrincipal,
    agentId: string,
    query: InboxQuery,
    guard?: Guard,
  ): Promise<InboxPage>;
  ack(
    principal: MessagingPrincipal,
    agentId: string,
    seq: number,
    guard?: Guard,
  ): Promise<InboxAck>;
  /**
   * The one private thread between `fromId` (the caller's member) and `toId` in room `roomRef`,
   * created if new, after the same checks as a send. Lets the console open the thread before the
   * first message.
   */
  openDirect(
    principal: MessagingPrincipal,
    roomRef: string,
    /** Default: the caller's person in the room, else its earliest-joined AI there. */
    fromId: string | undefined,
    toId: string,
  ): Promise<DirectThread>;
  /**
   * The console read a thread: acknowledges its people's inboxes in a private room thread and
   * records the owner's read of it (conversation_reads), so it is no longer unread (readDirect).
   */
  readDirect(principal: MessagingPrincipal, contextId: string): Promise<{ acked: InboxAck[] }>;
  /** "Delete conversation": hides the thread from this owner's Messages until a newer message. */
  hideConversation(
    principal: MessagingPrincipal,
    contextId: string,
  ): Promise<{ context_id: string; hidden_at: string }>;
  /** Members of the caller's rooms it can message privately (the console's New message). */
  recipients(operatorId: string): Promise<{ recipients: DirectRecipient[] }>;
  summary(operatorId: string): Promise<InboxSummaryPage>;
  conversations(
    operatorId: string,
    limit?: number,
    /** Only threads this own member takes part in; others' ids match nothing. */
    agentId?: string,
  ): Promise<{ conversations: ConversationSummary[] }>;
  conversation(
    operatorId: string,
    contextId: string,
    options?: { before?: string; limit?: number },
  ): Promise<{
    context_id: string;
    messages: AgentMessage[];
    has_more: boolean;
    next_before: string | null;
  }>;
}

type MessageRow = {
  /** 'external' for cross-owner messages (F4); absent on rows written before migration 12. */
  origin?: 'internal' | 'external';
  sender_owner_label?: string | null;
  recipient_id: string;
  seq: number | string;
  id: string;
  sender_id: string;
  context_id: string;
  reply_to: string | null;
  kind: 'message';
  parts: MessagePart[];
  created_at: number | string;
  /** Migration 63: the room that authorized a private message between its members. */
  room_id?: string | null;
  sender_owner_id?: string;
  recipient_owner_id?: string;
};
const COLUMNS =
  'recipient_id,seq,id,sender_id,context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id,sender_owner_id,recipient_owner_id';
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

/**
 * The two agents of a pair in a fixed order, the key of their stored default conversation
 * (`pair_contexts`, migration 19). The default id itself is random: it cannot be derived from the
 * public agent ids, so no one outside the pair can name, probe or pre-claim it.
 */
export function pairKey(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}
/** Latest messages of each inbox searched for the pair's current conversation (a bounded PK range). */
const PAIR_LOOKBACK = 1000;
/**
 * Newest sent rows of an owner searched for threads it only sent into (the conversation list).
 * Threads the owner received in are always found; a thread with no reply whose last send is older
 * than these rows is listed again when it gets a reply or a new send.
 */
export const CONVERSATION_SEND_SCAN = 2000;

/**
 * The id #61 (reverted) gave a pair's default conversation: an RFC 4122 version 5 UUID over the
 * sorted public agent ids, which anyone could compute. It is never issued any more. It is only
 * recognized, so that an agent that remembered it lands in its pair's stored conversation instead
 * of recreating a thread under it, and so scripts/remediate-pair-contexts.ts can find old rows.
 */
const LEGACY_PAIR_NAMESPACE = 'b6f1c1e2-3d4a-5b6c-8d9e-0f1a2b3c4d5e';
export function legacyPairContextId(first: string, second: string): string {
  const [low, high] = pairKey(first, second);
  const bytes = createHash('sha1')
    .update(Buffer.from(LEGACY_PAIR_NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`agent-pair:${low}:${high}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createMessaging(d: MessagingDependencies): Messaging {
  const depth = d.inboxDepth ?? MESSAGE_LIMITS.inboxDepth;
  // A person's cursor stops below its first message still unread in any thread, so read messages
  // pile up above it. They do not count toward its capacity (heldFor), but every capacity, ack and
  // unread scan walks them from the cursor, so the span itself stays capped at a few depths.
  const personSpan = depth * PERSON_SPAN_DEPTHS;
  const perMinute = d.sendsPerMinute ?? MESSAGE_LIMITS.sendsPerMinute;
  const crossPair = d.crossPairPerMinute ?? 30;
  const crossInbound = d.crossInboundPerMinute ?? 600;

  /** Unlocked snapshot read: never holds the owner's workspace row lock. */
  async function workspaceOf(tx: Tx, operatorId: string): Promise<Workspace> {
    const row = (
      await tx.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0];
    if (!row) fail(401, 'unauthorized', 'Sign in to continue.');
    return row!.data;
  }
  async function runtimeCurrent(tx: Tx, principal: MessagingPrincipal): Promise<void> {
    if (!principal.runtime) return;
    const current = await tx.query(
      'SELECT agent_id FROM credentials WHERE agent_id=$1 AND operator_id=$2 AND token_hash=$3',
      [principal.runtime.agentId, principal.operatorId, principal.runtime.credentialHash],
    );
    if (!current.rows.length) fail(401, 'unauthorized', 'Invalid runtime credential.');
  }
  function ownAgent(workspace: Workspace, id: string, role: string): StoredAgent {
    return (
      workspace.agents.find((agent) => agent.id === id) ??
      fail(404, 'agent_not_found', `${role} agent not found in this workspace.`)
    );
  }
  function project(row: MessageRow, names: Map<string, string>): AgentMessage {
    const external = row.origin === 'external';
    return {
      origin: external ? 'external' : 'internal',
      from_owner_label: external ? (row.sender_owner_label ?? null) : null,
      id: row.id,
      seq: Number(row.seq),
      kind: 'message',
      from_agent_id: row.sender_id,
      from_agent_name: names.get(row.sender_id) ?? 'Unknown agent',
      to_agent_id: row.recipient_id,
      to_agent_name: names.get(row.recipient_id) ?? 'Unknown agent',
      context_id: row.context_id,
      reply_to: row.reply_to,
      parts: row.parts,
      created_at: iso(Number(row.created_at)),
      room_id: row.room_id ?? null,
    };
  }
  const namesOf = (workspace: Workspace) =>
    new Map(workspace.agents.map((agent) => [agent.id, agent.name]));
  /**
   * Names for projection: this workspace's agents, plus peers in other workspaces that this one
   * is (or was) connected with by an accepted cross-workspace connection. Never other agents.
   */
  async function namesFor(
    tx: Tx,
    operatorId: string,
    workspace: Workspace,
    ids: Iterable<string>,
  ): Promise<Map<string, string>> {
    const names = namesOf(workspace);
    const missing = [...new Set(ids)].filter((id) => !names.has(id));
    if (!missing.length) return names;
    const rows = (
      await tx.query<{ id: string; name: string }>(
        `SELECT DISTINCT a->>'id' AS id, a->>'name' AS name FROM cross_connections c
          JOIN workspaces w ON w.operator_id = CASE WHEN c.to_owner_id=$1 THEN c.from_owner_id ELSE c.to_owner_id END
          CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
          WHERE c.status IN ('approved','revoked') AND (
            (c.to_owner_id=$1 AND a->>'id'=c.from_agent_id) OR
            (c.from_owner_id=$1 AND a->>'id'=c.to_agent_id))
          AND a->>'id' = ANY($2::text[])`,
        [operatorId, missing],
      )
    ).rows;
    for (const row of rows) names.set(row.id, row.name);
    // Private messages between room members: the other member's room name (room-direct.ts).
    const still = missing.filter((id) => !names.has(id));
    for (const [id, entry] of await roomMemberNames(tx, still)) names.set(id, entry.name);
    return names;
  }
  async function cursorOf(tx: Tx, agentId: string, lock = false) {
    const row = (
      await tx.query<{ next_seq: number | string; acked_seq: number | string }>(
        `SELECT next_seq,acked_seq FROM inbox_cursors WHERE agent_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [agentId],
      )
    ).rows[0];
    const latest = row ? Number(row.next_seq) - 1 : 0;
    const acked = row ? Number(row.acked_seq) : 0;
    return { latest, acked, unread: latest - acked };
  }
  async function replay(
    tx: Tx,
    receipt: { request_hash: string; recipient_id: string; seq: number | string },
    requestHash: string,
    workspace: Workspace,
    operatorId: string,
  ) {
    if (receipt.request_hash !== requestHash)
      fail(409, 'idempotency_conflict', 'This idempotency key belongs to a different message.');
    const row = (
      await tx.query<MessageRow>(
        `SELECT ${COLUMNS} FROM messages WHERE recipient_id=$1 AND seq=$2`,
        [receipt.recipient_id, receipt.seq],
      )
    ).rows[0];
    if (!row) fail(410, 'message_expired', 'The original message is no longer retained.');
    const names = await namesFor(tx, operatorId, workspace, [row!.sender_id, row!.recipient_id]);
    return { message: project(row!, names) };
  }

  /**
   * The room a send is a private room message of (its room_id, or the room of the private message
   * it answers with reply_to alone), when the caller's own active member `senderId` and the
   * recipient are both active in it; else null. Plain reads before the transaction, used only to
   * decide which budget to charge; the transaction authorizes again.
   */
  async function roomOfSend(
    operatorId: string,
    senderId: string,
    input: SendInput,
  ): Promise<string | null> {
    let ref = input.room_id;
    if (ref === undefined && input.reply_to && input.context_id === undefined)
      ref =
        (
          await d.db.query<{ room_id: string | null }>(
            'SELECT room_id FROM messages WHERE id=$1 AND recipient_id=$2 AND room_id IS NOT NULL LIMIT 1',
            [input.reply_to, senderId],
          )
        ).rows[0]?.room_id ?? undefined;
    if (ref === undefined) return null;
    const row = (
      await d.db.query<{ id: string }>(
        `SELECT r.id FROM rooms r
          JOIN room_members s ON s.room_id=r.id AND s.agent_id=$2 AND s.owner_id=$3 AND s.removed_at IS NULL
          JOIN room_members t ON t.room_id=r.id AND t.agent_id=$4 AND t.removed_at IS NULL
          WHERE r.id=$1 OR r.slug=$1 LIMIT 1`,
        [ref, senderId, operatorId, input.to_agent_id],
      )
    ).rows[0];
    return row?.id ?? null;
  }

  /**
   * The console read a private room thread: acknowledges the inbox of each of the viewer's
   * PEOPLE that received messages in it, past every message read, up to the first one still unread
   * in another thread (personAckLimit; acks only move forward, like city_ack_inbox). A person has
   * no other way to acknowledge, so without this a person's inbox would fill up (remote_quota, then
   * inbox_full). AIs keep acknowledging their own inbox.
   */
  async function readDirect(
    principal: MessagingPrincipal,
    contextId: string,
  ): Promise<{ acked: InboxAck[] }> {
    if (!principal.console) fail(403, 'forbidden', 'Only the console marks a private thread read.');
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      const rows = (
        await tx.query<{ recipient_id: string; seq: number | string }>(
          `SELECT m.recipient_id, max(m.seq) AS seq FROM messages m
            WHERE m.context_id=$1 AND m.recipient_owner_id=$2 AND m.room_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM room_members p WHERE p.agent_id=m.recipient_id
                AND p.owner_id=$2 AND p.kind='person')
            GROUP BY m.recipient_id`,
          [contextId, principal.operatorId],
        )
      ).rows;
      // The thread read first, so the ack below stops only at messages unread in other threads.
      await markThreadRead(tx, principal.operatorId, contextId);
      const acked: InboxAck[] = [];
      for (const row of rows) {
        const cursor = await cursorOf(tx, row.recipient_id, true);
        const seq = await personAckLimit(tx, row.recipient_id, principal.operatorId, cursor);
        if (seq > cursor.acked)
          await tx.query('UPDATE inbox_cursors SET acked_seq=$2, updated_at=$3 WHERE agent_id=$1', [
            row.recipient_id,
            seq,
            time,
          ]);
        acked.push({
          agent_id: row.recipient_id,
          acked_seq: seq,
          latest_seq: cursor.latest,
          unread: cursor.latest - seq,
        });
      }
      return { acked };
    });
  }

  /**
   * The owner read the thread, whichever of its members received it: messages up to the newest
   * one it holds are no longer unread for the owner (conversation_reads). An AI's own inbox cursor
   * stays where it is, so the AI still receives them.
   */
  async function markThreadRead(tx: Tx, ownerId: string, contextId: string) {
    await tx.query(
      `INSERT INTO conversation_reads(owner_id,context_id,read_at)
       SELECT $1, $2, newest.created_at FROM (SELECT m.created_at FROM messages m
        WHERE m.recipient_owner_id=$1 AND m.context_id=$2
        ORDER BY m.created_at DESC LIMIT 1) newest
       ON CONFLICT (owner_id,context_id)
       DO UPDATE SET read_at=GREATEST(conversation_reads.read_at, EXCLUDED.read_at)`,
      [ownerId, contextId],
    );
  }

  /**
   * How far a person's single inbox cursor moves when the console reads or answers a thread: past
   * every message the owner has read (this thread's, and other threads' read before), but never
   * past one still unread for the owner in another thread (unreadFor), since the unread counts
   * start at the cursor. Bounded by the person's span cap (personSpan).
   */
  async function personAckLimit(
    tx: Tx,
    personId: string,
    ownerId: string,
    cursor: { acked: number; latest: number },
  ): Promise<number> {
    const blocking = (
      await tx.query<{ seq: number | string | null }>(
        `SELECT min(m.seq) AS seq FROM messages m WHERE m.recipient_id=$1 AND m.seq > $3
           AND m.seq <= $4 AND m.recipient_owner_id=$2 AND ${unreadFor('$2')}`,
        [personId, ownerId, cursor.acked, cursor.latest],
      )
    ).rows[0]?.seq;
    return blocking === null || blocking === undefined ? cursor.latest : Number(blocking) - 1;
  }

  /** The pair's one stored thread (pair_contexts, migration 19), created once on first use. */
  async function pairThread(tx: Tx, first: string, second: string, time: number) {
    const [low, high] = pairKey(first, second);
    return (
      (
        await tx.query<{ context_id: string }>(
          `INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES($1,$2,$3,$4)
           ON CONFLICT (low_id,high_id) DO NOTHING RETURNING context_id`,
          [low, high, randomUUID(), time],
        )
      ).rows[0]?.context_id ??
      (
        await tx.query<{ context_id: string }>(
          'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
          [low, high],
        )
      ).rows[0]!.context_id
    );
  }

  async function openDirect(
    principal: MessagingPrincipal,
    roomRef: string,
    fromId: string | undefined,
    toId: string,
  ): Promise<DirectThread> {
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      await runtimeCurrent(tx, principal);
      fromId ??=
        (
          await tx.query<{ agent_id: string }>(
            `SELECT m.agent_id FROM room_members m JOIN rooms r ON r.id=m.room_id
              WHERE (r.id=$1 OR r.slug=$1) AND m.owner_id=$2 AND m.removed_at IS NULL
                AND ($3::boolean OR m.kind <> 'person') AND m.agent_id <> $4
              ORDER BY (m.kind='person') DESC, m.joined_at, m.agent_id LIMIT 1`,
            [roomRef, principal.operatorId, principal.console === true, toId],
          )
        ).rows[0]?.agent_id ?? principal.runtime?.agentId;
      if (!fromId) {
        // The recipient is the caller's only member in the room: say so instead of a 404.
        const onlyOwn = await tx.query(
          `SELECT 1 FROM room_members m JOIN rooms r ON r.id=m.room_id
            WHERE (r.id=$1 OR r.slug=$1) AND m.owner_id=$2 AND m.agent_id=$3 AND m.removed_at IS NULL`,
          [roomRef, principal.operatorId, toId],
        );
        if (onlyOwn.rows.length)
          fail(
            409,
            'no_other_member',
            'This AI is your only member in this room. Join the room as yourself, or add another of your AIs, to message it privately.',
          );
        fail(404, 'room_not_found', 'Room not found, or you are not a member of it.');
      }
      if (principal.runtime && principal.runtime.agentId !== fromId)
        fail(403, 'forbidden', 'A runtime may only write as its own agent.');
      const pair = await authorizeRoomPair(tx, {
        operatorId: principal.operatorId,
        roomRef,
        fromId: fromId!,
        toId,
        console: principal.console === true,
      });
      return {
        context_id: await pairThread(tx, pair.from.id, pair.to.id, time),
        room_id: pair.room.id,
        room_name: pair.room.name,
        self: {
          id: pair.from.id,
          name: pair.from.name,
          kind: pair.from.kind,
          owner_label: pair.from.ownerLabel,
          is_self: true,
          own: true,
        },
        peer: {
          id: pair.to.id,
          name: pair.to.name,
          kind: pair.to.kind,
          owner_label: pair.to.ownerLabel,
          is_self: false,
          own: pair.sameOwner,
        },
      };
    });
  }

  /**
   * A private message between two members of one room (room-direct.ts): authorized by shared
   * membership instead of a connection, always in the pair's one thread, delivered into the
   * recipient's inbox like any cross-owner message (origin external, the sender's owner label).
   */
  async function sendInRoom(
    tx: Tx,
    time: number,
    principal: MessagingPrincipal,
    workspace: Workspace,
    senderId: string,
    roomRef: string,
    input: SendInput,
    parts: MessagePart[],
    requestHash: string,
  ): Promise<{ message: AgentMessage }> {
    if (input.context_id !== undefined)
      fail(
        400,
        'invalid_arguments',
        'A private room message always continues the one thread of the pair; omit context_id.',
      );
    const pair: RoomPair = await authorizeRoomPair(tx, {
      operatorId: principal.operatorId,
      roomRef,
      fromId: senderId,
      toId: input.to_agent_id,
      console: principal.console === true,
    });
    const prior = (
      await tx.query<{ request_hash: string; recipient_id: string; seq: number | string }>(
        'SELECT request_hash,recipient_id,seq FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
        [senderId, input.idempotency_key],
      )
    ).rows[0];
    if (prior) return replay(tx, prior, requestHash, workspace, principal.operatorId);
    const { from, to } = pair;
    if (input.reply_to) {
      const original = (
        await tx.query(
          'SELECT 1 FROM messages WHERE id=$1 AND (recipient_id=$2 OR sender_id=$2) LIMIT 1',
          [input.reply_to, from.id],
        )
      ).rows[0];
      if (!original)
        fail(404, 'reply_not_found', 'reply_to must name a message this member sent or received.');
    }
    const messageId = randomUUID();
    const claimed = await tx.query(
      `INSERT INTO message_receipts(sender_id,idempotency_key,request_hash,message_id,recipient_id,seq,created_at)
       VALUES($1,$2,$3,$4,$5,0,$6) ON CONFLICT (sender_id,idempotency_key) DO NOTHING RETURNING message_id`,
      [from.id, input.idempotency_key, requestHash, messageId, to.id, time],
    );
    if (!claimed.rows.length) {
      const receipt = (
        await tx.query<{ request_hash: string; recipient_id: string; seq: number | string }>(
          'SELECT request_hash,recipient_id,seq FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
          [from.id, input.idempotency_key],
        )
      ).rows[0]!;
      return replay(tx, receipt, requestHash, workspace, principal.operatorId);
    }
    const contextId = await pairThread(tx, from.id, to.id, time);
    // A person's cursor stops below the first message still unread in any thread (personAckLimit),
    // so messages read above it are not held: for a person, quota and depth count only the
    // messages its owner has not read yet in the console (heldFor), under the cursor row's lock.
    // The span above the cursor stays capped (personSpan), which bounds these scans.
    const person = to.kind === 'person';
    if (person) {
      await tx.query(
        'INSERT INTO inbox_cursors(agent_id,next_seq,acked_seq,updated_at) VALUES($1,1,0,$2) ON CONFLICT (agent_id) DO NOTHING',
        [to.id, time],
      );
      await cursorOf(tx, to.id, true);
    }
    const held = person ? ` AND m.recipient_owner_id=$3 AND ${heldFor('$3')}` : '';
    // The sender's owner may hold at most a quarter of the recipient's unacknowledged capacity.
    const quota = Math.max(1, Math.floor(depth / 4));
    const pending = Number(
      (
        await tx.query<{ n: number | string }>(
          `SELECT count(*) AS n FROM messages m WHERE m.recipient_id=$1 AND m.sender_owner_id=$2
            AND m.seq > COALESCE((SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1),0)${held}`,
          person ? [to.id, principal.operatorId, to.ownerId] : [to.id, principal.operatorId],
        )
      ).rows[0]?.n ?? 0,
    );
    if (pending >= quota)
      fail(
        429,
        'remote_quota',
        `${to.name}'s inbox already holds ${quota} unacknowledged messages from you; retry after it reads some.`,
        30_000,
      );
    if (person) {
      const total = Number(
        (
          await tx.query<{ n: number | string }>(
            `SELECT count(*) AS n FROM (SELECT 1 FROM messages m WHERE m.recipient_id=$1
              AND m.seq > COALESCE((SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1),0)
              AND m.recipient_owner_id=$2 AND ${heldFor('$2')} ORDER BY m.seq LIMIT $3) x`,
            [to.id, to.ownerId, depth],
          )
        ).rows[0]?.n ?? 0,
      );
      if (total >= depth)
        fail(
          429,
          'inbox_full',
          `${to.name}'s inbox holds ${depth} unacknowledged messages; retry after it acknowledges some.`,
          30_000,
        );
    } else
      await tx.query(
        'INSERT INTO inbox_cursors(agent_id,next_seq,acked_seq,updated_at) VALUES($1,1,0,$2) ON CONFLICT (agent_id) DO NOTHING',
        [to.id, time],
      );
    const allocated = (
      await tx.query<{ seq: number | string }>(
        `UPDATE inbox_cursors SET next_seq=next_seq+1, updated_at=$2
         WHERE agent_id=$1 AND next_seq-1-acked_seq < $3 RETURNING next_seq-1 AS seq`,
        [to.id, time, person ? personSpan : depth],
      )
    ).rows[0];
    if (!allocated)
      fail(
        429,
        'inbox_full',
        person
          ? `${to.name}'s inbox holds ${personSpan} messages since its oldest unread one; retry after it reads that conversation.`
          : `${to.name}'s inbox holds ${depth} unacknowledged messages; retry after it acknowledges some.`,
        30_000,
      );
    const seq = Number(allocated!.seq);
    const row = (
      await tx.query<MessageRow>(
        `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,reply_to,kind,parts,created_at,origin,sender_owner_label,room_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'message',$9::jsonb,$10,$13,$11,$12) RETURNING ${COLUMNS}`,
        [
          to.id,
          seq,
          messageId,
          from.id,
          from.ownerId,
          to.ownerId,
          contextId,
          input.reply_to ?? null,
          JSON.stringify(parts),
          time,
          // Between two of the caller's own members (its person and its AI) the message is
          // internal: no owner label, like a message along a workspace connection.
          pair.sameOwner ? null : from.ownerLabel,
          pair.room.id,
          pair.sameOwner ? 'internal' : 'external',
        ],
      )
    ).rows[0]!;
    await tx.query('UPDATE message_receipts SET seq=$3 WHERE sender_id=$1 AND idempotency_key=$2', [
      from.id,
      input.idempotency_key,
      seq,
    ]);
    // A person replying in the console marks the thread read for the sender: its inbox cursor moves past the newest
    // message of this thread it holds, like the console's thread read (readDirect) and the
    // inbox ack. The scan starts at the cursor, so it is bounded by the unread depth. Only a
    // person: an AI's cursor is its runtime's, so a console reply sent as the AI leaves it put.
    const replied =
      !principal.console || from.kind !== 'person'
        ? undefined
        : (
            await tx.query<{ seq: number | string }>(
              `SELECT m.seq FROM messages m WHERE m.recipient_id=$1 AND m.context_id=$2
            AND m.seq > COALESCE((SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1),0)
          ORDER BY m.seq DESC LIMIT 1`,
              [from.id, contextId],
            )
          ).rows[0];
    if (replied) {
      // Answering reads the thread; the cursor stops at messages still unread in other threads.
      await markThreadRead(tx, from.ownerId, contextId);
      const cursor = await cursorOf(tx, from.id, true);
      const seq = await personAckLimit(tx, from.id, from.ownerId, cursor);
      if (seq > cursor.acked)
        await tx.query('UPDATE inbox_cursors SET acked_seq=$2, updated_at=$3 WHERE agent_id=$1', [
          from.id,
          seq,
          time,
        ]);
    }
    // An AI recipient is woken like for any direct message (inbox long-poll, @mention, webhook),
    // unless it muted this room's notifications. A person reads it in the console's Messages.
    if (to.kind === 'agent')
      await messageDelivered(tx, {
        recipientId: to.id,
        recipientName: to.name,
        recipientOwnerId: to.ownerId,
        senderId: from.id,
        senderName: from.name,
        senderOwnerLabel: from.ownerLabel,
        messageId,
        seq,
        contextId,
        parts,
        time,
        quiet: pair.quiet,
      });
    const names = new Map([
      [from.id, from.name],
      [to.id, to.name],
    ]);
    return { message: project(row, names) };
  }

  async function send(
    principal: MessagingPrincipal,
    senderId: string,
    input: SendInput,
    guard?: Guard,
  ): Promise<{ message: AgentMessage }> {
    if (principal.runtime && principal.runtime.agentId !== senderId)
      fail(403, 'forbidden', 'A runtime may only send as its own agent.');
    const parts: MessagePart[] =
      input.parts ?? (input.text !== undefined ? [{ type: 'text', text: input.text }] : []);
    if (!parts.length) fail(400, 'invalid_arguments', 'Pass exactly one of text or parts.');
    if (Buffer.byteLength(JSON.stringify(parts)) > MESSAGE_LIMITS.totalBytes)
      fail(413, 'message_too_large', `Messages are limited to ${MESSAGE_LIMITS.totalBytes} bytes.`);
    const requestHash = sha(
      canonical({
        to: input.to_agent_id,
        parts,
        context_id: input.context_id,
        reply_to: input.reply_to,
        room_id: input.room_id,
      }),
    );
    // Only new messages spend the sender's budget. The limiter runs before the transaction:
    // the hosted limiter needs its own pool connection, and acquiring one while a transaction
    // holds another can starve the small serverless pool. A plain read decides whether this is a
    // replay; replays are still answered, with full authorization, inside the transaction below.
    const known = await d.db.query(
      'SELECT 1 FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
      [senderId, input.idempotency_key],
    );
    if (input.room_id !== undefined && input.context_id !== undefined)
      fail(
        400,
        'invalid_arguments',
        'A private room message always continues the one thread of the pair; omit context_id.',
      );
    if (!known.rows.length) {
      await d.limit(`msg-send:${principal.operatorId}:${senderId}`, perMinute, 60_000);
      // Private room messages (also replies that only name reply_to): the same per-pair budget
      // as cross-owner sends (F4 §5), charged only once plain reads show the caller owns the
      // sending member and both are active in that room, so nobody can burn another pair's budget.
      const room = await roomOfSend(principal.operatorId, senderId, input);
      if (room) {
        const [low, high] = pairKey(senderId, input.to_agent_id);
        await d.limit(`room-dm-pair:${low}:${high}`, crossPair, 60_000);
      }
      // Cross-owner budgets (F4 §5), also charged before the transaction. Plain reads decide
      // whether the recipient is another owner's agent along an approved connection.
      const own = (
        await d.db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
          principal.operatorId,
        ])
      ).rows[0]?.data;
      if (own && !own.agents.some((agent) => agent.id === input.to_agent_id)) {
        const link = (
          await d.db.query<{ to_owner_id: string }>(
            "SELECT to_owner_id FROM cross_connections WHERE from_owner_id=$1 AND from_agent_id=$2 AND to_agent_id=$3 AND status='approved' LIMIT 1",
            [principal.operatorId, senderId, input.to_agent_id],
          )
        ).rows[0];
        if (link) {
          await d.limit(`xsend-pair:${senderId}:${input.to_agent_id}`, crossPair, 60_000);
          await d.limit(`xsend-in:${link.to_owner_id}`, crossInbound, 60_000);
        }
      }
    }
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      await runtimeCurrent(tx, principal);
      const workspace = await workspaceOf(tx, principal.operatorId);
      // A reply to a private room message stays a private room message of that room.
      let roomRef = input.room_id;
      if (roomRef === undefined && input.reply_to && input.context_id === undefined)
        roomRef =
          (
            await tx.query<{ room_id: string | null }>(
              'SELECT room_id FROM messages WHERE id=$1 AND recipient_id=$2 AND room_id IS NOT NULL LIMIT 1',
              [input.reply_to, senderId],
            )
          ).rows[0]?.room_id ?? undefined;
      if (roomRef !== undefined)
        return sendInRoom(
          tx,
          time,
          principal,
          workspace,
          senderId,
          roomRef,
          input,
          parts,
          requestHash,
        );
      const sender = ownAgent(workspace, senderId, 'Sending');
      // A replay of an accepted send returns the original message before any other check, so
      // retries stay idempotent even if the connection or agents changed since, and cost no budget.
      const prior = (
        await tx.query<{ request_hash: string; recipient_id: string; seq: number | string }>(
          'SELECT request_hash,recipient_id,seq FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
          [sender.id, input.idempotency_key],
        )
      ).rows[0];
      if (prior) return replay(tx, prior, requestHash, workspace, principal.operatorId);
      let recipient = workspace.agents.find((agent) => agent.id === input.to_agent_id);
      let recipientOwner = principal.operatorId;
      let recipientWorkspace = workspace;
      let senderLabel: string | null = null;
      if (!recipient) {
        // Another owner's agent only along an APPROVED cross-owner connection (F4), checked here
        // inside the send transaction; a connection revoked mid-flight fails the next send.
        const link = (
          await tx.query<{ to_operator_id: string; from_owner_label: string }>(
            "SELECT to_owner_id AS to_operator_id, from_owner_label FROM cross_connections WHERE from_owner_id=$1 AND from_agent_id=$2 AND to_agent_id=$3 AND status='approved' LIMIT 1",
            [principal.operatorId, sender.id, input.to_agent_id],
          )
        ).rows[0];
        if (link) {
          senderLabel = link.from_owner_label;
          const other = (
            await tx.query<{ data: Workspace }>(
              'SELECT data FROM workspaces WHERE operator_id=$1',
              [link.to_operator_id],
            )
          ).rows[0]?.data;
          const found = other?.agents.find((agent) => agent.id === input.to_agent_id);
          if (other && found) {
            recipient = found;
            recipientOwner = link.to_operator_id;
            recipientWorkspace = other;
          }
        }
      }
      const cross = recipientOwner !== principal.operatorId;
      // One answer for unknown ids and unconnected agents of other owners (F4 §4), so ids
      // cannot be probed.
      if (!recipient)
        fail(
          403,
          'connection_required',
          'No approved connection from this agent to that agent; request one with city_request_connection.',
        );
      const to = recipient!;
      if (to.id === sender.id) fail(400, 'invalid_arguments', 'An agent cannot message itself.');
      for (const [agent, role] of [
        [sender, 'sending'],
        [to, 'recipient'],
      ] as const) {
        if (agent.revokedAt)
          fail(403, 'agent_revoked', `The ${role} agent ${agent.name} is revoked.`);
        if (agent.pausedAt) fail(409, 'agent_paused', `The ${role} agent ${agent.name} is paused.`);
      }
      if (workspace.paused) fail(409, 'workspace_paused', 'Workspace is paused.');
      if (cross && recipientWorkspace.paused)
        fail(409, 'workspace_paused', "The recipient's workspace is paused.");
      // Same rule as work requests: a current sender -> recipient connection between live agents
      // (for another workspace, the accepted cross-workspace connection checked above).
      if (!cross && !hasPermission(workspace, { requesterId: sender.id, providerId: to.id }))
        fail(
          403,
          'connection_required',
          `A directional connection from ${sender.name} to ${to.name} is required.`,
        );

      const messageId = randomUUID();
      const claimed = await tx.query(
        `INSERT INTO message_receipts(sender_id,idempotency_key,request_hash,message_id,recipient_id,seq,created_at)
         VALUES($1,$2,$3,$4,$5,0,$6) ON CONFLICT (sender_id,idempotency_key) DO NOTHING RETURNING message_id`,
        [sender.id, input.idempotency_key, requestHash, messageId, to.id, time],
      );
      if (!claimed.rows.length) {
        // Lost a race with a concurrent send using the same key.
        const receipt = (
          await tx.query<{ request_hash: string; recipient_id: string; seq: number | string }>(
            'SELECT request_hash,recipient_id,seq FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
            [sender.id, input.idempotency_key],
          )
        ).rows[0]!;
        return replay(tx, receipt, requestHash, workspace, principal.operatorId);
      }

      // An explicit id equal to this pair's old derivable id (#61) means "our conversation": it is
      // resolved like an omitted context_id, so the derivable id is never written again.
      const legacy = legacyPairContextId(sender.id, to.id);
      const explicit =
        input.context_id !== undefined && input.context_id !== legacy
          ? input.context_id
          : undefined;
      let contextId = explicit;
      if (input.reply_to) {
        const original = (
          await tx.query<{ context_id: string }>(
            'SELECT context_id FROM messages WHERE id=$1 AND (recipient_id=$2 OR sender_id=$2) LIMIT 1',
            [input.reply_to, sender.id],
          )
        ).rows[0];
        if (!original)
          fail(404, 'reply_not_found', 'reply_to must name a message this agent sent or received.');
        // A reply to a #61-era message of this pair continues the pair's stored conversation, not
        // the derivable id (reply_to itself is kept).
        if (original!.context_id !== legacy) contextId ??= original!.context_id;
      }
      if (explicit !== undefined) {
        // A caller-chosen thread must be new or one this agent already takes part in, so no one
        // can inject messages into a conversation between other agents by guessing its id.
        // Index probes only (messages_context_sender / messages_context_recipient, migration 19),
        // never a count over the thread. Ordering by a column the equality leaves free keeps the
        // planner on the index even for a huge thread, where a seq scan "until the first match"
        // would otherwise look cheap.
        const thread = (
          await tx.query<{ mine: boolean; used: boolean }>(
            `SELECT (SELECT created_at FROM messages WHERE context_id=$1 AND sender_id=$2
                       ORDER BY created_at DESC LIMIT 1) IS NOT NULL
                 OR (SELECT created_at FROM messages WHERE context_id=$1 AND recipient_id=$2
                       ORDER BY created_at DESC LIMIT 1) IS NOT NULL AS mine,
                    (SELECT created_at FROM messages WHERE context_id=$1
                       ORDER BY sender_id, created_at LIMIT 1) IS NOT NULL AS used`,
            [explicit, sender.id],
          )
        ).rows[0];
        if (thread?.used && !thread.mine)
          fail(
            403,
            'context_forbidden',
            'context_id names a conversation this agent does not take part in; omit it to continue your conversation with this agent, or choose a new id.',
          );
      }
      // No context_id and no reply_to: continue the pair's conversation instead of opening a new
      // one per message (UX audit #6). That is the context of the latest message between these
      // two agents in either direction (within the last PAIR_LOOKBACK messages of each inbox), else
      // the pair's stored default: a random id created once per pair (ON CONFLICT, so concurrent
      // first sends converge) and known only to the pair's owners. A latest message still under the
      // pair's #61 derivable id (not yet remediated) is not continued: the send falls through to
      // pair_contexts, which the remediation also uses, so the derivable id is never written again
      // and a send racing the remediation cannot leave a straggler under it.
      if (contextId === undefined) {
        const latest = (
          await tx.query<{ context_id: string }>(
            `SELECT context_id FROM (
               (SELECT context_id, created_at, id FROM messages
                 WHERE recipient_id=$1 AND sender_id=$2
                   AND seq > COALESCE((SELECT next_seq FROM inbox_cursors WHERE agent_id=$1), 1) - 1 - $3
                 ORDER BY seq DESC LIMIT 1)
               UNION ALL
               (SELECT context_id, created_at, id FROM messages
                 WHERE recipient_id=$2 AND sender_id=$1
                   AND seq > COALESCE((SELECT next_seq FROM inbox_cursors WHERE agent_id=$2), 1) - 1 - $3
                 ORDER BY seq DESC LIMIT 1)
             ) AS pair ORDER BY created_at DESC, id DESC LIMIT 1`,
            [to.id, sender.id, PAIR_LOOKBACK],
          )
        ).rows[0];
        if (latest && latest.context_id !== legacy) contextId = latest.context_id;
        else {
          const [low, high] = pairKey(sender.id, to.id);
          contextId =
            (
              await tx.query<{ context_id: string }>(
                `INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES($1,$2,$3,$4)
                 ON CONFLICT (low_id,high_id) DO NOTHING RETURNING context_id`,
                [low, high, randomUUID(), time],
              )
            ).rows[0]?.context_id ??
            (
              await tx.query<{ context_id: string }>(
                'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
                [low, high],
              )
            ).rows[0]!.context_id;
        }
      }

      if (cross) {
        // One remote workspace may hold at most a quarter of an inbox's unacknowledged capacity,
        // so a connected peer cannot crowd out everyone else writing to the same agent.
        const quota = Math.max(1, Math.floor(depth / 4));
        const pending = Number(
          (
            await tx.query<{ n: number | string }>(
              `SELECT count(*) AS n FROM messages m WHERE m.recipient_id=$1 AND m.sender_owner_id=$2
                AND m.seq > COALESCE((SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1),0)`,
              [to.id, principal.operatorId],
            )
          ).rows[0]?.n ?? 0,
        );
        if (pending >= quota)
          fail(
            429,
            'remote_quota',
            `${to.name}'s inbox already holds ${quota} unacknowledged messages from your workspace; retry after it acknowledges some.`,
            30_000,
          );
      }

      await tx.query(
        'INSERT INTO inbox_cursors(agent_id,next_seq,acked_seq,updated_at) VALUES($1,1,0,$2) ON CONFLICT (agent_id) DO NOTHING',
        [to.id, time],
      );
      const allocated = (
        await tx.query<{ seq: number | string }>(
          `UPDATE inbox_cursors SET next_seq=next_seq+1, updated_at=$2
           WHERE agent_id=$1 AND next_seq-1-acked_seq < $3 RETURNING next_seq-1 AS seq`,
          [to.id, time, depth],
        )
      ).rows[0];
      if (!allocated)
        fail(
          429,
          'inbox_full',
          `${to.name}'s inbox holds ${depth} unacknowledged messages; retry after it acknowledges some.`,
          30_000,
        );
      const seq = Number(allocated!.seq);
      const row = (
        await tx.query<MessageRow>(
          `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,reply_to,kind,parts,created_at,origin,sender_owner_label)
           VALUES($1,$2,$3,$4,$5,$10,$6,$7,'message',$8::jsonb,$9,$11,$12) RETURNING ${COLUMNS}`,
          [
            to.id,
            seq,
            messageId,
            sender.id,
            principal.operatorId,
            contextId,
            input.reply_to ?? null,
            JSON.stringify(parts),
            time,
            recipientOwner,
            cross ? 'external' : 'internal',
            senderLabel,
          ],
        )
      ).rows[0]!;
      await tx.query(
        'UPDATE message_receipts SET seq=$3 WHERE sender_id=$1 AND idempotency_key=$2',
        [sender.id, input.idempotency_key, seq],
      );
      // @mentions of the recipient, webhook outbox and after-commit wake (docs/WAKE.md).
      await messageDelivered(tx, {
        recipientId: to.id,
        recipientName: to.name,
        recipientOwnerId: recipientOwner,
        senderId: sender.id,
        senderName: sender.name,
        senderOwnerLabel: senderLabel,
        messageId,
        seq,
        contextId: contextId!,
        parts,
        time,
      });
      const names = namesOf(workspace);
      names.set(to.id, to.name);
      return { message: project(row, names) };
    });
  }

  async function readInbox(
    principal: MessagingPrincipal,
    agentId: string,
    query: InboxQuery,
    guard?: Guard,
  ): Promise<InboxPage> {
    const limit = Math.min(query.limit ?? MESSAGE_LIMITS.defaultPageSize, MESSAGE_LIMITS.pageSize);
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      await runtimeCurrent(tx, principal);
      if (principal.runtime && principal.runtime.agentId !== agentId)
        fail(403, 'forbidden', 'A runtime may only read its own inbox.');
      const workspace = await workspaceOf(tx, principal.operatorId);
      ownAgent(workspace, agentId, 'Inbox');
      const cursor = await cursorOf(tx, agentId);
      let rows: MessageRow[];
      let hasMore: boolean;
      if (query.before !== undefined || (query.since === undefined && query.start === 'latest')) {
        const before = query.before ?? cursor.latest + 1;
        rows = (
          await tx.query<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE recipient_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT $3`,
            [agentId, before, limit + 1],
          )
        ).rows;
        hasMore = rows.length > limit;
        rows = rows.slice(0, limit).reverse();
      } else {
        const since = query.since ?? cursor.acked;
        rows = (
          await tx.query<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE recipient_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`,
            [agentId, since, limit + 1],
          )
        ).rows;
        hasMore = rows.length > limit;
        rows = rows.slice(0, limit);
      }
      const names = await namesFor(
        tx,
        principal.operatorId,
        workspace,
        rows.map((row) => row.sender_id),
      );
      const messages = rows.map((row) => project(row, names));
      return {
        agent_id: agentId,
        messages,
        latest_seq: cursor.latest,
        acked_seq: cursor.acked,
        unread: cursor.unread,
        next_since: messages.at(-1)?.seq ?? query.since ?? cursor.acked,
        has_more: hasMore,
      };
    });
  }

  async function ack(
    principal: MessagingPrincipal,
    agentId: string,
    seq: number,
    guard?: Guard,
  ): Promise<InboxAck> {
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      await runtimeCurrent(tx, principal);
      if (principal.runtime && principal.runtime.agentId !== agentId)
        fail(403, 'forbidden', 'A runtime may only acknowledge its own inbox.');
      const workspace = await workspaceOf(tx, principal.operatorId);
      ownAgent(workspace, agentId, 'Inbox');
      const cursor = await cursorOf(tx, agentId, true);
      if (seq > cursor.latest)
        fail(
          400,
          'ack_beyond_latest',
          `seq ${seq} is beyond the latest delivered message (${cursor.latest}).`,
        );
      if (seq <= cursor.acked)
        return {
          agent_id: agentId,
          acked_seq: cursor.acked,
          latest_seq: cursor.latest,
          unread: cursor.unread,
        };
      await tx.query('UPDATE inbox_cursors SET acked_seq=$2, updated_at=$3 WHERE agent_id=$1', [
        agentId,
        seq,
        time,
      ]);
      return {
        agent_id: agentId,
        acked_seq: seq,
        latest_seq: cursor.latest,
        unread: cursor.latest - seq,
      };
    });
  }

  /**
   * The console's unread per member, its AIs and its people in rooms (the Messages count in the
   * navigation sums them; the inbox chips show the AIs).
   * Unread for the owner is only what one of its members RECEIVED from someone else and the owner
   * has not read yet (unreadFor): a message one of the owner's own members sent (to its person or
   * to another of its AIs) is never unread for the owner, even while the receiving AI has not
   * acknowledged it. The scan starts at the inbox's ack cursor on the primary key, so it is
   * bounded by the inbox's unacknowledged depth.
   */
  /**
   * Unread for an owner (`$owner` is its operator id), on a message `m` addressed to one of its
   * members past that inbox's ack cursor: sent by someone else (never by the owner's own members)
   * and newer than the owner's last read of the thread in the console (conversation_reads).
   */
  const unreadFor = (owner: string) =>
    `m.sender_owner_id <> ${owner} AND m.created_at > COALESCE((SELECT r.read_at FROM
      conversation_reads r WHERE r.owner_id=${owner} AND r.context_id=m.context_id), -1)
      AND m.created_at > COALESCE((SELECT h.hidden_at FROM conversation_hidden h
      WHERE h.owner_id=${owner} AND h.context_id=m.context_id), -1)`;
  /**
   * Held in a person's inbox for its owner (`$owner`): not yet read (or hidden) in the console,
   * whoever sent it, the owner's own members included. A person's capacity (remote_quota,
   * inbox_full) counts these, since its cursor stays below the first message still unread.
   */
  const heldFor = (owner: string) =>
    `m.created_at > COALESCE((SELECT r.read_at FROM
      conversation_reads r WHERE r.owner_id=${owner} AND r.context_id=m.context_id), -1)
      AND m.created_at > COALESCE((SELECT h.hidden_at FROM conversation_hidden h
      WHERE h.owner_id=${owner} AND h.context_id=m.context_id), -1)`;

  // Whether room invitations exist on this database (migration 101); checked until they do.
  let invitationsTable = false;
  // Whether Feed Respond's table exists (migration 108); checked until it does.
  let responsesTable = false;

  async function summary(operatorId: string): Promise<InboxSummaryPage> {
    return d.db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      const ids = workspace.agents.map((agent) => agent.id);
      const rows = (
        await tx.query<{
          agent_id: string;
          next_seq: number | string;
          acked_seq: number | string;
          n: number | string;
        }>(
          // The inboxes are the workspace's AIs and the owner's people in rooms (two indexed
          // lookups, no OR). Per inbox a range scan on the primary key from its ack cursor,
          // stopped after UNREAD_CAP + 1 hits, like the conversation list. Only messages the owner
          // is the recipient owner of count: an agent claimed from another owner keeps its old
          // messages under the old owner, and those are in none of this owner's threads.
          `SELECT c.agent_id, c.next_seq, c.acked_seq,
             (SELECT count(*) FROM (SELECT 1 FROM messages m WHERE m.recipient_id=c.agent_id
               AND m.seq > c.acked_seq AND m.recipient_owner_id=$2 AND ${unreadFor('$2')}
               ORDER BY m.seq LIMIT $3) x) AS n
             FROM (SELECT c.* FROM inbox_cursors c WHERE c.agent_id = ANY($1::text[])
                   UNION ALL
                   SELECT c.* FROM room_members p JOIN inbox_cursors c ON c.agent_id=p.agent_id
                    WHERE p.owner_id=$2 AND p.kind='person') c`,
          [ids, operatorId, UNREAD_CAP + 1],
        )
      ).rows;
      // Open room invitations per agent of this owner (Operation Directory D2), so the My agents
      // list shows them from the same poll: still open and not yet expired, the invited owner's own.
      invitationsTable ||= (
        await tx.query<{ ok: boolean }>("SELECT to_regclass('room_invitations') IS NOT NULL AS ok")
      ).rows[0]!.ok;
      const invitations: Record<string, number> = {};
      if (invitationsTable && ids.length) {
        const open = await tx.query<{ agent_id: string; n: number | string }>(
          `SELECT invited_agent_id AS agent_id, count(*) AS n FROM room_invitations
            WHERE invited_owner_id=$1 AND invited_agent_id = ANY($2::text[]) AND state='open'
              AND expires_at > $3
            GROUP BY invited_agent_id`,
          [operatorId, ids, d.clock()],
        );
        for (const row of open.rows) invitations[row.agent_id] = Number(row.n);
      }
      // Open responses to the owner's Feed requests (Feed Respond, migration 108), behind
      // CITY_FEED: counted like the inbox lists them (open, unexpired, request and room open).
      let requestResponses: number | undefined;
      if (feedEnabled()) {
        responsesTable ||= (
          await tx.query<{ ok: boolean }>(
            "SELECT to_regclass('feed_request_invitations') IS NOT NULL AS ok",
          )
        ).rows[0]!.ok;
        if (responsesTable)
          requestResponses = Number(
            (
              await tx.query<{ n: number | string }>(
                `SELECT count(*) AS n FROM feed_request_invitations v
                  JOIN feed_requests q ON q.id = v.request_id
                  JOIN rooms r ON r.id = v.room_id
                  WHERE v.poster_owner_id=$1 AND v.state='open' AND v.expires_at > $2
                    AND q.state='open' AND q.expires_at > $2
                    AND r.closed_at IS NULL AND r.deleted_at IS NULL`,
                [operatorId, d.clock()],
              )
            ).rows[0]?.n ?? 0,
          );
      }
      return {
        invitations,
        ...(requestResponses === undefined ? {} : { requestResponses }),
        inboxes: rows.map((row) => ({
          agent_id: row.agent_id,
          latest_seq: Number(row.next_seq) - 1,
          acked_seq: Number(row.acked_seq),
          unread: Math.min(Number(row.n), UNREAD_CAP),
          unread_capped: Number(row.n) > UNREAD_CAP,
        })),
      };
    });
  }

  /** The viewer's side and the peer of each private room thread among `rows` (latest per context). */
  async function directThreads(
    tx: Tx,
    operatorId: string,
    rows: MessageRow[],
  ): Promise<Map<string, DirectThread>> {
    const threads = new Map<string, DirectThread>();
    const direct = rows.filter((row) => row.room_id);
    if (!direct.length) return threads;
    const members = await roomMemberNames(
      tx,
      direct.flatMap((row) => [row.sender_id, row.recipient_id]),
    );
    const rooms = new Map(
      (
        await tx.query<{ id: string; name: string }>(
          'SELECT id, name FROM rooms WHERE id = ANY($1::text[])',
          [[...new Set(direct.map((row) => row.room_id!))]],
        )
      ).rows.map((room) => [room.id, room.name]),
    );
    // The label each side carries in the thread's room: the same stored room_members.owner_label
    // the room's member list shows (ownerLabel in connections/service.ts), never owner details.
    const labels = new Map(
      (
        await tx.query<{ room_id: string; agent_id: string; owner_label: string }>(
          `SELECT DISTINCT ON (room_id, agent_id) room_id, agent_id, owner_label FROM room_members
            WHERE room_id = ANY($1::text[]) AND agent_id = ANY($2::text[])
            ORDER BY room_id, agent_id, joined_at DESC`,
          [
            [...new Set(direct.map((row) => row.room_id!))],
            [...new Set(direct.flatMap((row) => [row.sender_id, row.recipient_id]))],
          ],
        )
      ).rows.map((row) => [`${row.room_id}:${row.agent_id}`, row.owner_label]),
    );
    const side = (id: string, roomId: string, isSelf: boolean, own: boolean): DirectParty => ({
      id,
      name: members.get(id)?.name ?? 'Unknown member',
      kind: members.get(id)?.kind ?? ('agent' as const),
      owner_label: labels.get(`${roomId}:${id}`) ?? null,
      is_self: isSelf,
      own,
    });
    for (const row of direct) {
      // A thread between two of the viewer's own members (its person and its AI): the viewer's
      // side is its person (else the lower id), whoever wrote last, so the header stays put.
      const person = (id: string) => members.get(id)?.kind === 'person';
      const both = row.sender_owner_id === operatorId && row.recipient_owner_id === operatorId;
      const mine = !both
        ? row.sender_owner_id === operatorId
        : person(row.sender_id) !== person(row.recipient_id)
          ? person(row.sender_id)
          : row.sender_id < row.recipient_id;
      threads.set(row.context_id, {
        context_id: row.context_id,
        room_id: row.room_id!,
        room_name: rooms.get(row.room_id!) ?? 'Deleted room',
        self: side(mine ? row.sender_id : row.recipient_id, row.room_id!, true, true),
        peer: side(mine ? row.recipient_id : row.sender_id, row.room_id!, false, both),
      });
    }
    return threads;
  }

  async function conversations(
    operatorId: string,
    limit = 50,
    agentId?: string,
  ): Promise<{ conversations: ConversationSummary[] }> {
    return d.db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      // The newest threads first, without reading the owner's whole history: the threads the
      // owner received in come from a skip scan over (recipient_owner_id, context_id), one index
      // probe per thread, and the threads the owner only sent into from the newest
      // CONVERSATION_SEND_SCAN sent rows. Only the chosen page of threads is aggregated below.
      const page = (
        await tx.query<{ context_id: string }>(
          `WITH RECURSIVE recv(context_id) AS (
             (SELECT context_id FROM messages WHERE recipient_owner_id=$1 ORDER BY context_id LIMIT 1)
             UNION ALL
             SELECT (SELECT m.context_id FROM messages m WHERE m.recipient_owner_id=$1
                       AND m.context_id > recv.context_id ORDER BY m.context_id LIMIT 1)
               FROM recv WHERE recv.context_id IS NOT NULL
           ), candidates AS (
             SELECT context_id, max(last_at) AS last_at FROM (
               SELECT r.context_id, (SELECT max(m.created_at) FROM messages m
                        WHERE m.recipient_owner_id=$1 AND m.context_id=r.context_id) AS last_at
                 FROM recv r WHERE r.context_id IS NOT NULL
               UNION ALL
               SELECT context_id, created_at FROM (SELECT context_id, created_at FROM messages
                 WHERE sender_owner_id=$1 ORDER BY created_at DESC LIMIT $4) s
             ) c GROUP BY context_id
           )
           SELECT c.context_id FROM candidates c
            WHERE c.last_at > COALESCE((SELECT h.hidden_at FROM conversation_hidden h
                    WHERE h.owner_id=$1 AND h.context_id=c.context_id), -1)
              AND ($3::text IS NULL
                OR EXISTS (SELECT 1 FROM messages m WHERE m.context_id=c.context_id
                             AND m.sender_id=$3 AND m.sender_owner_id=$1)
                OR EXISTS (SELECT 1 FROM messages m WHERE m.context_id=c.context_id
                             AND m.recipient_id=$3 AND m.recipient_owner_id=$1))
            ORDER BY c.last_at DESC, c.context_id LIMIT $2`,
          [operatorId, Math.min(Math.max(limit, 1), 100), agentId ?? null, CONVERSATION_SEND_SCAN],
        )
      ).rows.map((row) => row.context_id);
      if (!page.length) return { conversations: [] };
      const groups = (
        await tx.query<{
          context_id: string;
          message_count: number | string;
          last_at: number | string;
          senders: string[];
          recipients: string[];
        }>(
          `SELECT context_id, count(*) AS message_count, max(created_at) AS last_at,
             jsonb_agg(DISTINCT sender_id) AS senders, jsonb_agg(DISTINCT recipient_id) AS recipients
           FROM messages WHERE context_id = ANY($2::text[])
             AND (recipient_owner_id=$1 OR sender_owner_id=$1)
           GROUP BY context_id`,
          [operatorId, page],
        )
      ).rows.sort(
        (x, y) =>
          Number(y.last_at) - Number(x.last_at) ||
          (x.context_id < y.context_id ? -1 : x.context_id > y.context_id ? 1 : 0),
      );
      if (!groups.length) return { conversations: [] };
      const latest = (
        await tx.query<MessageRow>(
          `SELECT DISTINCT ON (context_id) ${COLUMNS} FROM messages
           WHERE (recipient_owner_id=$1 OR sender_owner_id=$1) AND context_id IN (SELECT jsonb_array_elements_text($2::jsonb))
           ORDER BY context_id, created_at DESC, seq DESC, id DESC`,
          [operatorId, JSON.stringify(groups.map((group) => group.context_id))],
        )
      ).rows;
      const names = await namesFor(
        tx,
        operatorId,
        workspace,
        groups.flatMap((group) => [...group.senders, ...group.recipients]),
      );
      const byContext = new Map(latest.map((row) => [row.context_id, project(row, names)]));
      const direct = await directThreads(tx, operatorId, latest);
      // Unread per thread in one statement. For each (thread, recipient inbox) pair a LATERAL
      // range scan on the primary key (recipient_id, seq) starts at that inbox's ack cursor and
      // stops after UNREAD_CAP + 1 hits, so rows read are bounded by the inbox's unacknowledged
      // depth, never by the thread's history.
      // A private room thread counts only what reached the viewer's own side: in a thread between
      // the viewer's person and its own AI, the AI's unread messages are not the person's. And a
      // message one of the viewer's own members sent is never unread for the viewer (unreadFor).
      const pairs = groups.flatMap((group) =>
        [...new Set(group.recipients)]
          .filter((recipient) => {
            const thread = direct.get(group.context_id);
            return !thread || thread.self.id === recipient;
          })
          .map((recipient) => [group.context_id, recipient] as const),
      );
      const unread = new Map(
        (
          await tx.query<{ context_id: string; n: number | string }>(
            `SELECT p.context_id, count(*) AS n
               FROM unnest($2::text[], $3::text[]) AS p(context_id, recipient_id)
               LEFT JOIN inbox_cursors c ON c.agent_id=p.recipient_id
               CROSS JOIN LATERAL (
                 SELECT 1 FROM messages m
                  WHERE m.recipient_id=p.recipient_id AND m.seq > COALESCE(c.acked_seq, 0)
                    AND m.context_id=p.context_id AND m.recipient_owner_id=$1
                    AND ${unreadFor('$1')}
                  ORDER BY m.seq LIMIT $4) x
              GROUP BY p.context_id`,
            [
              operatorId,
              pairs.map((pair) => pair[0]),
              pairs.map((pair) => pair[1]),
              UNREAD_CAP + 1,
            ],
          )
        ).rows.map((row) => [row.context_id, Number(row.n)]),
      );
      return {
        conversations: groups.map((group) => ({
          context_id: group.context_id,
          message_count: Number(group.message_count),
          participants: [...new Set([...group.senders, ...group.recipients])].sort(),
          last_message: byContext.get(group.context_id)!,
          unread: Math.min(unread.get(group.context_id) ?? 0, UNREAD_CAP),
          unread_capped: (unread.get(group.context_id) ?? 0) > UNREAD_CAP,
          ...(direct.has(group.context_id) ? { direct: direct.get(group.context_id)! } : {}),
        })),
      };
    });
  }

  async function conversation(
    operatorId: string,
    contextId: string,
    options: { before?: string; limit?: number } = {},
  ) {
    const limit = Math.min(
      options.limit ?? MESSAGE_LIMITS.defaultPageSize,
      MESSAGE_LIMITS.pageSize,
    );
    // Cursor: created_at.seq.id of the oldest message on the previous page (newest-first order).
    let cursor: [number, number, string] | undefined;
    if (options.before !== undefined) {
      const match = /^(\d{1,16})\.(\d{1,16})\.([0-9a-f-]{36})$/.exec(options.before);
      if (!match) fail(400, 'invalid_arguments', 'before is not a valid conversation cursor.');
      cursor = [Number(match![1]), Number(match![2]), match![3]!];
    }
    return d.db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      const rows = (
        await tx.query<MessageRow>(
          `SELECT ${COLUMNS} FROM messages WHERE (recipient_owner_id=$1 OR sender_owner_id=$1) AND context_id=$2
           ${cursor ? 'AND (created_at, seq, id::text) < ($4::bigint, $5::bigint, $6::text)' : ''}
           ORDER BY created_at DESC, seq DESC, id::text DESC LIMIT $3`,
          cursor
            ? [operatorId, contextId, limit + 1, ...cursor]
            : [operatorId, contextId, limit + 1],
        )
      ).rows;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const oldest = page.at(-1);
      const names = await namesFor(
        tx,
        operatorId,
        workspace,
        page.flatMap((row) => [row.sender_id, row.recipient_id]),
      );
      return {
        context_id: contextId,
        messages: page.reverse().map((row) => project(row, names)),
        has_more: hasMore,
        next_before:
          hasMore && oldest
            ? `${Number(oldest.created_at)}.${Number(oldest.seq)}.${oldest.id}`
            : null,
      };
    });
  }

  /**
   * "Delete conversation" in the console: hides one thread from this owner's Messages only
   * (conversation_hidden, migration 70). Nothing is deleted: the other side keeps its copy, every
   * agent inbox keeps its messages, and the thread shows again when a newer message arrives.
   * Only a participant may hide, and an unknown thread is the same 404 as one of someone else.
   */
  async function hideConversation(
    principal: MessagingPrincipal,
    contextId: string,
  ): Promise<{ context_id: string; hidden_at: string }> {
    if (!principal.console)
      fail(403, 'forbidden', 'Only the console hides a conversation from Messages.');
    await d.limit(`msg-hide:${principal.operatorId}`, HIDES_PER_MINUTE, 60_000);
    return d.db.transaction(async (tx) => {
      const participant = await tx.query(
        `SELECT 1 FROM messages WHERE context_id=$1 AND (recipient_owner_id=$2 OR sender_owner_id=$2)
          LIMIT 1`,
        [contextId, principal.operatorId],
      );
      if (!participant.rows.length) fail(404, 'conversation_not_found', 'Conversation not found.');
      // Hidden from now: a message in the same millisecond still counts as before the hide, and
      // the newest message's time is the floor so clock skew never keeps a hidden thread visible.
      const time = d.clock();
      const newest = Number(
        (
          await tx.query<{ at: number | string | null }>(
            `SELECT max(created_at) AS at FROM messages
              WHERE context_id=$1 AND (recipient_owner_id=$2 OR sender_owner_id=$2)`,
            [contextId, principal.operatorId],
          )
        ).rows[0]?.at ?? 0,
      );
      const hiddenAt = Math.max(time, newest);
      await tx.query(
        `INSERT INTO conversation_hidden(owner_id,context_id,hidden_at) VALUES($1,$2,$3)
         ON CONFLICT (owner_id,context_id) DO UPDATE SET hidden_at=GREATEST(conversation_hidden.hidden_at, EXCLUDED.hidden_at)`,
        [principal.operatorId, contextId, hiddenAt],
      );
      // A hidden thread is read too: its messages are no longer unread for this owner.
      await tx.query(
        `INSERT INTO conversation_reads(owner_id,context_id,read_at) VALUES($1,$2,$3)
         ON CONFLICT (owner_id,context_id)
         DO UPDATE SET read_at=GREATEST(conversation_reads.read_at, EXCLUDED.read_at)`,
        [principal.operatorId, contextId, hiddenAt],
      );
      return { context_id: contextId, hidden_at: new Date(hiddenAt).toISOString() };
    });
  }

  /**
   * Who the console can start a private message with: the other active members of every open
   * room the caller is an active member of, where the host allows private messages and the
   * caller's member is not muted. The same rules as a send (authorizeRoomPair) decide on open;
   * this only lists candidates, so read-only members and Elric are left out. Bounded.
   */
  async function recipients(operatorId: string): Promise<{ recipients: DirectRecipient[] }> {
    const rows = (
      await d.db.query<{
        room_id: string;
        room_name: string;
        member_id: string;
        kind: string | null;
        name: string | null;
        owner_label: string;
        own: boolean;
      }>(
        `SELECT r.id AS room_id, r.name AS room_name, t.agent_id AS member_id, t.kind,
            CASE WHEN t.kind='person' THEN t.display_name ELSE (
              SELECT a->>'name' FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(w.data->'agents')='array' THEN w.data->'agents' ELSE '[]'::jsonb END) a
              WHERE w.operator_id=t.owner_id AND a->>'id'=t.agent_id LIMIT 1) END AS name,
            t.owner_label, (t.owner_id=$1) AS own
          FROM room_members s
          JOIN rooms r ON r.id=s.room_id
          JOIN room_members t ON t.room_id=s.room_id AND t.agent_id<>s.agent_id
          WHERE s.owner_id=$1 AND s.removed_at IS NULL AND s.muted_at IS NULL AND s.role<>'guest'
            AND r.deleted_at IS NULL AND r.closed_at IS NULL AND r.elric_private IS NOT TRUE
            AND r.members_may_dm IS NOT FALSE
            AND t.removed_at IS NULL AND t.muted_at IS NULL AND t.role<>'guest'
            -- The host's mute silences a whole owner in the room, not only the muted row
            -- (authorizeRoomPair, refuseIfMuted); "Mute all AIs" spares the person member.
            AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=s.room_id
              AND m.owner_id=s.owner_id AND m.muted_at IS NOT NULL
              AND (COALESCE(s.kind,'agent')<>'person' OR m.mute_scope IS DISTINCT FROM 'ai'))
            AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=t.room_id
              AND m.owner_id=t.owner_id AND m.muted_at IS NOT NULL
              AND (COALESCE(t.kind,'agent')<>'person' OR m.mute_scope IS DISTINCT FROM 'ai'))
            AND NOT (t.owner_id=$1 AND t.kind='person')
            AND (to_regclass('elric_agents') IS NULL OR NOT EXISTS (
              SELECT 1 FROM elric_agents e WHERE e.agent_id=t.agent_id))
          ORDER BY r.id, t.agent_id, (s.kind='person') DESC
          LIMIT 1000`,
        [operatorId],
      )
    ).rows;
    const seen = new Set<string>();
    const recipients: DirectRecipient[] = [];
    for (const row of rows) {
      const key = `${row.room_id}:${row.member_id}`;
      if (seen.has(key) || !row.name) continue;
      seen.add(key);
      recipients.push({
        room_id: row.room_id,
        room_name: row.room_name,
        member_id: row.member_id,
        name: row.name,
        kind: row.kind === 'person' ? 'person' : 'agent',
        owner_label: row.own ? null : row.owner_label,
        own: row.own,
      });
      if (recipients.length >= RECIPIENT_CAP) break;
    }
    recipients.sort(
      (a, b) =>
        a.room_name.localeCompare(b.room_name) ||
        a.name.localeCompare(b.name) ||
        a.member_id.localeCompare(b.member_id),
    );
    return { recipients };
  }

  return {
    send,
    openDirect,
    readDirect,
    readInbox,
    ack,
    summary,
    conversations,
    conversation,
    hideConversation,
    recipients,
  };
}
