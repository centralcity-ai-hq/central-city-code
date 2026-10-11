/*
 * The owner vault (shared/base/vault.ts; migration 88): one per person account. The server keeps
 * the ciphertext the browser made and never sees the password or the key. Each write is proven by
 * the owner key over a single-use server challenge:
 *
 *   create   VaultCreate{accountId, ownerAddress, envelopeHash, version: 1, purpose: 'create', nonce}
 *   rewrap   the same with purpose 'rewrap' and version + 1, same owner (new password or restore)
 *   backup   BackupConfirmed{accountId, ownerAddress, nonce} once the recovery phrase is saved
 *
 * envelopeHash covers the whole envelope (ciphertext, salt, IV, scrypt parameters, algorithms). The
 * server canonicalizes what it received, verifies the proof over exactly that, and stores exactly
 * that: a swapped field under a valid signature is a mismatch (422), never a stored vault. Only a
 * proven envelope is then checked against the resource policy (400 when outside it).
 *
 * A proof attempt deletes its challenge before the signature is checked, whatever the outcome, so a
 * nonce is never accepted twice. Audit events carry the owner address and version only, never the
 * ciphertext, KDF parameters or signatures.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from 'viem';
import type { Database, Transaction } from '../../database.js';
import type { Address } from '../../../shared/base/chains.js';
import {
  backupConfirmedTypedData,
  canonicalEnvelope,
  vaultCipherAllowed,
  vaultCiphertextAllowed,
  vaultKdfAllowed,
  vaultProofTypedData,
  type VaultCipher,
  type VaultEnvelope,
  type VaultEnvelopeInput,
  type VaultKdf,
  type VaultPurpose,
} from '../../../shared/base/vault.js';

/** How long a challenge stays usable, and how many unused ones an account keeps at most. */
export const VAULT_CHALLENGE_TTL_MS = 5 * 60_000;
export const VAULT_CHALLENGES_PER_ACCOUNT = 5;
/** Expired challenges removed per issue, so the table never grows without bound. */
const CHALLENGE_SWEEP = 100;

export type VaultErrorCode =
  | 'invalid_vault'
  | 'invalid_kdf'
  | 'invalid_cipher'
  | 'vault_exists'
  | 'vault_missing'
  | 'owner_in_use'
  | 'owner_mismatch'
  | 'version_conflict'
  | 'challenge_expired'
  | 'signature_mismatch';

const STATUS: Record<VaultErrorCode, number> = {
  invalid_vault: 400,
  invalid_kdf: 400,
  invalid_cipher: 400,
  vault_exists: 409,
  vault_missing: 409,
  owner_in_use: 409,
  owner_mismatch: 409,
  version_conflict: 409,
  challenge_expired: 410,
  signature_mismatch: 422,
};

