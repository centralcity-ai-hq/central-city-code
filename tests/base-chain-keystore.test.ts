import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { recoverMessageAddress } from 'viem';
import {
  createKeystore,
  parseKeks,
  parseKeyRef,
  type SpenderKeyStore,
  type StoredSpenderKey,
} from '../server/base/chain/keystore.js';

function memoryStore(): SpenderKeyStore & { rows: Map<string, StoredSpenderKey> } {
  const rows = new Map<string, StoredSpenderKey>();
  return {
    rows,
    async insert(row) {
      if (rows.has(row.keyId)) throw new Error('duplicate');
      rows.set(row.keyId, structuredClone(row));
    },
    async get(keyId) {
      const row = rows.get(keyId);
      return row ? structuredClone(row) : null;
    },
  };
}

const kek = (version: number) => `v${version}:${randomBytes(32).toString('base64')}`;

test('KEK env parsing: highest version is current; malformed input is refused', () => {
  const keks = parseKeks(`${kek(1)},${kek(3)}`);
  assert.equal(keks.current, 3);
  assert.equal(keks.keys.size, 2);
  for (const bad of [
    undefined,
    '',
    'v1:short',
    'v0:' + randomBytes(32).toString('base64'),
    'x1:abc',
  ])
    assert.throws(() => parseKeks(bad));
});

test('spender keys: created encrypted, used only inside withSigner, signer matches', async () => {
  const store = memoryStore();
  const keystore = createKeystore({ store, keks: parseKeks(kek(1)) });
  const { signer, keyRef } = await keystore.createSpenderKey();
  assert.match(keyRef, /^v1:[0-9a-f-]{36}$/);

  const row = store.rows.get(parseKeyRef(keyRef).keyId)!;
  assert.equal(row.signerAddress, signer);
  assert.equal(row.committedAt, null);
  // Nothing in the row is the raw key: 12-byte IV + 32-byte body + 16-byte tag for each layer.
  assert.equal(row.ciphertext.length, 60);
  assert.equal(row.wrappedDek.length, 60);

  const signature = await keystore.withSigner(keyRef, (account) =>
    account.signMessage({ message: 'probe' }),
  );
  assert.equal(await recoverMessageAddress({ message: 'probe', signature }), signer);
});

test('rotation: keys made under an old KEK still open when it is listed', async () => {
  const store = memoryStore();
  const v1 = kek(1);
  const old = createKeystore({ store, keks: parseKeks(v1) });
  const { keyRef } = await old.createSpenderKey();
  const rotated = createKeystore({ store, keks: parseKeks(`${v1},${kek(2)}`) });
  assert.match((await rotated.createSpenderKey()).keyRef, /^v2:/);
  await rotated.withSigner(keyRef, async () => undefined);
  const dropped = createKeystore({ store, keks: parseKeks(kek(2)) });
  await assert.rejects(
    dropped.withSigner(keyRef, async () => undefined),
    /not available/,
  );
});

test('tampering: swapped ciphertexts, wrong KEK and bad refs are refused', async () => {
  const store = memoryStore();
  const keystore = createKeystore({ store, keks: parseKeks(kek(1)) });
  const a = await keystore.createSpenderKey();
  const b = await keystore.createSpenderKey();
  const rowA = store.rows.get(parseKeyRef(a.keyRef).keyId)!;
  const rowB = store.rows.get(parseKeyRef(b.keyRef).keyId)!;
  store.rows.set(rowA.keyId, { ...rowA, ciphertext: rowB.ciphertext, wrappedDek: rowB.wrappedDek });
  await assert.rejects(keystore.withSigner(a.keyRef, async () => undefined));

  const other = createKeystore({ store, keks: parseKeks(kek(1)) });
  await assert.rejects(other.withSigner(b.keyRef, async () => undefined));

  for (const ref of ['', 'v1:', '1:abc', 'v1:not-a-uuid', `v2:${parseKeyRef(b.keyRef).keyId}`])
    await assert.rejects(keystore.withSigner(ref, async () => undefined));
});

test('a KEK version listed twice is refused', () => {
  assert.throws(() => parseKeks(`${kek(1)},${kek(1)}`), /twice/);
});
