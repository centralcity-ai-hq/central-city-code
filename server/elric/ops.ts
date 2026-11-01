import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../database.js';
import { httpsWebhookTransport, type WebhookTransport } from '../wake/webhooks.js';
import { registerElricCostReport } from './cost-report.js';
import { onCeilingAlert, setKillSwitch, type CeilingAlert } from './budget.js';
import {
  DAY_MS,
  dayOf,
  ELRIC_COST_UNIT_USD,
  elricKilledByEnv,
  resetAt,
  type ElricConfig,
} from './config.js';

/**
 * Operator controls for Elric (docs/ELRIC.md "Operator controls"). No admin UI and no person
 * account: the operator calls two routes with `Authorization: Bearer <secret>`, the 'elric'
 * capability's secret (CITY_OPS_ELRIC_SECRET, else CITY_OPS_SECRET; see opsAuthorizedFor below).
 *
 * - `POST /api/ops/elric/kill` `{ enabled }` writes the database kill switch (instant, no
 *   redeploy). CITY_ELRIC_KILL=1 stays the break-glass switch and wins over the database row.
 * - `GET /api/ops/elric/usage` returns aggregates only: today's and the last 7 days' global cost
 *   units against the ceiling, invocations and the kill state. Never an owner, room or turn.
 *
 * Fail closed like the cron routes: without a configured secret of 32+ characters, or with any
 * other header, both answer 404, exactly like an unknown path. CITY_OPS_SECRET is separate from
 * CRON_SECRET (which Vercel sends to every cron route).
 */
export const OPS_SECRET_MIN_CHARS = 32;
/** Days of history in the usage view (today included). */
export const OPS_USAGE_DAYS = 7;
/** Time allowed for the alert webhook. */
export const OPS_ALERT_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;

export function opsAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < OPS_SECRET_MIN_CHARS || !header?.startsWith('Bearer '))
    return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Capability-scoped operations secrets (CCA-717): each power has its own setting, so one leaked
 * secret no longer opens unrelated routes. The legacy single CITY_OPS_SECRET stays the fallback for
 * a capability whose own setting is unset (backward compatible); once a capability's setting is
 * set, the legacy secret no longer opens it. Rotation: `<SETTING>_PREVIOUS` is accepted next to its
 * current value (an overlap period), only while that current value is set; remove it to end the
 * overlap. Values are never logged or returned; only these setting names are documented
 * (docs/OPERATIONS.md "Operations secrets").
 */
export const OPS_SECRET_SETTING = 'CITY_OPS_SECRET';
export const OPS_PREVIOUS_SUFFIX = '_PREVIOUS';
export const OPS_CAPABILITY_SETTINGS = {
  /** Key provisioning: paymaster keys, sponsor key, facilitator keys. */
  keys: 'CITY_OPS_KEYS_SECRET',
  /** Elric kill switch, usage and cost report. */
  elric: 'CITY_OPS_ELRIC_SECRET',
  /** Feed moderation queue and decisions. */
  review: 'CITY_OPS_REVIEW_SECRET',
  /** Read-only operator numbers: platform metrics, sponsored first purchase numbers. */
  metrics: 'CITY_OPS_METRICS_SECRET',
  /** Newsletter subscriber list (personal data). */
  email: 'CITY_OPS_EMAIL_SECRET',
} as const;
export type OpsCapability = keyof typeof OPS_CAPABILITY_SETTINGS;

/** The secrets that open a capability now: its own (current, previous) or the legacy pair. */
function opsSecretsFor(env: Env, capability: OpsCapability): Array<string | undefined> {
  const own = OPS_CAPABILITY_SETTINGS[capability];
  const setting = env[own]?.trim() ? own : OPS_SECRET_SETTING;
  const current = env[setting]?.trim();
  return current ? [current, env[`${setting}${OPS_PREVIOUS_SUFFIX}`]?.trim()] : [];
}

/** The ops guard for one capability: true when the Bearer header matches one of its secrets. */
export function opsAuthorizedFor(
  header: string | undefined,
  env: Env,
  capability: OpsCapability,
): boolean {
  // Every candidate is compared (no early exit), each in constant time.
  return opsSecretsFor(env, capability)
    .map((secret) => opsAuthorized(header, secret))
    .reduce((any, ok) => any || ok, false);
}

export interface OpsDayUsage {
  day: string;
  reserved_units: number;
  spent_units: number;
  /** reserved + spent: what the ceiling is checked against. */
  total_units: number;
  ceiling_units: number;
  percent: number;
  spent_usd: number;
  ceiling_usd: number;
  invocations: number;
}

