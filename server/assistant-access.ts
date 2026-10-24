import { assertOnboarded } from './onboarding.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from './database.js';
import type { CityLimits } from './limits.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ASSISTANT_SCOPES,
  ROLLING_GRANT_DAYS,
  grantRenewal,
  rollingGrantCeiling,
  type AssistantGrant,
  type AssistantScope,
} from '../shared/assistant.js';
import { AGENT_NAME_MAX } from '../shared/agent-name.js';
import type { AgentCreator, Operator } from '../shared/types.js';
import type { Actor, AutonomyService } from './autonomy/service.js';
import type { Guard, Messaging } from './messaging/service.js';
import type { AiWorkspaces } from './workspaces/service.js';
import type { Connections } from './connections/service.js';
import type { Rooms } from './rooms/service.js';
import {
  ackInboxToolInput,
  readInboxToolInput,
  sendMessageToolInput,
} from './messaging/contract.js';
import { ROOM_TOOLS, type RoomToolName } from './rooms/contract.js';
import {
  ROOM_TASK_TOOLS,
  ROOM_TASK_TOOL_SCOPES,
  roomTasksEnabled,
  runRoomTaskTool,
  type RoomTaskToolName,
} from './rooms/tasks-tools.js';
import type { RoomTasks } from './rooms/tasks-service.js';
import type { RoomPins } from './rooms/pins.js';
import {
  ROOM_PIN_TOOLS,
  ROOM_PIN_TOOL_SCOPES,
  runRoomPinTool,
  type RoomPinToolName,
} from './rooms/pins-tools.js';
import {
  ROOM_REPO_TOOLS,
  ROOM_REPO_TOOL_SCOPES,
  roomReposEnabled,
  runRoomRepoTool,
  type RoomRepoToolName,
} from './rooms/repos/tools.js';
import type { RoomRepos } from './rooms/repos/service.js';
import {
  AGENT_PAY_TOOLS,
  AGENT_PAY_TOOL_SCOPES,
  agentPayEnabled,
  runAgentPayTool,
  type AgentPayToolName,
} from './base/payments/agent-pay-tools.js';
import type { AgentPayService } from './base/payments/agent-pay.js';
import {
  FEED_TOOLS,
  FEED_TOOL_SCOPES,
  feedEnabled,
  runFeedTool,
  type FeedToolName,
} from './feed/tools.js';
import {
  FEED_REQUEST_TOOLS,
  FEED_REQUEST_TOOL_SCOPES,
  runFeedRequestTool,
  type FeedRequestToolName,
} from './feed/request-tools.js';
import type { FeedRequests } from './feed/requests.js';
import {
  FEED_PAY_TOOLS,
  FEED_PAY_TOOL_SCOPES,
  feedPayToolEnabled,
  runFeedPayTool,
} from './feed/pay/tool.js';
import type { FeedPayEngine } from './feed/pay/engine.js';
import {
  FEED_OFFER_TOOLS,
  FEED_OFFER_TOOL_SCOPES,
  runFeedOfferTool,
  type FeedOfferToolName,
} from './feed/offers/tools.js';
import type { OfferStore } from './feed/offers/store.js';
import { OFFER_BATCH_TOOLS, OFFER_LIMITS } from '../shared/feed-offers.js';
import { feedPayBackground } from './feed/pay/routes.js';
import {
  INVITATION_TOOLS,
  INVITATION_TOOL_SCOPES,
  runInvitationTool,
  type InvitationToolName,
  type InvitationToolService,
} from './rooms/invitations-tools.js';
import { WAKE_TOOLS, roomReadWaitToolInput, type WakeToolName } from './wake/contract.js';
import { idleKeys, type Wake } from './wake/service.js';
import { RESULT_TOOLS, type ResultToolName } from './results/contract.js';
import type { Results } from './results/service.js';
import { ELRIC_RESERVED_NAME_MESSAGE, reservedName } from './elric/names.js';
import type { InboxPage } from './messaging/contract.js';
import {
  event,
  hasPermission,
  iso,
  publicAgent,
  publicJob,
  stopJob,
  type Workspace,
  type StoredAgent,
} from './model.js';
import { decodeAgentCursor, pageAgents } from './agent-pages.js';
import { AGENT_PAGES } from '../shared/agent-pages.js';
import { workspaceToolInput } from '../shared/assistant-tools.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/**
 * Calls of the services:sell tools per minute, per grant or key and per workspace. A publish
 * carries up to 100 offers, so this allows thousands of offer writes a minute; the offer store's
 * hourly write cap is the real bound.
 */
export const OFFER_TOOL_CALLS_PER_MINUTE = 60;
/** city_pay_status calls a grant or key may make per minute, and a workspace in all. */
export const AGENT_PAY_STATUS_PER_MINUTE = 30;
export const AGENT_PAY_STATUS_WORKSPACE_PER_MINUTE = 120;
/**
 * Active assistant grants per owner. A new grant beyond this bound retires the least recently
 * used active grant (as a manual revoke would) instead of refusing the owner.
 */
export const MAX_ACTIVE_ASSISTANT_GRANTS = 25;
/**
 * No control character in a name and no U+0000 in a description: the workspace is saved as jsonb,
 * which refuses U+0000, so such text would fail the save with a 500 instead of a 400.
 */
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const NO_NUL = /^[^\u0000]*$/;
export const assistantAgentSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_NAME_MAX)
      .regex(NO_CONTROL, 'Remove control characters.'),
    description: z.string().trim().max(300).regex(NO_NUL, 'Remove control characters.').default(''),
    capability: z.enum(['research', 'extract', 'verify']),
    mode: z.enum(['hosted', 'external']),
  })
  .strict();
export const assistantJobSchema = z
  .object({
    requesterId: z.string().uuid(),
    providerId: z.string().uuid(),
    input: z.string().trim().min(1).max(12000).regex(NO_NUL, 'Remove control characters.'),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .refine(
        (key) =>
          !['a2a:', 'workflow:', 'assistant:', 'xw:'].some((prefix) => key.startsWith(prefix)),
        'Reserved transport namespace.',
      ),
  })
  .strict();
export const grantSchema = z
  .object({
    label: z.string().trim().min(1).max(64).regex(NO_NUL, 'Remove control characters.'),
    scopes: z
      .array(z.enum(ASSISTANT_SCOPES))
      .min(1)
      .max(ASSISTANT_SCOPES.length)
      .refine(
        (scopes) => scopes.includes('workspace:read') && new Set(scopes).size === scopes.length,
      ),
    expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  })
  .strict();
