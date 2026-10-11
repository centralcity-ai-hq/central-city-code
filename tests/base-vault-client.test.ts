import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { hexToBytes, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_VAULT_SQL,
} from '../server/base/schema.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import {
  vaultCipherAllowed,
  vaultCiphertextAllowed,
  vaultKdfAllowed,
  vaultProofTypedData,
} from '../shared/base/vault.js';
import {
  BACKUP_GROUPS,
  backupGroups,
  changePassword,
  confirmBackup,
  createVault,
  groupMatches,
  openKey,
  parseBackupKey,
  passwordProblem,
  pickConfirmGroups,
  readVault,
  restoreFromBackup,
  sealKey,
  unlockVault,
  VaultCryptoError,
} from '../src/base/vault/index.js';
import { SIGNATURE_REFUSED } from '../src/base/vault/vault.js';
import { pageOutOfDate, STALE_PAGE, StalePageError } from '../src/base/stalePage.js';
import { networkProblem, UNSUPPORTED_NETWORK } from '../src/base/wallet/api.js';
import { BASE_MAINNET, BASE_SEPOLIA } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';

/*
 * The browser's wallet key module (src/base/vault) against the real W1 vault routes
 * (server/base/wallet/routes.ts) on an in-memory database: the client's fetch goes to the Fastify
 * app, so every proof is verified by the server's own code. Synthetic passwords only.
 */

const PASSWORD = 'correct horse battery 42';

async function server(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env: { CITY_BASE_WALLET: '1' },
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentWorkspace: async (request) => ({ id: request.headers['x-test-person'] as string }),
    runtime: async () => ({}) as ChainRuntime,
  });
  // The browser's fetch, as person-1, answered by the app; every request body is kept.
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  let person = 'person-1';
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : undefined;
    sent.push({ method: init.method ?? 'GET', url, body: body ? JSON.parse(body) : undefined });
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url,
      headers: { ...(init.headers as Record<string, string>), 'x-test-person': person },
      ...(body ? { payload: body } : {}),
    });
    return new Response(res.body, { status: res.statusCode });
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = original;
  });
  return { sent, as: (who: string) => (person = who) };
}

test('the backup key: 16 groups of 4, typed back with spaces or 0x, never a key out of range', () => {
  const key = `0x${'7f3a9c21'.repeat(8)}` as Hex;
  assert.equal(backupGroups(key).length, BACKUP_GROUPS);
  assert.deepEqual(backupGroups(key).slice(0, 2), ['7f3a', '9c21']);
  assert.deepEqual(parseBackupKey(` 0X${'7F3A 9C21 '.repeat(8)}`), { ok: true, privateKey: key });
  assert.deepEqual(parseBackupKey(backupGroups(key).join('-')), { ok: true, privateKey: key });
  const short = parseBackupKey('7f3a'.repeat(15) + '9c2');
  assert.equal(short.ok, false);
  assert.match((short as { reason: string }).reason, /64 characters; this has 63/);
  assert.equal(parseBackupKey('g'.repeat(64)).ok, false);
  assert.equal(parseBackupKey('0'.repeat(64)).ok, false);
  assert.equal(parseBackupKey('f'.repeat(64)).ok, false);
  // Two different groups, both in range, smaller first.
  for (const seed of [0, 0.2, 0.5, 0.99]) {
    const [a, b] = pickConfirmGroups(() => seed);
    assert.ok(a >= 1 && b <= BACKUP_GROUPS && a < b, `${a} ${b}`);
  }
  assert.equal(groupMatches(key, 2, ' 9C21 '), true);
  assert.equal(groupMatches(key, 2, '9c22'), false);
  assert.equal(groupMatches(key, 17, '7f3a'), false);
});

