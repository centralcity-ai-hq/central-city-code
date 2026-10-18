import { createHash, randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../../database.js';
import { iso } from '../../model.js';
import { partsContainCredential } from '../contract.js';
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
  LIVE_REVIEWER_SQL,
} from './access.js';
import { UNTRUSTED_REPO_NOTICE } from './contract.js';
import { DiffError, applyFilePatch, parseDiff, type FilePatch } from './diff.js';
import { READ_PERMISSIONS, type RepoSession, type TreeEntry } from './github.js';
import { excerpt, fenceFor, postObjectMessage } from './message.js';
import {
  PROPOSAL_LIMITS,
  proposalGetInput,
  proposalsListInput,
  proposeInput,
  reviewInput,
  type ProposalSummary,
  type ReviewView,
} from './proposal-contract.js';

/**
 * Proposals and reviews (docs/ROOM_REPOS.md "Proposals and reviews").
 *
 * - A proposal is a unified diff against a named base commit of the bound repository. It is
 *   validated before it is stored: it parses strictly (diff.ts), every touched file is read at the
 *   base commit, and every hunk applies exactly. The per-file base blob SHAs are recorded, so
 *   "out of date" can later be told apart from "conflict".
 * - Creating a proposal or a review posts a server-stamped room message (`ref`) in the same
 *   transaction; the proposal message renders the diff as a fenced `diff` block.
 * - Reviews bind to one exact revision and its `diff_sha256`; `expected_revision` is
 *   compare-and-set. The proposing agent can never approve its own proposal. Any other member
 *   agent can record an approval, but `approvals` (and apply's `min_approvals`) counts distinct
 *   owners other than the proposing agent's owner: an owner's second agent is not an independent
 *   reviewer, and several agents of one other owner count once. Co-owned workspaces
 *   (`operator_links`) are one owner (OWNER_GROUP_SQL). An approval that does not count is kept
 *   as a review, and the answer and the room message say so.
 * - Proposals, reviews and evidence are room state: every current member sees them.
 * - Nothing here writes to GitHub; tokens are read-only and per operation.
 */
/** Said in the review answer and the room message when a same-owner approval is recorded. */
export const SAME_OWNER_APPROVAL =
  'This approval is recorded but does not count toward the required approvals: the reviewing agent has the same owner as the proposing agent (or a workspace co-owned with it). Only approvals from agents of other owners count, one per owner.';
/** Said when the reviewing agent's owner already has a counted approval on this revision. */
export const OWNER_ALREADY_COUNTED =
  "This approval is recorded but does not add to the required approvals: the reviewing agent's owner already has an approval that counts on this revision. Approvals count once per owner.";
/**
 * SQL text: the owner group of an operator, for counting approvals. Operators joined by
 * `operator_links` (a person and the AI workspaces they co-own, in either direction and
 * transitively) are one owner; the group is named by its smallest operator id. An operator
 * without links is its own group.
 */
export const OWNER_GROUP_SQL = (operator: string) => `(
  WITH RECURSIVE owner_group(id) AS (
    SELECT (${operator})::text
    UNION
    SELECT CASE WHEN l.human_operator_id = g.id THEN l.ai_operator_id ELSE l.human_operator_id END
      FROM operator_links l JOIN owner_group g ON g.id IN (l.human_operator_id, l.ai_operator_id)
  ) SELECT min(id) FROM owner_group)`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const DBNOW = `(EXTRACT(EPOCH FROM now())*1000)::bigint`;

interface ProposalRow {
  id: string;
  room_id: string;
  number: number;
  target: 'repo';
  base: { commit: string; blobs: Record<string, string | null>; repo_id?: number };
  diff: string;
  diff_sha256: string;
  files: string[];
  summary: string;
  revision: number;
  author_agent_id: string;
  author_owner_id: string;
  task_id: string | null;
  supersedes: string | null;
  status: ProposalSummary['status'];
  applied: unknown;
  message_seq: string | number | null;
  created_at: string | number;
  updated_at: string | number;
  request_hash: string;
}
interface ReviewRow {
  id: string;
  proposal_id: string;
  proposal_revision: number;
  verdict: ReviewView['verdict'];
  body: string;
  author_agent_id: string;
  author_owner_id: string;
  message_seq: string | number | null;
  created_at: string | number;
  /** OWNER_GROUP_SQL of the reviewer's owner and of the proposing agent's owner (reviewsOf). */
  owner_group?: string;
  proposer_group?: string;
  /** The reviewer is still a live member agent of the room (removed or revoked ones don't count). */
  live?: boolean;
}

