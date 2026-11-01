import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createKeystore,
  type SpenderKeyStore,
  type StoredSpenderKey,
} from '../server/base/chain/keystore.js';
import { decryptApiKey, encryptApiKey } from '../server/responder/crypto.js';
import { openPii, sealPii } from '../server/google/pii-crypto.js';

// CCA-719: decrypted key material is wiped after use (intermediate chunks included), and paths that
// only need a key's address never decrypt it. Fake keys only.

function memoryStore(): SpenderKeyStore & { rows: Map<string, StoredSpenderKey> } {
  const rows = new Map<string, StoredSpenderKey>();
  return {
    rows,
    insert: async (row) => void rows.set(row.keyId, row),
    get: async (keyId) => rows.get(keyId) ?? null,
  };
}

/** Records the chunks every Buffer.concat call receives while `run` executes. */
async function concatInputs<T>(run: () => T | Promise<T>): Promise<{ value: T; parts: Buffer[] }> {
  const original = Buffer.concat;
  const parts: Buffer[] = [];
  Buffer.concat = ((list: readonly Uint8Array[], length?: number) => {
    for (const item of list) if (Buffer.isBuffer(item)) parts.push(item);
    return original(list, length);
  }) as typeof Buffer.concat;
  try {
    return { value: await run(), parts };
  } finally {
    Buffer.concat = original;
  }
}

const zero = (buffer: Buffer) => buffer.every((byte) => byte === 0);

test('keystore.addressOf answers the stored address without decrypting the key', async () => {
  const store = memoryStore();
  const keystore = createKeystore({
    store,
    keks: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
  });
  const { signer, keyRef } = await keystore.createSpenderKey();
  assert.equal(await keystore.addressOf(keyRef), signer);
  // Corrupt the ciphertext: a decryption would now fail, the address read does not decrypt.
  const row = store.rows.get(keyRef.split(':')[1]!)!;
  store.rows.set(row.keyId, { ...row, ciphertext: randomBytes(row.ciphertext.length) });
  assert.equal(await keystore.addressOf(keyRef), signer);
  await assert.rejects(keystore.withSigner(keyRef, async (a) => a.address));
  // A ref under another KEK version, or an unknown key, is still refused.
  await assert.rejects(keystore.addressOf(keyRef.replace(/^v1:/, 'v2:')), /not found/);
  await assert.rejects(keystore.addressOf('v1:00000000-0000-0000-0000-000000000000'), /not found/);
});

test('decryption wipes its intermediate plaintext chunks (responder keys, PII)', async () => {
  const kek = randomBytes(32);
  const binding = { id: 'c1', agentId: 'a1', ownerId: 'o1', provider: 'anthropic' };
  const apiKey = Buffer.from('fake-provider-key-for-tests-only');
  const sealed = encryptApiKey(kek, binding, Buffer.from(apiKey));
  const opened = await concatInputs(() => decryptApiKey(kek, binding, sealed));
  assert.deepEqual(opened.value, apiKey);
  const plaintextChunks = opened.parts.filter((part) => part.length > 0 && part.length <= 32);
  assert.ok(plaintextChunks.length > 0, 'the decryption concatenates its chunks');
  for (const part of plaintextChunks) assert.ok(zero(part), 'every intermediate chunk is zeroed');

  const aad = Buffer.from('fake-aad');
  const pii = Buffer.from('fake person name');
  const sealedPii = sealPii(kek, aad, Buffer.from(pii));
  const openedPii = await concatInputs(() => openPii(kek, aad, sealedPii));
  assert.deepEqual(openedPii.value, pii);
  const piiChunks = openedPii.parts.filter((part) => part.length > 0 && part.length <= 32);
  assert.ok(piiChunks.length > 0);
  for (const part of piiChunks) assert.ok(zero(part), 'every intermediate chunk is zeroed');
});

test('keystore signing wipes its intermediate plaintext chunks', async () => {
  const store = memoryStore();
  const keystore = createKeystore({
    store,
    keks: { current: 1, keys: new Map([[1, randomBytes(32)]]) },
  });
  const { signer, keyRef } = await keystore.createSpenderKey();
  const used = await concatInputs(() => keystore.withSigner(keyRef, async (a) => a.address));
  assert.equal(used.value, signer);
  // The decrypted data key and private key chunks (32 bytes each) are zeroed after use.
  const chunks = used.parts.filter((part) => part.length === 32);
  assert.ok(chunks.length >= 2);
  for (const part of chunks) assert.ok(zero(part), 'every intermediate chunk is zeroed');
});
