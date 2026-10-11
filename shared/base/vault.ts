/*
 * The owner vault contract (docs/base/ARCHITECTURE.md §4, §11.1; Operation Base Wallet v1.1): one
 * vault per person account holds the owner key, encrypted in the browser with the wallet password
 * (scrypt + AES-256-GCM). The server stores the envelope and can never decrypt it. Every write
 * carries a proof signed by the owner key over a single-use server challenge, so a vault is only
 * ever stored or replaced by whoever holds that key. Browser and server import the same envelope
 * hash and typed data from here, so both sides sign and verify exactly the same message.
 *
 * The proof binds the WHOLE envelope, not only the ciphertext: the salt, IV and scrypt parameters
 * decide whether (and at what cost) the key can be decrypted again, so none of them can be swapped
 * under a valid signature.
 *
 *   envelopeHash = keccak256(abi.encode(
 *     uint256 envelopeVersion,                                   // 1
 *     bytes encryptedKey,
 *     (string alg, uint256 N, uint256 r, uint256 p, bytes salt) kdf,  // alg 'scrypt'
 *     (string alg, bytes iv) cipher))                            // alg 'AES-256-GCM'
 */
import { encodeAbiParameters, getAddress, keccak256, type Hex } from 'viem';
import type { Address } from './chains.js';
import { WALLET_CHAIN_ID } from './wallet-network.js';

/** The envelope encoding the hash commits to; a new layout gets a new version. */
export const VAULT_ENVELOPE_VERSION = 1;
/** scrypt resources the server accepts (v1.1 gate 1): N in [2^17, 2^20], r = 8, p = 1. */
export const VAULT_SCRYPT = { minN: 2 ** 17, maxN: 2 ** 20, r: 8, p: 1 } as const;
/** Salt: random, 16 to 32 bytes. AES-GCM IV: exactly 12 bytes. */
export const VAULT_SALT_BYTES = { min: 16, max: 32 } as const;
export const VAULT_IV_BYTES = 12;
/** The ciphertext (with its GCM tag): 17 to 1024 bytes. */
export const VAULT_CIPHERTEXT_BYTES = { min: 17, max: 1024 } as const;

export interface VaultKdf {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** 0x-prefixed hex. */
  salt: Hex;
}

export interface VaultCipher {
  alg: 'AES-256-GCM';
  /** 0x-prefixed hex, 12 bytes. */
  iv: Hex;
}

/** What the server stores and returns: the ciphertext and everything needed to decrypt it. */
export interface VaultEnvelope {
  encryptedKey: Hex;
  kdf: VaultKdf;
  cipher: VaultCipher;
}

/** An envelope as received, before the resource policy is checked (any algorithm name). */
export interface VaultEnvelopeInput {
  encryptedKey: Hex;
  kdf: { alg: string; N: number; r: number; p: number; salt: Hex };
  cipher: { alg: string; iv: Hex };
}

export type VaultPurpose = 'create' | 'rewrap';

/** The EIP-712 domain of every vault proof: pinned to the wallet network like every wallet route. */
export const VAULT_DOMAIN = { name: 'Central City Vault', version: '1', chainId: WALLET_CHAIN_ID };

