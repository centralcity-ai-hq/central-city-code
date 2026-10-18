import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_VAULT_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  registerBaseRegistrationRoutes,
  type ChainRuntime,
} from '../server/base/identity/routes.js';
import { createWalletService } from '../server/base/wallet/service.js';
import { createIdentityService } from '../server/base/identity/service.js';
import type { Address } from '../shared/base/chains.js';

/*
 * One wallet for a new Base agent: with wallets on (CITY_BASE_WALLET=1) its Base ID goes to the
 * wallet the person's own wallet key owns, never to an address from the request, and only when the
 * browser derived that same wallet itself. Keys and chain are synthetic; nothing leaves the test.
 */

const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
/** The wallet the (fake) factory derives for any owner; the browser derives the same one. */
const WALLET: Address = `0x${'1'.repeat(40)}`;
const KEY_OWNER: Address = `0x${'a'.repeat(40)}`;
const EXTERNAL_OWNER: Address = `0x${'2'.repeat(40)}`;

interface Setup {
  wallets?: boolean;
  vault?: 'none' | 'unconfirmed' | 'confirmed';
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, opts: Setup = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  // The person p-1 works in their own workspace; ai-1 is an AI workspace, never a wallet owner.
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('p-1', 'owner'), ('p-2', 'owner'), ('ai-1', 'ai');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO workspaces VALUES ('p-1', '{"agents":[{"id":"${AGENT}","revision":1}]}');
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'p-1', 1, '{"spec":{"visibility":"public"}}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await pg.exec(BASE_IDENTITY_HANDOVER_BACKOFF_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  const vault = opts.vault ?? 'confirmed';
  if (vault !== 'none')
    await pg.query(
      `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
         cipher_params, version, backup_confirmed_at, created_at, updated_at)
       VALUES ('p-1', $1, $2, '{}', '{}', 1, $3, 1, 1)`,
      [KEY_OWNER, new Uint8Array(32), vault === 'confirmed' ? 2 : null],
    );
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  /** Each hand-over's destination; the first is still on its way, later ones are final. */
  const calls = { register: 0, transfer: 0, handedTo: [] as string[] };
  const runtime: ChainRuntime = {
    walletPort: {
      implementationVersion: 'cbsw-1.1',
      deriveSmartAccount: async () => WALLET,
      createSpender: async () => ({ spender: `0x${'3'.repeat(40)}`, keyRef: 'v1:k' }),
      commitSpender: async () => {},
    },
    identityPort: {
      register: async (input) => {
        calls.register++;
        return { idempotencyKey: input.operationKey, status: 'final', txHash: '0xa' };
      },
      registeredId: async () => 77n,
      transfer: async (input) => {
        calls.handedTo.push(input.to);
        return {
          idempotencyKey: input.operationKey,
          status: ++calls.transfer > 1 ? 'final' : 'submitted',
          txHash: '0xb',
        };
      },
    },
  };
  // Read per request by the route, so a test can switch wallets on or off between calls.
  const env: Record<string, string | undefined> = {
    CITY_BASE_MAINNET: '1',
    CITY_BASE_WALLET: opts.wallets === false ? undefined : '1',
  };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    db,
    env,
    currentOperator: async (request) => {
      const who = request.headers['x-test-workspace'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    runtime: async () => runtime,
  });
  const register = (payload: object, person = 'p-1', workspace = 'p-1') =>
    app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT}/register`,
      headers: { 'x-test-workspace': workspace, 'x-test-person': person },
      payload,
    });
  const walletRows = async () =>
    (
      await pg.query<{ owner_address: string; owner_account_id: string | null }>(
        'SELECT owner_address, owner_account_id FROM base_wallets WHERE agent_id = $1',
        [AGENT],
      )
    ).rows;
  const identityRows = async () =>
    (await pg.query('SELECT 1 FROM base_identities WHERE agent_id = $1', [AGENT])).rows;
  return { app, db, pg, env, runtime, calls, register, walletRows, identityRows };
}

const keyWallet = (s: Awaited<ReturnType<typeof setup>>) =>
  createWalletService({ db: s.db, chain: s.runtime.walletPort, env: s.env }).ensureWallet({
    workspaceId: 'p-1',
    agentId: AGENT,
    chainId: 8453,
    ownerAddress: KEY_OWNER,
    ownerAccountId: 'p-1',
  });

test('the Base ID goes to the wallet the person’s wallet key owns: one wallet for it and the money', async (t) => {
  const s = await setup(t);
  const answer = await s.register({ expectedWallet: WALLET });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual(answer.json().wallet, {
    address: WALLET,
    ownerAddress: KEY_OWNER,
    state: 'derived',
  });
  assert.equal(answer.json().identity.erc8004AgentId, '77');
  // The wallet is the vault wallet itself: linked to the person, so Withdraw and Pay can use it.
  assert.deepEqual(await s.walletRows(), [{ owner_address: KEY_OWNER, owner_account_id: 'p-1' }]);
  assert.equal(s.calls.register, 1);
});

test('an owner address in the request is refused: the wallet key is the owner', async (t) => {
  const s = await setup(t);
  for (const payload of [
    { ownerAddress: EXTERNAL_OWNER },
    { ownerAddress: EXTERNAL_OWNER, expectedWallet: WALLET },
    {},
    { expectedWallet: 'nope' },
  ]) {
    const refused = await s.register(payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.equal(refused.json().code, 'invalid_body');
  }
  assert.deepEqual(await s.walletRows(), []);
  assert.equal(s.calls.register, 0);
});

test('no wallet key, or a backup not confirmed yet: nothing starts', async (t) => {
  const none = await setup(t, { vault: 'none' });
  const noKey = await none.register({ expectedWallet: WALLET });
  assert.equal(noKey.statusCode, 409);
  assert.equal(noKey.json().code, 'wallet_key_required');
  assert.deepEqual(await none.walletRows(), []);

  const unconfirmed = await setup(t, { vault: 'unconfirmed' });
  const noBackup = await unconfirmed.register({ expectedWallet: WALLET });
  assert.equal(noBackup.statusCode, 409);
  assert.equal(noBackup.json().code, 'backup_required');
  assert.deepEqual(await unconfirmed.walletRows(), []);
  assert.deepEqual(await unconfirmed.identityRows(), []);
  assert.equal(none.calls.register + unconfirmed.calls.register, 0);
});

test('a wallet the browser did not derive itself never receives the Base ID', async (t) => {
  const s = await setup(t);
  const refused = await s.register({ expectedWallet: `0x${'9'.repeat(40)}` });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'wallet_mismatch');
  assert.deepEqual(await s.identityRows(), []);
  assert.equal(s.calls.register, 0);
  // The matching wallet then registers (the stored wallet is the person's own, nothing to undo).
  assert.equal((await s.register({ expectedWallet: WALLET })).statusCode, 200);
});

test('a wallet made first on the Wallet screen is the one that registers (no conflict)', async (t) => {
  const s = await setup(t);
  await createWalletService({ db: s.db, chain: s.runtime.walletPort, env: s.env }).ensureWallet({
    workspaceId: 'p-1',
    agentId: AGENT,
    chainId: 8453,
    ownerAddress: KEY_OWNER,
    ownerAccountId: 'p-1',
  });
  const answer = await s.register({ expectedWallet: WALLET });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal((await s.walletRows()).length, 1);
});

test('an agent registered earlier with an outside owner keeps that wallet (refused, never rebound)', async (t) => {
  const s = await setup(t);
  await createWalletService({ db: s.db, chain: s.runtime.walletPort, env: s.env }).ensureWallet({
    workspaceId: 'p-1',
    agentId: AGENT,
    chainId: 8453,
    ownerAddress: EXTERNAL_OWNER,
  });
  const refused = await s.register({ expectedWallet: WALLET });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'wallet_conflict');
  assert.equal(refused.json().ownerAddress, EXTERNAL_OWNER);
  assert.deepEqual(await s.walletRows(), [
    { owner_address: EXTERNAL_OWNER, owner_account_id: null },
  ]);
});

test('only a signed-in person registers with a wallet key; another person’s agent stays hidden', async (t) => {
  const s = await setup(t);
  assert.equal((await s.register({ expectedWallet: WALLET }, 'ai-1')).statusCode, 404);
  const anonymous = await s.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT}/register`,
    headers: { 'x-test-workspace': 'p-1' },
    payload: { expectedWallet: WALLET },
  });
  assert.equal(anonymous.statusCode, 404);
  // p-2 has no access to p-1's agent: 404 before any wallet question.
  assert.equal((await s.register({ expectedWallet: WALLET }, 'p-2', 'p-2')).statusCode, 404);
  assert.deepEqual(await s.walletRows(), []);
});

