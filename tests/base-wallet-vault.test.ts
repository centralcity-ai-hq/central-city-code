import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_VAULT_SQL,
  baseWalletVaultMigration,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import { VAULT_CHALLENGE_TTL_MS } from '../server/base/wallet/vault.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import type { Address } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import {
  backupConfirmedTypedData,
  envelopeHash,
  VAULT_DOMAIN,
  vaultProofTypedData,
  type VaultEnvelopeInput,
  type VaultPurpose,
} from '../shared/base/vault.js';
import {
  OTHER_EXPECTED,
  WALLET_EXPECTED,
  WALLET_NET,
  WALLET_ON,
} from './wallet-network-fixture.js';

const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const AI_AGENT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const WALLET = getAddress(`0x${'1'.repeat(40)}`);
const SPM = WALLET_NET.contracts.spendPermissionManager;
const NOW = 1_760_000_000_000;
const KDF = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt: `0x${'ab'.repeat(16)}` };
const CIPHER = { alg: 'AES-256-GCM', iv: `0x${'cd'.repeat(12)}` };
const CIPHERTEXT = `0x${'5a'.repeat(48)}` as Hex;
const json = { 'content-type': 'application/json' };

interface Options {
  env?: Record<string, string | undefined>;
  runtimeOk?: boolean;
  balances?: BalanceReader;
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: Options = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner'), ('ai-1','ai');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'person-1', 1, '{}'), ('${AI_AGENT}', 'ai-1', 1, '{}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const calls = {
    derive: [] as Array<{ chainId: number; owners: Address[] }>,
    runtime: [] as number[],
  };
  const runtime: ChainRuntime = {
    walletPort: {
      implementationVersion: 'cbsw-1.1',
      deriveSmartAccount: async (chainId, owners) => {
        calls.derive.push({ chainId, owners });
        return WALLET;
      },
      createSpender: async () => ({ spender: `0x${'3'.repeat(40)}`, keyRef: 'v1:k' }),
      commitSpender: async () => {},
    },
    identityPort: {} as ChainRuntime['identityPort'],
  };
  const clock = { now: NOW };
  // ai-1 is an AI workspace co-owned by both people.
  const coOwned = new Set(['person-1:ai-1', 'person-2:ai-1']);
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env: options.env ?? WALLET_ON,
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentWorkspace: async (request) => {
      const who = request.headers['x-test-person'] as string;
      const selected = request.headers['x-city-workspace'];
      if (typeof selected !== 'string' || selected === who) return { id: who };
      if (coOwned.has(`${who}:${selected}`)) return { id: selected };
      throw Object.assign(new Error('Workspace not found.'), { statusCode: 404 });
    },
    runtime: async (chainId) => {
      calls.runtime.push(chainId);
      if (options.runtimeOk === false) throw new Error('RUNTIME_UNAVAILABLE');
      return runtime;
    },
    balances: options.balances ?? {
      balances: async () => ({
        usdc: 2_500_000n,
        eth: 10n ** 15n,
        deployed: false,
        blockNumber: 900n,
      }),
    },
    now: () => clock.now,
  });
  return { app, pg, calls, clock };
}

type App = Awaited<ReturnType<typeof setup>>['app'];

const as = (person?: string, workspace?: string) => ({
  ...json,
  ...(person ? { 'x-test-person': person } : {}),
  ...(workspace ? { 'x-city-workspace': workspace } : {}),
});

