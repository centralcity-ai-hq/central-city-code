import { randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../../database.js';
import { iso } from '../../model.js';
import type { RoomPrincipal } from '../service.js';
import {
  HOUR,
  createRepoAccess,
  fromGitHub,
  refuse,
  type BindingRow,
  type RepoDependencies,
  type RoomRow,
  LIVE_REVIEWER_SQL,
} from './access.js';
import { APPLY_LIMITS, applyInput, evidenceInput, type EVIDENCE_STATES } from './apply-contract.js';
import { UNTRUSTED_REPO_NOTICE } from './contract.js';
import { parseDiff } from './diff.js';
import {
  GitHubError,
  READ_PERMISSIONS,
  type CheckResult,
  type PullInfo,
  type RepoSession,
  type TokenPermissions,
} from './github.js';
import { postObjectMessage } from './message.js';
import { OWNER_GROUP_SQL, applyToBase, requireOnDefaultBranch, resolvePaths } from './proposals.js';
import { agentsArraySql } from '../../agent-rows/sql.js';

/**
 * Apply and check evidence (docs/ROOM_REPOS.md "Apply and evidence").
 *
 * **Apply** turns one approved proposal revision into a branch and a **draft** pull request on the
 * bound repository:
 * - only the room host applies in this version (the tool also needs the `rooms:apply` scope);
 * - the current revision needs approvals from at least `min_approvals` (default 1) distinct owners,
 *   none of them the proposing agent's owner (another agent of the proposer's own owner is not an
 *   independent reviewer, and several agents of one owner count once). Owners linked by
 *   co-ownership (`operator_links`) are one owner. `expected_revision` is compare-and-set;
 * - the default branch head is re-read at apply time: if any touched file changed since the base,
 *   the proposal becomes `out_of_date` and nothing is created (`409 proposal_out_of_date`);
 * - the commit is built with the Git Data API on the current default branch head (its parent and
 *   tree), with only the touched files replaced by the stored diff re-applied exactly to them
 *   (identical at the base and the head, checked above). Every other file is the head's, so
 *   nothing main removed or changed since the base comes back. The only ref ever created is
 *   `refs/heads/cc/<room-slug>/p<n>-r<rev>` (github.ts guard). Nothing pushes to the default
 *   branch, force-updates or merges;
 * - PR and commit text are built by the server; room text is quoted, and `@` is escaped so the
 *   room cannot mention GitHub users;
 * - idempotent: an already-applied revision returns its branch and PR (`already_applied`), and a
 *   concurrent apply reuses the existing branch and PR.
 *
 * **Evidence** reads the check runs and commit statuses of the PR's head commit from GitHub
 * (never from room text). Only `required_passed` on the exact commit that apply created counts
 * as validated; failed or pending results are evidence, not validation.
 */
const WRITE_PERMISSIONS: TokenPermissions = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
};
const EVIDENCE_PERMISSIONS: TokenPermissions = {
  checks: 'read',
  statuses: 'read',
  pull_requests: 'read',
  metadata: 'read',
};
const PASSING = new Set(['success', 'neutral', 'skipped']);

interface ProposalRow {
  id: string;
  room_id: string;
  number: number;
  base: { commit: string; blobs: Record<string, string | null>; repo_id?: number };
  diff: string;
  files: string[];
  summary: string;
  revision: number;
  author_agent_id: string;
  author_owner_id: string;
  task_id: string | null;
  status: string;
  applied: Applied | null;
}
interface Applied {
  branch: string;
  pr_number: number;
  pr_url: string;
  head_sha: string;
  revision: number;
}
type EvidenceState = (typeof EVIDENCE_STATES)[number];

export interface RoomApply {
  apply(p: RoomPrincipal, body: unknown): Promise<unknown>;
  evidence(p: RoomPrincipal, body: unknown): Promise<unknown>;
}

