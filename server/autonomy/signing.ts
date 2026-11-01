import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import {
  exportJwks,
  generateSigningKey,
  jwkThumbprint,
  type Jwks,
  type SigningKey,
} from '../manifest/keys.js';

/**
 * Platform Agent Card signing key (Ed25519). Loaded from `CITY_SIGNING_KEY` as either a private
 * Ed25519 JWK (JSON, optionally `{kid, jwk}`) or base64 PKCS#8 DER. Without it, development and
 * tests use an ephemeral key (with a warning); production deployments refuse to start
 * (assertHostedSigningKey), while a Vercel preview or an injected `null` serves cards unsigned
 * (flagged).
 *
 * Rotation without a verification gap (docs/REMOTE_MCP.md#agent-cards-and-signing):
 * - `CITY_SIGNING_KEY_NEXT`: the public JWK of the key that will sign next. It is published in
 *   the JWKS ahead of time and never signs, so verifiers that cached the JWKS already know it
 *   when it starts signing.
 * - `CITY_SIGNING_KEY_PREVIOUS`: one retired key or a JSON array of them, published for
 *   verification only. Public-only JWKs (`{kty, crv, x, kid}`) are the expected form; a private
 *   key there is reduced to its public half (with a warning) and never kept in memory.
 * Keys are compared by their public key material, never by `kid` alone.
 */
export interface VerificationKey {
  kid: string;
  publicKey: KeyObject;
}
export interface PlatformSigner {
  key: SigningKey | null;
  /** Retired keys from CITY_SIGNING_KEY_PREVIOUS (public halves only), verification only. */
  previous: VerificationKey[];
  /** The pre-published next key from CITY_SIGNING_KEY_NEXT (public only). It never signs. */
  next: VerificationKey | null;
  /** True when the key was generated for this process only (cards stop verifying on restart). */
  ephemeral: boolean;
  jwks(): Jwks;
}

const KID = /^[A-Za-z0-9._-]{1,128}$/;

function fromJwk(value: Record<string, unknown>): SigningKey {
  const jwk = (value.jwk && typeof value.jwk === 'object' ? value.jwk : value) as Record<
    string,
    unknown
  >;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string')
    throw new Error('CITY_SIGNING_KEY must be a private Ed25519 JWK or PKCS#8 key.');
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: String(jwk.x ?? '') },
    format: 'jwk',
  });
  return withKid(privateKey, typeof value.kid === 'string' ? value.kid : jwk.kid);
}

function withKid(privateKey: ReturnType<typeof createPrivateKey>, kid: unknown): SigningKey {
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('CITY_SIGNING_KEY must be an Ed25519 key.');
  const publicKey = createPublicKey(privateKey);
  const x = publicKey.export({ format: 'jwk' }).x!;
  return {
    kid: typeof kid === 'string' && KID.test(kid) ? kid : jwkThumbprint(x),
    privateKey,
    publicKey,
  };
}

export function parseSigningKey(raw: string): SigningKey {
  const text = raw.trim();
  try {
    if (text.startsWith('{')) return fromJwk(JSON.parse(text) as Record<string, unknown>);
    if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) throw new Error('not base64');
    return withKid(
      createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' }),
      undefined,
    );
  } catch {
    // Never echo key material in errors.
    throw new Error('CITY_SIGNING_KEY is not a valid Ed25519 private JWK or base64 PKCS#8 key.');
  }
}

/** The base64url `x` of an Ed25519 public key: the key material keys are compared by. */
function rawX(publicKey: KeyObject): string {
  return publicKey.export({ format: 'jwk' }).x!;
}

/**
 * One verification-only key: a public Ed25519 JWK (optionally `{kid, jwk}`), or a private JWK /
 * base64 PKCS#8 key, which is reduced to its public half. Reports whether private material was
 * supplied so the caller can warn. Never echoes key material.
 */
function parseVerificationKey(
  value: unknown,
  name: string,
): { key: VerificationKey; hadPrivate: boolean } {
  const fail = (): never => {
    throw new Error(`${name} is not a valid Ed25519 public JWK, private JWK or base64 PKCS#8 key.`);
  };
  try {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.startsWith('{')) return parseVerificationKey(JSON.parse(text), name);
      const key = parseSigningKey(text);
      return { key: { kid: key.kid, publicKey: key.publicKey }, hadPrivate: true };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const outer = value as Record<string, unknown>;
    const jwk = (outer.jwk && typeof outer.jwk === 'object' ? outer.jwk : outer) as Record<
      string,
      unknown
    >;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') return fail();
    if (typeof jwk.d === 'string') {
      const key = fromJwk(outer);
      return { key: { kid: key.kid, publicKey: key.publicKey }, hadPrivate: true };
    }
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      format: 'jwk',
    });
    const kid = typeof outer.kid === 'string' ? outer.kid : jwk.kid;
    return {
      key: {
        kid: typeof kid === 'string' && KID.test(kid) ? kid : jwkThumbprint(rawX(publicKey)),
        publicKey,
      },
      hadPrivate: false,
    };
  } catch {
    return fail();
  }
}

