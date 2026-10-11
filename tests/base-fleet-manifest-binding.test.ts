import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '../server/database.js';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import { manifestHash } from '../shared/base/manifest.js';
import { bindFleetManifest } from '../server/base/fleet/manifest-binding.js';

test('manifest binds stored workspace, chain, owner, address, version and usable state', async () => {
  const pg = new PGlite();
  const entry = {
    ordinal: 0,
    agentId: '00000000-0000-0000-0000-000000000001',
    owner: `0x${'1'.repeat(40)}`,
    wallet: `0x${'2'.repeat(40)}`,
    derivationVersion: 1,
  };
  try {
    await pg.exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('test-workspace')",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.query(
      `INSERT INTO base_wallets(wallet_id,agent_id,operator_id,chain_id,address,owner_address,spender_address,spender_key_ref,derivation,state,created_at,updated_at)
      VALUES ('test-wallet',$1,'test-workspace',31337,$2,$3,$3,'v1:test','{"version":1}','derived',0,0)`,
      [entry.agentId, entry.wallet, entry.owner],
    );
    const bind = (workspace = 'test-workspace', chain = 31337) =>
      pg.transaction((tx) =>
        bindFleetManifest(
          tx as unknown as Transaction,
          workspace,
          chain,
          [entry],
          manifestHash([entry]),
        ),
      );
    assert.deepEqual(await bind(), [entry]);
    await assert.rejects(bind('other-workspace'), /unavailable/);
    await assert.rejects(bind('test-workspace', 84532), /unavailable/);
    for (const change of [
      "state='frozen'",
      "state='closed'",
      'derivation=\'{"version":2}\'',
      `owner_address='0x${'3'.repeat(40)}'`,
      `address='0x${'3'.repeat(40)}'`,
    ]) {
      await pg.exec(`UPDATE base_wallets SET ${change}`);
      await assert.rejects(bind(), /mismatch/);
      await pg.query(
        "UPDATE base_wallets SET state='derived',derivation='{\"version\":1}',owner_address=$1,address=$2",
        [entry.owner, entry.wallet],
      );
    }
    await assert.rejects(
      pg.transaction((tx) =>
        bindFleetManifest(
          tx as unknown as Transaction,
          'test-workspace',
          31337,
          [entry],
          `0x${'0'.repeat(64)}`,
        ),
      ),
      /hash mismatch/,
    );
  } finally {
    await pg.close();
  }
});

test('caller mutation during wallet lookup cannot change the signed binding', async () => {
  const entry = {
    ordinal: 0,
    agentId: '00000000-0000-0000-0000-000000000001',
    owner: `0x${'1'.repeat(40)}`,
    wallet: `0x${'2'.repeat(40)}`,
    derivationVersion: 1,
  };
  const original = { ...entry };
  const entries = [entry];
  const hash = manifestHash(entries);
  const tx = {
    async query() {
      // Simulate mutation while the database call is in flight.
      entry.owner = `0x${'3'.repeat(40)}`;
      entry.wallet = `0x${'4'.repeat(40)}`;
      entries.length = 0;
      return {
        rows: [
          {
            agent_id: original.agentId,
            owner_address: original.owner,
            address: original.wallet,
            derivation: { version: 1 },
            state: 'derived',
          },
        ],
      };
    },
  } as unknown as Transaction;
  const bound = await bindFleetManifest(tx, 'test-workspace', 31337, entries, hash);
  assert.deepEqual(bound, [original]);
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound[0]));
  assert.throws(() => {
    (bound[0] as { owner: string }).owner = entry.owner;
  }, TypeError);
});

test('an overridden input map cannot retain caller-owned entries across lookup', async () => {
  const entry = {
    ordinal: 0,
    agentId: '00000000-0000-0000-0000-000000000001',
    owner: `0x${'1'.repeat(40)}`,
    wallet: `0x${'2'.repeat(40)}`,
    derivationVersion: 1,
  };
  const original = { ...entry };
  const hash = manifestHash([original]);
  const entries = [entry];
  Object.defineProperty(entries, 'map', { value: () => [entry] });
  const tx = {
    async query() {
      entry.wallet = `0x${'3'.repeat(40)}`;
      return {
        rows: [
          {
            agent_id: entry.agentId,
            owner_address: entry.owner,
            address: entry.wallet,
            derivation: { version: 1 },
            state: 'derived',
          },
        ],
      };
    },
  } as unknown as Transaction;
  await assert.rejects(bindFleetManifest(tx, 'test-workspace', 31337, entries, hash), /mismatch/);
});

test('manifest copy rejects nonprimitive fields before wallet lookup', async () => {
  const entry = {
    ordinal: 0,
    agentId: '00000000-0000-0000-0000-000000000001',
    owner: `0x${'1'.repeat(40)}`,
    wallet: `0x${'2'.repeat(40)}`,
    derivationVersion: 1,
  };
  const hash = manifestHash([entry]);
  let reads = 0;
  const tx = {
    async query() {
      reads++;
      throw new Error('unexpected lookup');
    },
  } as unknown as Transaction;
  for (const field of ['agentId', 'owner', 'wallet', 'ordinal', 'derivationVersion'] as const) {
    const value = entry[field];
    const malformed = {
      ...entry,
      [field]: { toString: () => String(value), valueOf: () => value },
    };
    await assert.rejects(
      bindFleetManifest(tx, 'test-workspace', 31337, [malformed] as never, hash),
      /Invalid fleet manifest/,
    );
  }
  assert.equal(reads, 0);
});

test('manifest copy ignores array species and reads entry getters once', async () => {
  const original = {
    ordinal: 0,
    agentId: '00000000-0000-0000-0000-000000000001',
    owner: `0x${'1'.repeat(40)}`,
    wallet: `0x${'2'.repeat(40)}`,
    derivationVersion: 1,
  };
  let reads = 0;
  const entry = {
    ...original,
    get wallet() {
      reads++;
      return reads === 1 ? original.wallet : `0x${'3'.repeat(40)}`;
    },
  };
  const entries = [entry];
  Object.defineProperty(entries, 'constructor', {
    value: {
      get [Symbol.species]() {
        throw new Error('caller species invoked');
      },
    },
  });
  const tx = {
    async query() {
      return {
        rows: [
          {
            agent_id: original.agentId,
            owner_address: original.owner,
            address: original.wallet,
            derivation: { version: 1 },
            state: 'derived',
          },
        ],
      };
    },
  } as unknown as Transaction;
  const bound = await bindFleetManifest(
    tx,
    'test-workspace',
    31337,
    entries,
    manifestHash([original]),
  );
  assert.deepEqual(bound, [original]);
  assert.equal(reads, 1);
  assert.ok(Object.isFrozen(bound[0]));
});
