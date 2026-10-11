/**
 * A message typed on /elric before signing in. It stays in this tab only (sessionStorage), is
 * never sent anywhere before sign-in, and is put back in the composer once Elric's chat opens
 * (never sent on its own). It is cleared when it is sent, or on "Not now".
 */
const KEY = 'cc_elric_pending_draft';
const MAX = 4000;

export function savePendingDraft(text: string): void {
  try {
    const value = text.trim() ? text.slice(0, MAX) : '';
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the draft just isn't kept.
  }
}

export function readPendingDraft(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function clearPendingDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
