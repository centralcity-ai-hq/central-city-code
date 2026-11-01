import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEE_CHARGED,
  identityOutcome,
  ratingOutcome,
  receiptOutcome,
} from '../src/explorer/proofModel';
import type { VerifyResult, VerifyTick } from '../src/verify/onBaseData';

const ROUTER = '0xe807a76385ec3d76d17ab955091c12329d0a1403';
const ROUTERS = new Set([ROUTER]);
const PAYER = '0x939cd93a1a44a5dede85435364dd49d718ac69dd';
const PAYEE = '0x524c827cd1d5691817706763fb67574d107578b1';
const REF = `0x${'49'.repeat(32)}`;
const pad = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const call = { payer: PAYER, provider: PAYEE, ref: REF };
const log = (over: Partial<{ address: string; topics: string[] }> = {}) => ({
  address: ROUTER,
  topics: [FEE_CHARGED, pad(PAYER), pad(PAYEE), REF],
  ...over,
});

test('a receipt proves its row only with the router FeeCharged for the same payer, payee and ref', () => {
  assert.equal(receiptOutcome(call, { status: '0x1', logs: [log()] }, ROUTERS), 'pass');
  assert.equal(
    receiptOutcome(
      { ...call, payer: PAYER.toUpperCase().replace('0X', '0x') },
      { status: '0x1', logs: [log()] },
      ROUTERS,
    ),
    'pass',
    'addresses compare case-insensitively',
  );
});

test('a receipt is rejected for an unrelated event, address, payer, payee, ref or a failed transaction', () => {
  const cases: Array<[string, Parameters<typeof receiptOutcome>[1]]> = [
    ['reverted', { status: '0x0', logs: [log()] }],
    [
      'not a router',
      { status: '0x1', logs: [log({ address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' })] },
    ],
    [
      'other event',
      {
        status: '0x1',
        logs: [log({ topics: [`0x${'dd'.repeat(32)}`, pad(PAYER), pad(PAYEE), REF] })],
      },
    ],
    [
      'wrong payer',
      { status: '0x1', logs: [log({ topics: [FEE_CHARGED, pad(PAYEE), pad(PAYEE), REF] })] },
    ],
    [
      'wrong payee',
      { status: '0x1', logs: [log({ topics: [FEE_CHARGED, pad(PAYER), pad(PAYER), REF] })] },
    ],
    [
      'wrong ref',
      {
        status: '0x1',
        logs: [log({ topics: [FEE_CHARGED, pad(PAYER), pad(PAYEE), `0x${'00'.repeat(32)}`] })],
      },
    ],
    [
      'missing ref',
      { status: '0x1', logs: [log({ topics: [FEE_CHARGED, pad(PAYER), pad(PAYEE)] })] },
    ],
    ['no logs', { status: '0x1', logs: [] }],
  ];
  for (const [name, receipt] of cases)
    assert.equal(receiptOutcome(call, receipt, ROUTERS), 'fail', name);
  assert.equal(
    receiptOutcome(call, null, ROUTERS),
    'none',
    'no receipt is no answer, never a fail',
  );
});

const tick = (state: VerifyTick['state']): VerifyTick => ({ state, evidence: '' });
const checked = (over: Partial<Extract<VerifyResult, { kind: 'checked' }>> = {}): VerifyResult => ({
  kind: 'checked',
  owner: tick('pass'),
  uri: tick('pass'),
  registeredBy: tick('pass'),
  final: tick('pass'),
  block: 1,
  rpc: 'https://mainnet.base.org',
  ...over,
});

test('a ratings check passes only when the score itself was recomputed on Base', () => {
  assert.equal(ratingOutcome(checked({ score: tick('pass') })), 'pass');
  assert.equal(
    ratingOutcome(checked()),
    'none',
    'all identity checks pass but no score check: never a pass',
  );
  assert.equal(
    ratingOutcome(checked({ score: tick('pending') })),
    'none',
    'a score not read is not confirmed, never a pass',
  );
  assert.equal(ratingOutcome(checked({ score: tick('fail') })), 'fail');
  assert.equal(ratingOutcome(checked({ owner: tick('fail'), score: tick('pass') })), 'fail');
  assert.equal(ratingOutcome({ kind: 'unreachable' }), 'none');
});

test('an identity check: a failed tick is a fail, an unanswered (pending) tick is no answer, never red', () => {
  assert.equal(identityOutcome(checked()), 'pass');
  assert.equal(
    identityOutcome(checked({ registeredBy: tick('pending') })),
    'none',
    'an unreadable registration file is no answer',
  );
  assert.equal(identityOutcome(checked({ final: tick('pending') })), 'none', 'not final yet');
  assert.equal(identityOutcome(checked({ uri: tick('fail') })), 'fail');
  assert.equal(
    identityOutcome(checked({ registeredBy: tick('pending'), owner: tick('fail') })),
    'fail',
    'a fail outweighs a pending tick',
  );
  assert.equal(identityOutcome({ kind: 'unreachable' }), 'none');
  assert.equal(
    ratingOutcome(checked({ registeredBy: tick('pending'), score: tick('pass') })),
    'none',
    'ratings: an unreadable file is no answer, not a fail',
  );
  assert.equal(
    ratingOutcome(checked({ registeredBy: tick('pending'), score: tick('fail') })),
    'fail',
  );
});
