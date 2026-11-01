import type { CityLimits } from './limits.js';
import { hitAddressScopes, type RateLimiter, type RateLimitResult } from './rate-limit.js';

/** The window of the per-address sign-up budgets. */
export const SIGNUP_WINDOW_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const GLOBAL_KEY = 'register-global:all';

/** Account-name checks per IPv4 address or IPv6 /64 per SIGNUP_WINDOW_MS (wider scopes: x2, x4, x16). */
export const NAME_CHECKS_PER_WINDOW = 10;

/**
 * Admission for one account-name check outside the sign-up itself: a Google-created account
 * choosing its name (onboarding, /api/auth/google/handle) answers whether a name is taken, so
 * every such check is charged before the lookup, per address scope as sign-up is (the source,
 * and for IPv6 the /56, /48 and /32), not only per account. A pending account therefore cannot
 * test names without limit, and new pending accounts do not add budget. Login is unchanged: it
 * answers the same for an unknown name and a wrong password.
 */
export function admitNameCheck(
  limiter: Pick<RateLimiter, 'hit'>,
  ip: string,
): Promise<RateLimitResult> {
  return hitAddressScopes(limiter, 'name-check', ip, NAME_CHECKS_PER_WINDOW, SIGNUP_WINDOW_MS, {
    region: true,
  });
}

/**
 * Admission for a new account, shared by the password sign-up and Continue with Google (one set
 * of buckets for both). Per address scope first (rate-limit.ts hitAddressScopes: the source, and
 * for IPv6 the /56, /48 and /32), then one deployment-wide hourly count. That count refuses only when
 * `registrationsPerHourGlobal` is set (0, the default, is no ceiling); at or above
 * `registrationsAlertPerHour` it logs one structured `signup.volume` line per instance per minute
 * (counts only, never an address).
 */
export function createSignUpAdmission(d: {
  limiter: Pick<RateLimiter, 'hit' | 'count'>;
  clock(): number;
  caps: Pick<
    CityLimits,
    'registrationsPerWindow' | 'registrationsPerHourGlobal' | 'registrationsAlertPerHour'
  >;
  log?: (line: string) => void;
}): (ip: string) => Promise<RateLimitResult> {
  const log = d.log ?? ((line: string) => console.warn(line));
  let lastAlertCheck = -Infinity;
  return async (ip) => {
    const scoped = await hitAddressScopes(
      d.limiter,
      'register',
      ip,
      d.caps.registrationsPerWindow,
      SIGNUP_WINDOW_MS,
      // New accounts multiply every per-account budget, so the IPv6 /32 is counted as well.
      { region: true },
    );
    if (!scoped.allowed) return scoped;
    const ceiling = d.caps.registrationsPerHourGlobal;
    const global = await d.limiter.hit(
      GLOBAL_KEY,
      ceiling > 0 ? ceiling : Number.MAX_SAFE_INTEGER,
      HOUR_MS,
    );
    const now = d.clock();
    if (now - lastAlertCheck >= 60_000) {
      lastAlertCheck = now;
      const count = await d.limiter.count(GLOBAL_KEY, HOUR_MS);
      if (count >= d.caps.registrationsAlertPerHour && count < Number.MAX_SAFE_INTEGER)
        log(
          JSON.stringify({
            event: 'signup.volume',
            at: new Date(now).toISOString(),
            registrations_this_hour: count,
            alert_at: d.caps.registrationsAlertPerHour,
            ceiling: ceiling > 0 ? ceiling : null,
          }),
        );
    }
    return global;
  };
}
