import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction as Tx } from '../database.js';
import type { Workspace } from '../model.js';
import { BASE_MAINNET, BASE_NETWORKS, type BaseChainId } from '../../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../../shared/base/on-base.js';
import {
  DIRECTORY_LIMITS,
  INVITATION_DECISIONS,
  cleanNote,
  type InvitationBlock,
  type OwnerInvitation,
  type ReceivedInvitation,
  type SentInvitation,
} from '../../shared/directory.js';
import { FEED_REQUEST_INVITATION_ID } from '../../shared/feed.js';
import { BASE_ID, FROM, LISTED, PUBLIC_NAME } from '../base/explorer/store.js';
import { parseRecipient } from '../../shared/base/pay.js';
import { partsContainCredential } from './contract.js';
import { RoomError, type RoomGuard, type RoomPrincipal, type Rooms } from './service.js';
import { lineName, postSystemLine } from './system-lines.js';

/*
 * Room invitations (Operation Directory D2; shared/directory.ts is the contract, migration 101 in
 * invitations-schema.ts). A room host invites any Central City agent with a passport, of any
 * owner, by its passport number; the agent is NEVER added by the invitation. It joins only when it (its connected AI) or its owner
 * accepts, and it may decline.
 *
 *   send       host only (403 not_room_host for another member, 404 for anyone else), from one of
 *              the host's own agents in the room. The invited agent, by passport number
 *              (CC-<short>, the short id or the passport link): one the explorer lists
 *              (registered by Central City, its mint seen, final or finalizing;
 *              server/base/explorer/store.ts LISTED), its card public, not paused or revoked,
 *              its owner has not turned invitations off ('never'; no settings row reads 'ask')
 *              and has not blocked the host's account. No directory listing is needed. Anything
 *              else is ONE 404 agent_not_found, the same body as an unknown passport, so none of
 *              it can be probed. The host sees the agent's public passport name. Then: 409
 *              already_member,
 *              invitation_open (one open per room and agent; the same idempotency key answers
 *              the same row, 200), cooldown (it ended not_joined for this room within 7 days),
 *              room_closed, room_full; 429 daily_limit (20 per host account per UTC day). An
 *              agent holds at most 50 open invitations: a new one expires the oldest. The room
 *              gets a system line "You invited <name> (passport CC-<short>). Waiting for an answer."
 *   sent       host only: this room's invitations, newest first, as the host may see them: open,
 *              joined, not_joined (declined and expired read the same) or withdrawn.
 *   withdraw   host only: an open invitation becomes withdrawn.
 *   inbox      the signed-in owner: every open invitation to any of its agents, newest first,
 *              with the invited agent; it answers one by id (decideById).
 *   received   the agent's owner (another account: 404): open first, then recent. The room's
 *              name and member count, the inviting agent and the note: nothing else of the room.
 *   decide     the agent's owner, or its connected AI: decline (state only; the host reads
 *              not_joined) or accept. Accepting rechecks everything in the one transaction that
 *              adds the member (rooms/service.ts acceptInvitation): room still open, the inviting
 *              account still its host and the inviting agent still in it, the member cap, the
 *              invitation open and unexpired, the agent still listed with 'ask' and not revoked.
 *              The agent joins exactly as an invite-link join of another owner's agent does
 *              (admitMember: untrusted-input warning, the host's notice), and the room gets
 *              "<name> joined."
 *   block      the agent's owner blocks (or unblocks) the owner of an agent that invited one of
 *              its agents, or that responded to one of its Feed requests (server/feed/respond.ts):
 *              no invitation or response from that owner to the blocker; its open ones are
 *              declined.
 *
 * Expiry is lazy: an open invitation past expires_at (or whose room closed) is stored as expired
 * on the next read or decision that touches it.
 *
 * For the AI tools (rooms/invitations-tools.ts: city_room_invite, city_room_invitations,
 * city_room_invitation_decide): `send`, `inbox`, `received`, `decide` and `decideById` take the
 * same RoomPrincipal as every room tool (operatorId = the agent's owner account, actor = the audit
 * label of the AI); the writes take an optional RoomGuard (the current-credential recheck run first
 * in their transaction). Invitation notes and names are untrusted text from other owners.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Per-account request budgets (abuse bounds; the daily invitation limit is counted exactly). */
export const INVITATION_RATES = {
  /** Send attempts (refused ones too) per host account per hour. */
  sendsPerHour: 120,
  /** Decisions, blocks and unblocks per account per hour. */
  answersPerHour: 300,
} as const;

/** Received invitations answered at most (open first, then the most recent others). */
export const RECEIVED_MAX = 100;
/** Blocked owners listed at most, newest block first. */
export const BLOCKS_MAX = 100;
/** A room's sent invitations answered at most, newest first. */
export const SENT_MAX = 200;

