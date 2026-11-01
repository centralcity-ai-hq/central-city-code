import type { Database, Transaction } from '../database.js';
import { ageInYears } from './age.js';
import { openPii, piiAad, rewrapPiiDek, sealPii } from './pii-crypto.js';
import { piiKeys, type PiiKeyring } from './pii-keys.js';
import { elricHosted } from '../elric/adapter.js';

/**
 * The date of birth for Elric's 18+ age confirmation (docs/GOOGLE_SIGNIN.md "Date of birth").
 * This is the only module that reads or writes `elric_age_checks.dob_*` (a test checks it):
 *
 * - stored envelope-encrypted (pii-crypto.ts, CITY_PII_KEK), bound to the account and the purpose;
 *   never in logs, errors, exports, MCP tools or any staff view;
 * - read only by isAdult (the age confirmation, on every Elric invocation), ageBandCounts
 *   (aggregate age bands, groups of at least 10, no per-person output) and ownDateOfBirth (the
 *   signed-in owner viewing their own date in account settings);
 * - under 18 locks the account for Elric and keeps no date (only the lock): the lock stays
 *   through corrections, unlinks and new dates; a refused correction is counted;
 * - deleteDob crypto-shreds the date (ciphertext and wrapped key deleted) and keeps the lock;
 *   the row goes with the account (ON DELETE CASCADE).
 */
type Q = Pick<Transaction, 'query'>;
export type DobSource = 'owner' | 'google';
export type StoreDobResult = 'over_18' | 'under_18' | 'locked' | 'invalid' | 'unavailable';

const MAX_AGE_YEARS = 120;
export const AGE_BAND_MIN_GROUP = 10;
export const AGE_BANDS = [
  'under_18',
  '18_24',
  '25_34',
  '35_44',
  '45_54',
  '55_64',
  '65_plus',
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** The key ring from the environment; hosted deployments must set CITY_PII_KEK. */
export function defaultPiiKeyring(): PiiKeyring {
  return piiKeys(process.env, { hosted: elricHosted() });
}

interface Dob {
  year: number;
  month: number;
  day: number;
}
/** 'YYYY-MM-DD', a real date, not in the future and at most 120 years ago; else null. */
export function parseDob(value: unknown, now: number): Dob | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const dob = { year, month, day };
  const age = ageInYears(dob, now);
  if (Date.UTC(year, month - 1, day) > now || age < 0 || age > MAX_AGE_YEARS) return null;
  return dob;
}

interface Row {
  dob_ciphertext: Uint8Array | null;
  dob_wrapped_dek: Uint8Array | null;
  dob_kek_id: string | null;
  locked_at: string | number | null;
}

function openDob(keyring: PiiKeyring, operatorId: string, row: Row): string | null {
  if (!keyring.available || !row.dob_ciphertext || !row.dob_wrapped_dek || !row.dob_kek_id)
    return null;
  const key = keyring.all.find((item) => item.kid === row.dob_kek_id);
  if (!key) return null;
  try {
    const plain = openPii(key.key, piiAad('date_of_birth', operatorId), {
      wrappedDek: Buffer.from(row.dob_wrapped_dek),
      ciphertext: Buffer.from(row.dob_ciphertext),
    });
    try {
      return plain.toString('utf8');
    } finally {
      plain.fill(0);
    }
  } catch {
    return null;
  }
}

/**
 * Stores the date of birth (the caller holds the transaction). A locked account (under 18) is
 * never changed: the attempt is counted and 'locked' returned. Under 18 locks the account.
 */
