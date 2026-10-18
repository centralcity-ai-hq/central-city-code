/*
 * The use counts of the services sold by Central City agents (the 'Central City' rows of
 * feed_services): the Bazaar reports its own records' counts, these are ours, from the Feed pay
 * calls that paid them. Same notion as the public paid calls count (server/feed/pay/count-schema.ts):
 * a call counts once Base shows its payment used (payment_state 'settled'), on Base mainnet only,
 * whether or not its answer came back. Over the last 30 days:
 *
 * - paid_calls_30d: those calls; payers_30d: the distinct paying wallets (one per agent);
 * - last_called_at: the latest such call's settled time, kept once the 30 days have passed it (the
 *   card then says "No recent uses", not "New").
 *
 * refreshHostedUses recomputes them in one statement, from the Feed's sweep cron (every 15 minutes,
 * server/feed/cron.ts), so a card's count is at most one run behind. It reads the last 30 days of
 * settled fee-included calls through their partial index (migration 127, uses-schema.ts) and
 * writes only the Central City rows whose numbers changed; the Bazaar's rows are never written.
 * A publish keeps the numbers (the upsert in store.ts keeps them for a row of the same source) and
 * a new row starts at 0 ("New"). When any row changed, the Central City data version moves in the
 * same transaction, so the Feed's cached order and cursors follow (server/feed/query.ts).
 */
import type { Database } from '../../database.js';
import { PAID_CALLS_CHAIN_ID } from '../../../shared/paid-calls.js';
import { HOSTED_SOURCE } from '../types.js';
import { moveHostedVersion } from './store.js';

/** The window the counts cover, as the Bazaar's paid_calls_30d does. */
export const HOSTED_USES_WINDOW_MS = 30 * 86_400_000;

const REFRESH_SQL = `
UPDATE feed_services AS s SET
  paid_calls_30d = t.calls,
  payers_30d = t.payers,
  last_called_at = GREATEST(s.last_called_at, t.last)
FROM (
  SELECT h.id, COALESCE(u.calls, 0) AS calls, COALESCE(u.payers, 0) AS payers, u.last
  FROM feed_services h
  LEFT JOIN (
    SELECT service_id, count(*)::int AS calls, count(DISTINCT wallet_id)::int AS payers,
      max(settled_at) AS last
    FROM feed_pay_calls
    WHERE pay_kind = 'included' AND payment_state = 'settled' AND settled_at > $1
      AND chain_id = $2
    GROUP BY service_id
  ) u ON u.service_id = h.id
  WHERE h.source = $3
) AS t
WHERE s.id = t.id AND s.source = $3
  AND (s.paid_calls_30d IS DISTINCT FROM t.calls OR s.payers_30d IS DISTINCT FROM t.payers
    OR s.last_called_at IS DISTINCT FROM GREATEST(s.last_called_at, t.last))
RETURNING s.id`;

/** Recomputes the Central City rows' 30-day counts as of `now`; answers how many rows changed. */
export async function refreshHostedUses(db: Database, now: number): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(REFRESH_SQL, [
      now - HOSTED_USES_WINDOW_MS,
      PAID_CALLS_CHAIN_ID,
      HOSTED_SOURCE,
    ]);
    if (rows.length) await moveHostedVersion(tx);
    return rows.length;
  });
}
