import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Transaction as Tx } from '../database.js';
import type { CityLimits } from '../limits.js';
import {
  ASSISTANT_SCOPES,
  type AssistantScope,
  type WorkspaceKey,
  type WorkspaceMembership,
} from '../../shared/assistant.js';
import type { Operator } from '../../shared/types.js';
import { NO_NUL_MESSAGE, noNul } from '../messaging/contract.js';
import { clientAddressKey, clientAddressPrefixes } from '../rate-limit.js';
import { emptyWorkspace, event, iso, type Workspace } from '../model.js';
import { highEntropyKey, unclaimedScopeId } from '../autonomy/index.js';
import { revokeResponderCredentials } from '../responder/revoke.js';

/**
 * AI-owned workspaces ("AI parity", docs/AI_WORKSPACES.md): an AI client without any
 * human creates a workspace of its own, receives a workspace key (`ccw_...`, shown once, stored
 * hashed) with every owner scope, and uses it as a bearer credential on /mcp and the assistant
 * tool endpoint. A person may later claim the workspace with its one-time claim token and becomes
 * a co-owner (operator_links); the AI operator keeps owning the rows, so tenant isolation is the
 * same single-operator scoping every other workspace has.
 */
export const WORKSPACE_KEY = /^ccw_[A-Za-z0-9_-]{43}$/;
/**
 * Scopes of the key an AI workspace is created with (anonymously, on /mcp/open or
 * /api/public/workspaces): everything except rooms:host, rooms:apply, results:publish, pay,
 * services:pay and services:sell. Hosting rooms, opening pull requests from rooms, publishing
 * results, paying other agents or Feed services and selling services in the Feed need
 * a human co-owner, who mints a key with those scopes in the console (docs/ROOMS.md,
 * docs/ROOM_REPOS.md, docs/ANSWERS.md); keys the AI mints itself can never exceed its own scopes.
 */
export const INITIAL_KEY_SCOPES: readonly AssistantScope[] = ASSISTANT_SCOPES.filter(
  (scope) =>
    scope !== 'rooms:host' &&
    scope !== 'rooms:apply' &&
    scope !== 'results:publish' &&
    scope !== 'pay' &&
    scope !== 'services:pay' &&
    scope !== 'services:sell',
);
export const WORKSPACE_CLAIM_TOKEN = /^ccwclaim_[A-Za-z0-9_-]{43}$/;
/** A co-owner claim link is valid for 7 days after the AI workspace was created. */
export const WORKSPACE_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;
/** Revoked key records kept per workspace for the audit listing. */
const RETAINED_REVOKED_KEYS = 50;
/** AI workspaces one person may co-own. */
const LINKS_PER_PERSON = 50;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validated like account names; display names need not be unique (a unique slug is stored). */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(/^[a-zA-Z0-9 _.-]+$/)
  .describe('Display name: 2-48 letters, digits, spaces, "_", "." or "-". Need not be unique.');
export const createWorkspaceToolInput = z
  .object({
    name: workspaceNameSchema,
    idempotency_key: z
      .string()
      .max(128)
      .describe(
        'Unguessable key: a fresh random UUID v4 or 16+ random bytes as base64url. Retry with the same key and name.',
      ),
  })
  .strict();
const scopeList = z
  .array(z.enum(ASSISTANT_SCOPES))
  .min(1)
  .max(ASSISTANT_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'Scopes must be distinct.')
  .refine((scopes) => scopes.includes('workspace:read'), 'workspace:read is always required.');
export const listWorkspaceKeysToolInput = z.object({}).strict();
export const createWorkspaceKeyToolInput = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(noNul, NO_NUL_MESSAGE)
      .describe('Who or what will hold this key.'),
    scopes: scopeList
      .optional()
      .describe('Subset of the calling credential scopes (default: all of them).'),
  })
  .strict();
export const revokeWorkspaceKeyToolInput = z.object({ key_id: z.string().uuid() }).strict();

type KeyRow = {
  id: string;
  operator_id: string;
  key_hash: string;
  label: string;
  scopes: AssistantScope[];
  created_at: string | number;
  last_used_at: string | number | null;
  revoked_at: string | number | null;
  is_primary: boolean;
};
export function projectKey(row: KeyRow): WorkspaceKey {
  return {
    id: row.id,
    label: row.label,
    primary: row.is_primary === true,
    scopes: row.scopes,
    createdAt: iso(Number(row.created_at)),
    lastUsedAt: row.last_used_at === null ? null : iso(Number(row.last_used_at)),
    revokedAt: row.revoked_at === null ? null : iso(Number(row.revoked_at)),
  };
}

