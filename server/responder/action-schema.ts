import type { Migration } from '../migrations.js';

/** Reserved for B2. Register only with the lease-guarded, atomic effect executor. */
export const responderActionsMigration: Migration = {
  version: 87,
  name: 'responder_owner_actions',
  sql: `
CREATE TABLE IF NOT EXISTS responder_action_usage (
  agent_id text NOT NULL,
  day date NOT NULL,
  actions integer NOT NULL CHECK (actions BETWEEN 1 AND 10),
  PRIMARY KEY (agent_id, day)
);
CREATE TABLE IF NOT EXISTS responder_actions (
  agent_id text NOT NULL,
  mention_seq bigint NOT NULL,
  action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object'),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','executed','refused')),
  outcome jsonb,
  created_at bigint NOT NULL,
  finished_at bigint,
  PRIMARY KEY (agent_id, mention_seq),
  FOREIGN KEY (agent_id, mention_seq)
    REFERENCES responder_replies(agent_id, mention_seq) ON DELETE CASCADE,
  CHECK ((state = 'proposed') = (outcome IS NULL)),
  CHECK ((state = 'proposed') = (finished_at IS NULL))
);
CREATE FUNCTION responder_action_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.mention_seq IS DISTINCT FROM OLD.mention_seq
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'responder action identity is immutable';
  END IF;
  IF OLD.state <> 'proposed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'responder action outcome is terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER responder_action_immutable BEFORE UPDATE ON responder_actions
  FOR EACH ROW EXECUTE FUNCTION responder_action_immutable();
`,
};
