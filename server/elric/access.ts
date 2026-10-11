import type { Transaction as Tx } from '../database.js';
import type { StoredAgent, Workspace } from '../model.js';
import { defaultPiiKeyring, isAdult } from '../google/pii.js';

/**
 * Elric's agent-bound access (docs/ELRIC.md; THREAT_PRIVACY_REVIEW §10.1).
 *
 * Every Elric read and write goes through `elricRoomAccess`, which admits a room only through
 * THIS Elric agent's own active member row, never through "any membership of the owner" (the
 * owner-granular `access()` of server/rooms/service.ts). A foreign room and a room that does not
 * exist answer the same `not_found`. A paused or revoked Elric can neither read nor write.
 */
export type ElricAccessCode =
  | 'not_found'
  | 'removed'
  | 'room_deleted'
  | 'room_closed'
  | 'responders_off'
  | 'muted'
  | 'paused'
  | 'revoked';

export interface ElricRow {
  agent_id: string;
  owner_id: string;
  status: 'active' | 'paused' | 'revoked';
  host_may_invoke: boolean;
}

export interface ElricRoom {
  id: string;
  name: string;
  topic: string;
  host_owner_id: string;
  history: string;
  next_seq: number;
  /** The owner's private /elric chat (rooms.elric_private); every other room is a group room. */
  elric_private: boolean;
}

export type ElricAccess =
  | {
      ok: true;
      elric: ElricRow;
      agent: StoredAgent;
      room: ElricRoom;
      /** Elric's own history start: it sees only seq > visibleFromSeq. */
      visibleFromSeq: number;
    }
  | { ok: false; code: ElricAccessCode };

type Q = Pick<Tx, 'query'>;

/** `share` takes FOR SHARE on the row, so a concurrent pause/revoke (FOR UPDATE) waits. */
export async function elricRow(
  q: Q,
  agentId: string,
  share = false,
): Promise<ElricRow | undefined> {
  return (
    await q.query<ElricRow>(
      `SELECT agent_id,owner_id,status,host_may_invoke FROM elric_agents WHERE agent_id=$1${share ? ' FOR SHARE' : ''}`,
      [agentId],
    )
  ).rows[0];
}

/**
 * The agent-bound access check. `write` additionally needs an open room whose host allows
 * responders (`responders_allowed`, which applies to Elric too) and no host mute or self-mute of
 * the owner there. `lock` takes FOR SHARE on the Elric row (ordered against pause and revoke,
 * which take FOR UPDATE) and then the room row lock (FOR UPDATE), so a caller inside a
 * transaction is ordered against pause, revoke, removals, closing and posts.
 */
export async function elricRoomAccess(
  q: Q,
  elricAgentId: string,
  roomId: string,
  options: { mode?: 'read' | 'write'; lock?: boolean } = {},
): Promise<ElricAccess> {
  const elric = await elricRow(q, elricAgentId, options.lock);
  if (!elric) return { ok: false, code: 'not_found' };
  if (elric.status === 'revoked') return { ok: false, code: 'revoked' };
  if (elric.status === 'paused') return { ok: false, code: 'paused' };
  const workspace = (
    await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
      elric.owner_id,
    ])
  ).rows[0]?.data;
  const agent = workspace?.agents.find((item) => item.id === elricAgentId);
  if (!workspace || !agent || agent.revokedAt) return { ok: false, code: 'revoked' };
  if (agent.pausedAt || workspace.paused) return { ok: false, code: 'paused' };
  const room = (
    await q.query<
      ElricRoom & {
        closed_at: string | number | null;
        deleted_at: string | number | null;
        responders_allowed: boolean;
      }
    >(
      `SELECT id,name,topic,host_owner_id,history,next_seq,elric_private,closed_at,deleted_at,responders_allowed
         FROM rooms WHERE id=$1${options.lock ? ' FOR UPDATE' : ''}`,
      [roomId],
    )
  ).rows[0];
  if (!room) return { ok: false, code: 'not_found' };
  const member = (
    await q.query<{ owner_id: string; removed_at: unknown; visible_from_seq: string | number }>(
      `SELECT owner_id,removed_at,visible_from_seq FROM room_members
        WHERE room_id=$1 AND agent_id=$2 AND kind='agent'`,
      [room.id, elricAgentId],
    )
  ).rows[0];
  // No member row of THIS agent: identical to a room that does not exist.
  if (!member || member.owner_id !== elric.owner_id) return { ok: false, code: 'not_found' };
  if (room.deleted_at !== null && room.deleted_at !== undefined)
    return { ok: false, code: 'room_deleted' };
  if (member.removed_at !== null && member.removed_at !== undefined)
    return { ok: false, code: 'removed' };
  if (options.mode === 'write') {
    if (room.closed_at !== null) return { ok: false, code: 'room_closed' };
    if (!room.responders_allowed) return { ok: false, code: 'responders_off' };
    const muted = await q.query(
      `SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id=$2
         AND (muted_at IS NOT NULL OR notifications_muted) LIMIT 1`,
      [room.id, elric.owner_id],
    );
    if (muted.rows.length) return { ok: false, code: 'muted' };
  }
  return {
    ok: true,
    elric,
    agent,
    room: {
      id: room.id,
      name: room.name,
      topic: room.topic,
      host_owner_id: room.host_owner_id,
      history: room.history,
      next_seq: Number(room.next_seq),
      elric_private: room.elric_private === true,
    },
    visibleFromSeq: Number(member.visible_from_seq),
  };
}

