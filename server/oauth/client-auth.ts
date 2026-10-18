import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * RFC 7523 private_key_jwt client authentication for metadata-document clients (ChatGPT
 * publishes token_endpoint_auth_method "private_key_jwt" with an RS256 `jwks_uri`). The client
 * signs a short-lived JWT whose iss and sub are its client_id; the server verifies it against the
 * keys in the client's metadata document (`jwks` or `jwks_uri`), never against keys named in the
 * JWT header.
 */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const ASSERTION_ALGS = ['RS256', 'ES256', 'EdDSA'] as const;
export type AssertionAlg = (typeof ASSERTION_ALGS)[number];
export const ASSERTION_LIMITS = {
  /** Longest accepted assertion (compact serialization). */
  maxLength: 8192,
  /** Tolerated clock difference for exp, nbf and iat. */
  skewMs: 60_000,
  /** exp may lie at most this far ahead; jti tombstones live until exp. */
  maxLifetimeMs: 15 * 60_000,
  /** Keys accepted in one JWKS. */
  maxKeys: 10,
} as const;

/** A refused client assertion: RFC 6749 invalid_client. */
export class ClientAuthError extends Error {}

export interface DecodedAssertion {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function part(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new ClientAuthError('The client assertion is not a valid JWT.');
  }
  if (!isRecord(value)) throw new ClientAuthError('The client assertion is not a valid JWT.');
  return value;
}

/** Splits a compact JWS; nothing in it is trusted until verifyAssertion succeeds. */
export function decodeAssertion(assertion: string): DecodedAssertion {
  const pieces = assertion.split('.');
  if (
    assertion.length > ASSERTION_LIMITS.maxLength ||
    pieces.length !== 3 ||
    !pieces.every((piece) => B64URL.test(piece))
  )
    throw new ClientAuthError('The client assertion is not a valid JWT.');
  return {
    header: part(pieces[0]!),
    claims: part(pieces[1]!),
    signingInput: `${pieces[0]}.${pieces[1]}`,
    signature: Buffer.from(pieces[2]!, 'base64url'),
  };
}

interface VerificationKey {
  kid?: string;
  alg: AssertionAlg;
  key: KeyObject;
}
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/**
 * Public signing keys from a client's JWK Set. Keys for other uses, unsupported types or curves,
 * RSA moduli under 2048 bits and keys carrying private members are refused.
 */
export function signingKeys(jwks: unknown): VerificationKey[] {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length === 0)
    throw new ClientAuthError('The client JWK Set has no keys.');
  if (jwks.keys.length > ASSERTION_LIMITS.maxKeys)
    throw new ClientAuthError('The client JWK Set has too many keys.');
  const keys: VerificationKey[] = [];
  for (const jwk of jwks.keys) {
    if (!isRecord(jwk)) continue;
    if (PRIVATE_MEMBERS.some((member) => member in jwk))
      throw new ClientAuthError('The client JWK Set publishes private key material.');
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    const alg: AssertionAlg | undefined =
      jwk.kty === 'RSA'
        ? 'RS256'
        : jwk.kty === 'EC' && jwk.crv === 'P-256'
          ? 'ES256'
          : jwk.kty === 'OKP' && jwk.crv === 'Ed25519'
            ? 'EdDSA'
            : undefined;
    if (!alg || (jwk.alg !== undefined && jwk.alg !== alg)) continue;
    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as never, format: 'jwk' });
    } catch {
      continue;
    }
    if (alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
    keys.push({ ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}), alg, key });
  }
  if (!keys.length) throw new ClientAuthError('The client JWK Set has no usable signing key.');
  return keys;
}

function signatureValid(decoded: DecodedAssertion, key: VerificationKey): boolean {
  const data = Buffer.from(decoded.signingInput);
  try {
    if (key.alg === 'RS256') return verify('sha256', data, key.key, decoded.signature);
    if (key.alg === 'ES256')
      return verify('sha256', data, { key: key.key, dsaEncoding: 'ieee-p1363' }, decoded.signature);
    return verify(null, data, key.key, decoded.signature);
  } catch {
    return false;
  }
}

/** Keys whose kid (when the JWT names one) and algorithm match the header. */
export function candidateKeys(
  decoded: DecodedAssertion,
  keys: readonly VerificationKey[],
): VerificationKey[] {
  const { alg, kid } = decoded.header;
  return keys.filter(
    (key) => key.alg === alg && (kid === undefined || (typeof kid === 'string' && key.kid === kid)),
  );
}

/**
 * Verifies a client assertion (RFC 7523 §3): a supported asymmetric algorithm and no critical
 * extensions; a signature by one of the client's keys; iss and sub equal to the client_id; an
 * audience naming this authorization server (its issuer or token endpoint); exp in the future and
 * at most 15 minutes ahead; nbf and iat not in the future; and a jti, which the caller records
 * as used. Returns the jti and expiry.
 */
export function verifyAssertion(
  decoded: DecodedAssertion,
  keys: readonly VerificationKey[],
  expected: { clientId: string; audiences: readonly string[]; now: number },
): { jti: string; expiresAt: number } {
  const { header, claims } = decoded;
  if (!(ASSERTION_ALGS as readonly unknown[]).includes(header.alg))
    throw new ClientAuthError('The client assertion must use RS256, ES256 or EdDSA.');
  if (header.crit !== undefined)
    throw new ClientAuthError('The client assertion uses unsupported critical header parameters.');
  const candidates = candidateKeys(decoded, keys);
  if (!candidates.length)
    throw new ClientAuthError('No key in the client JWK Set matches the client assertion.');
  if (!candidates.some((key) => signatureValid(decoded, key)))
    throw new ClientAuthError('The client assertion signature is invalid.');
  if (claims.iss !== expected.clientId || claims.sub !== expected.clientId)
    throw new ClientAuthError('The client assertion iss and sub must be the client_id.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((aud) => typeof aud === 'string' && expected.audiences.includes(aud)))
    throw new ClientAuthError('The client assertion audience is not this authorization server.');
  const seconds = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
  const exp = seconds(claims.exp);
  const { skewMs, maxLifetimeMs } = ASSERTION_LIMITS;
  if (exp === undefined || exp <= expected.now - skewMs)
    throw new ClientAuthError('The client assertion has expired.');
  if (exp > expected.now + maxLifetimeMs + skewMs)
    throw new ClientAuthError('The client assertion is valid for too long.');
  for (const name of ['nbf', 'iat'] as const) {
    if (claims[name] === undefined) continue;
    const at = seconds(claims[name]);
    if (at === undefined || at > expected.now + skewMs)
      throw new ClientAuthError(`The client assertion ${name} is invalid.`);
  }
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256)
    throw new ClientAuthError('The client assertion needs a jti.');
  // RFC 7519 allows a fractional NumericDate; the replay record stores whole milliseconds, rounded
  // up so the jti is kept at least until the assertion expires.
  return { jti: claims.jti, expiresAt: Math.ceil(exp) };
}
