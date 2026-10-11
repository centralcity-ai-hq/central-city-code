import { createHash, randomBytes } from 'node:crypto';
import type { Transaction as Tx } from './database.js';
import { closeAgentChat } from './rooms/private.js';
import { resetPresence } from './presence.js';
import { revokeAgentCrossConnections } from './connections/service.js';
import { revokeAgentResults } from './results/store.js';
import { revokeResponderCredentials } from './responder/revoke.js';
import { active, event, iso, stopJob, type StoredAgent, type Workspace } from './model.js';
import { hashManifest } from './manifest/resolve.js';
import type { ResolvedAgentManifest } from '../shared/manifest.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Agents below `rootId` in the parentAgentId lineage, in breadth-first order (root excluded). */
export function descendants(workspace: Workspace, rootId: string): StoredAgent[] {
  const out: StoredAgent[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const agent of workspace.agents)
      if (agent.parentAgentId === parent && !seen.has(agent.id)) {
        seen.add(agent.id);
        out.push(agent);
        queue.push(agent.id);
      }
  }
  return out;
}

/**
 * Pauses or resumes one agent inside the owner's workspace transaction (city_control and the
 * console's Pause / Resume). A pause stops the agent's active work; both leave an audit event.
 * Returns whether anything changed: pausing a paused agent, resuming a running one or touching a
 * revoked one is a no-op.
 */
export function setAgentPaused(
  workspace: Workspace,
  agent: StoredAgent,
  time: number,
  paused: boolean,
  by: string,
): boolean {
  if (agent.revokedAt || Boolean(agent.pausedAt) === paused) return false;
  if (paused) {
    agent.pausedAt = iso(time);
    for (const job of workspace.jobs)
      if (active(job) && (job.requesterId === agent.id || job.providerId === agent.id))
        stopJob(workspace, job, time, 'Work stopped because an agent was paused.');
    event(workspace, time, 'agent.paused', `${agent.name} paused by ${by}.`, agent.id);
  } else {
    agent.pausedAt = null;
    event(workspace, time, 'agent.resumed', `${agent.name} resumed by ${by}.`, agent.id);
  }
  return true;
}

/** The agent's current manifest revision, or null for an agent created without a manifest. */
export async function currentManifest(
  tx: Tx,
  agent: StoredAgent,
): Promise<ResolvedAgentManifest | null> {
  if (!agent.revision) return null;
  const manifest = (
    await tx.query<{ manifest: ResolvedAgentManifest }>(
      'SELECT manifest FROM agent_manifests WHERE agent_id=$1 AND revision=$2',
      [agent.id, agent.revision],
    )
  ).rows[0]?.manifest;
  return manifest?.metadata ? manifest : null;
}

/**
 * Renames one agent and/or changes its profile visibility inside the owner's workspace transaction
 * (My agents' Rename and Make public). Rooms, mentions and messaging read the name from the
 * workspace, so they follow on their own. An agent created from a manifest gets one new manifest
 * revision with the new displayName and spec.visibility (the same revision step a manifest update
 * takes), so its Agent Card, and the Base registration file built from it, follow; metadata.name
 * stays, so the manifest still matches the agent. Visibility lives in the manifest, so without one
 * it is not changed (the caller refuses that). Returns whether anything changed: the same name and
 * visibility is a no-op.
 */
export async function updateStoredAgent(
  workspace: Workspace,
  tx: Tx,
  operatorId: string,
  agent: StoredAgent,
  manifest: ResolvedAgentManifest | null,
  changes: { name?: string; visibility?: 'private' | 'public' },
  time: number,
): Promise<boolean> {
  const name = changes.name !== undefined && changes.name !== agent.name ? changes.name : null;
  const visibility =
    manifest && changes.visibility && changes.visibility !== manifest.spec.visibility
      ? changes.visibility
      : null;
  // The stored copy mirrors the manifest, also for agents created before it was remembered.
  const current = manifest?.spec.visibility;
  if (current === 'private' || current === 'public') agent.visibility = current;
  if (name === null && visibility === null) return false;
  const previous = agent.name;
  if (name !== null) agent.name = name;
  if (manifest) {
    const next = {
      ...manifest,
      metadata: { ...manifest.metadata, displayName: agent.name },
      spec: visibility ? { ...manifest.spec, visibility } : manifest.spec,
    };
    agent.manifestHash = hashManifest(next);
    agent.revision = (agent.revision ?? 1) + 1;
    await tx.query(
      'INSERT INTO agent_manifests(agent_id,revision,manifest_hash,manifest,created_at,operator_id) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
      [agent.id, agent.revision, agent.manifestHash, JSON.stringify(next), time, operatorId],
    );
  }
  if (name !== null)
    event(workspace, time, 'agent.renamed', `Renamed ${previous} to ${name}.`, agent.id);
  if (visibility !== null) {
    agent.visibility = visibility;
    event(workspace, time, 'agent.visibility', `${agent.name} is now ${visibility}.`, agent.id);
  }
  return true;
}