test('with wallets off, registration takes an owner address exactly as before', async (t) => {
  const s = await setup(t, { wallets: false });
  const keyed = await s.register({ expectedWallet: WALLET });
  assert.equal(keyed.statusCode, 400);
  const answer = await s.register({ ownerAddress: EXTERNAL_OWNER });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal(answer.json().wallet.ownerAddress, EXTERNAL_OWNER);
  assert.deepEqual(await s.walletRows(), [
    { owner_address: EXTERNAL_OWNER, owner_account_id: null },
  ]);
});

test('registration racing the Wallet screen’s wallet creation ends with one wallet, the key’s', async (t) => {
  const s = await setup(t);
  const [answer] = await Promise.all([s.register({ expectedWallet: WALLET }), keyWallet(s)]);
  assert.equal(answer.statusCode, 200, answer.body);
  assert.deepEqual(await s.walletRows(), [{ owner_address: KEY_OWNER, owner_account_id: 'p-1' }]);
});

test('switching wallets off never reinterprets a key request, and never rebinds the key wallet', async (t) => {
  const s = await setup(t);
  assert.equal((await s.register({ expectedWallet: WALLET })).statusCode, 200);
  s.env.CITY_BASE_WALLET = undefined;
  const keyed = await s.register({ expectedWallet: WALLET, ownerAddress: EXTERNAL_OWNER });
  assert.equal(keyed.statusCode, 400);
  assert.equal(keyed.json().code, 'wallets_off');
  const other = await s.register({ ownerAddress: EXTERNAL_OWNER });
  assert.equal(other.statusCode, 409);
  assert.equal(other.json().code, 'wallet_conflict');
  assert.deepEqual(await s.walletRows(), [{ owner_address: KEY_OWNER, owner_account_id: 'p-1' }]);
});