async function challenge(app: App, person: string) {
  const res = await app.inject({ url: '/api/base/vault', headers: as(person) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().challenge as { nonce: Hex; expiresAt: number };
}

async function vaultBody(
  app: App,
  person: string,
  signer: PrivateKeyAccount,
  overrides: {
    owner?: Address;
    purpose?: VaultPurpose;
    version?: number;
    signedVersion?: number;
    accountId?: string;
    encryptedKey?: Hex;
    nonce?: Hex;
    kdf?: unknown;
    cipher?: unknown;
    /** Sign this envelope instead of the one sent (a tampering test). */
    signed?: Partial<VaultEnvelopeInput>;
    /** Sign under this chain id instead of the vault domain's (another network). */
    domainChainId?: number;
  } = {},
) {
  const nonce = overrides.nonce ?? (await challenge(app, person)).nonce;
  const owner = overrides.owner ?? signer.address;
  const sent = {
    encryptedKey: overrides.encryptedKey ?? CIPHERTEXT,
    kdf: overrides.kdf ?? KDF,
    cipher: overrides.cipher ?? CIPHER,
  };
  let envelope = { ...sent, ...overrides.signed } as VaultEnvelopeInput;
  // An envelope that cannot even be encoded is refused before any signature is read.
  try {
    envelopeHash(envelope);
  } catch {
    envelope = { encryptedKey: CIPHERTEXT, kdf: KDF, cipher: CIPHER } as VaultEnvelopeInput;
  }
  const typed = vaultProofTypedData({
    accountId: overrides.accountId ?? person,
    ownerAddress: owner,
    envelope,
    version: overrides.signedVersion ?? overrides.version ?? 1,
    purpose: overrides.purpose ?? 'create',
    nonce,
  });
  const signature = await signer.signTypedData(
    overrides.domainChainId === undefined
      ? typed
      : { ...typed, domain: { ...typed.domain, chainId: overrides.domainChainId } },
  );
  return {
    ownerAddress: owner,
    encryptedKey: sent.encryptedKey,
    kdf: sent.kdf,
    cipher: sent.cipher,
    ...(overrides.version === undefined ? {} : { version: overrides.version }),
    proof: { nonce, signature },
  };
}

const write = (app: App, method: 'POST' | 'PUT', person: string, payload: unknown) =>
  app.inject({
    method,
    url: '/api/base/vault',
    headers: as(person),
    payload: JSON.stringify(payload),
  });

async function confirmBackup(app: App, person: string, signer: PrivateKeyAccount, owner?: Address) {
  const { nonce } = await challenge(app, person);
  const signature = await signer.signTypedData(
    backupConfirmedTypedData({ accountId: person, ownerAddress: owner ?? signer.address, nonce }),
  );
  return app.inject({
    method: 'POST',
    url: '/api/base/vault/backup-confirmed',
    headers: as(person),
    payload: JSON.stringify({ nonce, signature }),
  });
}

const walletUrl = (agent = AGENT) => `/api/base/agents/${agent}/wallet`;

test('migration 88 is registered after 86 and links vaults to person accounts', async (t) => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(88));
  assert.ok(versions.indexOf(88) > versions.indexOf(86));
  assert.equal(baseWalletVaultMigration.name, 'base_wallet_vault');
  assert.doesNotMatch(BASE_WALLET_VAULT_SQL, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);

  const { pg } = await setup(t);
  const insert = (operator: string, owner: string, bytes = 48) =>
    pg.query(
      `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
         cipher_params, version, created_at, updated_at)
       VALUES ($1, $2, decode(repeat('ab', $3), 'hex'), '{}', '{}', 1, 1, 1)`,
      [operator, owner, bytes],
    );
  await insert('person-1', `0x${'aB'.repeat(20)}`);
  // One key per person: the same owner address (in any case) cannot open a second vault.
  await assert.rejects(insert('person-2', `0x${'Ab'.repeat(20)}`), /unique|duplicate/i);
  // The ciphertext is bounded.
  await assert.rejects(insert('person-2', `0x${'c'.repeat(40)}`, 2000), /ciphertext_size/);
  await assert.rejects(
    pg.query("INSERT INTO base_vault_challenges VALUES ('0xABC', 'person-1', 1, 1)"),
    /check/i,
  );
});

test('every route answers 404 while the wallet flag is off', async (t) => {
  const { app } = await setup(t, { env: {} });
  const signer = privateKeyToAccount(generatePrivateKey());
  for (const [method, url] of [
    ['GET', '/api/base/vault'],
    ['POST', '/api/base/vault'],
    ['PUT', '/api/base/vault'],
    ['POST', '/api/base/vault/backup-confirmed'],
    ['GET', walletUrl()],
    ['POST', walletUrl()],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      headers: as('person-1'),
      payload: method === 'GET' ? undefined : JSON.stringify({ ownerAddress: signer.address }),
    });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
});

