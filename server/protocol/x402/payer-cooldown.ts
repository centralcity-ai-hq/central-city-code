import type { Hex } from 'viem';
import type { Migration } from '../../migrations.js';

/**
 * Migration 357 `x402_payer_cooldowns`: the revert cool-down of outside x402 payers, one row per
 * lane and payer, so an hour means an hour after the revert. The shared limiter's windows follow the
 * clock, so a revert at xx:59 cooled for one minute there. New table only.
 *
 * `payer` is an outside buyer's public address, which no account owns, and a row lives an hour plus
 * the next sweep: neither exported nor erased with an account (no account column), never in a backup
 * (server/recovery.ts), and forgetting one only ends a cool-down early.
 */
export const X402_PAYER_COOLDOWNS_SQL = `
CREATE TABLE IF NOT EXISTS x402_payer_cooldowns (lane text NOT NULL, payer text NOT NULL, until_ms bigint NOT NULL, PRIMARY KEY (lane, payer));
CREATE INDEX IF NOT EXISTS x402_payer_cooldowns_until ON x402_payer_cooldowns (until_ms);
`;

export const x402PayerCooldownsMigration: Migration = {
  version: 357,
  name: 'x402_payer_cooldowns',
  sql: X402_PAYER_COOLDOWNS_SQL,
};

/** Expired rows one sweep deletes at most; the cron runs every minute. */
export const PAYER_COOLDOWN_SWEEP_MAX = 500;

type CooldownDb = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/**
 * One lane's cool-down. `record` starts the full time from now and never shortens one already
 * running; a failure is logged (no address) and never reaches the settlement that reverted.
 * `cooling` reads an error as cooling (fail closed).
 */
export function payerCooldown(
  db: CooldownDb,
  options: { lane: string; ms: number; now: () => number; log?: (line: string) => void },
): { record(payer: Hex): Promise<void>; cooling(payer: Hex): Promise<boolean> } {
  const { lane, ms, now } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  return {
    record: async (payer) => {
      try {
        await db.query(
          `INSERT INTO x402_payer_cooldowns AS c (lane, payer, until_ms) VALUES ($1, $2, $3)
           ON CONFLICT (lane, payer) DO UPDATE SET until_ms = GREATEST(c.until_ms, EXCLUDED.until_ms)`,
          [lane, payer.toLowerCase(), now() + ms],
        );
      } catch {
        log(JSON.stringify({ event: 'x402_cooldown.record_failed', lane }));
      }
    },
    cooling: async (payer) => {
      try {
        const { rows } = await db.query(
          'SELECT 1 FROM x402_payer_cooldowns WHERE lane = $1 AND payer = $2 AND until_ms > $3',
          [lane, payer.toLowerCase(), now()],
        );
        return rows.length > 0;
      } catch {
        return true;
      }
    },
  };
}

/** Deletes at most PAYER_COOLDOWN_SWEEP_MAX expired rows of any lane; answers how many. */
export async function sweepPayerCooldowns(db: CooldownDb, now: number): Promise<number> {
  const { rows } = await db.query(
    `DELETE FROM x402_payer_cooldowns WHERE (lane, payer) IN (
       SELECT lane, payer FROM x402_payer_cooldowns WHERE until_ms <= $1
       ORDER BY until_ms LIMIT ${PAYER_COOLDOWN_SWEEP_MAX})
     RETURNING lane`,
    [now],
  );
  return rows.length;
}
