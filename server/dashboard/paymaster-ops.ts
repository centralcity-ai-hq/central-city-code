/*
 * The paymaster's settled operations, as a running total in dashboard_state.backfill (no new table
 * and no COUNT over the whole table): each rollup run counts one bounded range of settled blocks
 * through own_paymaster_reservations_settled and moves the watermark in the same transaction. A
 * failed run moves nothing and the next one repeats it.
 */
import { BASE_MAINNET } from '../../shared/base/chains.js';
import type { Database } from '../database.js';

/** Blocks counted per run: about a day of Base, so a first run catches up within a few runs. */
export const PAYMASTER_OPS_BLOCKS = 50_000;
/** The block range that may still change: a settled operation is written shortly after its block. */
export const PAYMASTER_OPS_SETTLE_BLOCKS = 300;

interface OpsCursor {
  through: string;
  count: number;
}

const cursorOf = (backfill: unknown): OpsCursor | null => {
  const value = (typeof backfill === 'string' ? JSON.parse(backfill) : backfill) as {
    paymaster_ops?: OpsCursor;
  } | null;
  return value?.paymaster_ops ?? null;
};

/** One step; the head comes from the newest settled row, never from the chain. */
export async function stepPaymasterOperations(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL statement_timeout = '5s'`);
    const state = (
      await tx.query<{ backfill: unknown }>(
        'SELECT backfill FROM dashboard_state WHERE id FOR UPDATE',
      )
    ).rows[0];
    if (!state) return;
    const cursor = cursorOf(state.backfill) ?? { through: '0', count: 0 };
    const head = (
      await tx.query<{ head: string | null }>(
        `SELECT max(settled_block)::text AS head FROM own_paymaster_reservations WHERE chain_id = ${BASE_MAINNET} AND status='settled'`,
      )
    ).rows[0]?.head;
    if (!head) return;
    const from = BigInt(cursor.through);
    const safeHead = BigInt(head) - BigInt(PAYMASTER_OPS_SETTLE_BLOCKS);
    const first =
      from > 0n
        ? from
        : BigInt(
            (
              await tx.query<{ low: string }>(
                `SELECT min(settled_block)::text AS low FROM own_paymaster_reservations WHERE chain_id = ${BASE_MAINNET} AND status='settled'`,
              )
            ).rows[0]!.low,
          ) - 1n;
    const to = [first + BigInt(PAYMASTER_OPS_BLOCKS), safeHead].reduce((a, b) => (a < b ? a : b));
    if (to <= first) return;
    const counted = (
      await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM own_paymaster_reservations
          WHERE chain_id = ${BASE_MAINNET} AND status='settled' AND settled_block > $1::numeric AND settled_block <= $2::numeric`,
        [first.toString(), to.toString()],
      )
    ).rows[0]!.n;
    const next: OpsCursor = { through: to.toString(), count: cursor.count + Number(counted) };
    await tx.query(
      `UPDATE dashboard_state SET backfill = jsonb_set(backfill, '{paymaster_ops}', $1::jsonb) WHERE id`,
      [JSON.stringify(next)],
    );
  });
}

/** The running total, or null before the first count. */
export async function paymasterOperations(db: Pick<Database, 'query'>): Promise<number | null> {
  const row = (
    await db.query<{ backfill: unknown }>('SELECT backfill FROM dashboard_state WHERE id')
  ).rows[0];
  const cursor = row ? cursorOf(row.backfill) : null;
  return cursor ? cursor.count : null;
}