test('a sealed key opens with its password only; its envelope is exactly what the contract accepts', async () => {
  const owner = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const envelope = await sealKey(`0x${'42'.repeat(32)}`, PASSWORD);
  assert.deepEqual(Object.keys(envelope).sort(), ['cipher', 'encryptedKey', 'kdf']);
  assert.deepEqual(Object.keys(envelope.kdf).sort(), ['N', 'alg', 'p', 'r', 'salt']);
  assert.ok(vaultKdfAllowed(envelope.kdf) && vaultCipherAllowed(envelope.cipher));
  assert.ok(vaultCiphertextAllowed(envelope.encryptedKey));
  assert.equal(await openKey(envelope, PASSWORD, owner.address), `0x${'42'.repeat(32)}`);
  // The same password typed in another Unicode form opens it too.
  const accented = await sealKey(`0x${'42'.repeat(32)}`, 'café 12345678');
  assert.equal(await openKey(accented, 'café 12345678'), `0x${'42'.repeat(32)}`);
  await assert.rejects(openKey(envelope, `${PASSWORD}!`), (e: unknown) => {
    assert.ok(e instanceof VaultCryptoError);
    assert.equal(e.code, 'wrong_password');
    return true;
  });
  // A changed byte in the ciphertext fails the GCM check: never a different key.
  const bytes = hexToBytes(envelope.encryptedKey);
  bytes[0]! ^= 1;
  const tampered = { ...envelope, encryptedKey: `0x${Buffer.from(bytes).toString('hex')}` as Hex };
  await assert.rejects(openKey(tampered, PASSWORD), /doesn’t open/);
  // Weak parameters from a server are refused before deriving anything.
  await assert.rejects(
    openKey({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 10 } }, PASSWORD),
    (e: unknown) => (e as VaultCryptoError).code === 'unsupported_envelope',
  );
  // Another account's address: refused, even with the right password.
  await assert.rejects(
    openKey(envelope, PASSWORD, `0x${'9'.repeat(40)}`),
    (e: unknown) => (e as VaultCryptoError).code === 'wrong_owner',
  );
});

test('create, confirm the backup, unlock, change the password, restore: the real routes accept every proof', async (t) => {
  const { sent } = await server(t);
  assert.equal((await readVault()).exists, false);

  const { privateKey, state } = await createVault(PASSWORD);
  const owner = privateKeyToAccount(privateKey);
  assert.equal(state.exists, true);
  assert.equal(state.version, 1);
  assert.equal(state.ownerAddress?.toLowerCase(), owner.address.toLowerCase());
  assert.equal(state.backupConfirmedAt, null);
  // What left the browser: the envelope and the proof, never the key, the password or a dkLen.
  const create = sent.find((call) => call.method === 'POST' && call.url === '/api/base/vault')!;
  const wire = JSON.stringify(create.body);
  assert.ok(!wire.includes(privateKey.slice(2)), 'the key never leaves the browser');
  assert.ok(!wire.includes(PASSWORD), 'the password never leaves the browser');
  assert.ok(!/dkLen/i.test(wire));
  // The signature recovers to the owner over exactly the shared typed data.
  const body = create.body as {
    encryptedKey: Hex;
    kdf: never;
    cipher: never;
    proof: { nonce: Hex; signature: Hex };
  };
  const recovered = await recoverTypedDataAddress({
    ...vaultProofTypedData({
      accountId: 'person-1',
      ownerAddress: owner.address,
      envelope: { encryptedKey: body.encryptedKey, kdf: body.kdf, cipher: body.cipher },
      version: 1,
      purpose: 'create',
      nonce: body.proof.nonce,
    }),
    signature: body.proof.signature,
  });
  assert.equal(recovered, owner.address);
  await assert.rejects(createVault(PASSWORD), /already have a wallet key/);

  assert.equal(typeof (await confirmBackup(privateKey)), 'number');
  assert.notEqual((await readVault()).backupConfirmedAt, null);

  assert.equal(await unlockVault(PASSWORD), privateKey);
  await assert.rejects(unlockVault('not the password'), /doesn’t open/);

  const changed = await changePassword(PASSWORD, 'a brand new passphrase 7');
  assert.equal(changed.version, 2);
  assert.equal(await unlockVault('a brand new passphrase 7'), privateKey);
  await assert.rejects(unlockVault(PASSWORD), /doesn’t open/);

  // Restore with the backup key: a one-character typo is another key and is refused before storing.
  const groups = backupGroups(privateKey);
  const typo = [...groups];
  typo[6] = typo[6]!.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
  await assert.rejects(
    restoreFromBackup(typo.join(' '), 'restored passphrase 99'),
    /doesn’t match/,
  );
  assert.equal((await readVault()).version, 2, 'nothing was stored');
  const restored = await restoreFromBackup(groups.join(' '), 'restored passphrase 99');
  assert.equal(restored.version, 3);
  assert.equal(await unlockVault('restored passphrase 99'), privateKey);
});

