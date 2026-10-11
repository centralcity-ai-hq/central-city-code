/*
 * The owner key in the browser (Operation Base Wallet W1): created here, locked with the wallet
 * password (scrypt, then AES-256-GCM) and only the locked envelope leaves the browser. The
 * parameters are the vault contract's (shared/base/vault.ts); an envelope the contract wouldn't
 * accept is never opened, so a server can't make the browser derive with weak parameters.
 */
import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  VAULT_SCRYPT,
  vaultCipherAllowed,
  vaultCiphertextAllowed,
  vaultKdfAllowed,
  type VaultEnvelope,
  type VaultEnvelopeInput,
} from '../../../shared/base/vault';

/** The cost the browser asks for: the contract's minimum (≈128 MB, about a second on a laptop). */
export const VAULT_N = VAULT_SCRYPT.minN;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
/** Binds the ciphertext to its use: a vault key blob opens only as a vault key. */
const AAD = new TextEncoder().encode('Central City vault key v1');

export class VaultCryptoError extends Error {
  constructor(
    readonly code: 'wrong_password' | 'unsupported_envelope' | 'wrong_owner' | 'weak_password',
    message: string,
  ) {
    super(message);
  }
}

/** The shortest wallet password accepted (the setup screen says the same). */
export const MIN_PASSWORD_LENGTH = 12;
const COMMON = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'qwertyuiopas',
  'aaaaaaaaaaaa',
  'centralcity1',
  'centralcity12',
]);

/**
 * Why a wallet password can't lock a key, or null when it can: at least 12 characters, more than
 * one repeated character, no run up the keyboard or the digits, not a common one. Checked before
 * anything is derived or stored, for every lock (create, a new password, a restore).
 */
export function passwordProblem(password: string): string | null {
  const value = password.normalize('NFKC');
  if ([...value].length < MIN_PASSWORD_LENGTH)
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (/^(.)\1+$/u.test(value)) return 'Use more than one repeated character.';
  const lower = value.toLowerCase();
  if (
    COMMON.has(lower) ||
    '01234567890123456789'.includes(lower) ||
    'abcdefghijklmnopqrstuvwxyz'.includes(lower) ||
    'qwertyuiopasdfghjklzxcvbnm'.includes(lower)
  )
    return 'That password is too easy to guess. Use a longer, less common one.';
  return null;
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
/** Web Crypto wants bytes over a plain ArrayBuffer; these always are (never shared memory). */
const plainBytes = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

/** The password as bytes: Unicode-normalized, so the same password typed elsewhere opens it. */
const passwordBytes = (password: string) => new TextEncoder().encode(password.normalize('NFKC'));

async function derive(password: string, salt: Uint8Array, N: number): Promise<CryptoKey> {
  const raw = await scryptAsync(passwordBytes(password), salt, {
    N,
    r: VAULT_SCRYPT.r,
    p: VAULT_SCRYPT.p,
    dkLen: KEY_BYTES,
  });
  try {
    return await crypto.subtle.importKey('raw', plainBytes(raw), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  } finally {
    raw.fill(0);
  }
}

/** A new owner key (never leaves this browser unlocked) and its address. */
export function createOwnerKey(): { privateKey: Hex; address: Hex } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/** Locks a private key with the password: the envelope the vault stores (exactly its fields). */
export async function sealKey(
  privateKey: Hex,
  password: string,
  options: { N?: number } = {},
): Promise<VaultEnvelope> {
  const problem = passwordProblem(password);
  if (problem) throw new VaultCryptoError('weak_password', problem);
  const N = options.N ?? VAULT_N;
  // The cost is checked before deriving: never a derivation with parameters the contract refuses.
  if (
    !vaultKdfAllowed({
      alg: 'scrypt',
      N,
      r: VAULT_SCRYPT.r,
      p: VAULT_SCRYPT.p,
      salt: `0x${'00'.repeat(SALT_BYTES)}`,
    })
  )
    throw new VaultCryptoError('unsupported_envelope', 'This wallet key cost isn’t accepted.');
  const salt = random(SALT_BYTES);
  const iv = random(IV_BYTES);
  const key = await derive(password, salt, N);
  const plain = hexToBytes(privateKey);
  try {
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: AAD },
        key,
        plainBytes(plain),
      ),
    );
    const envelope: VaultEnvelope = {
      encryptedKey: bytesToHex(sealed),
      kdf: { alg: 'scrypt', N, r: VAULT_SCRYPT.r, p: VAULT_SCRYPT.p, salt: bytesToHex(salt) },
      cipher: { alg: 'AES-256-GCM', iv: bytesToHex(iv) },
    };
    assertSupported(envelope);
    return envelope;
  } finally {
    plain.fill(0);
  }
}

function assertSupported(envelope: VaultEnvelopeInput): asserts envelope is VaultEnvelope {
  if (
    !vaultKdfAllowed(envelope.kdf) ||
    !vaultCipherAllowed(envelope.cipher) ||
    !vaultCiphertextAllowed(envelope.encryptedKey)
  )
    throw new VaultCryptoError(
      'unsupported_envelope',
      'This wallet key uses settings this browser won’t open.',
    );
}

/**
 * Opens an envelope with the password. With `ownerAddress`, the key must belong to it (a vault
 * swapped for another account's never opens as this one). A wrong password is one plain error.
 */
export async function openKey(
  envelope: VaultEnvelopeInput,
  password: string,
  ownerAddress?: string,
): Promise<Hex> {
  assertSupported(envelope);
  const key = await derive(password, hexToBytes(envelope.kdf.salt), envelope.kdf.N);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: plainBytes(hexToBytes(envelope.cipher.iv)), additionalData: AAD },
        key,
        plainBytes(hexToBytes(envelope.encryptedKey)),
      ),
    );
  } catch {
    throw new VaultCryptoError('wrong_password', 'That password doesn’t open your wallet key.');
  }
  try {
    if (plain.length !== KEY_BYTES)
      throw new VaultCryptoError('unsupported_envelope', 'This wallet key isn’t complete.');
    const privateKey = bytesToHex(plain);
    if (
      ownerAddress &&
      privateKeyToAccount(privateKey).address.toLowerCase() !== ownerAddress.toLowerCase()
    )
      throw new VaultCryptoError('wrong_owner', 'This wallet key belongs to another account.');
    return privateKey;
  } finally {
    plain.fill(0);
  }
}
