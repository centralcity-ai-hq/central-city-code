import assert from 'node:assert/strict';
import test from 'node:test';
import { ON_BASE_QUERY_MAX } from '../shared/base/on-base';
import { loadOnBase } from '../src/verify/onBaseData';

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
