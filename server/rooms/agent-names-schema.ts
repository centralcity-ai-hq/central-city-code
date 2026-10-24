import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 244 `agent_names_reset_scoped`: the workspaces trigger of migration 62 cleared the
 * mention keys of every agent membership the owner had whenever any agent's name map changed, and
 * creating an agent always changes it. With tens of thousands of agents, every create rewrote all
 * of the owner's agent rows in room_members while holding the workspace row lock. The function
 * now resets only the agents whose name can have changed: renamed, removed or added (an added id
 * may still have memberships from before it was removed). A create then touches no membership row
 * unless that id already has one. The trigger itself (its WHEN) is unchanged.
 */
export const AGENT_NAMES_RESET_SCOPED_SQL = `
CREATE OR REPLACE FUNCTION workspaces_agent_names_reset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before jsonb := CASE WHEN jsonb_typeof(OLD.data->'agents') = 'array' THEN OLD.data->'agents' ELSE '[]'::jsonb END;
  after jsonb := CASE WHEN jsonb_typeof(NEW.data->'agents') = 'array' THEN NEW.data->'agents' ELSE '[]'::jsonb END;
  changed text[];
BEGIN
  SELECT array_agg(DISTINCT COALESCE(o.id, n.id)) INTO changed
    FROM (SELECT a->>'id' AS id, a->'name' AS name FROM jsonb_array_elements(before) a) o
    FULL JOIN (SELECT a->>'id' AS id, a->'name' AS name FROM jsonb_array_elements(after) a) n
      ON n.id = o.id
   WHERE COALESCE(o.id, n.id) IS NOT NULL
     AND (o.id IS NULL OR n.id IS NULL OR o.name IS DISTINCT FROM n.name);
  IF changed IS NOT NULL THEN
    UPDATE room_members SET name_key = NULL, slug_key = NULL, name_rev = name_rev + 1
      WHERE owner_id = NEW.operator_id AND kind = 'agent'
        AND lower(agent_id) = ANY (SELECT lower(x) FROM unnest(changed) x);
  END IF;
  RETURN NULL;
END $$;
`;

export const agentNamesResetScopedMigration: Migration = {
  version: 244,
  name: 'agent_names_reset_scoped',
  sql: AGENT_NAMES_RESET_SCOPED_SQL,
};

/** Idempotent; call before runMigrations (after 62, whose function it replaces). */
export function registerAgentNamesResetScopedMigration(): void {
  registerMigration(agentNamesResetScopedMigration);
}