test('a person creates a vault with an owner-key proof over a fresh challenge', async (t) => {
  const { app, pg } = await setup(t);
  const empty = await app.inject({ url: '/api/base/vault', headers: as('person-1') });
  assert.equal(empty.statusCode, 200);
  const first = empty.json();
  assert.match(first.challenge.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(first.challenge.expiresAt, NOW + VAULT_CHALLENGE_TTL_MS);
  assert.deepEqual(
    { ...first, challenge: undefined },
    {
      accountId: 'person-1',
      exists: false,
      ownerAddress: null,
      encryptedKey: null,
      kdf: null,
      cipher: null,
      version: null,
      backupConfirmedAt: null,
      chainId: WALLET_CHAIN_ID,
      challenge: undefined,
    },
  );

  const signer = privateKeyToAccount(generatePrivateKey());
  // A lowercase owner address is accepted and stored checksummed.
  const body = await vaultBody(app, 'person-1', signer);
  const created = await write(app, 'POST', 'person-1', {
    ...body,
    ownerAddress: signer.address.toLowerCase(),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json(), {
    accountId: 'person-1',
    exists: true,
    ownerAddress: signer.address,
    encryptedKey: CIPHERTEXT,
    kdf: KDF,
    cipher: CIPHER,
    version: 1,
    backupConfirmedAt: null,
    chainId: WALLET_CHAIN_ID,
  });
  const read = (await app.inject({ url: '/api/base/vault', headers: as('person-1') })).json();
  assert.equal(read.exists, true);
  assert.equal(read.encryptedKey, CIPHERTEXT);
  assert.notEqual(read.challenge.nonce, first.challenge.nonce);

  // The audit line names the owner and version only: no ciphertext, KDF or signature.
  const audit = await pg.query<{ kind: string; actor: string; detail: unknown }>(
    'SELECT kind, actor, detail FROM base_audit_events',
  );
  assert.deepEqual(audit.rows, [
    {
      kind: 'vault_created',
      actor: 'person-1',
      detail: { ownerAddress: signer.address, version: 1 },
    },
  ]);
});

test('a proof by another key, for another account, purpose or ciphertext is refused (422)', async (t) => {
  const { app } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const refused = async (payload: unknown) => {
    const res = await write(app, 'POST', 'person-1', payload);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().code, 'signature_mismatch');
  };
  await refused(await vaultBody(app, 'person-1', other, { owner: signer.address }));
  await refused(await vaultBody(app, 'person-1', signer, { accountId: 'person-2' }));
  await refused(await vaultBody(app, 'person-1', signer, { purpose: 'rewrap' }));
  await refused(await vaultBody(app, 'person-1', signer, { signedVersion: 2 }));
  await refused(
    await vaultBody(app, 'person-1', signer, { signed: { encryptedKey: `0x${'77'.repeat(48)}` } }),
  );
  // A malformed but well-shaped signature is a mismatch too, never a 500.
  const garbage = await vaultBody(app, 'person-1', signer);
  await refused({ ...garbage, proof: { ...garbage.proof, signature: `0x${'00'.repeat(65)}` } });
  const after = (await app.inject({ url: '/api/base/vault', headers: as('person-1') })).json();
  assert.equal(after.exists, false);
});

test('the proof domain is the wallet network: a proof signed for the other network is refused', async (t) => {
  // The vault proof format, with the chain id of the wallet network (shared/base/vault.ts).
  assert.deepEqual(VAULT_DOMAIN, {
    name: 'Central City Vault',
    version: '1',
    chainId: WALLET_EXPECTED.chainId,
  });
  const { app } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const foreign = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { domainChainId: OTHER_EXPECTED.chainId }),
  );
  assert.equal(foreign.statusCode, 422, foreign.body);
  assert.equal(foreign.json().code, 'signature_mismatch');
  const own = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { domainChainId: WALLET_EXPECTED.chainId }),
  );
  assert.equal(own.statusCode, 201, own.body);
});

test('scrypt outside N 2^17..2^20, r 8, p 1 and other ciphers are refused (400)', async (t) => {
  const { app } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  for (const kdf of [
    { ...KDF, N: 2 ** 16 },
    { ...KDF, N: 2 ** 21 },
    { ...KDF, N: 3 * 2 ** 17 },
    { ...KDF, r: 16 },
    { ...KDF, p: 2 },
    { ...KDF, dkLen: 32 },
    { ...KDF, salt: '0x1234' },
    { ...KDF, alg: 'pbkdf2' },
    { ...KDF, extra: 1 },
  ]) {
    const res = await write(
      app,
      'POST',
      'person-1',
      await vaultBody(app, 'person-1', signer, { kdf }),
    );
    assert.equal(res.statusCode, 400, JSON.stringify(kdf));
    assert.equal(res.json().code, 'invalid_kdf');
  }
  for (const cipher of [
    { ...CIPHER, iv: `0x${'cd'.repeat(16)}` },
    { ...CIPHER, alg: 'AES-128-GCM' },
  ]) {
    const res = await write(
      app,
      'POST',
      'person-1',
      await vaultBody(app, 'person-1', signer, { cipher }),
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'invalid_cipher');
  }
  for (const encryptedKey of ['0x12', `0x${'ab'.repeat(1025)}`, 'not-hex'] as Hex[]) {
    const res = await write(
      app,
      'POST',
      'person-1',
      await vaultBody(app, 'person-1', signer, { encryptedKey }),
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'invalid_vault');
  }
  // The largest accepted N works.
  const max = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { kdf: { ...KDF, N: 2 ** 20 } }),
  );
  assert.equal(max.statusCode, 201, max.body);
});