export async function storeDob(
  q: Q,
  keyring: PiiKeyring,
  operatorId: string,
  value: unknown,
  source: DobSource,
  now: number,
): Promise<StoreDobResult> {
  // The row exists before it is locked, so concurrent writers serialize on it (no gap to race).
  await q.query(
    'INSERT INTO elric_age_checks(operator_id) VALUES($1) ON CONFLICT (operator_id) DO NOTHING',
    [operatorId],
  );
  const existing = (
    await q.query<{ locked_at: string | number | null }>(
      'SELECT locked_at FROM elric_age_checks WHERE operator_id=$1 FOR UPDATE',
      [operatorId],
    )
  ).rows[0];
  if (existing?.locked_at != null) {
    await q.query(
      'UPDATE elric_age_checks SET refused_corrections=refused_corrections+1 WHERE operator_id=$1',
      [operatorId],
    );
    return 'locked';
  }
  const dob = parseDob(value, now);
  if (!dob) return 'invalid';
  const adult = ageInYears(dob, now) >= 18;
  if (!adult) {
    // Data minimisation for minors: only the lock is kept, never the date.
    await q.query(
      `UPDATE elric_age_checks SET dob_ciphertext=NULL, dob_wrapped_dek=NULL, dob_kek_id=NULL,
         source=$2, over_18=false, checked_at=$3, locked_at=$3 WHERE operator_id=$1`,
      [operatorId, source, now],
    );
    return 'under_18';
  }
  // Under 18 locked above even without the key (no date stored); an adult date needs it.
  if (!keyring.available) return 'unavailable';
  const sealed = sealPii(
    keyring.current.key,
    piiAad('date_of_birth', operatorId),
    Buffer.from(value as string, 'utf8'),
  );
  await q.query(
    `INSERT INTO elric_age_checks(operator_id,dob_ciphertext,dob_wrapped_dek,dob_kek_id,source,over_18,checked_at,locked_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (operator_id) DO UPDATE SET dob_ciphertext=EXCLUDED.dob_ciphertext,
       dob_wrapped_dek=EXCLUDED.dob_wrapped_dek, dob_kek_id=EXCLUDED.dob_kek_id, source=EXCLUDED.source,
       over_18=EXCLUDED.over_18, checked_at=EXCLUDED.checked_at, locked_at=EXCLUDED.locked_at`,
    [
      operatorId,
      sealed.ciphertext,
      sealed.wrappedDek,
      keyring.current.kid,
      source,
      adult,
      now,
      adult ? null : now,
    ],
  );
  return adult ? 'over_18' : 'under_18';
}

/** Locks the account for Elric (a Google account that is age-locked was linked to it). */
export async function lockAge(q: Q, operatorId: string, now: number): Promise<void> {
  await q.query(
    `INSERT INTO elric_age_checks(operator_id,over_18,locked_at) VALUES($1,false,$2)
     ON CONFLICT (operator_id) DO UPDATE SET over_18=false,
       locked_at=COALESCE(elric_age_checks.locked_at, EXCLUDED.locked_at)`,
    [operatorId, now],
  );
}

/** True when the account is locked for Elric (under 18). */
export async function ageLocked(q: Q, operatorId: string): Promise<boolean> {
  return (
    (
      await q.query<{ locked_at: unknown }>(
        'SELECT locked_at FROM elric_age_checks WHERE operator_id=$1',
        [operatorId],
      )
    ).rows[0]?.locked_at != null
  );
}

/** Crypto-shreds the date of birth; a lock (under 18) stays. */
export async function deleteDob(q: Q, operatorId: string): Promise<void> {
  await q.query(
    `UPDATE elric_age_checks SET dob_ciphertext=NULL, dob_wrapped_dek=NULL, dob_kek_id=NULL,
       over_18=CASE WHEN locked_at IS NULL THEN NULL ELSE false END
     WHERE operator_id=$1`,
    [operatorId],
  );
}

async function rowOf(q: Q, operatorId: string): Promise<Row | undefined> {
  return (
    await q.query<Row>(
      'SELECT dob_ciphertext,dob_wrapped_dek,dob_kek_id,locked_at FROM elric_age_checks WHERE operator_id=$1',
      [operatorId],
    )
  ).rows[0];
}

/**
 * The age confirmation: true at 18 or over today (UTC), false when locked or under 18, null when
 * unknown (no date, no key, or a value that does not open: fail closed).
 */
export async function isAdult(
  q: Q,
  keyring: PiiKeyring,
  operatorId: string,
  now: number,
): Promise<boolean | null> {
  const row = await rowOf(q, operatorId);
  if (!row) return null;
  if (row.locked_at != null) return false;
  const dob = parseDob(openDob(keyring, operatorId, row), now);
  if (!dob) return null;
  return ageInYears(dob, now) >= 18;
}

/** The signed-in owner's own date of birth, for viewing in account settings only. */
export async function ownDateOfBirth(
  q: Q,
  keyring: PiiKeyring,
  operatorId: string,
): Promise<{ date_of_birth: string | null; locked: boolean } | null> {
  const row = await rowOf(q, operatorId);
  if (!row) return null;
  return { date_of_birth: openDob(keyring, operatorId, row), locked: row.locked_at != null };
}

