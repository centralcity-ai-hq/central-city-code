import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { decode32, otherSecretForms } from '../secret-env.js';

/**
 * The root key (KEK) for personal data stored by Sign in with Google: today only the date of
 * birth (docs/GOOGLE_SIGNIN.md "Date of birth"). Same shape as the responder's key ring, but its
 * own secret and derivation:
 *
 * - CITY_PII_KEK (32 bytes, base64 or base64url), CITY_PII_KEK_PREVIOUS during a rotation;
 * - the key that wraps data keys is HKDF-SHA256(the decoded secret, info 'central-city/pii-kek/v1');
 * - it must differ from every other secret, in every form;
 * - hosted without a valid key the feature is unavailable (the age stays unknown: fail closed);
 *   locally without it, a random per-process key is used (stored dates stop opening on restart);
 * - never derived from CITY_RATE_LIMIT_KEY, and never the responder's key.
 */
export interface PiiKey {
  kid: string;
  key: Buffer;
}
export type PiiKeyring =
  | { available: true; current: PiiKey; all: PiiKey[]; ephemeral: boolean }
  | { available: false; reason: 'missing' | 'invalid' | 'not_distinct' };

/** Public, non-secret id of a derived key. */
export function piiKeyId(key: Buffer): string {
  return `p_${createHash('sha256').update('central-city/pii-kid:').update(key).digest('hex').slice(0, 12)}`;
}

/** This keyring's own variables; every other deployment secret must differ (server/secret-env.ts). */
const OWN_SECRETS = ['CITY_PII_KEK', 'CITY_PII_KEK_PREVIOUS'] as const;

export function derivePiiKek(root: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'central-city/pii-kek/v1', 32));
}

let ephemeral: PiiKey | null = null;

export function piiKeys(
  env: Record<string, string | undefined>,
  options: { hosted: boolean },
): PiiKeyring {
  const raw = env.CITY_PII_KEK;
  if (!raw) {
    if (options.hosted) return { available: false, reason: 'missing' };
    if (!ephemeral) {
      const key = derivePiiKek(randomBytes(32));
      ephemeral = { kid: piiKeyId(key), key };
    }
    return { available: true, current: ephemeral, all: [ephemeral], ephemeral: true };
  }
  const current = decode32(raw);
  const previous = env.CITY_PII_KEK_PREVIOUS ? decode32(env.CITY_PII_KEK_PREVIOUS) : null;
  if (!current || (env.CITY_PII_KEK_PREVIOUS && !previous))
    return { available: false, reason: 'invalid' };
  const mine = [current, ...(previous ? [previous] : [])];
  for (const form of otherSecretForms(env, OWN_SECRETS))
    if (mine.some((key) => form.equals(key)) || form.equals(Buffer.from(raw)))
      return { available: false, reason: 'not_distinct' };
  const keys = [current, ...(previous && !previous.equals(current) ? [previous] : [])].map(
    (root) => {
      const key = derivePiiKek(root);
      return { kid: piiKeyId(key), key };
    },
  );
  return { available: true, current: keys[0]!, all: keys, ephemeral: false };
}