/** Every envelope field, swapped under the owner's original signature. */
const TAMPERED: Array<[string, (body: any) => any]> = [
  ['encryptedKey', (b) => ({ ...b, encryptedKey: `0x${'99'.repeat(48)}` })],
  ['salt', (b) => ({ ...b, kdf: { ...b.kdf, salt: `0x${'01'.repeat(16)}` } })],
  ['iv', (b) => ({ ...b, cipher: { ...b.cipher, iv: `0x${'02'.repeat(12)}` } })],
  ['N', (b) => ({ ...b, kdf: { ...b.kdf, N: 2 ** 20 } })],
  ['r', (b) => ({ ...b, kdf: { ...b.kdf, r: 16 } })],
  ['p', (b) => ({ ...b, kdf: { ...b.kdf, p: 2 } })],
  ['kdf alg', (b) => ({ ...b, kdf: { ...b.kdf, alg: 'pbkdf2' } })],
  ['cipher alg', (b) => ({ ...b, cipher: { ...b.cipher, alg: 'AES-128-GCM' } })],
];

test('the proof binds the whole envelope: a swapped field on create is 422 and stores nothing', async (t) => {
  const { app, pg } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  for (const [field, tamper] of TAMPERED) {
    const res = await write(
      app,
      'POST',
      'person-1',
      tamper(await vaultBody(app, 'person-1', signer)),
    );
    assert.equal(res.statusCode, 422, `${field}: ${res.body}`);
    assert.equal(res.json().code, 'signature_mismatch', field);
    assert.equal((await pg.query('SELECT 1 FROM base_owner_vaults')).rows.length, 0, field);
  }
  // The untouched envelope with its own signature is accepted.
  const ok = await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer));
  assert.equal(ok.statusCode, 201, ok.body);
});

test('the proof binds the whole envelope: a swapped field on rewrap is 422 and changes nothing', async (t) => {
  const { app } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  const stored = async () => {
    const { challenge: _, ...vault } = (
      await app.inject({ url: '/api/base/vault', headers: as('person-1') })
    ).json();
    return vault;
  };
  const before = await stored();
  const NEW = `0x${'6b'.repeat(64)}` as Hex;
  const kdf = { ...KDF, N: 2 ** 18, salt: `0x${'ef'.repeat(32)}` };
  for (const [field, tamper] of TAMPERED) {
    const body = await vaultBody(app, 'person-1', signer, {
      encryptedKey: NEW,
      kdf,
      purpose: 'rewrap',
      version: 2,
    });
    const res = await write(app, 'PUT', 'person-1', tamper(body));
    assert.equal(res.statusCode, 422, `${field}: ${res.body}`);
    assert.equal(res.json().code, 'signature_mismatch', field);
    assert.deepEqual(await stored(), before, field);
  }
  const ok = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, {
      encryptedKey: NEW,
      kdf,
      purpose: 'rewrap',
      version: 2,
    }),
  );
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().version, 2);
});

test('the envelope hash is the pinned ABI encoding; what is hashed is what is stored', async (t) => {
  const envelope = { encryptedKey: CIPHERTEXT, kdf: KDF, cipher: CIPHER } as VaultEnvelopeInput;
  const expected = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint256 v, bytes c, (string alg, uint256 N, uint256 r, uint256 p, bytes salt) k, (string alg, bytes iv) x',
      ),
      [
        1n,
        CIPHERTEXT,
        { alg: 'scrypt', N: 2n ** 17n, r: 8n, p: 1n, salt: KDF.salt as Hex },
        { alg: 'AES-256-GCM', iv: CIPHER.iv as Hex },
      ],
    ),
  );
  assert.equal(envelopeHash(envelope), expected);
  // Hex case is not part of the envelope: upper and lower case hash (and store) the same.
  const upper = {
    encryptedKey: CIPHERTEXT.toUpperCase().replace('0X', '0x') as Hex,
    kdf: { ...KDF, salt: KDF.salt.toUpperCase().replace('0X', '0x') as Hex },
    cipher: { ...CIPHER, iv: CIPHER.iv.toUpperCase().replace('0X', '0x') as Hex },
  } as VaultEnvelopeInput;
  assert.equal(envelopeHash(upper), expected);

  const { app } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const created = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, {
      encryptedKey: upper.encryptedKey,
      kdf: upper.kdf,
      cipher: upper.cipher,
    }),
  );
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().encryptedKey, CIPHERTEXT);
  assert.deepEqual(created.json().kdf, KDF);
  assert.deepEqual(created.json().cipher, CIPHER);
  // The stored envelope hashes to what the owner signed.
  assert.equal(envelopeHash(created.json()), expected);
});