test('a weak password is refused before anything is read, derived or written', async (t) => {
  const { sent } = await server(t);
  for (const weak of [
    'short pass',
    'aaaaaaaaaaaaaaa',
    '123456789012',
    'abcdefghijklmn',
    'qwertyuiopas',
  ]) {
    assert.ok(passwordProblem(weak), weak);
    await assert.rejects(
      createVault(weak),
      (e: unknown) => (e as VaultCryptoError).code === 'weak_password',
    );
    await assert.rejects(
      sealKey(`0x${'42'.repeat(32)}`, weak),
      (e: unknown) => (e as VaultCryptoError).code === 'weak_password',
    );
  }
  assert.equal(sent.length, 0, 'no request was made for a weak password');
  // A cost outside the contract is refused before deriving (fast), never stored.
  const started = performance.now();
  await assert.rejects(
    sealKey(`0x${'42'.repeat(32)}`, PASSWORD, { N: 2 ** 10 }),
    (e: unknown) => (e as VaultCryptoError).code === 'unsupported_envelope',
  );
  await assert.rejects(
    sealKey(`0x${'42'.repeat(32)}`, PASSWORD, { N: 2 ** 21 }),
    (e: unknown) => (e as VaultCryptoError).code === 'unsupported_envelope',
  );
  assert.ok(performance.now() - started < 200, 'no scrypt ran');
  // A new password and a restore are checked the same way, before any write.
  const { privateKey } = await createVault(PASSWORD);
  const writes = sent.length;
  await assert.rejects(changePassword(PASSWORD, 'short'), /at least 12/);
  await assert.rejects(restoreFromBackup(privateKey.slice(2), 'aaaaaaaaaaaaaaaa'), /repeated/);
  assert.equal(sent.length, writes, 'nothing was sent');
  assert.equal(passwordProblem(PASSWORD), null);
});

test("another person's account never opens this vault's key", async (t) => {
  const { as } = await server(t);
  const { privateKey } = await createVault(PASSWORD);
  as('person-2');
  assert.equal((await readVault()).exists, false);
  await assert.rejects(confirmBackup(privateKey), /another account/);
});

/** The other Base network than this build's: what a server deployed after this page answers. */
const OTHER_NETWORK = WALLET_CHAIN_ID === BASE_MAINNET ? BASE_SEPOLIA : BASE_MAINNET;

const stale = (error: unknown) => {
  assert.ok(error instanceof StalePageError, String(error));
  assert.equal((error as Error).message, STALE_PAGE);
  return true;
};

/**
 * The real routes, with the vault read rewritten to name `chainId` (`'absent'` drops the field, as
 * an older server). Returns a switch and the requests that weren't reads.
 */
async function rewritten(t: Parameters<typeof server>[0]) {
  const { sent } = await server(t);
  const served = globalThis.fetch;
  const net: { chainId: unknown } = { chainId: WALLET_CHAIN_ID };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const res = await served(url, init);
    if ((init.method ?? 'GET') !== 'GET') return res;
    const json = (await res.json()) as Record<string, unknown>;
    const { chainId: _served, ...rest } = json;
    const body = net.chainId === 'absent' ? rest : { ...rest, chainId: net.chainId };
    return new Response(JSON.stringify(body), { status: res.status });
  }) as typeof fetch;
  return { net, writes: () => sent.filter((call) => call.method !== 'GET').length };
}

