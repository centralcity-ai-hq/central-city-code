import { z } from 'zod';
import { roomRefSchema } from '../contract.js';

/**
 * Apply and check-evidence contract (docs/ROOM_REPOS.md "Apply and evidence").
 */
export const APPLY_LIMITS = {
  /** Applies per room per hour (docs/ROOM_REPOS.md). */
  appliesPerRoomPerHour: 20,
  /** Evidence is re-read from GitHub when older than this (docs/ROOM_REPOS.md: 60 s). */
  evidenceMaxAgeMs: 60_000,
  /** Agent names and labels in commit trailers. */
  trailerChars: 80,
} as const;

const proposalRef = z
  .union([z.string().uuid(), z.number().int().min(1).max(2147483647)])
  .describe('The proposal id, or its room number (3 for P3).');

export const applyInput = z
  .object({
    room_id: roomRefSchema,
    agent_id: z
      .string()
      .uuid()
      .optional()
      .describe('Your member agent (optional when you have exactly one agent in the room).'),
    proposal: proposalRef,
    expected_revision: z
      .number()
      .int()
      .min(1)
      .describe('The revision that was reviewed; a mismatch is 409 revision_changed.'),
    idempotency_key: z
      .string()
      .min(8)
      .max(128)
      .describe('Stable caller-chosen key; a retry returns the same branch and pull request.'),
  })
  .strict();
export const evidenceInput = z.object({ room_id: roomRefSchema, proposal: proposalRef }).strict();

export const EVIDENCE_STATES = [
  'retrieved',
  'required_pending',
  'required_failed',
  'required_passed',
] as const;

const appliedView = z
  .object({
    branch: z.string(),
    pr_number: z.number(),
    pr_url: z.string(),
    head_sha: z.string(),
    revision: z.number(),
  })
  .strict();
export const applyOutput = z
  .object({
    proposal_id: z.string(),
    number: z.number(),
    applied: appliedView,
    already_applied: z.boolean(),
  })
  .strict();
const checkView = z
  .object({
    source: z.enum(['check_run', 'status']),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();
export const evidenceOutput = z
  .object({
    notice: z.string(),
    proposal_id: z.string(),
    number: z.number(),
    revision: z.number(),
    pr_number: z.number(),
    pr_url: z.string(),
    pr_state: z.enum(['open', 'closed', 'merged']),
    head_sha: z.string(),
    applied_head_sha: z.string(),
    head_matches_applied: z.boolean(),
    state: z.enum(EVIDENCE_STATES),
    validated: z.boolean(),
    required: z.array(z.string()).nullable(),
    checks: z.array(checkView),
    read_at: z.string(),
    task_evidence: z
      .object({ kind: z.literal('pull_request'), ref: z.string(), revision: z.string() })
      .strict(),
  })
  .strict();
