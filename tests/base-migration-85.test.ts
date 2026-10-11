import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  baseFleetManifestMigration,
  baseFleetMigration,
  baseIdentityProvisionalMigration,
  basePaymentsMigration,
  baseSharedAdditionsMigration,
  baseShortIdsMigration,
  baseWalletsMigration,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import { receiveMigration } from '../server/base/payments/receive-store.js';
import { registerKey, transferKey } from '../server/base/identity/service.js';

const REGISTRY = `0x${'8'.repeat(40)}`;

async function legacy(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  const insert = (
    agent: string,
    state: string,
    id: number | null,
    opId: string | null,
    updatedAt = 50,
  ) =>
    pg.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, tx_hash, updated_at)
       VALUES ($1, 8453, 'ws', $2, $3, 'https://centralcity.ai/a/abc123', '0x1', $4, $5, NULL, $6)`,
      [agent, REGISTRY, id, state, opId, updatedAt],
    );
  return { pg, insert };
}

const columns = `state, op_id, register_op_id, mint_op_id,
  provisional_agent_id::text AS provisional_agent_id, erc8004_agent_id::text AS erc8004_agent_id,
  mint_seen_at::text AS mint_seen_at, transfer_op_id, handover_id::text AS handover_id,
  evidence_rev::text AS evidence_rev, started_at::text AS started_at, swept_at`;

test('migration 85 backfills legacy rows: an id was only ever stored from a final mint', async (t) => {
  const { pg, insert } = await legacy(t);
  await insert('confirmed', 'confirmed', 99029, transferKey('confirmed', 8453), 70);
  await insert('handing', 'submitted', 7, registerKey('handing', 8453, 1));
  await insert('minting', 'submitted', null, registerKey('minting', 8453));
  await insert('fresh', 'pending', null, null);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  const row = async (agent: string) =>
    (
      await pg.query<Record<string, string | null>>(
        `SELECT ${columns} FROM base_identities WHERE agent_id = $1`,
        [agent],
      )
    ).rows[0];

  assert.deepEqual(await row('confirmed'), {
    state: 'confirmed',
    op_id: transferKey('confirmed', 8453),
    register_op_id: null,
    mint_op_id: null,
    provisional_agent_id: '99029',
    erc8004_agent_id: '99029',
    mint_seen_at: '70',
    transfer_op_id: transferKey('confirmed', 8453),
    handover_id: '99029',
    evidence_rev: '0',
    started_at: '70',
    swept_at: null,
  });
  const handing = await row('handing');
  assert.equal(handing.register_op_id, registerKey('handing', 8453, 1));
  assert.equal(handing.mint_op_id, registerKey('handing', 8453, 1));
  assert.equal(handing.transfer_op_id, transferKey('handing', 8453));
  assert.equal(handing.handover_id, '7');
  assert.equal(handing.provisional_agent_id, '7');
  const minting = await row('minting');
  assert.equal(minting.register_op_id, registerKey('minting', 8453));
  assert.equal(minting.mint_op_id, null);
  assert.equal(minting.transfer_op_id, null);
  assert.equal(minting.provisional_agent_id, null);
  // D1/D2/D4 columns: a legacy id came from a FINAL mint; nothing else is known yet.
  const added = async (agent: string) =>
    (
      await pg.query<Record<string, string | null>>(
        `SELECT mint_finality, mint_block_hash, handover_finality, handover_block::text AS
           handover_block, handover_block_hash, destination_mismatch
         FROM base_identities WHERE agent_id = $1`,
        [agent],
      )
    ).rows[0];
  const unknown = {
    mint_block_hash: null,
    handover_finality: null,
    handover_block: null,
    handover_block_hash: null,
    destination_mismatch: null,
  };
  assert.deepEqual(await added('confirmed'), { mint_finality: 'final', ...unknown });
  assert.deepEqual(await added('handing'), { mint_finality: 'final', ...unknown });
  assert.deepEqual(await added('minting'), { mint_finality: null, ...unknown });
  await assert.rejects(
    pg.query("UPDATE base_identities SET mint_finality = 'latest' WHERE agent_id = 'minting'"),
    /mint_finality_check/,
  );
  await assert.rejects(
    pg.query("UPDATE base_identities SET handover_finality = 'safe!' WHERE agent_id = 'minting'"),
    /handover_finality_check/,
  );
  const fresh = await row('fresh');
  assert.equal(fresh.register_op_id, null);
  assert.equal(fresh.started_at, '50');

  // Re-running the SQL changes nothing.
  const snapshot = async () => ({
    rows: (await pg.query(`SELECT ${columns} FROM base_identities ORDER BY agent_id`)).rows,
    constraints: (
      await pg.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'base_identities'::regclass ORDER BY conname`,
      )
    ).rows,
    indexes: (
      await pg.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'base_identities' ORDER BY 1",
      )
    ).rows,
  });
  const before = await snapshot();
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  assert.deepEqual(await snapshot(), before);
});

