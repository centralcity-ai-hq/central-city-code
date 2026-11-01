/*
 * Indexes on tables that are too large to index inside a migration. A migration runs inside a
 * transaction (server/migrations.ts), where CREATE INDEX CONCURRENTLY is not allowed, and a plain
 * CREATE INDEX holds a SHARE lock on the table (every insert, update and delete waits) for the
 * whole build. On a large production table these are built instead by an owner-run script with
 * CREATE INDEX CONCURRENTLY on a direct connection (reads and writes go on while it builds), and
 * the migration that names them only builds them itself on a small database.
 */

type Query = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface ConcurrentIndex {
  /** The index name: lowercase letters, digits and underscores only (it is spliced into SQL). */
  name: string;
  table: string;
  /** Everything after the index name: `ON table (columns) [WHERE ...]`. */
  definition: string;
}

export type IndexState = 'valid' | 'invalid' | 'missing';

export interface PrebuildStep {
  name: string;
  /** The table is not in this database (its feature's migration has not run): nothing to do. */
  before: IndexState | 'no_table';
  action: 'kept' | 'built' | 'rebuilt' | 'would build' | 'would rebuild' | 'skipped';
  after: IndexState | 'no_table';
  ms: number;
}

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
function checked(index: ConcurrentIndex): ConcurrentIndex {
  if (!NAME.test(index.name) || !NAME.test(index.table))
    throw new Error(`Index and table names are identifiers: ${index.name}`);
  return index;
}

/** Whether the index exists, and whether Postgres may use it (pg_index.indisvalid). */
export async function indexState(query: Query, name: string): Promise<IndexState> {
  if (!NAME.test(name)) throw new Error('Index names are identifiers.');
  const { rows } = await query(
    `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = '${name}' AND c.relkind = 'i'`,
  );
  if (!rows.length) return 'missing';
  return rows[0]!.valid === true ? 'valid' : 'invalid';
}

async function tableExists(query: Query, table: string): Promise<boolean> {
  const { rows } = await query(`SELECT to_regclass('${table}') IS NOT NULL AS present`);
  return rows[0]?.present === true;
}

/**
 * Brings every index to valid, one at a time, with CREATE INDEX CONCURRENTLY (never inside a
 * transaction: `query` must run each statement on its own, on a direct connection). A valid index
 * is kept. An invalid one (a concurrent build that failed or was cancelled leaves it so, and
 * IF NOT EXISTS would then skip it for good) is dropped CONCURRENTLY and built again. Without
 * `confirm` it only reports what it would do. Stops at the first failure (thrown after the steps
 * so far are reported through `onStep`); running it again resumes from there.
 */
export async function prebuildIndexes(
  query: Query,
  indexes: readonly ConcurrentIndex[],
  options: { confirm: boolean; onStep?: (step: PrebuildStep) => void; now?: () => number },
): Promise<PrebuildStep[]> {
  const now = options.now ?? Date.now;
  const steps: PrebuildStep[] = [];
  for (const index of indexes.map(checked)) {
    const started = now();
    if (!(await tableExists(query, index.table))) {
      const step: PrebuildStep = {
        name: index.name,
        before: 'no_table',
        action: 'skipped',
        after: 'no_table',
        ms: now() - started,
      };
      steps.push(step);
      options.onStep?.(step);
      continue;
    }
    const before = await indexState(query, index.name);
    let action: PrebuildStep['action'] = 'kept';
    if (before !== 'valid') {
      if (!options.confirm) action = before === 'invalid' ? 'would rebuild' : 'would build';
      else {
        if (before === 'invalid') await query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
        await query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ${index.definition}`);
        action = before === 'invalid' ? 'rebuilt' : 'built';
      }
    }
    const after = options.confirm ? await indexState(query, index.name) : before;
    const step: PrebuildStep = { name: index.name, before, action, after, ms: now() - started };
    steps.push(step);
    options.onStep?.(step);
    if (options.confirm && after !== 'valid')
      throw new Error(`${index.name} is ${after} after its build; run again to rebuild it.`);
  }
  return steps;
}

/**
 * The SQL of a migration that names these indexes without ever building one on a large table:
 * for each index whose table exists and that is missing, it builds it (plain CREATE INDEX) only
 * while the table has at most `guardRows` rows; on a larger table it leaves it to the owner-run
 * script and raises a NOTICE. It never fails the migration (the indexes only speed up reads, and
 * the app works without them), so a deploy never waits for the script. An index that exists but
 * is invalid is left for the script too (it drops and rebuilds it).
 */
export function guardedIndexSql(
  label: string,
  indexes: readonly ConcurrentIndex[],
  guardRows: number,
  script: string,
): string {
  if (!Number.isSafeInteger(guardRows) || guardRows < 0) throw new Error('guardRows: a count.');
  if (!/^[a-z0-9_ ]+$/.test(label)) throw new Error('label: words.');
  if (!/^[a-z0-9/._-]+$/.test(script)) throw new Error('script: a path.');
  const blocks = indexes.map(checked).map(
    (index) => `
  IF to_regclass('${index.table}') IS NOT NULL AND to_regclass('${index.name}') IS NULL THEN
    IF EXISTS (SELECT 1 FROM ${index.table} OFFSET ${guardRows}) THEN
      RAISE NOTICE '${label}: ${index.name} is missing on a large ${index.table}; build it with ${script} --confirm';
    ELSE
      CREATE INDEX IF NOT EXISTS ${index.name} ${index.definition};
    END IF;
  END IF;`,
  );
  return `
DO $guard$
BEGIN${blocks.join('')}
END
$guard$;
`;
}

/**
 * Counts for the migration's report line, measured just before it runs: indexes already valid,
 * missing on a small table (the migration builds them now), missing on a large table (left for
 * the owner-run script) and invalid (left for the script). Counts only, never row data.
 */
export async function guardedIndexReport(
  query: Query,
  indexes: readonly ConcurrentIndex[],
  guardRows: number,
): Promise<Record<'valid' | 'build_now' | 'left_for_script' | 'invalid', number>> {
  const counts = { valid: 0, build_now: 0, left_for_script: 0, invalid: 0 };
  for (const index of indexes.map(checked)) {
    if (!(await tableExists(query, index.table))) continue;
    const state = await indexState(query, index.name);
    if (state === 'valid') counts.valid += 1;
    else if (state === 'invalid') counts.invalid += 1;
    else if ((await query(`SELECT 1 FROM ${index.table} OFFSET ${guardRows} LIMIT 1`)).rows.length)
      counts.left_for_script += 1;
    else counts.build_now += 1;
  }
  return counts;
}