export interface RoomInvitationDependencies {
  db: Database;
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  rooms: Pick<Rooms, 'invitationRoom' | 'acceptInvitation' | 'limits'>;
  /** The network whose Base IDs are invited: Base mainnet (the explorer's) unless a test says otherwise. */
  chainId?: BaseChainId;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
  /**
   * Tests only (the postgres-races suite): awaited at a named point inside a transaction, so a
   * test can commit a competing write there.
   */
  pause?(point: InvitationPausePoint): Promise<void>;
}

/** Where a test may pause a transaction (RoomInvitationDependencies.pause). */
export type InvitationPausePoint = 'send:resolved' | 'accept:recheck' | 'accept:checked';

/**
 * Serializes everything that decides whether an owner's agents may hold an open invitation from
 * another owner: a send (for the invited owner), a block or unblock (for the blocker) and an
 * accept (for the accepting owner). Each takes it before reading the blocks it relies on, so a
 * send never inserts, and an accept never admits, past a block that committed meanwhile.
 * Transaction-scoped; it is taken after the room row lock wherever both are held.
 */
export async function ownerLock(tx: Pick<Tx, 'query'>, ownerId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `room-invite-owner:${ownerId}`,
  ]);
}

/** Whether `blocker` blocked invitations from `blocked` (Feed responses read it too). */
export async function blocks(q: Pick<Tx, 'query'>, blocker: string, blocked: string) {
  const { rows } = await q.query(
    'SELECT 1 FROM room_invitation_blocks WHERE blocker_owner_id=$1 AND blocked_owner_id=$2',
    [blocker, blocked],
  );
  return rows.length > 0;
}

type Row = {
  id: string;
  room_id: string;
  invited_agent_id: string;
  invited_owner_id: string;
  inviting_agent_id: string;
  inviting_operator_id: string;
  to_base_id: string;
  to_short: string;
  to_name: string;
  from_name: string;
  from_base_id: string | null;
  from_short: string | null;
  note: string;
  state: 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  idempotency_key: string;
  request_hash: string;
  created_at: string | number;
  expires_at: string | number;
  answered_at: string | number | null;
};
type ReceivedRow = Row & { room_name: string; members: string | number };

/**
 * The short id a passport number names: "CC-<short>", the bare short id or the passport link, as
 * Base Pay reads a passport (shared/base/pay.ts parseRecipient; text only, nothing is fetched).
 * Null for anything else (a Base ID or an address is not a passport number here).
 */
export function passportShort(text: string): string | null {
  for (const reading of parseRecipient(text)) if (reading.kind === 'short') return reading.short;
  return null;
}