export type ElricEligibility =
  | { eligible: true; email: string }
  | {
      eligible: false;
      reason: 'unknown' | 'not_person' | 'unverified' | 'age_under_18' | 'age_unknown';
    };

/**
 * Who may own an Elric: only a PERSON owner (operator kind 'owner') with a server-stored,
 * verified Google identity (`elric_verified_identities`, written only by Sign in with Google after
 * it verified the ID token; server/google, docs/GOOGLE_SIGNIN.md). AI and unclaimed operators
 * never qualify; agents, workspace keys, OAuth clients and guests act for an AI or unclaimed
 * operator or are not operators at all. The owner must also have passed the 18+ age
 * confirmation (server/google/pii.ts, the date of birth): under 18 (locked) or unknown is not
 * eligible.
 * Re-checked on every invocation, not only at addElric.
 */
export async function elricEligibility(
  q: Q,
  operatorId: string,
  now: number = Date.now(),
): Promise<ElricEligibility> {
  const row = (
    await q.query<IdentityRow>(
      `SELECT o.kind, v.provider, v.email, v.email_verified, v.verified_at
         FROM operators o LEFT JOIN elric_verified_identities v ON v.operator_id=o.id
        WHERE o.id=$1`,
      [operatorId],
    )
  ).rows[0];
  return eligibilityOf(row, () => isAdult(q, defaultPiiKeyring(), operatorId, now));
}

/** The operator's kind and verified identity, as elricEligibility reads them. */
export interface IdentityRow {
  kind: string;
  provider: string | null;
  email: string | null;
  email_verified: boolean | null;
  verified_at: string | number | null;
}

/**
 * elricEligibility's decision for an identity row already read (undefined: no operator); `adult`
 * is asked only once the identity qualifies.
 */
export async function eligibilityOf(
  row: IdentityRow | undefined,
  adult: () => Promise<boolean | null> | boolean | null,
): Promise<ElricEligibility> {
  if (!row) return { eligible: false, reason: 'unknown' };
  if (row.kind !== 'owner') return { eligible: false, reason: 'not_person' };
  if (
    row.provider !== 'google' ||
    row.email_verified !== true ||
    row.verified_at === null ||
    !row.email
  )
    return { eligible: false, reason: 'unverified' };
  // The 18+ age confirmation (server/google/pii.ts): under 18 locks the account for Elric.
  const isAdultNow = await adult();
  if (isAdultNow === false) return { eligible: false, reason: 'age_under_18' };
  if (isAdultNow !== true) return { eligible: false, reason: 'age_unknown' };
  return { eligible: true, email: row.email };
}

/**
 * The typed refusal for an ineligible owner (Add Elric). The age codes never carry the birth
 * date or the age: only that the check failed or could not be done.
 */
export function elricEligibilityRefusal(
  reason: Extract<ElricEligibility, { eligible: false }>['reason'],
): { code: string; message: string } {
  if (reason === 'age_under_18')
    return { code: 'elric_age_under_18', message: 'Elric is only for people aged 18 or over.' };
  if (reason === 'age_unknown')
    return {
      code: 'elric_age_unknown',
      message:
        "Elric needs your date of birth to confirm you're 18 or over. Add it in Account settings.",
    };
  if (reason === 'unverified')
    return {
      code: 'elric_not_eligible',
      message: 'Elric needs a verified Google account. Sign in with Google first.',
    };
  return {
    code: 'elric_not_eligible',
    message: 'Elric is only for people with a verified account.',
  };
}

/**
 * Elric is managed by Central City: per-agent destructive routes (console revoke and credential
 * rotation) and city_control refuse it with `409 elric_managed`. Elric's own settings (off
 * switch) and account erasure are the only paths that deactivate it.
 */
export const ELRIC_MANAGED = {
  code: 'elric_managed',
  message: 'Elric is managed by Central City. Turn it off in Elric settings instead.',
} as const;

/** The ids among `agentIds` that are (non-revoked) Elric agents. */
export async function elricAgentIds(q: Q, agentIds: readonly string[]): Promise<Set<string>> {
  if (!agentIds.length) return new Set();
  return new Set(
    (
      await q.query<{ agent_id: string }>(
        "SELECT agent_id FROM elric_agents WHERE agent_id = ANY($1::text[]) AND status <> 'revoked'",
        [[...agentIds]],
      )
    ).rows.map((row) => row.agent_id),
  );
}
