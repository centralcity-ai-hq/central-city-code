import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { assertOnboarded, OnboardingRequiredError } from '../server/onboarding.js';
import { GOOGLE_SALT_NO_PASSWORD, GOOGLE_SALT_PENDING_NAME } from '../server/google/routes.js';
import { TERMS_VERSION } from '../shared/terms.js';

// assertOnboarded (server/onboarding.ts): the account itself, and for an AI-owned workspace every
// human co-owner, must be onboarded; the lookup goes through the operators primary key.

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, salt text NOT NULL, kind text NOT NULL);
    CREATE TABLE account_terms_acceptances (operator_id text PRIMARY KEY, version text NOT NULL);
    CREATE TABLE operator_links (human_operator_id text, ai_operator_id text,
      PRIMARY KEY (human_operator_id, ai_operator_id));
    CREATE INDEX operator_links_ai ON operator_links (ai_operator_id);
    CREATE TABLE elric_verified_identities (operator_id text PRIMARY KEY);`);
  const add = async (id: string, salt: string, kind = 'owner', terms?: string) => {
    await pg.query('INSERT INTO operators VALUES ($1, $2, $3)', [id, salt, kind]);
    if (terms) await pg.query('INSERT INTO account_terms_acceptances VALUES ($1, $2)', [id, terms]);
  };
  return { pg, add };
}

const ok = (q: PGlite, id: string) => assertOnboarded(q as never, id);

test('assertOnboarded: password accounts pass; Google accounts need a name and the current terms', async (t) => {
  const { pg, add } = await setup(t);
  await add('pw', 'a'.repeat(32));
  await add('g-done', GOOGLE_SALT_NO_PASSWORD, 'owner', TERMS_VERSION);
  await add('g-old', GOOGLE_SALT_NO_PASSWORD, 'owner', 'old');
  await add('g-noname', GOOGLE_SALT_PENDING_NAME, 'owner', TERMS_VERSION);
  await ok(pg, 'pw');
  await ok(pg, 'g-done');
  await ok(pg, 'unknown');
  await assert.rejects(ok(pg, 'g-old'), OnboardingRequiredError);
  await assert.rejects(ok(pg, 'g-noname'), OnboardingRequiredError);
});

test('assertOnboarded: an AI workspace is held while any human co-owner is pending', async (t) => {
  const { pg, add } = await setup(t);
  await add('ai-1', 'a'.repeat(32), 'ai');
  await add('h-done', GOOGLE_SALT_NO_PASSWORD, 'owner', TERMS_VERSION);
  await add('h-pending', GOOGLE_SALT_PENDING_NAME, 'owner');
  await pg.query("INSERT INTO operator_links VALUES ('h-done', 'ai-1')");
  await ok(pg, 'ai-1');
  await pg.query("INSERT INTO operator_links VALUES ('h-pending', 'ai-1')");
  await assert.rejects(ok(pg, 'ai-1'), OnboardingRequiredError);
  // A link to a non-AI operator never pulls its humans in.
  await add('person', 'a'.repeat(32));
  await pg.query("INSERT INTO operator_links VALUES ('h-pending', 'person')");
  await ok(pg, 'person');
});

test('assertOnboarded: the operators lookup uses the primary key, not a scan', async (t) => {
  const { pg, add } = await setup(t);
  await add('pw', 'a'.repeat(32));
  // A large operators table (prod has 1.8M rows): the planner's own choice, no forced settings.
  await pg.exec(`INSERT INTO operators SELECT 'op-' || g, 'x', 'owner' FROM generate_series(1, 20000) g;
    ANALYZE operators;`);
  let plan = '';
  const spy = {
    query: async (sql: string, params?: unknown[]) => {
      const explained = await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
      plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
      return pg.query(sql, params);
    },
  };
  await assertOnboarded(spy as never, 'pw');
  assert.doesNotMatch(plan, /Seq Scan on operators o\b/, plan);
  assert.match(
    plan,
    /(Index (Only )?Scan using operators_pkey on operators o|Bitmap Index Scan on operators_pkey[\s\S]*id = ANY)/,
    plan,
  );
});
