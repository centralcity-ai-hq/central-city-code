import { registerElricDraftMigration } from './draft.js';
import { registerElricTitlesMigration } from './titles.js';
import { registerElricCatchUpMigration } from './catch-up-schema.js';
import type { Database, Transaction as Tx } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';
import { registerElricPrivateChatMigration } from './chat-schema.js';
import { elricKilledByEnv, type ElricConfig, type ElricKind } from './config.js';

/**
 * Elric's money controls (docs/ELRIC.md; THREAT_PRIVACY_REVIEW §10.4). Fail-closed:
 *
 * - the kill switch (CITY_ELRIC_KILL=1 or the `elric_flags` row 'kill') refuses before any
 *   reservation or adapter call, and is checked again inside the reservation transaction;
 * - one transaction locks the owner's day row and the global day row (always in that order) and
 *   reserves the per-owner allowance count AND the global cost units together, or neither;
 * - a database error while reserving is a refusal, never a free pass.
 */
export type ReserveResult =
  | { ok: true; units: number; day: string }
  | { ok: false; reason: 'owner_allowance' | 'global_ceiling' | 'kill' | 'unavailable' };

type Env = Record<string, string | undefined>;
type Q = Pick<Tx, 'query'>;

/**
 * Ceiling alerts (docs/ELRIC.md "Operator controls"): when today's global total (reserved +
 * spent) reaches 50, 80 or 95% of the ceiling, the operator hears about it once per day and
 * threshold. Migration 42 keeps the highest threshold already announced on the day row; reserve()
 * raises it under the row lock in the reservation transaction, so two instances never announce
 * the same threshold twice (a settle that releases a worst-case reservation can lower the total;
 * crossing back up stays silent). The alert is delivered after the commit (ops.ts).
 */
export const CEILING_ALERT_PERCENTS = [50, 80, 95] as const;
export const elricCeilingAlertsMigration: Migration = {
  version: 42,
  name: 'elric_ceiling_alerts',
  sql: `ALTER TABLE elric_global_usage ADD COLUMN IF NOT EXISTS alerted_percent smallint NOT NULL
  DEFAULT 0 CHECK (alerted_percent IN (0,50,80,95));`,
};
/**
 * Registers migration 42 next to Elric's migration 39 (createApp), never on import: a migrations
 * run without the Elric schema must not touch elric tables.
 */
export function registerElricCeilingMigration(): void {
  registerMigration(elricCeilingAlertsMigration);
  // Migration 43 (the private dashboard chat) rides on the same registration point.
  registerElricPrivateChatMigration();
  // Migration 46 (streamed reply drafts) too.
  registerElricDraftMigration();
  // Migration 52 (conversation titles) too.
  registerElricTitlesMigration();
  // Migration 66 (the room catch-up cache) too.
  registerElricCatchUpMigration();
}

export interface CeilingAlert {
  day: string;
  percent: (typeof CEILING_ALERT_PERCENTS)[number];
  total_units: number;
  ceiling_units: number;
}
/** The highest threshold `total` reaches above the one already announced, or null. */
export function ceilingThreshold(
  total: number,
  ceiling: number,
  announced: number,
): CeilingAlert['percent'] | null {
  let reached: CeilingAlert['percent'] | null = null;
  for (const percent of CEILING_ALERT_PERCENTS)
    if (percent > announced && total * 100 >= percent * ceiling) reached = percent;
  return reached;
}
/** Where a committed crossing goes, per database (ops.ts registers the log + webhook sink). */
const ceilingSinks = new WeakMap<object, (alert: CeilingAlert) => void>();
export function onCeilingAlert(db: object, sink: (alert: CeilingAlert) => void): void {
  ceilingSinks.set(db, sink);
}

export async function killSwitchOn(q: Q, env: Env = process.env): Promise<boolean> {
  if (elricKilledByEnv(env)) return true;
  try {
    const row = (
      await q.query<{ enabled: boolean }>("SELECT enabled FROM elric_flags WHERE name='kill'")
    ).rows[0];
    return row?.enabled === true;
  } catch {
    return true; // fail closed
  }
}

export async function setKillSwitch(
  q: Q,
  enabled: boolean,
  actor: string,
  time: number,
): Promise<void> {
  await q.query(
    `INSERT INTO elric_flags(name,enabled,updated_at,updated_by) VALUES('kill',$1,$2,$3)
     ON CONFLICT (name) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at,
       updated_by=EXCLUDED.updated_by`,
    [enabled, time, actor],
  );
}

const KIND_COLUMN: Record<ElricKind, string> = { short: 'short', summary: 'summary', tool: 'tool' };

/**
 * Reserves one `kind` from the owner's allowance and `units` of the global ceiling for the
 * invocation holding `lease`. Everything happens in one transaction under row locks; when the
 * lease is gone the transaction rolls back and nothing stays reserved.
 */
