import { UNCLAIMED_AGENT_TTL_MS } from './expiry-schema.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import type { CityLimits } from '../limits.js';
import {
  MANIFEST_API_VERSION,
  PAID_MODEL_PROVIDERS,
  manifestIssue,
  type ManifestIssue,
  type ResolvedAgentManifest,
} from '../../shared/manifest.js';
import {
  applyTeamToolInput,
  controlToolInput,
  createAgentToolInput,
  planTeamToolInput,
} from '../../shared/assistant-tools.js';
import type { AgentCreator } from '../../shared/types.js';
import { canonicalize } from '../manifest/canonical.js';
import { builtinTemplates, templateRef } from '../manifest/templates.js';
import { planAgent, planTeam, type PlanContext, type TeamPlan } from '../manifest/plan.js';
import type { LoadedAgent } from '../manifest/resolve.js';
import {
  event,
  iso,
  publicAgent,
  stopJob,
  active,
  type StoredAgent,
  type Workspace,
} from '../model.js';
import { descendants, revokeStoredAgent, setAgentPaused } from '../agent-lifecycle.js';
import { ELRIC_MANAGED, elricAgentIds } from '../elric/access.js';
import { ELRIC_RESERVED_NAME_MESSAGE, reservedName } from '../elric/names.js';
import { baseRegistrationStarted } from '../base/identity/short-links.js';
import { syncOfferProviderName } from '../feed/offers/store.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Longest parentAgentId chain (root has depth 0). Bounds cascades and runaway self-replication. */
export const MAX_LINEAGE_DEPTH = 4;
export const ENROLLMENT_TTL_MS = 15 * 60_000;
export const ENROLLMENT_CODE = /^cce_[A-Za-z0-9_-]{43}$/;
export const CLAIM_TOKEN = /^ccclaim_[A-Za-z0-9_-]{43}$/;

/** The only capacity error anonymous callers see (which cap was hit is not disclosed). */
export const UNCLAIMED_CAPACITY_ISSUE = manifestIssue(
  'QUOTA_EXCEEDED',
  'spec.members',
  'Unclaimed creation capacity is currently unavailable for this request.',
  'Claim existing agents using their valid claim links to free unclaimed capacity, or retry later with fewer agents. Existing agents are retained.',
);

/** Rejection with optional machine-actionable manifest issues. */
export class AutonomyError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public issues?: ManifestIssue[],
    public errorCode?: string,
  ) {
    super(message);
  }
}
function refuse(status: number, message: string, issues?: ManifestIssue[]): never {
  throw new AutonomyError(status, message, issues);
}

type Queryable = Pick<Tx, 'query'>;
export interface Receipts {
  get(
    tool: string,
    key: string,
  ): Promise<{ request_hash: string; resource_id: string } | undefined>;
  put(tool: string, key: string, requestHash: string, resourceId: string): Promise<void>;
}
/** Who is acting and in which partition: an owner workspace, or an unclaimed source bucket. */
export interface Actor {
  mode: 'owned' | 'unclaimed';
  /** Owner operator id, or the unclaimed bucket's operator id (empty before it exists). */
  operatorId: string;
  createdBy: AgentCreator;
  rootSponsor: string;
  /** Human-readable actor for audit events. */
  label: string;
  /** connections:create (always true for unclaimed teams, whose routes stay inside the team). */
  canConnect: boolean;
  origin: string;
  receipts?: Receipts;
  /** Extra check under the partition lock just before agents are created (global caps). */
  beforeCreate?: (tx: Tx, creates: number) => Promise<void>;
}

