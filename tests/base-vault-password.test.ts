import assert from 'node:assert/strict';
import test from 'node:test';
import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { VAULT_SCRYPT, type VaultEnvelope } from '../shared/base/vault.js';
import {
  openKey,
  passwordProblem,
  sealKey,
  VAULT_N,
  VaultCryptoError,
} from '../src/base/vault/index.js';
import { newPasswordProblem } from '../src/agents/v4/walletKeyModel.js';
import { setSignedInPerson } from '../src/base/signedInPerson.js';

/*
 * The wallet password policy (CCA-101): a new or changed password that is common, a run, mostly
 * one character or the account's own name is refused; a vault locked before the policy still
 * opens with its old password. Synthetic passwords and names only.
 */

const KEY = `0x${'42'.repeat(32)}` as Hex;
const TOO_EASY = /too easy to guess/;

test('common passwords and their usual dressings are refused', () => {
  for (const weak of [
    'password12345',
    'Password1234!',
    'iloveyou2024!!',
    'letmein123456',
    'trustno1trustno1',
    'Football2024!!',
    'monkeydragonsunshine',
  ])
    assert.match(passwordProblem(weak) ?? '', TOO_EASY, weak);
});

test('runs along the digits, the alphabet and the keyboard are refused', () => {
  for (const weak of [
    '1234567890ab',
    'abcd1234efgh',
    'Qwerty123456!',
    '987654321zyx',
    'asdfghjkl;123',
    'qwertzuiop1234',
    'zyxwvutsrqpo',
  ])
    assert.match(passwordProblem(weak) ?? '', TOO_EASY, weak);
});

test('a password that is mostly one character, a repeated pattern or only digits is refused', () => {
  assert.equal(passwordProblem('aaaaaaaaaaaaaa'), 'Use more than one repeated character.');
  for (const weak of [
    'aaaaaaaaaaab',
    'abababababab',
    'Xy7!Xy7!Xy7!',
    '1a1a1a1a1a1a1a',
    'zzzzzzz9q8w7',
  ])
    assert.ok(passwordProblem(weak), weak);
  assert.match(passwordProblem('Abc9!Abc9!Abc9!') ?? '', TOO_EASY);
  assert.equal(passwordProblem('839201748392'), 'Use letters too, not only digits.');
});

test('a password that contains the account name is refused', () => {
  const name = /account name/;
  assert.match(passwordProblem('marlowe-quinn wallet 2026', ['Marlowe-Quinn']) ?? '', name);
  assert.match(passwordProblem('my QUINN wallet key 77', ['marlowe.quinn']) ?? '', name);
  assert.equal(passwordProblem('violet harbor lantern 58', ['marlowe-quinn']), null);
  // The forms check the signed-in person's name too, before anything is sent.
  setSignedInPerson('person-1', 'marlowe-quinn');
  try {
    assert.match(
      newPasswordProblem('marlowequinn wallet 2026', 'marlowequinn wallet 2026') ?? '',
      name,
    );
  } finally {
    setSignedInPerson(null);
  }
});

test('strong passphrases are accepted', () => {
  for (const good of [
    'correct horse battery 42',
    'violet harbor lantern 58',
    'Local-test-only-passphrase-2026',
    'café au lait 7319',
    'Tr0ub4dor&3 kiwi orbit',
    'grain shovel mirror quietly',
  ])
    assert.equal(passwordProblem(good), null, good);
});

test('the key is sealed only with an accepted password, at the unchanged cost', async () => {
  await assert.rejects(
    sealKey(KEY, 'Password1234!'),
    (e: unknown) => (e as VaultCryptoError).code === 'weak_password',
  );
  const envelope = await sealKey(KEY, 'violet harbor lantern 58');
  assert.equal(envelope.kdf.N, VAULT_N);
  assert.equal(VAULT_N, VAULT_SCRYPT.minN);
});

/** An envelope locked the way the browser did before the policy, with a now-refused password. */
async function oldEnvelope(password: string): Promise<VaultEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = await scryptAsync(new TextEncoder().encode(password.normalize('NFKC')), salt, {
    N: VAULT_SCRYPT.minN,
    r: VAULT_SCRYPT.r,
    p: VAULT_SCRYPT.p,
    dkLen: 32,
  });
  const key = await crypto.subtle.importKey(
    'raw',
    raw as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('Central City vault key v1') },
    key,
    Buffer.from(KEY.slice(2), 'hex'),
  );
  return {
    encryptedKey: bytesToHex(new Uint8Array(sealed)),
    kdf: {
      alg: 'scrypt',
      N: VAULT_SCRYPT.minN,
      r: VAULT_SCRYPT.r,
      p: VAULT_SCRYPT.p,
      salt: bytesToHex(salt),
    },
    cipher: { alg: 'AES-256-GCM', iv: bytesToHex(iv) },
  };
}

test('a vault locked before the policy still opens with its old (now refused) password', async () => {
  const old = 'password12345';
  assert.ok(passwordProblem(old), 'the old password is refused for a new lock');
  const envelope = await oldEnvelope(old);
  const owner = privateKeyToAccount(KEY).address;
  assert.equal(await openKey(envelope, old, owner), KEY);
  await assert.rejects(
    openKey(envelope, 'violet harbor lantern 58', owner),
    (e: unknown) => (e as VaultCryptoError).code === 'wrong_password',
  );
});
