import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeAbiParameters, keccak256 } from 'viem';
import {
  BASE_FLEET_MANIFEST_SQL,
  BASE_FLEET_MIGRATION_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
} from '../server/base/schema.js';
import { manifestHash, type ManifestEntry } from '../shared/base/manifest.js';

const entry = (ordinal: number, agentId: string): ManifestEntry => ({
  ordinal,
  agentId,
  owner: `0x${'2'.repeat(40)}`,
  wallet: `0x${String(ordinal + 1).repeat(40)}`,
  derivationVersion: 1,
});
const A = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const B = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

test('manifest hash: fixed encoding, order and every field matter', () => {
  const entries = [entry(0, A), entry(1, B)];
  const expected = keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { type: 'uint32' },
            { type: 'bytes16' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint16' },
          ],
        },
      ],
      [
        entries.map(
          (e) =>
            [
              e.ordinal,
              `0x${e.agentId.replaceAll('-', '')}`,
              e.owner as `0x${string}`,
              e.wallet as `0x${string}`,
              1,
            ] as const,
        ),
      ],
    ),
  );
  assert.equal(manifestHash(entries), expected);
  assert.notEqual(
    manifestHash([{ ...entries[0], owner: `0x${'4'.repeat(40)}` }, entries[1]]),
    expected,
  );
  assert.throws(() => manifestHash([entry(1, A)]), /0..n-1/);
  assert.throws(() => manifestHash([entry(0, A), entry(1, A)]), /once/);
  assert.throws(() => manifestHash([entry(0, A.toUpperCase())]), /UUID/);
  assert.throws(() => manifestHash([]), /at least one/);
});

test('migration 83: items carry lowercase owner, wallet and version', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  for (const sql of [BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL, BASE_FLEET_MIGRATION_SQL])
    await pg.exec(sql);
  await pg.exec(BASE_FLEET_MANIFEST_SQL);
  await pg.exec(BASE_FLEET_MANIFEST_SQL); // idempotent
  await pg.exec(`INSERT INTO base_wallets VALUES ('w1','a1','ws',8453,'0x${'1'.repeat(40)}',
    '0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k','{}','derived',1,1)`);
  await pg.exec(`INSERT INTO base_fleet_jobs (job_id, operator_id, chain_id, treasury_wallet_id,
    run_nonce, intent_hash, intent, signature, manifest_hash, registration_mode, expires_at, state,
    created_at, updated_at) VALUES ('j1','ws',8453,'w1','1','0xh','{}','\\x00','0xm','immediate',9,
    'created',1,1)`);
  const item = (owner: string) =>
    pg.query(
      `INSERT INTO base_fleet_items (job_id, ordinal, stage, agent_id, operation_key, intent_hash,
        status, owner_address, wallet_address, derivation_version, created_at, updated_at)
       VALUES ('j1',0,'wallet','a1','k','0xh','pending',$1,$2,1,1,1)`,
      [owner, `0x${'1'.repeat(40)}`],
    );
  await assert.rejects(item(`0x${'A'.repeat(40)}`), /check/i);
  await item(`0x${'a'.repeat(40)}`);
});
