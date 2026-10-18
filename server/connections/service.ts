import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction as Tx } from '../database.js';
import type { CityLimits } from '../limits.js';
import type { ConnectionRequest, ConnectionInvite } from '../../shared/assistant.js';
import { NO_NUL_MESSAGE, noNul } from '../messaging/contract.js';
import {
  active,
  event,
  iso,
  stopJob,
  type InboundConnection,
  type StoredAgent,
  type Workspace,
} from '../model.js';

/**
 * Cross-owner connections (docs/AI_WORKSPACES.md). An agent of one owner may message an agent of another owner, and request
 * its hosted zero-cost demo work, only after that owner APPROVES a directional request. A request
 * addresses its recipient with a single-use invite token or, for a public agent that accepts
 * requests, its id; every other case answers the same 404. Only an `approved` row authorizes
 * anything, and it is rechecked inside every transaction that uses it.
 */
export const PENDING_TTL_MS = 7 * 86_400_000;
export const COOLDOWN_MS = 7 * 86_400_000;
export const INVITE_MAX_TTL_HOURS = 168;
const NOTE_CHARS = 280;
const DAY = 86_400_000;
const INVITE_TOKEN = /^cci_[A-Za-z0-9_-]{43}$/;
const CURSOR = /^(\d{1,16})\.([0-9a-f-]{36})$/;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export class ConnectionError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
const refuse = (status: number, code: string, message: string, retryAfterMs?: number): never => {
  throw new ConnectionError(status, code, message, retryAfterMs);
};
/** One answer for unknown, private-without-invite and request-disabled agents and bad invites. */
const notFound = (): never =>
  refuse(404, 'agent_not_found', 'Agent not found or not accepting connection requests.');

/**
 * Label the other owner sees: an AI workspace's display name, or an opaque stable label for a
 * person's account (a person's account name is their sign-in name and is never disclosed).
 */
export function ownerLabel(owner: { id: string; name: string; kind: string }): string {
  return owner.kind === 'ai' ? owner.name : `Account ${sha(`owner-label:${owner.id}`).slice(0, 8)}`;
}

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe('Stable caller-chosen key; a retry with the same key and arguments is free.');
export const createInviteToolInput = z
  .object({
    agent_id: uuid.describe('Your agent that the invite lets one other owner request.'),
    ttl_hours: z
      .number()
      .int()
      .min(1)
      .max(INVITE_MAX_TTL_HOURS)
      .optional()
      .describe('Lifetime in hours (default and maximum 168, seven days).'),
  })
  .strict();
export const listInvitesToolInput = z.object({}).strict();
export const revokeInviteToolInput = z.object({ invite_id: uuid }).strict();
export const requestConnectionToolInput = z
  .object({
    from_agent_id: uuid.describe('Your agent that will send messages and requests.'),
    to_agent_id: uuid
      .optional()
      .describe('A public agent of another owner (it has a public Agent Card).'),
    invite_token: z
      .string()
      .max(128)
      .optional()
      .describe('Single-use invite (cci_...) the other owner gave you for one of its agents.'),
    note: z
      .string()
      .trim()
      .max(NOTE_CHARS)
      .refine(noNul, NO_NUL_MESSAGE)
      .optional()
      .describe('Plain text shown to the other owner (untrusted for them).'),
    idempotency_key: idempotencyKey,
  })
  .strict()
  .refine((value) => (value.to_agent_id === undefined) !== (value.invite_token === undefined), {
    message: 'Pass exactly one of to_agent_id or invite_token.',
  });
