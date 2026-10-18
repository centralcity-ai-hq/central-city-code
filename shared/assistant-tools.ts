import { z } from 'zod';
import { AGENT_PAGES } from './agent-pages.js';

/**
 * Input schemas for the Phase 2 autonomy tools, shared by the remote MCP endpoint, the local
 * stdio bridge and the backend. Manifest documents are accepted as plain JSON objects here and
 * validated by the planner, which returns machine-actionable issues (code, path, hint).
 */
const uuid = z.string().uuid();
export const toolIdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe('Stable caller-chosen key; retry with the same key and unchanged arguments.');
const manifestDocument = z
  .record(z.string(), z.unknown())
  .describe(
    'A centralcity.agent/v1 manifest (kind Agent or Team). See docs/AGENT_MANIFEST.md; list templates with city_list_templates.',
  );
export const templateRefSchema = z
  .string()
  .max(128)
  .regex(/^template:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?@\d{1,4}\.\d{1,4}\.\d{1,4}$/)
  .describe('Built-in template reference, for example template:research-team@1.0.0.');
const overrides = z
  .object({
    metadata: z.record(z.string(), z.unknown()).optional(),
    spec: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .describe(
    'Manifest fields merged over the template. Set metadata.name to create a distinct agent from the same template.',
  );
const teamHash = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .describe('team_hash from city_plan_team; apply is refused if the plan changed.');
const parentAgent = uuid.describe(
  'Optional existing agent to create under (lineage for cascade revoke). Not available anonymously.',
);

/** Legacy fields (unchanged) or manifest mode; the backend enforces exactly one form. */
export const createAgentToolInput = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().max(300).optional(),
    capability: z.enum(['research', 'extract', 'verify']).optional(),
    mode: z.enum(['hosted', 'external']).optional(),
    idempotencyKey: toolIdempotencyKey.optional(),
    manifest: manifestDocument.optional(),
    template: templateRefSchema.optional(),
    overrides: overrides.optional(),
    parent_agent_id: parentAgent.optional(),
    dry_run: z
      .boolean()
      .optional()
      .describe('Plan only: validate and return the plan without creating anything.'),
    idempotency_key: toolIdempotencyKey.optional(),
  })
  .strict();
export const listTemplatesToolInput = z.object({}).strict();
/**
 * city_workspace paging (shared/agent-pages.ts). Without limit or cursor a workspace of at most
 * AGENT_PAGES.threshold agents answers in full, unchanged; a larger one, or any call with limit or
 * cursor, answers one page of agents, newest first, with agents_total and next_cursor.
 */
export const workspaceToolInput = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(AGENT_PAGES.max)
      .optional()
      .describe(`Agents per page (default ${AGENT_PAGES.size}, at most ${AGENT_PAGES.max}).`),
    cursor: z
      .string()
      .min(1)
      .max(AGENT_PAGES.cursor)
      .optional()
      .describe('next_cursor of the previous page, for the next (older) agents.'),
  })
  .strict();
export const planTeamToolInput = z
  .object({
    manifest: manifestDocument.optional(),
    template: templateRefSchema.optional(),
    parent_agent_id: parentAgent.optional(),
  })
  .strict();
export const applyTeamToolInput = z
  .object({
    manifest: manifestDocument.optional(),
    template: templateRefSchema.optional(),
    idempotency_key: toolIdempotencyKey,
    expected_team_hash: teamHash.optional(),
    parent_agent_id: parentAgent.optional(),
  })
  .strict();
export const controlToolInput = z
  .object({
    agent_id: uuid,
    action: z.enum(['pause', 'resume', 'revoke']),
    cascade: z
      .boolean()
      .optional()
      .describe(
        'Apply to descendants too (default true). Revocation always cascades; false is refused.',
      ),
  })
  .strict();

/**
 * Tools an unauthenticated caller may use on /mcp/open; everything else requires an OAuth grant
 * or an AI workspace key on /mcp. city_create_workspace exists only there.
 */
export const ANONYMOUS_TOOLS = [
  'city_list_templates',
  'city_plan_team',
  'city_create_agent',
  'city_apply_team',
  'city_create_workspace',
] as const;
export type AnonymousToolName = (typeof ANONYMOUS_TOOLS)[number];