/** CITY_SIGNING_KEY_PREVIOUS: one key, or a JSON array of keys (oldest retired keys included). */
function parseVerificationKeys(
  raw: string,
  name: string,
): Array<{ key: VerificationKey; hadPrivate: boolean }> {
  const text = raw.trim();
  if (!text.startsWith('[')) return [parseVerificationKey(text, name)];
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not a valid JSON array of Ed25519 keys.`);
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > 16)
    throw new Error(`${name} must list between 1 and 16 Ed25519 keys.`);
  return list.map((item) => parseVerificationKey(item, name));
}

/**
 * Production deployments refuse to start without a platform signing key, so Agent Cards and the
 * daily count checkpoints are never served or sealed unsigned by a missing setting. The caller
 * decides which deployments are production (signingKeyRequired in server/app.ts).
 */
export function assertHostedSigningKey(env: NodeJS.ProcessEnv): void {
  if (!env.CITY_SIGNING_KEY?.trim())
    throw new Error(
      'CITY_SIGNING_KEY must be set on a production deployment (Vercel production, or CITY_HOSTED=1 outside Vercel); refusing to start without a platform signing key.',
    );
}

const warned = new Set<string>();
/** Emits each distinct warning once per process. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(message);
}

export function loadPlatformSigner(
  env: NodeJS.ProcessEnv,
  hosted: boolean,
  warn: (message: string) => void = warnOnce,
  injected?: SigningKey | null,
): PlatformSigner {
  let key: SigningKey | null = null;
  let ephemeral = false;
  if (injected !== undefined) key = injected;
  else if (env.CITY_SIGNING_KEY) key = parseSigningKey(env.CITY_SIGNING_KEY);
  else if (!hosted) {
    key = generateSigningKey();
    ephemeral = true;
    warn(
      'CITY_SIGNING_KEY is not set; Agent Cards are signed with an ephemeral development key that changes on restart.',
    );
  } else warn('CITY_SIGNING_KEY is not set; hosted Agent Cards are served unsigned (flagged).');
  // Every published key, current first. A key whose material is already listed is skipped; a
  // different key under an already listed kid is a configuration error: verifiers pick the key by
  // kid, so one of the two would read genuine signatures as forged.
  const published: Array<Pick<SigningKey, 'kid' | 'publicKey'>> = key ? [key] : [];
  const add = (candidate: VerificationKey, name: string): boolean => {
    const x = rawX(candidate.publicKey);
    if (published.some((item) => rawX(item.publicKey) === x)) return false;
    if (published.some((item) => item.kid === candidate.kid))
      throw new Error(
        `${name} has kid "${candidate.kid}", which another signing key already uses; give each key its own kid (or omit kid to use the RFC 7638 thumbprint).`,
      );
    published.push(candidate);
    return true;
  };
  // Pre-published next key: verification only until it becomes CITY_SIGNING_KEY.
  let next: VerificationKey | null = null;
  if (env.CITY_SIGNING_KEY_NEXT) {
    const parsed = parseVerificationKey(env.CITY_SIGNING_KEY_NEXT, 'CITY_SIGNING_KEY_NEXT');
    if (parsed.hadPrivate)
      throw new Error(
        'CITY_SIGNING_KEY_NEXT must be a public Ed25519 JWK ({kty, crv, x, kid}); it never signs, so its private key does not belong here.',
      );
    if (add(parsed.key, 'CITY_SIGNING_KEY_NEXT')) next = parsed.key;
  }
  // Retired keys stay in the JWKS for verification while cards and checkpoints they signed are
  // still checked. They never sign, so only their public halves are kept.
  const previous: VerificationKey[] = [];
  if (env.CITY_SIGNING_KEY_PREVIOUS) {
    for (const parsed of parseVerificationKeys(
      env.CITY_SIGNING_KEY_PREVIOUS,
      'CITY_SIGNING_KEY_PREVIOUS',
    )) {
      if (parsed.hadPrivate)
        warn(
          'CITY_SIGNING_KEY_PREVIOUS holds a private key; only its public half is used. Replace it with the public JWK and destroy the retired private key.',
        );
      if (add(parsed.key, 'CITY_SIGNING_KEY_PREVIOUS')) previous.push(parsed.key);
    }
  }
  return { key, previous, next, ephemeral, jwks: () => exportJwks(published) };
}
