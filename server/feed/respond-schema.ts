import type { Transaction } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';

/** The table migration 108 adds (server/recovery.ts recognizes it, never exports it). */
export const FEED_RESPOND_TABLES = ['feed_request_invitations'] as const;

/**
 * Migration 108 `feed_request_invitations` (Feed Respond, P4, docs/FEED_RESPOND.md; the service is
 * server/feed/respond.ts, the contract shared/feed.ts). It needs the rooms tables and migration
 * 103 (feed_requests). Times are ms since epoch, like the rooms tables.
 *
 * One row per response: a responder (`inviting_operator_id`, its agent `inviting_agent_id`)
 * invites the poster of a signed-in request (`poster_owner_id`, copied from the request when
 * sent) into the responder's room. Separate from `room_invitations`, which targets a listed Base
 * agent by passport. `from_name` and `room_name` are what the poster was shown when it was sent
 * (untrusted: the responder chose them). `state`: open, then accepted (`accepted_agent_id` is the
 * poster's agent that joined), declined, expired (its own 7 days, its request closed or expired,
 * or its room closed) or withdrawn (the responder). `answered_at` is when it left 'open'. The
 * idempotency key is per responder account, bound to the request hash; one OPEN response per
 * (request, room). Deleting a request (the Feed's upkeep, 30 days after it ended) deletes its
 * responses.
 */
export const FEED_RESPOND_SQL = `
CREATE TABLE IF NOT EXISTS feed_request_invitations (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES feed_requests(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id),
  inviting_agent_id text NOT NULL,
  inviting_operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  from_name text NOT NULL,
  room_name text NOT NULL,
  note text NOT NULL DEFAULT '',
  poster_owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  accepted_agent_id text,
  state text NOT NULL CHECK (state IN ('open','accepted','declined','expired','withdrawn')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  answered_at bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_request_invitations_idempotency
  ON feed_request_invitations(inviting_operator_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS feed_request_invitations_one_open
  ON feed_request_invitations(request_id, room_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS feed_request_invitations_poster
  ON feed_request_invitations(poster_owner_id, state, created_at);
CREATE INDEX IF NOT EXISTS feed_request_invitations_request
  ON feed_request_invitations(request_id, state);
CREATE INDEX IF NOT EXISTS feed_request_invitations_sender
  ON feed_request_invitations(inviting_operator_id, created_at);
CREATE INDEX IF NOT EXISTS feed_request_invitations_room
  ON feed_request_invitations(room_id);
`;

export const feedRespondMigration: Migration = {
  version: 108,
  name: 'feed_request_invitations',
  sql: FEED_RESPOND_SQL,
};

/** Idempotent; call before runMigrations (after the rooms migrations and migration 103). */
export function registerFeedRespondMigration(): void {
  registerMigration(feedRespondMigration);
}

/**
 * Whether this database has the responses table (the whole app always does; a Feed slice on its
 * own may not). Asked until it does: one checker per service instance.
 */
export function responsesTableCheck(): (q: Pick<Transaction, 'query'>) => Promise<boolean> {
  let present = false;
  return async (q) => {
    present ||= (
      await q.query<{ ok: boolean }>(
        "SELECT to_regclass('feed_request_invitations') IS NOT NULL AS ok",
      )
    ).rows[0]!.ok;
    return present;
  };
}

/**
 * Ends the responses of the requests in `ended` (rows id, end_at) at end_at: an open one expires
 * there, and a declined one (a blocked one is stored declined too) is cut to end there as well.
 * The responder reads a declined response as open until its expires_at (respond.ts sentView): left
 * as it was, it would still read open after its request ended while the ignored ones read
 * not_joined. Cut, both read not_joined from the same time.
 */
const END_RESPONSES = `UPDATE feed_request_invitations v
    SET state = CASE WHEN v.state = 'open' THEN 'expired' ELSE v.state END,
        answered_at = CASE WHEN v.state = 'open' THEN LEAST(v.expires_at, e.end_at)
          ELSE v.answered_at END,
        expires_at = LEAST(v.expires_at, e.end_at)
   FROM ended e
  WHERE v.request_id = e.id
    AND (v.state = 'open' OR (v.state = 'declined' AND v.expires_at > e.end_at))`;

/**
 * `ending` (a statement that ends requests, RETURNING id and the time each ended as end_at) as
 * one statement that also ends their responses (END_RESPONSES): a request and its responses end
 * together or not at all. Without the responses table (`present` false) only `ending` runs.
 */
export async function endWithResponses(
  q: Pick<Transaction, 'query'>,
  present: boolean,
  ending: string,
  params: unknown[],
): Promise<void> {
  if (!present) {
    await q.query(ending, params);
    return;
  }
  await q.query(`WITH ended AS (${ending}) ${END_RESPONSES}`, params);
}
