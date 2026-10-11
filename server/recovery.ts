import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { acquireDataLock, directPath, INCOMPLETE_RECOVERY } from './data-lock.js';
import { OAUTH_TABLES } from './oauth/schema.js';
import { CROSS_CONNECTIONS_TABLE } from './connections/schema.js';
import { ROOM_TABLES } from './rooms/schema.js';
import { WAKE_TABLES } from './wake/schema.js';
import { RESPONDER_TABLES } from './responder/schema.js';
import { RESPONDER_EXECUTION_TABLES } from './responder/execution-schema.js';
import { COUNT_LOG_TABLES } from './count-log/schema.js';
import { COUNT_LOG_PENDING_TABLES } from './count-log/pending.js';
import { ROOM_CODE_TABLES } from './rooms/repos/schema.js';
import { RESULT_TABLES } from './results/schema.js';
import { ELRIC_TABLES } from './elric/schema.js';
import { GOOGLE_TABLES } from './google/schema.js';
import { EMAIL_TABLES } from './email/schema.js';
import { BASE_TABLES } from './base/schema.js';
import { ELRIC_ERASE_TABLES } from './elric/erase.js';
import { ELRIC_DRAFT_TABLES } from './elric/draft.js';
import { ELRIC_TITLE_TABLES } from './elric/titles.js';
import { ELRIC_CATCH_UP_TABLES } from './elric/catch-up-schema.js';
import { TASK_REVIEW_TABLES } from './rooms/task-reviews-schema.js';

/** Tables added by migrations 5-7 (server/migrations.ts). */
/** Migrations 11-12 (server/workspaces, server/connections): never part of a backup. */
export const PARITY_TABLES = [
  'ai_workspace_receipts',
  'ai_workspace_stats',
  'ai_workspaces',
  'cross_agent_settings',
  'cross_connections',
  'cross_invites',
  'operator_links',
  'workspace_key_receipts',
  'workspace_keys',
] as const;
/**
 * Hosted demo jobs requested from another owner (approved cross-owner connection) are kept only
 * when that connection is part of the backup (both owners are backed-up accounts); otherwise their
 * requester and consent stay behind and the job is left out.
 */
function withoutCrossWorkspaceJobs(pairs: Set<string>) {
  return <T extends { operator_id: string; data: { agents: unknown[]; jobs: unknown[] } }>(
    row: T,
  ): T => {
    const agents = new Set(
      row.data.agents.map((agent) => (agent as { id?: unknown }).id).filter(Boolean),
    );
    const jobs = row.data.jobs.filter((job) => {
      const { requesterId, providerId } = job as { requesterId?: string; providerId?: string };
      return agents.has(requesterId) || pairs.has(`${requesterId}>${providerId}`);
    });
    return jobs.length === row.data.jobs.length ? row : { ...row, data: { ...row.data, jobs } };
  };
}
/** Cross-owner consent rows (F4 §6): part of the backup when both owners are backed up. */
const crossConnection = z
  .object({
    id: z.string().uuid(),
    from_agent_id: z.string().uuid(),
    from_owner_id: z.string().uuid(),
    to_agent_id: z.string().uuid(),
    to_owner_id: z.string().uuid(),
    status: z.enum(['pending', 'approved', 'denied', 'revoked', 'expired']),
    note: z.string().max(280),
    from_owner_label: z.string().max(64),
    requested_at: z.coerce.number().int().nonnegative(),
    expires_at: z.coerce.number().int().nonnegative(),
    decided_at: z.coerce.number().int().nonnegative().nullable(),
    decided_by: z.string().max(200).nullable(),
    revoked_at: z.coerce.number().int().nonnegative().nullable(),
    revoked_by: z.string().max(200).nullable(),
    invite_id: z.string().max(64).nullable(),
    idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const AUTONOMY_TABLES = [
  'agent_manifests',
  'anonymous_receipts',
  'claim_tokens',
  'runtime_enrollments',
  'unclaimed_buckets',
  'unclaimed_stats',
] as const;

export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const MAX_OWNERS = 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const id = z.uuid();
const date = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.enum(['research', 'extract', 'verify']);
const output = z.record(z.string(), z.unknown()).refine((value) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) return false;
  const queue: Array<[unknown, number]> = [[value, 0]];
  let count = 0;
  while (queue.length) {
    const [item, depth] = queue.pop()!;
    if (++count > 2000 || depth > 8) return false;
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return false;
        queue.push([child, depth + 1]);
      }
    }
  }
  return true;
});
const workflow = z
  .object({
    id,
    requesterId: id,
    researcherId: id,
    reviewerId: id,
    source: z.string().min(1).max(4000),
    briefJobId: id,
    checkJobId: id.nullable(),
    status: z.enum([
      'briefing',
      'awaiting_review',
      'checking',
      'completed',
      'accepted',
      'failed',
      'canceled',
    ]),
    createdAt: date,
    updatedAt: date,
    error: z.string().max(1000).nullable(),
    idempotencyKey: z.string().min(8).max(128).startsWith('workflow:'),
    requestHash: digest,
  })
  .strict();