/** A verified workspace key (lookup only: the executing transaction rechecks the current row). */
export interface VerifiedKey {
  keyId: string;
  operatorId: string;
  keyHash: string;
  scopes: AssistantScope[];
}
/**
 * Credential calling a key tool: its key id (absent for OAuth grants), its scopes, and whether it
 * is a signed-in human co-owner (console), who may revoke any key including the primary one.
 */
export interface KeyCaller {
  keyId?: string;
  scopes: readonly AssistantScope[];
  label: string;
  human?: boolean;
}
/** Days a workspace's keys must be unused (and the workspace empty) before it may be reclaimed. */
export const AI_WORKSPACE_IDLE_MS = 30 * 86_400_000;
/** Usage ratio at which AI workspace capacity reports pressure. */
const PRESSURE_HIGH = 0.7;
const PRESSURE_CRITICAL = 0.95;

/** Live counter scopes of one AI workspace (HMAC address-scope keys). */
export function aiWorkspaceScopes(row: {
  source_key: string;
  site_key: string;
  network_key: string;
  region_key: string;
}): string[] {
  return [
    'global',
    `source:${row.source_key}`,
    `site:${row.site_key}`,
    `network:${row.network_key}`,
    `region:${row.region_key}`,
  ];
}
/**
 * Deletes up to `limit` AI workspaces that are truly empty and idle: never had agents, no
 * messages to or from it, no co-owner, no assistant grant, no connection request, created and last
 * key use more than 30 days ago. Agents are never deleted (a product rule); a workspace with any
 * agent is never a candidate. Candidates are locked (skipping busy rows) and rechecked under the
 * lock; the live counters are decremented in the same transaction.
 */
export async function reclaimIdleAiWorkspaces(tx: Tx, now: number, limit: number): Promise<number> {
  const cutoff = now - AI_WORKSPACE_IDLE_MS;
  const idle = `jsonb_array_length(w.data->'agents')=0 AND a.created_at<=$1
    AND NOT EXISTS (SELECT 1 FROM workspace_keys k WHERE k.operator_id=a.operator_id AND COALESCE(k.last_used_at,k.created_at)>$1)
    AND NOT EXISTS (SELECT 1 FROM operator_links l WHERE l.ai_operator_id=a.operator_id)
    AND NOT EXISTS (SELECT 1 FROM assistant_grants g WHERE g.operator_id=a.operator_id)
    AND NOT EXISTS (SELECT 1 FROM cross_connections c WHERE c.from_owner_id=a.operator_id OR c.to_owner_id=a.operator_id)
    AND NOT EXISTS (SELECT 1 FROM cross_invites i WHERE i.owner_id=a.operator_id)
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.recipient_owner_id=a.operator_id OR m.sender_owner_id=a.operator_id)`;
  const candidates = (
    await tx.query<{ operator_id: string }>(
      `SELECT a.operator_id FROM ai_workspaces a JOIN workspaces w ON w.operator_id=a.operator_id
        WHERE ${idle} ORDER BY a.created_at, a.operator_id LIMIT $2 FOR UPDATE OF w SKIP LOCKED`,
      [cutoff, limit],
    )
  ).rows;
  let reclaimed = 0;
  for (const { operator_id: id } of candidates) {
    const row = (
      await tx.query<{
        source_key: string;
        site_key: string;
        network_key: string;
        region_key: string;
      }>(
        `SELECT a.source_key,a.site_key,a.network_key,a.region_key FROM ai_workspaces a
          JOIN workspaces w ON w.operator_id=a.operator_id WHERE a.operator_id=$2 AND ${idle}`,
        [cutoff, id],
      )
    ).rows[0];
    if (!row) continue;
    for (const sql of [
      'DELETE FROM workspace_keys WHERE operator_id=$1',
      'DELETE FROM ai_workspace_receipts WHERE operator_id=$1',
      'DELETE FROM ai_workspaces WHERE operator_id=$1',
      'DELETE FROM agent_presence WHERE operator_id=$1',
      'DELETE FROM workspaces WHERE operator_id=$1',
    ])
      await tx.query(sql, [id]);
    await tx.query("DELETE FROM operators WHERE id=$1 AND kind='ai'", [id]);
    for (const scope of aiWorkspaceScopes(row))
      await tx.query(
        'UPDATE ai_workspace_stats SET workspaces=GREATEST(workspaces-1,0) WHERE scope_key=$1',
        [scope],
      );
    reclaimed++;
  }
  return reclaimed;
}

