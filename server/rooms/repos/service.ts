import { randomUUID } from 'node:crypto';
import { iso } from '../../model.js';
import type { RoomPrincipal } from '../service.js';
import {
  HOUR,
  createRepoAccess,
  fromGitHub,
  refuse,
  textOf,
  type BindingRow,
  type RepoDependencies,
  type RoomRow,
} from './access.js';
import {
  REPO_LIMITS,
  UNTRUSTED_REPO_NOTICE,
  repoBindInput,
  repoPreviewInput,
  bindNotice,
  repoGetInput,
  repoReadInput,
  repoUnbindInput,
  type BindingView,
} from './contract.js';
import { READ_PERMISSIONS, type TreeEntry } from './github.js';
import { createRoomProposals, type RoomProposals } from './proposals.js';
import { createRoomApply, type RoomApply } from './apply.js';

/**
 * Room repos service (docs/ROOM_REPOS.md): bind a room to one GitHub repository and let members read it.
 *
 * - **Authority** comes from the credential and room membership only, never from repository or
 *   room content. Unknown rooms and non-members share `404 room_not_found`.
 * - **Binding** is host-only (the room's host owner), needs the explicit member-read
 *   acknowledgement, and works only through an installation the deployment maps to that owner
 *   (`CITY_GITHUB_INSTALLATION_OWNERS`). It is audited as `repo.bound` / `repo.unbound`.
 * - **Pool rule:** no database client is held during a GitHub call. Each operation checks in a
 *   short transaction, calls GitHub, then rechecks (a concurrent unbind wins; reads stop at once).
 * - **Tokens:** one installation token per operation, scoped to the bound repository with read
 *   permissions for reads; never stored.
 */

export { RepoError } from './access.js';
export type RoomReposDependencies = RepoDependencies;

export interface RoomRepos extends RoomProposals, RoomApply {
  repo(p: RoomPrincipal, body: unknown): Promise<unknown>;
  read(p: RoomPrincipal, body: unknown): Promise<unknown>;
  /** Console only: what the host is about to confirm (repository, private flag, notice). */
  preview(p: RoomPrincipal, body: unknown): Promise<unknown>;
  bind(p: RoomPrincipal, body: unknown): Promise<unknown>;
  unbind(p: RoomPrincipal, body: unknown): Promise<unknown>;
}

const view = (row: BindingRow): BindingView => ({
  repo: row.repo_full_name,
  default_branch: row.default_branch,
  private: Boolean(row.private),
  bound_at: iso(Number(row.bound_at)),
});

