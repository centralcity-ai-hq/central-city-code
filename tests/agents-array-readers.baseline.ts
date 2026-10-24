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
  'server/agent-rows/agent-lookup-schema.ts': { json: 2 },
  'server/agent-rows/schema.ts': { json: 13, path: 1, docHelpers: 1 },
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
  'server/app.ts': { wholeDocument: 2, tsAgents: 12 },
  'server/assistant-access.ts': { json: 1, tsAgents: 10 },
  'server/autonomy/admin.ts': { json: 4 },
  'server/autonomy/index.ts': { json: 3, tsAgents: 6 },
  'server/autonomy/service.ts': { tsAgents: 8 },
  'server/base/identity/routes.ts': { json: 1 },
  'server/base/identity/short-links.ts': { json: 1 },
  'server/base/payments/agent-pay.ts': { json: 1 },
  'server/connections/service.ts': { json: 3, tsAgents: 3 },
  'server/count-log/service.ts': { json: 3 },
  'server/elric/access.ts': { wholeDocument: 1 },
  'server/elric/catch-up.ts': { wholeDocument: 1 },
  'server/elric/chat.ts': { json: 1 },
  'server/elric/draft.ts': { json: 1 },
  'server/elric/service.ts': { json: 1, tsAgents: 3 },
  'server/export.ts': { tsAgents: 1 },
  'server/feed/offers/store.ts': { json: 2, tsAgents: 1 },
  'server/feed/pay/engine.ts': { json: 2 },
  'server/feed/respond.ts': { wholeDocument: 1 },
  'server/links/invites.ts': { json: 1, tsAgents: 1 },
  'server/manifest/card-agent.ts': { json: 1 },
  'server/messaging/room-direct.ts': { json: 2, wholeDocument: 2 },
  'server/messaging/service.ts': { json: 3, wholeDocument: 3, tsAgents: 5 },
  'server/model.ts': { tsAgents: 11 },
  'server/presence.ts': { tsAgents: 2 },
  'server/responder/deliver.ts': { json: 1, wholeDocument: 2, tsAgents: 2 },
  'server/responder/service.ts': { wholeDocument: 1, tsAgents: 1 },
  'server/results/service.ts': { json: 2, tsAgents: 1 },
  'server/results/store.ts': { tsAgents: 2 },
  'server/rooms/invitations.ts': { json: 1, wholeDocument: 3 },
  'server/rooms/overview.ts': { json: 1 },
  'server/rooms/pins.ts': { wholeDocument: 1 },
  'server/rooms/repos/access.ts': { json: 1, wholeDocument: 1 },
  'server/rooms/repos/apply.ts': { json: 1 },
  'server/rooms/service.ts': { json: 6, wholeDocument: 2, tsAgents: 9 },
  'server/rooms/system-lines.ts': { json: 1 },
  'server/rooms/tasks-service.ts': { json: 1, wholeDocument: 1 },
  'server/stats/fast-count-check.ts': { docHelpers: 3 },
  'server/stats/public-stats.ts': { json: 3 },
  'server/wake/hooks.ts': { json: 3 },
  'server/wake/routes.ts': { wholeDocument: 1 },
  'server/wake/service.ts': { wholeDocument: 1, tsAgents: 1 },
  'server/workspaces/admin.ts': { json: 1 },
  'server/workspaces/service.ts': { json: 2 },
};
