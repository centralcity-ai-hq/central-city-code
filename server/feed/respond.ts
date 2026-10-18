/*
 * Feed Respond (P4, docs/FEED_RESPOND.md; shared/feed.ts is the contract, migration 108 in
 * respond-schema.ts): Respond on a signed-in request sends a room invitation addressed to the
 * request. The poster accepts or declines in Messages (the owner invitations inbox,
 * rooms/invitations-routes.ts). Identities stay hidden both ways.
 *
 *   send       a signed-in account, from a room it hosts (403 not_room_host for another member,
 *              404 room_not_found for anyone else) or a new room named after the request (created
 *              under a key derived from the idempotency key, so a retry never makes a second
 *              room), as one of its live agents in that room. Only an open, visible, unexpired
 *              request with an owner: anything else (anonymous, held, hidden, closed, expired,
 *              unknown) is ONE 404 request_not_found. The caller's own request: 409 own_request.
 *              The note goes through the request text rules (policy.ts): refused with the same
 *              sentence as a request, and a note a request would be held for is refused too
 *              (there is no review queue for notes). One open response per request and room (409
 *              response_open; the same idempotency key answers the same row, 200). Limits: 20
 *              per responder account per rolling hour, 50 open per request (429, Retry-After).
 *              A new room is made only once those checks pass, in the transaction that makes it, so
 *              a refused send leaves no room behind (two sends racing past the checks at once can
 *              still leave one; the window is that short).
 *              A responder the poster blocked (room_invitation_blocks) is answered exactly as if
 *              it were sent; the row is stored declined and never reaches the poster.
 *   mine       the responder: its own responses to a request, as it may see them (sentView).
 *   withdraw   the responder: an open response becomes withdrawn and leaves the poster's inbox.
 *   count      the poster only: open and accepted (never public).
 *   inbox      the poster: every open response to its requests, newest first, each with the
 *              agent Accept joins by default (the request's agent while it is live).
 *   decide     the poster: decline (state only; the responder reads not_joined, as for silence)
 *              or accept with the chosen agent (default the request's). Accepting rechecks
 *              everything in the one transaction that adds the member (rooms/service.ts
 *              acceptInvitation, the same join path as directory invitations): the request still
 *              open (and not in review: one hidden by reports waits for its review, which lists it
 *              again or removes it), the response open and unexpired, the inviting account still
 *              the room's host and its agent still in it, no block, then the agent live and not
 *              paused, the member cap. The room gets "<name> joined."
 *
 * Closing, expiring or removing a request ends its responses in the same statement or transaction
 * (requests.ts, review.ts; respond-schema.ts endWithResponses). Expiry is otherwise lazy: an open
 * response past expires_at, whose request is no longer open or whose room closed is stored as
 * expired on the next read or decision touching it. Either way it ends when its request or room
 * did (never later than its own expiry), and a declined one is cut to end then too, so the
 * responder reads a declined and an ignored response the same, before and after the end.
 *
 * Privacy: the poster sees the agent name, the room's name and member count and the note; the
 * responder sees open, joined, not_joined or withdrawn. Neither view carries the other side's
 * account, email or workspace ids.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction as Tx } from '../database.js';
import type { Workspace } from '../model.js';
import {
  FEED_REQUEST_ID,
  FEED_REQUEST_INVITATION_ID,
  FEED_RESPOND_LIMITS,
  type FeedRequestInvitation,
  type FeedResponseCount,
  type FeedResponseSent,
} from '../../shared/feed.js';
import { partsContainCredential } from '../rooms/contract.js';
import { blocks, INVITATION_RATES, ownerLock } from '../rooms/invitations.js';
import { RoomError, type RoomPrincipal, type Rooms } from '../rooms/service.js';
import { lineName, postSystemLine } from '../rooms/system-lines.js';
import { checkRequestText, cleanText, codePoints } from './policy.js';

const HOUR = 3_600_000;

/** Send attempts (refused ones too) per responder account per hour: an abuse bound. */
export const RESPOND_ATTEMPTS_PER_HOUR = 120;
/** Responses the inbox answers at most, newest first. */
export const RESPOND_INBOX_MAX = 100;

