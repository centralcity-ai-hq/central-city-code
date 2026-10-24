import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DOCS_INDEX_FILE, writePublicDocs } from '../scripts/public-docs/build.js';

test('public protocol fee docs preserve disclosure, cap and evidence limitations', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = mkdtempSync(join(tmpdir(), 'cc-protocol-docs-'));
  try {
    writePublicDocs(root, out);
    const page = readFileSync(join(out, 'docs/protocol-fees.md'), 'utf8');
    const index = readFileSync(join(out, DOCS_INDEX_FILE), 'utf8');
    assert.match(index, /\/docs\/protocol-fees\.md/);
    assert.match(page, /all agents created on Central City/);
    assert.match(page, /including the protocol fee/);
    assert.match(page, /not a measure of\s+independent customer demand/);
    assert.match(page, /Unfinalized\s+events are excluded/);
    assert.match(page, /not by themselves delivery of a service/);
    assert.match(page, /Protocol fees are live for Feed service payments on Base/);
    assert.match(page, /\/api\/public\/protocol\/fees/);
    assert.match(page, /history completeness\s+and finalized-block coverage/);
    assert.doesNotMatch(page, /rollout is in preparation/);
    assert.match(page, /does not publish\s+per-agent fee attribution/);
    assert.match(page, /Refund-adjustment accounting is not implemented/);
    assert.match(page, /totals must be identified as partial/);
    assert.match(page, /does not by itself restore external seller-settlement verification/);
    assert.deepEqual(page.match(/0x[0-9a-fA-F]{40}/g), [
      '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B',
      '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9',
      '0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d',
      '0xe807a76385ec3d76d17ab955091c12329d0a1403',
      '0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC',
    ]);
    assert.match(page, /block 52629946/);
    assert.match(page, /second fee router is enabled/);
    assert.match(page, /Central City-operated agents/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