function bandOf(age: number): AgeBand {
  if (age < 18) return 'under_18';
  if (age < 25) return '18_24';
  if (age < 35) return '25_34';
  if (age < 45) return '35_44';
  if (age < 55) return '45_54';
  if (age < 65) return '55_64';
  return '65_plus';
}

/**
 * Aggregate age bands over every stored date, for operators only (no route exposes it yet; any
 * future route must be admin-only and rate limited). Bands with fewer than 10 people are left
 * out; there are no filters and no per-person output.
 */
export async function ageBandCounts(
  q: Q,
  keyring: PiiKeyring,
  now: number,
): Promise<Partial<Record<AgeBand, number>>> {
  const rows = (
    await q.query<Row & { operator_id: string }>(
      'SELECT operator_id,dob_ciphertext,dob_wrapped_dek,dob_kek_id,locked_at FROM elric_age_checks WHERE dob_ciphertext IS NOT NULL',
    )
  ).rows;
  const counts = new Map<AgeBand, number>();
  for (const row of rows) {
    const dob = parseDob(openDob(keyring, row.operator_id, row), now);
    if (!dob) continue;
    const band = bandOf(ageInYears(dob, now));
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  const out: Partial<Record<AgeBand, number>> = {};
  for (const band of AGE_BANDS) {
    const count = counts.get(band) ?? 0;
    if (count >= AGE_BAND_MIN_GROUP) out[band] = count;
  }
  return out;
}

export interface PiiRewrapCounts {
  pending: number;
  rewrapped: number;
  unknownRoot: number;
  /** Rows whose re-wrap threw (for example a corrupt wrapped key): skipped, the run continues. */
  failed: number;
  dryRun: boolean;
}

/**
 * Re-wraps every stored date's data key under the current CITY_PII_KEK (rotation), one short
 * transaction per row. Idempotent; run until `pending` is 0, then remove CITY_PII_KEK_PREVIOUS.
 * Counts only.
 */
export async function rewrapPiiKeys(
  db: Pick<Database, 'query' | 'transaction'>,
  keyring: PiiKeyring,
  options: { confirm?: boolean } = {},
): Promise<PiiRewrapCounts> {
  if (!keyring.available) throw new Error('The PII key is unavailable.');
  const current = keyring.current;
  const rows = (
    await db.query<{ operator_id: string; dob_kek_id: string }>(
      `SELECT operator_id,dob_kek_id FROM elric_age_checks
        WHERE dob_ciphertext IS NOT NULL AND dob_kek_id <> $1 ORDER BY operator_id`,
      [current.kid],
    )
  ).rows;
  const counts: PiiRewrapCounts = {
    pending: rows.length,
    rewrapped: 0,
    unknownRoot: rows.filter((row) => !keyring.all.some((key) => key.kid === row.dob_kek_id))
      .length,
    failed: 0,
    dryRun: !options.confirm,
  };
  if (!options.confirm) return counts;
  for (const { operator_id: operatorId } of rows) {
    // One row that cannot be re-wrapped is counted and skipped; the run goes on.
    const done = await db
      .transaction(async (tx) => {
        const row = (
          await tx.query<{ dob_wrapped_dek: Uint8Array | null; dob_kek_id: string | null }>(
            'SELECT dob_wrapped_dek,dob_kek_id FROM elric_age_checks WHERE operator_id=$1 FOR UPDATE',
            [operatorId],
          )
        ).rows[0];
        if (!row?.dob_wrapped_dek || !row.dob_kek_id || row.dob_kek_id === current.kid)
          return false;
        const from = keyring.all.find((key) => key.kid === row.dob_kek_id);
        if (!from) return false;
        const wrapped = rewrapPiiDek(
          from.key,
          current.key,
          piiAad('date_of_birth', operatorId),
          Buffer.from(row.dob_wrapped_dek),
        );
        await tx.query(
          'UPDATE elric_age_checks SET dob_wrapped_dek=$2, dob_kek_id=$3 WHERE operator_id=$1',
          [operatorId, wrapped, current.kid],
        );
        return true;
      })
      .catch(() => 'failed' as const);
    if (done === 'failed') counts.failed += 1;
    else if (done) counts.rewrapped += 1;
  }
  return counts;
}