export interface FeedRespondDependencies {
  db: Database;
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  rooms: Pick<Rooms, 'create' | 'invitationRoom' | 'acceptInvitation' | 'limits'>;
  /**
   * Tests only: awaited at a named point inside a transaction, so a test can commit a competing
   * write there.
   */
  pause?(point: FeedRespondPausePoint): Promise<void>;
}

/** Where a test may pause a transaction (FeedRespondDependencies.pause). */
export type FeedRespondPausePoint = 'send:checked' | 'accept:recheck' | 'accept:checked';

type State = 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
type Row = {
  id: string;
  request_id: string;
  room_id: string;
  inviting_agent_id: string;
  inviting_operator_id: string;
  from_name: string;
  room_name: string;
  note: string;
  poster_owner_id: string;
  accepted_agent_id: string | null;
  state: State;
  idempotency_key: string;
  request_hash: string;
  created_at: string | number;
  expires_at: string | number;
  answered_at: string | number | null;
};
type InboxRow = Row & { title: string; members: string | number; request_agent_id: string | null };
type RequestRow = {
  id: string;
  state: string;
  title: string;
  owner_id: string | null;
  agent_id: string | null;
  hidden_at: string | number | null;
  expires_at: string | number;
};

const sendBody = z
  .object({
    roomId: z.string().min(1).max(200).optional(),
    newRoom: z.literal(true).optional(),
    fromAgentId: z.string().uuid(),
    // Checked against FEED_RESPOND_LIMITS.noteMax once cleaned (refused, not cut).
    note: z.string().max(FEED_RESPOND_LIMITS.noteMax * 4),
    idempotencyKey: z.string().regex(/^[\x21-\x7e]{8,128}$/),
  })
  .strict()
  .refine((body) => (body.roomId === undefined) !== (body.newRoom === undefined), {
    message: 'Send either roomId or newRoom: true.',
  });
const decideBody = z
  .object({ decision: z.enum(['accept', 'decline']), agentId: z.string().max(64).optional() })
  .strict();

const fail = (status: number, code: string, message: string, retryAfterMs?: number): never => {
  throw new RoomError(status, code, message, retryAfterMs);
};
/** The one answer for every request that cannot receive a response (or be counted by the caller). */
const requestNotFound = (): never =>
  fail(404, 'request_not_found', 'This request is not on the Feed.');
const invitationNotFound = (): never => fail(404, 'invitation_not_found', 'Invitation not found.');
const invitationClosed = (message = 'This invitation is no longer open.'): never =>
  fail(409, 'invitation_closed', message);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newId = () => `fri_${Array.from(randomBytes(20), (byte) => BASE32[byte & 31]).join('')}`;

/**
 * What the responder may see: never whether it was declined or ignored (as for directory
 * invitations, rooms/invitations.ts sentView). A declined response reads 'open' until it would
 * have expired, then 'not_joined' like an ignored one, dated at its expiry.
 */
