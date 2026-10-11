/*
 * Spender keystore (docs/base/ARCHITECTURE.md §4, §11.1). Each agent's spender key is a random
 * secp256k1 key, encrypted at rest with envelope encryption: a fresh data key per spender key
 * (AES-256-GCM), the data key wrapped by the key-encryption key from `CITY_BASE_SPENDER_KEK`.
 * The KEK is versioned so it can rotate; `spender_key_ref` = `v<kekVersion>:<keyId>`.
 *
 * Keys never leave this module: callers get the signer address and an opaque ref, and sign only
 * through `withSigner`. Plaintext buffers are zeroed after use; the viem account built inside
 * `withSigner` keeps its own string copy that JavaScript cannot wipe, so it must never outlive
 * the callback (it becomes garbage when `use` returns). Both GCM layers bind
 * keyId||kekVersion as additional data, so ciphertexts cannot be swapped between rows.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Address } from '../../../shared/base/chains.js';

export interface StoredSpenderKey {
  keyId: string;
  kekVersion: number;
  wrappedDek: Uint8Array;
  ciphertext: Uint8Array;
  signerAddress: Address;
  createdAt: number;
  committedAt: number | null;
}

/** Persistence for encrypted keys (the `base_spender_keys` table in production). */
export interface SpenderKeyStore {
  insert(row: StoredSpenderKey): Promise<void>;
  get(keyId: string): Promise<StoredSpenderKey | null>;
}

/** KEKs by version; the highest version encrypts new keys, any listed version decrypts. */
export interface KeyEncryptionKeys {
  current: number;
  keys: ReadonlyMap<number, Uint8Array>;
}

const REF = /^v([1-9][0-9]{0,5}):([0-9a-f-]{36})$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Parses `CITY_BASE_SPENDER_KEK`: comma-separated `v<version>:<base64 32 bytes>` entries, e.g.
 * `v1:...,v2:...`. The highest version is current. Refuses anything malformed.
 */
export function parseKeks(value: string | undefined): KeyEncryptionKeys {
  if (!value) throw new Error('CITY_BASE_SPENDER_KEK is not set.');
  const keys = new Map<number, Uint8Array>();
  for (const entry of value.split(',')) {
    const match = /^v([1-9][0-9]{0,5}):([A-Za-z0-9+/]{43}=)$/.exec(entry.trim());
    if (!match) throw new Error('CITY_BASE_SPENDER_KEK has a malformed entry.');
    const key = Buffer.from(match[2], 'base64');
    if (key.length !== 32) throw new Error('Each KEK must be 32 bytes.');
    if (keys.has(Number(match[1]))) throw new Error('CITY_BASE_SPENDER_KEK lists a version twice.');
    keys.set(Number(match[1]), key);
  }
  return { current: Math.max(...keys.keys()), keys };
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES + 1) throw new Error('Sealed key is too short.');
  const buffer = Buffer.from(sealed);
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, IV_BYTES));
  decipher.setAAD(aad);
  decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(buffer.subarray(IV_BYTES, buffer.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

const aadFor = (keyId: string, kekVersion: number) => Buffer.from(`${keyId}|${kekVersion}`, 'utf8');

export function parseKeyRef(ref: string): { kekVersion: number; keyId: string } {
  const match = REF.exec(ref);
  if (!match) throw new Error('Malformed spender key ref.');
  return { kekVersion: Number(match[1]), keyId: match[2] };
}

export function createKeystore(deps: {
  store: SpenderKeyStore;
  keks: KeyEncryptionKeys;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;

  return {
    /** Creates and stores a new spender key; returns only public data and the opaque ref. */
    async createSpenderKey(): Promise<{ signer: Address; keyRef: string }> {
      const keyId = randomUUID();
      const kekVersion = deps.keks.current;
      const kek = deps.keks.keys.get(kekVersion)!;
      const aad = aadFor(keyId, kekVersion);
      const secret = randomBytes(32);
      const dek = randomBytes(32);
      try {
        const signer = privateKeyToAccount(`0x${secret.toString('hex')}`).address;
        await deps.store.insert({
          keyId,
          kekVersion,
          wrappedDek: seal(kek, dek, aad),
          ciphertext: seal(dek, secret, aad),
          signerAddress: signer,
          createdAt: now(),
          committedAt: null,
        });
        return { signer, keyRef: `v${kekVersion}:${keyId}` };
      } finally {
        secret.fill(0);
        dek.fill(0);
      }
    },

    /**
     * Runs `use` with the decrypted signer, then zeroes the plaintext. The account object must not
     * escape `use`; sign inside it and return only signatures.
     */
    async withSigner<T>(
      keyRef: string,
      use: (signer: PrivateKeyAccount) => Promise<T>,
    ): Promise<T> {
      const { kekVersion, keyId } = parseKeyRef(keyRef);
      const row = await deps.store.get(keyId);
      if (!row || row.kekVersion !== kekVersion) throw new Error('Spender key not found.');
      const kek = deps.keks.keys.get(kekVersion);
      if (!kek) throw new Error('Key-encryption key version is not available.');
      const aad = aadFor(keyId, kekVersion);
      const dek = open(kek, row.wrappedDek, aad);
      let secret: Buffer | null = null;
      try {
        secret = open(dek, row.ciphertext, aad);
        const signer = privateKeyToAccount(`0x${secret.toString('hex')}`);
        if (signer.address !== row.signerAddress)
          throw new Error('Spender key does not match its address.');
        return await use(signer);
      } finally {
        dek.fill(0);
        secret?.fill(0);
      }
    },
  };
}
