import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { decode32, otherSecretForms } from '../secret-env.js';

/**
 * The responder root key (KEK) that wraps every stored provider key's data key (docs/RESPONDER.md).
 * It follows `wakeKeys` (server/wake/webhooks.ts) in shape
 * (current first, a PREVIOUS key during a rotation, a public fingerprint as kid) but differs on
 * purpose:
 *
 * - no HKDF fallback from CITY_RATE_LIMIT_KEY in hosted mode: stored ciphertext cannot be re-minted,
 *   and that widely used secret must not also unlock third-party credentials. Hosted without a
 *   valid CITY_RESPONDER_KEK, the feature is unavailable;
 * - it must be distinct from every other secret;
 * - locally without it, a random per-process key is used (stored keys stop working on restart);
 * - the key actually used to wrap data keys is HKDF-SHA256(the decoded variable, info
 *   'central-city/responder-kek/v1'), so the configured secret itself never touches ciphertext
 *   and a future purpose gets its own subkey.
 */
export interface ResponderKey {
  kid: string;
  key: Buffer;
}
export type ResponderKeyring =
  | { available: true; current: ResponderKey; all: ResponderKey[]; ephemeral: boolean }
  | { available: false; reason: 'missing' | 'invalid' | 'not_distinct' };

/** Public, non-secret id of a root key (a different domain string from the wake kid). */
export function responderKeyId(key: Buffer): string {
  return `k_${createHash('sha256').update('central-city/responder-kid:').update(key).digest('hex').slice(0, 12)}`;
}

/** This keyring's own variables; every other deployment secret must differ (server/secret-env.ts). */
const OWN_SECRETS = ['CITY_RESPONDER_KEK', 'CITY_RESPONDER_KEK_PREVIOUS'] as const;

/** The key-encryption key: HKDF-SHA256 of the configured root, bound to this one purpose. */
export function deriveKek(root: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', root, Buffer.alloc(0), 'central-city/responder-kek/v1', 32),
  );
}

export function responderKeys(
  env: Record<string, string | undefined>,
  options: { hosted: boolean },
): ResponderKeyring {
  const raw = env.CITY_RESPONDER_KEK;
  if (!raw) {
    if (options.hosted) return { available: false, reason: 'missing' };
    const key = randomBytes(32);
    const current = { kid: responderKeyId(key), key };
    return { available: true, current, all: [current], ephemeral: true };
  }
  const current = decode32(raw);
  const previous = env.CITY_RESPONDER_KEK_PREVIOUS
    ? decode32(env.CITY_RESPONDER_KEK_PREVIOUS)
    : null;
  if (!current || (env.CITY_RESPONDER_KEK_PREVIOUS && !previous))
    return { available: false, reason: 'invalid' };
  for (const form of otherSecretForms(env, OWN_SECRETS))
    if (
      form.equals(current) ||
      (previous && form.equals(previous)) ||
      form.equals(Buffer.from(raw))
    )
      return { available: false, reason: 'not_distinct' };
  const keys = [current, ...(previous && !previous.equals(current) ? [previous] : [])].map(
    (root) => {
      const key = deriveKek(root);
      return { kid: responderKeyId(key), key };
    },
  );
  return { available: true, current: keys[0]!, all: keys, ephemeral: false };
}