/** The alert text: aggregates only, never an owner, room or turn. */
export function ceilingAlertText(alert: CeilingAlert): string {
  const usd = (units: number) => Math.round(units * ELRIC_COST_UNIT_USD);
  return `Elric is at ${alert.percent}% of today's USD ${usd(alert.ceiling_units)} ceiling (USD ${usd(alert.total_units)} reserved or spent, ${alert.day} UTC).`;
}

/**
 * Announces a committed ceiling crossing: always a structured log line, and a POST to
 * CITY_OPS_ALERT_WEBHOOK when set (https on the default port, public host, no redirects, a
 * 5-second timeout: the wake webhook transport). Never throws; a failure is logged.
 */
export async function deliverCeilingAlert(
  alert: CeilingAlert,
  env: Env,
  transport: WebhookTransport = httpsWebhookTransport,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<void> {
  log(JSON.stringify({ event: 'elric_ceiling_alert', ...alert }));
  const url = env.CITY_OPS_ALERT_WEBHOOK;
  if (!url) return;
  try {
    const body = JSON.stringify({ text: ceilingAlertText(alert), ...alert });
    const { status } = await transport(
      url,
      body,
      { 'content-type': 'application/json' },
      OPS_ALERT_TIMEOUT_MS,
    );
    if (status < 200 || status >= 300)
      log(JSON.stringify({ event: 'elric_ceiling_alert_failed', status }));
  } catch (error) {
    log(
      JSON.stringify({
        event: 'elric_ceiling_alert_failed',
        error: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
      }),
    );
  }
}

const killBody = z.object({ enabled: z.boolean() }).strict();
const round2 = (value: number) => Math.round(value * 100) / 100;

export function registerElricOps(
  app: FastifyInstance,
  d: {
    db: Pick<Database, 'query' | 'transaction'>;
    clock: () => number;
    config: ElricConfig;
    env?: Env;
  },
): void {
  const env = () => d.env ?? process.env;
  // Committed ceiling crossings (budget.ts reserve) go to the log and the optional webhook.
  onCeilingAlert(d.db, (alert) => void deliverCeilingAlert(alert, env()));
  const notFound = () =>
    Object.assign(new Error('Not found.'), { statusCode: 404, errorCode: 'not_found' });
  const guard = (request: FastifyRequest) => {
    if (!opsAuthorizedFor(request.headers.authorization, env(), 'elric')) throw notFound();
  };
  const killState = async () => {
    const row = (
      await d.db.query<{ enabled: boolean; updated_at: string | number; updated_by: string }>(
        "SELECT enabled,updated_at,updated_by FROM elric_flags WHERE name='kill'",
      )
    ).rows[0];
    const byEnv = elricKilledByEnv(env());
    return {
      killed: byEnv || row?.enabled === true,
      env: byEnv,
      database: row?.enabled === true,
      updated_at: row ? new Date(Number(row.updated_at)).toISOString() : null,
      updated_by: row?.updated_by ?? null,
    };
  };
  const dayView = (
    day: string,
    row?: { reserved_units: string | number; spent_units: string | number; invocations: number },
  ): OpsDayUsage => {
    const reserved = Number(row?.reserved_units ?? 0);
    const spent = Number(row?.spent_units ?? 0);
    const ceiling = d.config.globalDailyUnits;
    return {
      day,
      reserved_units: reserved,
      spent_units: spent,
      total_units: reserved + spent,
      ceiling_units: ceiling,
      percent: ceiling > 0 ? round2(((reserved + spent) / ceiling) * 100) : 100,
      spent_usd: round2(spent * ELRIC_COST_UNIT_USD),
      ceiling_usd: round2(ceiling * ELRIC_COST_UNIT_USD),
      invocations: Number(row?.invocations ?? 0),
    };
  };

  registerElricCostReport(app, { db: d.db, clock: d.clock, guard });

  app.post('/api/ops/elric/kill', async (request) => {
    guard(request);
    const { enabled } = killBody.parse(request.body ?? {});
    await setKillSwitch(d.db, enabled, 'ops', d.clock());
    return { kill: await killState() };
  });

  app.get('/api/ops/elric/usage', async (request) => {
    guard(request);
    const time = d.clock();
    const days = Array.from({ length: OPS_USAGE_DAYS }, (_, i) => dayOf(time - i * DAY_MS));
    const rows = (
      await d.db.query<{
        day: string;
        reserved_units: string | number;
        spent_units: string | number;
        invocations: number;
      }>(
        'SELECT day,reserved_units,spent_units,invocations FROM elric_global_usage WHERE day = ANY($1::text[])',
        [days],
      )
    ).rows;
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const [today, ...earlier] = days.map((day) => dayView(day, byDay.get(day)));
    return {
      today,
      resets_at: new Date(resetAt(time)).toISOString(),
      cost_unit_usd: ELRIC_COST_UNIT_USD,
      kill: await killState(),
      days: earlier,
    };
  });
}