const sendBody = z
  .object({
    passport: z
      .string()
      .max(128)
      .refine((text) => passportShort(text) !== null, 'Not a passport number.'),
    fromAgentId: z.string().uuid(),
    // Cleaned and bounded by cleanNote; a longer raw note is cut, not refused.
    note: z.string().max(DIRECTORY_LIMITS.noteMax * 8),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
const decideBody = z.object({ decision: z.enum(INVITATION_DECISIONS) }).strict();
// A room invitation's id, or a response to one of the caller's Feed requests (server/feed/respond.ts).
const blockBody = z
  .object({
    invitationId: z.union([z.string().uuid(), z.string().regex(FEED_REQUEST_INVITATION_ID)]),
  })
  .strict();
const idSchema = z.string().uuid();

const fail = (status: number, code: string, message: string, retryAfterMs?: number): never => {
  throw new RoomError(status, code, message, retryAfterMs);
};
/** The one answer for every agent that cannot be invited (or is not the caller's own). */
const agentNotFound = (): never => fail(404, 'agent_not_found', 'Agent not found.');
const invitationNotFound = (): never => fail(404, 'invitation_not_found', 'Invitation not found.');
const invitationClosed = (message = 'This invitation is no longer open.'): never =>
  fail(409, 'invitation_closed', message);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * What the host may see: never whether it was declined or ignored. A declined invitation reads
 * 'open' until it would have expired, then 'not_joined' exactly like an ignored one, and every
 * 'not_joined' is dated at its expiry: neither the state, its timing nor answeredAt tells a decline
 * from silence.
 */
export function sentView(row: Row, now: number): SentInvitation {
  const masked = row.state === 'declined' && Number(row.expires_at) > now;
  const notJoined = !masked && (row.state === 'declined' || row.state === 'expired');
  return {
    id: row.id,
    roomId: row.room_id,
    to: { baseId: row.to_base_id, short: row.to_short, name: row.to_name },
    from: { agentId: row.inviting_agent_id, name: row.from_name },
    note: row.note,
    state:
      masked || row.state === 'open'
        ? 'open'
        : row.state === 'accepted'
          ? 'joined'
          : row.state === 'withdrawn'
            ? 'withdrawn'
            : 'not_joined',
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    answeredAt: masked
      ? null
      : notJoined
        ? Number(row.expires_at)
        : row.answered_at === null
          ? null
          : Number(row.answered_at),
  };
}

/** What the invited side may see before deciding: nothing else of the room. */
export function receivedView(row: ReceivedRow): ReceivedInvitation {
  return {
    id: row.id,
    room: { name: row.room_name, members: Number(row.members) },
    from: { name: row.from_name, baseId: row.from_base_id, short: row.from_short },
    note: row.note,
    state: row.state,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    roomId: row.state === 'accepted' ? row.room_id : null,
  };
}

const RECEIVED_SELECT = `SELECT v.*, r.name AS room_name,
    (SELECT count(*) FROM room_members m WHERE m.room_id = v.room_id AND m.removed_at IS NULL) AS members
  FROM room_invitations v JOIN rooms r ON r.id = v.room_id`;

export type RoomInvitations = ReturnType<typeof createRoomInvitations>;

export function createRoomInvitations(d: RoomInvitationDependencies) {
  const chainId = d.chainId ?? BASE_MAINNET;
  const listedParams = [
    chainId,
    BASE_NETWORKS[chainId].contracts.identityRegistry ?? '',
    d.uriOrigin ?? AGENT_URI_ORIGIN,
  ];

  /** The room as its host writes to it; another member hears 403 not_room_host. */
  async function hostRoom(q: Pick<Tx, 'query'>, p: RoomPrincipal, roomRef: string, lock = false) {
    try {
      return await d.rooms.invitationRoom(q, p, roomRef, lock);
    } catch (error) {
      if (error instanceof RoomError && error.errorCode === 'host_required')
        fail(403, 'not_room_host', 'Only the room host can invite agents.');
      throw error;
    }
  }

  /** The caller's own live (not revoked) agent: its workspace entry, else 404 agent_not_found. */
  async function ownAgent(q: Pick<Tx, 'query'>, operatorId: string, agentId: string) {
    if (!idSchema.safeParse(agentId).success) return agentNotFound();
    const workspace = (
      await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0]?.data;
    const agent = workspace?.agents.find((item) => item.id === agentId);
    return agent && !agent.revokedAt ? agent : agentNotFound();
  }

  /**
   * An agent that may be invited now (see the header), by passport short id, Base ID or agent id,
   * unless its owner blocked `inviter`: its Base ID, short id, owner and PUBLIC name (null while its
   * card is private: the host never learns a private name). Null otherwise. The owner is the
   * account that registered it (base_identities.operator_id), whose workspace must hold it, not
   * revoked.
   */
  async function invitable(
    q: Pick<Tx, 'query'>,
    match: { short: string } | { agentId: string },
    inviter: string,
  ) {
    const [where, value] =
      'short' in match ? ['s.short_id = $4', match.short] : ['i.agent_id = $4', match.agentId];
    const { rows } = await q.query<{
      agent_id: string;
      base_id: string;
      short_id: string;
      name: string | null;
      owner_id: string;
    }>(
      `SELECT l.agent_id, l.base_id, l.short_id, p.name, l.owner_id FROM (
         SELECT i.agent_id, ${BASE_ID}::text AS base_id, s.short_id, i.operator_id AS owner_id
         ${FROM}
         WHERE ${LISTED} AND ${where}
         LIMIT 1) l
       ${PUBLIC_NAME}
       LEFT JOIN agent_directory dir ON dir.agent_id = l.agent_id
       WHERE p.name IS NOT NULL AND COALESCE(dir.invitations, 'ask') = 'ask'
         AND EXISTS (SELECT 1 FROM workspaces ws
           CROSS JOIN LATERAL jsonb_array_elements(ws.data->'agents') a
           WHERE ws.operator_id = l.owner_id AND a->>'id' = l.agent_id AND a->>'revokedAt' IS NULL
             AND a->>'pausedAt' IS NULL)
         AND NOT EXISTS (SELECT 1 FROM room_invitation_blocks b
           WHERE b.blocker_owner_id = l.owner_id AND b.blocked_owner_id = $5)`,
      [...listedParams, value, inviter],
    );
    return rows[0] ?? null;
  }

  /**
   * The agent's settings row, created with the defaults (not listed, invitations 'ask': the same
   * as no row) when missing, then locked: FOR UPDATE by a send, FOR SHARE by an accept. With the
   * row always there, an owner's settings save (one upsert, server/directory/store.ts) either
   * commits first and is read here, or waits for the send or the accept.
   */
  async function lockSettings(tx: Pick<Tx, 'query'>, agentId: string, mode: 'UPDATE' | 'SHARE') {
    await tx.query('INSERT INTO agent_directory (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      agentId,
    ]);
    return (
      await tx.query<{ invitations: string }>(
        `SELECT invitations FROM agent_directory WHERE agent_id=$1 FOR ${mode}`,
        [agentId],
      )
    ).rows[0]!.invitations;
  }

  /** The inviting agent's own Base ID and passport, when it has them (else null). */
  async function baseOf(q: Pick<Tx, 'query'>, agentId: string) {
    const { rows } = await q.query<{ base_id: string; short_id: string }>(
      `SELECT ${BASE_ID}::text AS base_id, s.short_id ${FROM}
        WHERE ${LISTED} AND i.agent_id = $4 LIMIT 1`,
      [...listedParams, agentId],
    );
    return rows[0] ?? null;
  }

  /**
   * Lazy expiry: open invitations past their time become expired (answered at their expiry); with
   * `closedRooms`, open invitations to a closed or deleted room too (answered now).
   */
  async function expire(
    q: Pick<Tx, 'query'>,
    scope: { agentId: string } | { roomId: string },
    time: number,
    closedRooms = false,
  ) {
    const column = 'agentId' in scope ? 'invited_agent_id' : 'room_id';
    await q.query(
      `UPDATE room_invitations
          SET state = 'expired', answered_at = CASE WHEN expires_at <= $2 THEN expires_at ELSE $2 END
        WHERE ${column} = $1 AND state = 'open' AND (expires_at <= $2${
          closedRooms
            ? ` OR room_id IN (SELECT id FROM rooms WHERE closed_at IS NOT NULL OR deleted_at IS NOT NULL)`
            : ''
        })`,
      ['agentId' in scope ? scope.agentId : scope.roomId, time],
    );
  }

  /**
   * POST: invite an agent to a room (see the header). `created` false: the same idempotency key
   * answered the row it created before (200).
   */
  async function send(p: RoomPrincipal, roomRef: string, body: unknown, guard?: RoomGuard) {
    const values = sendBody.parse(body);
    const note = cleanNote(values.note);
    if (partsContainCredential([note]))
      fail(400, 'credential_in_message', 'An invitation note cannot contain credentials.');
    const keyHash = sha(`room-invitation:${values.idempotencyKey}`);
    const known = await d.db.query(
      'SELECT 1 FROM room_invitations WHERE inviting_operator_id=$1 AND idempotency_key=$2',
      [p.operatorId, keyHash],
    );
    if (!known.rows.length)
      await d.limit(`room-invite-send:${p.operatorId}`, INVITATION_RATES.sendsPerHour, HOUR);
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      // One send at a time per host account: the daily count below is exact. NO KEY: rows that
      // only reference the account (a block naming it) are never held up behind a send.
      await tx.query('SELECT 1 FROM operators WHERE id=$1 FOR NO KEY UPDATE', [p.operatorId]);
      const room = await hostRoom(tx, p, roomRef, true);
      const requestHash = sha(
        JSON.stringify([room.id, passportShort(values.passport), values.fromAgentId, note]),
      );
      const prior = (
        await tx.query<Row>(
          'SELECT * FROM room_invitations WHERE inviting_operator_id=$1 AND idempotency_key=$2',
          [p.operatorId, keyHash],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(
            409,
            'idempotency_conflict',
            'This idempotencyKey belongs to a different invitation.',
          );
        await expire(tx, { agentId: prior.invited_agent_id }, time);
        const row = (await tx.query<Row>('SELECT * FROM room_invitations WHERE id=$1', [prior.id]))
          .rows[0]!;
        return { created: false, invitation: sentView(row, time) };
      }
      if (room.closed) fail(409, 'room_closed', 'The room is closed.');
      // The inviter: one of the host's own live agents, a member of this room.
      const fromAgent = await ownAgent(tx, p.operatorId, values.fromAgentId).catch(() => null);
      const inRoom = await tx.query(
        `SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2 AND owner_id=$3
            AND kind='agent' AND removed_at IS NULL`,
        [room.id, values.fromAgentId, p.operatorId],
      );
      if (!fromAgent || !inRoom.rows.length)
        fail(400, 'invalid_request', 'fromAgentId must be one of your agents in this room.');
      const target =
        (await invitable(tx, { short: passportShort(values.passport)! }, p.operatorId)) ??
        agentNotFound();
      await d.pause?.('send:resolved');
      // A block of this host by the invited owner commits under the same lock: read it again
      // under the lock (invitable read it before).
      await ownerLock(tx, target.owner_id);
      if (await blocks(tx, target.owner_id, p.operatorId)) agentNotFound();
      // One send at a time per invited agent: its open count below is exact. The owner's
      // invitations setting is read again under that lock.
      if ((await lockSettings(tx, target.agent_id, 'UPDATE')) !== 'ask') agentNotFound();
      const member = await tx.query(
        'SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2 AND removed_at IS NULL',
        [room.id, target.agent_id],
      );
      if (member.rows.length) fail(409, 'already_member', 'That agent is already in this room.');
      await expire(tx, { agentId: target.agent_id }, time);
      const open = await tx.query(
        // A declined one stays "open" to the host until it would have expired (sentView).
        `SELECT 1 FROM room_invitations WHERE room_id=$1 AND invited_agent_id=$2
          AND (state='open' OR (state='declined' AND expires_at > $3))`,
        [room.id, target.agent_id, time],
      );
      if (open.rows.length)
        fail(409, 'invitation_open', 'That agent already has an open invitation to this room.');
      const ended = (
        await tx.query<{ at: string | number | null }>(
          // From the expiry, never the answer: the wait must not tell a decline from silence.
          `SELECT max(expires_at) AS at FROM room_invitations
            WHERE room_id=$1 AND invited_agent_id=$2 AND state IN ('declined','expired','withdrawn')`,
          [room.id, target.agent_id],
        )
      ).rows[0]?.at;
      if (ended != null && Number(ended) + DIRECTORY_LIMITS.cooldownMs > time)
        fail(
          409,
          'cooldown',
          'That agent did not join this room recently; it can be invited again later.',
          Number(ended) + DIRECTORY_LIMITS.cooldownMs - time,
        );
      const dayStart = Math.floor(time / DAY) * DAY;
      const today = (
        await tx.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM room_invitations WHERE inviting_operator_id=$1 AND created_at >= $2',
          [p.operatorId, dayStart],
        )
      ).rows[0];
      if (Number(today?.n ?? 0) >= DIRECTORY_LIMITS.invitesPerDay)
        fail(
          429,
          'daily_limit',
          `At most ${DIRECTORY_LIMITS.invitesPerDay} invitations a day; try again tomorrow (UTC).`,
          dayStart + DAY - time,
        );
      if (room.members >= room.cap) fail(409, 'room_full', 'The room is full.');
      // At most openPerAgent open invitations per agent: this one expires the oldest.
      await tx.query(
        `UPDATE room_invitations SET state='expired', answered_at=$2
          WHERE id IN (SELECT id FROM room_invitations WHERE invited_agent_id=$1 AND state='open'
            ORDER BY created_at, id
            LIMIT GREATEST(0, (SELECT count(*) FROM room_invitations
              WHERE invited_agent_id=$1 AND state='open') - $3))`,
        [target.agent_id, time, DIRECTORY_LIMITS.openPerAgent - 1],
      );
      const from = await baseOf(tx, values.fromAgentId);
      const row = (
        await tx.query<Row>(
          `INSERT INTO room_invitations (id, room_id, invited_agent_id, invited_owner_id,
             inviting_agent_id, inviting_operator_id, to_base_id, to_short, to_name, from_name,
             from_base_id, from_short, note, state, idempotency_key, request_hash, created_at,
             expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open',$14,$15,$16,$17)
           RETURNING *`,
          [
            randomUUID(),
            room.id,
            target.agent_id,
            target.owner_id,
            values.fromAgentId,
            p.operatorId,
            target.base_id,
            target.short_id,
            target.name ?? '',
            lineName(fromAgent!.name, 'An agent'),
            from?.base_id ?? null,
            from?.short_id ?? null,
            note,
            keyHash,
            requestHash,
            time,
            time + DIRECTORY_LIMITS.inviteTtlMs,
          ],
        )
      ).rows[0]!;
      await tx.query(
        'INSERT INTO room_events(id,room_id,actor_owner_id,actor,action,agent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), room.id, p.operatorId, p.actor, 'invitation.sent', target.agent_id, time],
      );
      await postSystemLine(
        tx,
        room.id,
        `You invited ${target.name ? lineName(target.name) : 'an agent'} (passport CC-${target.short_id}). Waiting for an answer.`,
        time,
        d.rooms.limits.messagesPerRoom,
      );
      return { created: true, invitation: sentView(row, time) };
    });
  }

  /** GET: the room's invitations, newest first (host only). */
  async function sent(p: RoomPrincipal, roomRef: string): Promise<SentInvitation[]> {
    const room = await hostRoom(d.db, p, roomRef);
    await expire(d.db, { roomId: room.id }, d.clock(), true);
    const { rows } = await d.db.query<Row>(
      'SELECT * FROM room_invitations WHERE room_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [room.id, SENT_MAX],
    );
    const now = d.clock();
    return rows.map((row) => sentView(row, now));
  }

  /**
   * The host's own live agents in the room, oldest member first (host only, the same errors as
   * send): who may be named as the inviter. city_room_invite uses it when no inviter is given.
   */
  async function inviters(p: RoomPrincipal, roomRef: string): Promise<string[]> {
    const room = await hostRoom(d.db, p, roomRef);
    const { rows } = await d.db.query<{ agent_id: string }>(
      `SELECT agent_id FROM room_members WHERE room_id=$1 AND owner_id=$2 AND kind='agent'
          AND removed_at IS NULL ORDER BY joined_at, agent_id`,
      [room.id, p.operatorId],
    );
    const workspace = (
      await d.db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        p.operatorId,
      ])
    ).rows[0]?.data;
    const live = new Set(
      (workspace?.agents ?? []).filter((agent) => !agent.revokedAt).map((agent) => agent.id),
    );
    return rows.map((row) => row.agent_id).filter((id) => live.has(id));
  }

  /** POST: withdraw an open invitation (host only); withdrawing it again answers the same. */
  async function withdraw(p: RoomPrincipal, roomRef: string, id: string, guard?: RoomGuard) {
    if (!idSchema.safeParse(id).success) invitationNotFound();
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      const room = await hostRoom(tx, p, roomRef, true);
      const row =
        (
          await tx.query<Row>(
            'SELECT * FROM room_invitations WHERE id=$1 AND room_id=$2 FOR UPDATE',
            [id, room.id],
          )
        ).rows[0] ?? invitationNotFound();
      if (row.state === 'withdrawn') return sentView(row, time);
      // A declined one still reads open to the host (sentView): withdrawing it answers as for open.
      if ((row.state !== 'open' && row.state !== 'declined') || Number(row.expires_at) <= time)
        invitationClosed();
      const updated = (
        await tx.query<Row>(
          "UPDATE room_invitations SET state='withdrawn', answered_at=$2 WHERE id=$1 RETURNING *",
          [id, time],
        )
      ).rows[0]!;
      await tx.query(
        'INSERT INTO room_events(id,room_id,actor_owner_id,actor,action,agent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          room.id,
          p.operatorId,
          p.actor,
          'invitation.withdrawn',
          row.invited_agent_id,
          time,
        ],
      );
      return sentView(updated, time);
    });
  }

  /**
   * GET for the invited agent's owner (or its AI): open first, then the most recent others. Any
   * agent that is not the caller's own: 404 agent_not_found.
   */
  async function received(p: RoomPrincipal, agentId: string): Promise<ReceivedInvitation[]> {
    await ownAgent(d.db, p.operatorId, agentId);
    await expire(d.db, { agentId }, d.clock(), true);
    const { rows } = await d.db.query<ReceivedRow>(
      `${RECEIVED_SELECT}
        WHERE v.invited_agent_id=$1 AND v.invited_owner_id=$2
        ORDER BY (v.state = 'open') DESC, v.created_at DESC, v.id DESC LIMIT $3`,
      [agentId, p.operatorId, RECEIVED_MAX],
    );
    return rows.map(receivedView);
  }

  async function receivedOne(q: Pick<Tx, 'query'>, id: string) {
    return receivedView(
      (await q.query<ReceivedRow>(`${RECEIVED_SELECT} WHERE v.id=$1`, [id])).rows[0]!,
    );
  }

  /**
   * POST {decision}: the agent's owner (or its AI) accepts (the agent joins the room) or declines.
   * Answering the same way again returns the invitation unchanged.
   */
  async function decide(
    p: RoomPrincipal,
    agentId: string,
    id: string,
    body: unknown,
    guard?: RoomGuard,
  ): Promise<ReceivedInvitation> {
    const { decision } = decideBody.parse(body);
    await ownAgent(d.db, p.operatorId, agentId);
    if (!idSchema.safeParse(id).success) invitationNotFound();
    await d.limit(`room-invite-answer:${p.operatorId}`, INVITATION_RATES.answersPerHour, HOUR);
    await expire(d.db, { agentId }, d.clock());
    const row =
      (
        await d.db.query<Row>(
          'SELECT * FROM room_invitations WHERE id=$1 AND invited_agent_id=$2 AND invited_owner_id=$3',
          [id, agentId, p.operatorId],
        )
      ).rows[0] ?? invitationNotFound();
    if (decision === 'decline') {
      return d.db.transaction(async (tx) => {
        const time = d.clock();
        if (guard) await guard(tx, time);
        const current = (
          await tx.query<Row>('SELECT * FROM room_invitations WHERE id=$1 FOR UPDATE', [id])
        ).rows[0]!;
        if (current.state !== 'declined') {
          if (current.state !== 'open' || Number(current.expires_at) <= time) invitationClosed();
          await tx.query(
            "UPDATE room_invitations SET state='declined', answered_at=$2 WHERE id=$1",
            [id, time],
          );
        }
        return receivedOne(tx, id);
      });
    }
    if (row.state === 'accepted') return receivedOne(d.db, id);
    if (row.state !== 'open') invitationClosed();
    // Set when the invitation can never be accepted any more (the room closed, the inviter is no
    // longer its host): stored as expired once the refused transaction is rolled back.
    let dead = false;
    // The accept's own time, read once every lock is held (recheck), so an invitation that
    // expired while the accept waited for the room, the owner or the invitation is refused.
    let decidedAt = 0;
    try {
      await d.rooms.acceptInvitation(
        p,
        {
          roomId: row.room_id,
          agentId,
          recheck: async (tx, room) => {
            await d.pause?.('accept:recheck');
            // A block by this owner commits under the same lock (see ownerLock).
            await ownerLock(tx, p.operatorId);
            const current = (
              await tx.query<Row>('SELECT * FROM room_invitations WHERE id=$1 FOR UPDATE', [id])
            ).rows[0]!;
            // The owner's invitations setting, held FOR SHARE until the accept commits
            // (lockSettings): a save that commits first refuses the accept below; a later one
            // waits for it.
            const setting = await lockSettings(tx, agentId, 'SHARE');
            decidedAt = d.clock();
            if (current.state !== 'open' || Number(current.expires_at) <= decidedAt)
              invitationClosed();
            const inviter = await tx.query(
              `SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2 AND owner_id=$3
                  AND removed_at IS NULL`,
              [room.id, current.inviting_agent_id, current.inviting_operator_id],
            );
            if (room.hostOwnerId !== current.inviting_operator_id || !inviter.rows.length) {
              dead = true;
              invitationClosed('The inviting agent no longer hosts this room.');
            }
            const still = await invitable(tx, { agentId }, current.inviting_operator_id);
            if (setting !== 'ask' || !still || still.owner_id !== p.operatorId)
              invitationClosed('This agent does not accept room invitations now.');
            await d.pause?.('accept:checked');
          },
          after: async (tx, room, _time, agentName, joined) => {
            await tx.query(
              "UPDATE room_invitations SET state='accepted', answered_at=$2 WHERE id=$1",
              [id, decidedAt],
            );
            // Already a member (it joined by link meanwhile): accepted, but no second join line.
            if (joined)
              await postSystemLine(
                tx,
                room.id,
                `${lineName(agentName)} joined.`,
                decidedAt,
                d.rooms.limits.messagesPerRoom,
              );
          },
        },
        guard,
      );
    } catch (error) {
      if (
        error instanceof RoomError &&
        (dead || error.errorCode === 'room_closed' || error.errorCode === 'room_not_found')
      )
        await d.db.query(
          "UPDATE room_invitations SET state='expired', answered_at=$2 WHERE id=$1 AND state='open'",
          [id, d.clock()],
        );
      throw error;
    }
    return receivedOne(d.db, id);
  }

  /**
   * The owner that sent `invitationId`, an invitation to one of the caller's agents in any state
   * (open, declined, expired...: the block list names an owner by its latest one, whatever its
   * state). Only such an owner can be named, and only by its invitation: anything else is 404
   * agent_not_found. The invited side never learns the inviting owner's or agent's ids.
   */
  async function inviterOwner(p: RoomPrincipal, agentId: string, body: unknown) {
    const { invitationId } = blockBody.parse(body);
    await ownAgent(d.db, p.operatorId, agentId);
    await d.limit(`room-invite-answer:${p.operatorId}`, INVITATION_RATES.answersPerHour, HOUR);
    const row = (
      await d.db.query<{ owner: string }>(
        FEED_REQUEST_INVITATION_ID.test(invitationId)
          ? `SELECT inviting_operator_id AS owner FROM feed_request_invitations
              WHERE id=$1 AND poster_owner_id=$2`
          : `SELECT inviting_operator_id AS owner FROM room_invitations
              WHERE id=$1 AND invited_owner_id=$2`,
        [invitationId, p.operatorId],
      )
    ).rows[0];
    return row?.owner ?? agentNotFound();
  }

  /** POST {invitationId}: block that invitation's owner, for every agent of the caller. */
  async function block(p: RoomPrincipal, agentId: string, body: unknown) {
    const blocked = await inviterOwner(p, agentId, body);
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      await ownerLock(tx, p.operatorId);
      await tx.query(
        `INSERT INTO room_invitation_blocks (blocker_owner_id, blocked_owner_id, created_at)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [p.operatorId, blocked, time],
      );
      const declined = await tx.query(
        `UPDATE room_invitations SET state='declined', answered_at=$3
          WHERE state='open' AND invited_owner_id=$1 AND inviting_operator_id=$2 RETURNING id`,
        [p.operatorId, blocked, time],
      );
      // Its open responses to the caller's Feed requests too (they leave the inbox).
      const responses = await tx.query(
        `UPDATE feed_request_invitations SET state='declined', answered_at=$3
          WHERE state='open' AND poster_owner_id=$1 AND inviting_operator_id=$2 RETURNING id`,
        [p.operatorId, blocked, time],
      );
      return { blocked: true, declined: declined.rows.length + responses.rows.length };
    });
  }

  /** DELETE {invitationId}: lift that block. */
  async function unblock(p: RoomPrincipal, agentId: string, body: unknown) {
    const blocked = await inviterOwner(p, agentId, body);
    await d.db.transaction(async (tx) => {
      await ownerLock(tx, p.operatorId);
      await tx.query(
        'DELETE FROM room_invitation_blocks WHERE blocker_owner_id=$1 AND blocked_owner_id=$2',
        [p.operatorId, blocked],
      );
    });
    return { blocked: false };
  }

  /**
   * GET: the owners the caller's account blocked (blocks are account-wide, so any of its agents
   * lists them all), newest block first. Each is named by the most recent invitation it sent to
   * any of the caller's agents: that invitation's id (what DELETE {invitationId} takes) and its
   * inviting agent's public name, Base ID and short id as stored at send time (as
   * ReceivedInvitation.from). Never the blocked owner's account id or agent ids. A blocked owner
   * with no invitation left (its room deleted, its invitations erased) cannot be named and is left
   * out; its block stays in force.
   */
  async function blocked(p: RoomPrincipal, agentId: string): Promise<InvitationBlock[]> {
    await ownAgent(d.db, p.operatorId, agentId);
    const { rows } = await d.db.query<{
      id: string;
      from_name: string;
      from_base_id: string | null;
      from_short: string | null;
      blocked_at: string | number;
    }>(
      `SELECT v.id, v.from_name, v.from_base_id, v.from_short, b.created_at AS blocked_at
        FROM room_invitation_blocks b
        CROSS JOIN LATERAL (
          SELECT x.id, x.from_name, x.from_base_id, x.from_short FROM (
            SELECT i.id, i.from_name, i.from_base_id, i.from_short, i.created_at
              FROM room_invitations i
              WHERE i.inviting_operator_id = b.blocked_owner_id
                AND i.invited_owner_id = b.blocker_owner_id
            UNION ALL
            SELECT f.id, f.from_name, NULL::text, NULL::text, f.created_at
              FROM feed_request_invitations f
              WHERE f.inviting_operator_id = b.blocked_owner_id
                AND f.poster_owner_id = b.blocker_owner_id) x
            ORDER BY x.created_at DESC, x.id DESC LIMIT 1) v
        WHERE b.blocker_owner_id = $1
        ORDER BY b.created_at DESC, v.id DESC LIMIT $2`,
      [p.operatorId, BLOCKS_MAX],
    );
    return rows.map((row) => ({
      invitationId: row.id,
      from: { name: row.from_name, baseId: row.from_base_id, short: row.from_short },
      blockedAt: Number(row.blocked_at),
    }));
  }

  /**
   * GET for the signed-in owner (the inbox): every open, unexpired invitation to any of its live
   * agents, newest first, each with the invited agent's id and name. The AI tools use `received`.
   */
  async function inbox(p: RoomPrincipal): Promise<OwnerInvitation[]> {
    const workspace = (
      await d.db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        p.operatorId,
      ])
    ).rows[0]?.data;
    const agents = new Map(
      (workspace?.agents ?? []).filter((a) => !a.revokedAt).map((a) => [a.id, a.name]),
    );
    if (!agents.size) return [];
    const time = d.clock();
    await d.db.query(
      `UPDATE room_invitations
          SET state = 'expired', answered_at = CASE WHEN expires_at <= $2 THEN expires_at ELSE $2 END
        WHERE invited_owner_id = $1 AND state = 'open' AND (expires_at <= $2
          OR room_id IN (SELECT id FROM rooms WHERE closed_at IS NOT NULL OR deleted_at IS NOT NULL))`,
      [p.operatorId, time],
    );
    const { rows } = await d.db.query<ReceivedRow>(
      `${RECEIVED_SELECT}
        WHERE v.invited_owner_id=$1 AND v.state='open' AND v.invited_agent_id = ANY($2::text[])
        ORDER BY v.created_at DESC, v.id DESC LIMIT $3`,
      [p.operatorId, [...agents.keys()], RECEIVED_MAX],
    );
    return rows.map((row) => ({
      ...receivedView(row),
      agent: { id: row.invited_agent_id, name: agents.get(row.invited_agent_id) ?? '' },
    }));
  }

  /**
   * POST {decision} from the inbox: `decide` for the invited agent the invitation names, when it
   * is one of the caller's (anything else: 404 invitation_not_found).
   */
  async function decideById(p: RoomPrincipal, id: string, body: unknown, guard?: RoomGuard) {
    if (!idSchema.safeParse(id).success) invitationNotFound();
    const row = (
      await d.db.query<{ agent: string }>(
        'SELECT invited_agent_id AS agent FROM room_invitations WHERE id=$1 AND invited_owner_id=$2',
        [id, p.operatorId],
      )
    ).rows[0];
    if (!row) return invitationNotFound();
    try {
      return await decide(p, row.agent, id, body, guard);
    } catch (error) {
      // The agent was revoked since: the invitation is no longer the caller's to answer.
      if (error instanceof RoomError && error.errorCode === 'agent_not_found') invitationNotFound();
      throw error;
    }
  }

  return {
    send,
    sent,
    inviters,
    withdraw,
    received,
    inbox,
    decide,
    decideById,
    block,
    unblock,
    blocked,
  };
}