const STATUSES = ['pending', 'approved', 'denied', 'revoked', 'expired'] as const;
export const listConnectionRequestsToolInput = z
  .object({
    direction: z
      .enum(['incoming', 'outgoing'])
      .optional()
      .describe('incoming: requests to your agents; outgoing: requests you sent. Default both.'),
    status: z.enum(STATUSES).optional(),
    before: z
      .string()
      .regex(CURSOR)
      .optional()
      .describe('Page cursor (next_before of the previous page); needs direction.'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size, default 100.'),
  })
  .strict()
  .refine((value) => value.before === undefined || value.direction !== undefined, {
    message: 'before needs a direction.',
  });
export const decideConnectionToolInput = z
  .object({
    request_id: uuid,
    decision: z.enum(['approve', 'deny']),
    deny_all_pending_from_owner: z
      .boolean()
      .optional()
      .describe("With decision 'deny': also deny every other pending request from that owner."),
  })
  .strict()
  .refine((value) => !value.deny_all_pending_from_owner || value.decision === 'deny', {
    message: 'deny_all_pending_from_owner needs decision deny.',
  });
export const revokeConnectionToolInput = z.object({ connection_id: uuid }).strict();
export const setConnectionRequestsToolInput = z
  .object({
    agent_id: uuid,
    requests_enabled: z
      .boolean()
      .describe('false: this public agent no longer accepts requests by id (invites still work).'),
  })
  .strict();

/** Who acts: the workspace and an audit label (never a person's name). */
export interface ConnectionPrincipal {
  operatorId: string;
  actor: string;
}
/** Authority recheck run first inside the operation's transaction (current grant or key). */
export type ConnectionGuard = (tx: Tx, time: number) => Promise<void>;

type Row = {
  id: string;
  from_agent_id: string;
  from_owner_id: string;
  to_agent_id: string;
  to_owner_id: string;
  status: (typeof STATUSES)[number];
  note: string;
  from_owner_label: string;
  requested_at: string | number;
  expires_at: string | number;
  decided_at: string | number | null;
  decided_by: string | null;
  revoked_at: string | number | null;
  revoked_by: string | null;
  idempotency_key: string;
  request_hash: string;
};
type InviteRow = {
  id: string;
  owner_id: string;
  agent_id: string;
  created_at: string | number;
  expires_at: string | number;
  used_at: string | number | null;
  revoked_at: string | number | null;
};
type Directory = Map<string, { name: string; kind: string; agents: Map<string, string> }>;

export interface ConnectionDependencies {
  db: Database;
  clock(): number;
  caps: Pick<
    CityLimits,
    | 'connectionRequestsPerOwnerPerDay'
    | 'pendingConnectionRequestsPerWorkspace'
    | 'pendingConnectionRequestsPerTarget'
    | 'invitesPerOwner'
  >;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  mutateMany<T>(
    operatorIds: string[],
    action: (workspaces: Map<string, Workspace>, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
}
export interface Connections {
  createInvite(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  listInvites(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  revokeInvite(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  request(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  list(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  decide(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  revoke(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
  setRequests(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard): Promise<unknown>;
}

/**
 * Approved inbound connections of a workspace, attached (non-enumerable) to every locked workspace
 * read. Only while the requesting agent is live (not revoked or paused) and its workspace is not
 * paused: pausing the requester side stops and blocks its work here too.
 */
export async function loadInbound(
  tx: Pick<Tx, 'query'>,
  operatorId: string,
): Promise<InboundConnection[]> {
  return inboundFromRows(
    (
      await tx.query<InboundRow>(
        `SELECT c.from_agent_id,c.from_owner_id,c.to_agent_id ${INBOUND_FROM_SQL}`,
        [operatorId],
      )
    ).rows,
  );
}

type InboundRow = { from_agent_id: string; from_owner_id: string; to_agent_id: string };
/** The FROM and WHERE of loadInbound (`$1` is the operator id of the workspace). */
const INBOUND_FROM_SQL = `FROM cross_connections c
        JOIN workspaces w ON w.operator_id=c.from_owner_id
        WHERE c.to_owner_id=$1 AND c.status='approved'
        AND (w.data->>'paused')::boolean IS NOT TRUE
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.data->'agents') a
          WHERE a->>'id'=c.from_agent_id AND a->>'revokedAt' IS NULL AND a->>'pausedAt' IS NULL)`;
/** loadInbound's rows as one JSON array, for reading them in the same statement as the document. */
export const INBOUND_JSON_SQL = `(SELECT COALESCE(json_agg(json_build_object('from_agent_id',
  c.from_agent_id,'from_owner_id',c.from_owner_id,'to_agent_id',c.to_agent_id)),'[]'::json)
  ${INBOUND_FROM_SQL})`;

export function inboundFromRows(rows: InboundRow[]): InboundConnection[] {
  return rows.map((row) => ({
    fromAgentId: row.from_agent_id,
    fromOperatorId: row.from_owner_id,
    toAgentId: row.to_agent_id,
  }));
}

/** Revokes an agent's cross connections and invites (agent revocation; same transaction). */
export async function revokeAgentCrossConnections(
  tx: Pick<Tx, 'query'>,
  operatorId: string,
  agentId: string,
  time: number,
): Promise<void> {
  await tx.query(
    `UPDATE cross_connections SET status='revoked', revoked_at=$3, revoked_by='agent revoked'
      WHERE status IN ('pending','approved') AND (
        (from_agent_id=$1 AND from_owner_id=$2) OR (to_agent_id=$1 AND to_owner_id=$2))`,
    [agentId, operatorId, time],
  );
  await tx.query(
    'UPDATE cross_invites SET revoked_at=$3 WHERE agent_id=$1 AND owner_id=$2 AND revoked_at IS NULL AND used_at IS NULL',
    [agentId, operatorId, time],
  );
}

export function createConnections(d: ConnectionDependencies): Connections {
  async function directory(tx: Pick<Tx, 'query'>, operatorIds: string[]): Promise<Directory> {
    const ids = [...new Set(operatorIds)];
    const map: Directory = new Map();
    if (!ids.length) return map;
    const rows = (
      await tx.query<{ id: string; name: string; kind: string; agents: Record<string, string> }>(
        `SELECT o.id, o.name, o.kind,
          COALESCE((SELECT jsonb_object_agg(a->>'id', a->>'name') FROM jsonb_array_elements(w.data->'agents') a), '{}'::jsonb) AS agents
          FROM operators o JOIN workspaces w ON w.operator_id=o.id WHERE o.id = ANY($1::text[])`,
        [ids],
      )
    ).rows;
    for (const row of rows)
      map.set(row.id, {
        name: row.name,
        kind: row.kind,
        agents: new Map(Object.entries(row.agents ?? {})),
      });
    return map;
  }
  const statusAt = (row: Row, time: number) =>
    row.status === 'pending' && Number(row.expires_at) <= time ? 'expired' : row.status;
  function project(row: Row, viewer: string, names: Directory, time: number): ConnectionRequest {
    const outgoing = row.from_owner_id === viewer;
    const status = statusAt(row, time);
    const from = names.get(row.from_owner_id);
    const to = names.get(row.to_owner_id);
    // The requester sees only its own request status; the recipient's names only once approved.
    const disclosed = !outgoing || status === 'approved';
    return {
      id: row.id,
      direction: outgoing ? 'outgoing' : 'incoming',
      status,
      from_agent_id: row.from_agent_id,
      from_agent_name: from?.agents.get(row.from_agent_id) ?? null,
      from_owner_label: row.from_owner_label,
      to_agent_id: row.to_agent_id,
      to_agent_name: disclosed ? (to?.agents.get(row.to_agent_id) ?? null) : null,
      note: row.note,
      requested_at: iso(Number(row.requested_at)),
      expires_at: iso(Number(row.expires_at)),
      decided_at: row.decided_at === null ? null : iso(Number(row.decided_at)),
      revoked_at: row.revoked_at === null ? null : iso(Number(row.revoked_at)),
    };
  }
  const liveAgent = (workspace: Workspace | undefined, id: string): StoredAgent | undefined =>
    workspace?.agents.find((agent) => agent.id === id && !agent.revokedAt);
  async function ownerOf(tx: Pick<Tx, 'query'>, id: string) {
    return (
      await tx.query<{ id: string; name: string; kind: string }>(
        'SELECT id,name,kind FROM operators WHERE id=$1',
        [id],
      )
    ).rows[0];
  }
  function projectInvite(row: InviteRow, time: number): ConnectionInvite {
    return {
      id: row.id,
      agent_id: row.agent_id,
      created_at: iso(Number(row.created_at)),
      expires_at: iso(Number(row.expires_at)),
      status: row.revoked_at
        ? 'revoked'
        : row.used_at
          ? 'used'
          : Number(row.expires_at) <= time
            ? 'expired'
            : 'active',
    };
  }

  // -------------------------------------------------------------------------------------------
  // Invites

  async function createInvite(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const values = createInviteToolInput.parse(body);
    return d.mutate(p.operatorId, async (workspace, tx, time) => {
      if (guard) await guard(tx, time);
      const agent = liveAgent(workspace, values.agent_id);
      if (!agent) refuse(404, 'agent_not_found', 'Agent not found in this workspace.');
      const activeInvites = Number(
        (
          await tx.query<{ n: string | number }>(
            'SELECT count(*) AS n FROM cross_invites WHERE owner_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>$2',
            [p.operatorId, time],
          )
        ).rows[0]?.n ?? 0,
      );
      if (activeInvites >= d.caps.invitesPerOwner)
        refuse(
          429,
          'too_many_invites',
          `At most ${d.caps.invitesPerOwner} invites may be active; revoke one or let it expire.`,
          DAY,
        );
      const token = `cci_${randomBytes(32).toString('base64url')}`;
      const row = (
        await tx.query<InviteRow>(
          'INSERT INTO cross_invites(id,token_hash,owner_id,agent_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [
            randomUUID(),
            sha(token),
            p.operatorId,
            agent!.id,
            time,
            time + (values.ttl_hours ?? INVITE_MAX_TTL_HOURS) * 3_600_000,
          ],
        )
      ).rows[0]!;
      event(
        workspace,
        time,
        'connection.invite_created',
        `Connection invite ${row.id} for ${agent!.name} created by ${p.actor}.`,
        agent!.id,
      );
      return {
        invite: projectInvite(row, time),
        invite_token: token,
        next_actions: [
          'Give invite_token to the one owner (or AI) whose agent should connect; it is shown only once and works once. They call city_request_connection with it, and you still approve with city_decide_connection.',
        ],
      };
    });
  }
  async function listInvites(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    listInvitesToolInput.parse(body ?? {});
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      const rows = (
        await tx.query<InviteRow>(
          'SELECT * FROM cross_invites WHERE owner_id=$1 ORDER BY created_at DESC, id LIMIT 100',
          [p.operatorId],
        )
      ).rows;
      return { invites: rows.map((row) => projectInvite(row, time)) };
    });
  }
  async function revokeInvite(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const { invite_id } = revokeInviteToolInput.parse(body);
    return d.mutate(p.operatorId, async (workspace, tx, time) => {
      if (guard) await guard(tx, time);
      const row = (
        await tx.query<InviteRow>(
          'UPDATE cross_invites SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND owner_id=$2 RETURNING *',
          [invite_id, p.operatorId, time],
        )
      ).rows[0];
      if (!row) refuse(404, 'invite_not_found', 'Invite not found in this workspace.');
      if (Number(row!.revoked_at) === time)
        event(
          workspace,
          time,
          'connection.invite_revoked',
          `Connection invite ${row!.id} revoked by ${p.actor}.`,
          row!.agent_id,
        );
      return { invite: projectInvite(row!, time) };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  /** Recipient of a request by id: a live public agent of another owner that accepts requests. */
  async function publicTarget(tx: Pick<Tx, 'query'>, agentId: string) {
    const row = (
      await tx.query<{ operator_id: string; kind: string; agent: StoredAgent; visibility: string }>(
        `SELECT w.operator_id, o.kind, a AS agent, m.manifest->'spec'->>'visibility' AS visibility
          FROM agent_manifests m JOIN workspaces w ON w.operator_id=m.operator_id
          JOIN operators o ON o.id=w.operator_id
          CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
          WHERE m.agent_id=$1 AND a->>'id'=$1 AND (a->>'revision')::integer=m.revision`,
        [agentId],
      )
    ).rows[0];
    if (!row || row.visibility !== 'public' || row.agent.revokedAt) return null;
    if (row.kind !== 'owner' && row.kind !== 'ai') return null;
    const disabled = (
      await tx.query<{ requests_disabled: boolean }>(
        'SELECT requests_disabled FROM cross_agent_settings WHERE agent_id=$1',
        [agentId],
      )
    ).rows[0]?.requests_disabled;
    return disabled ? null : { ownerId: row.operator_id, agentId };
  }

  async function request(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const values = requestConnectionToolInput.parse(body);
    const keyHash = sha(values.idempotency_key);
    const requestHash = sha(
      JSON.stringify({
        from: values.from_agent_id,
        to: values.to_agent_id ?? null,
        invite: values.invite_token ? sha(values.invite_token) : null,
        note: values.note ?? '',
      }),
    );
    const replay = async (tx: Pick<Tx, 'query'>, time: number) => {
      const row = (
        await tx.query<Row>(
          'SELECT * FROM cross_connections WHERE from_owner_id=$1 AND idempotency_key=$2',
          [p.operatorId, keyHash],
        )
      ).rows[0];
      if (!row) return null;
      if (row.request_hash !== requestHash)
        refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different request.');
      return {
        request: project(row, p.operatorId, await directory(tx, [p.operatorId]), time),
        replayed: true,
        next_actions: ['This request was already recorded; nothing new was created.'],
      };
    };
    // Replays are free: decided by a plain read before any budget is charged.
    const early = await replay(d.db, d.clock());
    if (early) return early;
    // Charged before the transaction (the hosted limiter needs its own pool client).
    await d.limit(`xconn-req:${p.operatorId}`, d.caps.connectionRequestsPerOwnerPerDay, DAY);
    // Resolve the recipient (lookup only; rechecked under the locks).
    let target: { ownerId: string; agentId: string; inviteId?: string } | null = null;
    if (values.invite_token !== undefined) {
      if (!INVITE_TOKEN.test(values.invite_token)) notFound();
      const invite = (
        await d.db.query<InviteRow>('SELECT * FROM cross_invites WHERE token_hash=$1', [
          sha(values.invite_token),
        ])
      ).rows[0];
      if (!invite) notFound();
      target = { ownerId: invite!.owner_id, agentId: invite!.agent_id, inviteId: invite!.id };
    } else target = await publicTarget(d.db, values.to_agent_id!);
    if (!target) return notFound();
    if (target.ownerId === p.operatorId)
      refuse(
        400,
        'same_workspace',
        'Both agents are in this workspace; authorize a direct connection instead.',
      );
    const resolved = target;
    return d.mutateMany([p.operatorId, resolved.ownerId], async (workspaces, tx, time) => {
      if (guard) await guard(tx, time);
      const again = await replay(tx, time);
      if (again) return again;
      const own = workspaces.get(p.operatorId)!;
      const theirs = workspaces.get(resolved.ownerId)!;
      const from = own.agents.find((agent) => agent.id === values.from_agent_id);
      if (!from) refuse(404, 'agent_not_found', 'Requesting agent not found in this workspace.');
      if (from!.revokedAt) refuse(403, 'agent_revoked', `${from!.name} is revoked.`);
      const to = liveAgent(theirs, resolved.agentId);
      if (!to) notFound();
      if (resolved.inviteId) {
        const invite = (
          await tx.query<InviteRow>(
            'SELECT * FROM cross_invites WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>$2 FOR UPDATE',
            [resolved.inviteId, time],
          )
        ).rows[0];
        if (!invite) notFound();
      } else if (!(await publicTarget(tx, resolved.agentId))) notFound();
      // Stale pending rows of this pair expire now, so they no longer hold the unique slot.
      await tx.query(
        "UPDATE cross_connections SET status='expired' WHERE from_agent_id=$1 AND to_agent_id=$2 AND status='pending' AND expires_at<=$3",
        [from!.id, to!.id, time],
      );
      const live = (
        await tx.query<Row>(
          "SELECT * FROM cross_connections WHERE from_agent_id=$1 AND to_agent_id=$2 AND status IN ('pending','approved')",
          [from!.id, to!.id],
        )
      ).rows[0];
      if (live)
        refuse(
          409,
          live.status === 'approved' ? 'already_approved' : 'pending_exists',
          live.status === 'approved'
            ? 'This connection is already approved.'
            : 'A request for this connection is already pending.',
        );
      const cooldown = (
        await tx.query<{ until: string | number }>(
          `SELECT max(CASE WHEN status='denied' THEN decided_at ELSE expires_at END) + $3 AS until
            FROM cross_connections WHERE from_agent_id=$1 AND to_agent_id=$2
            AND status IN ('denied','expired')`,
          [from!.id, to!.id, COOLDOWN_MS],
        )
      ).rows[0]?.until;
      if (cooldown !== null && cooldown !== undefined && Number(cooldown) > time)
        refuse(
          429,
          'cooldown',
          'The previous request for this pair was denied or expired; a new one is allowed after the 7-day cooldown.',
          Number(cooldown) - time,
        );
      const count = async (sql: string, params: unknown[]) =>
        Number((await tx.query<{ n: string | number }>(sql, params)).rows[0]?.n ?? 0);
      if (
        (await count(
          "SELECT count(*) AS n FROM cross_connections WHERE from_owner_id=$1 AND to_agent_id=$2 AND status='pending' AND expires_at>$3",
          [p.operatorId, to!.id, time],
        )) > 0
      )
        refuse(
          409,
          'pending_exists',
          'This workspace already has a pending request to that agent; wait for a decision or withdraw it.',
        );
      if (
        (await count(
          "SELECT count(*) AS n FROM cross_connections WHERE from_owner_id=$1 AND status='pending' AND expires_at>$2",
          [p.operatorId, time],
        )) >= d.caps.pendingConnectionRequestsPerWorkspace
      )
        refuse(
          429,
          'too_many_pending',
          `At most ${d.caps.pendingConnectionRequestsPerWorkspace} of your requests may be pending.`,
          DAY,
        );
      if (
        (await count(
          "SELECT count(*) AS n FROM cross_connections WHERE to_agent_id=$1 AND status='pending' AND expires_at>$2",
          [to!.id, time],
        )) >= d.caps.pendingConnectionRequestsPerTarget
      )
        refuse(
          429,
          'too_many_pending',
          'That agent has too many pending connection requests; try again after retry_after_ms, when older requests have expired or been decided.',
          DAY,
        );
      if (resolved.inviteId)
        await tx.query('UPDATE cross_invites SET used_at=$2 WHERE id=$1', [
          resolved.inviteId,
          time,
        ]);
      const requester = (await ownerOf(tx, p.operatorId))!;
      const label = ownerLabel(requester);
      const inserted = (
        await tx.query<Row>(
          `INSERT INTO cross_connections(id,from_agent_id,from_owner_id,to_agent_id,to_owner_id,status,note,
            from_owner_label,requested_at,expires_at,invite_id,idempotency_key,request_hash)
            VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT DO NOTHING RETURNING *`,
          [
            randomUUID(),
            from!.id,
            p.operatorId,
            to!.id,
            resolved.ownerId,
            values.note ?? '',
            label,
            time,
            time + PENDING_TTL_MS,
            resolved.inviteId ?? null,
            keyHash,
            requestHash,
          ],
        )
      ).rows[0];
      // A concurrent duplicate lost the unique race: one row stands, answered as a replay.
      if (!inserted) {
        const winner = await replay(tx, time);
        if (winner) return winner;
        refuse(409, 'pending_exists', 'A request for this connection is already pending.');
      }
      event(
        own,
        time,
        'connection.cross_requested',
        `${from!.name} requested a cross-owner connection to agent ${to!.id}${resolved.inviteId ? ' with an invite' : ''} (by ${p.actor}).`,
        from!.id,
      );
      event(
        theirs,
        time,
        'connection.cross_requested',
        `${from!.name} (${label}, another owner) asks to connect to ${to!.name}. Approve or deny it under Connections.`,
        to!.id,
      );
      return {
        request: project(inserted!, p.operatorId, await directory(tx, [p.operatorId]), time),
        replayed: false,
        next_actions: [
          "Request recorded and pending. The other owner approves or denies it (city_decide_connection); check with city_list_connection_requests (direction 'outgoing'). It expires after 7 days.",
        ],
      };
    });
  }

  async function list(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const {
      direction,
      status,
      before,
      limit = 100,
    } = listConnectionRequestsToolInput.parse(body ?? {});
    const cursor = before ? CURSOR.exec(before) : null;
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      let next: string | null = null;
      const fetch = async (column: 'from_owner_id' | 'to_owner_id') => {
        const params: unknown[] = [p.operatorId, limit + 1, time];
        let filter = '';
        if (status === 'expired')
          filter = " AND (status='expired' OR (status='pending' AND expires_at<=$3))";
        else if (status === 'pending') filter = " AND status='pending' AND expires_at>$3";
        else if (status) {
          params.push(status);
          filter = ` AND status=$${params.length}`;
        }
        if (cursor) {
          params.push(Number(cursor[1]), cursor[2]);
          filter += ` AND (requested_at, id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
        }
        const rows = (
          await tx.query<Row>(
            `SELECT * FROM cross_connections WHERE ${column}=$1 AND $3::bigint IS NOT NULL${filter}
              ORDER BY requested_at DESC, id DESC LIMIT $2`,
            params,
          )
        ).rows;
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        if (rows.length > limit && last && direction)
          next = `${Number(last.requested_at)}.${last.id}`;
        return page;
      };
      const incoming = direction === 'outgoing' ? [] : await fetch('to_owner_id');
      const outgoing = direction === 'incoming' ? [] : await fetch('from_owner_id');
      const names = await directory(tx, [
        p.operatorId,
        ...incoming.map((row) => row.from_owner_id),
        ...outgoing.map((row) => row.to_owner_id),
      ]);
      return {
        incoming: incoming.map((row) => project(row, p.operatorId, names, time)),
        outgoing: outgoing.map((row) => project(row, p.operatorId, names, time)),
        next_before: next,
      };
    });
  }

  async function decide(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const values = decideConnectionToolInput.parse(body);
    const missing = (): never =>
      refuse(
        404,
        'request_not_found',
        'Connection request not found among your incoming requests.',
      );
    const found = (
      await d.db.query<Row>('SELECT * FROM cross_connections WHERE id=$1 AND to_owner_id=$2', [
        values.request_id,
        p.operatorId,
      ])
    ).rows[0];
    if (!found) missing();
    return d.mutateMany([found!.from_owner_id, p.operatorId], async (workspaces, tx, time) => {
      if (guard) await guard(tx, time);
      const row = (
        await tx.query<Row>(
          'SELECT * FROM cross_connections WHERE id=$1 AND to_owner_id=$2 FOR UPDATE',
          [values.request_id, p.operatorId],
        )
      ).rows[0];
      if (!row) missing();
      const wanted = values.decision === 'approve' ? 'approved' : 'denied';
      const own = workspaces.get(p.operatorId)!;
      const theirs = workspaces.get(row!.from_owner_id)!;
      let deniedOthers = 0;
      if (values.deny_all_pending_from_owner)
        deniedOthers = (
          await tx.query(
            `UPDATE cross_connections SET status='denied', decided_at=$3, decided_by=$4
              WHERE to_owner_id=$1 AND from_owner_id=$2 AND status='pending' AND id<>$5 AND expires_at>$3
              RETURNING id`,
            [p.operatorId, row!.from_owner_id, time, p.actor, row!.id],
          )
        ).rows.length;
      const current = statusAt(row!, time);
      const names = () => directory(tx, [row!.from_owner_id, p.operatorId]);
      if (current === wanted)
        return {
          request: project(row!, p.operatorId, await names(), time),
          denied_count: deniedOthers,
        };
      if (current !== 'pending') {
        if (current === 'expired' && row!.status === 'pending')
          await tx.query("UPDATE cross_connections SET status='expired' WHERE id=$1", [row!.id]);
        refuse(409, 'not_pending', `This connection request is ${current}, no longer pending.`);
      }
      const to = liveAgent(own, row!.to_agent_id);
      const from = liveAgent(theirs, row!.from_agent_id);
      if (wanted === 'approved' && (!to || !from))
        refuse(
          409,
          'agent_unavailable',
          'One of the two agents was revoked; the request cannot be approved.',
        );
      const updated = (
        await tx.query<Row>(
          'UPDATE cross_connections SET status=$2, decided_at=$3, decided_by=$4 WHERE id=$1 RETURNING *',
          [row!.id, wanted, time, p.actor],
        )
      ).rows[0]!;
      const toName = to?.name ?? 'your agent';
      const fromName = from?.name ?? 'an agent';
      event(
        own,
        time,
        `connection.cross_${wanted}`,
        wanted === 'approved'
          ? `Cross-owner connection approved by ${p.actor}: ${fromName} (${row!.from_owner_label}) may message ${toName} and request its hosted demo work.`
          : `Cross-owner connection request from ${fromName} (${row!.from_owner_label}) to ${toName} denied by ${p.actor}.`,
        to?.id ?? null,
      );
      event(
        theirs,
        time,
        `connection.cross_${wanted}`,
        wanted === 'approved'
          ? `The other owner approved the connection from ${fromName} to agent ${row!.to_agent_id}.`
          : `The other owner denied the connection request from ${fromName}; a new request is possible after 7 days.`,
        from?.id ?? null,
      );
      return {
        request: project(updated, p.operatorId, await names(), time),
        denied_count: deniedOthers + (wanted === 'denied' ? 1 : 0),
      };
    });
  }

  async function revoke(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const { connection_id } = revokeConnectionToolInput.parse(body);
    const missing = (): never =>
      refuse(404, 'request_not_found', 'Connection or request not found in this workspace.');
    const found = (
      await d.db.query<Row>(
        'SELECT * FROM cross_connections WHERE id=$1 AND (from_owner_id=$2 OR to_owner_id=$2)',
        [connection_id, p.operatorId],
      )
    ).rows[0];
    if (!found) missing();
    const sides = [found!.from_owner_id, found!.to_owner_id];
    return d.mutateMany(sides, async (workspaces, tx, time) => {
      if (guard) await guard(tx, time);
      const row = (
        await tx.query<Row>(
          'SELECT * FROM cross_connections WHERE id=$1 AND (from_owner_id=$2 OR to_owner_id=$2) FOR UPDATE',
          [connection_id, p.operatorId],
        )
      ).rows[0];
      if (!row) missing();
      const names = () => directory(tx, sides);
      const current = statusAt(row!, time);
      if (current !== 'pending' && current !== 'approved')
        return { request: project(row!, p.operatorId, await names(), time) };
      const updated = (
        await tx.query<Row>(
          "UPDATE cross_connections SET status='revoked', revoked_at=$2, revoked_by=$3 WHERE id=$1 RETURNING *",
          [row!.id, time, p.actor],
        )
      ).rows[0]!;
      const from = workspaces.get(row!.from_owner_id)!;
      const to = workspaces.get(row!.to_owner_id)!;
      if (current === 'approved')
        for (const job of to.jobs)
          if (
            active(job) &&
            job.requesterId === row!.from_agent_id &&
            job.providerId === row!.to_agent_id
          )
            stopJob(to, job, time, 'Work stopped because its cross-owner connection was revoked.');
      const bySelf = (side: string) => (p.operatorId === side ? p.actor : 'the other owner');
      const fromName = from.agents.find((agent) => agent.id === row!.from_agent_id)?.name;
      const toName = to.agents.find((agent) => agent.id === row!.to_agent_id)?.name;
      event(
        to,
        time,
        'connection.cross_revoked',
        `Cross-owner connection from ${fromName ?? 'an agent'} (${row!.from_owner_label}) to ${toName ?? 'your agent'} ${current === 'approved' ? 'revoked' : 'withdrawn'} by ${bySelf(row!.to_owner_id)}.`,
        row!.to_agent_id,
      );
      event(
        from,
        time,
        'connection.cross_revoked',
        `Cross-owner connection from ${fromName ?? 'your agent'} to agent ${row!.to_agent_id} ${current === 'approved' ? 'revoked' : 'withdrawn'} by ${bySelf(row!.from_owner_id)}.`,
        row!.from_agent_id,
      );
      return { request: project(updated, p.operatorId, await names(), time) };
    });
  }

  async function setRequests(p: ConnectionPrincipal, body: unknown, guard?: ConnectionGuard) {
    const values = setConnectionRequestsToolInput.parse(body);
    return d.mutate(p.operatorId, async (workspace, tx, time) => {
      if (guard) await guard(tx, time);
      const agent = liveAgent(workspace, values.agent_id);
      if (!agent) refuse(404, 'agent_not_found', 'Agent not found in this workspace.');
      await tx.query(
        `INSERT INTO cross_agent_settings(agent_id,owner_id,requests_disabled) VALUES($1,$2,$3)
          ON CONFLICT (agent_id) DO UPDATE SET requests_disabled=EXCLUDED.requests_disabled
          WHERE cross_agent_settings.owner_id=EXCLUDED.owner_id`,
        [agent!.id, p.operatorId, !values.requests_enabled],
      );
      event(
        workspace,
        time,
        'connection.requests_setting',
        `${agent!.name} ${values.requests_enabled ? 'accepts' : 'no longer accepts'} connection requests by id (set by ${p.actor}).`,
        agent!.id,
      );
      return { agent_id: agent!.id, requests_enabled: values.requests_enabled };
    });
  }

  return {
    createInvite,
    listInvites,
    revokeInvite,
    request,
    list,
    decide,
    revoke,
    setRequests,
  };
}