const createAgentSchema = assistantAgentSchema.extend({
  idempotencyKey: z.string().min(8).max(128),
});
const idSchema = z.object({ id: z.string().uuid() }).strict();
/** `last_used_at` of a grant or workspace key is written at most this often (loadAuthority). */
export const LAST_USED_WRITE_MS = 60_000;
const emptySchema = z.object({}).strict();
type GrantRow = {
  id: string;
  operator_id: string;
  token_hash: string;
  label: string;
  scopes: AssistantScope[];
  created_at: string | number;
  expires_at: string | number;
  last_used_at: string | number | null;
  revoked_at: string | number | null;
};
function projectGrant(row: GrantRow): AssistantGrant {
  const renewal = grantRenewal(Number(row.created_at), Number(row.expires_at));
  return {
    id: row.id,
    label: row.label,
    scopes: row.scopes,
    createdAt: iso(Number(row.created_at)),
    expiresAt: iso(Number(row.expires_at)),
    renewal,
    endsAtLatest: renewal === 'rolling' ? iso(rollingGrantCeiling(Number(row.created_at))) : null,
    lastUsedAt: row.last_used_at === null ? null : iso(Number(row.last_used_at)),
    revokedAt: row.revoked_at === null ? null : iso(Number(row.revoked_at)),
  };
}
interface Dependencies {
  db: Database;
  messaging: Messaging;
  owner(request: FastifyRequest): Promise<Operator>;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  limit(key: string, max: number, window: number): Promise<void>;
  limits: Pick<
    CityLimits,
    | 'agentsPerWorkspace'
    | 'assistantToolCallsPerMinute'
    | 'feedPayCallsPerGrantPerMinute'
    | 'feedPayCallsPerWorkspacePerMinute'
    | 'feedPayReadsPerGrantPerMinute'
    | 'feedPayReadsPerWorkspacePerMinute'
  >;
  fail(code: number, message: string): never;
  autonomy: AutonomyService;
  /** Public origin of a request (for Agent Card and enrollment URLs). */
  originOf(request: FastifyRequest): string;
  advanceRead(workspace: Workspace, time: number): void;
  admitJob(
    workspace: Workspace,
    values: z.infer<typeof assistantJobSchema>,
    time: number,
    transportHash?: string,
    remoteRequester?: StoredAgent,
  ): { job: ReturnType<typeof publicJob> };
  /** Locks several workspace rows in sorted order within one transaction. */
  mutateMany<T>(
    operatorIds: string[],
    action: (workspaces: Map<string, Workspace>, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  workspaces: AiWorkspaces;
  connections: Connections;
  rooms: Rooms;
  /** Room tasks (docs/ROOM_TASKS.md); the tools are behind CITY_ROOM_TASKS=1. */
  tasks: RoomTasks;
  /** Room pins and the handoff brief (docs/ROOMS.md "Pins and the handoff brief"). */
  pins: RoomPins;
  /** Room repos (docs/ROOM_REPOS.md); the tools are behind CITY_ROOM_REPOS=1. */
  repos: RoomRepos;
  /** Mentions, long-poll and wake-up webhooks (docs/WAKE.md). */
  wake: Wake;
  /** Published results, city_ask and reuse reports (docs/ANSWERS.md). */
  results: Results;
  /**
   * Base Pay P2c: agents pay other Central City agents on their own (base/payments/agent-pay.ts);
   * the tools are behind CITY_BASE_WALLET=1 and CITY_BASE_AGENT_PAY=1.
   */
  agentPay?: AgentPayService;
  /**
   * Feed D6 (feed/pay/engine.ts): city_service_call, scope services:pay, listed and callable while
   * Feed pay is on (feedPayEnabled: unless CITY_FEED or CITY_FEED_PAY is '0').
   */
  feedPay?: FeedPayEngine;
  /** How long city_service_call waits for its call (FEED_PAY_LIMITS.mcpWaitMs). */
  feedPayWaitMs?: number;
  /**
   * Feed offers (feed/offers/store.ts): the services:sell tools, listed and callable while the
   * Feed is on (unless CITY_FEED is '0').
   */
  offers?: OfferStore;
  /** Room invitations (rooms/invitations-tools.ts): the service the console uses. */
  invitations: InvitationToolService;
  /**
   * The app clock the Feed's service search reads its freshness with, so the tool and the public
   * routes agree on stale and delayed; Date.now by default.
   */
  now?: () => number;
  /**
   * The Feed's requests (feed/requests.ts): city_request_search reads the public route's list,
   * under the public list's read cap.
   */
  feedRequests: Pick<FeedRequests, 'list' | 'caps'>;
}

export const ASSISTANT_TOOL_SCOPES = {
  city_workspace: 'workspace:read',
  city_create_agent: 'agents:create',
  city_create_job: 'jobs:create',
  city_get_job: 'workspace:read',
  city_cancel_job: 'jobs:cancel',
  city_list_templates: 'workspace:read',
  city_plan_team: 'workspace:read',
  city_apply_team: 'agents:create',
  city_control: 'agents:control',
  city_send_message: 'messages:send',
  city_read_inbox: 'messages:read',
  city_ack_inbox: 'messages:read',
  city_workspace_keys: 'workspace:keys',
  city_create_workspace_key: 'workspace:keys',
  city_revoke_workspace_key: 'workspace:keys',
  // Cross-owner connections (F4 §4).
  city_create_invite: 'connections:create',
  city_list_invites: 'connections:create',
  city_revoke_invite: 'connections:create',
  city_set_connection_requests: 'connections:create',
  city_request_connection: 'connections:create',
  city_list_connection_requests: 'workspace:read',
  city_decide_connection: 'connections:approve',
  city_revoke_connection: 'connections:create',
  // Rooms (F4 §0, docs/ROOMS.md): participating and hosting are separate authority.
  city_create_room: 'rooms:host',
  city_list_room_templates: 'rooms:host',
  city_room_link: 'rooms:host',
  city_join_room: 'rooms:join',
  city_room_post: 'rooms:join',
  city_room_read: 'rooms:join',
  city_room_members: 'rooms:join',
  city_room_remove: 'rooms:host',
  city_room_close: 'rooms:host',
  city_room_leave: 'rooms:join',
  city_room_search: 'rooms:join',
  city_room_overview: 'rooms:join',
  city_room_update: 'rooms:host',
  // Room pins and the handoff brief: the same scope as posting (rooms:join).
  ...ROOM_PIN_TOOL_SCOPES,
  // Room tasks: rooms:join; host-only actions are enforced in the service.
  ...ROOM_TASK_TOOL_SCOPES,
  // Room repos: reads need rooms:join; bind/unbind need rooms:apply, and the
  // service allows the room host only.
  ...ROOM_REPO_TOOL_SCOPES,
  // Mentions and wake-up (docs/WAKE.md). Listing needs only workspace:read; each mention
  // is shown only with the scope that reads its source (messages:read or rooms:join).
  city_mentions: 'workspace:read',
  city_ack_mentions: 'workspace:read',
  city_set_wake_webhook: 'agents:wake',
  city_clear_wake_webhook: 'agents:wake',
  // Answers (docs/ANSWERS.md): asking and reuse feedback are read-scoped; publishing is not.
  city_publish_result: 'results:publish',
  city_unpublish_result: 'results:publish',
  city_ask: 'results:read',
  city_report_reuse: 'results:read',
  // Base Pay P2c: pay, never a default scope; the owner's consent per agent is checked as well.
  ...AGENT_PAY_TOOL_SCOPES,
  // Room invitations: listing them is a read; inviting is hosting; answering is joining.
  ...INVITATION_TOOL_SCOPES,
  // The Feed's service search (live unless CITY_FEED is '0'): a read of public listings.
  ...FEED_TOOL_SCOPES,
  // The Feed's request search (live unless CITY_FEED is '0'): a read of the public request list.
  ...FEED_REQUEST_TOOL_SCOPES,
  // Feed D6: pays a listed service from an agent's own wallet; services:pay, never a default
  // scope, separate from pay (which pays Central City agents only).
  ...FEED_PAY_TOOL_SCOPES,
  // Selling services in the Feed: services:sell, never a default scope, separate from
  // services:pay (buying). It moves no money.
  ...FEED_OFFER_TOOL_SCOPES,
} as const satisfies Record<string, AssistantScope>;
export type AssistantToolName = keyof typeof ASSISTANT_TOOL_SCOPES;
export type GrantValues = z.infer<typeof grantSchema>;
/**
 * Values for a new grant. `'rolling'` (OAuth consent only) starts at ROLLING_GRANT_DAYS and is
 * extended by every refresh-token exchange; the local bearer API offers fixed lifetimes only.
 */
export type NewGrantValues = Omit<GrantValues, 'expiresInDays'> & {
  expiresInDays: GrantValues['expiresInDays'] | 'rolling';
};
/** Grant identity resolved by a transport. `tokenHash` additionally binds the local bearer credential. */
export interface GrantIdentity {
  grantId: string;
  operatorId: string;
  tokenHash?: string;
  /** OAuth client id for remote MCP callers (attribution of created agents). */
  clientId?: string;
  /**
   * Set for an AI workspace key (`grantId` is then the key id): the current key row with this
   * hash is the authority, rechecked inside every executing transaction.
   */
  keyHash?: string;
  /**
   * The caller's network address (Fastify request.ip, derived with the configured trusted proxy
   * hops; never a raw forwarding header). Keys per-network limits.
   */
  address?: string;
}
/** Per-call transport context. */
export interface ToolContext {
  /** Public origin the call arrived on; used for Agent Card and enrollment URLs. */
  origin: string;
  /** Aborts when the caller's connection closes: a long-poll wait (wait=) then ends early. */
  signal?: AbortSignal;
}
/** Shared authority used by every assistant transport (local bearer tools and remote MCP). */
export interface AssistantAccess {
  /** Runs inside the owner's workspace mutation and enforces the active-grant bound. */
  insertGrant(
    workspace: Workspace,
    tx: Tx,
    time: number,
    operatorId: string,
    values: NewGrantValues,
  ): Promise<{ grant: AssistantGrant; token: string }>;
  /** Executes one tool under the owner's workspace lock after rechecking the current grant. */
  executeTool(
    identity: GrantIdentity,
    tool: string,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown>;
  /**
   * For streams and long-polls outside the tool dispatcher: rechecks the current grant or key
   * inside the caller's transaction and returns its scopes (401 when revoked or expired).
   */
  authority(identity: GrantIdentity): (tx: Tx, time: number) => Promise<AssistantScope[]>;
}

export async function registerAssistantAccess(
  app: FastifyInstance,
  d: Dependencies,
): Promise<AssistantAccess> {
  // Tables are created by migration 001 (server/migrations.ts). Recovery intentionally
  // snapshots only operators and workspaces. These authority tables are never embedded in
  // workspace data and start empty after an offline restore.
  async function insertGrant(
    workspace: Workspace,
    tx: Tx,
    time: number,
    operatorId: string,
    values: NewGrantValues,
  ): Promise<{ grant: AssistantGrant; token: string }> {
    const active = await tx.query<{ id: string; label: string }>(
      `SELECT id,label FROM assistant_grants
       WHERE operator_id=$1 AND revoked_at IS NULL AND expires_at>$2
       ORDER BY COALESCE(last_used_at,created_at) ASC,created_at ASC,id`,
      [operatorId, time],
    );
    const excess = active.rows.slice(
      0,
      Math.max(0, active.rows.length - (MAX_ACTIVE_ASSISTANT_GRANTS - 1)),
    );
    for (const oldest of excess) {
      await tx.query('UPDATE assistant_grants SET revoked_at=$2 WHERE id=$1', [oldest.id, time]);
      event(
        workspace,
        time,
        'assistant.revoked',
        `Assistant grant ${oldest.id} (${oldest.label}) revoked to make room for a new connection.`,
      );
    }
    // Keep at most 95 terminal records plus the active grants. Deleting terminal
    // receipts cannot revive authority; audit events retain the grant identity.
    await tx.query(
      `DELETE FROM assistant_grants WHERE operator_id=$1
      AND (revoked_at IS NOT NULL OR expires_at<=$2) AND id NOT IN (
        SELECT id FROM assistant_grants WHERE operator_id=$1
        AND (revoked_at IS NOT NULL OR expires_at<=$2)
        ORDER BY created_at DESC,id LIMIT 95
      )`,
      [operatorId, time],
    );
    const token = randomBytes(32).toString('base64url');
    const row = (
      await tx.query<GrantRow>(
        'INSERT INTO assistant_grants(id,operator_id,token_hash,label,scopes,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *',
        [
          randomUUID(),
          operatorId,
          hash(token),
          values.label,
          JSON.stringify(values.scopes),
          time,
          time +
            (values.expiresInDays === 'rolling' ? ROLLING_GRANT_DAYS : values.expiresInDays) *
              86_400_000,
        ],
      )
    ).rows[0]!;
    event(workspace, time, 'assistant.granted', `Assistant grant ${row.id} (${row.label}) issued.`);
    return { grant: projectGrant(row), token };
  }
  app.get('/api/assistant-access', async (request) => {
    const operator = await d.owner(request);
    const rows = await d.db.query<GrantRow>(
      'SELECT * FROM assistant_grants WHERE operator_id=$1 ORDER BY created_at DESC,id',
      [operator.id],
    );
    return { grants: rows.rows.map(projectGrant) };
  });
  app.post('/api/assistant-access', async (request, reply) => {
    const operator = await d.owner(request),
      values = grantSchema.parse(request.body);
    await d.limit(`assistant-issue:${operator.id}`, 10, 60_000);
    const result = await d.mutate(operator.id, (workspace, tx, time) =>
      insertGrant(workspace, tx, time, operator.id, values),
    );
    return reply.code(201).send(result);
  });
  app.delete('/api/assistant-access/:id', async (request) => {
    const operator = await d.owner(request),
      { id } = idSchema.parse(request.params);
    return d.mutate(operator.id, async (workspace, tx, time) => {
      const row = (
        await tx.query<GrantRow>('SELECT * FROM assistant_grants WHERE id=$1 AND operator_id=$2', [
          id,
          operator.id,
        ])
      ).rows[0];
      if (!row) d.fail(404, 'Assistant grant not found.');
      if (row.revoked_at === null) {
        await tx.query('UPDATE assistant_grants SET revoked_at=$2 WHERE id=$1', [id, time]);
        event(
          workspace,
          time,
          'assistant.revoked',
          `Assistant grant ${id} (${row.label}) revoked.`,
        );
      }
      return { ok: true };
    });
  });

  const scopes: Record<string, AssistantScope> = ASSISTANT_TOOL_SCOPES;
  app.post('/api/assistant/tools/:tool', async (request) =>
    runToolRoute(request, z.object({ tool: z.string() }).parse(request.params).tool),
  );
  // The offer batch tools take up to 1 MiB (OFFER_LIMITS.batchBytesMax) on their own static
  // routes, which win over /:tool; every other tool keeps the app's 64 KiB body limit.
  for (const tool of OFFER_BATCH_TOOLS)
    app.post(`/api/assistant/tools/${tool}`, { bodyLimit: OFFER_LIMITS.batchBytesMax }, (request) =>
      runToolRoute(request, tool),
    );
  async function runToolRoute(request: FastifyRequest, tool: string) {
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !/^Bearer (?:ccw_)?[A-Za-z0-9_-]{43}$/.test(authorization)
    )
      d.fail(401, 'Invalid assistant credential.');
    const presented = authorization.slice(7);
    if (presented.startsWith('ccw_')) {
      // AI workspace key (docs/AI_WORKSPACES.md): same tools, the key's scopes.
      const key = await d.workspaces.verifyKey(presented);
      if (!key) d.fail(401, 'Invalid assistant credential.');
      await d.limit(`workspace-key:${key.keyId}`, 120, 60_000);
      await assertOnboarded(d.db, key.operatorId);
      return executeTool(
        {
          grantId: key.keyId,
          operatorId: key.operatorId,
          keyHash: key.keyHash,
          address: request.ip,
        },
        tool,
        request.body,
        { origin: d.originOf(request) },
      );
    }
    const tokenHash = hash(presented);
    const identity = (
      await d.db.query<{ id: string; operator_id: string }>(
        'SELECT id,operator_id FROM assistant_grants WHERE token_hash=$1',
        [tokenHash],
      )
    ).rows[0];
    if (!identity) d.fail(401, 'Invalid assistant credential.');
    await d.limit(`assistant:${identity.id}`, d.limits.assistantToolCallsPerMinute, 60_000);
    await assertOnboarded(d.db, identity.operator_id);
    return executeTool(
      { grantId: identity.id, operatorId: identity.operator_id, tokenHash, address: request.ip },
      tool,
      request.body,
      { origin: d.originOf(request) },
    );
  }

  /** The credential acting: an owner-approved grant or an AI workspace key. */
  interface Authority {
    id: string;
    label: string;
    scopes: AssistantScope[];
    kind: 'grant' | 'key';
    /** Audit wording, e.g. "assistant grant <id> (<label>)". */
    who: string;
  }
  /**
   * Records the credential's use (`last_used_at`) at most once per LAST_USED_WRITE_MS: a busy
   * credential no longer writes (and row-locks) its row on every call. The guard in the UPDATE
   * keeps concurrent calls that all read an old time to one write.
   */
  async function touchLastUsed(
    tx: Tx,
    table: 'assistant_grants' | 'workspace_keys',
    id: string,
    stored: string | number | null,
    time: number,
  ): Promise<void> {
    if (stored !== null && time - Number(stored) < LAST_USED_WRITE_MS) return;
    await tx.query(
      `UPDATE ${table} SET last_used_at=$2 WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<=$3)`,
      [id, time, time - LAST_USED_WRITE_MS],
    );
  }
  /**
   * Rechecks the current credential row inside the executing transaction (lookup outside it is
   * only a lookup): a revoked, expired or rotated grant or key fails here with 401. This check
   * runs on every call; only the `last_used_at` write is throttled (touchLastUsed).
   */
  async function loadAuthority(tx: Tx, identity: GrantIdentity, time: number): Promise<Authority> {
    // The shared onboarding gate (server/onboarding.ts): grants and AI workspace keys (through
    // the AI workspace's human co-owners) on every path that acts with them.
    await assertOnboarded(tx, identity.operatorId);
    if (identity.keyHash !== undefined) {
      const key = (
        await tx.query<{
          id: string;
          label: string;
          scopes: AssistantScope[];
          revoked_at: string | number | null;
          last_used_at: string | number | null;
        }>(
          'SELECT id,label,scopes,revoked_at,last_used_at FROM workspace_keys WHERE id=$1 AND operator_id=$2 AND key_hash=$3',
          [identity.grantId, identity.operatorId, identity.keyHash],
        )
      ).rows[0];
      if (!key || key.revoked_at !== null) d.fail(401, 'Workspace key revoked.');
      await touchLastUsed(tx, 'workspace_keys', key.id, key.last_used_at, time);
      return {
        id: key.id,
        label: key.label,
        scopes: key.scopes,
        kind: 'key',
        who: `workspace key ${key.id} (${key.label})`,
      };
    }
    const grant = (
      await tx.query<GrantRow>(
        identity.tokenHash === undefined
          ? 'SELECT * FROM assistant_grants WHERE id=$1 AND operator_id=$2'
          : 'SELECT * FROM assistant_grants WHERE id=$1 AND operator_id=$2 AND token_hash=$3',
        identity.tokenHash === undefined
          ? [identity.grantId, identity.operatorId]
          : [identity.grantId, identity.operatorId, identity.tokenHash],
      )
    ).rows[0];
    if (!grant || grant.revoked_at !== null || Number(grant.expires_at) <= time)
      d.fail(401, 'Assistant grant expired or revoked.');
    await touchLastUsed(tx, 'assistant_grants', grant.id, grant.last_used_at, time);
    return {
      id: grant.id,
      label: grant.label,
      scopes: grant.scopes,
      kind: 'grant',
      who: `assistant grant ${grant.id} (${grant.label})`,
    };
  }
  function permit(authority: Authority, tool: string): void {
    if (!authority.scopes.includes('workspace:read') || !authority.scopes.includes(scopes[tool]!))
      d.fail(
        403,
        `${authority.kind === 'key' ? 'Workspace key' : 'Assistant grant'} does not permit this tool.`,
      );
  }
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  function receiptsOf(tx: Tx, authority: Authority) {
    const [table, column] =
      authority.kind === 'key'
        ? ['workspace_key_receipts', 'key_id']
        : ['assistant_receipts', 'grant_id'];
    return {
      get: async (toolName: string, key: string) =>
        (
          await tx.query<{ request_hash: string; resource_id: string }>(
            `SELECT request_hash,resource_id FROM ${table} WHERE ${column}=$1 AND tool=$2 AND request_key=$3`,
            [authority.id, toolName, key],
          )
        ).rows[0],
      put: async (toolName: string, key: string, requestHash: string, resourceId: string) => {
        await tx.query(
          `INSERT INTO ${table}(${column},tool,request_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5)`,
          [authority.id, toolName, key, requestHash, resourceId],
        );
      },
    };
  }
  /** Idempotent action per credential: a replay returns the recorded resource id. */
  async function idempotent(
    tx: Tx,
    authority: Authority,
    toolName: string,
    values: { idempotencyKey: string },
    action: () => string,
  ): Promise<string> {
    const receipts = receiptsOf(tx, authority);
    const key = hash(values.idempotencyKey),
      fingerprint = hash(JSON.stringify(values));
    const receipt = await receipts.get(toolName, key);
    if (receipt) {
      if (receipt.request_hash !== fingerprint)
        d.fail(409, 'This idempotency key belongs to different arguments.');
      return receipt.resource_id;
    }
    const id = action();
    await receipts.put(toolName, key, fingerprint, id);
    return id;
  }
  /** Guard for tools that run in their own transaction (messaging, cross-workspace). */
  function guardFor(identity: GrantIdentity, tool: string): Guard {
    return async (tx, time) => permit(await loadAuthority(tx, identity, time), tool);
  }

  async function executeTool(
    identity: GrantIdentity,
    tool: string,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    if (!Object.hasOwn(scopes, tool)) d.fail(404, 'Assistant tool not found.');
    if (tool === 'city_send_message' || tool === 'city_read_inbox' || tool === 'city_ack_inbox')
      return messageTool(identity, tool, body, context.signal);
    if ((WAKE_TOOLS as readonly string[]).includes(tool))
      return d.wake.executeTool(
        {
          operatorId: identity.operatorId,
          actor:
            identity.keyHash !== undefined
              ? `workspace key ${identity.grantId}`
              : `assistant grant ${identity.grantId}`,
        },
        tool as WakeToolName,
        body,
        async (tx, time) => {
          const authority = await loadAuthority(tx, identity, time);
          permit(authority, tool);
          return authority.scopes;
        },
        context.signal,
      );
    if (
      tool === 'city_create_invite' ||
      tool === 'city_list_invites' ||
      tool === 'city_revoke_invite' ||
      tool === 'city_set_connection_requests' ||
      tool === 'city_request_connection' ||
      tool === 'city_list_connection_requests' ||
      tool === 'city_decide_connection' ||
      tool === 'city_revoke_connection'
    )
      return connectionTool(identity, tool, body);
    if ((ROOM_TOOLS as readonly string[]).includes(tool))
      return roomTool(identity, tool as RoomToolName, body, context);
    if ((ROOM_PIN_TOOLS as readonly string[]).includes(tool))
      return pinTool(identity, tool as RoomPinToolName, body, context);
    if ((INVITATION_TOOLS as readonly string[]).includes(tool))
      return invitationTool(identity, tool as InvitationToolName, body, context);
    if ((ROOM_TASK_TOOLS as readonly string[]).includes(tool)) {
      if (!roomTasksEnabled(process.env)) d.fail(404, 'Assistant tool not found.');
      return taskTool(identity, tool as RoomTaskToolName, body, context);
    }
    if ((ROOM_REPO_TOOLS as readonly string[]).includes(tool)) {
      if (!roomReposEnabled(process.env)) d.fail(404, 'Assistant tool not found.');
      return repoTool(identity, tool as RoomRepoToolName, body, context);
    }
    if ((RESULT_TOOLS as readonly string[]).includes(tool))
      return resultTool(identity, tool as ResultToolName, body, context);
    if ((AGENT_PAY_TOOLS as readonly string[]).includes(tool)) {
      if (!agentPayEnabled(process.env) || !d.agentPay) d.fail(404, 'Assistant tool not found.');
      return payTool(identity, tool as AgentPayToolName, body);
    }
    if ((FEED_PAY_TOOLS as readonly string[]).includes(tool)) {
      if (!d.feedPay || !feedPayToolEnabled(process.env, identity.operatorId))
        d.fail(404, 'Assistant tool not found.');
      return feedPayTool(identity, body, context);
    }
    if ((FEED_OFFER_TOOLS as readonly string[]).includes(tool)) {
      if (!d.offers || !feedEnabled(process.env)) d.fail(404, 'Assistant tool not found.');
      return offerTool(identity, tool as FeedOfferToolName, body);
    }
    if ((FEED_TOOLS as readonly string[]).includes(tool)) {
      if (!feedEnabled(process.env)) d.fail(404, 'Assistant tool not found.');
      return feedTool(identity, tool as FeedToolName, body, context);
    }
    if ((FEED_REQUEST_TOOLS as readonly string[]).includes(tool)) {
      if (!feedEnabled(process.env)) d.fail(404, 'Assistant tool not found.');
      return feedRequestTool(identity, tool as FeedRequestToolName, body, context);
    }
    if (tool === 'city_create_job' || tool === 'city_get_job' || tool === 'city_cancel_job') {
      const remote = await remoteJobTool(identity, tool, body);
      if (remote !== undefined) return remote;
    }
    return d.mutate(identity.operatorId, async (workspace, tx, time) => {
      // Owner revoke and all delegated actions use the same workspace lock. Authentication
      // outside the transaction is only lookup; this current row is the authority check.
      const authority = await loadAuthority(tx, identity, time);
      permit(authority, tool);
      const agent = (id: string) =>
        workspace.agents.find((item) => item.id === id) ?? d.fail(404, 'Agent not found.');
      const job = (id: string) =>
        workspace.jobs.find((item) => item.id === id) ?? d.fail(404, 'Job not found.');
      const createdBy: AgentCreator =
        authority.kind === 'key'
          ? { kind: 'workspace-key', id: authority.id }
          : identity.tokenHash === undefined
            ? {
                kind: 'oauth-client',
                id: authority.id,
                ...(identity.clientId ? { clientId: identity.clientId } : {}),
              }
            : { kind: 'assistant', id: authority.id };
      const actor: Actor = {
        mode: 'owned',
        operatorId: identity.operatorId,
        createdBy,
        rootSponsor: identity.operatorId,
        label: authority.who,
        canConnect: authority.scopes.includes('connections:create'),
        origin: context.origin,
        receipts: receiptsOf(tx, authority),
      };
      const manifestMode =
        tool === 'city_create_agent' &&
        body !== null &&
        typeof body === 'object' &&
        ['manifest', 'template', 'overrides', 'dry_run', 'idempotency_key', 'parent_agent_id'].some(
          (key) => Object.hasOwn(body, key),
        );
      let response: unknown;
      if (
        tool === 'city_workspace_keys' ||
        tool === 'city_create_workspace_key' ||
        tool === 'city_revoke_workspace_key'
      ) {
        response = await d.workspaces.keyTool(
          tx,
          workspace,
          time,
          identity.operatorId,
          {
            ...(authority.kind === 'key' ? { keyId: authority.id } : {}),
            scopes: authority.scopes,
            label: authority.who,
          },
          tool,
          body,
        );
      } else if (tool === 'city_list_templates') {
        emptySchema.parse(body);
        response = d.autonomy.listTemplates();
      } else if (tool === 'city_plan_team') {
        response = await d.autonomy.planTool(tx, workspace, actor, body);
      } else if (tool === 'city_apply_team') {
        response = await d.autonomy.applyTeamTool(tx, workspace, time, actor, body);
      } else if (tool === 'city_control') {
        response = await d.autonomy.controlTool(tx, workspace, time, actor, body);
      } else if (manifestMode) {
        response = await d.autonomy.createAgentTool(tx, workspace, time, actor, body);
      } else if (tool === 'city_workspace') {
        const paging = workspaceToolInput.parse(body);
        const cursor = paging.cursor === undefined ? null : decodeAgentCursor(paging.cursor);
        if (paging.cursor !== undefined && !cursor) d.fail(400, 'Invalid cursor.');
        d.advanceRead(workspace, time);
        const operator = (
          await tx.query<Operator>('SELECT id,name FROM operators WHERE id=$1', [
            identity.operatorId,
          ])
        ).rows[0]!;
        const connections = workspace.connections.map(
          ({ id, fromAgentId, toAgentId, createdAt }) => ({
            id,
            fromAgentId,
            toAgentId,
            createdAt,
          }),
        );
        // shared/agent-pages.ts: small workspaces answer in full, unchanged, unless they ask
        // for a page; a large one always answers a page, newest first, with the total.
        const paged =
          paging.limit !== undefined ||
          cursor !== null ||
          workspace.agents.length > AGENT_PAGES.threshold;
        if (!paged)
          response = {
            operator,
            agents: workspace.agents.map((item) => publicAgent(item, workspace.jobs, time)),
            connections,
            paused: workspace.paused,
          };
        else {
          const page = pageAgents(workspace.agents, {
            limit: paging.limit ?? AGENT_PAGES.size,
            cursor,
          });
          response = {
            operator,
            agents: page.items.map((item) => publicAgent(item, workspace.jobs, time)),
            connections,
            paused: workspace.paused,
            agents_total: workspace.agents.length,
            next_cursor: page.nextCursor,
          };
        }
      } else if (tool === 'city_create_agent') {
        const values = createAgentSchema.parse(body);
        if (reservedName(values.name)) d.fail(409, ELRIC_RESERVED_NAME_MESSAGE); // docs/ELRIC.md
        if (workspace.paused) d.fail(409, 'Workspace is paused.');
        const id = await idempotent(tx, authority, tool, values, () => {
          if (workspace.agents.length >= d.limits.agentsPerWorkspace)
            d.fail(409, `Local workspace limit of ${d.limits.agentsPerWorkspace} agents reached.`);
          const { idempotencyKey: _key, ...fields } = values;
          const created: StoredAgent = {
            id: randomUUID(),
            ...fields,
            isDemo: fields.mode === 'hosted',
            lastSeenAt: null,
            createdAt: iso(time),
            revokedAt: null,
            lastSequence: -1,
            announcedOnline: false,
          };
          workspace.agents.push(created);
          event(
            workspace,
            time,
            'agent.registered',
            `${created.name} registered by ${authority.who} as ${created.isDemo ? 'a deterministic demonstration' : 'an external record awaiting owner runtime setup'}.`,
            created.id,
          );
          return created.id;
        });
        const created = agent(id);
        response = {
          agent: publicAgent(created, workspace.jobs, time),
          connectionRequired: !workspace.connections.some(
            (connection) => connection.fromAgentId === id || connection.toAgentId === id,
          ),
          runtimeSetupRequired: created.mode === 'external',
        };
      } else if (tool === 'city_create_job') {
        const values = assistantJobSchema.parse(body);
        if (agent(values.providerId).mode !== 'hosted')
          d.fail(403, 'Assistant jobs are limited to hosted, zero-cost demonstrations.');
        if (!hasPermission(workspace, values))
          d.fail(403, 'A current directional connection is required.');
        const id = await idempotent(
          tx,
          authority,
          tool,
          values,
          () =>
            d.admitJob(
              workspace,
              {
                ...values,
                idempotencyKey: `assistant:${authority.id}:${hash(values.idempotencyKey)}`,
              },
              time,
            ).job.id,
        );
        response = { job: publicJob(job(id)) };
      } else {
        const { id } = idSchema.parse(body),
          found = job(id);
        if (tool === 'city_cancel_job') {
          stopJob(workspace, found, time, `${capital(authority.who)} canceled the job.`);
          response = { ok: true };
        } else {
          d.advanceRead(workspace, time);
          response = { job: publicJob(found) };
        }
      }
      event(workspace, time, 'assistant.tool_used', `${capital(authority.who)} used ${tool}.`);
      return response;
    });
  }

  /**
   * Hosted demo jobs across workspaces (docs/AI_WORKSPACES.md): a requester of this workspace asks
   * a hosted provider of another workspace along an accepted cross-workspace connection. The job
   * lives in the provider's workspace (it executes and counts there); the requester creates, reads
   * and cancels it through its own credential. Returns undefined for same-workspace calls.
   */
  async function remoteJobTool(
    identity: GrantIdentity,
    tool: 'city_create_job' | 'city_get_job' | 'city_cancel_job',
    body: unknown,
  ): Promise<unknown> {
    // Invalid arguments fall through to the same-workspace path, which checks scope first.
    if (tool === 'city_create_job') {
      const parsed = assistantJobSchema.safeParse(body);
      if (!parsed.success) return undefined;
      const values = parsed.data;
      const local = (
        await d.db.query<{ is_local: boolean }>(
          "SELECT (data->'agents') @> $2::jsonb AS is_local FROM workspaces WHERE operator_id=$1",
          [identity.operatorId, JSON.stringify([{ id: values.providerId }])],
        )
      ).rows[0];
      if (!local || local.is_local) return undefined;
      const link = (
        await d.db.query<{ to_operator_id: string }>(
          "SELECT to_owner_id AS to_operator_id FROM cross_connections WHERE from_owner_id=$1 AND from_agent_id=$2 AND to_agent_id=$3 AND status='approved' LIMIT 1",
          [identity.operatorId, values.requesterId, values.providerId],
        )
      ).rows[0];
      if (!link) return undefined;
      return d.mutateMany(
        [identity.operatorId, link.to_operator_id],
        async (workspaces, tx, time) => {
          const authority = await loadAuthority(tx, identity, time);
          permit(authority, tool);
          const own = workspaces.get(identity.operatorId)!;
          const other = workspaces.get(link.to_operator_id)!;
          const current = await tx.query(
            "SELECT 1 FROM cross_connections WHERE from_owner_id=$1 AND from_agent_id=$2 AND to_agent_id=$3 AND to_owner_id=$4 AND status='approved'",
            [identity.operatorId, values.requesterId, values.providerId, link.to_operator_id],
          );
          if (!current.rows.length) d.fail(403, 'A current directional connection is required.');
          const requester =
            own.agents.find((item) => item.id === values.requesterId) ??
            d.fail(404, 'Agent not found.');
          if (requester.revokedAt || requester.pausedAt)
            d.fail(409, `${requester.name} is revoked or paused.`);
          if (own.paused) d.fail(409, 'Workspace is paused.');
          const provider =
            other.agents.find((item) => item.id === values.providerId) ??
            d.fail(404, 'Agent not found.');
          if (provider.mode !== 'hosted')
            d.fail(403, 'Assistant jobs are limited to hosted, zero-cost demonstrations.');
          const id = await idempotent(
            tx,
            authority,
            tool,
            values,
            () =>
              d.admitJob(
                other,
                {
                  ...values,
                  idempotencyKey: `xw:${authority.id}:${hash(values.idempotencyKey)}`,
                },
                time,
                undefined,
                requester,
              ).job.id,
          );
          const created =
            other.jobs.find((item) => item.id === id) ?? d.fail(404, 'Job not found.');
          event(
            own,
            time,
            'assistant.tool_used',
            `${capital(authority.who)} requested ${provider.capability} for ${requester.name} from an agent in another workspace (job ${id}).`,
            requester.id,
          );
          return { job: publicJob(created) };
        },
      );
    }
    const parsed = idSchema.safeParse(body);
    if (!parsed.success) return undefined;
    const { id } = parsed.data;
    const home = (
      await d.db.query<{ is_local: boolean }>(
        "SELECT (data->'jobs') @> $2::jsonb AS is_local FROM workspaces WHERE operator_id=$1",
        [identity.operatorId, JSON.stringify([{ id }])],
      )
    ).rows[0];
    if (!home || home.is_local) return undefined;
    // Only jobs this workspace's agents requested along a (current or former) accepted connection.
    const remote = (
      await d.db.query<{ to_operator_id: string }>(
        `SELECT c.to_owner_id AS to_operator_id FROM cross_connections c JOIN workspaces w ON w.operator_id=c.to_owner_id
          WHERE c.from_owner_id=$1 AND c.status IN ('approved','revoked')
          AND (w.data->'jobs') @> jsonb_build_array(jsonb_build_object('id', $2::text, 'requesterId', c.from_agent_id))
          LIMIT 1`,
        [identity.operatorId, id],
      )
    ).rows[0];
    if (!remote) return undefined;
    return d.mutateMany(
      [identity.operatorId, remote.to_operator_id],
      async (workspaces, tx, time) => {
        const authority = await loadAuthority(tx, identity, time);
        permit(authority, tool);
        const own = workspaces.get(identity.operatorId)!;
        const other = workspaces.get(remote.to_operator_id)!;
        const found = other.jobs.find(
          (item) => item.id === id && own.agents.some((agent) => agent.id === item.requesterId),
        );
        if (!found) d.fail(404, 'Job not found.');
        if (tool === 'city_cancel_job') {
          stopJob(other, found, time, 'The requester in another workspace canceled the job.');
          event(own, time, 'assistant.tool_used', `${capital(authority.who)} used ${tool}.`);
          return { ok: true };
        }
        d.advanceRead(other, time);
        return { job: publicJob(found) };
      },
    );
  }

  /**
   * Messaging tools never take the owner's workspace lock: the current grant or key is rechecked
   * inside the messaging transaction itself (docs/MESSAGING.md). They are not written to the
   * workspace activity log, which would require that lock on every message.
   */
  async function messageTool(
    identity: GrantIdentity,
    tool: 'city_send_message' | 'city_read_inbox' | 'city_ack_inbox',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const guard = guardFor(identity, tool);
    const principal = { operatorId: identity.operatorId };
    if (tool === 'city_send_message') {
      const { from_agent_id, ...values } = sendMessageToolInput.parse(body);
      return d.messaging.send(principal, from_agent_id, values, guard);
    }
    if (tool === 'city_read_inbox') {
      const { agent_id, wait, ...query } = readInboxToolInput.parse(body);
      return d.wake.longPoll(
        wait,
        () => d.messaging.readInbox(principal, agent_id, { ...query, start: 'acked' }, guard),
        (page: InboxPage) => idleKeys('inbox', agent_id, page, page.messages.length),
        signal,
        { owner: identity.operatorId, agent: agent_id },
        true,
      );
    }
    const { agent_id, seq } = ackInboxToolInput.parse(body);
    return d.messaging.ack(principal, agent_id, seq, guard);
  }

  /** Cross-workspace connection tools; the credential is rechecked inside their transaction. */
  async function connectionTool(
    identity: GrantIdentity,
    tool:
      | 'city_create_invite'
      | 'city_list_invites'
      | 'city_revoke_invite'
      | 'city_set_connection_requests'
      | 'city_request_connection'
      | 'city_list_connection_requests'
      | 'city_decide_connection'
      | 'city_revoke_connection',
    body: unknown,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
    };
    const guard = guardFor(identity, tool);
    if (tool === 'city_create_invite') return d.connections.createInvite(principal, body, guard);
    if (tool === 'city_list_invites') return d.connections.listInvites(principal, body, guard);
    if (tool === 'city_revoke_invite') return d.connections.revokeInvite(principal, body, guard);
    if (tool === 'city_set_connection_requests')
      return d.connections.setRequests(principal, body, guard);
    if (tool === 'city_request_connection') return d.connections.request(principal, body, guard);
    if (tool === 'city_list_connection_requests') return d.connections.list(principal, body, guard);
    if (tool === 'city_decide_connection') return d.connections.decide(principal, body, guard);
    return d.connections.revoke(principal, body, guard);
  }
  /**
   * Room tools: the credential is rechecked inside the room transaction. Joining with a new agent
   * (`create`) also needs agents:create.
   */
  async function roomTool(
    identity: GrantIdentity,
    tool: RoomToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      origin: context.origin,
    };
    const creates =
      tool === 'city_join_room' &&
      body !== null &&
      typeof body === 'object' &&
      Object.hasOwn(body, 'create');
    const guard: Guard = async (tx, time) => {
      const authority = await loadAuthority(tx, identity, time);
      permit(authority, tool);
      if (creates && !authority.scopes.includes('agents:create'))
        d.fail(403, 'Joining with a new agent also needs agents:create.');
    };
    if (tool === 'city_create_room') return d.rooms.create(principal, body, guard);
    if (tool === 'city_list_room_templates') return d.rooms.templates(principal, body, guard);
    if (tool === 'city_room_link') return d.rooms.link(principal, body, guard);
    if (tool === 'city_join_room') return d.rooms.join(principal, body, guard);
    if (tool === 'city_room_post') return d.rooms.post(principal, body, guard);
    if (tool === 'city_room_read') {
      const { wait, ...query } = roomReadWaitToolInput.parse(body);
      type Page = {
        room: { id: string };
        messages: unknown[];
        latest_seq: number;
        next_since: number;
        handoff_brief?: string;
      };
      return d.wake.longPoll(
        wait,
        // The MCP read is the one that may carry the handoff brief (docs/ROOMS.md).
        () => d.rooms.read({ ...principal, handoffBrief: true }, query, guard) as Promise<Page>,
        // A first read's handoff brief counts as news: the long-poll answers at once with it.
        (page) =>
          idleKeys('room', page.room.id, page, page.messages.length + (page.handoff_brief ? 1 : 0)),
        context.signal,
        // The reading agent is resolved inside the room read; the grant (or key) is the one
        // client session, so it carries the per-client wait budget — one bucket per room, so a
        // connector may poll its rooms in parallel.
        { owner: identity.operatorId, grant: identity.grantId, room: query.room_id },
        true,
      );
    }
    if (tool === 'city_room_members') return d.rooms.members(principal, body, guard);
    if (tool === 'city_room_remove') return d.rooms.remove(principal, body, guard);
    if (tool === 'city_room_leave') return d.rooms.leave(principal, body, guard);
    if (tool === 'city_room_search') return d.rooms.search(principal, body, guard);
    if (tool === 'city_room_overview') return d.rooms.overview(principal, body, guard);
    if (tool === 'city_room_update') return d.rooms.update(principal, body, guard);
    return d.rooms.close(principal, body, guard);
  }
  /**
   * Room task tools: the tasks service takes no guard and runs its own transactions,
   * so the current grant or key is rechecked in a small transaction first (no workspace lock).
   */
  async function taskTool(
    identity: GrantIdentity,
    tool: RoomTaskToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      origin: context.origin,
    };
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    return runRoomTaskTool(d.tasks, tool, body, principal);
  }
  /**
   * Room pin and brief tools: like the task tools, the service runs its own transactions, so the
   * current grant or key is rechecked in a small transaction first.
   */
  async function pinTool(
    identity: GrantIdentity,
    tool: RoomPinToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      origin: context.origin,
    };
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    return runRoomPinTool(d.pins, tool, body, principal);
  }
  /**
   * Room invitation tools: the current grant or key is rechecked in a small
   * transaction first (the reads), and again first inside the invitation's own transaction for
   * the writes (send, decide), as every room write does.
   */
  async function invitationTool(
    identity: GrantIdentity,
    tool: InvitationToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      origin: context.origin,
    };
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    return runInvitationTool(d.invitations, tool, body, principal, guard);
  }
  /**
   * Room repo tools: like the task tools, the service runs its own transactions
   * (and calls GitHub between them), so the credential is rechecked in a small transaction first.
   */
  async function repoTool(
    identity: GrantIdentity,
    tool: RoomRepoToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      origin: context.origin,
    };
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    return runRoomRepoTool(d.repos, tool, body, principal);
  }
  /**
   * Answers tools: the credential is rechecked inside the result transaction. Publish and
   * unpublish run under the workspace lock; asks and reports never take it.
   */
  async function resultTool(
    identity: GrantIdentity,
    tool: ResultToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const principal = {
      operatorId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      origin: context.origin,
      address: identity.address ?? '',
    };
    const guard = guardFor(identity, tool);
    if (tool === 'city_publish_result') return d.results.publish(principal, body, guard);
    if (tool === 'city_unpublish_result') return d.results.unpublish(principal, body, guard);
    if (tool === 'city_ask') return d.results.ask(principal, body, guard);
    return d.results.report(principal, body, guard);
  }
  /**
   * Base Pay P2c tools: the payment runs its own transactions and reads Base between them, so no
   * workspace lock is held. The current grant or key (rotation, revocation, expiry, the pay scope)
   * is rechecked here first, and the payment rechecks it the same way before it is reserved, before
   * it is signed and right before its first broadcast (revalidate).
   */
  async function payTool(
    identity: GrantIdentity,
    tool: AgentPayToolName,
    body: unknown,
  ): Promise<unknown> {
    const guard = guardFor(identity, tool);
    const revalidate = () => d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    await revalidate();
    if (tool === 'city_pay') await d.limit(`agent-pay:${identity.grantId}`, 20, 60_000);
    // A status read of a payment in flight reads the bundler and Base each time (the endpoint the
    // paymaster shares): its own budget per grant or key, and one per workspace that several
    // grants and keys share.
    if (tool === 'city_pay_status') {
      await d.limit(`agent-pay-status:${identity.grantId}`, AGENT_PAY_STATUS_PER_MINUTE, 60_000);
      await d.limit(
        `agent-pay-status:ws:${identity.operatorId}`,
        AGENT_PAY_STATUS_WORKSPACE_PER_MINUTE,
        60_000,
      );
    }
    return runAgentPayTool(d.agentPay!, tool, body, {
      workspaceId: identity.operatorId,
      actor:
        identity.keyHash !== undefined
          ? `workspace key ${identity.grantId}`
          : `assistant grant ${identity.grantId}`,
      revalidate,
    });
  }
  /**
   * The Feed's service search: a read of public listings, outside any workspace lock. The current
   * grant or key is rechecked in a small transaction first, as for the other module tools.
   */
  async function feedTool(
    identity: GrantIdentity,
    tool: FeedToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    return runFeedTool({ db: d.db, now: d.now }, tool, body, {
      origin: context.origin,
      // While Feed pay is on for this workspace the notice says how to pay a listed service.
      payOn: feedPayToolEnabled(process.env, identity.operatorId),
    });
  }
  /**
   * city_service_call: the payment runs its own transactions and reads Base between them, so no
   * workspace lock is held. The current grant or key (rotation, revocation, expiry, the services:pay scope)
   * is rechecked here first, and the engine rechecks it the same way before the call is reserved
   * and before its payment is signed (revalidate).
   *
   * Budgets (CityLimits feedPay*, the same for every workspace), charged by the engine once the
   * idempotency key is looked up: a new call spends a call token of the grant or key and one of
   * the workspace (several grants or keys of one workspace share it); a same-key re-read of an
   * existing call spends a read token instead, never a call token. The engine also holds new calls
   * to the workspace's cap of calls in flight.
   */
  async function feedPayTool(
    identity: GrantIdentity,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const guard = guardFor(identity, 'city_service_call');
    const revalidate = () => d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    await revalidate();
    const caps = d.limits;
    const admission = {
      fresh: async () => {
        await d.limit(
          `feed-pay-mcp:${identity.grantId}`,
          caps.feedPayCallsPerGrantPerMinute,
          60_000,
        );
        await d.limit(
          `feed-pay-mcp:ws:${identity.operatorId}`,
          caps.feedPayCallsPerWorkspacePerMinute,
          60_000,
        );
      },
      reread: async () => {
        await d.limit(
          `feed-pay-mcp-read:${identity.grantId}`,
          caps.feedPayReadsPerGrantPerMinute,
          60_000,
        );
        await d.limit(
          `feed-pay-mcp-read:ws:${identity.operatorId}`,
          caps.feedPayReadsPerWorkspacePerMinute,
          60_000,
        );
      },
    };
    return runFeedPayTool(
      {
        engine: d.feedPay!,
        env: process.env,
        background: feedPayBackground,
        ...(d.feedPayWaitMs !== undefined ? { waitMs: d.feedPayWaitMs } : {}),
      },
      body,
      {
        workspaceId: identity.operatorId,
        actor:
          identity.keyHash !== undefined
            ? `workspace key ${identity.grantId}`
            : `assistant grant ${identity.grantId}`,
        revalidate,
        grant: {
          kind: identity.keyHash !== undefined ? 'key' : 'grant',
          id: identity.grantId,
        },
        origin: context.origin,
        admission,
      },
    );
  }
  /**
   * The services:sell tools (feed/offers/tools.ts): each write is one transaction of the offer
   * store under the workspace's row lock, so no lock is held here. The current grant or key is
   * rechecked first, as for the other module tools. Calls are capped per grant or key and per
   * workspace (several grants of one workspace share one budget); the store's own caps (offers
   * per agent and per workspace, offer writes per hour) are the same for every workspace.
   */
  async function offerTool(
    identity: GrantIdentity,
    tool: FeedOfferToolName,
    body: unknown,
  ): Promise<unknown> {
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    await d.limit(`feed-offers-mcp:${identity.grantId}`, OFFER_TOOL_CALLS_PER_MINUTE, 60_000);
    await d.limit(`feed-offers-mcp:ws:${identity.operatorId}`, OFFER_TOOL_CALLS_PER_MINUTE, 60_000);
    return runFeedOfferTool(d.offers!, tool, body, { workspaceId: identity.operatorId });
  }
  /**
   * The Feed's request search: a read of the public request list, outside any workspace lock,
   * after the same recheck of the current grant or key as feedTool.
   */
  async function feedRequestTool(
    identity: GrantIdentity,
    tool: FeedRequestToolName,
    body: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const guard = guardFor(identity, tool);
    await d.db.transaction((tx) => guard(tx, (d.now ?? Date.now)()));
    // The public list is edge-cached and capped per address; this search reaches the database on
    // every call, so each workspace gets the same reads per minute as one address there, shared by
    // all its grants and keys (more grants buy no more reads).
    await d.limit(
      `feed-read-owner:${identity.operatorId}`,
      d.feedRequests.caps.readsPerMinute,
      60_000,
    );
    return runFeedRequestTool({ requests: d.feedRequests }, tool, body, {
      origin: context.origin,
    });
  }
  function authority(identity: GrantIdentity) {
    return async (tx: Tx, time: number) => (await loadAuthority(tx, identity, time)).scopes;
  }
  return { insertGrant, executeTool, authority };
}
