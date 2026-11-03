import type { Rule } from './agents-array-readers.test.js';

/**
 * Direct reads of the agents array (or the whole workspace document) still allowed, per file and
 * rule, for tests/agents-array-readers.test.ts. Counts only go down: a reader moved to
 * workspace_agents(), workspace_agent() or workspace_document() lowers its entry, and an entry at
 * zero is removed.
 */
type Baseline = Record<string, Partial<Record<Rule, number>>>;

/**
 * Migrations (their SQL is frozen once applied) and the offline backup, which reads documents on
 * purpose. These stay.
 */
export const PERMANENT: Baseline = {
  'server/agent-rows/agent-lookup-schema.ts': { json: 5 },
  // Its workspaces trigger compares a write's old and new arrays (document mode only).
  'server/agent-rows/public-cards-schema.ts': { json: 6 },
  'server/agent-rows/schema.ts': { json: 13, path: 1, docHelpers: 1 },
  // The dual-mode SQL fragments: their document-mode branch is the old read, on purpose.
  'server/agent-rows/sql.ts': { json: 7 },
  // The rows-mode writer: it takes the written document's agents and keeps the counted ids.
  'server/agent-rows/writer-schema.ts': { docHelpers: 1 },
  // The mover reads the document's agents to copy them (and counts the rollback's).
  'server/agent-rows/mover.ts': { json: 3 },
  'server/agent-rows/writer.ts': { json: 1 },
  'server/autonomy/expiry-schema.ts': { json: 1 },
  'server/count-log/pending.ts': { json: 11, docHelpers: 2 },
  'server/migrations.ts': { json: 1 },
  'server/recovery.ts': { tsAgents: 5 },
  'server/rooms/agent-names-schema.ts': { json: 4 },
  'server/rooms/schema.ts': { json: 6 },
  'server/stats/schema.ts': { json: 5, docHelpers: 6 },
};

/** Readers still to move to the read functions before any workspace switches to rows. */
export const LEGACY: Baseline = {
  'server/activity.ts': { tsAgents: 1 },
  'server/agent-lifecycle.ts': { tsAgents: 1 },
  'server/agent-pages.ts': { tsAgents: 2 },
  'server/app.ts': { tsAgents: 12 },
  'server/assistant-access.ts': { tsAgents: 10 },
  'server/autonomy/index.ts': { tsAgents: 6 },
  'server/autonomy/service.ts': { tsAgents: 8 },
  'server/connections/service.ts': { tsAgents: 3 },
  'server/elric/service.ts': { tsAgents: 3 },
  'server/export.ts': { tsAgents: 1 },
  'server/feed/offers/store.ts': { tsAgents: 1 },
  // The document-mode branch of agentByIdSql (server/agent-rows/sql.ts), kept for its plan.
  'server/feed/pay/engine.ts': { json: 2 },
  'server/links/invites.ts': { tsAgents: 1 },
  'server/messaging/service.ts': { tsAgents: 5 },
  'server/model.ts': { tsAgents: 11 },
  'server/presence.ts': { tsAgents: 2 },
  'server/responder/deliver.ts': { tsAgents: 2 },
  'server/responder/service.ts': { tsAgents: 1 },
  'server/results/service.ts': { tsAgents: 1 },
  'server/results/store.ts': { tsAgents: 2 },
  'server/rooms/service.ts': { tsAgents: 9 },
  'server/stats/fast-count-check.ts': { docHelpers: 3 },
  'server/stats/public-stats.ts': { json: 1 },
  'server/wake/service.ts': { tsAgents: 1 },
};
