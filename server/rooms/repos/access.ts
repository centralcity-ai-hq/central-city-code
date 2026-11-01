import { withoutElricAgents } from '../private.js';
import type { Database, Transaction as Tx } from '../../database.js';
import type { Workspace } from '../../model.js';
import { roomNotFound, type RoomPrincipal } from '../service.js';
import { TaskError } from '../tasks-service.js';
import { REPO_LIMITS } from './contract.js';
import { GitHubError, type GitHubApp, type RepoSession, type TokenPermissions } from './github.js';

/**
 * Shared authority and GitHub-session helpers for the room repo services (
 * docs/ROOM_REPOS.md "Authority and failure modes"). Authority comes from the credential and room
 * membership only, never from repository or room content.
 */

/** Failures carry machine-readable details over MCP through the TaskError channel. */
export class RepoError extends TaskError {}
export const refuse = (status: number, code: string, message: string, details?: unknown): never => {
  throw new RepoError(status, code, message, details);
};
export const HOUR = 3_600_000;

/**
 * SQL boolean: the review author (`<reviews>.author_agent_id`) is still a live member agent of the
 * proposal's room: not removed, and not revoked in its owner's workspace. A removed or revoked
 * reviewer's approvals stop counting.
 */
export const LIVE_REVIEWER_SQL = (reviews: string, roomId: string) => `EXISTS (
  SELECT 1 FROM room_members m JOIN workspaces w ON w.operator_id = m.owner_id
   WHERE m.room_id = ${roomId} AND m.agent_id = ${reviews}.author_agent_id AND m.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.data->'agents') a
                  WHERE a->>'id' = m.agent_id AND (a->>'revokedAt') IS NULL))`;

export interface RepoDependencies {
  db: Database;
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  /** null when the App is not configured (no id or key): tools answer 503. */
  github: GitHubApp | null;
  /** installation id → the owner allowed to bind through it. */
  installationOwners: ReadonlyMap<number, string>;
}

export interface RoomRow {
  id: string;
  slug: string;
  host_owner_id: string;
  closed_at: string | number | null;
}
export interface MemberRow {
  agent_id: string;
  role: 'host' | 'member' | 'guest';
  owner_label: string;
  /** Migration 273; null on rows from before it. */
  owner_kind: string | null;
}
export interface BindingRow {
  room_id: string;
  installation_id: string | number;
  repo_id: string | number;
  repo_full_name: string;
  default_branch: string;
  private: boolean;
  bound_at: string | number;
  status: 'active' | 'revoked';
}

/** Maps a GitHub failure to a room error; the GitHub body never reaches the caller. */
export function fromGitHub(error: unknown, notFound: () => never): never {
  if (!(error instanceof GitHubError)) throw error;
  if (error.code === 'not_found') return notFound();
  if (error.code === 'rate_limited')
    return refuse(429, 'rate_limited', 'GitHub is rate limiting this repository; try again later.');
  if (error.code === 'too_large')
    return refuse(413, 'file_too_large', 'That item is too large to read through the room.');
  return refuse(502, 'github_unavailable', 'GitHub could not be reached; try again later.');
}

