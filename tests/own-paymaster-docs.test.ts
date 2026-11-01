import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// docs/base/OWN_PAYMASTER*.md: no owner identity or custody, and the signer leak / rotation runbook.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('own paymaster docs neither name the owner nor describe its key custody', () => {
  for (const path of ['docs/base/OWN_PAYMASTER.md', 'docs/base/OWN_PAYMASTER_OPS.md']) {
    const doc = read(path);
    assert.doesNotMatch(doc, /owner-held|never on any server/, path);
    assert.doesNotMatch(doc, /block 53086671/, path);
  }
  assert.doesNotMatch(
    read('server/base/chain/own-paymaster-keys.ts'),
    /stress\s+\*?\s*server/,
    'the owner key is not described as living on a server',
  );
});

test('ops doc has the signer leak and rotation runbook in the safe order', () => {
  const doc = read('docs/base/OWN_PAYMASTER_OPS.md');
  const section = doc.slice(doc.indexOf('## Signer leak and signer rotation'));
  assert.ok(section.length > 0 && doc.includes('## Signer leak and signer rotation'));
  assert.match(section, /accepts a pending signer immediately/);
  assert.match(section, /refuses to sponsor on an unexpected pending signer/);
  const steps = section.slice(section.indexOf('### Signer leak (or suspected leak)'));
  const order = [
    'Withdraw the deposit first',
    'withdrawTo(',
    'The owner calls\n   `setPendingVerifyingSigner(new)`',
    'CITY_BASE_PAYMASTER_SIGNER_KEY_REF` set to the new key',
    'the owner calls `rotateVerifyingSigner()`',
    '**Verify**',
  ].map((needle) => steps.indexOf(needle));
  assert.ok(
    order.every((at) => at >= 0),
    `missing step: ${order}`,
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
});

test('sponsor key docs say it also sends router-3 transactions', () => {
  assert.match(read('server/feed/pay/sponsor-key.ts'), /also SENDS the router-3 settlement/);
  assert.match(
    read('docs/protocol/SPONSORED_FIRST_PURCHASE.md'),
    /also sends the router-3 settlement transactions from its own EOA/,
  );
});