/**
 * Revokes one agent inside the owner's workspace transaction: its runtime credential and any
 * pending enrollment codes are deleted and its active work is stopped. Idempotent.
 */
export async function revokeStoredAgent(
  workspace: Workspace,
  tx: Tx,
  operatorId: string,
  agent: StoredAgent,
  time: number,
  message = `${agent.name} revoked.`,
): Promise<boolean> {
  await closeAgentChat(tx, operatorId, agent.id, time);
  if (agent.revokedAt) return false;
  agent.revokedAt = iso(time);
  agent.announcedOnline = false;
  delete agent.credentialHint;
  await tx.query('DELETE FROM credentials WHERE agent_id=$1 AND operator_id=$2', [
    agent.id,
    operatorId,
  ]);
  await tx.query('DELETE FROM runtime_enrollments WHERE agent_id=$1', [agent.id]);
  // Its cross-workspace connections and pending requests end with it (docs/AI_WORKSPACES.md);
  // work it requested in other workspaces then stops on their next read.
  await revokeAgentCrossConnections(tx, operatorId, agent.id, time);
  // Its published results are revoked (content erased) in the same transaction.
  await revokeAgentResults(tx, operatorId, agent.id, time);
  // Its stored responder key is deleted and auto-reply turned off (data minimization).
  await revokeResponderCredentials(
    tx,
    { ownerId: operatorId, agentIds: [agent.id] },
    time,
    'agent revoked',
  );
  for (const job of workspace.jobs)
    if (job.requesterId === agent.id || job.providerId === agent.id)
      stopJob(workspace, job, time, 'Work stopped because an agent was revoked.');
  event(workspace, time, 'agent.revoked', message, agent.id);
  return true;
}

/**
 * Replaces an external agent's runtime credential (owner rotation or runtime enrollment) in the
 * same transaction as presence reset, replay-nonce cleanup and cancellation of its active work.
 * Returns the new one-time credential; only its hash is stored.
 */
export async function issueRuntimeCredential(
  workspace: Workspace,
  tx: Tx,
  operatorId: string,
  agent: StoredAgent,
  time: number,
  reason: 'rotated' | 'enrolled',
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  // The legacy table permits exactly one credential per stable agent identity.
  await tx.query('DELETE FROM credentials WHERE agent_id=$1 AND operator_id=$2', [
    agent.id,
    operatorId,
  ]);
  await tx.query('INSERT INTO credentials(token_hash,operator_id,agent_id) VALUES($1,$2,$3)', [
    sha(token),
    operatorId,
    agent.id,
  ]);
  // The owner's masked hint (ownerAgent); the token itself is never stored.
  agent.credentialHint = token.slice(-4);
  await tx.query('DELETE FROM replay_nonces WHERE agent_id=$1', [agent.id]);
  await resetPresence(tx, agent.id);
  agent.lastSeenAt = null;
  agent.lastSequence = -1;
  agent.announcedOnline = false;
  for (const job of workspace.jobs) {
    if (active(job) && (job.requesterId === agent.id || job.providerId === agent.id)) {
      stopJob(
        workspace,
        job,
        time,
        reason === 'rotated'
          ? 'Work stopped because an agent credential was rotated.'
          : 'Work stopped because the agent runtime enrolled a new credential.',
      );
      job.leaseHash = null;
    }
  }
  if (reason === 'rotated')
    event(
      workspace,
      time,
      'agent.credential_rotated',
      `${agent.name} runtime credential replaced. Reconnect with the new credential.`,
      agent.id,
    );
  else
    event(
      workspace,
      time,
      'agent.enrolled',
      `${agent.name} runtime enrolled with a single-use code and received its credential.`,
      agent.id,
    );
  return token;
}