interface AppliedResource {
  teamHash: string | null;
  agents: Array<{ name: string; id: string; action: 'create' | 'update' | 'noop' }>;
  connections: Array<{ from: string; to: string; id: string; action: 'create' | 'noop' }>;
}
type Document = { kind: 'Agent' | 'Team'; document: unknown };
interface Planned {
  plan: TeamPlan;
  document: Document;
  lineage: Map<string, { parentName: string | null; depth: number }>;
  parent: StoredAgent | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function templateOf(ref: string) {
  const [, id, version] = /^template:(.+)@(.+)$/.exec(ref) ?? [];
  return id && version ? builtinTemplates.get(id, version) : undefined;
}

/** `{manifest}` or `{template, overrides?}` as a manifest document of the right kind. */
function toDocument(values: {
  manifest?: Record<string, unknown>;
  template?: string;
  overrides?: { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
}): Document {
  if (Boolean(values.manifest) === Boolean(values.template))
    refuse(400, 'Provide exactly one of manifest or template.');
  if (values.manifest) {
    if (values.overrides) refuse(400, 'overrides apply only to template references.');
    return { kind: values.manifest.kind === 'Team' ? 'Team' : 'Agent', document: values.manifest };
  }
  const ref = values.template!;
  const template = templateOf(ref);
  if (template?.kind === 'Team') {
    if (values.overrides) refuse(400, 'Team templates cannot be overridden; submit a manifest.');
    return { kind: 'Team', document: structuredClone(template.manifest) };
  }
  const metadata = { ...(values.overrides?.metadata ?? {}) };
  const id = /^template:([^@]+)@/.exec(ref)![1]!;
  return {
    kind: 'Agent',
    document: {
      apiVersion: MANIFEST_API_VERSION,
      kind: 'Agent',
      metadata: { ...metadata, name: metadata.name ?? id },
      spec: { ...(values.overrides?.spec ?? {}), extends: ref },
    },
  };
}

const AGENT_REF = /^agent:([0-9a-f-]{36})@([1-9]\d{0,8})$/;
function agentRefs(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 12 || out.size > 32) return out;
  if (typeof value === 'string' && AGENT_REF.test(value)) out.add(value);
  else if (Array.isArray(value)) for (const item of value) agentRefs(item, out, depth + 1);
  else if (isRecord(value))
    for (const item of Object.values(value)) agentRefs(item, out, depth + 1);
  return out;
}

/** Compact plan for tool output: resolved manifests are summarized, not echoed in full. */
export function compactPlan(plan: TeamPlan) {
  return {
    ...plan,
    agents: plan.agents.map(({ manifest, ...rest }) => ({
      ...rest,
      summary: {
        displayName: manifest.metadata.displayName,
        description: manifest.metadata.description,
        capabilities: manifest.spec.capabilities,
        runtime: manifest.spec.runtime,
        policy: manifest.spec.policy,
        visibility: manifest.spec.visibility,
        skills: manifest.spec.skills.map((skill) => skill.id),
      },
    })),
  };
}

export const agentCardUrl = (origin: string, agentId: string) =>
  `${origin}/a2a/${agentId}/.well-known/agent-card.json`;

export function createAutonomyService(caps: CityLimits) {
  async function preloadForks(
    db: Queryable,
    actor: Actor,
    document: unknown,
  ): Promise<(id: string, revision: number) => LoadedAgent | undefined> {
    const loaded = new Map<string, LoadedAgent>();
    for (const ref of agentRefs(document)) {
      const [, agentId, revision] = AGENT_REF.exec(ref)!;
      const row = (
        await db.query<{ manifest: ResolvedAgentManifest; operator_id: string }>(
          'SELECT manifest,operator_id FROM agent_manifests WHERE agent_id=$1 AND revision=$2',
          [agentId, Number(revision)],
        )
      ).rows[0];
      if (!row) continue;
      const sameOwner = actor.mode === 'owned' && row.operator_id === actor.operatorId;
      // Tenant isolation: another partition's agent is visible only when published as public.
      if (!sameOwner && row.manifest.spec.visibility !== 'public') continue;
      loaded.set(`${agentId}@${revision}`, { manifest: row.manifest, sameOwner });
    }
    return (id, revision) => loaded.get(`${id}@${revision}`);
  }

  /** Plans a document for the actor's partition and adds autonomy checks. */
  async function plan(
    db: Queryable,
    workspace: Workspace | null,
    actor: Actor,
    document: Document,
    parentAgentId: string | undefined,
  ): Promise<Planned> {
    const owned = actor.mode === 'owned' && workspace !== null;
    const agentLimit =
      actor.mode === 'owned' ? caps.agentsPerWorkspace : caps.unclaimedAgentsPerSource;
    const context: PlanContext = {
      // Unclaimed buckets are shared by every anonymous caller behind one address, so each
      // unclaimed apply is standalone: it never matches, updates or reuses existing agents.
      existingAgents: owned
        ? workspace.agents
            .filter((agent) => agent.manifestName)
            .map((agent) => ({
              id: agent.id,
              name: agent.manifestName!,
              manifestHash: agent.manifestHash ?? null,
              revoked: Boolean(agent.revokedAt),
            }))
        : [],
      existingConnections: owned ? workspace.connections : [],
      limits: {
        agentsPerWorkspace: agentLimit,
        connectionsPerWorkspace: caps.connectionsPerWorkspace,
      },
      quotas: {
        remaining: {
          agents: Math.max(0, agentLimit - (workspace?.agents.length ?? 0)),
          connections: Math.max(
            0,
            caps.connectionsPerWorkspace - (workspace?.connections.length ?? 0),
          ),
        },
      },
      loadAgent: await preloadForks(db, actor, document.document),
    };
    const result =
      document.kind === 'Team'
        ? planTeam(document.document, context)
        : planAgent(document.document, context);
    const errors = [...result.errors];
    const warnings = [...result.warnings];

    let parent: StoredAgent | null = null;
    if (parentAgentId !== undefined) {
      if (actor.mode === 'unclaimed')
        errors.push(
          manifestIssue(
            'PARENT_NOT_ALLOWED',
            'parent_agent_id',
            'Anonymous callers cannot create agents under an existing agent.',
            'Omit parent_agent_id, or connect with OAuth as the owner.',
          ),
        );
      else {
        parent = workspace?.agents.find((agent) => agent.id === parentAgentId) ?? null;
        if (!parent || parent.revokedAt)
          errors.push(
            manifestIssue(
              'PARENT_NOT_FOUND',
              'parent_agent_id',
              'The parent agent does not exist in this workspace or is revoked.',
              'Use the id of an active agent in the granted workspace.',
            ),
          );
      }
    }
    const baseDepth = parent ? (parent.depth ?? 0) + 1 : 0;
    const lineage = new Map<string, { parentName: string | null; depth: number }>();
    const coordinator =
      document.kind === 'Team' && isRecord(document.document) && isRecord(document.document.spec)
        ? String(document.document.spec.coordinator ?? '')
        : null;
    for (const agent of result.agents)
      lineage.set(agent.name, { parentName: null, depth: baseDepth });
    if (coordinator && lineage.has(coordinator)) {
      const queue = [coordinator];
      const reached = new Set(queue);
      while (queue.length) {
        const from = queue.shift()!;
        for (const edge of result.connections)
          if (edge.from === from && !reached.has(edge.to) && lineage.has(edge.to)) {
            reached.add(edge.to);
            lineage.set(edge.to, { parentName: from, depth: lineage.get(from)!.depth + 1 });
            queue.push(edge.to);
          }
      }
    }
    for (const [name, place] of lineage)
      if (
        place.depth > MAX_LINEAGE_DEPTH &&
        result.agents.find((a) => a.name === name)?.action === 'create'
      )
        errors.push(
          manifestIssue(
            'LINEAGE_TOO_DEEP',
            'parent_agent_id',
            `"${name}" would be ${place.depth} levels below its lineage root; the limit is ${MAX_LINEAGE_DEPTH}.`,
            'Create the team under a shallower parent or shorten its delegation chain.',
          ),
        );

    result.agents.forEach((agent) => {
      if (agent.action === 'noop') return;
      if (agent.manifest.spec.runtime.mode === 'a2a')
        errors.push(
          manifestIssue(
            'RUNTIME_NOT_APPLICABLE',
            `${agent.name}.spec.runtime.mode`,
            `"${agent.name}" uses an a2a runtime, which cannot be applied yet.`,
            'Use runtime mode "external" (enrolled runtime) or "hosted" (zero-cost demo).',
          ),
        );
      const existing = agent.agentId && workspace?.agents.find((item) => item.id === agent.agentId);
      if (existing && existing.mode !== agent.manifest.spec.runtime.mode)
        errors.push(
          manifestIssue(
            'RUNTIME_MODE_CHANGE',
            `${agent.name}.spec.runtime.mode`,
            `"${agent.name}" already exists with runtime mode ${existing.mode}.`,
            'Revoke the existing agent first, or keep its runtime mode.',
          ),
        );
    });
    // Autonomous creation is zero-cost only. Anything needing spend approval is refused
    // (there is no owner approval step for AI-applied manifests yet).
    for (const approval of result.approvals)
      errors.push(
        manifestIssue(
          actor.mode === 'unclaimed' ? 'UNCLAIMED_ZERO_COST_ONLY' : 'OWNER_APPROVAL_REQUIRED',
          approval.path,
          `${approval.message} ${actor.mode === 'unclaimed' ? 'Unclaimed agents must be zero-cost (budget 0, no paid model).' : 'AI clients may only apply zero-cost manifests without owner approval.'}`,
          actor.mode === 'unclaimed'
            ? 'Set budgetUsd to 0 and omit paid model providers.'
            : 'Set budgetUsd to 0 and omit paid model providers, or ask the owner.',
        ),
      );
    if (result.summary.connectionsToCreate > 0 && !actor.canConnect)
      warnings.push(
        manifestIssue(
          'SCOPE_REQUIRED',
          'spec.connections',
          'Applying this team creates connections, which requires the connections:create scope.',
          'Ask the owner to grant connections:create, or apply a team without connections.',
        ),
      );
    // N4: unclaimed callers learn only that capacity is unavailable, not which cap or how full.
    if (actor.mode === 'unclaimed')
      errors.forEach((issue, index) => {
        if (issue.code === 'QUOTA_EXCEEDED') errors[index] = UNCLAIMED_CAPACITY_ISSUE;
      });
    const ok = errors.length === 0;
    return {
      plan: {
        ...result,
        ok,
        errors,
        warnings,
        team: result.team ? { ...result.team, teamHash: ok ? result.team.teamHash : null } : null,
      },
      document,
      lineage,
      parent,
    };
  }

  function refusePlan(plan: TeamPlan): never {
    const codes = new Set(plan.errors.map((issue) => issue.code));
    const status = [...codes].some((code) =>
      ['OWNER_APPROVAL_REQUIRED', 'UNCLAIMED_ZERO_COST_ONLY'].includes(code),
    )
      ? 403
      : [...codes].every((code) => code === 'QUOTA_EXCEEDED')
        ? 409
        : 400;
    if (plan.errors.every((issue) => issue === UNCLAIMED_CAPACITY_ISSUE))
      return refuse(409, UNCLAIMED_CAPACITY_ISSUE.message, plan.errors);
    return refuse(
      status,
      `The manifest cannot be applied: ${plan.errors
        .slice(0, 3)
        .map((issue) => `${issue.code} at ${issue.path || '(root)'}`)
        .join('; ')}${plan.errors.length > 3 ? '; …' : ''}.`,
      plan.errors,
    );
  }

  async function applyPlan(
    tx: Tx,
    workspace: Workspace,
    time: number,
    actor: Actor,
    planned: Planned,
    expectedTeamHash: string | undefined,
  ): Promise<AppliedResource> {
    const { plan } = planned;
    if (!plan.ok) refusePlan(plan);
    if (expectedTeamHash !== undefined && plan.team?.teamHash !== expectedTeamHash)
      refuse(409, 'The team plan changed since it was reviewed; plan again.', [
        manifestIssue(
          'TEAM_HASH_MISMATCH',
          'expected_team_hash',
          `The current team hash is ${plan.team?.teamHash ?? 'unavailable'}.`,
          'Re-run city_plan_team, review the plan and apply with its team_hash.',
        ),
      ]);
    if (plan.summary.connectionsToCreate > 0 && !actor.canConnect)
      refuse(403, 'Creating team connections requires the connections:create scope.');
    if (workspace.paused) refuse(409, 'Workspace is paused.');
    const creates = plan.agents.filter((agent) => agent.action === 'create').length;
    if (creates && actor.beforeCreate) await actor.beforeCreate(tx, creates);

    const ids = new Map<string, string>();
    const agents: AppliedResource['agents'] = [];
    for (const item of plan.agents) {
      const { manifest } = item;
      const fields = {
        name: manifest.metadata.displayName.slice(0, 64),
        description: manifest.metadata.description.slice(0, 300),
        capability: manifest.spec.capabilities[0] as StoredAgent['capability'],
      };
      // Elric (docs/ELRIC.md): the name is reserved for first-party Elric agents.
      if (reservedName(fields.name)) refuse(409, ELRIC_RESERVED_NAME_MESSAGE);
      if (item.action === 'create') {
        const place = planned.lineage.get(item.name) ?? { parentName: null, depth: 0 };
        const agent: StoredAgent = {
          id: randomUUID(),
          ...fields,
          mode: manifest.spec.runtime.mode as 'hosted' | 'external',
          isDemo: manifest.spec.runtime.mode === 'hosted',
          lastSeenAt: null,
          createdAt: iso(time),
          revokedAt: null,
          lastSequence: -1,
          announcedOnline: false,
          manifestName: item.name,
          manifestHash: item.manifestHash,
          revision: 1,
          createdBy: actor.createdBy,
          parentAgentId: place.parentName
            ? (ids.get(place.parentName) ?? null)
            : (planned.parent?.id ?? null),
          depth: place.depth,
          rootSponsor: planned.parent?.rootSponsor ?? actor.rootSponsor,
        };
        if (actor.mode === 'unclaimed')
          await tx.query(
            'INSERT INTO unclaimed_agent_expiry(agent_id,operator_id,expires_at) VALUES($1,$2,$3)',
            [agent.id, actor.operatorId, time + UNCLAIMED_AGENT_TTL_MS],
          );
        workspace.agents.push(agent);
        ids.set(item.name, agent.id);
        await tx.query(
          'INSERT INTO agent_manifests(agent_id,revision,manifest_hash,manifest,created_at,operator_id) VALUES($1,1,$2,$3::jsonb,$4,$5)',
          [agent.id, item.manifestHash, JSON.stringify(manifest), time, actor.operatorId],
        );
        event(
          workspace,
          time,
          'agent.registered',
          `${agent.name} created from manifest "${item.name}" by ${actor.label} as ${agent.isDemo ? 'a zero-cost deterministic demonstration' : 'an external runtime awaiting enrollment'}.`,
          agent.id,
        );
        agents.push({ name: item.name, id: agent.id, action: 'create' });
        continue;
      }
      const agent = workspace.agents.find((candidate) => candidate.id === item.agentId)!;
      ids.set(item.name, agent.id);
      if (item.action === 'update') {
        // A Base agent's on-chain URI (/a/<id>) is read from its public card, so it stays public
        // (the same rule as My agents' Make private).
        if (manifest.spec.visibility !== 'public' && (await baseRegistrationStarted(tx, agent.id)))
          throw new AutonomyError(
            409,
            "A Base agent's profile stays public.",
            [
              manifestIssue(
                'BASE_AGENT_PUBLIC',
                'spec.visibility',
                `${agent.name} is registered on Base, so its visibility must stay public.`,
                'Set spec.visibility to "public" in the manifest.',
              ),
            ],
            'base_stays_public',
          );
        const previousName = agent.name;
        Object.assign(agent, fields);
        // The stored copy mirrors the manifest (the owner's pages read it).
        const visibility = manifest.spec.visibility;
        if (visibility === 'private' || visibility === 'public') agent.visibility = visibility;
        else delete agent.visibility;
        agent.manifestHash = item.manifestHash;
        agent.revision = (agent.revision ?? 1) + 1;
        await tx.query(
          'INSERT INTO agent_manifests(agent_id,revision,manifest_hash,manifest,created_at,operator_id) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
          [
            agent.id,
            agent.revision,
            item.manifestHash,
            JSON.stringify(manifest),
            time,
            actor.operatorId,
          ],
        );
        // The agent's Feed listings carry its public name: the new revision's, or none while
        // private (as updateStoredAgent does for a rename or a visibility change).
        const shown = agent.name.replace(/^ +| +$/g, '');
        await syncOfferProviderName(
          tx,
          actor.operatorId,
          agent.id,
          visibility === 'public' && shown ? shown : null,
        );
        event(
          workspace,
          time,
          'agent.updated',
          `${agent.name} updated to manifest revision ${agent.revision} by ${actor.label}.`,
          agent.id,
        );
        // A manifest can change the display name: the owner sees it in Activity like a rename (#116).
        if (agent.name !== previousName)
          event(
            workspace,
            time,
            'agent.renamed',
            `Renamed ${previousName} to ${agent.name}.`,
            agent.id,
          );
      }
      agents.push({ name: item.name, id: agent.id, action: item.action });
    }
    const connections: AppliedResource['connections'] = [];
    for (const edge of plan.connections) {
      const fromAgentId = ids.get(edge.from)!;
      const toAgentId = ids.get(edge.to)!;
      const existing = workspace.connections.find(
        (item) => item.fromAgentId === fromAgentId && item.toAgentId === toAgentId,
      );
      if (existing) {
        connections.push({ from: edge.from, to: edge.to, id: existing.id, action: 'noop' });
        continue;
      }
      if (workspace.connections.length >= caps.connectionsPerWorkspace)
        refuse(409, 'Connection limit reached.');
      const connection = { id: randomUUID(), fromAgentId, toAgentId, createdAt: iso(time) };
      workspace.connections.push(connection);
      const from = workspace.agents.find((agent) => agent.id === fromAgentId)!;
      const to = workspace.agents.find((agent) => agent.id === toAgentId)!;
      event(
        workspace,
        time,
        'connection.authorized',
        `${from.name} may request work from ${to.name} (team route applied by ${actor.label}).`,
        to.id,
      );
      connections.push({ from: edge.from, to: edge.to, id: connection.id, action: 'create' });
    }
    return { teamHash: plan.team?.teamHash ?? null, agents, connections };
  }

  async function enrollmentFor(
    tx: Tx,
    operatorId: string,
    agent: StoredAgent,
    time: number,
    origin: string,
  ) {
    if (agent.mode !== 'external' || agent.revokedAt) return null;
    const credential = await tx.query('SELECT agent_id FROM credentials WHERE agent_id=$1', [
      agent.id,
    ]);
    if (credential.rows.length) return null;
    // At most one live code per agent; a retried response supersedes the previous code.
    await tx.query('DELETE FROM runtime_enrollments WHERE agent_id=$1 AND used_at IS NULL', [
      agent.id,
    ]);
    await tx.query(
      'DELETE FROM runtime_enrollments WHERE code_hash IN (SELECT code_hash FROM runtime_enrollments WHERE expires_at<=$1 LIMIT 200)',
      [time],
    );
    const code = `cce_${randomBytes(32).toString('base64url')}`;
    await tx.query(
      'INSERT INTO runtime_enrollments(code_hash,operator_id,agent_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
      [sha(code), operatorId, agent.id, time, time + ENROLLMENT_TTL_MS],
    );
    return {
      enrollment_code: code,
      agent_id: agent.id,
      endpoint: `${origin}/api/runtime/enroll`,
      expires_at: iso(time + ENROLLMENT_TTL_MS),
      single_use: true as const,
    };
  }

  async function mintClaim(
    tx: Tx,
    bucketId: string,
    agentIds: string[],
    time: number,
    origin: string,
  ) {
    const set = JSON.stringify([...agentIds].sort());
    // One live claim token per created set: a retried response supersedes the earlier token.
    await tx.query(
      'DELETE FROM claim_tokens WHERE bucket_id=$1 AND claimed_at IS NULL AND agent_ids=$2::jsonb',
      [bucketId, set],
    );
    const token = `ccclaim_${randomBytes(32).toString('base64url')}`;
    await tx.query(
      'INSERT INTO claim_tokens(token_hash,bucket_id,agent_ids,created_at) VALUES($1,$2,$3::jsonb,$4)',
      [sha(token), bucketId, set, time],
    );
    return {
      claim_token: token,
      claim_url: `${origin}/#claim=${token}`,
      endpoint: `${origin}/api/agents/claim`,
      agent_ids: [...agentIds].sort(),
      single_use: true as const,
    };
  }

  async function describe(
    tx: Tx,
    workspace: Workspace,
    time: number,
    actor: Actor,
    resource: AppliedResource,
    replay: boolean,
  ) {
    // B1: a replayed unclaimed request never mints or rotates secrets. Anyone behind the same
    // address shares the partition, so re-issuing would let a neighbour who learned the key take
    // over the original caller's claim token or enrollment code.
    const issueSecrets = !(replay && actor.mode === 'unclaimed');
    const agents = [];
    for (const item of resource.agents) {
      const agent = workspace.agents.find((candidate) => candidate.id === item.id);
      // Uniform 404: whether the agents were claimed, revoked or never existed is not disclosed.
      if (!agent) refuse(404, 'Agent not found.');
      agents.push({
        name: item.name,
        agent_id: agent.id,
        action: item.action,
        display_name: agent.name,
        runtime_mode: agent.mode,
        capability: agent.capability,
        manifest_hash: agent.manifestHash ?? null,
        revision: agent.revision ?? null,
        parent_agent_id: agent.parentAgentId ?? null,
        depth: agent.depth ?? 0,
        status: publicAgent(agent, workspace.jobs, time).status,
        agent_card_url: agentCardUrl(actor.origin, agent.id),
        enrollment: issueSecrets
          ? await enrollmentFor(tx, actor.operatorId, agent, time, actor.origin)
          : null,
      });
    }
    const claim =
      issueSecrets && actor.mode === 'unclaimed' && agents.length
        ? await mintClaim(
            tx,
            actor.operatorId,
            agents.map((agent) => agent.agent_id),
            time,
            actor.origin,
          )
        : null;
    const next: string[] = [];
    for (const agent of agents)
      if (agent.enrollment)
        next.push(
          `Give ${agent.name}'s runtime its enrollment_code; it calls POST ${agent.enrollment.endpoint} with {"agent_id","enrollment_code"} once, within 15 minutes, to receive its runtime credential.`,
        );
    if (!issueSecrets)
      next.push(
        'This request was already applied; its claim token and enrollment codes were returned only by the first response and are not issued again.',
      );
    if (claim)
      next.push(
        `Give claim_token (or claim_url) to the person who should own these unclaimed agents; after signing in they claim them once at POST ${claim.endpoint}. The token is shown only in this response.`,
      );
    if (agents.some((agent) => agent.runtime_mode === 'hosted'))
      next.push(
        actor.mode === 'owned'
          ? 'Hosted members are zero-cost deterministic demos; request work along the team connections with city_create_job (jobs:create).'
          : 'Hosted members are zero-cost deterministic demos; enrolled team runtimes can request their work along the team connections.',
      );
    next.push(
      `Fetch each Agent Card from agent_card_url and verify its signature with ${actor.origin}/.well-known/jwks.json.`,
    );
    return {
      mode: actor.mode,
      team_hash: resource.teamHash,
      agents,
      connections: resource.connections.map((edge) => ({
        from: edge.from,
        to: edge.to,
        connection_id: edge.id,
        action: edge.action,
      })),
      claim,
      secrets_already_issued: !issueSecrets,
      next_actions: next,
    };
  }

  async function idempotent(
    actor: Actor,
    tool: string,
    key: string,
    values: unknown,
    run: () => Promise<AppliedResource>,
  ): Promise<{ resource: AppliedResource; replay: boolean }> {
    if (!actor.receipts) return { resource: await run(), replay: false };
    const keyHash = sha(key);
    // The receipt is bound to a hash of the canonical request: the same key with any other
    // arguments is refused.
    const fingerprint = sha(canonicalize(values));
    const receipt = await actor.receipts.get(tool, keyHash);
    if (receipt) {
      if (receipt.request_hash !== fingerprint)
        refuse(409, 'This idempotency key belongs to different arguments.');
      return { resource: JSON.parse(receipt.resource_id) as AppliedResource, replay: true };
    }
    const resource = await run();
    await actor.receipts.put(tool, keyHash, fingerprint, JSON.stringify(resource));
    return { resource, replay: false };
  }

  function nextForPlan(planned: Planned, mode: Actor['mode']): string[] {
    if (!planned.plan.ok)
      return ['Fix the listed errors (each has a path and hint) and plan again.'];
    return [
      planned.document.kind === 'Team'
        ? `Apply with city_apply_team using the same manifest, an idempotency_key and expected_team_hash "${planned.plan.team?.teamHash}".`
        : 'Create with city_create_agent using the same manifest and an idempotency_key.',
      ...(mode === 'unclaimed'
        ? [
            'Anonymous creation makes unclaimed, zero-cost agents that a person can later claim with the returned claim token.',
          ]
        : []),
    ];
  }

  function manifestCreateValues(args: unknown) {
    const values = createAgentToolInput.parse(args);
    for (const legacy of ['name', 'description', 'capability', 'mode', 'idempotencyKey'] as const)
      if (values[legacy] !== undefined)
        refuse(400, `Manifest mode does not accept the legacy field ${legacy}.`);
    const document = toDocument(values);
    if (document.kind !== 'Agent')
      refuse(400, 'city_create_agent takes an Agent manifest; apply teams with city_apply_team.');
    return { values, document };
  }

  /** city_create_agent with dry_run: plans only; nothing is created or recorded. */
  async function createDryRun(
    db: Queryable,
    workspace: Workspace | null,
    actor: Actor,
    args: unknown,
  ) {
    const { values, document } = manifestCreateValues(args);
    const planned = await plan(db, workspace, actor, document, values.parent_agent_id);
    return {
      agent: null,
      connectionRequired: false,
      runtimeSetupRequired: false,
      dry_run: true,
      mode: actor.mode,
      plan: compactPlan(planned.plan),
      next_actions: nextForPlan(planned, actor.mode),
    };
  }

  return {
    createDryRun,
    listTemplates() {
      return {
        templates: builtinTemplates.list().map((template) => {
          const zeroCost =
            template.kind === 'Team'
              ? template.manifest.spec.policy.budgetUsd === 0
              : (template.manifest.spec.policy?.budgetUsd ?? 0) === 0 &&
                !PAID_MODEL_PROVIDERS.includes(
                  template.manifest.spec.runtime?.model?.provider ?? 'platform',
                );
          return {
            ref: templateRef(template),
            kind: template.kind,
            id: template.id,
            version: template.version,
            title: template.title,
            description: template.description,
            members:
              template.kind === 'Team'
                ? template.manifest.spec.members.map((member) => member.name)
                : [],
            zero_cost: zeroCost,
          };
        }),
        next_actions: [
          'Plan a template with city_plan_team {"template": "<ref>"}, or create one agent with city_create_agent {"template": "<ref>", "idempotency_key": "…"}.',
        ],
      };
    },

    async planTool(db: Queryable, workspace: Workspace | null, actor: Actor, args: unknown) {
      const values = planTeamToolInput.parse(args);
      const planned = await plan(db, workspace, actor, toDocument(values), values.parent_agent_id);
      return {
        mode: actor.mode,
        ok: planned.plan.ok,
        team_hash: planned.plan.team?.teamHash ?? null,
        plan: compactPlan(planned.plan),
        next_actions: nextForPlan(planned, actor.mode),
      };
    },

    /** Manifest-mode city_create_agent. Returns the plan only when dry_run is true. */
    async createAgentTool(tx: Tx, workspace: Workspace, time: number, actor: Actor, args: unknown) {
      const { values, document } = manifestCreateValues(args);
      if (values.dry_run) return createDryRun(tx, workspace, actor, args);
      if (!values.idempotency_key)
        refuse(400, 'idempotency_key is required unless dry_run is true.');
      const { idempotency_key: key, dry_run: _dry, ...fingerprinted } = values;
      const { resource, replay } = await idempotent(
        actor,
        'city_create_agent:manifest',
        key!,
        fingerprinted,
        async () =>
          applyPlan(
            tx,
            workspace,
            time,
            actor,
            await plan(tx, workspace, actor, document, values.parent_agent_id),
            undefined,
          ),
      );
      const result = await describe(tx, workspace, time, actor, resource, replay);
      const created = result.agents[0]!;
      const agent = workspace.agents.find((item) => item.id === created.agent_id)!;
      return {
        agent: publicAgent(agent, workspace.jobs, time),
        connectionRequired: !workspace.connections.some(
          (connection) => connection.fromAgentId === agent.id || connection.toAgentId === agent.id,
        ),
        runtimeSetupRequired: agent.mode === 'external',
        dry_run: false,
        mode: result.mode,
        action: created.action,
        manifest_name: created.name,
        manifest_hash: created.manifest_hash,
        revision: created.revision,
        agent_card_url: created.agent_card_url,
        enrollment: created.enrollment,
        claim: result.claim,
        secrets_already_issued: result.secrets_already_issued,
        next_actions: result.next_actions,
      };
    },

    async applyTeamTool(tx: Tx, workspace: Workspace, time: number, actor: Actor, args: unknown) {
      const values = applyTeamToolInput.parse(args);
      const document = toDocument(values);
      if (document.kind !== 'Team')
        refuse(
          400,
          'city_apply_team takes a Team manifest; create single agents with city_create_agent.',
        );
      const { idempotency_key: key, ...fingerprinted } = values;
      const { resource, replay } = await idempotent(
        actor,
        'city_apply_team',
        key,
        fingerprinted,
        async () =>
          applyPlan(
            tx,
            workspace,
            time,
            actor,
            await plan(tx, workspace, actor, document, values.parent_agent_id),
            values.expected_team_hash,
          ),
      );
      return describe(tx, workspace, time, actor, resource, replay);
    },

    /** Pre-flight plan outside any partition lock (anonymous fail-fast before a bucket exists). */
    async preflight(db: Queryable, actor: Actor, tool: 'create' | 'apply', args: unknown) {
      const values =
        tool === 'apply' ? applyTeamToolInput.parse(args) : createAgentToolInput.parse(args);
      const document = toDocument(values);
      if ((tool === 'apply') !== (document.kind === 'Team'))
        refuse(
          400,
          tool === 'apply'
            ? 'city_apply_team takes a Team manifest; create single agents with city_create_agent.'
            : 'city_create_agent takes an Agent manifest; apply teams with city_apply_team.',
        );
      const planned = await plan(db, null, actor, document, values.parent_agent_id);
      if (!planned.plan.ok) refusePlan(planned.plan);
      return planned;
    },

    async controlTool(tx: Tx, workspace: Workspace, time: number, actor: Actor, args: unknown) {
      const values = controlToolInput.parse(args);
      if (values.action === 'revoke' && values.cascade === false)
        refuse(
          400,
          'Revocation always cascades to descendant agents; omit cascade or set it to true.',
        );
      const target =
        workspace.agents.find((agent) => agent.id === values.agent_id) ??
        refuse(404, 'Agent not found.');
      const targets =
        values.cascade === false ? [target] : [target, ...descendants(workspace, target.id)];
      // Elric (docs/ELRIC.md) is managed by Central City: no grant or key controls it.
      if (
        (
          await elricAgentIds(
            tx,
            targets.map((agent) => agent.id),
          )
        ).size
      )
        throw new AutonomyError(409, ELRIC_MANAGED.message, undefined, ELRIC_MANAGED.code);
      const affected = [];
      for (const agent of targets) {
        let changed = false;
        if (values.action === 'revoke')
          changed = await revokeStoredAgent(
            workspace,
            tx,
            actor.operatorId,
            agent,
            time,
            agent === target
              ? `${agent.name} revoked by ${actor.label}.`
              : `${agent.name} revoked by ${actor.label} because its parent agent ${target.name} was revoked.`,
          );
        else
          changed = setAgentPaused(workspace, agent, time, values.action === 'pause', actor.label);
        affected.push({
          agent_id: agent.id,
          name: agent.name,
          changed,
          paused: Boolean(agent.pausedAt),
          revoked: Boolean(agent.revokedAt),
          status: publicAgent(agent, workspace.jobs, time).status,
        });
      }
      return {
        agent_id: target.id,
        action: values.action,
        cascade: values.cascade !== false,
        affected,
        next_actions:
          values.action === 'revoke'
            ? ['Revocation is permanent; create new agents from a manifest if needed.']
            : values.action === 'pause'
              ? [
                  'Paused agents cannot send or receive work. Resume with city_control action "resume".',
                ]
              : ['Resumed agents can work again along their existing connections.'],
      };
    },
  };
}
export type AutonomyService = ReturnType<typeof createAutonomyService>;