/**
 * One line of untrusted room text for commit and PR text: no controls, no @-mentions, no issue
 * cross-references, capped.
 */
export function quoteLine(value: string, max: number = APPLY_LIMITS.trailerChars): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return (
    (line.length > max ? `${line.slice(0, max - 1)}…` : line)
      // No @-mentions, and no #123 / owner/repo#123 / GH-123 cross-references from room text.
      .replace(/@/g, '@\u200b')
      .replace(/#(?=\d)/g, '#\u200b')
      .replace(/\b(GH)-(?=\d)/gi, '$1-\u200b')
  );
}

/**
 * Evaluates check results: per name, any failure fails, else anything pending is pending, else
 * it passed. With named required checks, a missing one is pending. With none named (NULL),
 * every reported check is required, and no checks at all is only `retrieved`.
 */
export function evaluateChecks(
  checks: CheckResult[],
  required: string[] | null,
): { state: EvidenceState; required: string[] } {
  const byName = new Map<string, 'passed' | 'failed' | 'pending'>();
  for (const check of checks) {
    const verdict =
      check.status !== 'completed'
        ? 'pending'
        : check.conclusion && PASSING.has(check.conclusion)
          ? 'passed'
          : 'failed';
    const prior = byName.get(check.name);
    if (prior === 'failed') continue;
    if (
      verdict === 'failed' ||
      prior === undefined ||
      (prior === 'passed' && verdict === 'pending')
    )
      byName.set(check.name, verdict);
  }
  const names = required ?? [...byName.keys()].sort();
  if (!names.length) return { state: 'retrieved', required: [] };
  const verdicts = names.map((name) => byName.get(name) ?? 'pending');
  const state = verdicts.includes('failed')
    ? 'required_failed'
    : verdicts.includes('pending')
      ? 'required_pending'
      : 'required_passed';
  return { state, required: names };
}