/** Largest end ≤ `limit` that does not split a UTF-8 sequence. */
function charBoundary(bytes: Buffer, limit: number): number {
  let end = Math.min(limit, bytes.length);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

const entryType = (entry: TreeEntry): 'file' | 'dir' | 'submodule' | 'symlink' =>
  entry.type === 'tree'
    ? 'dir'
    : entry.type === 'commit'
      ? 'submodule'
      : entry.mode === '120000'
        ? 'symlink'
        : 'file';

export function createRoomRepos(d: RoomReposDependencies): RoomRepos {
  const {
    membership,
    actingAgent,
    activeBinding,
    requireBinding,
    github,
    session,
    recheck,
    chargeRead,
  } = createRepoAccess(d);
  const readSession = (binding: BindingRow, hostOwnerId: string) =>
    session(binding, hostOwnerId, READ_PERMISSIONS);
  const access = createRepoAccess(d);
  const hostOnly = (room: RoomRow, p: RoomPrincipal) =>
    access.hostOnly(room, p, 'Only the room host can connect or disconnect a repository.');

  async function repo(p: RoomPrincipal, body: unknown) {
    const input = repoGetInput.parse(body);
    const { room, binding } = await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const { room } = await membership(tx, input.room_id, p.operatorId);
      return { room, binding: await activeBinding(tx, room.id) };
    });
    let head: string | null = null;
    if (binding && d.github) {
      await chargeRead(room.id, p.operatorId);
      try {
        head = (
          await (await readSession(binding, room.host_owner_id)).commit(binding.default_branch)
        ).sha;
      } catch {
        head = null; // informational; the binding is still shown
      }
    }
    return {
      room_id: room.id,
      binding: binding ? view(binding) : null,
      head_sha: head,
      // Only the host opens pull requests for now (per-member `can_apply` comes later).
      can_apply: room.host_owner_id === p.operatorId && !!binding,
    };
  }

  async function read(p: RoomPrincipal, body: unknown) {
    const input = repoReadInput.parse(body);
    const { room, binding } = await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const { room } = await membership(tx, input.room_id, p.operatorId);
      const binding = await activeBinding(tx, room.id);
      if (!binding) refuse(404, 'repo_not_bound', 'This room has no connected repository.');
      return { room, binding: binding! };
    });
    await chargeRead(room.id, p.operatorId);
    const session = await readSession(binding, room.host_owner_id);
    const ref = input.ref ?? binding.default_branch;
    const path = input.path ?? '';
    const commit = await session
      .commit(ref)
      .catch((error) =>
        fromGitHub(error, () =>
          refuse(404, 'ref_not_found', 'That branch, tag or commit was not found.'),
        ),
      );
    const missing = () => refuse(404, 'path_not_found', 'That path does not exist at this ref.');
    const found = await session
      .contents(path, commit.sha)
      .catch((error) => fromGitHub(error, missing));
    const base = {
      notice: UNTRUSTED_REPO_NOTICE,
      repo: binding.repo_full_name,
      ref,
      commit: commit.sha,
      path,
    };
    let result: Record<string, unknown>;
    if (found.kind === 'dir') {
      let entries = found.entries;
      let truncated = false;
      if (input.recursive) {
        const tree = await session
          .tree(commit.tree_sha, true)
          .catch((error) => fromGitHub(error, missing));
        const prefix = path ? `${path}/` : '';
        entries = tree.entries.filter((entry) => entry.path.startsWith(prefix));
        truncated = tree.truncated;
      }
      if (entries.length > REPO_LIMITS.treeEntries) {
        entries = entries.slice(0, REPO_LIMITS.treeEntries);
        truncated = true;
      }
      result = {
        ...base,
        kind: 'dir',
        entries: entries.map((entry) => ({
          path: entry.path,
          type: entryType(entry),
          ...(entry.size !== undefined && entryType(entry) === 'file' ? { size: entry.size } : {}),
          sha: entry.sha,
        })),
        truncated,
      };
    } else if (found.kind === 'other' || found.path !== path) {
      // GitHub's contents API follows a symlink to a regular file and answers with the target's
      // path: a different path means the requested one is a symlink.
      return refuse(
        422,
        'unsupported_entry',
        'That path is a symlink or submodule; only files and directories can be read.',
      );
    } else {
      if (found.size > REPO_LIMITS.fileBytes)
        refuse(
          413,
          'file_too_large',
          'That file is larger than 1 MB and cannot be read through the room.',
          {
            size: found.size,
            limit: REPO_LIMITS.fileBytes,
          },
        );
      const bytes =
        found.bytes ?? (await session.blob(found.sha).catch((error) => fromGitHub(error, missing)));
      if (bytes.length > REPO_LIMITS.fileBytes)
        refuse(
          413,
          'file_too_large',
          'That file is larger than 1 MB and cannot be read through the room.',
        );
      const text = textOf(bytes);
      const offset = input.offset ?? 0;
      if (text === null) {
        result = { ...base, kind: 'file', blob_sha: found.sha, size: bytes.length, binary: true };
      } else {
        if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80))
          refuse(400, 'invalid_offset', 'Use offset 0 or next_offset from the previous page.');
        const end = charBoundary(bytes, offset + REPO_LIMITS.pageBytes);
        result = {
          ...base,
          kind: 'file',
          blob_sha: found.sha,
          size: bytes.length,
          binary: false,
          content: bytes.subarray(offset, end).toString('utf8'),
          offset,
          next_offset: end < bytes.length ? end : null,
        };
      }
    }
    // Recheck after the GitHub calls: an unbind or removal during the read wins.
    await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      await membership(tx, room.id, p.operatorId);
      const still = await activeBinding(tx, room.id);
      if (!still || String(still.repo_id) !== String(binding.repo_id))
        refuse(404, 'repo_not_bound', 'This room has no connected repository.');
    });
    return result;
  }

  /**
   * Binding is a human decision in the signed-in console (docs/ROOM_REPOS.md): the console route marks its principal `console: true`, and no other caller (MCP,
   * workspace keys, grants) ever sets it.
   */
  function consoleOnly(p: RoomPrincipal) {
    if (p.console !== true)
      refuse(
        403,
        'console_only',
        'Connecting or disconnecting a repository is done by the room host in the Central City console.',
      );
  }

  /** Host checks, budgets and the GitHub lookup shared by preview and bind. */
  async function lookup(
    p: RoomPrincipal,
    roomRef: string,
    agentId: string | undefined,
    repo: string,
  ) {
    consoleOnly(p);
    const app = github();
    const pre = await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const { room, members } = await membership(tx, roomRef, p.operatorId);
      actingAgent(members, agentId);
      hostOnly(room, p);
      if (room.closed_at !== null) refuse(409, 'room_closed', 'The room is closed.');
      if (await activeBinding(tx, room.id))
        refuse(
          409,
          'repo_already_bound',
          'This room already has a repository; disconnect it first.',
        );
      return room;
    });
    await d.limit(`room-repo-bind:${pre.id}`, REPO_LIMITS.bindsPerRoomPerHour, HOUR);
    await d.limit(`room-repo-bind-owner:${p.operatorId}`, REPO_LIMITS.bindsPerOwnerPerHour, HOUR);
    const unavailable = () =>
      refuse(
        404,
        'repo_not_available',
        'The Central City Rooms GitHub App does not cover that repository for you.',
      );
    const installation = await app
      .installationFor(repo)
      .catch((error) => fromGitHub(error, unavailable));
    if (d.installationOwners.get(installation.id) !== p.operatorId) unavailable();
    const name = repo.split('/')[1]!;
    const info = await app
      .session(installation.id, { name }, repo, READ_PERMISSIONS)
      .then((session) => session.repo())
      .catch((error) => fromGitHub(error, unavailable));
    if (info.full_name.toLowerCase() !== repo.toLowerCase()) unavailable();
    return { pre, installation, info };
  }

  /** What the host is about to confirm: the repository, whether it is private, and the notice. */
  async function preview(p: RoomPrincipal, body: unknown) {
    const input = repoPreviewInput.parse(body);
    const { pre, info } = await lookup(p, input.room_id, input.agent_id, input.repo);
    return {
      room_id: pre.id,
      repo: info.full_name,
      default_branch: info.default_branch,
      private: info.private,
      notice: bindNotice(info.full_name, info.private),
      confirm_repo: info.full_name,
    };
  }

  async function bind(p: RoomPrincipal, body: unknown) {
    const input = repoBindInput.parse(body);
    consoleOnly(p);
    if (input.confirm_repo.trim().toLowerCase() !== input.repo.toLowerCase())
      refuse(
        400,
        'confirmation_mismatch',
        'Type the repository name (owner/name) exactly to confirm the connection.',
      );
    const { pre, installation, info } = await lookup(p, input.room_id, input.agent_id, input.repo);
    const time = d.clock();
    return d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const { room, members } = await membership(tx, pre.id, p.operatorId);
      const member = actingAgent(members, input.agent_id);
      hostOnly(room, p);
      if (room.closed_at !== null) refuse(409, 'room_closed', 'The room is closed.');
      await tx.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      await tx.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_login,created_at)
          VALUES($1,$2,$3,$4)
          ON CONFLICT (installation_id) DO UPDATE
            SET owner_id=EXCLUDED.owner_id, account_login=EXCLUDED.account_login, revoked_at=NULL`,
        [installation.id, p.operatorId, installation.account_login, time],
      );
      const row = (
        await tx.query<BindingRow>(
          `INSERT INTO room_repo_bindings
             (room_id,installation_id,repo_id,repo_full_name,default_branch,private,bound_by,bound_at,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')
           ON CONFLICT (room_id) DO UPDATE SET
             installation_id=EXCLUDED.installation_id, repo_id=EXCLUDED.repo_id,
             repo_full_name=EXCLUDED.repo_full_name, default_branch=EXCLUDED.default_branch,
             private=EXCLUDED.private, bound_by=EXCLUDED.bound_by, bound_at=EXCLUDED.bound_at,
             unbound_at=NULL, unbound_by=NULL, status='active'
           WHERE room_repo_bindings.status='revoked'
           RETURNING *`,
          [
            room.id,
            installation.id,
            info.id,
            info.full_name,
            info.default_branch,
            info.private,
            p.actor,
            time,
          ],
        )
      ).rows[0];
      if (!row)
        refuse(
          409,
          'repo_already_bound',
          'This room already has a repository; disconnect it first.',
        );
      await tx.query(
        'INSERT INTO room_events(id,room_id,actor_owner_id,actor,action,agent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), room.id, p.operatorId, p.actor, 'repo.bound', member.agent_id, time],
      );
      return { room_id: room.id, binding: view(row!), replaced: false as const };
    });
  }

  async function unbind(p: RoomPrincipal, body: unknown) {
    const input = repoUnbindInput.parse(body);
    consoleOnly(p);
    const time = d.clock();
    return d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const { room, members } = await membership(tx, input.room_id, p.operatorId);
      const member = actingAgent(members, input.agent_id);
      hostOnly(room, p);
      const changed = (
        await tx.query<{ room_id: string }>(
          `UPDATE room_repo_bindings SET status='revoked', unbound_at=$2, unbound_by=$3
            WHERE room_id=$1 AND status='active' RETURNING room_id`,
          [room.id, time, p.actor],
        )
      ).rows.length;
      if (changed)
        await tx.query(
          'INSERT INTO room_events(id,room_id,actor_owner_id,actor,action,agent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), room.id, p.operatorId, p.actor, 'repo.unbound', member.agent_id, time],
        );
      return { room_id: room.id, unbound: changed > 0 };
    });
  }

  return { repo, read, preview, bind, unbind, ...createRoomProposals(d), ...createRoomApply(d) };
}
