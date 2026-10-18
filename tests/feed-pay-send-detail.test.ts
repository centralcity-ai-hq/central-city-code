import assert from 'node:assert/strict';
import test from 'node:test';
import { sendFailureCode, sendFailureDetail } from '../server/feed/pay/engine.js';

test('a paymaster policy rejection is logged as fixed labels with its method selector', () => {
  const inner = Object.assign(new Error('Request denied'), {
    details: 'policy rejected: called method not in allowlist: 0x5e5571ac',
  });
  const outer = Object.assign(new Error('UserOperation failed'), { cause: inner });
  assert.equal(
    sendFailureDetail(outer),
    'paymaster_policy_rejected,request_denied,selector:0x5e5571ac',
  );
});

test('free provider text never reaches the log, whatever shape a credential has', () => {
  // Synthetic stand-ins, built at run time.
  const quoted = JSON.stringify({ ['api' + '_key']: 'syntheticShort123' });
  const bearer = 'Authorization: Bearer ' + 'q'.repeat(10);
  for (const message of [quoted, bearer, 'password="hunter"', 'some other words']) {
    const text = sendFailureDetail(new Error(message));
    assert.doesNotMatch(text, /synthetic|qqqq|hunter|words/);
    assert.equal(text, 'unrecognized');
  }
});

test('rate limits and EntryPoint codes are labelled', () => {
  assert.equal(sendFailureDetail(new Error('HTTP 429: rate limited')), 'rate_limited');
  assert.equal(sendFailureDetail(new Error('AA21 didn’t pay prefund')), 'entrypoint:AA21');
  assert.equal(sendFailureDetail('x'), '');
  assert.equal(sendFailureDetail(null), '');
});

test('the code is a bounded scalar: an UPPER_SNAKE name or an integer, never an object or free text', () => {
  assert.equal(sendFailureCode({ code: -32002 }), -32002);
  assert.equal(sendFailureCode({ code: 'INSUFFICIENT_BALANCE' }), 'INSUFFICIENT_BALANCE');
  assert.equal(sendFailureCode({ code: 'key=secret value' }), null);
  assert.equal(sendFailureCode({ code: { nested: 'x' } }), null);
  assert.equal(sendFailureCode(null), null);
});