const workspace = z
  .object({
    paused: z.boolean(),
    workflows: z.array(workflow).max(200).optional(),
    agents: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(64),
            description: z.string().max(300),
            capability,
            mode: z.enum(['hosted', 'external']),
            isDemo: z.boolean(),
            createdAt: date,
            lastSeenAt: date.nullable(),
            revokedAt: date.nullable(),
            lastSequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
            announcedOnline: z.boolean(),
            demoKey: z.string().max(64).optional(),
            // Phase 2 manifest identity and lineage (all optional; see shared/types.ts).
            pausedAt: date.nullable().optional(),
            manifestName: z.string().max(63).optional(),
            manifestHash: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/)
              .optional(),
            revision: z.number().int().min(1).max(1_000_000).optional(),
            createdBy: z
              .object({
                kind: z.enum([
                  'owner',
                  'assistant',
                  'oauth-client',
                  'agent',
                  'anonymous-client',
                  'workspace-key',
                ]),
                id: z.string().min(1).max(128).optional(),
                clientId: z.string().max(2048).optional(),
              })
              .strict()
              .optional(),
            parentAgentId: id.nullable().optional(),
            depth: z.number().int().min(0).max(16).optional(),
            rootSponsor: z.string().max(128).optional(),
            claimedAt: date.optional(),
            credentialHint: z
              .string()
              .regex(/^[A-Za-z0-9_-]{4}$/)
              .optional(),
            visibility: z.enum(['private', 'public']).optional(),
          })
          .strict(),
      )
      .max(100),
    connections: z
      .array(z.object({ id, fromAgentId: id, toAgentId: id, createdAt: date }).strict())
      .max(500),
    jobs: z
      .array(
        z
          .object({
            id,
            requesterId: id,
            providerId: id,
            capability,
            input: z.string().min(1).max(12000),
            status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
            acceptance: z.enum(['pending', 'accepted']),
            output: output.nullable(),
            createdAt: date,
            updatedAt: date,
            completedAt: date.nullable(),
            acceptedAt: date.nullable(),
            costCents: z.number().int().nonnegative().nullable(),
            error: z.string().max(1000).nullable(),
            isDemo: z.boolean(),
            idempotencyKey: z.string().min(8).max(128),
            requestHash: digest,
            attempts: z.number().int().nonnegative(),
            leaseHash: digest.nullable(),
            leaseExpiresAt: z.number().int().nonnegative().nullable(),
            outputHash: digest.nullable(),
          })
          .strict(),
      )
      .max(1000),
    events: z
      .array(
        z
          .object({
            id,
            type: z.string().max(100),
            message: z.string().max(1000),
            agentId: id.nullable(),
            jobId: id.nullable(),
            createdAt: date,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
const snapshotSchema = z
  .object({
    format: z.literal('central-city-offline-backup'),
    version: z.literal(1),
    createdAt: date,
    operators: z
      .array(
        z
          .object({
            id,
            name: z.string().min(2).max(48),
            name_key: z.string().min(2).max(48),
            password_hash: z.string().regex(/^[a-f0-9]{128}$/),
            salt: z.string().regex(/^[a-f0-9]{32}$/),
          })
          .strict(),
      )
      .max(MAX_OWNERS),
    workspaces: z.array(z.object({ operator_id: id, data: workspace }).strict()).max(MAX_OWNERS),
    cross_connections: z.array(crossConnection).max(100_000).optional(),
  })
  .strict();
const envelopeSchema = z
  .object({ payload: z.string().max(MAX_BACKUP_BYTES), sha256: digest })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} in backup.`);
}
function validateSnapshot(value: unknown): Snapshot {
  const snapshot = snapshotSchema.parse(value);
  unique(
    snapshot.operators.map((row) => row.id),
    'operator',
  );
  unique(
    snapshot.operators.map((row) => row.name_key),
    'operator name',
  );
  unique(
    snapshot.workspaces.map((row) => row.operator_id),
    'workspace',
  );
  const owners = new Set(snapshot.operators.map((row) => row.id));
  if (snapshot.workspaces.length !== owners.size)
    throw new Error('Workspace ownership is incomplete.');
  const agentOwner = new Map<string, string>();
  for (const row of snapshot.workspaces)
    for (const agent of row.data.agents) agentOwner.set(agent.id, row.operator_id);
  const cross = snapshot.cross_connections ?? [];
  unique(
    cross.map((row) => row.id),
    'cross connection',
  );
  const crossPairs = new Set<string>();
  for (const row of cross) {
    if (
      row.from_owner_id === row.to_owner_id ||
      agentOwner.get(row.from_agent_id) !== row.from_owner_id ||
      agentOwner.get(row.to_agent_id) !== row.to_owner_id
    )
      throw new Error('Dangling cross connection.');
    if (row.status === 'approved' || row.status === 'revoked')
      crossPairs.add(`${row.from_agent_id}>${row.to_agent_id}`);
  }
  for (const row of snapshot.workspaces) {
    if (!owners.has(row.operator_id)) throw new Error('Unknown workspace owner.');
    const data = row.data;
    unique(
      data.agents.map((agent) => agent.id),
      'agent',
    );
    unique(
      data.jobs.map((job) => job.id),
      'job',
    );
    unique(
      data.jobs.map((job) => job.idempotencyKey),
      'idempotency key',
    );
    unique(
      data.connections.map((grant) => grant.id),
      'grant',
    );
    const agents = new Set(data.agents.map((agent) => agent.id));
    for (const pair of [
      ...data.connections.map((grant) => [grant.fromAgentId, grant.toAgentId]),
      // A job requested from another owner needs its included cross-owner connection.
      ...data.jobs.map((job) =>
        crossPairs.has(`${job.requesterId}>${job.providerId}`)
          ? [job.providerId]
          : [job.requesterId, job.providerId],
      ),
    ])
      if (pair.some((agentId) => !agents.has(agentId)))
        throw new Error('Dangling agent reference.');
    const workflows = data.workflows ?? [];
    unique(
      workflows.map((item) => item.id),
      'workflow',
    );
    unique(
      workflows.map((item) => item.idempotencyKey),
      'workflow idempotency key',
    );
    unique(
      workflows.flatMap((item) => [item.briefJobId, ...(item.checkJobId ? [item.checkJobId] : [])]),
      'workflow job link',
    );
    for (const item of workflows) {
      if (
        new Set([item.requesterId, item.researcherId, item.reviewerId]).size !== 3 ||
        [item.requesterId, item.researcherId, item.reviewerId].some(
          (agentId) => !agents.has(agentId),
        )
      )
        throw new Error('Invalid workflow agent reference.');
      const brief = data.jobs.find((job) => job.id === item.briefJobId);
      const check = item.checkJobId
        ? data.jobs.find((job) => job.id === item.checkJobId)
        : undefined;
      if (
        !brief ||
        brief.requesterId !== item.requesterId ||
        brief.providerId !== item.researcherId ||
        brief.capability !== 'research' ||
        brief.input !== item.source ||
        brief.idempotencyKey !== `workflow:brief:${item.id}` ||
        (item.checkJobId &&
          (!check ||
            check.requesterId !== item.researcherId ||
            check.providerId !== item.reviewerId ||
            check.capability !== 'verify' ||
            check.idempotencyKey !== `workflow:check:${item.id}`)) ||
        (['checking', 'completed', 'accepted'].includes(item.status) && !check)
      )
        throw new Error('Invalid workflow job reference.');
      if (
        (['briefing', 'awaiting_review'].includes(item.status) && check) ||
        (item.status === 'briefing' && !['queued', 'running'].includes(brief.status)) ||
        (['awaiting_review', 'checking', 'completed', 'accepted'].includes(item.status) &&
          brief.status !== 'completed') ||
        (item.status === 'checking' && check && !['queued', 'running'].includes(check.status)) ||
        (['completed', 'accepted'].includes(item.status) && check?.status !== 'completed') ||
        (item.status === 'accepted' &&
          (brief.acceptance !== 'accepted' || check?.acceptance !== 'accepted'))
      )
        throw new Error('Workflow state is inconsistent with its linked jobs.');
    }
  }
  return snapshot;
}

function isWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !/^[a-z]:/i.test(path));
}
async function inspectTree(root: string) {
  const queue = [root];
  let entries = 0;
  while (queue.length) {
    const current = queue.pop()!;
    const stat = await lstat(current);
    if (++entries > 20000) throw new Error('Data directory exceeds the supported entry bound.');
    await directPath(current);
    if (stat.isDirectory())
      for (const name of await readdir(current)) queue.push(resolve(current, name));
    else if (!stat.isFile()) throw new Error('Unsupported filesystem entry in data directory.');
  }
}

/** All database readers/writers must cooperate with acquireDataLock. Stop older app builds first. */
export async function backupDatabase(dataPath: string, backupPath: string) {
  const dataDir = await directPath(dataPath);
  const destination = await directPath(backupPath);
  if (isWithin(dataDir, destination))
    throw new Error('Store the backup outside the database directory.');
  const parent = await lstat(dirname(destination));
  if (!parent.isDirectory())
    throw new Error('Backup parent must be an existing private directory.');
  const lock = await acquireDataLock(dataDir);
  let db: PGlite | undefined;
  let outputFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Never initialize a missing source database while trying to back it up.
    if (!(await lstat(resolve(dataDir, 'PG_VERSION'))).isFile())
      throw new Error('Not an existing PGlite database.');
    await inspectTree(dataDir);
    db = await PGlite.create(dataDir);
    const snapshot = await db.transaction(async (tx) => {
      const tables = (
        await tx.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
        )
      ).rows
        .map((row) => row.table_name)
        // Migration 28 public_stats, migration 59 counted_agent_ids and migration 64 room_counts
        // are derived (recomputed from workspaces, room members and tasks): recognized on top of any schema and never exported, so they never
        // decide whether a schema is supported.
        .filter(
          (name) =>
            name !== 'public_stats' && name !== 'counted_agent_ids' && name !== 'room_counts',
        );
      const legacyTables = ['credentials', 'operators', 'replay_nonces', 'sessions', 'workspaces'];
      // Assistant grants and mutation receipts are authority, not recovery data.
      // Recognize the complete upgraded schema while exporting neither table.
      const assistantTables = ['assistant_grants', 'assistant_receipts', ...legacyTables];
      // Versioned schema (server/migrations.ts): presence, shared rate-limit counters and the
      // migration ledger are operational state and are not exported either.
      const migratedTables = [
        'agent_presence',
        'assistant_grants',
        'assistant_receipts',
        'credentials',
        'operators',
        'rate_limits',
        'replay_nonces',
        'schema_migrations',
        'sessions',
        'workspaces',
      ];
      // Remote MCP OAuth tables are authority too; recognized but never exported.
      const oauthTables = [...migratedTables, ...OAUTH_TABLES].sort();
      // Phase 2 autonomy tables (migrations 5-7): manifest revisions, enrollment codes, claim
      // tokens and anonymous receipts are recognized but not part of the v1 backup format.
      const autonomyTables = [...oauthTables, ...AUTONOMY_TABLES].sort();
      const messagingTables = [
        ...autonomyTables,
        'inbox_cursors',
        'message_receipts',
        'messages',
      ].sort(); // migration 10, not exported
      // Migrations 11-12 (AI-owned workspaces, keys, co-ownership links, connection requests)
      // are authority or AI-owned state: recognized, never exported (docs/AI_WORKSPACES.md).
      const parityTables = [...messagingTables, ...PARITY_TABLES].sort();
      // Migrations 13-14 (rooms, join links): recognized, never exported. A restore therefore
      // carries no room, membership, invite or join link: nothing revoked can come back, and
      // access needs a fresh invitation (ROOMS-SEC-001 backdated join / stale backup).
      const roomTables = [...parityTables, ...ROOM_TABLES].sort();
      const joinLinkTables = [...roomTables, 'join_links'].sort();
      // Migration 15 authority is recognized but never exported.
      const wakeTables = [...joinLinkTables, ...WAKE_TABLES].sort();
      // Migration 17 is an anonymous eviction index, never owned account backup data.
      // Accept both the pre-wake TTL schema and the combined current schema.
      const expiryTables = [...joinLinkTables, 'unclaimed_agent_expiry'].sort();
      const wakeExpiryTables = [...wakeTables, 'unclaimed_agent_expiry'].sort();
      // Migration 16 (published results, asks, receipts, reuse events; docs/ANSWERS.md):
      // recognized, never exported, so a restore cannot resurrect a revoked result.
      const resultTables = [...wakeTables, ...RESULT_TABLES].sort();
      // Migration 20 (hosted responder settings and encrypted provider keys) may sit on top
      // of any schema that has messaging: recognized and never exported. A restore carries no
      // provider key; owners set auto-reply up again (docs/RESPONDER.md).
      // Migration 26 (hosted responder execution: reply state and usage) comes only on top of migration 20.
      const responder = RESPONDER_TABLES.filter((name) => tables.includes(name));
      const execution = RESPONDER_EXECUTION_TABLES.filter((name) => tables.includes(name));
      if (
        (responder.length &&
          (responder.length !== RESPONDER_TABLES.length || !tables.includes('messages'))) ||
        (execution.length &&
          (execution.length !== RESPONDER_EXECUTION_TABLES.length || !responder.length))
      )
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 29 (the verifiable agent count's append-only log, salts included) may sit on
      // top of any schema: all three tables or none, recognized and never exported. A restore
      // starts no new log; the published checkpoints and the public witness keep the history.
      const countLog = COUNT_LOG_TABLES.filter((name) => tables.includes(name));
      if (countLog.length && countLog.length !== COUNT_LOG_TABLES.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 47 (the live pending feed) comes only on top of the count log: recognized and
      // never exported, like the log itself.
      if (COUNT_LOG_PENDING_TABLES.some((name) => tables.includes(name)) && !countLog.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migrations 24/30 (room tasks, docs/ROOM_TASKS.md) may sit on top of any schema that has
      // rooms: both tables or none, recognized and never exported, like the rooms they belong to
      // (no claim comes back). Migration 54 (task stages) only adds columns to rooms and room_tasks,
      // so this check accepts it unchanged.
      const roomTaskTables = ['room_task_events', 'room_tasks'];
      const roomTasks = roomTaskTables.filter((name) => tables.includes(name));
      if (
        roomTasks.length &&
        (roomTasks.length !== roomTaskTables.length || !tables.includes('room_members'))
      )
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 56 (peer review of room tasks) comes only on top of the room task tables:
      // recognized and never exported, like the tasks themselves.
      if (TASK_REVIEW_TABLES.some((name) => tables.includes(name)) && !roomTasks.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 57 (task comments) comes only on top of the room task tables: recognized and
      // never exported, like the tasks they belong to.
      if (tables.includes('room_task_comments') && !roomTasks.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 23 (room repos, proposals, reviews and evidence; docs/ROOM_REPOS.md)
      // may sit on top of any schema that has rooms: all of its tables or none, recognized and
      // never exported, like the rooms they belong to (no binding or proposal comes back).
      const roomCode = ROOM_CODE_TABLES.filter((name) => tables.includes(name));
      if (
        roomCode.length &&
        (roomCode.length !== ROOM_CODE_TABLES.length || !tables.includes('room_members'))
      )
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 37 (guest source blocks of removed guests without an account) may sit on top
      // of any schema that has rooms: recognized and never exported, so a restore brings no
      // block back (they expire within 30 days anyway).
      if (tables.includes('room_guest_blocks') && !tables.includes('room_members'))
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 68 (room pins and the handoff brief ledger, docs/ROOMS.md) may sit on top of any
      // schema that has rooms: both tables or none, recognized and never exported, like the
      // messages and tasks the pins point at.
      const roomPinTables = ['room_briefs', 'room_pins'];
      const roomPins = roomPinTables.filter((name) => tables.includes(name));
      if (
        roomPins.length &&
        (roomPins.length !== roomPinTables.length || !tables.includes('room_members'))
      )
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 70 (conversation_hidden, docs/MESSAGING.md) comes only on top of messaging:
      // per-person "hidden from my list" marks, recognized and never exported like the messages.
      if (tables.includes('conversation_hidden') && !tables.includes('messages'))
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 73 (conversation_reads) likewise: per-owner read marks, never exported.
      if (tables.includes('conversation_reads') && !tables.includes('messages'))
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 39 (Elric, docs/ELRIC.md) may sit on top of any schema that has rooms: all of its
      // tables or none, recognized and never exported (no allowance, turn or pending action comes
      // back; a restored Elric workspace agent is a plain agent until its owner adds Elric again).
      const elric = ELRIC_TABLES.filter((name) => tables.includes(name));
      if (
        elric.length &&
        (elric.length !== ELRIC_TABLES.length || !tables.includes('room_members'))
      )
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 41 (Sign in with Google, docs/GOOGLE_SIGNIN.md) comes only on top of Elric's
      // tables: recognized and never exported. Its rows are short-lived sign-in flows; the linked
      // identities live in elric_verified_identities, which is never exported either (a restored
      // account links Google again).
      const google = GOOGLE_TABLES.filter((name) => tables.includes(name));
      if (google.length && (google.length !== GOOGLE_TABLES.length || !elric.length))
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 44 (Elric owner erasure) comes only on top of Elric's tables: anonymous cost
      // totals of erased accounts, recognized and never exported.
      if (ELRIC_ERASE_TABLES.some((name) => tables.includes(name)) && !elric.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 46 (streamed Elric reply drafts) comes only on top of Elric's tables: transient,
      // recognized and never exported.
      if (ELRIC_DRAFT_TABLES.some((name) => tables.includes(name)) && !elric.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 52 (anonymous conversation-title cost totals) comes only on top of Elric's
      // tables: recognized and never exported.
      if (ELRIC_TITLE_TABLES.some((name) => tables.includes(name)) && !elric.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 66 (cached room catch-ups) comes only on top of Elric's tables: a cache,
      // recognized and never exported.
      if (ELRIC_CATCH_UP_TABLES.some((name) => tables.includes(name)) && !elric.length)
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 71 (dismissed "Needs you" items, docs/ROOMS.md) may sit on top of any schema
      // that has rooms: recognized and never exported (a restore shows the items again).
      const needsYouTables = ['needs_you_dismissed'];
      if (needsYouTables.some((name) => tables.includes(name)) && !tables.includes('room_members'))
        throw new Error('Unsupported database schema; no backup was written.');
      // Migration 75 (messages each agent sent, a counter kept by a trigger on room_messages) may sit
      // on top of any schema that has rooms: both tables or none, recognized and never exported (a
      // restore starts the counts again; the backfill script recounts history).
      const messageCountTables = ['agent_message_counts', 'agent_message_counts_meta'];
      const messageCounts = messageCountTables.filter((name) => tables.includes(name));
      if (
        messageCounts.length &&
        (messageCounts.length !== messageCountTables.length || !tables.includes('room_members'))
      )
        throw new Error('Unsupported database schema; no backup was written.');
      const optional: readonly string[] = [
        ...RESPONDER_TABLES,
        ...RESPONDER_EXECUTION_TABLES,
        ...COUNT_LOG_TABLES,
        ...COUNT_LOG_PENDING_TABLES,
        ...roomTaskTables,
        ...TASK_REVIEW_TABLES,
        'room_task_comments',
        ...ROOM_CODE_TABLES,
        'room_guest_blocks',
        'conversation_hidden',
        'conversation_reads',
        ...messageCountTables,
        ...roomPinTables,
        ...ELRIC_TABLES,
        ...GOOGLE_TABLES,
        // Migration 76 (email outbox, newsletter consent): recognized, never exported.
        ...EMAIL_TABLES,
        // Migration 78 (Base agent wallets): recognized, never exported.
        ...BASE_TABLES,
        ...ELRIC_ERASE_TABLES,
        ...ELRIC_DRAFT_TABLES,
        ...ELRIC_TITLE_TABLES,
        ...ELRIC_CATCH_UP_TABLES,
        ...needsYouTables,
      ];
      const core = tables.filter((name) => !optional.includes(name));
      if (
        ![
          legacyTables,
          assistantTables,
          migratedTables,
          oauthTables,
          autonomyTables,
          messagingTables,
          parityTables,
          roomTables,
          joinLinkTables,
          expiryTables,
          wakeTables,
          wakeExpiryTables,
          [...expiryTables, 'room_invite_bootstrap', 'room_invite_credentials'].sort(),
          [...wakeExpiryTables, 'room_invite_bootstrap', 'room_invite_credentials'].sort(),
          resultTables,
          [...resultTables, 'unclaimed_agent_expiry'].sort(),
          [
            ...resultTables,
            'unclaimed_agent_expiry',
            'room_invite_bootstrap',
            'room_invite_credentials',
          ].sort(),
        ].some(
          (known) =>
            JSON.stringify(core) === JSON.stringify(known) ||
            // Migration 19 (pair_contexts, docs/MESSAGING.md) may sit on top of any schema that has
            // messaging (it needs migration 10): recognized and never exported, like the messages it
            // points into. `core` already excludes the migration 20 responder tables, so both
            // optional additions compose.
            (known.includes('messages') &&
              JSON.stringify(core) === JSON.stringify([...known, 'pair_contexts'].sort())),
        )
      )
        throw new Error('Unsupported database schema; no backup was written.');
      const size = (
        await tx.query<{ bytes: string }>(
          `SELECT COALESCE(sum(octet_length(data::text)),0)::text AS bytes FROM workspaces${tables.includes('claim_tokens') ? " WHERE operator_id IN (SELECT id FROM operators WHERE kind='owner')" : ''}`,
        )
      ).rows[0]!;
      const owners = tables.includes('claim_tokens') ? " WHERE kind='owner'" : '';
      if (Number(size.bytes) > MAX_BACKUP_BYTES)
        throw new Error('Backup exceeds the 32 MiB limit.');
      // Consent between two backed-up accounts is data and is carried (F4 §6).
      const crossRows = tables.includes('cross_connections')
        ? (
            await tx.query<z.infer<typeof crossConnection>>(
              `SELECT id,from_agent_id,from_owner_id,to_agent_id,to_owner_id,status,note,from_owner_label,
                requested_at,expires_at,decided_at,decided_by,revoked_at,revoked_by,invite_id,
                idempotency_key,request_hash FROM cross_connections
                WHERE from_owner_id IN (SELECT id FROM operators WHERE kind='owner')
                AND to_owner_id IN (SELECT id FROM operators WHERE kind='owner')
                ORDER BY requested_at, id LIMIT 100000`,
            )
          ).rows
        : [];
      const pairs = new Set(
        crossRows
          .filter((row) => row.status === 'approved' || row.status === 'revoked')
          .map((row) => `${row.from_agent_id}>${row.to_agent_id}`),
      );
      return validateSnapshot({
        format: 'central-city-offline-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        // Only owner accounts are backed up; unclaimed partitions (operators.kind) are not.
        operators: (
          await tx.query(
            `SELECT id,name,name_key,password_hash,salt FROM operators${owners} ORDER BY id LIMIT 1001`,
          )
        ).rows,
        workspaces: (
          await tx.query<{ operator_id: string; data: { agents: unknown[]; jobs: unknown[] } }>(
            `SELECT operator_id,data FROM workspaces WHERE operator_id IN (SELECT id FROM operators${owners}) ORDER BY operator_id LIMIT 1001`,
          )
        ).rows.map(withoutCrossWorkspaceJobs(pairs)),
        ...(crossRows.length
          ? {
              cross_connections: crossRows.map((row) => ({
                ...row,
                requested_at: Number(row.requested_at),
                expires_at: Number(row.expires_at),
                decided_at: row.decided_at === null ? null : Number(row.decided_at),
                revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
              })),
            }
          : {}),
      });
    });
    const payload = JSON.stringify(snapshot);
    const bytes = Buffer.from(JSON.stringify({ payload, sha256: hash(payload) }));
    if (bytes.length > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 32 MiB limit.');
    await directPath(destination);
    outputFile = await open(destination, 'wx', 0o600);
    await outputFile.writeFile(bytes);
    await outputFile.sync();
    return { operators: snapshot.operators.length, bytes: bytes.length };
  } finally {
    await outputFile?.close();
    if (db) await db.close();
    await lock.release();
  }
}

async function readBackup(path: string): Promise<Snapshot> {
  const source = await directPath(path);
  const file = await open(source, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BACKUP_BYTES || stat.size === 0)
      throw new Error('Backup must be a regular file of at most 32 MiB.');
    // Fixed allocation also bounds reads if another process grows the file after stat.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error('Backup changed while reading.');
    const envelope = envelopeSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    if (hash(envelope.payload) !== envelope.sha256) throw new Error('Backup checksum mismatch.');
    return validateSnapshot(JSON.parse(envelope.payload));
  } finally {
    await file.close();
  }
}

export async function restoreDatabase(backupPath: string, destinationPath: string) {
  // Validate entirely before creating the destination.
  const snapshot = await readBackup(backupPath);
  const destination = await directPath(destinationPath);
  const lock = await acquireDataLock(destination);
  let db: PGlite | undefined;
  try {
    await mkdir(destination, { mode: 0o700 }); // EEXIST is intentional, including empty directories.
    const marker = resolve(destination, INCOMPLETE_RECOVERY);
    await writeFile(marker, 'Recovery not complete. Do not start this database.\n', {
      flag: 'wx',
      mode: 0o600,
    });
    db = await PGlite.create(destination);
    await db.exec(`
      CREATE TABLE operators (id text PRIMARY KEY, name text NOT NULL, name_key text NOT NULL UNIQUE, password_hash text NOT NULL, salt text NOT NULL);
      CREATE TABLE workspaces (operator_id text PRIMARY KEY REFERENCES operators(id), data jsonb NOT NULL);
      CREATE TABLE sessions (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), expires_at bigint NOT NULL, created_at bigint NOT NULL);
      CREATE TABLE credentials (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), agent_id text NOT NULL UNIQUE);
      CREATE TABLE replay_nonces (agent_id text NOT NULL, nonce text NOT NULL, expires_at bigint NOT NULL, PRIMARY KEY(agent_id, nonce));
    `);
    const recoveredAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      for (const row of snapshot.operators)
        await tx.query(
          'INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES($1,$2,$3,$4,$5)',
          [row.id, row.name, row.name_key, row.password_hash, row.salt],
        );
      for (const row of snapshot.workspaces) {
        row.data.paused = true;
        for (const agent of row.data.agents) {
          agent.lastSeenAt = null;
          agent.lastSequence = -1;
          agent.announcedOnline = false;
        }
        for (const job of row.data.jobs) {
          job.leaseHash = null;
          job.leaseExpiresAt = null;
          if (job.status === 'queued' || job.status === 'running') {
            job.status = 'canceled';
            job.updatedAt = recoveredAt;
            job.completedAt = recoveredAt;
            job.error =
              'Canceled during isolated recovery; inspect external effects before creating new work.';
          }
        }
        for (const workflow of row.data.workflows ?? []) {
          if (!['accepted', 'failed', 'canceled'].includes(workflow.status)) {
            workflow.status = 'canceled';
            workflow.updatedAt = recoveredAt;
            workflow.error =
              'Canceled during isolated recovery; review retained results before starting new work.';
          }
        }
        row.data.events.push({
          id: randomUUID(),
          type: 'workspace.recovered',
          message:
            'Isolated recovery paused the workspace, cleared sessions, assistant access and runtime credentials, reset presence and canceled active jobs.',
          agentId: null,
          jobId: null,
          createdAt: recoveredAt,
        });
        row.data.events = row.data.events.slice(-1000);
        await tx.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
          row.operator_id,
          JSON.stringify(row.data),
        ]);
      }
      // Consent is restored as it was (the restored workspaces start paused anyway); the
      // migration ledger later adopts this table unchanged (CREATE ... IF NOT EXISTS).
      if (snapshot.cross_connections?.length) {
        await tx.exec(CROSS_CONNECTIONS_TABLE);
        for (const row of snapshot.cross_connections)
          await tx.query(
            `INSERT INTO cross_connections(id,from_agent_id,from_owner_id,to_agent_id,to_owner_id,status,note,
              from_owner_label,requested_at,expires_at,decided_at,decided_by,revoked_at,revoked_by,invite_id,
              idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              row.id,
              row.from_agent_id,
              row.from_owner_id,
              row.to_agent_id,
              row.to_owner_id,
              row.status,
              row.note,
              row.from_owner_label,
              row.requested_at,
              row.expires_at,
              row.decided_at,
              row.decided_by,
              row.revoked_at,
              row.revoked_by,
              row.invite_id,
              row.idempotency_key,
              row.request_hash,
            ],
          );
      }
    });
    await db.close();
    db = undefined;
    await unlink(marker);
    return { operators: snapshot.operators.length, dataDir: destination, paused: true };
  } finally {
    if (db) await db.close();
    await lock.release();
  }
}
