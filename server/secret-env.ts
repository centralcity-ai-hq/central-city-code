/**
 * Every environment variable of the deployment that holds a secret, in one list. The key-encryption
 * keys (CITY_RESPONDER_KEK, CITY_PII_KEK) must differ from all of them in every byte form, so a
 * secret configured twice cannot unlock more than its own purpose. tests/secret-env.test.ts fails
 * when server code reads a secret-looking variable that is in neither list below.
 */
export const DEPLOYMENT_SECRET_NAMES = [
  'CITY_RATE_LIMIT_KEY',
  'CITY_WAKE_SECRET',
  'CITY_WAKE_SECRET_PREVIOUS',
  'CITY_SIGNING_KEY',
  'CITY_SIGNING_KEY_PREVIOUS',
  'CITY_RESPONDER_KEK',
  'CITY_RESPONDER_KEK_PREVIOUS',
  'CITY_PII_KEK',
  'CITY_PII_KEK_PREVIOUS',
  'CITY_BASE_SPENDER_KEK',
  'CITY_EMAIL_LINK_KEY',
  'CITY_EMAIL_LINK_KEY_PREVIOUS',
  'CITY_EMAIL_API_KEY',
  // Ops secrets and their rotation overlap (server/elric/ops.ts reads `<SETTING>_PREVIOUS`).
  'CITY_OPS_SECRET',
  'CITY_OPS_SECRET_PREVIOUS',
  'CITY_OPS_KEYS_SECRET',
  'CITY_OPS_KEYS_SECRET_PREVIOUS',
  'CITY_OPS_METRICS_SECRET',
  'CITY_OPS_METRICS_SECRET_PREVIOUS',
  'CITY_OPS_EMAIL_SECRET',
  'CITY_OPS_EMAIL_SECRET_PREVIOUS',
  'CITY_OPS_ELRIC_SECRET',
  'CITY_OPS_ELRIC_SECRET_PREVIOUS',
  'CITY_OPS_REVIEW_SECRET',
  'CITY_OPS_REVIEW_SECRET_PREVIOUS',
  'CITY_ELRIC_MODEL_KEY',
  'CITY_ELRIC_ANTHROPIC_KEY',
  'CITY_GITHUB_APP_PRIVATE_KEY',
  'CITY_CODE_COUNT_GITHUB_TOKEN',
  'CRON_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'DATABASE_URL',
] as const;

/**
 * Names that look like secrets but are not: key references (`v<n>:<id>` pointers into the
 * encrypted keystore), public keys, numeric limits and code constants.
 */
export const NOT_SECRET_NAMES = [
  'CITY_SIGNING_KEY_NEXT',
  'CITY_BASE_PAYMASTER_SIGNER_KEY_REF',
  'CITY_BASE_SUBMITTER_KEY_REFS',
  'CITY_ARC_FACILITATOR_KEY_REF',
  'CITY_ARC_PAYMASTER_SIGNER_KEY_REF',
  'CITY_ARC_SUBMITTER_KEY_REFS',
  'CITY_SFP_SPONSOR_KEY_REF', // gitleaks:allow (a setting name, not a key)
  'CITY_X402_FACILITATOR_KEY_REF',
  'CITY_X402_PUBLIC_SETTLE_KEY_REF',
  'CITY_X402_PUBLIC_OFFER_KEY_REF',
  'CITY_LIMIT_WORKSPACE_KEYS_PER_WORKSPACE',
  'GOOGLE_SALT_NO_PASSWORD',
  // On/off switch for the key-role guard (server/base/chain/key-roles.ts), not key material.
  'CITY_KEY_ROLES_ENFORCE',
] as const;

/** 32 bytes from standard or URL-safe base64, else null. */
export function decode32(value: string): Buffer | null {
  const text = value.trim();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length === 32 ? bytes : null;
}

/** Every byte form one secret value could take: raw, trimmed, decoded base64 and hex. */
function forms(value: string): Buffer[] {
  const out: Buffer[] = [Buffer.from(value, 'utf8'), Buffer.from(value.trim(), 'utf8')];
  const b64 = decode32(value);
  if (b64) out.push(b64);
  if (/^[0-9a-f]{64}$/i.test(value.trim())) out.push(Buffer.from(value.trim(), 'hex'));
  return out;
}

/**
 * The byte forms of every deployment secret except `exclude` (the caller's own variables).
 * CITY_BASE_SPENDER_KEK is a list of `v<n>:<base64>` entries, each used directly as a key, so each
 * entry is compared on its own as well.
 */
export function otherSecretForms(
  env: Record<string, string | undefined>,
  exclude: readonly string[],
): Buffer[] {
  const out: Buffer[] = [];
  for (const name of DEPLOYMENT_SECRET_NAMES) {
    if (exclude.includes(name)) continue;
    const value = env[name];
    if (!value) continue;
    out.push(...forms(value));
    if (name === 'CITY_BASE_SPENDER_KEK')
      for (const entry of value.split(',')) {
        const match = /^v[0-9]+:(.+)$/.exec(entry.trim());
        if (match) out.push(...forms(match[1]!));
      }
  }
  return out;
}
