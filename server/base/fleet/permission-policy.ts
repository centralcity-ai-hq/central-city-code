/*
 * Fleet spend permission policy (audit CCA-709). A fleet's spend permission is the only on-chain
 * bound on what its spender key can move, so it must stay close to what the fleet plans to spend:
 *
 *   allowance  at most FLEET_PERMISSION_HEADROOM (2x) the fleet's planned spend per period
 *   end        a real end date, at most the policy's longest lifetime after it starts or after
 *              now, whichever is later (an end exactly at the limit is accepted); "no end" (the
 *              largest uint48) is refused
 *
 * The longest lifetime is 90 days by default, configurable up to 365 days with
 * CITY_FLEET_PERMISSION_MAX_DAYS; a configured value above 365 (or 0, or not a whole number) is
 * refused: the policy is then not built (a missing policy). A policy passed in code with
 * maxLifetimeSeconds above 365 days is refused the same way (TOO_LONG).
 *
 * ENFORCEMENT IS OPT-IN (service continuity): the owner sets the planned spend and re-issues the
 * permissions first (docs/KEY_ROLES_RUNBOOK.md), then turns on CITY_FLEET_PERMISSION_ENFORCE=1.
 * Until then reviewFleetPermission only logs one sanitized ALERT per violation (a missing policy
 * included) and lets the batch through exactly as before; with it, the violation is refused.
 *
 * Anything else is refused unless the caller passes an explicit exception (who approved it and
 * why). An exception is never silent: every use is logged as an ALERT line with the permission's
 * public fields (account, spender, token, allowance, period, end), never a signature or key, to
 * the caller's sink or, without one, the console (production has no Fastify logger).
 *
 * The permissions themselves are signed by the fleet owner accounts (operator-held keys, outside
 * the app); re-issuing and revoking them is an owner action (docs/KEY_ROLES_RUNBOOK.md).
 * This module is the app's side: it refuses to spend through an oversized or endless permission,
 * and fleetPermissionTerms gives the terms a re-issued permission should carry.
 */
import type { SpendPermission } from '../../../shared/base/types.js';

/** A permission may allow at most this multiple of the planned spend per period. */
export const FLEET_PERMISSION_HEADROOM = 2n;
/** The default longest lifetime of a fleet permission (seconds): 90 days. */
export const FLEET_PERMISSION_MAX_LIFETIME_S = 90 * 86_400;
/** The most CITY_FLEET_PERMISSION_MAX_DAYS may configure: 365 days; above is refused. */
export const FLEET_PERMISSION_MAX_CONFIGURABLE_DAYS = 365;
const MAX_CONFIGURABLE_S = FLEET_PERMISSION_MAX_CONFIGURABLE_DAYS * 86_400;
/** The largest uint48: what the Base SDKs (and our owner limits) use for "no end". */
const NO_END = 2 ** 48 - 1;

/** The planned spend per period: how much a fleet may move through this permission. */
export const FLEET_PLANNED_SPEND_SETTING = 'CITY_FLEET_PLANNED_SPEND_PER_PERIOD';
/** Optional longest lifetime in whole days, 1 to 365; default 90; anything else is refused. */
export const FLEET_PERMISSION_MAX_DAYS_SETTING = 'CITY_FLEET_PERMISSION_MAX_DAYS';
/** An explicit, logged exception: `approver: reason`. Unset: no exception. */
export const FLEET_PERMISSION_EXCEPTION_SETTING = 'CITY_FLEET_PERMISSION_EXCEPTION';
/** Exactly '1' makes the policy refuse; anything else only ALERTs (the last owner step). */
export const FLEET_PERMISSION_ENFORCE_SETTING = 'CITY_FLEET_PERMISSION_ENFORCE';

export function fleetPermissionEnforced(env: Record<string, string | undefined>): boolean {
  return env[FLEET_PERMISSION_ENFORCE_SETTING]?.trim() === '1';
}