export function sentView(row: Row, now: number): FeedResponseSent {
  const masked = row.state === 'declined' && Number(row.expires_at) > now;
  const notJoined = !masked && (row.state === 'declined' || row.state === 'expired');
  return {
    id: row.id,
    requestId: row.request_id,
    roomId: row.room_id,
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

/** The poster's view: nothing of the responder's account, nothing else of the room. */
function posterView(row: InboxRow, agents: Map<string, string>): FeedRequestInvitation {
  const agentId = row.state === 'accepted' ? row.accepted_agent_id : (row.request_agent_id ?? null);
  const name = agentId === null ? undefined : agents.get(agentId);
  return {
    kind: 'feed_request',
    id: row.id,
    request: { id: row.request_id, title: row.title },
    room: { name: row.room_name, members: Number(row.members) },
    from: { name: row.from_name },
    note: row.note,
    state: row.state,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    roomId: row.state === 'accepted' ? row.room_id : null,
    agent: agentId !== null && name !== undefined ? { id: agentId, name } : null,
  };
}

const INBOX_SELECT = `SELECT v.*, q.title, q.agent_id AS request_agent_id,
    (SELECT count(*) FROM room_members m WHERE m.room_id = v.room_id AND m.removed_at IS NULL) AS members
  FROM feed_request_invitations v JOIN feed_requests q ON q.id = v.request_id`;

/**
 * Lazy expiry of the responses in `where` (over `v`): each ends at the earliest of its own
 * expiry, the end of its request (closed, expired, removed or past its expiry) and the closing or
 * deletion of its room, once that time has come. An open one is stored as expired then; a
 * declined one is cut to end then (as respond-schema.ts END_RESPONSES does), so the responder
 * reads it exactly as an ignored one. The end time comes from the rows, never from when they are
 * read: responses that ended together read the same, whoever read them first.
 */
async function expireStale(q: Pick<Tx, 'query'>, where: string, params: unknown[], time: number) {
  const at = `$${params.length + 1}`;
  await q.query(
    `WITH due AS (
       SELECT v.id, LEAST(v.expires_at,
           (SELECT CASE WHEN q.state = 'open' AND q.expires_at > ${at} THEN NULL
                        WHEN q.state = 'open' THEN q.expires_at
                        ELSE coalesce(q.closed_at, q.reviewed_at, ${at}) END
              FROM feed_requests q WHERE q.id = v.request_id),
           (SELECT LEAST(r.closed_at, r.deleted_at) FROM rooms r WHERE r.id = v.room_id)) AS end_at
         FROM feed_request_invitations v
        WHERE ${where} AND v.state IN ('open', 'declined'))
     UPDATE feed_request_invitations v
        SET state = CASE WHEN v.state = 'open' THEN 'expired' ELSE v.state END,
            answered_at = CASE WHEN v.state = 'open' THEN d.end_at ELSE v.answered_at END,
            expires_at = d.end_at
       FROM due d
      WHERE v.id = d.id AND v.state IN ('open', 'declined') AND d.end_at <= ${at}
        AND (v.state = 'open' OR d.end_at < v.expires_at)`,
    [...params, time],
  );
}

/** At most `max` UTF-16 units of `text` (what a room name's length counts), never half a pair. */
function cutUnits(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/** The workspace's live (not revoked) agents, id → name. */
async function liveAgents(q: Pick<Tx, 'query'>, operatorId: string) {
  const workspace = (
    await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
      operatorId,
    ])
  ).rows[0]?.data;
  return new Map(
    (workspace?.agents ?? []).filter((a) => !a.revokedAt).map((a) => [a.id, a.name] as const),
  );
}

/**
 * The note as stored: cleaned like a request's description and checked by the same rules
 * (contact details, links, keys), refused with the same sentence. Throws the refusal.
 */
export function checkNote(raw: string): string {
  const note = cleanText(raw);
  if (codePoints(note) > FEED_RESPOND_LIMITS.noteMax)
    fail(
      400,
      'invalid_request',
      `The note may have at most ${FEED_RESPOND_LIMITS.noteMax} characters.`,
    );
  if (!note) return '';
  if (partsContainCredential([note]))
    fail(400, 'invalid_request', 'Text may not contain a key, a token or a recovery phrase.');
  const checked = checkRequestText({
    title: 'Response note',
    description: note,
    displayName: null,
    capabilities: [],
  });
  if (!checked.ok) return fail(400, 'invalid_request', checked.message);
  // A request with this text would wait for review; a note has no review, so it is not sent.
  if (checked.held)
    fail(400, 'invalid_request', 'This note cannot be sent as written. Keep it to the work.');
  return checked.description;
}

export type FeedRespond = ReturnType<typeof createFeedRespond>;

export function createFeedRespond(d: FeedRespondDependencies) {
  /** The room as its host writes to it; another member hears 403 not_room_host. */
  async function hostRoom(q: Pick<Tx, 'query'>, p: RoomPrincipal, roomRef: string, lock = false) {
    try {
      return await d.rooms.invitationRoom(q, p, roomRef, lock);
    } catch (error) {
      if (error instanceof RoomError && error.errorCode === 'host_required')
        fail(403, 'not_room_host', 'Only the room host can respond from this room.');
      throw error;
    }
  }

  /** An open, visible, unexpired request with an owner; else the one 404. */
  async function respondable(q: Pick<Tx, 'query'>, id: string, time: number, lock = '') {
    if (!FEED_REQUEST_ID.test(id)) return requestNotFound();
    const row = (
      await q.query<RequestRow>(
        `SELECT id, state, title, owner_id, agent_id, hidden_at, expires_at FROM feed_requests
          WHERE id=$1 ${lock}`,
        [id],
      )
    ).rows[0];
    if (
      !row ||
      row.state !== 'open' ||
      row.hidden_at !== null ||
      Number(row.expires_at) <= time ||
      row.owner_id === null
    )
      return requestNotFound();
    return row as RequestRow & { owner_id: string };
  }

  /**
   * The send limits: 20 per responder account per rolling hour, 50 open (and unexpired) per
   * request (429).
   */
  async function withinLimits(
    q: Pick<Tx, 'query'>,
    operatorId: string,
    requestId: string,
    time: number,
  ) {
    const sentThisHour = (
      await q.query<{ n: string | number; oldest: string | number | null }>(
        `SELECT count(*) AS n, min(created_at) AS oldest FROM feed_request_invitations
          WHERE inviting_operator_id=$1 AND created_at > $2`,
        [operatorId, time - HOUR],
      )
    ).rows[0]!;
    if (Number(sentThisHour.n) >= FEED_RESPOND_LIMITS.perAccountHour)
      fail(
        429,
        'rate_limited',
        `At most ${FEED_RESPOND_LIMITS.perAccountHour} responses an hour. Try again later.`,
        Number(sentThisHour.oldest) + HOUR - time,
      );
    const openHere = (
      await q.query<{ n: string | number; first: string | number | null }>(
        `SELECT count(*) AS n, min(expires_at) AS first FROM feed_request_invitations
          WHERE request_id=$1 AND state='open' AND expires_at > $2`,
        [requestId, time],
      )
    ).rows[0]!;
    if (Number(openHere.n) >= FEED_RESPOND_LIMITS.openPerRequest)
      fail(
        429,
        'rate_limited',
        'This request has many open responses. Try again later.',
        Number(openHere.first) - time,
      );
  }

  /** What a key is bound to: the request, the room (or "new"), the agent and the cleaned note. */
  const requestHashOf = (requestId: string, values: z.infer<typeof sendBody>): string =>
    sha(
      JSON.stringify([
        requestId,
        values.newRoom ? 'new' : values.roomId,
        values.fromAgentId,
        cleanText(values.note),
      ]),
    );

  async function priorOf(q: Pick<Tx, 'query'>, operatorId: string, keyHash: string) {
    return (
      await q.query<Row>(
        'SELECT * FROM feed_request_invitations WHERE inviting_operator_id=$1 AND idempotency_key=$2',
        [operatorId, keyHash],
      )
    ).rows[0];
  }

  /** The same key again: the same response (and room), or 409 when the key was used differently. */
  async function replay(q: Pick<Tx, 'query'>, prior: Row, requestHash: string, time: number) {
    if (prior.request_hash !== requestHash)
      fail(409, 'idempotency_conflict', 'This idempotencyKey belongs to a different response.');
    await expireStale(q, 'v.id = $1', [prior.id], time);
    const row = (
      await q.query<Row>('SELECT * FROM feed_request_invitations WHERE id=$1', [prior.id])
    ).rows[0]!;
    return { created: false, response: sentView(row, time) };
  }

  /**
   * POST: respond to a request (see the header). `created` false: the same idempotency key
   * answered the row it created before (200).
   */
  async function send(p: RoomPrincipal, requestId: string, body: unknown) {
    const values = sendBody.parse(body);
    const keyHash = sha(`feed-respond:${values.idempotencyKey}`);
    const known = await priorOf(d.db, p.operatorId, keyHash);
    // A replay is answered before any check: the request may have closed since.
    if (known)
      return d.db.transaction((tx) =>
        replay(tx, known, requestHashOf(requestId, values), d.clock()),
      );
    // Charged before any content check, so probing the filters costs budget.
    await d.limit(`feed-respond:${p.operatorId}`, RESPOND_ATTEMPTS_PER_HOUR, HOUR);
    const request = await respondable(d.db, requestId, d.clock());
    if (request.owner_id === p.operatorId) fail(409, 'own_request', 'This is your own request.');
    const note = checkNote(values.note);
    const requestHash = requestHashOf(request.id, values);
    let roomRef = values.roomId;
    if (values.newRoom) {
      // Keyed by the response's own key: a retry finds the room the first attempt made. Made only
      // while the send passes its limits (checked again, exactly, when it is sent).
      const created = (await d.rooms.create(
        p,
        {
          agent_id: values.fromAgentId,
          name: cutUnits(request.title, 80).trim(),
          idempotency_key: `feed-respond-room:${sha(values.idempotencyKey).slice(0, 48)}`,
        },
        async (tx, time) => {
          await respondable(tx, request.id, time);
          await withinLimits(tx, p.operatorId, request.id, time);
        },
      )) as { room: { id: string } };
      roomRef = created.room.id;
    }
    try {
      return await d.db.transaction(async (tx) => {
        const time = d.clock();
        // One send at a time per responder account: the hourly count below is exact.
        await tx.query('SELECT 1 FROM operators WHERE id=$1 FOR NO KEY UPDATE', [p.operatorId]);
        const prior = await priorOf(tx, p.operatorId, keyHash);
        if (prior) return replay(tx, prior, requestHash, time);
        const room = await hostRoom(tx, p, roomRef!, true);
        if (room.closed) fail(409, 'room_closed', 'The room is closed.');
        // The inviter: one of the caller's own live agents, a member of this room.
        const agents = await liveAgents(tx, p.operatorId);
        const inRoom = await tx.query(
          `SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2 AND owner_id=$3
              AND kind='agent' AND removed_at IS NULL`,
          [room.id, values.fromAgentId, p.operatorId],
        );
        if (!agents.has(values.fromAgentId) || !inRoom.rows.length)
          fail(400, 'invalid_request', 'fromAgentId must be one of your agents in this room.');
        // The request again, locked: a close or expiry commits before this send or after it
        // (and then expires this response with the others).
        const current = await respondable(tx, request.id, time, 'FOR NO KEY UPDATE');
        // A block of this responder by the poster commits under the same lock.
        await ownerLock(tx, current.owner_id);
        const blocked = await blocks(tx, current.owner_id, p.operatorId);
        await expireStale(tx, 'v.request_id = $1', [current.id], time);
        const open = await tx.query(
          // A declined one stays "open" to the responder until it would have expired (sentView).
          `SELECT 1 FROM feed_request_invitations WHERE request_id=$1 AND room_id=$2
            AND (state='open' OR (state='declined' AND expires_at > $3))`,
          [current.id, room.id, time],
        );
        if (open.rows.length)
          fail(409, 'response_open', 'This room already has an open response to this request.');
        await withinLimits(tx, p.operatorId, current.id, time);
        if (room.members >= room.cap) fail(409, 'room_full', 'The room is full.');
        await d.pause?.('send:checked');
        const row = (
          await tx.query<Row>(
            `INSERT INTO feed_request_invitations (id, request_id, room_id, inviting_agent_id,
               inviting_operator_id, from_name, room_name, note, poster_owner_id, state,
               idempotency_key, request_hash, created_at, expires_at, answered_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING *`,
            [
              newId(),
              current.id,
              room.id,
              values.fromAgentId,
              p.operatorId,
              lineName(agents.get(values.fromAgentId), 'An agent'),
              room.name,
              note,
              current.owner_id,
              // Blocked: answered as sent, stored declined (it never reaches the poster).
              blocked ? 'declined' : 'open',
              keyHash,
              requestHash,
              time,
              Math.min(Number(current.expires_at), time + FEED_RESPOND_LIMITS.ttlMs),
              blocked ? time : null,
            ],
          )
        ).rows[0]!;
        return { created: true, response: sentView(row, time) };
      });
    } catch (error) {
      // Two sends from one room raced past the check: the index keeps one open.
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === '23505' &&
        String((error as { message?: unknown }).message ?? '').includes('one_open')
      )
        fail(409, 'response_open', 'This room already has an open response to this request.');
      throw error;
    }
  }

  /** GET: the caller's own responses to this request, newest first. */
  async function mine(p: RoomPrincipal, requestId: string): Promise<FeedResponseSent[]> {
    if (!FEED_REQUEST_ID.test(requestId)) return [];
    const time = d.clock();
    await expireStale(
      d.db,
      'v.request_id = $1 AND v.inviting_operator_id = $2',
      [requestId, p.operatorId],
      time,
    );
    const { rows } = await d.db.query<Row>(
      `SELECT * FROM feed_request_invitations WHERE request_id=$1 AND inviting_operator_id=$2
        ORDER BY created_at DESC, id DESC LIMIT 100`,
      [requestId, p.operatorId],
    );
    return rows.map((row) => sentView(row, time));
  }

  /** POST: withdraw an open response (the responder); withdrawing it again answers the same. */
  async function withdraw(p: RoomPrincipal, id: string): Promise<FeedResponseSent> {
    if (!FEED_REQUEST_INVITATION_ID.test(id)) invitationNotFound();
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      const row =
        (
          await tx.query<Row>(
            `SELECT * FROM feed_request_invitations WHERE id=$1 AND inviting_operator_id=$2
              FOR UPDATE`,
            [id, p.operatorId],
          )
        ).rows[0] ?? invitationNotFound();
      if (row.state === 'withdrawn') return sentView(row, time);
      // A declined one still reads open to the responder (sentView): withdrawing it answers so.
      if ((row.state !== 'open' && row.state !== 'declined') || Number(row.expires_at) <= time)
        invitationClosed();
      const updated = (
        await tx.query<Row>(
          `UPDATE feed_request_invitations SET state='withdrawn', answered_at=$2 WHERE id=$1
            RETURNING *`,
          [id, time],
        )
      ).rows[0]!;
      return sentView(updated, time);
    });
  }

  /** GET: the poster's count, open and accepted; anyone else (or a removed request): 404. */
  async function count(p: RoomPrincipal, requestId: string): Promise<FeedResponseCount> {
    if (!FEED_REQUEST_ID.test(requestId)) return requestNotFound();
    const request = (
      await d.db.query<{ owner_id: string | null; state: string }>(
        'SELECT owner_id, state FROM feed_requests WHERE id=$1',
        [requestId],
      )
    ).rows[0];
    if (!request || request.state === 'removed' || request.owner_id !== p.operatorId)
      return requestNotFound();
    const time = d.clock();
    await expireStale(d.db, 'v.request_id = $1', [requestId], time);
    const row = (
      await d.db.query<{ open: string | number; accepted: string | number }>(
        `SELECT count(*) FILTER (WHERE state='open') AS open,
            count(*) FILTER (WHERE state='accepted') AS accepted
          FROM feed_request_invitations WHERE request_id=$1 AND poster_owner_id=$2`,
        [requestId, p.operatorId],
      )
    ).rows[0];
    return { open: Number(row?.open ?? 0), accepted: Number(row?.accepted ?? 0) };
  }

  /** GET for the poster's inbox: every open response to its requests, newest first. */
  async function inbox(p: RoomPrincipal): Promise<FeedRequestInvitation[]> {
    const time = d.clock();
    await expireStale(d.db, 'v.poster_owner_id = $1', [p.operatorId], time);
    const agents = await liveAgents(d.db, p.operatorId);
    const { rows } = await d.db.query<InboxRow>(
      `${INBOX_SELECT}
        WHERE v.poster_owner_id=$1 AND v.state='open'
        ORDER BY v.created_at DESC, v.id DESC LIMIT $2`,
      [p.operatorId, RESPOND_INBOX_MAX],
    );
    return rows.map((row) => posterView(row, agents));
  }

  async function posterOne(q: Pick<Tx, 'query'>, p: RoomPrincipal, id: string) {
    const row = (await q.query<InboxRow>(`${INBOX_SELECT} WHERE v.id=$1`, [id])).rows[0]!;
    return posterView(row, await liveAgents(q, p.operatorId));
  }

  /**
   * POST {decision, agentId?} from the inbox (the poster): accept (the chosen agent, default the
   * request's, joins the room) or decline. Answering the same way again returns it unchanged.
   */
  async function decide(
    p: RoomPrincipal,
    id: string,
    body: unknown,
  ): Promise<FeedRequestInvitation> {
    if (!FEED_REQUEST_INVITATION_ID.test(id)) invitationNotFound();
    const values = decideBody.parse(body);
    const load = async () =>
      (
        await d.db.query<Row & { request_agent_id: string | null }>(
          `SELECT v.*, q.agent_id AS request_agent_id FROM feed_request_invitations v
            JOIN feed_requests q ON q.id = v.request_id WHERE v.id=$1 AND v.poster_owner_id=$2`,
          [id, p.operatorId],
        )
      ).rows[0];
    if (!(await load())) invitationNotFound();
    await d.limit(`room-invite-answer:${p.operatorId}`, INVITATION_RATES.answersPerHour, HOUR);
    await expireStale(d.db, 'v.id = $1', [id], d.clock());
    const row = (await load())!;
    if (values.decision === 'decline') {
      return d.db.transaction(async (tx) => {
        const time = d.clock();
        const current = (
          await tx.query<Row>('SELECT * FROM feed_request_invitations WHERE id=$1 FOR UPDATE', [id])
        ).rows[0]!;
        if (current.state !== 'declined') {
          if (current.state !== 'open' || Number(current.expires_at) <= time) invitationClosed();
          await tx.query(
            "UPDATE feed_request_invitations SET state='declined', answered_at=$2 WHERE id=$1",
            [id, time],
          );
        }
        return posterOne(tx, p, id);
      });
    }
    if (row.state === 'accepted') return posterOne(d.db, p, id);
    if (row.state !== 'open') invitationClosed();
    const agentId = values.agentId ?? row.request_agent_id;
    if (!agentId)
      fail(400, 'agent_required', 'Choose which of your agents joins the room (agentId).');
    // Set when the response can never be accepted any more (its request or room ended, the
    // inviter no longer hosts the room): stored as expired once the refused transaction rolls back.
    let dead = false;
    let decidedAt = 0;
    try {
      await d.rooms.acceptInvitation(p, {
        roomId: row.room_id,
        agentId: agentId!,
        recheck: async (tx, room) => {
          await d.pause?.('accept:recheck');
          // The request first, then the response: the order a close takes them in.
          const request = (
            await tx.query<{
              state: string;
              expires_at: string | number;
              hidden_at: string | number | null;
            }>('SELECT state, expires_at, hidden_at FROM feed_requests WHERE id=$1 FOR SHARE', [
              row.request_id,
            ])
          ).rows[0];
          // A block by this poster commits under the same lock (rooms/invitations.ts ownerLock).
          await ownerLock(tx, p.operatorId);
          const current = (
            await tx.query<Row>('SELECT * FROM feed_request_invitations WHERE id=$1 FOR UPDATE', [
              id,
            ])
          ).rows[0]!;
          decidedAt = d.clock();
          if (!request || request.state !== 'open' || Number(request.expires_at) <= decidedAt) {
            dead = true;
            invitationClosed('This request is closed.');
          }
          // Hidden by reports, it waits for its review (a release lists it again, keeping this).
          if (request.hidden_at !== null)
            fail(409, 'request_in_review', 'This request is being reviewed. Try again later.');
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
          if (await blocks(tx, p.operatorId, current.inviting_operator_id)) invitationClosed();
          await d.pause?.('accept:checked');
        },
        after: async (tx, room, _time, agentName, joined) => {
          await tx.query(
            `UPDATE feed_request_invitations SET state='accepted', answered_at=$2,
                accepted_agent_id=$3 WHERE id=$1`,
            [id, decidedAt, agentId],
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
      });
    } catch (error) {
      if (
        error instanceof RoomError &&
        (dead || error.errorCode === 'room_closed' || error.errorCode === 'room_not_found')
      ) {
        const time = d.clock();
        // Ended with its request or room: at that time, as any read would store it.
        await expireStale(d.db, 'v.id = $1', [id], time);
        // Its inviter left the room or no longer hosts it: ended now.
        await d.db.query(
          `UPDATE feed_request_invitations SET state='expired', answered_at=$2,
              expires_at=LEAST(expires_at, $2) WHERE id=$1 AND state='open'`,
          [id, time],
        );
      }
      throw error;
    }
    return posterOne(d.db, p, id);
  }

  return { send, mine, withdraw, count, inbox, decide };
}