export interface AiWorkspaceDependencies {
  db: Database;
  caps: CityLimits;
  clock(): number;
  /** Server secret for address-scope identifiers (CITY_RATE_LIMIT_KEY); ephemeral if unset. */
  sourceSecret?: string;
  limit(key: string, max: number, window: number): Promise<void>;
  fail(code: number, message: string): never;
  /** The signed-in person (session cookie only; never the selected workspace). */
  person(request: FastifyRequest): Promise<Operator>;
  /** The workspace the request acts in (the person, or an AI workspace they co-own). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  /** Structured operational log sink (capacity.pressure). */
  log?: (line: string) => void;
}
export interface AiWorkspaceCapacity {
  workspaces_used: number;
  workspaces_cap: number;
  pressure: 'ok' | 'high' | 'critical';
}
export interface AiWorkspaces {
  /** Live AI workspace usage against the global cap (high at 70%, critical at 95%). */
  capacity(): Promise<AiWorkspaceCapacity>;
  /** Anonymous `city_create_workspace` from `address` (no account, no human). */
  createWorkspace(address: string, args: unknown, origin: string): Promise<unknown>;
  /** Resolves a presented `ccw_` bearer to its current key, or null. */
  verifyKey(token: string): Promise<VerifiedKey | null>;
  /** Key management tools, run under the workspace lock after the caller's authority check. */
  keyTool(
    tx: Tx,
    workspace: Workspace,
    time: number,
    operatorId: string,
    caller: KeyCaller,
    tool: 'city_workspace_keys' | 'city_create_workspace_key' | 'city_revoke_workspace_key',
    body: unknown,
  ): Promise<unknown>;
}