/** The UTF-8 text of `bytes`, or null when it is binary (NUL byte or invalid UTF-8). */
export function textOf(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function createRepoAccess(d: RepoDependencies) {
  async function findRoom(q: Pick<Tx, 'query'>, ref: string) {
    return (
      await q.query<RoomRow>(
        // A private Elric chat never has repo code (rooms/private.ts): the uniform 404 for all.
        'SELECT id,slug,host_owner_id,closed_at FROM rooms WHERE (id=$1 OR slug=$1) AND NOT elric_private',
        [ref],
      )
    ).rows[0];
  }

  /** The caller's live member agents in the room (`404 room_not_found` when none). */
  async function membership(q: Pick<Tx, 'query'>, roomRef: string, operatorId: string) {
    const room = await findRoom(q, roomRef);
    if (!room) return roomNotFound();
    const data = (
      await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0]?.data;
    if (!data) refuse(401, 'unauthorized', 'Sign in to continue.');
    const agents = new Map(
      data!.agents.filter((agent) => !agent.revokedAt).map((agent) => [agent.id, agent]),
    );
    const members = (
      await q.query<MemberRow>(
        "SELECT agent_id,role,owner_label,owner_kind FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL AND kind='agent'",
        [room.id, operatorId],
      )
    ).rows.filter((row) => agents.has(row.agent_id));
    // Elric never acts in room code, and nobody acts as an agent that is or was an Elric.
    const acting = await withoutElricAgents(q, members, false);
    if (!acting.length) return roomNotFound();
    return { room, members: acting, agents, workspace: data! };
  }

  function actingAgent(members: MemberRow[], agentId: string | undefined): MemberRow {
    if (agentId !== undefined) {
      const member = members.find((row) => row.agent_id === agentId);
      return member ?? refuse(403, 'not_a_member', 'That agent is not a member of this room.');
    }
    if (members.length === 1) return members[0]!;
    return refuse(
      400,
      'agent_required',
      'You have several agents in this room; pass agent_id to choose.',
    );
  }

  /** Writes (propose, review) need a posting member in an open room. */
  function writeGuards(room: RoomRow, member: MemberRow) {
    if (room.closed_at !== null) refuse(409, 'room_closed', 'The room is closed.');
    if (member.role === 'guest')
      refuse(403, 'read_only', 'Guests can read but not propose or review.');
  }

  function hostOnly(room: RoomRow, p: RoomPrincipal, message: string) {
    if (room.host_owner_id !== p.operatorId) refuse(403, 'host_only', message);
  }

  async function activeBinding(q: Pick<Tx, 'query'>, roomId: string) {
    return (
      await q.query<BindingRow>(
        "SELECT * FROM room_repo_bindings WHERE room_id=$1 AND status='active'",
        [roomId],
      )
    ).rows[0];
  }

  async function requireBinding(q: Pick<Tx, 'query'>, roomId: string): Promise<BindingRow> {
    return (
      (await activeBinding(q, roomId)) ??
      refuse(404, 'repo_not_bound', 'This room has no connected repository.')
    );
  }

  function github(): GitHubApp {
    return (
      d.github ??
      refuse(503, 'repos_not_configured', 'Repository access is not configured on this server.')
    );
  }

  /**
   * A repo-scoped session for a binding with exactly `permissions`. A lost installation, or an
   * installation no longer mapped to the room's host in the allowlist, is `repo_access_lost`
   * (checked before any token is minted).
   */
  async function session(
    binding: BindingRow,
    hostOwnerId: string,
    permissions: TokenPermissions,
  ): Promise<RepoSession> {
    const app = github();
    if (d.installationOwners.get(Number(binding.installation_id)) !== hostOwnerId)
      refuse(
        409,
        'repo_access_lost',
        'The repository connection is no longer allowed for this room host; the host can connect it again.',
      );
    try {
      return await app.session(
        Number(binding.installation_id),
        { id: Number(binding.repo_id) },
        binding.repo_full_name,
        permissions,
      );
    } catch (error) {
      if (
        error instanceof GitHubError &&
        (error.code === 'not_found' || error.code === 'unprocessable' || error.code === 'forbidden')
      )
        return refuse(
          409,
          'repo_access_lost',
          'The Central City Rooms App no longer covers this repository; the host can connect it again.',
        );
      return fromGitHub(error, () =>
        refuse(409, 'repo_access_lost', 'The repository is no longer available.'),
      );
    }
  }

  /** Recheck after GitHub calls: still a member, and the same repository is still bound. */
  async function recheck(
    q: Pick<Tx, 'query'>,
    roomId: string,
    operatorId: string,
    repoId: unknown,
  ) {
    const found = await membership(q, roomId, operatorId);
    const still = await activeBinding(q, roomId);
    if (!still || String(still.repo_id) !== String(repoId))
      refuse(404, 'repo_not_bound', 'This room has no connected repository.');
    return { ...found, binding: still! };
  }

  /** Repo reads: the caller's own share first, then the room's (both charged before GitHub). */
  async function chargeRead(roomId: string, operatorId: string, calls = 1) {
    for (let i = 0; i < calls; i++) {
      await d.limit(
        `room-repo-read-owner:${roomId}:${operatorId}`,
        REPO_LIMITS.readsPerOwnerPerRoomPerHour,
        HOUR,
      );
      await d.limit(`room-repo-read:${roomId}`, REPO_LIMITS.readsPerRoomPerHour, HOUR);
    }
  }

  return {
    chargeRead,
    findRoom,
    membership,
    actingAgent,
    writeGuards,
    hostOnly,
    activeBinding,
    requireBinding,
    github,
    session,
    recheck,
  };
}
export type RepoAccess = ReturnType<typeof createRepoAccess>;