export interface FleetPermissionException {
  /** Who approved the exception (a name or role, never a key). */
  approvedBy: string;
  reason: string;
}

export interface FleetPermissionPolicy {
  /** The fleet's planned spend per permission period, in the token's base units. */
  plannedPerPeriod: bigint;
  /** Longest allowed lifetime in seconds: default 90 days, at most 365 days. */
  maxLifetimeSeconds?: number;
  /** Lets an oversized or long-running permission through, logged as ALERT every time. */
  exception?: FleetPermissionException | null;
}

export type FleetPermissionRefusal =
  'NO_PLANNED_SPEND' | 'OVER_PLANNED_SPEND' | 'NO_END' | 'TOO_LONG' | 'INVALID_EXCEPTION';

export class FleetPermissionRefused extends Error {
  constructor(
    readonly code: FleetPermissionRefusal,
    message: string,
  ) {
    super(message);
  }
}

const validException = (exception: FleetPermissionException) =>
  [exception.approvedBy, exception.reason].every(
    (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
  );

/**
 * Checks a fleet permission against its policy; returns whether an exception let it through.
 * Throws FleetPermissionRefused otherwise. `now` is unix seconds. The exception ALERT goes to
 * `log`, else to the console.
 */
export function checkFleetPermission(
  permission: Pick<
    SpendPermission,
    'account' | 'spender' | 'token' | 'allowance' | 'period' | 'start' | 'end'
  >,
  policy: FleetPermissionPolicy,
  options: { now: number; log?: (line: string) => void },
): { exception: boolean } {
  const planned = policy?.plannedPerPeriod;
  if (typeof planned !== 'bigint' || planned <= 0n)
    throw new FleetPermissionRefused(
      'NO_PLANNED_SPEND',
      'A fleet permission needs a planned spend per period.',
    );
  const maxLifetime = policy.maxLifetimeSeconds ?? FLEET_PERMISSION_MAX_LIFETIME_S;
  if (!Number.isInteger(maxLifetime) || maxLifetime <= 0 || maxLifetime > MAX_CONFIGURABLE_S)
    throw new FleetPermissionRefused('TOO_LONG', 'The longest lifetime must be 1 s to 365 days.');

  const problems: { code: FleetPermissionRefusal; message: string }[] = [];
  if (permission.allowance > planned * FLEET_PERMISSION_HEADROOM)
    problems.push({
      code: 'OVER_PLANNED_SPEND',
      message: `The permission allows more than ${FLEET_PERMISSION_HEADROOM}x the planned spend per period.`,
    });
  if (permission.end >= NO_END)
    problems.push({ code: 'NO_END', message: 'The permission has no end date.' });
  else if (permission.end - Math.max(permission.start, options.now) > maxLifetime)
    problems.push({ code: 'TOO_LONG', message: 'The permission runs longer than allowed.' });
  if (!problems.length) return { exception: false };

  const exception = policy.exception;
  if (!exception) throw new FleetPermissionRefused(problems[0].code, problems[0].message);
  if (!validException(exception))
    throw new FleetPermissionRefused(
      'INVALID_EXCEPTION',
      'An exception names who approved it and why.',
    );
  (options.log ?? ((line: string) => console.error(line)))(
    `fleet permission: ALERT exception used (${problems.map((p) => p.code).join(', ')}) ${JSON.stringify(
      {
        account: permission.account,
        spender: permission.spender,
        token: permission.token,
        allowance: permission.allowance.toString(),
        planned: planned.toString(),
        period: permission.period,
        end: permission.end,
        approvedBy: exception.approvedBy,
        reason: exception.reason,
      },
    )}`,
  );
  return { exception: true };
}

/**
 * The fleet batch's entry point. With `enforce`, exactly checkFleetPermission (a violation
 * throws). Without it, a violation (a missing policy included) is logged as ONE sanitized ALERT
 * line, permission public fields and the refusal code only, and the permission is let through as
 * before. Returns the violation code, or null.
 */
export function reviewFleetPermission(
  permission: Pick<
    SpendPermission,
    'account' | 'spender' | 'token' | 'allowance' | 'period' | 'start' | 'end'
  >,
  policy: FleetPermissionPolicy | null | undefined,
  options: { now: number; enforce: boolean; log?: (line: string) => void },
): { violation: FleetPermissionRefusal | null } {
  const log = options.log ?? ((line: string) => console.error(line));
  if (options.enforce) {
    checkFleetPermission(permission, policy as FleetPermissionPolicy, { now: options.now, log });
    return { violation: null };
  }
  try {
    checkFleetPermission(permission, policy as FleetPermissionPolicy, { now: options.now, log });
    return { violation: null };
  } catch (error) {
    if (!(error instanceof FleetPermissionRefused)) throw error;
    log(
      `fleet permission: ALERT ${error.code} not enforced (${FLEET_PERMISSION_ENFORCE_SETTING} is off), batch allowed ${JSON.stringify(
        {
          account: permission.account,
          spender: permission.spender,
          token: permission.token,
          allowance: permission.allowance.toString(),
          period: permission.period,
          end: permission.end,
        },
      )}`,
    );
    return { violation: error.code };
  }
}

/**
 * The terms a (re-)issued fleet permission should carry: twice the planned spend per period, a
 * fixed period, and an end `lifetimeSeconds` after its start (default 90 days, at most 365).
 */
export function fleetPermissionTerms(input: {
  plannedPerPeriod: bigint;
  period: number;
  start: number;
  lifetimeSeconds?: number;
}): { allowance: bigint; period: number; start: number; end: number } {
  const lifetime = input.lifetimeSeconds ?? FLEET_PERMISSION_MAX_LIFETIME_S;
  if (input.plannedPerPeriod <= 0n) throw new Error('Planned spend must be positive.');
  if (!Number.isInteger(input.period) || input.period <= 0)
    throw new Error('Period must be positive.');
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > MAX_CONFIGURABLE_S)
    throw new Error('Lifetime must be 1 s to 365 days.');
  return {
    allowance: input.plannedPerPeriod * FLEET_PERMISSION_HEADROOM,
    period: input.period,
    start: input.start,
    end: input.start + lifetime,
  };
}

