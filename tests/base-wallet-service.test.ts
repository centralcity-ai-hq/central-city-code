import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import {
  accountIndexFor,
  createWalletService,
  type WalletChainPort,
} from '../server/base/wallet/service.js';
import { BASE_MAINNET, BASE_SEPOLIA, type Address } from '../shared/base/chains.js';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec('CREATE TABLE operators (id text PRIMARY KEY);');
  await pg.exec("INSERT INTO operators VALUES ('ws-1'), ('ws-2');");
  await pg.exec(BASE_MIGRATION_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const calls = { derive: 0, spender: 0, owners: [] as Address[][], committed: [] as string[] };
  const chain: WalletChainPort = {
    implementationVersion: 'cbsw-1.1',
    async deriveSmartAccount(_chainId, owners, index) {
      calls.derive += 1;
      calls.owners.push(owners);
      return `0x${index.toString(16).padStart(40, 'a').slice(-40)}` as Address;
    },
    async createSpender() {
      calls.spender += 1;
      return {
        spender: `0x${calls.spender.toString(16).padStart(40, 'b')}` as Address,
        keyRef: `v1:key-${calls.spender}`,
      };
    },
    async commitSpender(_tx, keyRef) {
      calls.committed.push(keyRef);
    },
  };
  return { db, chain, calls, svc: createWalletService({ db, chain, now: () => 1_000 }) };
}

test('ensureWallet is idempotent per agent and chain, with two owners and a stored recipe', async (t) => {
  const { db, calls, svc } = await setup(t);
  const agentId = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
  const first = await svc.ensureWallet({
    workspaceId: 'ws-1',
    agentId,
    chainId: BASE_SEPOLIA,
    ownerAddress: OWNER,
  });
  const again = await svc.ensureWallet({
    workspaceId: 'ws-1',
    agentId,
    chainId: BASE_SEPOLIA,
    ownerAddress: OWNER,
  });
  assert.equal(again.walletId, first.walletId);
  assert.equal(again.address, first.address);
  assert.equal(first.state, 'derived');
  assert.equal(calls.derive, 1, 'a second call never derives or creates a spender again');
  assert.deepEqual(calls.owners[0], [OWNER, '0xf85210B21cC50302F477BA56686d2019dC9b67Ad']);
  assert.equal(first.derivation.accountIndex, accountIndexFor(agentId).toString(10));
  assert.equal(first.derivation.implementationVersion, 'cbsw-1.1');
  const audit = await db.query<{ kind: string; detail: { address: string } }>(
    'SELECT kind, detail FROM base_audit_events',
  );
  assert.deepEqual(
    audit.rows.map((row) => row.kind),
    ['wallet_derived'],
  );
  assert.ok(!JSON.stringify(first).includes('key-'), 'no key reference in the view');
});

test('the same agent on another workspace or owner is refused; mainnet is closed', async (t) => {
  const { svc } = await setup(t);
  const base = { agentId: 'agent-1', chainId: BASE_SEPOLIA, ownerAddress: OWNER } as const;
  await svc.ensureWallet({ ...base, workspaceId: 'ws-1' });
  await assert.rejects(svc.ensureWallet({ ...base, workspaceId: 'ws-2' }), /another wallet/);
  await assert.rejects(
    svc.ensureWallet({ ...base, workspaceId: 'ws-1', ownerAddress: OTHER }),
    /another wallet/,
  );
  await assert.rejects(
    svc.ensureWallet({ ...base, workspaceId: 'ws-1', chainId: BASE_MAINNET }),
    /Network not available/,
  );
  await assert.rejects(
    svc.ensureWallet({
      ...base,
      agentId: 'agent-2',
      workspaceId: 'ws-1',
      ownerAddress: '0x12' as Address,
    }),
    /Owner address is invalid/,
  );
});

test('freeze is recorded once and keeps the wallet', async (t) => {
  const { db, svc } = await setup(t);
  await svc.ensureWallet({
    workspaceId: 'ws-1',
    agentId: 'a',
    chainId: BASE_SEPOLIA,
    ownerAddress: OWNER,
  });
  assert.equal((await svc.freeze('a', BASE_SEPOLIA, 'ws-1')).state, 'frozen');
  assert.equal((await svc.freeze('a', BASE_SEPOLIA, 'ws-1')).state, 'frozen');
  const kinds = (await db.query<{ kind: string }>('SELECT kind FROM base_audit_events')).rows;
  assert.equal(kinds.filter((row) => row.kind === 'wallet_frozen').length, 1);
  await assert.rejects(svc.freeze('missing', BASE_SEPOLIA, 'ws-1'), /No wallet/);
});

test('the audit log is append-only', async (t) => {
  const { db, svc } = await setup(t);
  await svc.ensureWallet({
    workspaceId: 'ws-1',
    agentId: 'a',
    chainId: BASE_SEPOLIA,
    ownerAddress: OWNER,
  });
  await assert.rejects(db.query('DELETE FROM base_audit_events'), /append-only/);
});

test('ids that look alike never share an account index', () => {
  const pairs = [
    ['agent-0001', 'agent-0001-x'],
    ['abc', 'abc0'],
    ['9f8e7d6c-5b4a-4321-8fed-cba987654321', '9f8e7d6c-5b4a-4321-8fed-cba987654322'],
  ];
  for (const [a, b] of pairs) assert.notEqual(accountIndexFor(a), accountIndexFor(b));
  assert.equal(accountIndexFor('agent-0001'), accountIndexFor('agent-0001'));
  assert.ok(accountIndexFor('x') < 2n ** 256n);
});

test('ensureWallet commits the spender key once, with the wallet insert', async (t) => {
  const { calls, svc } = await setup(t);
  const input: Parameters<typeof svc.ensureWallet>[0] = {
    workspaceId: 'ws-1',
    agentId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
    chainId: BASE_SEPOLIA,
    ownerAddress: OWNER,
  };
  await svc.ensureWallet(input);
  await svc.ensureWallet(input);
  assert.deepEqual(calls.committed, ['v1:key-1']);
});
