import type { AssistantGrant } from '../../shared/assistant';

/*
 * The "Connected" group of Connect AI (src/ConnectApp.tsx). Its data is the account's AI access
 * grants (GET /api/assistant-access): an app that finished signing in over OAuth is a grant
 * labelled with the app's own client name; the local bridge's grants are listed the same way.
 * Settings → Connected apps (src/AssistantAccess.tsx) reviews and removes them. No React here, so
 * the rules load in unit tests.
 */

/** Grants that still work: not removed and not past their end, newest first. */
export function activeGrants(grants: readonly AssistantGrant[], now = Date.now()) {
  return grants
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > now)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Whole local calendar days from `from` to `to` (midnight to midnight). */
function calendarDays(from: number, to: number) {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * "Connected today", "Connected yesterday", "Connected 3 days ago" (up to 30 days), then the
 * date ("Connected on 4 Sept"). A time in the future (clock skew) is today.
 */
export function connectedSince(iso: string, now = Date.now(), locale?: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'Connected';
  const days = calendarDays(then, now);
  if (days <= 0) return 'Connected today';
  if (days === 1) return 'Connected yesterday';
  if (days < 30) return `Connected ${days} days ago`;
  return `Connected on ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(then)}`;
}
