import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption of one personal value, Node crypto only (the responder's pattern, its own
 * key ring and labels):
 *
 *   dek         = 32 random bytes, one per stored value
 *   ciphertext  = nonce(12) | AES-256-GCM(dek, plaintext, aad) | tag(16)
 *   wrapped_dek = nonce(12) | AES-256-GCM(kek, dek, aad)       | tag(16)
 *   aad         = "central-city/pii/v1|" + purpose + "|" + operator id
 *
 * The AAD binds both layers to the account and the purpose: a value copied to another account or
 * read for another purpose does not open. Not exported from server/google: only pii.ts uses it.
 */
export type PiiPurpose = 'date_of_birth';

export function piiAad(purpose: PiiPurpose, operatorId: string): Buffer {
  return Buffer.from(`central-city/pii/v1|${purpose}|${operatorId}`);
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

export function sealPii(
  kek: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): { wrappedDek: Buffer; ciphertext: Buffer } {
  const dek = randomBytes(32);
  try {
    return { ciphertext: seal(dek, plaintext, aad), wrappedDek: seal(kek, dek, aad) };
  } finally {
    dek.fill(0);
  }
}

/** Throws on a wrong key, a tampered value or another account or purpose. */
export function openPii(
  kek: Buffer,
  aad: Buffer,
  sealed: { wrappedDek: Buffer; ciphertext: Buffer },
): Buffer {
  const dek = open(kek, sealed.wrappedDek, aad);
  try {
    return open(dek, sealed.ciphertext, aad);
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps only the data key under a new root key (rotation); the ciphertext is unchanged. */
export function rewrapPiiDek(from: Buffer, to: Buffer, aad: Buffer, wrappedDek: Buffer): Buffer {
  const dek = open(from, wrappedDek, aad);
  try {
    return seal(to, dek, aad);
  } finally {
    dek.fill(0);
  }
}