test('a challenge is single use, bound to its account and short-lived', async (t) => {
  const { app, clock } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  // A failed attempt spends the nonce: the same nonce with the right key is refused afterwards.
  const nonce = (await challenge(app, 'person-1')).nonce;
  const wrong = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', other, { owner: signer.address, nonce }),
  );
  assert.equal(wrong.statusCode, 422);
  const replay = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce }),
  );
  assert.equal(replay.statusCode, 410);
  assert.equal(replay.json().code, 'challenge_expired');

  // Another account's challenge is not this account's.
  const foreign = (await challenge(app, 'person-2')).nonce;
  const stolen = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce: foreign }),
  );
  assert.equal(stolen.statusCode, 410);

  // Expired.
  const late = (await challenge(app, 'person-1')).nonce;
  clock.now += VAULT_CHALLENGE_TTL_MS;
  const expired = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce: late }),
  );
  assert.equal(expired.statusCode, 410);

  // Only the newest five stay live.
  const nonces: Hex[] = [];
  for (let i = 0; i < 6; i++) {
    nonces.push((await challenge(app, 'person-1')).nonce);
    clock.now += 1;
  }
  const oldest = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce: nonces[0] }),
  );
  assert.equal(oldest.statusCode, 410);
  const newest = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce: nonces[5] }),
  );
  assert.equal(newest.statusCode, 201, newest.body);

  // The same nonce after a success is refused too.
  const again = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce: nonces[5], purpose: 'rewrap', version: 2 }),
  );
  assert.equal(again.statusCode, 410);

  // Many challenges in the same millisecond: the one just issued is always live.
  let last: Hex = nonces[0];
  for (let i = 0; i < 12; i++) last = (await challenge(app, 'person-1')).nonce;
  const sameTime = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, { nonce: last, purpose: 'rewrap', version: 2 }),
  );
  assert.equal(sameTime.statusCode, 200, sameTime.body);
});

test('a second vault is refused, and one owner key never serves two accounts (409)', async (t) => {
  const { app } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  const second = await write(
    app,
    'POST',
    'person-1',
    await vaultBody(app, 'person-1', privateKeyToAccount(generatePrivateKey())),
  );
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'vault_exists');
  const shared = await write(app, 'POST', 'person-2', await vaultBody(app, 'person-2', signer));
  assert.equal(shared.statusCode, 409);
  assert.equal(shared.json().code, 'owner_in_use');
});

test('rewrap replaces the ciphertext under the same owner key, version + 1', async (t) => {
  const { app, pg } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const missing = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, { purpose: 'rewrap', version: 2 }),
  );
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().code, 'vault_missing');
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );

  const NEW = `0x${'6b'.repeat(64)}` as Hex;
  const kdf = { ...KDF, N: 2 ** 18, salt: `0x${'ef'.repeat(32)}` };
  // The proof must sign the new version and purpose 'rewrap'.
  const asCreate = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, {
      encryptedKey: NEW,
      kdf,
      purpose: 'create',
      version: 2,
    }),
  );
  assert.equal(asCreate.statusCode, 422);
  const oldVersion = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, {
      encryptedKey: NEW,
      kdf,
      purpose: 'rewrap',
      signedVersion: 1,
    }),
  );
  assert.equal(oldVersion.statusCode, 422);
  const stale = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, {
      encryptedKey: NEW,
      kdf,
      purpose: 'rewrap',
      version: 1,
    }),
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'version_conflict');
  const otherKey = privateKeyToAccount(generatePrivateKey());
  const swap = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', otherKey, { purpose: 'rewrap', version: 2 }),
  );
  assert.equal(swap.statusCode, 409);
  assert.equal(swap.json().code, 'owner_mismatch');

  const ok = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, {
      encryptedKey: NEW,
      kdf,
      purpose: 'rewrap',
      version: 2,
    }),
  );
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().version, 2);
  assert.equal(ok.json().encryptedKey, NEW);
  assert.deepEqual(ok.json().kdf, kdf);
  assert.equal(ok.json().ownerAddress, signer.address);
  // Without a version in the body the proof signs the next one.
  const next = await write(
    app,
    'PUT',
    'person-1',
    await vaultBody(app, 'person-1', signer, { purpose: 'rewrap', signedVersion: 3 }),
  );
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().version, 3);
  const kinds = await pg.query<{ kind: string }>(
    'SELECT kind FROM base_audit_events ORDER BY event_id',
  );
  assert.deepEqual(
    kinds.rows.map((row) => row.kind),
    ['vault_created', 'vault_rewrapped', 'vault_rewrapped'],
  );
});

test('backup-confirmed needs the owner key, sets the time once and writes one audit line', async (t) => {
  const { app, pg, clock } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const early = await confirmBackup(app, 'person-1', signer);
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, 'vault_missing');
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  const wrong = await confirmBackup(
    app,
    'person-1',
    privateKeyToAccount(generatePrivateKey()),
    signer.address,
  );
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().code, 'signature_mismatch');
  const bad = await app.inject({
    method: 'POST',
    url: '/api/base/vault/backup-confirmed',
    headers: as('person-1'),
    payload: JSON.stringify({ signature: '0x12' }),
  });
  assert.equal(bad.statusCode, 400);

  clock.now += 1_000;
  const ok = await confirmBackup(app, 'person-1', signer);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { backupConfirmedAt: NOW + 1_000 });
  clock.now += 1_000;
  const again = await confirmBackup(app, 'person-1', signer);
  assert.deepEqual(again.json(), { backupConfirmedAt: NOW + 1_000 });
  const read = (await app.inject({ url: '/api/base/vault', headers: as('person-1') })).json();
  assert.equal(read.backupConfirmedAt, NOW + 1_000);
  const audit = await pg.query<{ kind: string }>(
    "SELECT kind FROM base_audit_events WHERE kind = 'vault_backup_confirmed'",
  );
  assert.equal(audit.rows.length, 1);
});

