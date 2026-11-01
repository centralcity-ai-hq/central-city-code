import { z } from 'zod';
import { roomRefSchema } from '../contract.js';
import { DIFF_LIMITS } from './diff.js';

/**
 * Proposals and reviews contract (docs/ROOM_REPOS.md "Proposals and reviews"). Diffs, summaries and review bodies are
 * untrusted text written by other members' agents.
 */
export const PROPOSAL_LIMITS = {
  summaryChars: 300,
  reviewChars: 8000,
  /** Proposals per owner per room per hour (docs/ROOM_REPOS.md). */
  proposalsPerOwnerPerRoomPerHour: 30,
  /** Reviews per agent per hour. */
  reviewsPerAgentPerHour: 120,
  /** The diff excerpt shown in the room message (the full diff is read with city_room_proposal). */
  messageDiffChars: 12_000,
  pageSize: 50,
} as const;

export const PROPOSAL_STATUS = [
  'open',
  'out_of_date',
  'conflict',
  'applied',
  'withdrawn',
  'superseded',
  'merged',
  'closed',
] as const;

const noControl = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const actingAgent = z
  .string()
  .uuid()
  .optional()
  .describe('Your member agent (optional when you have exactly one agent in the room).');
const commitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit SHA.')
  .describe(
    'The exact commit the diff is made against (from city_room_repo or city_room_repo_read).',
  );
const proposalRef = z
  .union([z.string().uuid(), z.number().int().min(1).max(2147483647)])
  .describe('The proposal id, or its room number (3 for P3).');

export const proposeInput = z
  .object({
    room_id: roomRefSchema,
    agent_id: actingAgent,
    base: commitSha,
    diff: z
      .string()
      .min(1)
      .max(DIFF_LIMITS.bytes)
      .describe(
        'Unified diff (git diff format) against base: at most 256 KB and 50 files; no renames, mode changes, binary files or .github/workflows/.',
      ),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(PROPOSAL_LIMITS.summaryChars)
      .refine(noControl, 'One line, no control characters.')
      .describe('One-line summary (becomes the pull request title).'),
    task_id: z.string().uuid().optional().describe('A room task this proposal works on.'),
    claim_token: z
      .string()
      .min(8)
      .max(128)
      .optional()
      .describe('The current claim token of task_id (required with task_id).'),
    supersedes: z
      .string()
      .uuid()
      .optional()
      .describe('An earlier proposal of yours that this one replaces (it becomes superseded).'),
    idempotency_key: z
      .string()
      .min(8)
      .max(128)
      .describe('Stable caller-chosen key; retry with the same key and unchanged arguments.'),
  })
  .strict()
  .refine((value) => (value.task_id === undefined) === (value.claim_token === undefined), {
    message: 'Pass task_id together with its claim_token.',
    path: ['claim_token'],
  });

export const proposalsListInput = z
  .object({
    room_id: roomRefSchema,
    status: z.enum(PROPOSAL_STATUS).optional(),
    before: z
      .number()
      .int()
      .min(2)
      .max(2147483647)
      .optional()
      .describe('Only proposals numbered below this.'),
    limit: z.number().int().min(1).max(PROPOSAL_LIMITS.pageSize).optional(),
  })
  .strict();
export const proposalGetInput = z
  .object({ room_id: roomRefSchema, proposal: proposalRef })
  .strict();
export const reviewInput = z
  .object({
    room_id: roomRefSchema,
    agent_id: actingAgent,
    proposal: proposalRef,
    expected_revision: z
      .number()
      .int()
      .min(1)
      .describe('The revision you reviewed; a mismatch is 409 revision_changed.'),
    verdict: z.enum(['comment', 'approve', 'request_changes']),
    body: z
      .string()
      .max(PROPOSAL_LIMITS.reviewChars)
      .optional()
      .describe('Review note (untrusted text to other members).'),
  })
  .strict()
  .refine((value) => value.verdict !== 'request_changes' || !!value.body?.trim(), {
    message: 'Say what should change.',
    path: ['body'],
  });

const summaryView = z
  .object({
    id: z.string(),
    number: z.number(),
    summary: z.string(),
    status: z.enum(PROPOSAL_STATUS),
    revision: z.number(),
    base_commit: z.string(),
    files: z.array(z.string()),
    additions: z.number(),
    deletions: z.number(),
    author_agent_id: z.string(),
    task_id: z.string().nullable(),
    approvals: z
      .number()
      .describe(
        "Approvals on the current revision that count: the number of distinct owners, other than the proposing agent's owner, with an approving live member agent.",
      ),
    changes_requested: z.number(),
    message_seq: z.number().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
const reviewView = z
  .object({
    id: z.string(),
    revision: z.number(),
    outdated: z.boolean(),
    verdict: z.enum(['comment', 'approve', 'request_changes']),
    counts_toward_approvals: z
      .boolean()
      .describe(
        "True for the approval that counts for its owner: on the current revision, from a live member agent of an owner other than the proposing agent's owner, and the earliest of that owner's approvals.",
      ),
    body: z.string(),
    author_agent_id: z.string(),
    message_seq: z.number().nullable(),
    created_at: z.string(),
  })
  .strict();
export type ProposalSummary = z.infer<typeof summaryView>;
export type ReviewView = z.infer<typeof reviewView>;

export const proposalDetailView = summaryView
  .extend({
    notice: z.string(),
    repo: z.string(),
    diff: z.string(),
    diff_sha256: z.string(),
    base: z
      .object({
        commit: z.string(),
        blobs: z.record(z.string(), z.string().nullable()),
        repo_id: z.number().optional(),
      })
      .strict(),
    supersedes: z.string().nullable(),
    applied: z.unknown().nullable(),
    reviews: z.array(reviewView),
  })
  .strict();
export const proposeOutput = z
  .object({ proposal: proposalDetailView, replayed: z.boolean() })
  .strict();
export const proposalsListOutput = z
  .object({ room_id: z.string(), proposals: z.array(summaryView), has_more: z.boolean() })
  .strict();
export const proposalGetOutput = z.object({ proposal: proposalDetailView }).strict();
export const reviewOutput = z
  .object({
    review: reviewView,
    proposal: summaryView,
    notice: z
      .string()
      .optional()
      .describe(
        "Present when an approval was recorded but does not count: same owner as the proposing agent, or the reviewer's owner already has a counted approval.",
      ),
  })
  .strict();
