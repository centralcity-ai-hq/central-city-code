import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption of a provider API key (docs/RESPONDER.md), Node crypto only.
 *
 *   dek         = 32 random bytes, one per stored key
 *   ciphertext  = nonce(12) | AES-256-GCM(dek, apiKey, aad) | tag(16)
 *   wrapped_dek = nonce(12) | AES-256-GCM(kek, dek, aad)    | tag(16)
 *   aad         = "central-city/responder-key/v1|" + credential id + "|" + agent + "|" + owner + "|" + provider
 *
 * The AAD binds both layers to their row: a ciphertext copied into another row fails to decrypt.
 * Callers pass and receive Buffers so plaintext can be zeroized (`.fill(0)`) after use; this module
 * zeroizes the data key and intermediate copies it creates.
 */
export interface CredentialBinding {
  id: string;
  agentId: string;
  ownerId: string;
  provider: string;
}
export function credentialAad(binding: CredentialBinding): Buffer {
  return Buffer.from(
    `central-city/responder-key/v1|${binding.id}|${binding.agentId}|${binding.ownerId}|${binding.provider}`,
  );
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < 12 + 16 + 1) throw new Error('sealed value too short');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  // Intermediate plaintext chunks are zeroed once copied (CCA-719); the caller zeroes the result.
  const parts: Buffer[] = [];
  try {
    parts.push(decipher.update(sealed.subarray(12, sealed.length - 16)));
    parts.push(decipher.final());
    return Buffer.concat(parts);
  } finally {
    for (const part of parts) part.fill(0);
  }
}

export function encryptApiKey(
  kek: Buffer,
  binding: CredentialBinding,
  apiKey: Buffer,
): { wrappedDek: Buffer; ciphertext: Buffer } {
  const aad = credentialAad(binding);
  const dek = randomBytes(32);
  try {
    return { ciphertext: seal(dek, apiKey, aad), wrappedDek: seal(kek, dek, aad) };
  } finally {
    dek.fill(0);
  }
}

/** Throws on a wrong key, a tampered value or a mismatched binding. The caller zeroizes the result. */
export function decryptApiKey(
  kek: Buffer,
  binding: CredentialBinding,
  sealed: { wrappedDek: Buffer; ciphertext: Buffer },
): Buffer {
  const aad = credentialAad(binding);
  const dek = open(kek, sealed.wrappedDek, aad);
  try {
    return open(dek, sealed.ciphertext, aad);
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps only the data key under a new root key (rotation); the ciphertext is unchanged. */
export function rewrapDek(
  from: Buffer,
  to: Buffer,
  binding: CredentialBinding,
  wrappedDek: Buffer,
): Buffer {
  const aad = credentialAad(binding);
  const dek = open(from, wrappedDek, aad);
  try {
    return seal(to, dek, aad);
  } finally {
    dek.fill(0);
  }
}
