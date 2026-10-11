/*
 * The backup key (the product owner, 10 Oct 2026): the owner key itself as one long string, 64 hex
 * characters shown once in 16 numbered groups of 4. Restoring types it back in. A typo still parses
 * as a key, but as another key: restore checks that it opens the same owner address before using
 * it.
 */
import type { Hex } from 'viem';

export const BACKUP_KEY_LENGTH = 64;
export const BACKUP_GROUP_SIZE = 4;
export const BACKUP_GROUPS = BACKUP_KEY_LENGTH / BACKUP_GROUP_SIZE;
/** secp256k1's group order: a private key is in [1, n - 1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** "7f3a 9c21 …": the 16 groups of a private key, without the 0x. */
export function backupGroups(privateKey: Hex): string[] {
  const body = privateKey.slice(2).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(body)) throw new Error('Not a private key.');
  return body.match(/.{4}/g)!;
}

export type ParsedBackupKey = { ok: true; privateKey: Hex } | { ok: false; reason: string };

/**
 * A backup key as typed or pasted: spaces, dashes and line breaks are ignored, case doesn't
 * matter, a leading 0x is allowed. Says what's wrong in plain words; never echoes the key.
 */
export function parseBackupKey(text: string): ParsedBackupKey {
  const body = text
    .trim()
    .replace(/^0x/i, '')
    .replace(/[\s-]+/g, '')
    .toLowerCase();
  if (/[^0-9a-f]/.test(body))
    return { ok: false, reason: 'A backup key has only the digits 0–9 and the letters a–f.' };
  if (body.length !== BACKUP_KEY_LENGTH)
    return {
      ok: false,
      reason: `A backup key has ${BACKUP_KEY_LENGTH} characters; this has ${body.length}.`,
    };
  const value = BigInt(`0x${body}`);
  if (value === 0n || value >= SECP256K1_N)
    return { ok: false, reason: 'This isn’t a valid backup key. Check it against your copy.' };
  return { ok: true, privateKey: `0x${body}` };
}

/** Two different groups (1-based) for the person to type back, never the same pair twice in a row. */
export function pickConfirmGroups(random: () => number = Math.random): [number, number] {
  const first = 1 + Math.floor(random() * BACKUP_GROUPS);
  let second = 1 + Math.floor(random() * (BACKUP_GROUPS - 1));
  if (second >= first) second += 1;
  return first < second ? [first, second] : [second, first];
}

/** Whether a typed group (1-based) matches the key; spaces and case are forgiven. */
export function groupMatches(privateKey: Hex, group: number, typed: string): boolean {
  if (!Number.isInteger(group) || group < 1 || group > BACKUP_GROUPS) return false;
  return backupGroups(privateKey)[group - 1] === typed.replace(/\s+/g, '').toLowerCase();
}