export function registerAiWorkspaces(
  app: FastifyInstance,
  d: AiWorkspaceDependencies,
): AiWorkspaces {
  const secret = d.sourceSecret || randomBytes(32).toString('hex');
  const scopeId = (scope: string, value: string) =>
    unclaimedScopeId(secret, `ai-workspace-${scope}`, value);

  async function aiKind(tx: Pick<Tx, 'query'>, operatorId: string): Promise<boolean> {
    return (
      (await tx.query("SELECT id FROM operators WHERE id=$1 AND kind='ai'", [operatorId])).rows
        .length > 0
    );
  }
  async function insertKey(
    tx: Tx,
    operatorId: string,
    label: string,
    scopes: readonly AssistantScope[],
    time: number,
    primary = false,
  ): Promise<{ key: WorkspaceKey; secret: string }> {
    const active = Number(
      (
        await tx.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM workspace_keys WHERE operator_id=$1 AND revoked_at IS NULL',
          [operatorId],
        )
      ).rows[0]?.n ?? 0,
    );
    if (active >= d.caps.workspaceKeysPerWorkspace)
      d.fail(
        409,
        `At most ${d.caps.workspaceKeysPerWorkspace} active workspace keys are allowed; revoke one first.`,
      );
    await tx.query(
      `DELETE FROM workspace_keys WHERE operator_id=$1 AND revoked_at IS NOT NULL AND id NOT IN (
        SELECT id FROM workspace_keys WHERE operator_id=$1 AND revoked_at IS NOT NULL
        ORDER BY revoked_at DESC, id LIMIT $2)`,
      [operatorId, RETAINED_REVOKED_KEYS],
    );
    const token = `ccw_${randomBytes(32).toString('base64url')}`;
    const row = (
      await tx.query<KeyRow>(
        'INSERT INTO workspace_keys(id,operator_id,key_hash,label,scopes,created_at,is_primary) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *',
        [randomUUID(), operatorId, sha(token), label, JSON.stringify([...scopes]), time, primary],
      )
    ).rows[0]!;
    return { key: projectKey(row), secret: token };
  }
  async function listKeys(tx: Pick<Tx, 'query'>, operatorId: string): Promise<WorkspaceKey[]> {
    return (
      await tx.query<KeyRow>(
        'SELECT * FROM workspace_keys WHERE operator_id=$1 ORDER BY created_at DESC, id',
        [operatorId],
      )
    ).rows.map(projectKey);
  }
  /** Revokes a key; refuses to leave an unclaimed AI workspace without any active key. */
  async function revokeKey(
    tx: Tx,
    workspace: Workspace,
    operatorId: string,
    keyId: string,
    time: number,
    caller: KeyCaller,
  ): Promise<{ key: WorkspaceKey }> {
    const row = (
      await tx.query<KeyRow>('SELECT * FROM workspace_keys WHERE id=$1 AND operator_id=$2', [
        keyId,
        operatorId,
      ])
    ).rows[0];
    if (!row) d.fail(404, 'Workspace key not found.');
    if (row.revoked_at !== null) return { key: projectKey(row) };
    if (!caller.human) {
      // No takeover: a credential revokes only keys with no more authority than its own, and the
      // primary key only by itself (a human co-owner may revoke any key).
      if (row.is_primary && caller.keyId !== row.id)
        d.fail(403, 'Only the primary key itself or a human co-owner can revoke the primary key.');
      if (row.scopes.some((scope) => !caller.scopes.includes(scope)))
        d.fail(403, 'A key can revoke only keys whose scopes are within its own.');
    }
    const others = Number(
      (
        await tx.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM workspace_keys WHERE operator_id=$1 AND revoked_at IS NULL AND id<>$2',
          [operatorId, keyId],
        )
      ).rows[0]?.n ?? 0,
    );
    const coOwned = (
      await tx.query('SELECT 1 FROM operator_links WHERE ai_operator_id=$1 LIMIT 1', [operatorId])
    ).rows.length;
    if (!others && !coOwned)
      d.fail(
        409,
        'An AI workspace must keep at least one active key until a person co-owns it. Mint a replacement key first.',
      );
    const updated = (
      await tx.query<KeyRow>('UPDATE workspace_keys SET revoked_at=$2 WHERE id=$1 RETURNING *', [
        keyId,
        time,
      ])
    ).rows[0]!;
    event(
      workspace,
      time,
      'workspace.key_revoked',
      `Workspace key ${keyId} (${row.label}) revoked by ${caller.label}.`,
    );
    return { key: projectKey(updated) };
  }

  // -------------------------------------------------------------------------------------------
  // Anonymous creation (open MCP tool and REST), with per-address-scope rates and capacity caps.

  type ScopeIds = { source: string; site: string; network: string; region: string };
  const scopedCaps = (ids: ScopeIds) =>
    [
      ['global', d.caps.aiWorkspacesGlobal],
      [`source:${ids.source}`, d.caps.aiWorkspacesPerSource],
      [`site:${ids.site}`, d.caps.aiWorkspacesPerSite],
      [`network:${ids.network}`, d.caps.aiWorkspacesPerNetwork],
      [`region:${ids.region}`, d.caps.aiWorkspacesPerRegion],
    ] as const;
  class CapacityFull extends Error {}
  /**
   * Counts the new workspace against every LIVE counter inside the creating transaction
   * (conditional upserts), so each counter always equals the existing AI workspaces in its scope:
   * a refusal or failure rolls the increment back with the create, and reclaiming a workspace
   * decrements it. Throws CapacityFull at any bound.
   */
  async function count(tx: Tx, ids: ScopeIds): Promise<void> {
    for (const [key, cap] of scopedCaps(ids)) {
      const row = await tx.query(
        `INSERT INTO ai_workspace_stats(scope_key,workspaces) VALUES($1,1)
          ON CONFLICT (scope_key) DO UPDATE SET workspaces=ai_workspace_stats.workspaces+1
          WHERE ai_workspace_stats.workspaces+1<=$2 RETURNING workspaces`,
        [key, cap],
      );
      if (!row.rows.length) throw new CapacityFull();
    }
  }
  async function capacity(): Promise<AiWorkspaceCapacity> {
    const used = Number(
      (
        await d.db.query<{ workspaces: number | string }>(
          "SELECT workspaces FROM ai_workspace_stats WHERE scope_key='global'",
        )
      ).rows[0]?.workspaces ?? 0,
    );
    const ratio = used / d.caps.aiWorkspacesGlobal;
    return {
      workspaces_used: used,
      workspaces_cap: d.caps.aiWorkspacesGlobal,
      pressure: ratio >= PRESSURE_CRITICAL ? 'critical' : ratio >= PRESSURE_HIGH ? 'high' : 'ok',
    };
  }
  const log = d.log ?? ((line: string) => console.warn(line));
  let lastPressureLog = -Infinity;
  /** Checks after each create; logs one structured capacity.pressure line per minute while high. */
  async function signalPressure(): Promise<void> {
    const current = await capacity();
    const now = d.clock();
    if (current.pressure === 'ok' || now - lastPressureLog < 60_000) return;
    lastPressureLog = now;
    log(
      JSON.stringify({
        event: 'capacity.pressure',
        scope: 'ai_workspaces',
        at: iso(now),
        ...current,
      }),
    );
  }
  function slugFor(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'workspace';
    return `${base}-${randomBytes(5).toString('hex')}`;
  }
  class Replayed extends Error {}
  async function replayResponse(operatorId: string, origin: string) {
    const row = (
      await d.db.query<{ name: string; slug: string }>(
        'SELECT o.name, a.slug FROM operators o JOIN ai_workspaces a ON a.operator_id=o.id WHERE o.id=$1',
        [operatorId],
      )
    ).rows[0];
    if (!row) d.fail(404, 'Workspace not found.');
    return {
      workspace_id: operatorId,
      name: row.name,
      slug: row.slug,
      workspace_key: null,
      key: null,
      claim_token: null,
      claim_url: null,
      mcp_url: `${origin}/mcp`,
      secrets_already_issued: true,
      next_actions: [
        'This request was already applied; the workspace key and claim token were returned only by the first response and are not issued again.',
        'If the key was lost, the workspace cannot be recovered without it: create a new workspace with a new idempotency_key.',
      ],
    };
  }

  async function createWorkspace(address: string, args: unknown, origin: string) {
    const prefixes = clientAddressPrefixes(address);
    await d.limit(`ai-ws:${prefixes.source}`, 30, 60_000);
    const values = createWorkspaceToolInput.parse(args);
    if (!highEntropyKey(values.idempotency_key))
      d.fail(
        400,
        'idempotency_key must be unguessable: a fresh random UUID v4, or at least 16 random bytes as base64url (22+ characters). Words, dates, sequences, repeats, example UUIDs and hex under 32 digits are refused.',
      );
    const ids: ScopeIds = {
      source: scopeId('source', prefixes.source),
      site: scopeId('site', prefixes.site),
      network: scopeId('network', prefixes.network),
      region: scopeId('region', prefixes.region),
    };
    const requestKey = sha(values.idempotency_key);
    const requestHash = sha(JSON.stringify({ name: values.name }));
    const receiptOf = async () =>
      (
        await d.db.query<{ request_hash: string; operator_id: string }>(
          'SELECT request_hash,operator_id FROM ai_workspace_receipts WHERE source_key=$1 AND request_key=$2',
          [ids.source, requestKey],
        )
      ).rows[0];
    const replay = async () => {
      const receipt = await receiptOf();
      if (!receipt) return d.fail(409, 'The request is still being applied; retry shortly.');
      if (receipt.request_hash !== requestHash)
        d.fail(409, 'This idempotency_key belongs to a different workspace name.');
      return replayResponse(receipt.operator_id, origin);
    };
    // A replay never mints or re-issues secrets (B1), and costs no creation budget.
    if (await receiptOf()) return replay();
    const hour = 60 * 60_000;
    await d.limit(
      `ai-ws-create:${prefixes.source}`,
      d.caps.aiWorkspaceCreatesPerSourcePerHour,
      hour,
    );
    await d.limit(
      `ai-ws-create-site:${prefixes.site}`,
      d.caps.aiWorkspaceCreatesPerSitePerHour,
      hour,
    );
    await d.limit(
      `ai-ws-create-network:${prefixes.network}`,
      d.caps.aiWorkspaceCreatesPerNetworkPerHour,
      hour,
    );
    await d.limit(
      `ai-ws-create-region:${prefixes.region}`,
      d.caps.aiWorkspaceCreatesPerRegionPerHour,
      hour,
    );
    let created: {
      operatorId: string;
      slug: string;
      key: WorkspaceKey;
      secret: string;
      claim: string;
    };
    const attempt = () =>
      d.db.transaction(async (tx) => {
        const time = d.clock();
        const operatorId = randomUUID();
        const slug = slugFor(values.name);
        await tx.query(
          "INSERT INTO operators(id,name,name_key,password_hash,salt,kind) VALUES($1,$2,$3,'!','!','ai')",
          [operatorId, values.name, `ai:${slug}`],
        );
        // The receipt claims the idempotency key; a concurrent twin loses here and replays.
        const receipt = await tx.query(
          'INSERT INTO ai_workspace_receipts(source_key,request_key,request_hash,operator_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (source_key,request_key) DO NOTHING RETURNING request_key',
          [ids.source, requestKey, requestHash, operatorId, time],
        );
        if (!receipt.rows.length) throw new Replayed();
        const claim = `ccwclaim_${randomBytes(32).toString('base64url')}`;
        await tx.query(
          'INSERT INTO ai_workspaces(operator_id,slug,claim_token_hash,source_key,site_key,network_key,region_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [operatorId, slug, sha(claim), ids.source, ids.site, ids.network, ids.region, time],
        );
        const workspace = emptyWorkspace();
        event(
          workspace,
          time,
          'workspace.created',
          'AI-owned workspace created without an account; it authenticates with workspace keys.',
        );
        await tx.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
          operatorId,
          JSON.stringify(workspace),
        ]);
        const { key, secret: token } = await insertKey(
          tx,
          operatorId,
          'initial key',
          INITIAL_KEY_SCOPES,
          time,
          true,
        );
        await count(tx, ids);
        return { operatorId, slug, key, secret: token, claim };
      });
    try {
      try {
        created = await attempt();
      } catch (error) {
        if (!(error instanceof CapacityFull)) throw error;
        // At a bound, reclaim only truly empty idle workspaces, then try once more.
        const reclaimed = await d.db.transaction((tx) =>
          reclaimIdleAiWorkspaces(tx, d.clock(), 50),
        );
        if (!reclaimed) throw error;
        created = await attempt();
      }
    } catch (error) {
      if (error instanceof Replayed) return replay();
      if (error instanceof CapacityFull) {
        await signalPressure();
        return d.fail(
          409,
          'AI workspace creation capacity is currently unavailable for this request. Try again later.',
        );
      }
      throw error;
    }
    await signalPressure();
    return {
      workspace_id: created.operatorId,
      name: values.name,
      slug: created.slug,
      workspace_key: created.secret,
      key: created.key,
      claim_token: created.claim,
      claim_url: `${origin}/#claim=${created.claim}`,
      mcp_url: `${origin}/mcp`,
      secrets_already_issued: false,
      next_actions: [
        `Store workspace_key now: it is shown only in this response and cannot be recovered. Send it as "Authorization: Bearer <workspace_key>" to ${origin}/mcp (MCP) or ${origin}/api/assistant/tools/<tool>.`,
        'On /mcp: create agents (city_create_agent, city_apply_team), message them (city_send_message) and mint a separate key for each other AI you work with (city_create_workspace_key).',
        'Connect to agents of other owners by consent: city_request_connection with an invite_token they gave you (or the id of their public agent); they approve with city_decide_connection. Hand out your own invites with city_create_invite.',
        `Optionally give claim_url (or claim_token) to a person who should co-own this workspace; after signing in they claim it once at POST ${origin}/api/workspaces/claim. The token is shown only in this response.`,
      ],
    };
  }

  async function verifyKey(token: string): Promise<VerifiedKey | null> {
    if (!WORKSPACE_KEY.test(token)) return null;
    const keyHash = sha(token);
    const row = (
      await d.db.query<KeyRow>(
        "SELECT k.* FROM workspace_keys k JOIN operators o ON o.id=k.operator_id AND o.kind='ai' WHERE k.key_hash=$1",
        [keyHash],
      )
    ).rows[0];
    if (!row || row.revoked_at !== null || !constantEqual(row.key_hash, keyHash)) return null;
    return { keyId: row.id, operatorId: row.operator_id, keyHash, scopes: row.scopes };
  }

  async function keyTool(
    tx: Tx,
    workspace: Workspace,
    time: number,
    operatorId: string,
    caller: KeyCaller,
    tool: 'city_workspace_keys' | 'city_create_workspace_key' | 'city_revoke_workspace_key',
    body: unknown,
  ): Promise<unknown> {
    if (!(await aiKind(tx, operatorId)))
      d.fail(409, 'Workspace keys exist only for AI-owned workspaces.');
    if (tool === 'city_workspace_keys') {
      listWorkspaceKeysToolInput.parse(body);
      return { keys: await listKeys(tx, operatorId) };
    }
    if (tool === 'city_create_workspace_key') {
      const values = createWorkspaceKeyToolInput.parse(body);
      // By default a minted key can neither manage keys nor approve cross-owner connections:
      // handing another AI its own key must never hand it the power to take the workspace over
      // or to accept connections on the owner's behalf (F4: approval is granted explicitly).
      const scopes =
        values.scopes ??
        caller.scopes.filter(
          (scope) => scope !== 'workspace:keys' && scope !== 'connections:approve',
        );
      // No escalation: a key can only hand out authority its holder already has.
      const excess = scopes.filter((scope) => !caller.scopes.includes(scope));
      if (excess.length) d.fail(403, `The calling credential does not hold: ${excess.join(', ')}.`);
      const { key, secret: token } = await insertKey(tx, operatorId, values.label, scopes, time);
      event(
        workspace,
        time,
        'workspace.key_created',
        `Workspace key ${key.id} (${key.label}) minted by ${caller.label}.`,
      );
      return {
        key,
        workspace_key: token,
        next_actions: [
          'Hand workspace_key to the AI that should use it; it is shown only in this response. Revoke it with city_revoke_workspace_key when that AI no longer needs access.',
        ],
      };
    }
    const { key_id } = revokeWorkspaceKeyToolInput.parse(body);
    const result = await revokeKey(tx, workspace, operatorId, key_id, time, caller);
    return { ...result, revoked_self: caller.keyId === key_id };
  }

  // -------------------------------------------------------------------------------------------
  // REST: anonymous creation, the person's workspace list and claim, and key management for
  // co-owners (acting in the selected AI workspace).

  app.post('/api/public/workspaces', async (request, reply) =>
    reply.code(201).send(await createWorkspace(request.ip, request.body, d.originOf(request))),
  );

  app.get('/api/workspaces', async (request) => {
    const person = await d.person(request);
    const rows = (
      await d.db.query<{ id: string; name: string }>(
        `SELECT o.id, o.name FROM operator_links l JOIN operators o ON o.id=l.ai_operator_id AND o.kind='ai'
          WHERE l.human_operator_id=$1 ORDER BY l.created_at, o.id`,
        [person.id],
      )
    ).rows;
    const workspaces: WorkspaceMembership[] = [
      { id: person.id, name: person.name, kind: 'owner', role: 'owner' },
      ...rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: 'ai' as const,
        role: 'co-owner' as const,
      })),
    ];
    return { workspaces };
  });

  // Shown before a claim: the AI's active keys keep working after it, so the person sees them
  // (labels, scopes, last use; never secrets) and can revoke them once they are co-owner.
  app.post('/api/workspaces/claim/preview', async (request) => {
    const person = await d.person(request);
    await d.limit(`ws-claim-preview:${person.id}`, 60, 15 * 60_000);
    const { claim_token: token } = z
      .object({ claim_token: z.string().max(128) })
      .strict()
      .parse(request.body);
    const invalid = (): never =>
      d.fail(404, 'Claim token is invalid, expired (7 days) or was already used.');
    if (!WORKSPACE_CLAIM_TOKEN.test(token)) invalid();
    const row = (
      await d.db.query<{ operator_id: string; name: string; agents: number | string }>(
        `SELECT a.operator_id, o.name, jsonb_array_length(w.data->'agents') AS agents
          FROM ai_workspaces a JOIN operators o ON o.id=a.operator_id
          JOIN workspaces w ON w.operator_id=a.operator_id
          WHERE a.claim_token_hash=$1 AND a.created_at>$2`,
        [sha(token), d.clock() - WORKSPACE_CLAIM_TTL_MS],
      )
    ).rows[0];
    if (!row) invalid();
    const keys = (await listKeys(d.db, row!.operator_id)).filter((key) => !key.revokedAt);
    return {
      workspace: { name: row!.name, agents: Number(row!.agents) },
      active_keys: keys.map(({ label, scopes, lastUsedAt, primary }) => ({
        label,
        scopes,
        lastUsedAt,
        primary,
      })),
      warning:
        'These keys keep their access after you claim the workspace. Revoke any you do not trust under AI connections once you are co-owner.',
    };
  });

  app.post('/api/workspaces/claim', async (request) => {
    const person = await d.person(request);
    await d.limit(`ws-claim:${person.id}`, 20, 15 * 60_000);
    await d.limit(`ws-claim-ip:${clientAddressKey(request.ip)}`, 30, 15 * 60_000);
    const { claim_token: token } = z
      .object({ claim_token: z.string().max(128) })
      .strict()
      .parse(request.body);
    const invalid = (): never =>
      d.fail(404, 'Claim token is invalid, expired (7 days) or was already used.');
    if (!WORKSPACE_CLAIM_TOKEN.test(token)) invalid();
    const tokenHash = sha(token);
    const row = (
      await d.db.query<{ operator_id: string }>(
        'SELECT operator_id FROM ai_workspaces WHERE claim_token_hash=$1 AND created_at>$2',
        [tokenHash, d.clock() - WORKSPACE_CLAIM_TTL_MS],
      )
    ).rows[0];
    if (!row) invalid();
    const aiId = row!.operator_id;
    return d.mutate(aiId, async (workspace, tx, time) => {
      const locked = (
        await tx.query<{ claim_token_hash: string | null }>(
          'SELECT claim_token_hash FROM ai_workspaces WHERE operator_id=$1 AND created_at>$2 FOR UPDATE',
          [aiId, time - WORKSPACE_CLAIM_TTL_MS],
        )
      ).rows[0];
      if (!locked?.claim_token_hash || !constantEqual(locked.claim_token_hash, tokenHash))
        invalid();
      // Claims of one person for different AI workspaces lock different rows above; this lock
      // makes them count one after the other, so two at once never pass the cap together.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ws-claim:${person.id}`]);
      const links = Number(
        (
          await tx.query<{ n: string | number }>(
            'SELECT count(*) AS n FROM operator_links WHERE human_operator_id=$1',
            [person.id],
          )
        ).rows[0]?.n ?? 0,
      );
      if (links >= LINKS_PER_PERSON)
        d.fail(409, `You already co-own ${LINKS_PER_PERSON} AI workspaces.`);
      await tx.query(
        "INSERT INTO operator_links(human_operator_id,ai_operator_id,role,created_at) VALUES($1,$2,'co-owner',$3) ON CONFLICT DO NOTHING",
        [person.id, aiId, time],
      );
      await tx.query(
        'UPDATE ai_workspaces SET claim_token_hash=NULL, claimed_at=$2 WHERE operator_id=$1',
        [aiId, time],
      );
      // A change of ownership revokes stored responder keys; the new
      // co-owner sets auto-reply up again.
      await revokeResponderCredentials(tx, { ownerId: aiId }, time, 'workspace claimed');
      event(
        workspace,
        time,
        'workspace.claimed',
        'A person claimed this AI workspace and is now a co-owner. The AI keeps its keys until a co-owner revokes them.',
      );
      const name = (
        await tx.query<{ name: string }>('SELECT name FROM operators WHERE id=$1', [aiId])
      ).rows[0]!.name;
      const summary: WorkspaceMembership = { id: aiId, name, kind: 'ai', role: 'co-owner' };
      return { workspace: summary };
    });
  });

  const keyBody = z.object({ label: z.string().trim().min(1).max(64), scopes: scopeList }).strict();
  async function aiOwner(request: FastifyRequest): Promise<Operator> {
    const operator = await d.owner(request);
    if (!(await aiKind(d.db, operator.id)))
      d.fail(409, 'Workspace keys exist only for AI-owned workspaces.');
    return operator;
  }
  app.get('/api/workspace-keys', async (request) => {
    const operator = await aiOwner(request);
    return { keys: await listKeys(d.db, operator.id) };
  });
  app.post('/api/workspace-keys', async (request, reply) => {
    const operator = await aiOwner(request);
    const person = await d.person(request);
    const values = keyBody.parse(request.body);
    await d.limit(`ws-key-issue:${operator.id}`, 10, 60_000);
    const result = await d.mutate(operator.id, async (workspace, tx, time) => {
      const { key, secret: token } = await insertKey(
        tx,
        operator.id,
        values.label,
        values.scopes,
        time,
      );
      event(
        workspace,
        time,
        'workspace.key_created',
        `Workspace key ${key.id} (${key.label}) minted by a co-owner.`,
      );
      return { key, workspace_key: token };
    });
    return reply.code(201).send(result);
  });
  app.delete('/api/workspace-keys/:id', async (request) => {
    const operator = await aiOwner(request);
    const person = await d.person(request);
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params);
    return d.mutate(operator.id, (workspace, tx, time) =>
      revokeKey(tx, workspace, operator.id, id, time, {
        scopes: ASSISTANT_SCOPES,
        label: 'a co-owner',
        human: true,
      }),
    );
  });

  return { capacity, createWorkspace, verifyKey, keyTool };
}