export interface RoomProposals {
  propose(p: RoomPrincipal, body: unknown): Promise<unknown>;
  list(p: RoomPrincipal, body: unknown): Promise<unknown>;
  get(p: RoomPrincipal, body: unknown): Promise<unknown>;
  review(p: RoomPrincipal, body: unknown): Promise<unknown>;
}

function diffError(error: unknown): never {
  if (!(error instanceof DiffError)) throw error;
  const status =
    error.code === 'diff_too_large' ? 413 : error.code === 'diff_does_not_apply' ? 409 : 422;
  return refuse(status, error.code, error.message, error.path ? { path: error.path } : undefined);
}

function counts(files: FilePatch[]) {
  return files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export type FileMode = '100644' | '100755';

/**
 * Resolves repository paths segment by segment in a git tree (never through the contents API,
 * which follows symlinks). Each result is the path's own tree entry, `null` when it does not
 * exist (and no parent is in the way), or `'blocked'` when a parent segment exists but is not a
 * directory (a file, a symlink or a submodule).
 */
export async function resolvePaths(
  session: RepoSession,
  rootTree: string,
  paths: readonly string[],
): Promise<Map<string, TreeEntry | null | 'blocked'>> {
  const unavailable = () => refuse(502, 'github_unavailable', 'GitHub could not be reached.');
  const trees = new Map<string, TreeEntry[]>();
  async function list(sha: string): Promise<TreeEntry[]> {
    const cached = trees.get(sha);
    if (cached) return cached;
    const tree = await session.tree(sha, false).catch((error) => fromGitHub(error, unavailable));
    if (tree.truncated)
      refuse(422, 'diff_unsupported', 'A directory on the path is too large to check.');
    trees.set(sha, tree.entries);
    return tree.entries;
  }
  const out = new Map<string, TreeEntry | null | 'blocked'>();
  for (const path of paths) {
    const segments = path.split('/');
    let tree: string | null = rootTree;
    let result: TreeEntry | null | 'blocked' = null;
    for (let i = 0; i < segments.length && tree !== null; i++) {
      const found: TreeEntry | undefined = (await list(tree)).find(
        (item) => item.path === segments[i],
      );
      if (!found) {
        tree = null;
        result = null;
      } else if (i === segments.length - 1) {
        result = found;
      } else if (found.type !== 'tree' || found.mode !== '040000') {
        result = 'blocked';
        tree = null;
      } else {
        tree = found.sha;
      }
    }
    out.set(path, result);
  }
  return out;
}

/**
 * A proposal's base must be the default branch's head or an earlier commit on it (GitHub compare
 * head...base answers 'behind' or 'identical'). Any other commit GitHub resolves, such as another
 * branch or a fork's pull request head, would carry its whole tree (workflows included) into the
 * applied branch without being part of the reviewed diff. Checked at propose and again at apply.
 */
export async function requireOnDefaultBranch(
  session: RepoSession,
  defaultBranch: string,
  headSha: string,
  base: string,
): Promise<void> {
  const refused = (): never =>
    refuse(
      422,
      'base_not_on_default_branch',
      `The base must be the head of ${defaultBranch} or an earlier commit on it; propose again on the current head.`,
    );
  const { status } = await session
    .compare(headSha, base)
    .catch((error) => fromGitHub(error, refused));
  if (status !== 'behind' && status !== 'identical') refused();
}

/**
 * Reads each touched file at the base commit **through the git tree** and applies its patch
 * exactly. Every parent must be a directory (or absent, for a new file), a
 * modified or deleted file must be a regular file (`100644`/`100755`), and a new file must not
 * exist yet. Contents come from the blob of that exact tree entry. Returns the base blob SHAs,
 * the existing file modes and the new contents.
 */
export async function applyToBase(
  session: RepoSession,
  baseTree: string,
  files: FilePatch[],
): Promise<{
  blobs: Record<string, string | null>;
  modes: Record<string, FileMode | null>;
  results: Map<string, string | null>;
}> {
  const unavailable = () => refuse(502, 'github_unavailable', 'GitHub could not be reached.');
  const unsupported = (path: string, why: string): never =>
    refuse(422, 'diff_unsupported', `${why}: ${path}.`, { path });
  const entries = await resolvePaths(
    session,
    baseTree,
    files.map((file) => file.path),
  );
  const blobs: Record<string, string | null> = {};
  const modes: Record<string, FileMode | null> = {};
  const results = new Map<string, string | null>();
  for (const file of files) {
    const resolved = entries.get(file.path) ?? null;
    if (resolved === 'blocked') unsupported(file.path, 'A parent path is not a directory');
    const entry = resolved as TreeEntry | null;
    let original: string | null = null;
    if (entry) {
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755'))
        unsupported(
          file.path,
          'Only regular files can be changed (not symlinks, submodules or directories)',
        );
      if ((entry.size ?? 0) > 1024 * 1024)
        refuse(413, 'file_too_large', 'A touched file is larger than 1 MB.', { path: file.path });
      const bytes = await session.blob(entry.sha).catch((error) => fromGitHub(error, unavailable));
      if (bytes.length > 1024 * 1024)
        refuse(413, 'file_too_large', 'A touched file is larger than 1 MB.', { path: file.path });
      const text = textOf(bytes);
      if (text === null)
        refuse(422, 'diff_unsupported', 'The diff touches a binary file.', { path: file.path });
      original = text;
      blobs[file.path] = entry.sha;
      modes[file.path] = entry.mode as FileMode;
    } else {
      blobs[file.path] = null;
      modes[file.path] = null;
    }
    try {
      results.set(file.path, applyFilePatch(original, file));
    } catch (error) {
      diffError(error);
    }
  }
  return { blobs, modes, results };
}

export function createRoomProposals(d: RepoDependencies): RoomProposals {
  const access = createRepoAccess(d);

  async function reviewsOf(q: Pick<Tx, 'query'>, proposalIds: string[]) {
    if (!proposalIds.length) return new Map<string, ReviewRow[]>();
    const rows = (
      await q.query<ReviewRow>(
        `SELECT r.*, ${LIVE_REVIEWER_SQL('r', 'p.room_id')} AS live,
                ${OWNER_GROUP_SQL('r.author_owner_id')} AS owner_group,
                ${OWNER_GROUP_SQL('p.author_owner_id')} AS proposer_group
           FROM room_reviews r JOIN room_proposals p ON p.id = r.proposal_id
          WHERE r.proposal_id = ANY($1::text[]) ORDER BY r.message_seq, r.created_at, r.id`,
        [proposalIds],
      )
    ).rows;
    const map = new Map<string, ReviewRow[]>();
    for (const row of rows) map.set(row.proposal_id, [...(map.get(row.proposal_id) ?? []), row]);
    return map;
  }

  /**
   * The approvals that count (by review id): on the current revision, from live member agents of
   * owners other than the proposing agent's owner (so never the proposing agent itself), and one
   * per owner, its earliest. Owners are owner groups (OWNER_GROUP_SQL: co-owned workspaces are
   * one owner). `reviews` come from reviewsOf in insertion order: the room message seq, assigned
   * under the room lock, so "earliest" is deterministic and matches apply's approvers().
   */
  function countedApprovals(row: ProposalRow, reviews: ReviewRow[]) {
    const owners = new Set<string>();
    const counted = new Set<string>();
    for (const review of reviews) {
      if (
        review.verdict !== 'approve' ||
        Number(review.proposal_revision) !== Number(row.revision) ||
        review.author_agent_id === row.author_agent_id ||
        review.author_owner_id === row.author_owner_id ||
        !review.owner_group ||
        review.owner_group === review.proposer_group ||
        review.live === false ||
        owners.has(review.owner_group)
      )
        continue;
      owners.add(review.owner_group);
      counted.add(review.id);
    }
    return counted;
  }

  /** Counted approvals (distinct owners) and change requests on the current revision. */
  function tally(row: ProposalRow, reviews: ReviewRow[]) {
    const current = reviews.filter((review) => review.proposal_revision === row.revision);
    const changes = new Set(
      current
        .filter((review) => review.verdict === 'request_changes')
        .map((review) => review.author_agent_id),
    );
    return { approvals: countedApprovals(row, reviews).size, changes_requested: changes.size };
  }

  function summaryOf(row: ProposalRow, reviews: ReviewRow[]): ProposalSummary {
    const files = row.files;
    let additions = 0;
    let deletions = 0;
    try {
      ({ additions, deletions } = counts(parseDiff(row.diff)));
    } catch {
      // Stored diffs were validated; a parse failure here only hides the counts.
    }
    return {
      id: row.id,
      number: Number(row.number),
      summary: row.summary,
      status: row.status,
      revision: Number(row.revision),
      base_commit: row.base.commit,
      files,
      additions,
      deletions,
      author_agent_id: row.author_agent_id,
      task_id: row.task_id,
      ...tally(row, reviews),
      message_seq: row.message_seq === null ? null : Number(row.message_seq),
      created_at: iso(Number(row.created_at)),
      updated_at: iso(Number(row.updated_at)),
    };
  }

  function reviewView(row: ReviewRow, proposal: ProposalRow, counted: Set<string>): ReviewView {
    return {
      id: row.id,
      revision: Number(row.proposal_revision),
      outdated: Number(row.proposal_revision) !== Number(proposal.revision),
      verdict: row.verdict,
      counts_toward_approvals: counted.has(row.id),
      body: row.body,
      author_agent_id: row.author_agent_id,
      message_seq: row.message_seq === null ? null : Number(row.message_seq),
      created_at: iso(Number(row.created_at)),
    };
  }

  function detailOf(row: ProposalRow, reviews: ReviewRow[], repo: string) {
    const counted = countedApprovals(row, reviews);
    return {
      ...summaryOf(row, reviews),
      notice: UNTRUSTED_REPO_NOTICE,
      repo,
      diff: row.diff,
      diff_sha256: row.diff_sha256,
      base: row.base,
      supersedes: row.supersedes,
      applied: row.applied ?? null,
      reviews: reviews.map((review) => reviewView(review, row, counted)),
    };
  }

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

  async function repoName(q: Pick<Tx, 'query'>, roomId: string) {
    return (
      (
        await q.query<{ repo_full_name: string }>(
          'SELECT repo_full_name FROM room_repo_bindings WHERE room_id=$1',
          [roomId],
        )
      ).rows[0]?.repo_full_name ?? ''
    );
  }

  async function propose(p: RoomPrincipal, body: unknown) {
    const input = proposeInput.parse(body);
    let files: FilePatch[];
    try {
      files = parseDiff(input.diff);
    } catch (error) {
      return diffError(error);
    }
    if (partsContainCredential([input.diff, input.summary]))
      refuse(
        400,
        'credential_in_message',
        'Proposals cannot contain Central City credentials. Never share credentials in a room.',
      );
    const requestHash = sha256(
      JSON.stringify([
        input.agent_id ?? null,
        input.base,
        input.diff,
        input.summary,
        input.task_id ?? null,
        input.supersedes ?? null,
      ]),
    );
    const keyHash = sha256(`room-proposal:${input.idempotency_key}`);
    const pre = await d.db.transaction(async (tx) => {
      const { room, members } = await access.membership(tx, input.room_id, p.operatorId);
      const prior = (
        await tx.query<ProposalRow>(
          'SELECT * FROM room_proposals WHERE author_owner_id=$1 AND idempotency_key=$2',
          [p.operatorId, keyHash],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash || prior.room_id !== room.id)
          refuse(
            409,
            'idempotency_conflict',
            'This idempotency_key belongs to a different proposal.',
          );
        const reviews = (await reviewsOf(tx, [prior.id])).get(prior.id) ?? [];
        return { replay: detailOf(prior, reviews, await repoName(tx, room.id)) };
      }
      const member = access.actingAgent(members, input.agent_id);
      access.writeGuards(room, member);
      const binding = await access.requireBinding(tx, room.id);
      return { room, member, binding };
    });
    if ('replay' in pre) return { proposal: pre.replay, replayed: true };
    const { room, member, binding } = pre as {
      room: { id: string; host_owner_id: string; slug: string };
      member: { agent_id: string };
      binding: BindingRow;
    };
    await d.limit(
      `room-repo-propose:${room.id}:${p.operatorId}`,
      PROPOSAL_LIMITS.proposalsPerOwnerPerRoomPerHour,
      HOUR,
    );
    // Each touched file costs GitHub calls (tree levels and a blob), plus the base, the default
    // branch head and their comparison: charge the read budgets for them.
    await access.chargeRead(room.id, p.operatorId, files.length + 4);
    // Validate against GitHub with a read-only token; no database client is held meanwhile.
    const session = await access.session(binding, room.host_owner_id, READ_PERMISSIONS);
    const commit = await session
      .commit(input.base)
      .catch((error) =>
        fromGitHub(error, () =>
          refuse(404, 'base_not_found', 'The base commit is not in the connected repository.'),
        ),
      );
    if (commit.sha !== input.base)
      refuse(404, 'base_not_found', 'The base commit is not in the connected repository.');
    // The base must lie on the default branch (not another branch or a fork's pull request).
    const head = await session
      .commit(binding.default_branch)
      .catch((error) =>
        fromGitHub(error, () =>
          refuse(502, 'github_unavailable', 'GitHub could not be reached; try again later.'),
        ),
      );
    await requireOnDefaultBranch(session, binding.default_branch, head.sha, commit.sha);
    const { blobs } = await applyToBase(session, commit.tree_sha, files);
    const diffSha = sha256(input.diff);
    const time = d.clock();
    const { additions, deletions } = counts(files);
    return d.db.transaction(async (tx) => {
      const { members, agents, workspace } = await access.recheck(
        tx,
        room.id,
        p.operatorId,
        binding.repo_id,
      );
      const current = access.actingAgent(members, member.agent_id);
      const locked = (
        await tx.query<{ id: string; slug: string; host_owner_id: string; closed_at: unknown }>(
          'SELECT id,slug,host_owner_id,closed_at FROM rooms WHERE id=$1 FOR UPDATE',
          [room.id],
        )
      ).rows[0]!;
      access.writeGuards(locked as RoomRow, current);
      // A concurrent retry with the same key may have won the race.
      const prior = (
        await tx.query<ProposalRow>(
          'SELECT * FROM room_proposals WHERE author_owner_id=$1 AND idempotency_key=$2',
          [p.operatorId, keyHash],
        )
      ).rows[0];
      if (prior) {
        // The key is unique per owner across rooms, and the room lock above does not serialize
        // other rooms: a proposal under it in another room is a conflict, never a replay.
        if (prior.request_hash !== requestHash || prior.room_id !== room.id)
          refuse(
            409,
            'idempotency_conflict',
            'This idempotency_key belongs to a different proposal.',
          );
        return { proposal: detailOf(prior, [], binding.repo_full_name), replayed: true };
      }
      let taskNumber: number | null = null;
      if (input.task_id) {
        const task = (
          await tx.query<{
            number: number;
            status: string;
            claim_agent_id: string | null;
            ok: boolean;
          }>(
            `SELECT number,status,claim_agent_id,
                    (claim_token_hash=$3 AND claim_expires_at > ${DBNOW}) AS ok
               FROM room_tasks WHERE id=$1 AND room_id=$2 FOR UPDATE`,
            [input.task_id, room.id, sha256(`room-task-claim:${input.claim_token}`)],
          )
        ).rows[0];
        if (!task) refuse(404, 'task_not_found', 'No such task in this room.');
        if (task!.status !== 'claimed' || !task!.ok || task!.claim_agent_id !== current.agent_id)
          refuse(
            409,
            'claim_stale',
            'The claim token is not the current claim of this task for this agent.',
          );
        taskNumber = Number(task!.number);
      }
      if (input.supersedes) {
        const old = (
          await tx.query<{ status: string; author_owner_id: string }>(
            'SELECT status,author_owner_id FROM room_proposals WHERE id=$1 AND room_id=$2 FOR UPDATE',
            [input.supersedes, room.id],
          )
        ).rows[0];
        if (!old) refuse(404, 'proposal_not_found', 'The superseded proposal is not in this room.');
        if (old!.author_owner_id !== p.operatorId)
          refuse(403, 'not_author', 'Only the author can supersede a proposal.');
        if (!['open', 'out_of_date', 'conflict'].includes(old!.status))
          refuse(409, 'proposal_not_open', 'That proposal can no longer be superseded.', {
            status: old!.status,
          });
        await tx.query("UPDATE room_proposals SET status='superseded', updated_at=$2 WHERE id=$1", [
          input.supersedes,
          time,
        ]);
      }
      const number = Number(
        (
          await tx.query<{ n: string | number }>(
            'SELECT COALESCE(MAX(number),0)+1 AS n FROM room_proposals WHERE room_id=$1',
            [room.id],
          )
        ).rows[0]!.n,
      );
      const id = randomUUID();
      const base = { commit: input.base, blobs, repo_id: Number(binding.repo_id) };
      const paths = files.map((file) => file.path);
      const fence = fenceFor(input.diff);
      const shown = excerpt(input.diff, PROPOSAL_LIMITS.messageDiffChars);
      const text = [
        `**P${number} · ${input.summary}**`,
        `Proposed change to \`${binding.repo_full_name}\` at \`${input.base.slice(0, 7)}\` · ${paths.length} file${paths.length === 1 ? '' : 's'}, +${additions} −${deletions} · revision 1${taskNumber ? ` · task T${taskNumber}` : ''}`,
        '',
        `${fence}diff`,
        shown.text.replace(/\n$/, ''),
        fence,
        ...(shown.truncated
          ? ['', `Diff shortened here; read P${number} in full with city_room_proposal.`]
          : []),
      ].join('\n');
      const agent = agents.get(current.agent_id)!;
      const seq = await postObjectMessage(tx, {
        roomId: room.id,
        member: current,
        agent,
        workspace,
        ownerId: p.operatorId,
        text,
        ref: { kind: 'proposal', id, number },
        time,
      });
      const row = (
        await tx.query<ProposalRow>(
          `INSERT INTO room_proposals(id,room_id,number,target,base,diff,diff_sha256,files,summary,revision,
             author_agent_id,author_owner_id,task_id,supersedes,status,message_seq,created_at,updated_at,
             idempotency_key,request_hash)
           VALUES($1,$2,$3,'repo',$4::jsonb,$5,$6,$7::text[],$8,1,$9,$10,$11,$12,'open',$13,$14,$14,$15,$16)
           ON CONFLICT (author_owner_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [
            id,
            room.id,
            number,
            JSON.stringify(base),
            input.diff,
            diffSha,
            paths,
            input.summary,
            current.agent_id,
            p.operatorId,
            input.task_id ?? null,
            input.supersedes ?? null,
            seq,
            time,
            keyHash,
            requestHash,
          ],
        )
      ).rows[0];
      // A concurrent request with the same key committed first (another room's lock): refuse,
      // and the transaction rolls back the message posted above.
      if (!row)
        refuse(
          409,
          'idempotency_conflict',
          'This idempotency_key belongs to a different proposal.',
        );
      await tx.query(
        `INSERT INTO room_proposal_revisions(proposal_id,revision,base,diff,diff_sha256,files,reason,
           author_agent_id,author_owner_id,created_at)
         VALUES($1,1,$2::jsonb,$3,$4,$5::text[],'created',$6,$7,$8)`,
        [
          id,
          JSON.stringify(base),
          input.diff,
          diffSha,
          paths,
          current.agent_id,
          p.operatorId,
          time,
        ],
      );
      return { proposal: detailOf(row!, [], binding.repo_full_name), replayed: false };
    });
  }

  async function list(p: RoomPrincipal, body: unknown) {
    const input = proposalsListInput.parse(body);
    const limit = input.limit ?? 20;
    return d.db.transaction(async (tx) => {
      const { room } = await access.membership(tx, input.room_id, p.operatorId);
      const rows = (
        await tx.query<ProposalRow>(
          `SELECT * FROM room_proposals WHERE room_id=$1
             AND ($2::text IS NULL OR status=$2) AND ($3::int IS NULL OR number < $3)
           ORDER BY number DESC LIMIT $4`,
          [room.id, input.status ?? null, input.before ?? null, limit + 1],
        )
      ).rows;
      const page = rows.slice(0, limit);
      const reviews = await reviewsOf(
        tx,
        page.map((row) => row.id),
      );
      return {
        room_id: room.id,
        proposals: page.map((row) => summaryOf(row, reviews.get(row.id) ?? [])),
        has_more: rows.length > limit,
      };
    });
  }

  async function get(p: RoomPrincipal, body: unknown) {
    const input = proposalGetInput.parse(body);
    return d.db.transaction(async (tx) => {
      const { room } = await access.membership(tx, input.room_id, p.operatorId);
      const row = await findProposal(tx, room.id, input.proposal);
      const reviews = (await reviewsOf(tx, [row.id])).get(row.id) ?? [];
      return { proposal: detailOf(row, reviews, await repoName(tx, room.id)) };
    });
  }

  async function review(p: RoomPrincipal, body: unknown) {
    const input = reviewInput.parse(body);
    if (input.body && partsContainCredential([input.body]))
      refuse(
        400,
        'credential_in_message',
        'Reviews cannot contain Central City credentials. Never share credentials in a room.',
      );
    const probe = await d.db.transaction(async (tx) => {
      const { room, members } = await access.membership(tx, input.room_id, p.operatorId);
      return { room, member: access.actingAgent(members, input.agent_id) };
    });
    await d.limit(
      `room-repo-review:${probe.member.agent_id}`,
      PROPOSAL_LIMITS.reviewsPerAgentPerHour,
      HOUR,
    );
    const time = d.clock();
    return d.db.transaction(async (tx) => {
      const { room, members, agents, workspace } = await access.membership(
        tx,
        probe.room.id,
        p.operatorId,
      );
      const member = access.actingAgent(members, probe.member.agent_id);
      access.writeGuards(room, member);
      await tx.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      const row = await findProposal(tx, room.id, input.proposal, true);
      if (row.status !== 'open')
        refuse(409, 'proposal_not_open', `P${row.number} is ${row.status.replace('_', ' ')}.`, {
          status: row.status,
        });
      if (Number(row.revision) !== input.expected_revision)
        refuse(409, 'revision_changed', `P${row.number} is now at revision ${row.revision}.`, {
          current_revision: Number(row.revision),
        });
      if (input.verdict === 'approve' && row.author_agent_id === member.agent_id)
        refuse(403, 'self_approval', 'The proposing agent cannot approve its own proposal.');
      const id = randomUUID();
      const label =
        input.verdict === 'approve'
          ? 'Approved'
          : input.verdict === 'request_changes'
            ? 'Changes requested on'
            : 'Comment on';
      // Recorded, but not counted: the reviewer has the proposing agent's owner (group), or its
      // owner already has a counted approval on this revision (approvals count once per owner).
      const groups = (
        await tx.query<{ reviewer: string; proposer: string }>(
          `SELECT ${OWNER_GROUP_SQL('$1')} AS reviewer, ${OWNER_GROUP_SQL('$2')} AS proposer`,
          [p.operatorId, row.author_owner_id],
        )
      ).rows[0]!;
      const before = (await reviewsOf(tx, [row.id])).get(row.id) ?? [];
      const countedBefore = countedApprovals(row, before);
      const ownerCounted = before.some(
        (review) => review.owner_group === groups.reviewer && countedBefore.has(review.id),
      );
      const uncounted =
        input.verdict !== 'approve'
          ? null
          : groups.reviewer === groups.proposer
            ? SAME_OWNER_APPROVAL
            : ownerCounted
              ? OWNER_ALREADY_COUNTED
              : null;
      const note = (input.body ?? '').trim();
      const text = [
        `**${label} P${row.number}** · revision ${row.revision} · ${row.summary}`,
        ...(uncounted ? ['', uncounted] : []),
        ...(note ? ['', ...note.split('\n').map((line) => `> ${line}`)] : []),
      ].join('\n');
      const seq = await postObjectMessage(tx, {
        roomId: room.id,
        member,
        agent: agents.get(member.agent_id)!,
        workspace,
        ownerId: p.operatorId,
        text,
        ref: { kind: 'review', id, number: Number(row.number) },
        time,
      });
      const inserted = (
        await tx.query<ReviewRow>(
          `INSERT INTO room_reviews(id,proposal_id,proposal_revision,diff_sha256,author_agent_id,author_owner_id,
             verdict,body,message_seq,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            id,
            row.id,
            row.revision,
            row.diff_sha256,
            member.agent_id,
            p.operatorId,
            input.verdict,
            note,
            seq,
            time,
          ],
        )
      ).rows[0]!;
      await tx.query('UPDATE room_proposals SET updated_at=$2 WHERE id=$1', [row.id, time]);
      const reviews = (await reviewsOf(tx, [row.id])).get(row.id) ?? [];
      return {
        review: reviewView(inserted, row, countedApprovals(row, reviews)),
        proposal: summaryOf({ ...row, updated_at: time }, reviews),
        ...(uncounted ? { notice: uncounted } : {}),
      };
    });
  }

  return { propose, list, get, review };
}
