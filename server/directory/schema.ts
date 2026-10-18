import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 100 `agent_directory` (Operation Directory D1, shared/directory.ts): the owner's
 * directory settings per agent.
 *
 * - `listed`: "Show in the directory". Off by default for every agent, and no row reads the same
 *   as the defaults (not listed, invitations 'ask'), so existing agents stay out until their owner
 *   turns it on. The search lists an agent only while this is on AND the explorer would list it
 *   with a final Base ID and a public card (server/directory/store.ts): turning a card private or
 *   revoking the agent takes it out without touching this row.
 * - `invitations`: 'ask' (room invitations arrive for the AI or the owner to answer, D2) or
 *   'never' (no Invite button).
 *
 * The partial index keeps the search's candidate scan to the listed rows.
 */
/** The tables migration 100 adds (server/recovery.ts recognizes them). */
export const DIRECTORY_TABLES = ['agent_directory'] as const;

export const AGENT_DIRECTORY_SQL = `
CREATE TABLE IF NOT EXISTS agent_directory (
  agent_id text PRIMARY KEY,
  listed boolean NOT NULL DEFAULT false,
  invitations text NOT NULL DEFAULT 'ask' CHECK (invitations IN ('ask','never')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_directory_listed ON agent_directory(agent_id) WHERE listed;
`;

export const agentDirectoryMigration: Migration = {
  version: 100,
  name: 'agent_directory',
  sql: AGENT_DIRECTORY_SQL,
};

/** Idempotent; call before runMigrations. */
export function registerDirectoryMigration(): void {
  registerMigration(agentDirectoryMigration);
}