test('a vault whose key changed since the wallet was made never registers into either wallet', async (t) => {
  const s = await setup(t);
  await keyWallet(s);
  await s.pg.query(`UPDATE base_owner_vaults SET owner_address = $1 WHERE operator_id = 'p-1'`, [
    `0x${'b'.repeat(40)}`,
  ]);
  const refused = await s.register({ expectedWallet: WALLET });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'wallet_conflict');
  assert.deepEqual(await s.identityRows(), []);
  assert.equal(s.calls.register, 0);
});

test('a hand-over finished later (the finalize cron) still goes to the wallet the browser checked', async (t) => {
  const s = await setup(t);
  const first = await s.register({ expectedWallet: WALLET });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().identity.state, 'submitted');
  // Between the request and the cron: the vault names another key and a rebind is attempted.
  await s.pg.query(`UPDATE base_owner_vaults SET owner_address = $1 WHERE operator_id = 'p-1'`, [
    `0x${'b'.repeat(40)}`,
  ]);
  await assert.rejects(
    createWalletService({ db: s.db, chain: s.runtime.walletPort, env: s.env }).ensureWallet({
      workspaceId: 'p-1',
      agentId: AGENT,
      chainId: 8453,
      ownerAddress: `0x${'b'.repeat(40)}`,
      ownerAccountId: 'p-1',
    }),
    /another wallet/,
  );
  // The cron's path: the identity service alone, no route and no check of its own.
  const later = await createIdentityService({
    db: s.db,
    chain: s.runtime.identityPort,
    env: s.env,
  }).advance(AGENT, 8453, {});
  assert.equal(later.state, 'confirmed');
  assert.deepEqual(s.calls.handedTo, [WALLET, WALLET]);
  assert.deepEqual(await s.walletRows(), [{ owner_address: KEY_OWNER, owner_account_id: 'p-1' }]);
});