export async function reserve(
  db: Pick<Database, 'transaction'>,
  config: ElricConfig,
  input: {
    ownerId: string;
    kind: ElricKind;
    units: number;
    day: string;
    /**
     * The invocation holding the lease the reservation is recorded on. Omitted for a request that
     * is not an invocation (the room catch-up, catch-up.ts): the caller settles it itself.
     */
    invocation?: { agentId: string; roomId: string; sourceSeq: number; leaseId: string };
  },
  env: Env = process.env,
): Promise<ReserveResult> {
  const column = KIND_COLUMN[input.kind];
  let crossed: CeilingAlert | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      crossed = null;
      if (await killSwitchOn(tx, env)) return { ok: false, reason: 'kill' } as const;
      await tx.query('INSERT INTO elric_usage(owner_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        input.ownerId,
        input.day,
      ]);
      await tx.query('INSERT INTO elric_global_usage(day) VALUES($1) ON CONFLICT DO NOTHING', [
        input.day,
      ]);
      const owner = (
        await tx.query<{ used: number }>(
          `SELECT ${column} AS used FROM elric_usage WHERE owner_id=$1 AND day=$2 FOR UPDATE`,
          [input.ownerId, input.day],
        )
      ).rows[0]!;
      const global = (
        await tx.query<{
          reserved_units: string | number;
          spent_units: string | number;
          alerted_percent: number;
        }>(
          'SELECT reserved_units,spent_units,alerted_percent FROM elric_global_usage WHERE day=$1 FOR UPDATE',
          [input.day],
        )
      ).rows[0]!;
      if (Number(owner.used) >= config.allowance[input.kind])
        return { ok: false, reason: 'owner_allowance' } as const;
      if (
        Number(global.reserved_units) + Number(global.spent_units) + input.units >
        config.globalDailyUnits
      )
        return { ok: false, reason: 'global_ceiling' } as const;
      await tx.query(
        `UPDATE elric_usage SET ${column}=${column}+1, reserved_units=reserved_units+$3
          WHERE owner_id=$1 AND day=$2`,
        [input.ownerId, input.day, input.units],
      );
      await tx.query(
        `UPDATE elric_global_usage SET reserved_units=reserved_units+$2, invocations=invocations+1
          WHERE day=$1`,
        [input.day, input.units],
      );
      const total = Number(global.reserved_units) + Number(global.spent_units) + input.units;
      const percent = ceilingThreshold(
        total,
        config.globalDailyUnits,
        Number(global.alerted_percent),
      );
      if (percent !== null) {
        await tx.query('UPDATE elric_global_usage SET alerted_percent=$2 WHERE day=$1', [
          input.day,
          percent,
        ]);
        crossed = {
          day: input.day,
          percent,
          total_units: total,
          ceiling_units: config.globalDailyUnits,
        };
      }
      if (!input.invocation) return { ok: true, units: input.units, day: input.day } as const;
      const held = await tx.query(
        `UPDATE elric_invocations SET reserved_units=$5, usage_day=$6, kind=$7
          WHERE agent_id=$1 AND room_id=$2 AND source_seq=$3 AND lease_id=$4 AND status='running'
          RETURNING 1`,
        [
          input.invocation.agentId,
          input.invocation.roomId,
          input.invocation.sourceSeq,
          input.invocation.leaseId,
          input.units,
          input.day,
          input.kind,
        ],
      );
      if (!held.rows.length) throw new Error('lease lost'); // rolls the reservation back
      return { ok: true, units: input.units, day: input.day } as const;
    });
    // Committed: announce the crossing. A sink failure never affects the reservation.
    const alert = crossed as CeilingAlert | null;
    if (result.ok && alert)
      try {
        ceilingSinks.get(db)?.(alert);
      } catch {
        // contained
      }
    return result;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Settles a reservation: the reservation is released and the TRUE `spent` units are recorded,
 * even above the reservation (the overage is returned and audited in the turn, never hidden);
 * `refund` also gives the allowance count back (cancelled or failed before a useful answer).
 * Runs in the caller's transaction.
 */
export async function settle(
  tx: Q,
  input: {
    ownerId: string;
    kind: ElricKind;
    day: string;
    reserved: number;
    spent: number;
    refund: boolean;
  },
): Promise<{ overage: number }> {
  const spent = Math.max(0, Math.ceil(input.spent));
  const column = KIND_COLUMN[input.kind];
  await tx.query(
    `UPDATE elric_usage SET reserved_units=GREATEST(0, reserved_units-$3),
       spent_units=spent_units+$4,
       ${column}=CASE WHEN $5 THEN GREATEST(0, ${column}-1) ELSE ${column} END
     WHERE owner_id=$1 AND day=$2`,
    [input.ownerId, input.day, input.reserved, spent, input.refund],
  );
  await tx.query(
    `UPDATE elric_global_usage SET reserved_units=GREATEST(0, reserved_units-$2),
       spent_units=spent_units+$3 WHERE day=$1`,
    [input.day, input.reserved, spent],
  );
  return { overage: Math.max(0, spent - input.reserved) };
}

export interface ElricUsageView {
  day: string;
  used: Record<ElricKind, number>;
  allowance: Record<ElricKind, number>;
  resets_at: string;
}