test('vaults are for person accounts only: AI workspaces and other principals get 404', async (t) => {
  const { app } = await setup(t);
  // A selected AI workspace (even a co-owned one) has no vault of its own.
  assert.equal(
    (await app.inject({ url: '/api/base/vault', headers: as('person-1', 'ai-1') })).statusCode,
    404,
  );
  // The AI operator itself, as the session's account.
  assert.equal((await app.inject({ url: '/api/base/vault', headers: as('ai-1') })).statusCode, 404);
  // A key or token without a console session.
  const bearer = await app.inject({
    url: '/api/base/vault',
    headers: { authorization: 'Bearer ccw_x' },
  });
  assert.equal(bearer.statusCode, 404);
  assert.equal((await app.inject({ url: '/api/base/vault' })).statusCode, 401);
  // Selecting one's own account is the same as selecting nothing.
  assert.equal(
    (await app.inject({ url: '/api/base/vault', headers: as('person-1', 'person-1') })).statusCode,
    200,
  );
  const signer = privateKeyToAccount(generatePrivateKey());
  const body = await vaultBody(app, 'person-1', signer);
  const viaAi = await app.inject({
    method: 'POST',
    url: '/api/base/vault',
    headers: as('person-1', 'ai-1'),
    payload: JSON.stringify(body),
  });
  assert.equal(viaAi.statusCode, 404);
});

test('the wallet is pinned to the wallet network and owned by the vault key, never the request', async (t) => {
  const { app, pg, calls } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  const post = (payload: unknown = {}, person = 'person-1', agent = AGENT) =>
    app.inject({
      method: 'POST',
      url: walletUrl(agent),
      headers: as(person),
      payload: JSON.stringify(payload),
    });

  assert.deepEqual((await app.inject({ url: walletUrl(), headers: as('person-1') })).json(), {
    wallet: null,
  });
  const noVault = await post();
  assert.equal(noVault.statusCode, 409);
  assert.equal(noVault.json().code, 'vault_missing');
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );

  // Any setting in the body is refused: no chain id, no owner address.
  for (const payload of [
    { chainId: OTHER_EXPECTED.chainId },
    { chainId: WALLET_EXPECTED.chainId },
    { ownerAddress: `0x${'4'.repeat(40)}` },
  ]) {
    const res = await post(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().code, 'invalid_body');
  }
  assert.equal(calls.derive.length, 0);

  const created = await post();
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(created.json(), {
    chainId: WALLET_EXPECTED.chainId,
    network: WALLET_EXPECTED.name,
    testnet: WALLET_EXPECTED.testnet,
    address: null,
    ownerAddress: signer.address,
    spenderAddress: `0x${'3'.repeat(40)}`,
    fundingLocked: true,
    explorerUrl: null,
  });
  assert.deepEqual(calls.runtime, [WALLET_EXPECTED.chainId]);
  assert.deepEqual(calls.derive, [
    { chainId: WALLET_EXPECTED.chainId, owners: [signer.address, SPM] },
  ]);
  const stored = await pg.query<Record<string, unknown>>(
    'SELECT chain_id, owner_address, owner_account_id, operator_id FROM base_wallets',
  );
  assert.deepEqual(stored.rows, [
    {
      chain_id: WALLET_EXPECTED.chainId,
      owner_address: signer.address,
      owner_account_id: 'person-1',
      operator_id: 'person-1',
    },
  ]);
  // Repeating is idempotent.
  assert.equal((await post()).statusCode, 200);
  assert.equal(calls.derive.length, 1);

  // Until the backup is confirmed the address stays hidden and funding locked.
  const locked = (await app.inject({ url: walletUrl(), headers: as('person-1') })).json();
  assert.equal(locked.address, null);
  assert.equal(locked.fundingLocked, true);
  assert.equal(locked.explorerUrl, null);
  assert.equal((await confirmBackup(app, 'person-1', signer)).statusCode, 200);
  const open = (await app.inject({ url: walletUrl(), headers: as('person-1') })).json();
  assert.deepEqual(open, {
    chainId: WALLET_EXPECTED.chainId,
    network: WALLET_EXPECTED.name,
    testnet: WALLET_EXPECTED.testnet,
    address: WALLET,
    ownerAddress: signer.address,
    spenderAddress: `0x${'3'.repeat(40)}`,
    deployed: false,
    fundingLocked: false,
    usdc: { raw: '2500000', decimals: 6, display: '2.5' },
    eth: { raw: '1000000000000000', decimals: 18, display: '0.001' },
    readAtBlock: 900,
    readAt: NOW,
    stale: false,
    explorerUrl: `${WALLET_EXPECTED.explorer}/address/${WALLET}`,
  });

  // Strangers and other people's agents.
  assert.equal((await post({}, 'person-2')).statusCode, 404);
  assert.equal((await app.inject({ url: walletUrl(), headers: as('person-2') })).statusCode, 404);
  assert.equal(
    (await app.inject({ url: walletUrl('not-a-uuid'), headers: as('person-1') })).statusCode,
    404,
  );
  assert.equal((await app.inject({ url: walletUrl() })).statusCode, 401);
});

