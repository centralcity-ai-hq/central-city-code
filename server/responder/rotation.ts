import type { Transaction as Tx } from '../database.js';
import { decryptApiKey, rewrapDek, type CredentialBinding } from './crypto.js';
import type { ResponderKey, ResponderKeyring } from './keys.js';

/**
 * Stored-key access by root key id, and root-key rotation.
 *
 * Every stored credential records the fingerprint (`kek_id`) of the root key that wrapped its data
 * key. Decryption selects exactly that key from the keyring (CITY_RESPONDER_KEK, then
 * CITY_RESPONDER_KEK_PREVIOUS); an unknown id is refused, never tried against every key.
 * Rotation re-wraps only the data keys under the current root; afterwards PREVIOUS can be removed.
 */
export class UnknownRootKeyError extends Error {
  constructor() {
    super('The stored key was wrapped under a root key this server does not have.');
  }
}

export function rootKeyFor(keyring: ResponderKeyring, kid: string | null): ResponderKey {
  if (!keyring.available || !kid) throw new UnknownRootKeyError();
  const key = keyring.all.find((item) => item.kid === kid);
  if (!key) throw new UnknownRootKeyError();
  return key;
}

export interface StoredCredential {
  id: string;
  agent_id: string;
  owner_id: string;
  provider: string;
  kek_id: string | null;
  wrapped_dek: Uint8Array | null;
  ciphertext: Uint8Array | null;
}

/** Decrypts one stored key with the root key its row names. The caller zeroizes the result. */
export function openStoredKey(keyring: ResponderKeyring, row: StoredCredential): Buffer {
  if (!row.wrapped_dek || !row.ciphertext) throw new UnknownRootKeyError();
  const key = rootKeyFor(keyring, row.kek_id);
  return decryptApiKey(key.key, bindingOf(row), {
    wrappedDek: Buffer.from(row.wrapped_dek),
    ciphertext: Buffer.from(row.ciphertext),
  });
}

function bindingOf(row: StoredCredential): CredentialBinding {
  return { id: row.id, agentId: row.agent_id, ownerId: row.owner_id, provider: row.provider };
}

export interface RewrapCounts {
  /** Live credentials still wrapped under a non-current root key (before this run). */
  pending: number;
  rewrapped: number;
  /** Rows whose root key is not in the keyring: they cannot be re-wrapped (owners re-enter). */
  unknownRoot: number;
  /** Rows whose re-wrap threw (for example a corrupt wrapped key): skipped, the run continues. */
  failed: number;
  dryRun: boolean;
}

/**
 * Re-wraps every live credential not under the current root key, one short transaction per row
 * (`FOR UPDATE`, re-checked), in pages. Idempotent: run until `pending` is 0, then remove
 * CITY_RESPONDER_KEK_PREVIOUS. A row that fails is counted in `failed` and the run goes on.
 * Prints nothing itself; counts only.
 */
export async function rewrapResponderKeys(
  db: Pick<Tx, 'query'> & { transaction<T>(action: (tx: Tx) => Promise<T>): Promise<T> },
  keyring: ResponderKeyring,
  options: { confirm?: boolean; pageSize?: number } = {},
): Promise<RewrapCounts> {
  if (!keyring.available) throw new UnknownRootKeyError();
  const current = keyring.current;
  const pageSize = options.pageSize ?? 200;
  const ids = (
    await db.query<{ id: string; kek_id: string }>(
      `SELECT id,kek_id FROM responder_credentials
        WHERE status <> 'revoked' AND kek_id IS NOT NULL AND kek_id <> $1 ORDER BY id`,
      [current.kid],
    )
  ).rows;
  const counts: RewrapCounts = {
    pending: ids.length,
    rewrapped: 0,
    unknownRoot: ids.filter((row) => !keyring.all.some((key) => key.kid === row.kek_id)).length,
    failed: 0,
    dryRun: !options.confirm,
  };
  if (!options.confirm) return counts;
  for (let start = 0; start < ids.length; start += pageSize)
    for (const { id } of ids.slice(start, start + pageSize)) {
      // One row that cannot be re-wrapped (a failed GCM check) is counted and skipped; it must
      // not stop every later row from moving off the previous root.
      const done = await db
        .transaction(async (tx) => {
          const row = (
            await tx.query<StoredCredential>(
              `SELECT id,agent_id,owner_id,provider,kek_id,wrapped_dek,ciphertext FROM responder_credentials
              WHERE id=$1 AND status <> 'revoked' AND kek_id <> $2 FOR UPDATE`,
              [id, current.kid],
            )
          ).rows[0];
          if (!row?.wrapped_dek) return false;
          const from = keyring.all.find((key) => key.kid === row.kek_id);
          if (!from) return false;
          const wrapped = rewrapDek(
            from.key,
            current.key,
            bindingOf(row),
            Buffer.from(row.wrapped_dek),
          );
          await tx.query('UPDATE responder_credentials SET wrapped_dek=$2, kek_id=$3 WHERE id=$1', [
            id,
            wrapped,
            current.kid,
          ]);
          return true;
        })
        .catch(() => 'failed' as const);
      if (done === 'failed') counts.failed++;
      else if (done) counts.rewrapped++;
    }
  return counts;
}
