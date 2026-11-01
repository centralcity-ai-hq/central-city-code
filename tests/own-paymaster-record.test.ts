import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getAddress } from 'viem';
import { OWN_PAYMASTER_RECORD as R } from '../shared/base/own-paymaster-record.js';
import { SPONSOR_PAYMASTERS } from '../shared/base/paymasters.js';
import { BASE_MAINNET } from '../shared/base/chains.js';

// CCA-747 / CCA-748 / CCA-720: the paymaster's owner and deploy record have one source in code
// (shared/base/own-paymaster-record.ts), and the documents must agree with it. No network.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const DOCS = ['docs/base/OWN_PAYMASTER.md', 'docs/base/OWN_PAYMASTER_OPS.md'];
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

test('every address in the record is in its checksum form', () => {
  const addresses = [R.address, R.entryPoint, R.verifyingSigner];
  for (const address of addresses) assert.equal(getAddress(address), address, address);
  assert.match(R.deploy.tx, /^0x[0-9a-f]{64}$/);
});

test('the record is consistent with the pinned paymaster and keeps no owner identity', () => {
  assert.equal(R.chainId, BASE_MAINNET);
  assert.ok(SPONSOR_PAYMASTERS[BASE_MAINNET]!.includes(R.address));
  for (const key of ['owner', 'previousOwner', 'ownerSinceBlock']) assert.ok(!(key in R), key);
  for (const key of ['deployer', 'constructorArgs']) assert.ok(!(key in R.deploy), key);
});

test('the paymaster docs keep one owner row and name no owner address', () => {
  for (const path of ['docs/base/OWN_PAYMASTER.md', 'docs/base/OWN_PAYMASTER_OPS.md']) {
    const doc = read(path);
    const ownerRows = doc.split('\n').filter((line) => /^\| *Paymaster owner/.test(line));
    assert.equal(ownerRows.length, 1, `${path}: one owner row`);
    assert.deepEqual(
      ownerRows[0]!.match(ADDRESS) ?? [],
      [],
      `${path}: the owner row names no address`,
    );
    assert.doesNotMatch(doc, /owner changed at|previously|before it the owner/, path);
    assert.ok(doc.includes(R.address), path);
  }
});

test('every address in the paymaster docs is checksummed, and each one the record knows is spelled as the record spells it', () => {
  const known = new Map(
    [R.address, R.entryPoint, R.verifyingSigner].map((a) => [a.toLowerCase(), a]),
  );
  for (const path of DOCS) {
    for (const address of read(path).match(ADDRESS) ?? []) {
      assert.equal(getAddress(address), address, `${path}: ${address} is not checksummed`);
      const expected = known.get(address.toLowerCase());
      if (expected) assert.equal(address, expected, path);
    }
  }
});