test('in a co-owned AI workspace the person who sets up the wallet owns it; the other sees it', async (t) => {
  const { app } = await setup(t);
  const one = privateKeyToAccount(generatePrivateKey());
  const two = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', one))).statusCode,
    201,
  );
  assert.equal(
    (await write(app, 'POST', 'person-2', await vaultBody(app, 'person-2', two))).statusCode,
    201,
  );
  const post = (person: string) =>
    app.inject({
      method: 'POST',
      url: walletUrl(AI_AGENT),
      headers: as(person, 'ai-1'),
      payload: '{}',
    });
  const get = (person: string) =>
    app.inject({ url: walletUrl(AI_AGENT), headers: as(person, 'ai-1') });

  const created = await post('person-1');
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().ownerAddress, one.address);
  // The co-owner cannot rebind it to their own key.
  const conflict = await post('person-2');
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'wallet_conflict');
  // They see it, locked until its owner (not they) confirms the backup.
  assert.equal((await confirmBackup(app, 'person-2', two)).statusCode, 200);
  assert.equal((await get('person-2')).json().address, null);
  assert.equal((await confirmBackup(app, 'person-1', one)).statusCode, 200);
  const seen = (await get('person-2')).json();
  assert.equal(seen.address, WALLET);
  assert.equal(seen.ownerAddress, one.address);
  // Without the workspace selected the agent is not theirs.
  assert.equal(
    (await app.inject({ url: walletUrl(AI_AGENT), headers: as('person-2') })).statusCode,
    404,
  );
});

test('no chain runtime means 503 network_unavailable and nothing is stored', async (t) => {
  const { app, pg } = await setup(t, { runtimeOk: false });
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  const res = await app.inject({
    method: 'POST',
    url: walletUrl(),
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'network_unavailable');
  assert.equal((await pg.query('SELECT 1 FROM base_wallets')).rows.length, 0);
});

test('on Base no wallet is created while the mainnet gate is closed; Base Sepolia has none', async (t) => {
  // The wallet flag alone, without CITY_BASE_MAINNET=1.
  const { app, pg } = await setup(t, { env: { CITY_BASE_WALLET: '1' } });
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  const res = await app.inject({
    method: 'POST',
    url: walletUrl(),
    headers: as('person-1'),
    payload: '{}',
  });
  if (WALLET_EXPECTED.testnet) {
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().chainId, WALLET_EXPECTED.chainId);
  } else {
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().code, 'network_unavailable');
    assert.equal((await pg.query('SELECT 1 FROM base_wallets')).rows.length, 0);
  }
});

test("the agent's wallet on the other network is never read, adopted or replaced", async (t) => {
  const { app, pg, calls } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  // The same agent already has a wallet on the other network, owned by another key.
  const elsewhere = getAddress(`0x${'4d'.repeat(20)}`);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-other', $1, 'person-1', $2, $3, $4, $5, 'v1:k0', '{}', 'derived', 1, 1)`,
    [
      AGENT,
      OTHER_EXPECTED.chainId,
      elsewhere,
      getAddress(`0x${'4e'.repeat(20)}`),
      `0x${'3'.repeat(40)}`,
    ],
  );
  assert.deepEqual((await app.inject({ url: walletUrl(), headers: as('person-1') })).json(), {
    wallet: null,
  });
  const created = await app.inject({
    method: 'POST',
    url: walletUrl(),
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().chainId, WALLET_EXPECTED.chainId);
  assert.equal(created.json().ownerAddress, signer.address);
  assert.deepEqual(calls.derive, [
    { chainId: WALLET_EXPECTED.chainId, owners: [signer.address, SPM] },
  ]);
  const rows = await pg.query<{ chain_id: number; address: string; owner_account_id: string }>(
    'SELECT chain_id, address, owner_account_id FROM base_wallets',
  );
  const byChain = new Map(rows.rows.map((row) => [row.chain_id, row]));
  assert.equal(rows.rows.length, 2);
  assert.deepEqual(
    [
      byChain.get(WALLET_EXPECTED.chainId)?.address,
      byChain.get(WALLET_EXPECTED.chainId)?.owner_account_id,
    ],
    [WALLET, 'person-1'],
  );
  assert.deepEqual(
    [
      byChain.get(OTHER_EXPECTED.chainId)?.address,
      byChain.get(OTHER_EXPECTED.chainId)?.owner_account_id,
    ],
    [elsewhere, null],
  );
});