test('an odd legacy row never blocks the deploy; later writes are checked', async (t) => {
  const { pg, insert } = await legacy(t);
  await insert('odd', 'confirmed', null, null);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await assert.rejects(
    pg.query("UPDATE base_identities SET updated_at = 51 WHERE agent_id = 'odd'"),
    /base_identities_confirmed_canonical/,
  );
  await insert('ok', 'pending', null, null);
  await assert.rejects(
    pg.query("UPDATE base_identities SET register_op_id = 'nope' WHERE agent_id = 'ok'"),
    /register_op_id_check/,
  );
  // The odd row stays readable; the sanity count names it before the deploy.
  const { rows } = await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM base_identities WHERE state = 'confirmed' AND erc8004_agent_id IS NULL",
  );
  assert.equal(rows[0].n, 1);
});

const BASE_THROUGH_83 = [
  baseWalletsMigration,
  basePaymentsMigration,
  baseShortIdsMigration,
  baseFleetMigration,
  baseSharedAdditionsMigration,
  baseFleetManifestMigration,
];

async function freshDb(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec('CREATE TABLE operators (id text PRIMARY KEY)');
  return pg;
}

const ledger = async (pg: PGlite) =>
  (
    await pg.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
  ).rows.map((r) => Number(r.version));

test('migration 85 applies after 84 (x402 receipts)', async (t) => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(83) && versions.includes(84) && versions.includes(85));
  assert.equal(versions.indexOf(84), versions.indexOf(83) + 1);
  assert.equal(versions.indexOf(85), versions.indexOf(84) + 1);

  // A ledger at 83: 84 then 85 are applied, in that order.
  const at83 = await freshDb(t);
  const reports: Array<[string, Record<string, number>]> = [];
  const log = (e: string, f: Record<string, number>) => void reports.push([e, f]);
  assert.deepEqual(
    (await runMigrations(at83, BASE_THROUGH_83, Date.now, true, log)).applied,
    [78, 79, 80, 81, 82, 83],
  );
  assert.deepEqual(
    (
      await runMigrations(
        at83,
        [...BASE_THROUGH_83, receiveMigration, baseIdentityProvisionalMigration],
        Date.now,
        true,
        log,
      )
    ).applied,
    [84, 85],
  );
  assert.deepEqual(reports, [['base_identity_provisional_migration', { confirmedWithoutId: 0 }]]);
  assert.deepEqual(await ledger(at83), [78, 79, 80, 81, 82, 83, 84, 85]);

  // A ledger at 84: only 85 is applied.
  const at84 = await freshDb(t);
  await runMigrations(at84, [...BASE_THROUGH_83, receiveMigration], Date.now, true, () => {});
  assert.deepEqual(
    (
      await runMigrations(
        at84,
        [...BASE_THROUGH_83, receiveMigration, baseIdentityProvisionalMigration],
        Date.now,
        true,
        () => {},
      )
    ).applied,
    [85],
  );
  assert.deepEqual(await ledger(at84), [78, 79, 80, 81, 82, 83, 84, 85]);
});

test('a database that already ran 85 before 84 arrived still gets 84', async (t) => {
  const pg = await freshDb(t);
  assert.deepEqual(
    (
      await runMigrations(
        pg,
        [...BASE_THROUGH_83, baseIdentityProvisionalMigration],
        Date.now,
        true,
        () => {},
      )
    ).applied,
    [78, 79, 80, 81, 82, 83, 85],
  );
  assert.deepEqual(
    (
      await runMigrations(
        pg,
        [...BASE_THROUGH_83, receiveMigration, baseIdentityProvisionalMigration],
        Date.now,
        true,
        () => {},
      )
    ).applied,
    [84],
  );
  assert.deepEqual(await ledger(pg), [78, 79, 80, 81, 82, 83, 84, 85]);
  // Both tables are usable.
  await pg.query('SELECT 1 FROM base_x402_receipts LIMIT 1');
  await pg.query('SELECT provisional_agent_id FROM base_identities LIMIT 1');
});
