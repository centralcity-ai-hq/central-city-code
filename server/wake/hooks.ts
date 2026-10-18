import type { Transaction as Tx } from '../database.js';
import type { MessagePart } from '../messaging/contract.js';
import { WAKE_LIMITS } from './contract.js';
import { excerptAt, findMentions, mentionKeys, nameKeyOf, slugOf, textOf } from './mentions.js';
import { emit, type WakeSignal } from './signals.js';
import { elricOnRoomPosted } from '../elric/hook.js';

/**
 * In-transaction wake hooks (docs/WAKE.md), called by the messaging and rooms services
 * right after they write a new message, inside the same transaction:
 *
 * 1. record @mentions of agents that can already read the message (never anyone else);
 * 2. coalesce a pending webhook wake-up into `wake_outbox` for affected agents' webhooks;
 * 3. emit after-commit signals so in-process waiters wake at once.
 *
 * No rate limiter, network call or second pool client is used here. Locks: only the mentioned
 * agents' `wake_cursors` rows (taken in sorted id order) and their `wake_outbox` rows.
 */

interface MentionRow {
  agentId: string;
  ownerId: string;
  sourceKind: 'message' | 'room';
  sourceId: string;
  roomId: string | null;
  sourceSeq: number;
  contextId: string | null;
  fromAgentId: string;
  fromName: string;
  fromOwnerLabel: string | null;
  excerpt: string;
  time: number;
}

/**
 * The hard bound on an agent's unread mentions: the backlog cap plus as many mentions Auto-reply
 * never answers (see insertMention).
 */
export const UNREAD_MENTIONS_CEILING = 2 * WAKE_LIMITS.unreadMentions;

/**
 * Allocates the next mention seq and writes the row; null when the agent's backlog is full. The
 * backlog counts unread mentions (`unread_count`, migration 26), not the cursor span, so mentions
 * nobody acknowledges below the cursor cannot stop recording.
 *
 * Auto-reply (server/responder) never answers a room mention from before it was enabled or from
 * an auto-reply post, and never marks one read for an agent that is not hosted: its runtime, a
 * chat-app connector or a wake-up webhook may still read it. So such mentions must not silence
 * the ones Auto-reply answers: at the cap, a room mention that is not from an auto-reply post is
 * still recorded for an agent with Auto-reply on while the unread mentions other than those stay
 * under the cap, up to UNREAD_MENTIONS_CEILING in all. The count runs only at the cap and
 * starts at the mention cursor.
 */