/**
 * The policy from the environment, or null (every fleet batch is then refused) when no planned
 * spend is configured or CITY_FLEET_PERMISSION_MAX_DAYS is set to anything but a whole number of
 * days from 1 to 365. The exception setting reads `approver: reason`.
 */
export function fleetPermissionPolicyFromEnv(
  env: Record<string, string | undefined>,
): FleetPermissionPolicy | null {
  const planned = env[FLEET_PLANNED_SPEND_SETTING]?.trim() ?? '';
  if (!/^[1-9][0-9]{0,30}$/.test(planned)) return null;
  const days = env[FLEET_PERMISSION_MAX_DAYS_SETTING]?.trim();
  let maxLifetimeSeconds = FLEET_PERMISSION_MAX_LIFETIME_S;
  if (days) {
    if (!/^[1-9][0-9]{0,2}$/.test(days) || Number(days) > FLEET_PERMISSION_MAX_CONFIGURABLE_DAYS)
      return null;
    maxLifetimeSeconds = Number(days) * 86_400;
  }
  const raw = env[FLEET_PERMISSION_EXCEPTION_SETTING]?.trim() ?? '';
  const split = raw.indexOf(':');
  const exception =
    split > 0
      ? { approvedBy: raw.slice(0, split).trim(), reason: raw.slice(split + 1).trim() }
      : null;
  return {
    plannedPerPeriod: BigInt(planned),
    maxLifetimeSeconds,
    exception: exception && validException(exception) ? exception : null,
  };
}
