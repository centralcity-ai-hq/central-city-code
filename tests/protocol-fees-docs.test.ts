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
    assert.match(page, /history\s+completeness\s+and\s+finalized-block\s+coverage/);
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
    // CCA-127: the fee count is an event count anyone can raise, not the number of paid calls.
    assert.match(page, /not the number of paid calls/);
    assert.match(page, /anyone\s+can add to it for the smallest fee/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('FEES.md describes the fee leg the engine runs: its states, no automatic retry (R1-31)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fees = readFileSync(join(root, 'docs/protocol/FEES.md'), 'utf8');
  const schema = readFileSync(join(root, 'server/feed/pay/fee-schema.ts'), 'utf8');
  const states = /fee_state IN \(([^)]*)\)\)/.exec(schema)?.[1]?.match(/[a-z_]+/g) ?? [];
  assert.deepEqual(states, ['pending', 'sent', 'charged', 'not_owed', 'failed']);
  for (const state of states) assert.match(fees, new RegExp(`\\| \`${state}\` +\\|`), state);
  // Promised before, never built: a fee_retry state and a daily re-send.
  assert.doesNotMatch(fees, /fee_retry/);
  assert.doesNotMatch(fees, /daily reconcile/i);
  assert.match(fees, /no automatic fee retry/);
  assert.match(fees, /reviewed by hand/);
});

test('FEES.md states the routers’ error precision: input checks before RefMismatch, ZeroAddress as a refusal, feeFor’s domain (CCA-125)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fees = readFileSync(join(root, 'docs/protocol/FEES.md'), 'utf8').replace(/\s+/g, ' ');
  const router = readFileSync(join(root, 'contracts/fees/CentralCityFeeRouter.sol'), 'utf8');
  // The behaviour the doc describes: the payee and amount checks run before the commitment check.
  const start = router.slice(router.indexOf('function _start'));
  assert.ok(start.indexOf('revert ZeroAddress') < start.indexOf('revert RefMismatch'));
  assert.ok(start.indexOf('revert BadAmount') < start.indexOf('revert RefMismatch'));
  assert.match(start, /payee == treasury\) revert ZeroAddress/);
  assert.doesNotMatch(fees, /retry with any field changed reverts with `RefMismatch`, so/);
  assert.match(fees, /once it passes the input checks, which run first/);
  assert.match(fees, /read it as "payee or payer refused"/);
  assert.match(fees, /defined for `gross <= MAX_TOTAL`/);
});

test('FEES.md says which fee-on-top values the payer declares rather than the router checks (CCA-128)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fees = readFileSync(join(root, 'docs/protocol/FEES.md'), 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(fees, /The buyer has already paid the seller `gross` through x402\./);
  assert.match(fees, /`payee` and `gross` are declared by the caller and are not checked on chain/);
  assert.match(fees, /`MAX_TOTAL` bounds only the declared price/);
  assert.match(fees, /enforces the total a buyer may spend off chain/);
});

test('the fee ledger code comments describe the ledger as production runs it (CCA-134)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const ledger = readFileSync(join(root, 'server/protocol/fees/ledger.ts'), 'utf8');
  const cron = readFileSync(join(root, 'server/protocol/fees/cron.ts'), 'utf8');
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
    crons: { path: string; schedule: string }[];
  };
  for (const stale of [
    /Unwired for now/,
    /Not registered until the ledger is wired/,
    /daily reconcile/i,
  ])
    assert.doesNotMatch(ledger, stale);
  assert.match(ledger, /No scan or cron calls it/);
  // The scan schedule the comments name is the one vercel.json runs.
  const scan = vercel.crons.find((c) => c.path === '/api/cron/protocol-fee-scan');
  assert.equal(scan?.schedule, '*/5 * * * *');
  assert.match(cron, /every 5 minutes/);
  assert.doesNotMatch(cron, /every minute/);
});

test('FEES.md says exactly what fee_count counts and that anyone can raise it (CCA-127)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fees = readFileSync(join(root, 'docs/protocol/FEES.md'), 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(fees, /`fee_count` counts every fee\./);
  assert.match(fees, /`fee_count` counts exactly the fees that `fees_usdc` sums/);
  assert.match(fees, /`FeeCharged` on routers 1 and 2 is permissionless/);
  assert.match(fees, /`fee_count` is an event count, not an activity count/);
  assert.match(fees, /It is not a count of paid calls; `payments` is\./);
});
