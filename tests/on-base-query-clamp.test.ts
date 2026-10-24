import assert from 'node:assert/strict';
import test from 'node:test';
import { ON_BASE_QUERY_MAX } from '../shared/base/on-base';
import { loadOnBase, ON_BASE_LIST_TIMEOUT_MS } from '../src/verify/onBaseData';

test('the On Base list never sends a search longer than the server accepts', async (t) => {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    asked.push(path);
    return new Response(JSON.stringify({ rows: [] }), { status: 200 });
  });
  await loadOnBase({ q: `  ${'a'.repeat(ON_BASE_QUERY_MAX + 40)}  ` });
  await loadOnBase({ q: '  99268 ' });
  const sent = asked.map((path) => new URL(path, 'https://x').searchParams.get('q'));
  assert.equal(sent[0], 'a'.repeat(ON_BASE_QUERY_MAX));
  assert.equal(sent[1], '99268');
});

test('with a timeout, a list read that never answers fails instead of loading for ever', async (t) => {
  let aborted = false;
  t.mock.method(
    globalThis,
    'fetch',
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  );
  const started = Date.now();
  await assert.rejects(loadOnBase({ q: '', timeoutMs: 30 }), /no answer within 30 ms/);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(aborted, true);
  // An error status fails the same way; an answer in time is returned.
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  await assert.rejects(loadOnBase({ timeoutMs: 1_000 }), /503/);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ rows: [], nextBefore: null }), { status: 200 }),
  );
  assert.deepEqual(await loadOnBase({ timeoutMs: 1_000 }), { rows: [], nextBefore: null });
  assert.equal(ON_BASE_LIST_TIMEOUT_MS, 15_000);
});
