/*
 * The wallet vault in the browser (Operation Base Wallet W1; routes: server/base/wallet/routes.ts).
 * One vault per person: the owner key of all their agents' wallets, stored only as the envelope
 * this browser locked. Every write is proven by the owner key over the server's single-use
 * challenge, with the typed data both sides import (shared/base/vault.ts), never a field more
 * (no dkLen: the contract's scrypt output is always 32 bytes).
 */
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { api, ApiError } from '../../api';
import {
  backupConfirmedTypedData,
  vaultProofTypedData,
  type VaultEnvelope,
  type VaultEnvelopeInput,
} from '../../../shared/base/vault';
import { createOwnerKey, openKey, passwordProblem, sealKey, VaultCryptoError } from './crypto';
import { parseBackupKey } from './backupKey';
import { pinOwnerKey } from './keyPin';
import { checkServerNetwork } from '../stalePage';

/** GET /api/base/vault: the account's vault (or none) and a fresh challenge for its next proof. */
export interface VaultState {
  accountId: string;
  exists: boolean;
  ownerAddress: Hex | null;
  encryptedKey: Hex | null;
  kdf: VaultEnvelopeInput['kdf'] | null;
  cipher: VaultEnvelopeInput['cipher'] | null;
  version: number | null;
  backupConfirmedAt: number | null;
  challenge: { nonce: Hex; expiresAt: number };
  /** The wallet network the server signs for (absent from an older server); checked, never trusted. */
  chainId?: unknown;
}

const ROUTE = '/api/base/vault';

export const readVault = () => api<VaultState>(ROUTE, undefined, 'GET');

/** Refuses a password that can't lock a key before anything is read, derived or written. */
function checkPassword(password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new VaultCryptoError('weak_password', problem);
}

export const SIGNATURE_REFUSED =
  'The server didn’t accept the signature, so nothing was saved. Reload the page and try again.';

/**
 * Sends a proof the owner key signed in this page. A refused signature may mean this page is out of
 * date, but that isn't certain, so the message says only what happened and what to try.
 */
async function sendProof<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'signature_mismatch')
      throw new Error(SIGNATURE_REFUSED);
    throw error;
  }
}

const envelopeOf = (state: VaultState): VaultEnvelopeInput | null =>
  state.encryptedKey && state.kdf && state.cipher
    ? { encryptedKey: state.encryptedKey, kdf: state.kdf, cipher: state.cipher }
    : null;

/** Stores or replaces the envelope, signed by the owner key over the challenge just read. */
async function writeVault(
  state: VaultState,
  privateKey: Hex,
  envelope: VaultEnvelope,
  purpose: 'create' | 'rewrap',
): Promise<VaultState> {
  checkServerNetwork(state.chainId);
  const owner = privateKeyToAccount(privateKey);
  const version = purpose === 'create' ? 1 : (state.version ?? 0) + 1;
  const signature = await owner.signTypedData(
    vaultProofTypedData({
      accountId: state.accountId,
      ownerAddress: owner.address,
      envelope,
      version,
      purpose,
      nonce: state.challenge.nonce,
    }),
  );
  const body = {
    ownerAddress: owner.address,
    encryptedKey: envelope.encryptedKey,
    kdf: envelope.kdf,
    cipher: envelope.cipher,
    version,
    proof: { nonce: state.challenge.nonce, signature },
  };
  return sendProof(() => api<VaultState>(ROUTE, body, purpose === 'create' ? 'POST' : 'PUT'));
}

/**
 * Sets up the person's wallet key: made here, locked with `password`, stored as the envelope.
 * Returns the key once, for the backup step (it is never shown again).
 */
export async function createVault(
  password: string,
): Promise<{ privateKey: Hex; state: VaultState }> {
  checkPassword(password);
  const before = await readVault();
  if (before.exists) throw new Error('You already have a wallet key. Unlock it instead.');
  const { privateKey } = createOwnerKey();
  const envelope = await sealKey(privateKey, password);
  const state = await writeVault(before, privateKey, envelope, 'create');
  pinOwnerKey(state.accountId, privateKey);
  return { privateKey, state };
}

/** The person typed their groups back: the owner key signs that the backup is saved. */
export async function confirmBackup(privateKey: Hex): Promise<number> {
  const state = await readVault();
  const owner = privateKeyToAccount(privateKey);
  if (!state.ownerAddress || state.ownerAddress.toLowerCase() !== owner.address.toLowerCase())
    throw new VaultCryptoError('wrong_owner', 'This wallet key belongs to another account.');
  checkServerNetwork(state.chainId);
  const signature = await owner.signTypedData(
    backupConfirmedTypedData({
      accountId: state.accountId,
      ownerAddress: owner.address,
      nonce: state.challenge.nonce,
    }),
  );
  const result = await sendProof(() =>
    api<{ backupConfirmedAt: number }>(`${ROUTE}/backup-confirmed`, {
      nonce: state.challenge.nonce,
      signature,
    }),
  );
  return result.backupConfirmedAt;
}

/** Opens the stored key with the password (a new browser, or before moving money). */
export async function unlockVault(password: string): Promise<Hex> {
  const state = await readVault();
  const envelope = envelopeOf(state);
  if (!envelope || !state.ownerAddress) throw new Error('There’s no wallet key to unlock yet.');
  const privateKey = await openKey(envelope, password, state.ownerAddress);
  // This browser held the key itself: later checks hold the wallet to it (keyPin.ts).
  pinOwnerKey(state.accountId, privateKey);
  return privateKey;
}

/** A new password for the same key: the envelope is locked again and replaced (version + 1). */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<VaultState> {
  checkPassword(newPassword);
  const privateKey = await unlockVault(oldPassword);
  const state = await readVault();
  return writeVault(state, privateKey, await sealKey(privateKey, newPassword), 'rewrap');
}

/**
 * Restores with the backup key and a new password. The key must open the account's own owner
 * address: a typo makes another (valid) key, and is refused here before anything is stored.
 */
export async function restoreFromBackup(
  backupKey: string,
  newPassword: string,
): Promise<VaultState> {
  checkPassword(newPassword);
  const parsed = parseBackupKey(backupKey);
  if (!parsed.ok) throw new Error(parsed.reason);
  const state = await readVault();
  if (!state.ownerAddress) throw new Error('There’s no wallet key to restore on this account.');
  if (
    privateKeyToAccount(parsed.privateKey).address.toLowerCase() !==
    state.ownerAddress.toLowerCase()
  )
    throw new VaultCryptoError(
      'wrong_owner',
      'This backup key doesn’t match your wallet. Check each group against your copy.',
    );
  const restored = await writeVault(
    state,
    parsed.privateKey,
    await sealKey(parsed.privateKey, newPassword),
    'rewrap',
  );
  pinOwnerKey(state.accountId, parsed.privateKey);
  return restored;
}
