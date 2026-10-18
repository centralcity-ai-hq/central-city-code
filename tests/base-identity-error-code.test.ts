import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode } from '../server/base/identity/service.js';

test('errorCode keeps string codes', () => {
  assert.equal(
    errorCode(Object.assign(new Error('x'), { code: 'IDENTITY_NOT_HELD' })),
    'IDENTITY_NOT_HELD',
  );
});

test('errorCode names numeric RPC errors through the cause chain, never the message', () => {
  const inner = Object.assign(new Error('https://api.example/rpc/SECRET failed'), {
    name: 'RpcRequestError',
    code: -32000,
  });
  const outer = Object.assign(new Error('wrapped https://api.example/rpc/SECRET'), {
    cause: inner,
  });
  const code = errorCode(outer);
  assert.equal(code, 'RpcRequestError:-32000');
  assert.ok(!code.includes('SECRET'));
});

test('errorCode uses an HTTP status and falls back to the class name', () => {
  assert.equal(
    errorCode(Object.assign(new Error('x'), { name: 'HttpRequestError', status: 429 })),
    'HttpRequestError:429',
  );
  assert.equal(errorCode(new TypeError('x')), 'TypeError');
  assert.equal(errorCode(null), 'error');
  assert.equal(errorCode(Object.assign(new Error('x'), { name: 'bad name with spaces' })), 'error');
});

test('errorDetail names the RPC method and block shape and strips URLs and long hex', async () => {
  const { errorDetail } = await import('../server/base/identity/service.js');
  const rpc = Object.assign(new Error('RPC Request failed.'), {
    name: 'RpcRequestError',
    code: -32002,
    details: 'resource not available at https://node.example/v1/SECRET for 0x' + 'ab'.repeat(32),
    metaMessages: [
      'URL: https://node.example/v1/SECRET',
      'Request body: {"method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"0x2"}]}',
    ],
  });
  const outer = Object.assign(new Error('x'), { name: 'ResourceUnavailableRpcError', cause: rpc });
  const d = errorDetail(outer);
  assert.equal(d.method, 'eth_getLogs');
  assert.equal(d.block, 'none');
  assert.ok(d.detail && !d.detail.includes('SECRET') && !d.detail.includes('abab'));
  const call = Object.assign(new Error('x'), {
    metaMessages: ['Request body: {"method":"eth_call","params":[{"to":"0x1"},"0x10"]}'],
  });
  assert.deepEqual(errorDetail(call), { method: 'eth_call', block: 'number' });
  assert.deepEqual(errorDetail(new Error('plain')), {});
});

test('errorDetail removes bare hosts and long tokens that carry no scheme', async () => {
  const { errorDetail } = await import('../server/base/identity/service.js');
  const e = Object.assign(new Error('x'), {
    details:
      'denied for key Zk3pQ9vT7mW2xR8yL4nB6cH1dF5gJ0aS at api.node.example/v1/abc rate limited',
  });
  const d = errorDetail(e).detail ?? '';
  assert.ok(!d.includes('Zk3pQ9vT7mW2xR8yL4nB6cH1dF5gJ0aS'), d);
  assert.ok(!d.includes('node.example'), d);
  assert.ok(d.includes('rate limited'), d);
});
