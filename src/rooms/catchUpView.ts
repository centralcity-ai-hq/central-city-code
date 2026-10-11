import type { CatchUp, CatchUpSection } from '../../shared/elric-catch-up';

/**
 * What the "Catch me up" part of the New-since divider shows (Smart Rooms v2 preview), from the
 * catch-up hook's state (useCatchUp.ts). Pure, so the mapping is unit tested.
 *
 * - `collapsed`: nothing fetched yet (nothing billed): the "Catch me up" button.
 * - `loading`: Elric's thinking dots.
 * - `hidden`: nothing at all (Elric is off for everyone right now, or no such room).
 * - `unavailable`: one quiet line saying why there is no catch-up here (the host's Elric is
 *   off in this room, or the person is not eligible for Elric).
 * - `limited`: too many catch-ups just now: the rate-limit line with when to try again.
 * - `error`: the request failed: a plain retry.
 * - `ready`: the sections; `nothing` is the single quiet line; `notice` is the limit notice
 *   (daily allowance used up) and `retry` means Elric could not finish (try again).
 */
export type CatchUpView =
  | { kind: 'collapsed' }
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'unavailable'; text: string }
  | { kind: 'limited'; text: string }
  | { kind: 'error' }
  | {
      kind: 'ready';
      sections: CatchUpSection[];
      nothing: boolean;
      notice: string | null;
      retry: boolean;
    };

export const CATCH_UP_LIMIT_FALLBACK = 'Summaries used up for today.';

export const CATCH_UP_ROOM_OFF_TEXT = 'Catch-up needs Elric in this room.';
export const CATCH_UP_ACCOUNT_OFF_TEXT = 'Catch-up needs Elric on your account.';

/** The rate-limit line, with the wait rounded up to seconds or minutes. */
export function catchUpLimitedText(retryAfterMs?: number): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0)
    return 'Too many catch-ups just now. Try again in a moment.';
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 60)
    return `Too many catch-ups just now. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Too many catch-ups just now. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export function catchUpView(
  state:
    | { status: 'idle' | 'loading' | 'error' }
    | { status: 'off'; reason: 'room' | 'account' | null }
    | { status: 'limited'; retryAfterMs?: number }
    | { status: 'ready'; data: CatchUp },
): CatchUpView {
  switch (state.status) {
    case 'idle':
      return { kind: 'collapsed' };
    case 'loading':
      return { kind: 'loading' };
    case 'off':
      if (state.reason === 'room') return { kind: 'unavailable', text: CATCH_UP_ROOM_OFF_TEXT };
      if (state.reason === 'account')
        return { kind: 'unavailable', text: CATCH_UP_ACCOUNT_OFF_TEXT };
      return { kind: 'hidden' };
    case 'limited':
      return { kind: 'limited', text: catchUpLimitedText(state.retryAfterMs) };
    case 'error':
      return { kind: 'error' };
    case 'ready': {
      const { data } = state;
      const sections = data.sections.filter((section) => section.bullets.length > 0);
      const limit = data.incomplete === 'limit';
      return {
        kind: 'ready',
        sections,
        nothing: sections.length === 0 && !data.incomplete,
        notice: limit ? data.notice?.trim() || CATCH_UP_LIMIT_FALLBACK : null,
        retry: data.incomplete === 'unavailable',
      };
    }
  }
}
