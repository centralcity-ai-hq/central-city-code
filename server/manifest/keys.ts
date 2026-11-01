import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalize, sha256Hex } from './canonical.js';

/**
 * Ed25519 JWS (RFC 7515 / RFC 8037 "EdDSA") for Agent Card signatures. A2A v1.0 carries each
 * signature as `{protected, signature, header?}` — the JSON serialization of a JWS whose payload
 * is the RFC 8785 canonical form of the card with `signatures` removed. The payload is detached:
 * it is recomputed from the card on verification.
 */
export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}
export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}
export interface SerializedSigningKey {
  kid: string;
  /** Private JWK (contains `d`). Store encrypted; never publish. */
  jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; d: string };
}
export interface Jwks {
  keys: PublicJwk[];
}
export interface JwsSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const B64URL = /^[A-Za-z0-9_-]*$/;

/** RFC 7638 JWK thumbprint of an Ed25519 public key; used as the default `kid`. */
export function jwkThumbprint(x: string): string {
  return Buffer.from(sha256Hex(canonicalize({ crv: 'Ed25519', kty: 'OKP', x })), 'hex').toString(
    'base64url',
  );
}

function publicX(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string')
    throw new Error('Only Ed25519 keys are supported.');
  return jwk.x;
}

export function generateSigningKey(kid?: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid: kid ?? jwkThumbprint(publicX(publicKey)), privateKey, publicKey };
}

export function exportSigningKey(key: SigningKey): SerializedSigningKey {
  const jwk = key.privateKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.d)
    throw new Error('Only Ed25519 keys are supported.');
  return { kid: key.kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d } };
}

export function importSigningKey(serialized: SerializedSigningKey): SigningKey {
  const { jwk } = serialized;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')
    throw new Error('Only Ed25519 keys are supported.');
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = createPublicKey(privateKey);
  if (publicX(publicKey) !== jwk.x) throw new Error('Key pair does not match.');
  return { kid: serialized.kid, privateKey, publicKey };
}

export function publicJwk(key: Pick<SigningKey, 'kid' | 'publicKey'>): PublicJwk {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: publicX(key.publicKey),
    kid: key.kid,
    alg: 'EdDSA',
    use: 'sig',
  };
}

/** Public JWKS for publication. Keep retired keys listed until cards signed with them expire. */
export function exportJwks(keys: ReadonlyArray<Pick<SigningKey, 'kid' | 'publicKey'>>): Jwks {
  const kids = new Set<string>();
  for (const key of keys) {
    if (kids.has(key.kid)) throw new Error(`Duplicate kid ${key.kid}.`);
    kids.add(key.kid);
  }
  return { keys: keys.map(publicJwk) };
}

/** Signs a JSON payload; returns the detached JWS JSON-serialization members. */
export function signDetached(
  payload: unknown,
  key: SigningKey,
  extraHeader: Record<string, unknown> = {},
): JwsSignature {
  const header = { ...extraHeader, alg: 'EdDSA', typ: 'JOSE', kid: key.kid };
  const protectedHeader = b64url(canonicalize(header));
  const input = `${protectedHeader}.${b64url(canonicalize(payload))}`;
  return {
    protected: protectedHeader,
    signature: b64url(sign(null, Buffer.from(input), key.privateKey)),
  };
}

/** RFC 7515 Appendix F detached compact form: `<protected>..<signature>`. */
export const detachedCompact = (signature: JwsSignature) =>
  `${signature.protected}..${signature.signature}`;

export type VerifyResult = { valid: true; kid: string } | { valid: false; reason: string };

/** Clock skew tolerated for `iat` in the future, in seconds (CCA-617). */
export const SIGNATURE_CLOCK_SKEW_SECONDS = 300;

export interface VerifyOptions {
  /** Current time in milliseconds (default Date.now()). */
  now?: number;
  /** Refuse a signature without `iat` and `exp` in its protected header (Agent Cards, CCA-617). */
  requireTimes?: boolean;
}

const numericDate = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The protected header's `iat`/`exp` (RFC 7519 NumericDate, seconds) against `now`: an expired
 * signature, one issued in the future beyond the skew, or one whose window is empty never verifies.
 * A header without them is accepted unless `requireTimes`.
 */
function timesProblem(header: Record<string, unknown>, options: VerifyOptions): string | null {
  const hasIat = 'iat' in header;
  const hasExp = 'exp' in header;
  if (!hasIat && !hasExp) return options.requireTimes ? 'missing-exp' : null;
  if (!hasIat || !hasExp || !numericDate(header.iat) || !numericDate(header.exp))
    return 'malformed-times';
  const iat = header.iat as number;
  const exp = header.exp as number;
  if (exp <= iat) return 'malformed-times';
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (iat > nowSeconds + SIGNATURE_CLOCK_SKEW_SECONDS) return 'not-yet-valid';
  if (exp <= nowSeconds) return 'expired';
  return null;
}

export function verifyDetached(
  payload: unknown,
  signature: JwsSignature,
  jwks: Jwks,
  options: VerifyOptions = {},
): VerifyResult {
  if (
    typeof signature?.protected !== 'string' ||
    typeof signature.signature !== 'string' ||
    !B64URL.test(signature.protected) ||
    !B64URL.test(signature.signature) ||
    signature.protected.length > 2048
  )
    return { valid: false, reason: 'malformed' };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(signature.protected, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || Array.isArray(header))
    return { valid: false, reason: 'malformed' };
  if (header.alg !== 'EdDSA') return { valid: false, reason: 'unsupported-alg' };
  if ('crit' in header || 'b64' in header) return { valid: false, reason: 'unsupported-header' };
  if (typeof header.kid !== 'string') return { valid: false, reason: 'missing-kid' };
  const times = timesProblem(header, options);
  if (times) return { valid: false, reason: times };
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')
    return { valid: false, reason: 'unknown-kid' };
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  } catch {
    return { valid: false, reason: 'invalid-key' };
  }
  let payloadText: string;
  try {
    payloadText = canonicalize(payload);
  } catch {
    return { valid: false, reason: 'payload-not-canonicalizable' };
  }
  const input = Buffer.from(`${signature.protected}.${b64url(payloadText)}`);
  const ok = verify(null, input, publicKey, Buffer.from(signature.signature, 'base64url'));
  return ok ? { valid: true, kid: header.kid } : { valid: false, reason: 'bad-signature' };
}
