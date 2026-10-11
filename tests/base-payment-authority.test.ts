import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import type { Database } from '../server/database.js';
import { createPaymentAuthority } from '../server/base/payments/authority.js';
import { intentFor, PaymentError, type TransferInput } from '../server/base/payments/service.js';
import { BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';

const input: TransferInput = {
  chainId: BASE_SEPOLIA,
  source: { agentId: 'agent-1' },
  to: `0x${'1'.repeat(40)}` as const,
  token: BASE_NETWORKS[BASE_SEPOLIA].tokens.USDC.address,
  amount: 1n,
  idempotencyKey: 'test-payment',
};
const intent = (actorId = 'workspace-1') =>
  intentFor({ workspaceId: 'workspace-1', actorId }, input);
const code = (expected: string) => (e: unknown) => e instanceof PaymentError && e.code === expected;

test('authority SQL rechecks wallet and matching grant', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('workspace-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  const wallet = `0x${'2'.repeat(40)}`;
  const spender = `0x${'3'.repeat(40)}`;
  await pg.query(
    `INSERT INTO base_wallets
    (wallet_id,agent_id,operator_id,chain_id,address,owner_address,spender_address,
     spender_key_ref,derivation,state,created_at,updated_at)
    VALUES ('wallet-1','agent-1','workspace-1',84532,$1,$1,$2,'v1:test','{}','derived',0,0)`,
    [wallet, spender],
  );
  const authority = createPaymentAuthority({
    db: { query: (sql: string, params: unknown[]) => pg.query(sql, params) } as unknown as Database,
    principal: { kind: 'owner', operatorId: 'workspace-1' },
    revalidate: async () => {},
  });
  await assert.rejects(authority.assertCanTransfer(intent()), code('NO_PERMISSION'));
  const permission = { account: wallet, spender, token: input.token };
  await pg.query(
    `INSERT INTO base_spend_permissions
    (permission_id,wallet_id,chain_id,permission,signature,state,created_at,updated_at)
    VALUES ('grant-1','wallet-1',84532,$1,$2,'signed',0,0)`,
    [JSON.stringify(permission), new Uint8Array([1])],
  );
  await authority.assertCanTransfer(intent());
  await assert.rejects(
    authority.assertCanTransfer(
      intentFor(
        { workspaceId: 'workspace-1', actorId: 'workspace-1' },
        { ...input, to: spender as `0x${string}` },
      ),
    ),
    code('SPENDER_RECIPIENT'),
  );
  await pg.exec("UPDATE base_spend_permissions SET state='revoked'");
  await assert.rejects(authority.assertCanTransfer(intent()), code('NO_PERMISSION'));
  await pg.exec("UPDATE base_spend_permissions SET state='onchain'");
  await authority.assertCanTransfer(intent());
  for (const changed of [
    { ...permission, account: input.to },
    { ...permission, spender: input.to },
    { ...permission, token: input.to },
  ]) {
    await pg.query('UPDATE base_spend_permissions SET permission=$1', [JSON.stringify(changed)]);
    await assert.rejects(authority.assertCanTransfer(intent()), code('NO_PERMISSION'));
  }
  await pg.query('UPDATE base_spend_permissions SET permission=$1', [JSON.stringify(permission)]);
  await pg.exec("UPDATE base_wallets SET state='frozen'");
  await assert.rejects(authority.assertCanTransfer(intent()), code('SOURCE_UNAVAILABLE'));
});

test('authority binds owner identity and revalidates on every assertion', async () => {
  let checks = 0;
  let revoked = false;
  const db = {
    query: async () => ({ rows: [{ address: `0x${'2'.repeat(40)}`, permitted: true }] }),
  } as unknown as Database;
  const authority = createPaymentAuthority({
    db,
    principal: { kind: 'owner', operatorId: 'workspace-1' },
    revalidate: async () => {
      checks++;
      if (revoked) throw new Error('revoked');
    },
  });
  await authority.assertCanTransfer(intent());
  await authority.assertCanTransfer(intent());
  assert.equal(checks, 2);
  await assert.rejects(authority.assertCanTransfer(intent('other')), code('NOT_AUTHORIZED'));
  revoked = true;
  await assert.rejects(authority.assertCanTransfer(intent()), /revoked/);
});

test('runtime principal cannot spend a different agent wallet', async () => {
  const authority = createPaymentAuthority({
    db: {
      query: async () => {
        throw new Error('must not query');
      },
    } as unknown as Database,
    principal: { kind: 'agent', operatorId: 'workspace-1', agentId: 'agent-2' },
    revalidate: async () => {
      throw new Error('must not revalidate');
    },
  });
  await assert.rejects(authority.assertCanTransfer(intent('agent-2')), code('NOT_AUTHORIZED'));
});

test('runtime authority snapshots identity and refuses rotated credentials before querying', async () => {
  const principal = { kind: 'agent' as const, operatorId: 'workspace-1', agentId: 'agent-1' };
  let current = true;
  let queries = 0;
  const authority = createPaymentAuthority({
    db: {
      query: async () => {
        queries++;
        return { rows: [{ address: `0x${'2'.repeat(40)}`, permitted: true }] };
      },
    } as unknown as Database,
    principal,
    revalidate: async () => {
      if (!current) throw new Error('credential rotated');
    },
  });
  principal.agentId = 'agent-2';
  await authority.assertCanTransfer(intent('agent-1'));
  assert.equal(queries, 1);
  await assert.rejects(authority.assertCanTransfer(intent('agent-2')), code('NOT_AUTHORIZED'));
  current = false;
  await assert.rejects(authority.assertCanTransfer(intent('agent-1')), /credential rotated/);
  assert.equal(queries, 1);
});

test('authority refuses unavailable sources, self transfers and missing grants', async () => {
  for (const [rows, expected] of [
    [[], 'SOURCE_UNAVAILABLE'],
    [[{ address: input.to, permitted: true }], 'SELF_TRANSFER'],
    [[{ address: `0x${'2'.repeat(40)}`, permitted: false }], 'NO_PERMISSION'],
  ] as const) {
    const authority = createPaymentAuthority({
      db: { query: async () => ({ rows }) } as unknown as Database,
      principal: { kind: 'owner', operatorId: 'workspace-1' },
      revalidate: async () => {},
    });
    await assert.rejects(authority.assertCanTransfer(intent()), code(expected));
  }
});