test('an outside-owned wallet with the vault owner is adopted; another account is a conflict', async (t) => {
  const { app, pg } = await setup(t);
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w1', $1, 'person-1', $5, $2, $3, $4, 'v1:k0', '{}', 'derived', 1, 1)`,
    [AGENT, WALLET, signer.address, `0x${'3'.repeat(40)}`, WALLET_EXPECTED.chainId],
  );
  const res = await app.inject({
    method: 'POST',
    url: walletUrl(),
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = await pg.query<{ owner_account_id: string }>(
    'SELECT owner_account_id FROM base_wallets',
  );
  assert.equal(row.rows[0].owner_account_id, 'person-1');
  await pg.query("UPDATE base_wallets SET owner_account_id = 'person-2'");
  const taken = await app.inject({
    method: 'POST',
    url: walletUrl(),
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().code, 'wallet_conflict');
});

test('an agent registered on the wallet network before its vault wallet: never shown or used as its wallet, nothing changes', async (t) => {
  let reads = 0;
  const { app, pg, calls } = await setup(t, {
    balances: {
      balances: async () => {
        reads += 1;
        return { usdc: 7_000_000n, eth: 0n, deployed: true, blockNumber: 900n };
      },
    },
  });
  // As the registration flow leaves it: the agent's wallet owned by [the owner address typed at
  // registration, SpendPermissionManager], no owner account, and its identity on that network.
  const typed = getAddress(`0x${'6b'.repeat(20)}`);
  const held = getAddress(`0x${'ac'.repeat(20)}`);
  // Stored in lower case: the answer checksums both.
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-registered', $1, 'person-1', $2, $3, $4, $5, 'v1:k0', $6, 'derived', 1, 1)`,
    [
      AGENT,
      WALLET_EXPECTED.chainId,
      held.toLowerCase(),
      typed.toLowerCase(),
      `0x${'3'.repeat(40)}`,
      JSON.stringify({ version: 1, owners: [typed, SPM] }),
    ],
  );
  await pg.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ($1, $2, 'person-1', $3, 424242, 'https://centralcity.ai/a/Live01', $4, 'confirmed', 1)`,
    [AGENT, WALLET_EXPECTED.chainId, WALLET_EXPECTED.registry, held],
  );
  // The identity wallet holding the Base ID and its external owner, checksummed; no balance.
  const registered = {
    kind: 'registered_elsewhere',
    address: held,
    ownerAddress: typed,
    chainId: WALLET_EXPECTED.chainId,
    network: WALLET_EXPECTED.name,
    testnet: WALLET_EXPECTED.testnet,
    code: 'wallet_registered_elsewhere',
    message:
      "This agent's Base ID is held by the owner wallet you used when registering it. Connecting that wallet to Central City comes next.",
  };
  const get = () => app.inject({ url: walletUrl(), headers: as('person-1') });
  const post = () =>
    app.inject({ method: 'POST', url: walletUrl(), headers: as('person-1'), payload: '{}' });
  const snapshot = () =>
    pg.query('SELECT * FROM base_wallets ORDER BY wallet_id').then((result) => result.rows);
  const before = await snapshot();

  // Without a vault: never its wallet, no address, no balance, Base not read.
  const noVault = await get();
  assert.equal(noVault.statusCode, 200, noVault.body);
  assert.deepEqual(noVault.json(), registered);
  // With a vault of another key: the same, and setting the wallet up is a clear 409.
  const signer = privateKeyToAccount(generatePrivateKey());
  assert.equal(
    (await write(app, 'POST', 'person-1', await vaultBody(app, 'person-1', signer))).statusCode,
    201,
  );
  assert.deepEqual((await get()).json(), registered);
  const res = await post();
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), { error: registered.message, code: 'wallet_registered_elsewhere' });
  assert.equal(reads, 0, 'Base was never read for it');
  // Nothing adopted, rebound or derived.
  assert.deepEqual(await snapshot(), before);
  assert.equal(calls.derive.length, 0);
  // A wallet another account's vault owns is a plain conflict, shown as that wallet (locked).
  await pg.query("UPDATE base_wallets SET owner_account_id = 'person-2'");
  const owned = await post();
  assert.equal(owned.statusCode, 409);
  assert.equal(owned.json().code, 'wallet_conflict');
  const shown = (await get()).json();
  assert.equal(shown.kind, undefined);
  assert.equal(shown.fundingLocked, true);
});