/** Create, rewrap (change password) and backup are all refused for `chainId`: nothing is sent. */
async function refusedEverywhere(
  t: Parameters<typeof server>[0],
  chainId: unknown,
  check: (error: unknown) => boolean,
) {
  const { net, writes } = await rewritten(t);
  net.chainId = chainId;
  await assert.rejects(createVault(PASSWORD), check, `create ${String(chainId)}`);
  assert.equal(writes(), 0, 'create sent nothing');
  net.chainId = WALLET_CHAIN_ID;
  assert.equal((await readVault()).exists, false, 'nothing was created');
  const { privateKey } = await createVault(PASSWORD);
  const before = writes();
  net.chainId = chainId;
  await assert.rejects(confirmBackup(privateKey), check, `backup ${String(chainId)}`);
  await assert.rejects(changePassword(PASSWORD, 'a brand new passphrase 7'), check);
  assert.equal(writes(), before, 'backup and rewrap sent nothing');
  net.chainId = WALLET_CHAIN_ID;
  const after = await readVault();
  assert.equal(after.backupConfirmedAt, null, 'nothing was confirmed');
  assert.equal(after.version, 1, 'nothing was replaced');
}

test('the server names its network, and the vault signs for exactly that one', async (t) => {
  await server(t);
  assert.equal((await readVault()).chainId, WALLET_CHAIN_ID);
});

test('a page out of date (the server moved to the other Base network) asks for a reload and sends nothing', async (t) => {
  await refusedEverywhere(t, OTHER_NETWORK, stale);
});

test('any other supplied network, or one that isn’t a number, is refused as unsupported and sends nothing', async (t) => {
  for (const chainId of [1, 10, 0, null, String(WALLET_CHAIN_ID), true, {}]) {
    await t.test(String(JSON.stringify(chainId)), async (sub) => {
      await refusedEverywhere(sub, chainId, (error: unknown) => {
        assert.ok(!(error instanceof StalePageError), 'not called out of date');
        assert.equal((error as Error).message, UNSUPPORTED_NETWORK);
        return true;
      });
    });
  }
});

test('an older server that names no network: create, backup and rewrap work as before', async (t) => {
  const { net } = await rewritten(t);
  net.chainId = 'absent';
  assert.equal('chainId' in (await readVault()), false);
  const { privateKey } = await createVault(PASSWORD);
  assert.equal(typeof (await confirmBackup(privateKey)), 'number');
  assert.equal((await changePassword(PASSWORD, 'a brand new passphrase 7')).version, 2);
});

test('a signature the server refuses says only that, never that the page is out of date', async (t) => {
  await server(t);
  const { privateKey } = await createVault(PASSWORD);
  const served = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) =>
    url.endsWith('/backup-confirmed')
      ? new Response(
          JSON.stringify({
            error: 'The confirmation was not signed by the owner key.',
            code: 'signature_mismatch',
          }),
          { status: 422 },
        )
      : served(url, init)) as typeof fetch;
  await assert.rejects(confirmBackup(privateKey), (error: unknown) => {
    assert.ok(!(error instanceof StalePageError));
    assert.equal((error as Error).message, SIGNATURE_REFUSED);
    return true;
  });
});

test('only the other Base network reads as an out-of-date page; any other is unsupported', () => {
  assert.equal(pageOutOfDate(OTHER_NETWORK), true);
  for (const chainId of [WALLET_CHAIN_ID, 1, 10, undefined, null, '8453', String(OTHER_NETWORK)])
    assert.equal(pageOutOfDate(chainId), false, String(chainId));
  assert.equal(networkProblem({ chainId: OTHER_NETWORK }), STALE_PAGE);
  assert.equal(networkProblem({ chainId: 1 }), UNSUPPORTED_NETWORK);
});
