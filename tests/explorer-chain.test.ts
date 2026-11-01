import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARC_EXPLORER_CHAIN,
  BASE_EXPLORER_CHAIN,
  arcEnabled,
  explorerChainOf,
  resetArcProbe,
} from '../src/explorer/chain';
import { loadRatedIds } from '../src/explorer/listRead';
import { parseHeads } from '../src/explorer/x3Client';
import { ON_BASE_PATHS } from '../shared/base/on-base';

const HASH = `0x${'ab'.repeat(32)}`;
const WALLET = '0x1111111111111111111111111111111111111111';

test('Base keeps its paths, pages and Basescan links', () => {
  const base = explorerChainOf('base');
  assert.equal(base, BASE_EXPLORER_CHAIN);
  assert.deepEqual(base.paths, ON_BASE_PATHS);
  assert.equal(base.name, 'Base');
  assert.equal(base.chainId, 8453);
  assert.equal(base.home, '/explorer/base');
  assert.equal(base.agentPath('42'), '/explorer/agents/42');
  assert.equal(base.txUrl(HASH), `https://basescan.org/tx/${HASH}`);
  assert.equal(base.addressUrl(WALLET), `https://basescan.org/address/${WALLET}`);
});

test("Arc reads /api/public/arc and links to Arc's explorer", () => {
  const arc = explorerChainOf('arc');
  assert.equal(arc, ARC_EXPLORER_CHAIN);
  assert.equal(arc.name, 'Arc');
  assert.equal(arc.chainId, 5042);
  assert.deepEqual(arc.paths, {
    list: '/api/public/arc/agents',
    passport: '/api/public/arc/agents',
    rated: '/api/public/arc/rated',
  });
  assert.equal(arc.home, '/explorer/arc');
  assert.equal(arc.agentPath('7'), '/explorer/arc/agents/7');
  assert.equal(arc.txUrl(HASH), `https://explorer.arc.io/tx/${HASH}`);
  assert.equal(arc.addressUrl(WALLET), `https://explorer.arc.io/address/${WALLET}`);
  assert.match(arc.registry, /^0x8004/);
});

test('the Arc probe: 200 is on, anything else off, asked once per session', async () => {
  for (const [status, on] of [
    [200, true],
    [404, false],
    [503, false],
  ] as const) {
    resetArcProbe();
    let asked = 0;
    const fetcher = (async (url: string) => {
      asked += 1;
      assert.equal(url, '/api/public/arc/rated');
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    assert.equal(await arcEnabled(fetcher), on);
    assert.equal(await arcEnabled(fetcher), on);
    assert.equal(asked, 1);
  }
  resetArcProbe();
  const failing = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.equal(await arcEnabled(failing), false);
  resetArcProbe();
});

test("the rated ids read another chain's path when given one", async () => {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(url);
    return Response.json({ baseIds: ['3'], asOf: 1 });
  }) as unknown as typeof fetch;
  await loadRatedIds(undefined, fetcher);
  await loadRatedIds(undefined, fetcher, ARC_EXPLORER_CHAIN.paths.rated);
  assert.deepEqual(asked, ['/api/public/base/rated', '/api/public/arc/rated']);
});

test("heads are accepted for the view's chain only", () => {
  const body = (chainId: number) => ({ chainId, latest: '3', safe: '2', finalized: '1', asOf: 1 });
  assert.equal(parseHeads(body(5042)), null, 'Base by default');
  assert.equal(parseHeads(body(5042), 5042)!.latest, 3n);
  assert.equal(parseHeads(body(8453), 5042), null);
});
