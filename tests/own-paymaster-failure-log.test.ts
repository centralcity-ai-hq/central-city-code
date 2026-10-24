import test from 'node:test';
import assert from 'node:assert/strict';
import { failureOf } from '../server/base/chain/direct-bundler.js';

// The upkeep failure line names the error class and its codes, never anything free-form.
test('failureOf keeps known names and code-shaped codes, never a secret or a message', () => {
  const secret = Object.assign(new Error('https://rpc.example/v1/SECRET-IN-MESSAGE'), {
    name: 'https://rpc.example/SECRET-NAME',
    code: 'key=SECRET-CODE',
  });
  const line = failureOf(secret);
  assert.ok(!line.includes('SECRET'), line);
  assert.equal(line, 'other code=- rpc=- http=-');
  // A database error (SQLSTATE) and a viem RPC error keep what identifies them.
  assert.equal(
    failureOf(Object.assign(new Error('x'), { code: '40001' })),
    'Error code=40001 rpc=- http=-',
  );
  assert.equal(
    failureOf(Object.assign(new Error('x'), { name: 'RpcRequestError', code: -32005 })),
    'RpcRequestError code=-32005 rpc=- http=-',
  );
  assert.equal(
    failureOf(Object.assign(new Error('x'), { name: 'HttpRequestError', status: 429 })),
    'HttpRequestError code=- rpc=- http=429',
  );
  assert.equal(failureOf(null), 'other code=- rpc=- http=-');
});

test('failureOf names our own fixed guard messages exactly, and nothing else', () => {
  assert.equal(
    failureOf(new Error('A cost is never negative.')),
    'Error code=- rpc=- http=- msg=A cost is never negative.',
  );
  // Any other message, even one that only starts like ours, stays out.
  assert.equal(
    failureOf(new Error('A cost is never negative. https://x/SECRET')),
    'Error code=- rpc=- http=-',
  );
});