export class VaultError extends Error {
  readonly status: number;
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export interface VaultView {
  ownerAddress: Address;
  encryptedKey: Hex;
  kdf: VaultKdf;
  cipher: VaultCipher;
  version: number;
  backupConfirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface VaultChallenge {
  nonce: Hex;
  expiresAt: number;
}

export interface VaultProof {
  nonce: string;
  signature: string;
}

export interface VaultWrite {
  ownerAddress: string;
  encryptedKey: string;
  /** As received; the resource policy is checked only once the proof over them holds. */
  kdf: VaultEnvelopeInput['kdf'];
  cipher: VaultEnvelopeInput['cipher'];
  /** The version the proof signs: 1 on create, the stored version + 1 on rewrap. */
  version?: number;
  proof: VaultProof;
}

interface VaultRow {
  operator_id: string;
  owner_address: string;
  encrypted_key: string;
  kdf_params: VaultKdf;
  cipher_params: VaultCipher;
  version: number;
  backup_confirmed_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
}

const COLUMNS = `operator_id, owner_address, '0x' || encode(encrypted_owner_key, 'hex') AS encrypted_key,
  kdf_params, cipher_params, version, backup_confirmed_at, created_at, updated_at`;

const view = (row: VaultRow): VaultView => ({
  ownerAddress: row.owner_address as Address,
  encryptedKey: row.encrypted_key as Hex,
  kdf: row.kdf_params,
  cipher: row.cipher_params,
  version: Number(row.version),
  backupConfirmedAt: row.backup_confirmed_at === null ? null : Number(row.backup_confirmed_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

export function createVaultService(deps: { db: Database; now?: () => number }) {
  const now = deps.now ?? Date.now;

  async function load(accountId: string): Promise<VaultRow | null> {
    const { rows } = await deps.db.query<VaultRow>(
      `SELECT ${COLUMNS} FROM base_owner_vaults WHERE operator_id = $1`,
      [accountId],
    );
    return rows[0] ?? null;
  }

  /** Deletes the challenge first, so it is spent whatever the proof turns out to be. */
  async function spend(accountId: string, nonce: string): Promise<Hex> {
    const lower = nonce.toLowerCase();
    const { rows } = await deps.db.query<{ expires_at: string | number }>(
      'DELETE FROM base_vault_challenges WHERE nonce = $1 AND operator_id = $2 RETURNING expires_at',
      [lower, accountId],
    );
    if (!rows[0] || Number(rows[0].expires_at) <= now())
      throw new VaultError('challenge_expired', 'This challenge is used or expired; ask again.');
    return lower as Hex;
  }

  async function recovered(typedData: Parameters<typeof recoverTypedDataAddress>[0]) {
    try {
      return getAddress(await recoverTypedDataAddress(typedData));
    } catch {
      throw new VaultError('signature_mismatch', 'The proof is not a valid signature.');
    }
  }

  /** The checksummed owner and the canonical envelope: exactly what is verified and stored. */
  function canonical(input: VaultWrite): { owner: Address; envelope: VaultEnvelopeInput } {
    if (!isAddress(input.ownerAddress))
      throw new VaultError('invalid_vault', 'ownerAddress must be an address.');
    try {
      return {
        owner: getAddress(input.ownerAddress),
        envelope: canonicalEnvelope({
          encryptedKey: input.encryptedKey as Hex,
          kdf: input.kdf,
          cipher: input.cipher,
        }),
      };
    } catch {
      throw new VaultError('invalid_vault', 'The vault is not well formed.');
    }
  }

  /** Spends the challenge, then checks that the owner key signed this exact envelope. */
  async function prove(
    accountId: string,
    owner: Address,
    envelope: VaultEnvelopeInput,
    proof: VaultProof,
    version: number,
    purpose: VaultPurpose,
  ) {
    const nonce = await spend(accountId, proof.nonce);
    const signer = await recovered({
      ...vaultProofTypedData({ accountId, ownerAddress: owner, envelope, version, purpose, nonce }),
      signature: proof.signature as Hex,
    });
    if (signer !== owner)
      throw new VaultError('signature_mismatch', 'The proof was not signed by the owner key.');
  }

  /** The resource policy (v1.1 gate 1), applied to a proven envelope. */
  function allowed(envelope: VaultEnvelopeInput): VaultEnvelope {
    const { encryptedKey, kdf, cipher } = envelope;
    if (!vaultCiphertextAllowed(encryptedKey))
      throw new VaultError('invalid_vault', 'encryptedKey must be 17 to 1024 bytes of hex.');
    if (!vaultKdfAllowed(kdf))
      throw new VaultError('invalid_kdf', 'scrypt needs N between 2^17 and 2^20, r = 8, p = 1.');
    if (!vaultCipherAllowed(cipher))
      throw new VaultError('invalid_cipher', 'The cipher must be AES-256-GCM with a 12-byte IV.');
    return { encryptedKey, kdf, cipher };
  }

  async function audit(
    tx: Transaction,
    accountId: string,
    kind: string,
    detail: Record<string, unknown>,
  ) {
    await tx.query(
      `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
       VALUES ($1, $2, $2, NULL, $3, $4)`,
      [now(), accountId, kind, JSON.stringify(detail)],
    );
  }

  return {
    /** The account's vault (or null) and a fresh single-use challenge for its next proof. */
    async read(accountId: string): Promise<{ vault: VaultView | null; challenge: VaultChallenge }> {
      const at = now();
      const challenge: VaultChallenge = {
        nonce: `0x${randomBytes(32).toString('hex')}`,
        expiresAt: at + VAULT_CHALLENGE_TTL_MS,
      };
      await deps.db.transaction(async (tx) => {
        await tx.query(
          `DELETE FROM base_vault_challenges WHERE nonce IN (
             SELECT nonce FROM base_vault_challenges WHERE expires_at <= $1 LIMIT ${CHALLENGE_SWEEP})`,
          [at],
        );
        await tx.query(
          `INSERT INTO base_vault_challenges (nonce, operator_id, expires_at, created_at)
           VALUES ($1, $2, $3, $4)`,
          [challenge.nonce, accountId, challenge.expiresAt, at],
        );
        // Only the newest few stay usable: asking again and again never piles up live nonces. The
        // one just issued always stays (several may share a millisecond).
        await tx.query(
          `DELETE FROM base_vault_challenges
           WHERE operator_id = $1 AND nonce <> $2 AND nonce NOT IN (
             SELECT nonce FROM base_vault_challenges WHERE operator_id = $1 AND nonce <> $2
             ORDER BY created_at DESC, nonce DESC LIMIT ${VAULT_CHALLENGES_PER_ACCOUNT - 1})`,
          [accountId, challenge.nonce],
        );
      });
      const row = await load(accountId);
      return { vault: row ? view(row) : null, challenge };
    },

    /** The vault's owner and backup state, for the wallet routes; null without a vault. */
    async owner(accountId: string) {
      const row = await load(accountId);
      if (!row) return null;
      return {
        ownerAddress: row.owner_address as Address,
        backupConfirmedAt:
          row.backup_confirmed_at === null ? null : Number(row.backup_confirmed_at),
      };
    },

    async create(accountId: string, input: VaultWrite): Promise<VaultView> {
      const { owner, envelope: received } = canonical(input);
      if (input.version !== undefined && input.version !== 1)
        throw new VaultError('version_conflict', 'A new vault starts at version 1.');
      if (await load(accountId))
        throw new VaultError('vault_exists', 'This account already has a wallet vault.');
      await prove(accountId, owner, received, input.proof, 1, 'create');
      const envelope = allowed(received);
      const at = now();
      const row = await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<VaultRow>(
          `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key,
             kdf_params, cipher_params, version, backup_confirmed_at, created_at, updated_at)
           VALUES ($1, $2, decode($3, 'hex'), $4, $5, 1, NULL, $6, $6)
           ON CONFLICT DO NOTHING
           RETURNING ${COLUMNS}`,
          [
            accountId,
            owner,
            envelope.encryptedKey.slice(2),
            JSON.stringify(envelope.kdf),
            JSON.stringify(envelope.cipher),
            at,
          ],
        );
        if (rows[0])
          await audit(tx, accountId, 'vault_created', { ownerAddress: owner, version: 1 });
        return rows[0] ?? null;
      });
      if (row) return view(row);
      if (await load(accountId))
        throw new VaultError('vault_exists', 'This account already has a wallet vault.');
      // One key per person: the same owner key can never open two accounts' wallets.
      throw new VaultError('owner_in_use', 'This owner key already belongs to another account.');
    },

    /** Re-encrypts the same key (password change, restore from the phrase): version + 1. */
    async rewrap(accountId: string, input: VaultWrite): Promise<VaultView> {
      const { owner, envelope: received } = canonical(input);
      const current = await load(accountId);
      if (!current) throw new VaultError('vault_missing', 'This account has no wallet vault yet.');
      if (getAddress(current.owner_address) !== owner)
        throw new VaultError('owner_mismatch', 'A rewrap keeps the same owner key.');
      const version = Number(current.version) + 1;
      if (input.version !== undefined && input.version !== version)
        throw new VaultError('version_conflict', 'The vault changed; read it again.');
      await prove(accountId, owner, received, input.proof, version, 'rewrap');
      const envelope = allowed(received);
      const row = await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<VaultRow>(
          `UPDATE base_owner_vaults SET encrypted_owner_key = decode($3, 'hex'),
             kdf_params = $4, cipher_params = $5, version = $6, updated_at = $7
           WHERE operator_id = $1 AND version = $2
           RETURNING ${COLUMNS}`,
          [
            accountId,
            version - 1,
            envelope.encryptedKey.slice(2),
            JSON.stringify(envelope.kdf),
            JSON.stringify(envelope.cipher),
            version,
            now(),
          ],
        );
        if (rows[0])
          await audit(tx, accountId, 'vault_rewrapped', { ownerAddress: owner, version });
        return rows[0] ?? null;
      });
      if (!row) throw new VaultError('version_conflict', 'The vault changed; read it again.');
      return view(row);
    },

    /** Records, once, that the owner key confirmed the recovery phrase was saved. */
    async confirmBackup(accountId: string, proof: VaultProof): Promise<VaultView> {
      const current = await load(accountId);
      if (!current) throw new VaultError('vault_missing', 'This account has no wallet vault yet.');
      const owner = getAddress(current.owner_address);
      const nonce = await spend(accountId, proof.nonce);
      const signer = await recovered({
        ...backupConfirmedTypedData({ accountId, ownerAddress: owner, nonce }),
        signature: proof.signature as Hex,
      });
      if (signer !== owner)
        throw new VaultError(
          'signature_mismatch',
          'The confirmation was not signed by the owner key.',
        );
      const at = now();
      const row = await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<VaultRow>(
          `UPDATE base_owner_vaults SET backup_confirmed_at = $2, updated_at = $2
           WHERE operator_id = $1 AND backup_confirmed_at IS NULL
           RETURNING ${COLUMNS}`,
          [accountId, at],
        );
        if (rows[0])
          await audit(tx, accountId, 'vault_backup_confirmed', {
            ownerAddress: owner,
            version: Number(rows[0].version),
          });
        return rows[0] ?? null;
      });
      // Confirmed before: the first confirmation stands, this one changes nothing.
      const result = row ?? (await load(accountId));
      if (!result) throw new VaultError('vault_missing', 'This account has no wallet vault yet.');
      return view(result);
    },
  };
}