async function insertMention(
  tx: Tx,
  row: MentionRow,
  options: { autoReply?: boolean } = {},
): Promise<number | null> {
  await tx.query(
    'INSERT INTO wake_cursors(agent_id,next_mention_seq,acked_mention_seq,updated_at) VALUES($1,1,0,$2) ON CONFLICT (agent_id) DO NOTHING',
    [row.agentId, row.time],
  );
  let allocated = (
    await tx.query<{ seq: number | string }>(
      `UPDATE wake_cursors SET next_mention_seq=next_mention_seq+1, unread_count=unread_count+1, updated_at=$2
       WHERE agent_id=$1 AND unread_count < $3 RETURNING next_mention_seq-1 AS seq`,
      [row.agentId, row.time, WAKE_LIMITS.unreadMentions],
    )
  ).rows[0];
  if (!allocated && row.sourceKind === 'room' && !options.autoReply)
    allocated = (
      await tx.query<{ seq: number | string }>(
        `WITH s AS (SELECT enabled_at FROM responder_settings
                     WHERE agent_id=$1 AND enabled AND enabled_at IS NOT NULL)
         UPDATE wake_cursors c SET next_mention_seq=c.next_mention_seq+1,
           unread_count=c.unread_count+1, updated_at=$2
          WHERE c.agent_id=$1 AND c.unread_count < $4 AND EXISTS (SELECT 1 FROM s)
            AND (SELECT count(*) FROM mentions m, s WHERE m.agent_id=$1
                   AND m.seq > c.acked_mention_seq AND m.read_at IS NULL
                   AND NOT (m.source_kind='room' AND (m.created_at < s.enabled_at
                     OR EXISTS (SELECT 1 FROM room_messages rm WHERE rm.room_id=m.room_id
                                  AND rm.seq=m.source_seq AND rm.auto_reply IS NOT NULL)))) < $3
          RETURNING c.next_mention_seq-1 AS seq`,
        [row.agentId, row.time, WAKE_LIMITS.unreadMentions, UNREAD_MENTIONS_CEILING],
      )
    ).rows[0];
  if (!allocated) return null;
  const seq = Number(allocated.seq);
  await tx.query(
    `INSERT INTO mentions(agent_id,seq,owner_id,source_kind,source_id,room_id,source_seq,context_id,from_agent_id,from_name,from_owner_label,excerpt,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.agentId,
      seq,
      row.ownerId,
      row.sourceKind,
      row.sourceId,
      row.roomId,
      row.sourceSeq,
      row.contextId,
      row.fromAgentId,
      row.fromName.slice(0, 200),
      row.fromOwnerLabel,
      row.excerpt,
      row.time,
    ],
  );
  return seq;
}

/** Coalesces into the pending wake-up of every enabled webhook the statement selects. */
const UPSERT = `ON CONFLICT (webhook_id) DO UPDATE SET
  kinds = ARRAY(SELECT DISTINCT e FROM unnest(wake_outbox.kinds || EXCLUDED.kinds) AS e ORDER BY e),
  event = EXCLUDED.event, pending = wake_outbox.pending + 1, version = wake_outbox.version + 1
  RETURNING webhook_id`;

/** Direct message delivered into `recipientId`'s inbox (server/messaging/service.ts send). */
export async function messageDelivered(
  tx: Tx,
  m: {
    recipientId: string;
    recipientName: string;
    recipientOwnerId: string;
    senderId: string;
    senderName: string;
    senderOwnerLabel: string | null;
    messageId: string;
    seq: number;
    contextId: string;
    parts: MessagePart[];
    time: number;
    /**
     * A private room message to an AI that muted that room's notifications: it lands in the inbox
     * (long-poll readers still see it), but records no @mention and wakes no webhook.
     */
    quiet?: boolean;
  },
): Promise<void> {
  const signals: WakeSignal[] = [{ kind: 'inbox', id: m.recipientId, seq: m.seq }];
  if (m.quiet) {
    emit(tx, ...signals);
    return;
  }
  const kinds = ['message'];
  const text = textOf(m.parts);
  if (text.includes('@')) {
    // Only the recipient can read a direct message, so only the recipient can be mentioned.
    const found = findMentions(
      text,
      [
        { id: m.recipientId, name: m.recipientName },
        { id: m.senderId, name: m.senderName },
      ],
      { exclude: m.senderId },
    );
    if (found.ids.length) {
      const seq = await insertMention(tx, {
        agentId: m.recipientId,
        ownerId: m.recipientOwnerId,
        sourceKind: 'message',
        sourceId: m.messageId,
        roomId: null,
        sourceSeq: m.seq,
        contextId: m.contextId,
        fromAgentId: m.senderId,
        fromName: m.senderName,
        fromOwnerLabel: m.senderOwnerLabel,
        excerpt: excerptAt(text, found.offsets.get(m.recipientId) ?? 0),
        time: m.time,
      });
      if (seq !== null) {
        signals.push({ kind: 'mention', id: m.recipientId, seq });
        kinds.push('mention');
      }
    }
  }
  const event = {
    kind: 'message',
    message_id: m.messageId,
    seq: m.seq,
    context_id: m.contextId,
    from_agent_id: m.senderId,
  };
  const queued = await tx.query(
    `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
     SELECT w.id, w.agent_id, k.kinds, $3::jsonb, 1, 1, 0, $4, $4, w.kind FROM wake_webhooks w
     CROSS JOIN LATERAL (SELECT ARRAY(SELECT e FROM unnest($2::text[]) AS e WHERE e = ANY(w.events) ORDER BY e) AS kinds) k
     -- Direct messages wake HTTPS webhooks only; hosted responders answer room mentions.
     WHERE w.agent_id=$1 AND w.kind='https' AND w.disabled_at IS NULL AND cardinality(k.kinds) > 0 ORDER BY w.id
     ${UPSERT}`,
    [m.recipientId, kinds, JSON.stringify(event), m.time],
  );
  if (queued.rows.length) signals.push({ kind: 'outbox' });
  emit(tx, ...signals);
}

/**
 * Fills the mention keys (migration 62) of the room's active members that have none: new
 * members, and members whose name changed since. One indexed probe when there are none. Rows
 * another transaction holds are skipped (they stay candidates), and a row whose name changed
 * after it was read here (name_rev moved) keeps NULL, so a written key is never stale. A member
 * whose agent is gone from its owner's workspace gets empty keys, which match nothing.
 */
export async function fillMemberNameKeys(tx: Pick<Tx, 'query'>, roomId: string): Promise<void> {
  const unkeyed = (
    await tx.query<{ agent_id: string; name: string | null; name_rev: number }>(
      `SELECT m.agent_id, m.name_rev,
          CASE WHEN m.kind='person' THEN m.display_name ELSE (
            SELECT a->>'name' FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(w.data->'agents')='array' THEN w.data->'agents' ELSE '[]'::jsonb END) a
            WHERE w.operator_id=m.owner_id AND a->>'id'=m.agent_id LIMIT 1) END AS name
        FROM room_members m WHERE m.room_id=$1 AND m.name_key IS NULL AND m.removed_at IS NULL`,
      [roomId],
    )
  ).rows;
  if (!unkeyed.length) return;
  await tx.query(
    `UPDATE room_members m SET name_key=k.name_key, slug_key=k.slug_key
       FROM (SELECT x.agent_id, n.name_key, n.slug_key
               FROM unnest($2::text[], $3::int[], $4::text[], $5::text[])
                 AS n(agent_id, name_rev, name_key, slug_key)
               JOIN room_members x ON x.room_id=$1 AND x.agent_id=n.agent_id
                 AND x.name_rev=n.name_rev AND x.name_key IS NULL
               FOR UPDATE OF x SKIP LOCKED) k
      WHERE m.room_id=$1 AND m.agent_id=k.agent_id`,
    [
      roomId,
      unkeyed.map((member) => member.agent_id),
      unkeyed.map((member) => Number(member.name_rev)),
      unkeyed.map((member) => (member.name === null ? '' : nameKeyOf(member.name))),
      unkeyed.map((member) => (member.name === null ? '' : slugOf(member.name))),
    ],
  );
}

/** New room post (server/rooms/service.ts post), with the inserted room_messages row. */
export async function roomPosted(
  tx: Tx,
  row: {
    room_id: string;
    seq: string | number;
    id: string;
    sender_agent_id: string;
    sender_name: string;
    sender_owner_label: string;
    parts: MessagePart[];
    created_at: string | number;
    /** Server-stamped auto-reply label (migration 26); an auto-reply wakes no responder. */
    auto_reply?: unknown;
    /** Server-stamped sender kind (migration 31): 'person' only for a person member's post. */
    sender_kind?: string | null;
  },
  room: {
    /** The room is the owner's private chat with this own agent (server/rooms/private.ts). */
    privateAgentId?: string | null;
  } = {},
): Promise<void> {
  const seq = Number(row.seq);
  const time = Number(row.created_at);
  const signals: WakeSignal[] = [{ kind: 'room', id: row.room_id, seq }];
  const text = textOf(row.parts);
  const mentioned: string[] = [];
  // In a private chat with an own agent, every post of the owner's person is addressed to that
  // agent, "@" or not. Never an agent's post: its own posts and auto-replies stay unaddressed.
  const addressed = row.sender_kind === 'person' ? (room.privateAgentId ?? null) : null;
  if (text.includes('@') || addressed) {
    // Candidates: active members that can read this post: live agents of their owners, and
    // people in the room by their room-unique display name (migration 31). A member whose owner
    // the host muted (migration 35), or who muted the room's notifications for itself (migration
    // 38), still counts as a name (so "@Ann Lee" never falls back to "@Ann"), but no mention is
    // recorded for it. A bulk "Mute all AIs" (mute_scope 'ai') mutes only the owner's AIs: the
    // owner's person member is still mentioned.
    // Only members that can match a mention token are loaded (indexed name_key / slug_key /
    // id, migration 62), plus the sender (for its own-host rule), the addressed agent (by id) and
    // members whose keys are not known yet; findMentions over them is the same as over every
    // member (mentionKeys).
    await fillMemberNameKeys(tx, row.room_id);
    const keys = mentionKeys(text);
    if (addressed) keys.ids = [...keys.ids, addressed.toLowerCase()];
    const members = (
      await tx.query<{
        agent_id: string;
        owner_id: string;
        name: string;
        kind: string;
        role: string;
        muted: boolean;
      }>(
        `WITH c AS MATERIALIZED (
           SELECT agent_id FROM room_members WHERE room_id=$1 AND name_key = ANY($3::text[])
           UNION SELECT agent_id FROM room_members WHERE room_id=$1 AND slug_key = ANY($4::text[])
           UNION SELECT agent_id FROM room_members WHERE room_id=$1 AND lower(agent_id) = ANY($5::text[])
           UNION SELECT agent_id FROM room_members WHERE room_id=$1 AND name_key IS NULL
           UNION SELECT $6::text)
         SELECT m.agent_id, m.owner_id, a->>'name' AS name, 'agent' AS kind, m.role,
            EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
              AND x.room_id=m.room_id AND (x.muted_at IS NOT NULL OR x.notifications_muted)) AS muted FROM room_members m
          JOIN workspaces w ON w.operator_id=m.owner_id
          CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
          WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.visible_from_seq < $2
            AND m.agent_id IN (SELECT agent_id FROM c)
            AND m.kind='agent' AND a->>'id'=m.agent_id AND (a->>'revokedAt') IS NULL
         UNION ALL
         SELECT m.agent_id, m.owner_id, m.display_name AS name, 'person' AS kind, m.role,
            EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
              AND x.room_id=m.room_id AND (x.notifications_muted
                OR (x.muted_at IS NOT NULL AND x.mute_scope IS DISTINCT FROM 'ai'))) AS muted
          FROM room_members m
          WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.visible_from_seq < $2
            AND m.agent_id IN (SELECT agent_id FROM c)
            AND m.kind='person' AND m.display_name IS NOT NULL`,
        [row.room_id, seq, keys.names, keys.slugs, keys.ids, row.sender_agent_id],
      )
    ).rows;
    // Never mentioned: the sender itself (an agent never wakes on its own post or auto-reply).
    // When an AGENT member posts (an AI, or its owner posting in its name), also not the
    // room-host agent of the same owner: "@<their host>" from another agent of the owner is not
    // a mention (no record, no wake-up, no auto-reply). A PERSON member is the owner themselves
    // (only the console posts as a person, rooms/service.ts post): their "@<own agent>" is a
    // mention like anyone's, also of the agent hosting the room, so it wakes it and its
    // auto-reply can answer (owner decision, 10 Oct). Excluded ids stay candidates, so their
    // names still resolve. Anyone else mentions that host normally.
    const sender = members.find((member) => member.agent_id === row.sender_agent_id);
    const ownHost =
      sender?.kind === 'agent'
        ? members
            .filter(
              (member) =>
                member.role === 'host' &&
                member.kind === 'agent' &&
                member.owner_id === sender.owner_id,
            )
            .map((member) => member.agent_id)
        : [];
    const found = findMentions(
      text,
      members.map((member) => ({ id: member.agent_id, name: member.name })),
      { exclude: [row.sender_agent_id, ...ownHost] },
    );
    const ids = new Set(found.ids);
    // The owner's person in its private chat with its own agent: the agent is addressed without
    // an "@" while it is a live member that can read the post (the candidates' rules). Muted
    // notifications, removal and revocation still record nothing, like any mention.
    const target = addressed
      ? members.find((member) => member.agent_id === addressed && member.kind === 'agent')
      : undefined;
    if (target && sender?.kind === 'person' && target.owner_id === sender.owner_id)
      ids.add(target.agent_id);
    const owners = new Map(members.map((member) => [member.agent_id, member.owner_id]));
    const muted = new Set(members.filter((member) => member.muted).map((m) => m.agent_id));
    // Sorted, so concurrent posts lock wake_cursors rows in one global order.
    for (const agentId of [...ids].sort()) {
      if (muted.has(agentId)) continue;
      const mentionSeq = await insertMention(
        tx,
        {
          agentId,
          ownerId: owners.get(agentId)!,
          sourceKind: 'room',
          sourceId: row.id,
          roomId: row.room_id,
          sourceSeq: seq,
          contextId: null,
          fromAgentId: row.sender_agent_id,
          fromName: row.sender_name,
          fromOwnerLabel: row.sender_owner_label,
          excerpt: excerptAt(text, found.offsets.get(agentId) ?? 0),
          time,
        },
        { autoReply: row.auto_reply !== undefined && row.auto_reply !== null },
      );
      if (mentionSeq !== null) {
        mentioned.push(agentId);
        signals.push({ kind: 'mention', id: agentId, seq: mentionSeq });
      }
    }
  }
  // Elric (docs/ELRIC.md, CITY_ELRIC=1): queues its owner's invocations and refuses the rest.
  // No model call and no reservation here; a no-op when the flag is off.
  if (mentioned.length) await elricOnRoomPosted(tx, row, mentioned);
  const event = {
    kind: 'room_post',
    room_id: row.room_id,
    message_id: row.id,
    seq,
    from_agent_id: row.sender_agent_id,
  };
  const queued = await tx.query(
    `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
     SELECT w.id, w.agent_id, k.kinds, $3::jsonb, 1, 1, 0, $4, $4, w.kind FROM wake_webhooks w
     JOIN room_members m ON m.agent_id=w.agent_id AND m.room_id=$1 AND m.removed_at IS NULL
       AND m.kind='agent'
       -- The host muted this owner here (migration 35): it cannot answer, so it is not woken
       -- (a hosted responder would spend the member's tokens on a refused reply). Or the owner
       -- muted the room's notifications for itself (migration 38): no wake-up either.
       AND NOT EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
         AND x.room_id=m.room_id AND (x.muted_at IS NOT NULL OR x.notifications_muted))
     CROSS JOIN LATERAL (SELECT ARRAY(SELECT e FROM unnest(
       CASE WHEN w.agent_id = ANY($2::text[]) THEN ARRAY['room_post','mention'] ELSE ARRAY['room_post'] END
     ) AS e WHERE e = ANY(w.events) ORDER BY e) AS kinds) k
     WHERE w.disabled_at IS NULL AND w.agent_id <> $5 AND cardinality(k.kinds) > 0
       -- A hosted responder (events ['mention']) is woken only by a mention in a room whose
       -- host allows responders, and never by an auto-reply (loop protection, review B7/N10).
       AND (w.kind = 'https' OR ($6::boolean AND EXISTS (
         SELECT 1 FROM rooms r WHERE r.id=$1 AND r.responders_allowed AND r.closed_at IS NULL)))
     ORDER BY w.id
     ${UPSERT}`,
    [
      row.room_id,
      mentioned,
      JSON.stringify(event),
      time,
      row.sender_agent_id,
      row.auto_reply === undefined || row.auto_reply === null,
    ],
  );
  if (queued.rows.length) signals.push({ kind: 'outbox' });
  emit(tx, ...signals);
}

/**
 * Peer review notice (room tasks, docs/ROOM_TASKS.md "Peer review"): the server's line about a
 * review request or verdict mentions the agents it concerns (the requested reviewer; or the
 * claimer and the host), the same way an @mention in a room post does: a mention record, a
 * webhook or hosted-responder wake-up, and an in-process signal. Members whose owner is muted in
 * the room (by the host or by themselves) get nothing, like any mention; a bulk "Mute all AIs"
 * (mute_scope 'ai') spares the owner's person member, as in roomPosted. Inside the caller's
 * transaction, after the line was written.
 */
export async function taskReviewNotice(
  tx: Tx,
  n: {
    roomId: string;
    seq: number;
    agentIds: readonly string[];
    fromAgentId: string;
    fromName: string;
    text: string;
    time: number;
  },
): Promise<void> {
  const message = (
    await tx.query<{ id: string }>('SELECT id FROM room_messages WHERE room_id=$1 AND seq=$2', [
      n.roomId,
      n.seq,
    ])
  ).rows[0];
  if (!message) return;
  const targets = (
    await tx.query<{ agent_id: string; owner_id: string; muted: boolean }>(
      `SELECT m.agent_id, m.owner_id,
          EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
            AND x.room_id=m.room_id AND (x.notifications_muted OR (x.muted_at IS NOT NULL
              AND (m.kind <> 'person' OR x.mute_scope IS DISTINCT FROM 'ai')))) AS muted
        FROM room_members m WHERE m.room_id=$1 AND m.agent_id = ANY($2::text[]) AND m.removed_at IS NULL`,
      [n.roomId, [...new Set(n.agentIds)].filter((id) => id !== n.fromAgentId)],
    )
  ).rows.filter((row) => !row.muted);
  const signals: WakeSignal[] = [];
  const mentioned: string[] = [];
  for (const target of [...targets].sort((a, b) => (a.agent_id < b.agent_id ? -1 : 1))) {
    const seq = await insertMention(tx, {
      agentId: target.agent_id,
      ownerId: target.owner_id,
      sourceKind: 'room',
      sourceId: message.id,
      roomId: n.roomId,
      sourceSeq: n.seq,
      contextId: null,
      fromAgentId: n.fromAgentId,
      fromName: n.fromName,
      fromOwnerLabel: null,
      excerpt: excerptAt(n.text, 0),
      time: n.time,
    });
    if (seq !== null) {
      mentioned.push(target.agent_id);
      signals.push({ kind: 'mention', id: target.agent_id, seq });
    }
  }
  if (!mentioned.length) return;
  const event = {
    kind: 'room_post',
    room_id: n.roomId,
    message_id: message.id,
    seq: n.seq,
    from_agent_id: n.fromAgentId,
  };
  const queued = await tx.query(
    `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
     SELECT w.id, w.agent_id, k.kinds, $3::jsonb, 1, 1, 0, $4, $4, w.kind FROM wake_webhooks w
     CROSS JOIN LATERAL (SELECT ARRAY(SELECT e FROM unnest(ARRAY['mention']) AS e
       WHERE e = ANY(w.events) ORDER BY e) AS kinds) k
     WHERE w.agent_id = ANY($2::text[]) AND w.disabled_at IS NULL AND cardinality(k.kinds) > 0
       AND (w.kind = 'https' OR EXISTS (
         SELECT 1 FROM rooms r WHERE r.id=$1 AND r.responders_allowed AND r.closed_at IS NULL))
     ORDER BY w.id
     ${UPSERT}`,
    [n.roomId, mentioned, JSON.stringify(event), n.time],
  );
  if (queued.rows.length) signals.push({ kind: 'outbox' });
  emit(tx, ...signals);
}
