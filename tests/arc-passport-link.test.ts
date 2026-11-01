import assert from 'node:assert/strict';
import test from 'node:test';
import { arcPassportPage } from '../src/verify/passportChain';

type Read = NonNullable<NonNullable<Parameters<typeof arcPassportPage>[1]>['read']>;
const listed = (rows: Array<{ short: string; baseId: string }>): Read =>
  (async () => ({ rows })) as unknown as Read;

test("an Arc agent's short id opens its Arc Explorer page", async () => {
  const seen: unknown[] = [];
  const read = (async (query: unknown) => {
    seen.push(query);
    return { rows: [{ short: 'abc123', baseId: '77' }] };
  }) as unknown as Read;
  const page = await arcPassportPage('abc123', { on: async () => true, read });
  assert.equal(page, '/explorer/arc/agents/77');
  assert.deepEqual(seen, [{ q: 'abc123', listPath: '/api/public/arc/agents' }]);
});

test('only the exact short id counts: a search hit on another agent is no passport', async () => {
  const read = listed([{ short: 'abc124', baseId: '78' }]);
  assert.equal(await arcPassportPage('abc123', { on: async () => true, read }), null);
});

test('Arc off: nothing is asked and there is no page', async () => {
  const read = (async () => assert.fail('Arc is off: no read')) as unknown as Read;
  assert.equal(await arcPassportPage('abc123', { on: async () => false, read }), null);
});

test('a failed read is not "no such agent": it stays an error for the page', async () => {
  const read = (async () => {
    throw new Error('503');
  }) as unknown as Read;
  await assert.rejects(arcPassportPage('abc123', { on: async () => true, read }));
});