export function createRoomApply(d: RepoDependencies): RoomApply {
  const access = createRepoAccess(d);

  async function findProposal(
    q: Pick<Tx, 'query'>,
    roomId: string,
    ref: string | number,
    lock = false,
  ) {
    const row = (
      await q.query<ProposalRow>(
        `SELECT * FROM room_proposals WHERE room_id=$1 AND ${typeof ref === 'number' ? 'number=$2' : 'id=$2'}${lock ? ' FOR UPDATE' : ''}`,
        [roomId, ref],
      )
    ).rows[0];
    return row ?? refuse(404, 'proposal_not_found', 'No such proposal in this room.');
  }

  async function settings(q: Pick<Tx, 'query'>, roomId: string) {
    const row = (
      await q.query<{ required_checks: string[] | null; min_approvals: number }>(
        'SELECT required_checks,min_approvals FROM room_code_settings WHERE room_id=$1',
        [roomId],
      )
    ).rows[0];
    return {
      required: row?.required_checks ?? null,
      minApprovals: Number(row?.min_approvals ?? 1),
    };
  }

  /**
   * Approvals on the current revision that count: one per distinct owner group other than the
   * proposing agent's (OWNER_GROUP_SQL: operators joined by co-ownership links are one owner), from
   * live member agents, never the proposing agent. Each group's earliest approval by insertion
   * order (the review's room message seq, as in proposals.ts countedApprovals) is named.
   */
  async function approvers(q: Pick<Tx, 'query'>, row: ProposalRow) {
    return (
      await q.query<{ author_agent_id: string }>(
        `SELECT author_agent_id FROM (
           SELECT DISTINCT ON (x.owner_group) x.author_agent_id, x.message_seq, x.created_at, x.id
             FROM (SELECT r.author_agent_id, r.message_seq, r.created_at, r.id,
                          ${OWNER_GROUP_SQL('r.author_owner_id')} AS owner_group
                     FROM room_reviews r
                    WHERE r.proposal_id=$1 AND r.proposal_revision=$2 AND r.verdict='approve'
                      AND r.author_agent_id<>$3 AND r.author_owner_id<>$5
                      AND ${LIVE_REVIEWER_SQL('r', '$4')}) x
            WHERE x.owner_group <> ${OWNER_GROUP_SQL('$5')}
            ORDER BY x.owner_group, x.message_seq, x.created_at, x.id) AS counted
          ORDER BY message_seq, created_at, id`,
        [row.id, row.revision, row.author_agent_id, row.room_id, row.author_owner_id],
      )
    ).rows.map((item) => item.author_agent_id);
  }

  /** Checks shared by the pre-check and the final transaction. */
  async function gate(
    tx: Pick<Tx, 'query'>,
    p: RoomPrincipal,
    roomRef: string,
    agentId: string | undefined,
    proposalRef: string | number,
    expected: number,
    lock: boolean,
  ) {
    const found = await access.membership(tx, roomRef, p.operatorId);
    const member = access.actingAgent(found.members, agentId);
    access.writeGuards(found.room, member);
    access.hostOnly(found.room, p, 'Only the room host can open pull requests.');
    if (lock) await tx.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [found.room.id]);
    const binding = await access.requireBinding(tx, found.room.id);
    const row = await findProposal(tx, found.room.id, proposalRef, lock);
    sameRepo(row, binding);
    return { ...found, member, binding, row };
  }

  /** A proposal is applied only to the repository it was validated against (no rebind drift). */
  function sameRepo(row: ProposalRow, binding: BindingRow) {
    if (row.base.repo_id !== undefined && Number(row.base.repo_id) !== Number(binding.repo_id))
      refuse(
        409,
        'repo_changed',
        `P${row.number} was proposed for another repository than the one now connected.`,
      );
  }

  /** The current revision already has its pull request (whatever happened to it since). */
  function alreadyApplied(row: ProposalRow) {
    return !!row.applied && Number(row.applied.revision) === Number(row.revision);
  }

  async function apply(p: RoomPrincipal, body: unknown) {
    const input = applyInput.parse(body);
    const pre = await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const g = await gate(
        tx,
        p,
        input.room_id,
        input.agent_id,
        input.proposal,
        input.expected_revision,
        false,
      );
      if (alreadyApplied(g.row)) return { done: g.row as ProposalRow, g: null, approved: [] };
      if (g.row.status !== 'open')
        refuse(
          409,
          g.row.status === 'out_of_date' ? 'proposal_out_of_date' : 'proposal_not_open',
          `P${g.row.number} is ${g.row.status.replace('_', ' ')}.`,
          { status: g.row.status },
        );
      if (Number(g.row.revision) !== input.expected_revision)
        refuse(409, 'revision_changed', `P${g.row.number} is now at revision ${g.row.revision}.`, {
          current_revision: Number(g.row.revision),
        });
      const { minApprovals } = await settings(tx, g.room.id);
      const approved = await approvers(tx, g.row);
      if (approved.length < minApprovals)
        refuse(
          409,
          'approval_required',
          `P${g.row.number} revision ${g.row.revision} needs approvals from ${minApprovals} different owner${minApprovals === 1 ? '' : 's'} other than the proposer's; the proposing owner's own agents do not count, and several agents of one owner count once.`,
          { approvals: approved.length, required: minApprovals },
        );
      return { done: null, g, approved };
    });
    if (pre.done)
      return {
        proposal_id: pre.done.id,
        number: Number(pre.done.number),
        applied: pre.done.applied!,
        already_applied: true,
      };
    const { approved } = pre;
    const g = pre.g!;
    const { room, binding, row } = g;
    await d.limit(`room-repo-apply:${room.id}`, APPLY_LIMITS.appliesPerRoomPerHour, HOUR);

    // 1. Re-read the target branch head with a read-only token: out of date is never overwritten.
    const reader = await access.session(binding, room.host_owner_id, READ_PERMISSIONS);
    const unavailable = () => refuse(502, 'github_unavailable', 'GitHub could not be reached.');
    const headCommit = await reader
      .commit(binding.default_branch)
      .catch((error) => fromGitHub(error, unavailable));
    // The base must still lie on the default branch (checked at propose too): the applied branch
    // starts from the base's whole tree, so a base elsewhere would bring files nobody reviewed.
    await requireOnDefaultBranch(reader, binding.default_branch, headCommit.sha, row.base.commit);
    const atHead = await resolvePaths(reader, headCommit.tree_sha, row.files);
    const changed: string[] = [];
    for (const path of row.files) {
      const entry = atHead.get(path) ?? null;
      const blob =
        entry === null
          ? null
          : entry === 'blocked' ||
              entry.type !== 'blob' ||
              (entry.mode !== '100644' && entry.mode !== '100755')
            ? `other:${path}`
            : entry.sha;
      if (blob !== (row.base.blobs[path] ?? null)) changed.push(path);
    }
    if (changed.length) {
      await d.db.transaction((tx) =>
        tx.query(
          "UPDATE room_proposals SET status='out_of_date', updated_at=$3 WHERE id=$1 AND revision=$2 AND status='open'",
          [row.id, row.revision, d.clock()],
        ),
      );
      refuse(
        409,
        'proposal_out_of_date',
        `${changed.length} touched file${changed.length === 1 ? '' : 's'} changed on ${binding.default_branch} since the base; propose again on the new head (supersedes).`,
        { changed_files: changed, new_head: headCommit.sha },
      );
    }

    // 2. Rebuild the new file contents on the current head. The touched files are the same there
    //    as at the reviewed base (step 1), so the change is exactly the reviewed one; every other
    //    file stays as on the head, so an older base cannot bring back files main has since
    //    removed or changed (workflows, dependencies).
    const files = parseDiff(row.diff);
    const { blobs, modes, results } = await applyToBase(reader, headCommit.tree_sha, files);
    for (const path of row.files)
      if ((blobs[path] ?? null) !== (row.base.blobs[path] ?? null))
        refuse(409, 'base_changed', 'The base files no longer match the proposal.', { path });

    // 3. Names for the commit trailers and the PR body (untrusted labels, quoted).
    const names = await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const labels = (
        await tx.query<{ agent_id: string; owner_label: string; name: string | null }>(
          `SELECT m.agent_id, m.owner_label, a->>'name' AS name FROM room_members m
             JOIN workspaces w ON w.operator_id=m.owner_id
             LEFT JOIN LATERAL jsonb_array_elements(${agentsArraySql('w.operator_id', 'w.data')}) a ON a->>'id'=m.agent_id
            WHERE m.room_id=$1 AND m.agent_id = ANY($2::text[])`,
          [room.id, [row.author_agent_id, ...approved]],
        )
      ).rows;
      const task = row.task_id
        ? (
            await tx.query<{ number: number }>('SELECT number FROM room_tasks WHERE id=$1', [
              row.task_id,
            ])
          ).rows[0]?.number
        : undefined;
      return { labels: new Map(labels.map((item) => [item.agent_id, item])), task };
    });
    const nameOf = (agentId: string) => quoteLine(names.labels.get(agentId)?.name ?? 'an agent');
    const author = names.labels.get(row.author_agent_id);
    const link = `${p.origin}/r/${room.slug}/p/${row.number}`;
    const summary = quoteLine(row.summary, 300);
    const message = [
      summary,
      '',
      `Proposed-by: ${nameOf(row.author_agent_id)} (${quoteLine(author?.owner_label ?? 'owner')}) via Central City`,
      ...approved.map((agentId) => `Reviewed-by: ${nameOf(agentId)}`),
      `Central-City-Proposal: ${link}`,
    ].join('\n');
    const prBody = [
      'Opened from a Central City room. This is a draft: the repository’s own review and CI apply.',
      '',
      `Proposal: P${row.number}, revision ${row.revision} (${link})`,
      `Room: ${p.origin}/r/${room.slug}`,
      ...(names.task ? [`Task: T${names.task}`] : []),
      `Base commit (reviewed): ${row.base.commit}`,
      `Built on: ${binding.default_branch} at ${headCommit.sha}`,
      `Proposed by: ${nameOf(row.author_agent_id)}`,
      `Approved on this revision by: ${approved.map(nameOf).join(', ')}`,
      '',
      'Summary as written in the room (untrusted text, quoted):',
      '~~~text',
      summary.replace(/~~~/g, '~ ~ ~'),
      '~~~',
    ].join('\n');

    // 4. Write. Blobs and the tree are content-addressed, so building them is harmless and gives
    //    the exact tree this revision must have. An existing cc/ branch or PR is accepted only
    //    when its commit sits directly on the base with exactly that tree:
    //    anything else (a planted or pushed commit) is 409 branch_conflict, and nothing is adopted.
    await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const current = await access.requireBinding(tx, room.id);
      if (String(current.repo_id) !== String(binding.repo_id))
        refuse(
          409,
          'repo_changed',
          'The connected repository changed during apply; nothing was opened.',
        );
    });
    const writer = await access.session(binding, room.host_owner_id, WRITE_PERMISSIONS);
    const branch = `cc/${room.slug}/p${row.number}-r${row.revision}`;
    const ref = `refs/heads/${branch}`;
    const entries: { path: string; mode: '100644' | '100755'; sha: string | null }[] = [];
    for (const file of files) {
      const content = results.get(file.path)!;
      const mode = file.kind === 'add' ? file.mode! : modes[file.path];
      // applyToBase only lets regular files through; a missing mode here is a bug: fail closed.
      if (file.kind !== 'delete' && mode !== '100644' && mode !== '100755')
        refuse(409, 'base_changed', 'A touched file is not a regular file.', { path: file.path });
      entries.push({
        path: file.path,
        mode: (mode ?? '100644') as '100644' | '100755',
        sha:
          content === null
            ? null
            : await writer.createBlob(content).catch((error) => fromGitHub(error, unavailable)),
      });
    }
    const tree = await writer
      .createTree(headCommit.tree_sha, entries)
      .catch((error) => fromGitHub(error, unavailable));
    const conflict = (): never =>
      refuse(
        409,
        'branch_conflict',
        `The branch ${branch} already exists with a commit that is not this revision; nothing was opened.`,
        { branch },
      );
    const verify = async (sha: string) => {
      const found = await writer.gitCommit(sha).catch((error) => fromGitHub(error, unavailable));
      if (found.parents.length !== 1) conflict();
      const parent = found.parents[0]!;
      if (parent === headCommit.sha) {
        if (found.tree !== tree) conflict();
        return sha;
      }
      // An interrupted apply on an earlier head: adopted only while that head is still on the
      // default branch and the tree is exactly this revision's files on that head's tree.
      const { status } = await reader.compare(headCommit.sha, parent).catch(conflict);
      if (status !== 'behind') conflict();
      const earlier = await reader.commit(parent).catch(conflict);
      const expected = await writer
        .createTree(earlier.tree_sha, entries)
        .catch((error) => fromGitHub(error, unavailable));
      if (found.tree !== expected) conflict();
      return sha;
    };
    let headSha = await writer.ownRef(ref).catch((error) => fromGitHub(error, unavailable));
    if (headSha) {
      headSha = await verify(headSha);
    } else {
      const commit = await writer
        .createCommit(message, tree, headCommit.sha)
        .catch((error) => fromGitHub(error, unavailable));
      try {
        await writer.createOwnRef(ref, commit);
        headSha = commit;
      } catch (error) {
        // A concurrent apply (or anyone) created the branch first: accept it only if it verifies.
        if (!(error instanceof GitHubError && error.code === 'unprocessable'))
          fromGitHub(error, unavailable);
        const existing = await writer.ownRef(ref).catch((e) => fromGitHub(e, unavailable));
        headSha = existing ? await verify(existing) : unavailable();
      }
    }
    const adopt = (pull: PullInfo | null) => {
      if (pull && pull.head_sha !== headSha) conflict();
      return pull;
    };
    let pr: PullInfo | null = adopt(
      await writer.pullForBranch(branch).catch((error) => fromGitHub(error, unavailable)),
    );
    if (!pr) {
      try {
        pr = await writer.createDraftPull({
          title: `P${row.number}: ${summary}`.slice(0, 256),
          body: prBody,
          head: branch,
          base: binding.default_branch,
        });
      } catch (error) {
        if (!(error instanceof GitHubError && error.code === 'unprocessable'))
          fromGitHub(error, unavailable);
        pr = adopt(await writer.pullForBranch(branch).catch((e) => fromGitHub(e, unavailable)));
        if (!pr)
          refuse(422, 'pull_request_refused', 'GitHub refused the pull request for this branch.');
      }
    }
    const applied: Applied = {
      branch,
      pr_number: pr!.number,
      pr_url: pr!.url,
      head_sha: headSha!,
      revision: Number(row.revision),
    };

    // 5. Record and announce, rechecking the gate under the room lock.
    const time = d.clock();
    return d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const again = await gate(
        tx,
        p,
        room.id,
        g.member.agent_id,
        row.id,
        input.expected_revision,
        true,
      );
      if (alreadyApplied(again.row))
        return {
          proposal_id: again.row.id,
          number: Number(again.row.number),
          applied: again.row.applied!,
          already_applied: true,
        };
      if (again.row.status !== 'open' || Number(again.row.revision) !== Number(row.revision))
        refuse(
          409,
          'revision_changed',
          `P${row.number} changed while the pull request was opened.`,
          {
            current_revision: Number(again.row.revision),
            pull_request: applied.pr_url,
          },
        );
      await tx.query(
        "UPDATE room_proposals SET status='applied', applied=$2::jsonb, updated_at=$3 WHERE id=$1",
        [row.id, JSON.stringify(applied), time],
      );
      await tx.query(
        'INSERT INTO room_events(id,room_id,actor_owner_id,actor,action,agent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          room.id,
          p.operatorId,
          p.actor,
          'proposal.applied',
          again.member.agent_id,
          time,
        ],
      );
      await postObjectMessage(tx, {
        roomId: room.id,
        member: again.member,
        agent: again.agents.get(again.member.agent_id)!,
        workspace: again.workspace,
        ownerId: p.operatorId,
        text: [
          `**Opened draft PR #${applied.pr_number}** for P${row.number} revision ${row.revision} · ${applied.pr_url}`,
          `Branch \`${branch}\` · commit \`${applied.head_sha.slice(0, 7)}\`. The repository's CI runs there; its results are read back with city_room_evidence.`,
        ].join('\n'),
        ref: { kind: 'proposal', id: row.id, number: Number(row.number) },
        time,
      });
      return { proposal_id: row.id, number: Number(row.number), applied, already_applied: false };
    });
  }

  async function evidence(p: RoomPrincipal, body: unknown) {
    const input = evidenceInput.parse(body);
    const pre = await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      const { room } = await access.membership(tx, input.room_id, p.operatorId);
      const binding = await access.requireBinding(tx, room.id);
      const row = await findProposal(tx, room.id, input.proposal);
      if (!row.applied)
        refuse(409, 'proposal_not_applied', `P${row.number} has no pull request yet.`, {
          status: row.status,
        });
      const cached = (
        await tx.query<{
          head_sha: string;
          checks: CheckResult[];
          required: string[];
          state: EvidenceState;
          read_at: string | number;
        }>(
          `SELECT head_sha,checks,required,state,read_at FROM room_evidence
            WHERE proposal_id=$1 AND revision=$2 ORDER BY read_at DESC LIMIT 1`,
          [row.id, row.applied!.revision],
        )
      ).rows[0];
      const { required } = await settings(tx, room.id);
      return { room, binding, row, cached, required };
    });
    const { room, binding, row, required } = pre;
    const applied = row.applied!;
    const view = (
      head: string,
      checks: CheckResult[],
      state: EvidenceState,
      readAt: number,
      prState: 'open' | 'closed' | 'merged',
    ) => {
      const matches = head === applied.head_sha;
      return {
        notice: `Check results read from GitHub for commit ${head}. ${UNTRUSTED_REPO_NOTICE}`,
        proposal_id: row.id,
        number: Number(row.number),
        revision: Number(applied.revision),
        pr_number: applied.pr_number,
        pr_url: applied.pr_url,
        pr_state: prState,
        head_sha: head,
        applied_head_sha: applied.head_sha,
        head_matches_applied: matches,
        state,
        validated: state === 'required_passed' && matches,
        required,
        checks,
        read_at: iso(readAt),
        task_evidence: { kind: 'pull_request' as const, ref: applied.pr_url, revision: head },
      };
    };
    const statusState = (): 'open' | 'closed' | 'merged' =>
      row.status === 'merged' ? 'merged' : row.status === 'closed' ? 'closed' : 'open';
    if (pre.cached && d.clock() - Number(pre.cached.read_at) < APPLY_LIMITS.evidenceMaxAgeMs)
      return view(
        pre.cached.head_sha,
        pre.cached.checks,
        pre.cached.state,
        Number(pre.cached.read_at),
        statusState(),
      );
    await d.limit(`room-repo-read:${room.id}`, 600, HOUR);
    const unavailable = () => refuse(502, 'github_unavailable', 'GitHub could not be reached.');
    const session = await access.session(
      binding as BindingRow,
      (room as RoomRow).host_owner_id,
      EVIDENCE_PERMISSIONS,
    );
    const pr = await session
      .pull(applied.pr_number)
      .catch((error) =>
        fromGitHub(error, () =>
          refuse(404, 'pull_request_not_found', 'The pull request no longer exists.'),
        ),
      );
    const runs = await session
      .checkRuns(pr.head_sha)
      .catch((error) => fromGitHub(error, unavailable));
    const statuses = await session
      .statuses(pr.head_sha)
      .catch((error) => fromGitHub(error, unavailable));
    const checks = [...runs.results, ...statuses.results];
    // Past the page cap some results are unseen, so nothing is evaluated as required: retrieved.
    const evaluated =
      runs.complete && statuses.complete
        ? evaluateChecks(checks, required)
        : { state: 'retrieved' as const, required: required ?? [] };
    const time = d.clock();
    const prState = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    await d.db.transaction(async (tx) => {
      if (p.guard) await p.guard(tx, d.clock());
      await access.membership(tx, room.id, p.operatorId);
      await tx.query(
        `INSERT INTO room_evidence(proposal_id,revision,head_sha,checks,required,state,read_at)
         VALUES($1,$2,$3,$4::jsonb,$5::text[],$6,$7)
         ON CONFLICT (proposal_id,revision,head_sha) DO UPDATE
           SET checks=EXCLUDED.checks, required=EXCLUDED.required, state=EXCLUDED.state, read_at=EXCLUDED.read_at`,
        [
          row.id,
          applied.revision,
          pr.head_sha,
          JSON.stringify(checks),
          evaluated.required,
          evaluated.state,
          time,
        ],
      );
      if (prState !== 'open')
        await tx.query(
          "UPDATE room_proposals SET status=$2, updated_at=$3 WHERE id=$1 AND status='applied'",
          [row.id, prState, time],
        );
    });
    return view(pr.head_sha, checks, evaluated.state, time, prState);
  }

  return { apply, evidence };
}
