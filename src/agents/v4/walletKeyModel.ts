import { parseBackupKey, passwordProblem } from '../../base/vault';

/*
 * The checks of the wallet key's two forms (WalletKeyScreens.tsx): restore with the backup key,
 * and change the password. Each runs before anything is read or sent, and says what’s wrong in
 * plain words; none of them echoes the key or a password.
 */

export const RESTORED = 'Restored. Your new password works from now on.';
export const PASSWORD_CHANGED = 'Password changed.';
export const NOT_THE_SAME = 'The two passwords aren’t the same.';

/** A new password, typed twice: the vault’s own rules first (passwordProblem), then the repeat. */
export function newPasswordProblem(password: string, repeat: string): string | null {
  return passwordProblem(password) ?? (password === repeat ? null : NOT_THE_SAME);
}

/** The backup key as typed (parseBackupKey forgives spaces, dashes and 0x), then the password. */
export function restoreProblem(backupKey: string, password: string, repeat: string): string | null {
  if (!backupKey.trim()) return 'Type or paste your backup key.';
  const parsed = parseBackupKey(backupKey);
  if (!parsed.ok) return parsed.reason;
  return newPasswordProblem(password, repeat);
}

/** The current password opens the key on submit; here only that a new one is really new. */
export function changeProblem(current: string, password: string, repeat: string): string | null {
  if (!current) return 'Type your current password.';
  if (password === current) return 'The new password is the same as the current one.';
  return newPasswordProblem(password, repeat);
}