export const VAULT_TYPES = {
  VaultCreate: [
    { name: 'accountId', type: 'string' },
    { name: 'ownerAddress', type: 'address' },
    { name: 'envelopeHash', type: 'bytes32' },
    { name: 'version', type: 'uint32' },
    { name: 'purpose', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
  ],
  BackupConfirmed: [
    { name: 'accountId', type: 'string' },
    { name: 'ownerAddress', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const ENVELOPE_ABI = [
  { name: 'envelopeVersion', type: 'uint256' },
  { name: 'encryptedKey', type: 'bytes' },
  {
    name: 'kdf',
    type: 'tuple',
    components: [
      { name: 'alg', type: 'string' },
      { name: 'N', type: 'uint256' },
      { name: 'r', type: 'uint256' },
      { name: 'p', type: 'uint256' },
      { name: 'salt', type: 'bytes' },
    ],
  },
  {
    name: 'cipher',
    type: 'tuple',
    components: [
      { name: 'alg', type: 'string' },
      { name: 'iv', type: 'bytes' },
    ],
  },
] as const;

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const byteLength = (hex: string) => (hex.length - 2) / 2;

function hexBytes(value: string, field: string): Hex {
  if (typeof value !== 'string' || !HEX_BYTES.test(value))
    throw new Error(`${field} must be hex bytes.`);
  return value.toLowerCase() as Hex;
}

function count(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer.`);
  return value;
}

/**
 * The envelope with exactly the hashed fields and lowercase hex: what the hash covers is what the
 * server stores and returns. Throws on anything that cannot be encoded.
 */
export function canonicalEnvelope(input: VaultEnvelopeInput): VaultEnvelopeInput {
  if (typeof input.kdf?.alg !== 'string' || typeof input.cipher?.alg !== 'string')
    throw new Error('The algorithms must be named.');
  return {
    encryptedKey: hexBytes(input.encryptedKey, 'encryptedKey'),
    kdf: {
      alg: input.kdf.alg,
      N: count(input.kdf.N, 'N'),
      r: count(input.kdf.r, 'r'),
      p: count(input.kdf.p, 'p'),
      salt: hexBytes(input.kdf.salt, 'salt'),
    },
    cipher: { alg: input.cipher.alg, iv: hexBytes(input.cipher.iv, 'iv') },
  };
}

/** keccak256 of the canonical ABI encoding of the whole envelope (see the header). */
export function envelopeHash(input: VaultEnvelopeInput): Hex {
  const envelope = canonicalEnvelope(input);
  return keccak256(
    encodeAbiParameters(ENVELOPE_ABI, [
      BigInt(VAULT_ENVELOPE_VERSION),
      envelope.encryptedKey,
      {
        alg: envelope.kdf.alg,
        N: BigInt(envelope.kdf.N),
        r: BigInt(envelope.kdf.r),
        p: BigInt(envelope.kdf.p),
        salt: envelope.kdf.salt,
      },
      { alg: envelope.cipher.alg, iv: envelope.cipher.iv },
    ]),
  );
}

/** True only for the scrypt parameters the server accepts (v1.1 gate 1); memory stays bounded. */
export function vaultKdfAllowed(kdf: VaultEnvelopeInput['kdf']): kdf is VaultKdf {
  const { N, r, p } = kdf;
  return (
    kdf.alg === 'scrypt' &&
    Number.isSafeInteger(N) &&
    N >= VAULT_SCRYPT.minN &&
    N <= VAULT_SCRYPT.maxN &&
    (N & (N - 1)) === 0 &&
    r === VAULT_SCRYPT.r &&
    p === VAULT_SCRYPT.p &&
    HEX_BYTES.test(kdf.salt) &&
    byteLength(kdf.salt) >= VAULT_SALT_BYTES.min &&
    byteLength(kdf.salt) <= VAULT_SALT_BYTES.max
  );
}

export function vaultCipherAllowed(cipher: VaultEnvelopeInput['cipher']): cipher is VaultCipher {
  return (
    cipher.alg === 'AES-256-GCM' &&
    HEX_BYTES.test(cipher.iv) &&
    byteLength(cipher.iv) === VAULT_IV_BYTES
  );
}

export function vaultCiphertextAllowed(encryptedKey: string): boolean {
  return (
    HEX_BYTES.test(encryptedKey) &&
    byteLength(encryptedKey) >= VAULT_CIPHERTEXT_BYTES.min &&
    byteLength(encryptedKey) <= VAULT_CIPHERTEXT_BYTES.max
  );
}

/** What the owner key signs to store (`create`) or replace (`rewrap`) the vault. */
export function vaultProofTypedData(input: {
  accountId: string;
  ownerAddress: Address;
  envelope: VaultEnvelopeInput;
  version: number;
  purpose: VaultPurpose;
  nonce: Hex;
}) {
  return {
    domain: VAULT_DOMAIN,
    types: VAULT_TYPES,
    primaryType: 'VaultCreate' as const,
    message: {
      accountId: input.accountId,
      ownerAddress: getAddress(input.ownerAddress),
      envelopeHash: envelopeHash(input.envelope),
      version: input.version,
      purpose: input.purpose,
      nonce: input.nonce,
    },
  };
}

/** What the owner key signs once the person has proven they saved the recovery phrase. */
export function backupConfirmedTypedData(input: {
  accountId: string;
  ownerAddress: Address;
  nonce: Hex;
}) {
  return {
    domain: VAULT_DOMAIN,
    types: VAULT_TYPES,
    primaryType: 'BackupConfirmed' as const,
    message: {
      accountId: input.accountId,
      ownerAddress: getAddress(input.ownerAddress),
      nonce: input.nonce,
    },
  };
}
