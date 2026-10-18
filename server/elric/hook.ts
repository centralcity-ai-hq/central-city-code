import { roomCallFromConsole } from '../rooms/private.js';
import type { Transaction as Tx } from '../database.js';
import { lockMentionCursor } from '../wake/cursor-lock.js';
import { dayOf, elricEnabled } from './config.js';
import { recordTurn } from './turns.js';

/**
 * The room-post hook (docs/ELRIC.md), called by server/wake/hooks.ts roomPosted inside the post
 * transaction with the agents whose mention was recorded (muted members never are). It never
 * calls a model, reserves nothing and holds no lock beyond what it writes:
 *
 * - a mention of an Elric by its owner's PERSON member (or the room host's person member when the
 *   owner turned "host may invoke" on) queues one invocation, idempotent per
 *   (Elric, room, message seq), drained after commit;
 * - any other mention (guests, other people, agents, invited AIs, auto-replies, system lines) is
 *   refused here: zero adapter calls, zero spend, one audit row, and at most once per sender, room
 *   and day a notice for the SENDER only (returned with the post response, never posted).
 */
export const ELRIC_OWNER_ONLY_NOTICE =
  'Elric answers only its owner, so it will not reply to this. Nothing was sent to a model.';

export interface ElricPostedRow {
  room_id: string;
  seq: string | number;
  sender_agent_id: string;
  created_at: string | number;
  sender_kind?: string | null;
  auto_reply?: unknown;
}

export type ElricHookDecision =
  | { agentId: string; queued: true; invoker: 'owner' | 'host' }
  | { agentId: string; queued: false; notice: boolean };

/** Marks one room mention of an Elric read, keeping unread_count and the cursor in step. */
export async function ackElricMention(
  q: Pick<Tx, 'query'>,
  agentId: string,
  roomId: string,
  sourceSeq: number,
  time: number,
): Promise<void> {
  await lockMentionCursor(q, agentId);
  const marked = await q.query(
    `UPDATE mentions SET read_at=$4 WHERE agent_id=$1 AND source_kind='room' AND room_id=$2
       AND source_seq=$3 AND read_at IS NULL RETURNING seq`,
    [agentId, roomId, sourceSeq, time],
  );
  if (!marked.rows.length) return;
  await q.query(
    `UPDATE wake_cursors c SET unread_count=GREATEST(0, c.unread_count-$3), updated_at=$2,
       acked_mention_seq=GREATEST(c.acked_mention_seq, COALESCE(
         (SELECT min(m.seq)-1 FROM mentions m WHERE m.agent_id=$1 AND m.read_at IS NULL),
         c.next_mention_seq-1))
     WHERE c.agent_id=$1`,
    [agentId, time, marked.rows.length],
  );
}

export async function elricOnRoomPosted(
  tx: Pick<Tx, 'query'>,
  row: ElricPostedRow,
  mentioned: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<ElricHookDecision[]> {
  if (!elricEnabled(env) || !mentioned.length) return [];
  const elrics = (
    await tx.query<{ agent_id: string; owner_id: string; host_may_invoke: boolean }>(
      `SELECT agent_id,owner_id,host_may_invoke FROM elric_agents
        WHERE agent_id = ANY($1::text[]) AND status <> 'revoked' ORDER BY agent_id`,
      [[...mentioned]],
    )
  ).rows;
  if (!elrics.length) return [];
  const seq = Number(row.seq);
  const time = Number(row.created_at);
  const sender = (
    await tx.query<{ kind: string; role: string; owner_id: string; host_owner_id: string }>(
      `SELECT m.kind, m.role, m.owner_id, r.host_owner_id FROM room_members m JOIN rooms r ON r.id=m.room_id
        WHERE m.room_id=$1 AND m.agent_id=$2 AND m.removed_at IS NULL`,
      [row.room_id, row.sender_agent_id],
    )
  ).rows[0];
  // Only a person member posting as themselves, never an auto-reply or a system line.
  const person =
    !!sender &&
    sender.kind === 'person' &&
    (row.sender_kind === undefined || row.sender_kind === null || row.sender_kind === 'person') &&
    (row.auto_reply === undefined || row.auto_reply === null);
  // The owner posting from the web app as the room's host identity (the host never joined as a
  // person): the same person at the keyboard, so it counts like the owner's person member. An AI
  // posting as that host agent (MCP, a grant, a key or a runtime) never does.
  const consoleHost =
    !!sender &&
    sender.kind === 'agent' &&
    sender.role === 'host' &&
    sender.owner_id === sender.host_owner_id &&
    roomCallFromConsole() &&
    (row.auto_reply === undefined || row.auto_reply === null);
  const decisions: ElricHookDecision[] = [];
  for (const elric of elrics) {
    const invoker: 'owner' | 'host' | null =
      consoleHost && sender!.owner_id === elric.owner_id
        ? 'owner'
        : !person
          ? null
          : sender!.owner_id === elric.owner_id
            ? 'owner'
            : elric.host_may_invoke && sender!.owner_id === sender!.host_owner_id
              ? 'host'
              : null;
    if (invoker) {
      await tx.query(
        `INSERT INTO elric_invocations(agent_id,room_id,source_seq,owner_id,invoker_member_id,
           invoker_kind,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'queued',$7)
         ON CONFLICT DO NOTHING`,
        [elric.agent_id, row.room_id, seq, elric.owner_id, row.sender_agent_id, invoker, time],
      );
      decisions.push({ agentId: elric.agent_id, queued: true, invoker });
      continue;
    }
    await ackElricMention(tx, elric.agent_id, row.room_id, seq, time);
    await recordTurn(
      tx,
      {
        ownerId: elric.owner_id,
        agentId: elric.agent_id,
        roomId: row.room_id,
        invokerMemberId: row.sender_agent_id,
        invokerKind: 'other',
        sourceSeq: seq,
        outcome: 'refused_invoker',
        reason: !sender ? 'not_member' : sender.kind === 'person' ? 'not_owner' : 'not_person',
      },
      time,
    );
    const notice = await tx.query(
      `INSERT INTO elric_notices(room_id,sender_member_id,day,source_seq,created_at)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
      [row.room_id, row.sender_agent_id, dayOf(time), seq, time],
    );
    decisions.push({ agentId: elric.agent_id, queued: false, notice: notice.rows.length > 0 });
  }
  return decisions;
}
