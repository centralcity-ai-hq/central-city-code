import type { Transaction } from '../database.js';
import { parseResponderAction, type ResponderAction } from './actions.js';

type Query = Pick<Transaction, 'query'>;
type Key = { agentId: string; mentionSeq: number };
export type ActionResult = { state: 'executed' | 'refused'; outcome: unknown };

/** Persist once within the caller's authorized lease transaction; retries keep the first action. */
export async function proposeJournaledAction(
  tx: Query,
  key: Key,
  input: unknown,
  now: number,
): Promise<ResponderAction> {
  const action = parseResponderAction(input);
  if (!action) throw new Error('Invalid responder action proposal.');
  await tx.query(
    `INSERT INTO responder_actions(agent_id,mention_seq,action,created_at)
     VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (agent_id,mention_seq) DO NOTHING`,
    [key.agentId, key.mentionSeq, JSON.stringify(action), now],
  );
  const { rows } = await tx.query<{ action: unknown }>(
    `SELECT action FROM responder_actions WHERE agent_id=$1 AND mention_seq=$2 FOR UPDATE`,
    [key.agentId, key.mentionSeq],
  );
  const stored = parseResponderAction([rows[0]?.action]);
  if (!stored) throw new Error('Invalid stored responder action proposal.');
  return stored;
}

/** The caller owns the transaction: the effect and journal outcome must commit together. */
export async function executeJournaledAction(
  tx: Query,
  key: Key,
  hooks: {
    enabled?: boolean;
    now: number;
    /** Must recheck lease, current person/owner, enablement and selected-agent visibility. */
    authorize: (tx: Query) => Promise<string | null>;
    effect: (tx: Query, action: ResponderAction) => Promise<unknown>;
  },
): Promise<ActionResult> {
  if (hooks.enabled !== true) throw new Error('Responder actions are disabled.');
  const { rows } = await tx.query<{
    action: unknown;
    state: 'proposed' | 'executed' | 'refused';
    outcome: unknown;
  }>(
    `SELECT action,state,outcome FROM responder_actions
     WHERE agent_id=$1 AND mention_seq=$2 FOR UPDATE`,
    [key.agentId, key.mentionSeq],
  );
  const row = rows[0];
  if (!row) throw new Error('Missing responder action proposal.');
  // A replay returns the recorded outcome, even if the pin was subsequently removed.
  if (row.state !== 'proposed') return { state: row.state, outcome: row.outcome };
  const refusal = await hooks.authorize(tx);
  const action = parseResponderAction([row.action]);
  let code = refusal ?? (action ? null : 'invalid_action');
  if (code === null) {
    if (!Number.isSafeInteger(hooks.now) || hooks.now < 0)
      throw new Error('Invalid responder action time.');
    // Match responder usage's UTC day; the upsert serializes all rooms for this agent.
    const day = new Date(hooks.now).toISOString().slice(0, 10);
    const charged = await tx.query(
      `INSERT INTO responder_action_usage(agent_id,day,actions) VALUES ($1,$2::date,1)
       ON CONFLICT (agent_id,day) DO UPDATE SET actions=responder_action_usage.actions+1
       WHERE responder_action_usage.actions < 10 RETURNING actions`,
      [key.agentId, day],
    );
    if (charged.rows.length === 0) code = 'action_daily_limit';
  }
  const state = code === null ? 'executed' : 'refused';
  const outcome = code === null ? await hooks.effect(tx, action!) : { code };
  // Undefined is not a durable outcome; throw so the caller rolls back the effect as well.
  const encoded = JSON.stringify(outcome);
  if (encoded === undefined || encoded === 'null')
    throw new Error('Missing responder action outcome.');
  await tx.query(
    `UPDATE responder_actions SET state=$3,outcome=$4::jsonb,finished_at=$5
     WHERE agent_id=$1 AND mention_seq=$2`,
    [key.agentId, key.mentionSeq, state, encoded, hooks.now],
  );
  return { state, outcome };
}
