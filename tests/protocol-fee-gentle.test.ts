import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { HttpRequestError, LimitExceededRpcError, RpcRequestError } from 'viem';
import {
  ARC_LOG_RANGE,
  PROTOCOL_FEE_SCAN_PATH,
  registerProtocolFeeCron,
} from '../server/protocol/fees/cron.js';
import {
  isRateLimitError,
  resetBloomTries,
  resetLearnedLogRange,
  scanFees,
} from '../server/protocol/fees/ledger.js';
import { ARC_MAINNET } from '../shared/chains.js';
import {
  countingChain,
  feeAt,
  feeConfig,
  feeDb,
  ROUTER,
  treasuryTransfer,
  USDC,
} from './helpers/fee-scan-fake.js';

const ARC = ARC_MAINNET;
const gentle = { logRange: 500n };
const limited = () => Object.assign(new Error('Request exceeds defined limit.'), { code: -32005 });
const headers = (requests: string[]) => requests.filter((r) => r.startsWith('header '));
const ranges = (requests: string[], address: string) =>
  requests
    .filter((r) => r.startsWith(`logs ${address}`))
    .map((r) => r.split(' ')[2]!.split('-').map(BigInt) as [bigint, bigint]);

async function feeBlocks(db: Awaited<ReturnType<typeof feeDb>>['db'], chainId = ARC) {
  const { rows } = await db.query<{ block_number: string; finalized: boolean }>(
    `SELECT block_number::text AS block_number, finalized FROM protocol_fee_events
     WHERE chain_id = $1 ORDER BY block_number`,
    [chainId],
  );
  return rows;
}
async function cursor(db: Awaited<ReturnType<typeof feeDb>>['db'], chainId = ARC) {
  const { rows } = await db.query<{ next_block: string; caught_up: boolean }>(
    'SELECT next_block::text AS next_block, caught_up FROM protocol_fee_scan_state WHERE chain_id = $1',
    [chainId],
  );
  return rows[0];
}
/** The ranges of one source cover [from, to] without a hole, however many runs asked. */
function assertCovered(requests: string[], address: string, from: bigint, to: bigint) {
  const sorted = ranges(requests, address).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let next = from;
  for (const [start, end] of sorted) {
    assert.ok(start <= next, `a hole before block ${start}`);
    if (end + 1n > next) next = end + 1n;
  }
  assert.ok(next > to, `read only up to ${next - 1n}`);
}

test('gentle: a catch-up reads headers only of blocks with fee logs, in small ranges', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const state = {
    logs: [...feeAt(1100n), ...feeAt(2600n), treasuryTransfer(3000n, 'donation')],
    latest: 4999n,
    finalized: 4999n,
  };
  const { chain, requests } = countingChain(state);
  const scan = () =>
    scanFees(db, chain, feeConfig(ARC), { maxBlocks: 5_000n, gentle, log: () => undefined });
  await scan();
  state.latest = 5100n;
  state.finalized = 5100n;
  await scan();

  // Two runs over about 4,100 blocks: no header at all for the empty ones. The blocks holding a
  // fee of the only source need none either; the one with a treasury transfer alone is checked.
  assert.deepEqual(headers(requests), ['header 3000']);
  assert.deepEqual(
    requests.filter((r) => r.startsWith('block ')).map((r) => r.split(' ')[1]),
    ['1100', '2600', '1100', '2600'],
  );
  for (const address of [USDC, ROUTER])
    for (const [start, end] of ranges(requests, address))
      assert.ok(end - start + 1n <= gentle.logRange, `${start}-${end}`);
  assert.ok(
    requests.filter((r) => r.startsWith('logs ')).length <= 2 * (2 * Math.ceil(4101 / 500) + 1),
    `${requests.length} requests`,
  );
  assert.deepEqual(await feeBlocks(db), [
    { block_number: '1100', finalized: true },
    { block_number: '2600', finalized: true },
  ]);
  assert.equal((await cursor(db))?.next_block, '5101');

  // The same story without gentle: a header per block (what the rehearsal counted).
  resetLearnedLogRange();
  const before = await feeDb(t);
  const loud = countingChain(state);
  await scanFees(before.db, loud.chain, feeConfig(84532), {
    maxBlocks: 5_000n,
    log: () => undefined,
  });
  await scanFees(before.db, loud.chain, feeConfig(84532), {
    maxBlocks: 5_000n,
    log: () => undefined,
  });
  assert.ok(headers(loud.requests).length > 3_000, `${headers(loud.requests).length}`);
});

test('gentle: a treasury transfer whose fee log the router read missed stays unpromoted', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const [transfer, fee] = feeAt(1200n);
  const state = { logs: [transfer!, fee!], latest: 1500n, finalized: 1500n };
  const { chain, requests } = countingChain(state);
  // The range read for the router misses the block; the block itself holds the event.
  const inner = chain.getLogs;
  chain.getLogs = async (input) =>
    (await inner(input)).filter((l) => l.address.toLowerCase() !== ROUTER);
  const options = { maxBlocks: 5_000n, gentle, log: () => undefined };
  await scanFees(db, chain, feeConfig(ARC), options);
  state.latest = 1600n;
  state.finalized = 1600n;
  await scanFees(db, chain, feeConfig(ARC), options);
  assert.deepEqual(headers(requests), ['header 1200']);
  const { rows } = await db.query<{ finalized_through: string }>(
    'SELECT finalized_through::text AS finalized_through FROM protocol_fee_scan_state WHERE chain_id = $1',
    [ARC],
  );
  assert.equal(rows[0]!.finalized_through, '1199');
});

test('gentle: a rate limit ends the run at once, never splits; the next run resumes, no block skipped', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const lines: string[] = [];
  const state = {
    logs: [...feeAt(1100n), ...feeAt(1750n), ...feeAt(2400n)],
    latest: 2999n,
    finalized: 2999n,
    refuse: undefined as undefined | ((request: string) => unknown),
  };
  const { chain, requests } = countingChain(state);
  const options = { maxBlocks: 5_000n, gentle, log: (l: string) => void lines.push(l) };
  // The third chunk's router read (USDC of that chunk already answered).
  state.refuse = (request) => (request === `logs ${ROUTER} 2000-2499` ? limited() : undefined);
  const first = await scanFees(db, chain, feeConfig(ARC), options);
  assert.equal(first?.partial, 'rate_limit');
  assert.equal(first?.to, 1999n);
  // Nothing more asked of the node than the times of the fees it will commit.
  const after = requests.slice(requests.indexOf(`logs ${ROUTER} 2000-2499`) + 1);
  assert.deepEqual(after, ['block 1100', 'block 1750']);
  assert.equal(
    requests.filter((r) => r.startsWith(`logs ${ROUTER} 2000`)).length,
    1,
    'never split',
  );
  assert.deepEqual(await cursor(db), { next_block: '2000', caught_up: false });
  assert.deepEqual(
    (await feeBlocks(db)).map((r) => r.block_number),
    ['1100', '1750'],
  );
  assert.ok(lines.some((l) => l.includes('protocol.fee_scan_rate_limited')));

  // Resumed: the fee in the interrupted chunk and everything after it are found.
  state.refuse = undefined;
  const second = await scanFees(db, chain, feeConfig(ARC), options);
  assert.equal(second?.partial, undefined);
  assert.deepEqual(
    (await feeBlocks(db)).map((r) => r.block_number),
    ['1100', '1750', '2400'],
  );
  assert.deepEqual(await cursor(db), { next_block: '3000', caught_up: true });
  for (const address of [USDC, ROUTER]) assertCovered(requests, address, 1000n, 2999n);

  // A third run confirms them all final, each exactly once.
  state.latest = 3100n;
  state.finalized = 3100n;
  await scanFees(db, chain, feeConfig(ARC), options);
  assert.deepEqual(await feeBlocks(db), [
    { block_number: '1100', finalized: true },
    { block_number: '1750', finalized: true },
    { block_number: '2400', finalized: true },
  ]);
});

test('gentle: rate limited inside a chunk, its logs are dropped and its fee is not reported unbacked', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const lines: string[] = [];
  const state = {
    logs: [...feeAt(1100n), ...feeAt(1600n)],
    latest: 1999n,
    finalized: 1999n,
    refuse: (request: string) =>
      request.startsWith(`logs ${ROUTER} 1500`) ? limited() : undefined,
  };
  const { chain } = countingChain(state);
  const run = await scanFees(db, chain, feeConfig(ARC), {
    maxBlocks: 5_000n,
    gentle,
    log: (l) => void lines.push(l),
  });
  assert.equal(run?.to, 1499n);
  assert.equal((await cursor(db))?.next_block, '1500');
  assert.deepEqual(
    (await feeBlocks(db)).map((r) => r.block_number),
    ['1100'],
  );
  assert.ok(!lines.some((l) => l.includes('unbacked')));
});

test('gentle: rate limited before anything was read, nothing is written and the cursor stands', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const state = {
    logs: feeAt(1100n),
    latest: 1999n,
    finalized: 1999n,
    refuse: undefined as undefined | ((request: string) => unknown),
  };
  const { chain, requests } = countingChain(state);
  const options = { maxBlocks: 5_000n, gentle, log: () => undefined };
  await scanFees(db, chain, feeConfig(ARC), options);
  const before = await cursor(db);
  assert.equal(before?.next_block, '2000');
  assert.equal(before?.caught_up, true);

  state.latest = 2500n;
  state.finalized = 2500n;
  state.refuse = (request) => (request.startsWith('logs ') ? limited() : undefined);
  const count = requests.length;
  const run = await scanFees(db, chain, feeConfig(ARC), options);
  assert.equal(run?.partial, 'rate_limit');
  assert.equal(run?.written, 0);
  assert.equal(run?.to, run!.from - 1n);
  assert.equal(requests.length, count + 3, 'the head, its final block, and one refused read');
  assert.deepEqual(await cursor(db), { next_block: '2000', caught_up: false });

  // Even the head refused: the same quiet end, no row in the first place.
  const fresh = await feeDb(t);
  state.refuse = (request) => (request === 'latest' ? limited() : undefined);
  const none = await scanFees(fresh.db, chain, feeConfig(ARC), options);
  assert.equal(none?.partial, 'rate_limit');
  assert.equal(none?.from, 1000n);
  assert.equal(await cursor(fresh.db), undefined);
});

test('gentle: any other read failure still fails the run and leaves the cursor', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const { chain } = countingChain({
    logs: [],
    latest: 1999n,
    finalized: 1999n,
    refuse: (request) => (request === 'latest' ? new Error('down') : undefined),
  });
  await assert.rejects(scanFees(db, chain, feeConfig(ARC), { gentle, log: () => undefined }));
  assert.equal(await cursor(db), undefined);
});

test('gentle: a refused range splits and is learned for that chain only; Base keeps its ranges', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const refused = Object.assign(new Error('block range too large'), { code: -32012 });
  const state = {
    logs: feeAt(1100n),
    latest: 2999n,
    finalized: 2999n,
    refuse: (request: string) => {
      if (!request.startsWith('logs ')) return undefined;
      const [start, end] = request.split(' ')[2]!.split('-').map(BigInt);
      return end! - start! + 1n > 200n ? refused : undefined;
    },
  };
  const arc = countingChain(state);
  await scanFees(db, arc.chain, feeConfig(ARC), {
    maxBlocks: 5_000n,
    gentle,
    log: () => undefined,
  });
  assert.equal((await cursor(db))?.next_block, '3000');
  assertCovered(arc.requests, USDC, 1000n, 2999n);
  // The first chunk learns the size that worked, the range grows back slowly: no cascade per chunk.
  const refusals = ranges(arc.requests, USDC).filter(([a, b]) => b - a + 1n > 200n);
  assert.ok(refusals.length <= 4, JSON.stringify(refusals.map(String)));

  const base = countingChain({ logs: [], latest: 2999n, finalized: 2999n });
  const other = await feeDb(t);
  await scanFees(other.db, base.chain, feeConfig(84532), { log: () => undefined });
  assert.equal(ranges(base.requests, USDC)[0]![1] - ranges(base.requests, USDC)[0]![0] + 1n, 1000n);
  resetLearnedLogRange();
});

test('isRateLimitError: rate limits through viem, not size refusals or outages', () => {
  const rpc = (code: number, details: string) =>
    new RpcRequestError({ body: {}, error: { code, message: details }, url: 'https://x.test' });
  assert.equal(isRateLimitError(new LimitExceededRpcError(rpc(-32005, 'busy'))), true);
  assert.equal(isRateLimitError(rpc(-32005, 'request rate exceeded')), true);
  assert.equal(
    isRateLimitError(new HttpRequestError({ url: 'https://x.test', status: 429 })),
    true,
  );
  assert.equal(isRateLimitError(new Error('Too Many Requests')), true);
  assert.equal(isRateLimitError(rpc(-32005, 'query returned more than 10000 results')), false);
  assert.equal(isRateLimitError(rpc(-32012, 'range too wide')), false);
  assert.equal(
    isRateLimitError(new HttpRequestError({ url: 'https://x.test', status: 503 })),
    false,
  );
  assert.equal(isRateLimitError(new Error('timed out')), false);
});

test('the Arc pass of the cron scans gently; a rate limit is in its answer, not a failure', async (t) => {
  resetLearnedLogRange();
  resetBloomTries();
  const { db } = await feeDb(t);
  const state = {
    logs: [] as ReturnType<typeof feeAt>,
    latest: 2999n,
    finalized: 2999n,
    refuse: undefined as undefined | ((request: string) => unknown),
  };
  const arc = countingChain(state);
  const base = countingChain({ logs: [], latest: 200n, finalized: 200n });
  const lines: string[] = [];
  const app = Fastify();
  t.after(() => app.close());
  registerProtocolFeeCron(app, {
    db,
    cronSecret: 'x'.repeat(32),
    env: {
      CITY_PROTOCOL_FEES: '1',
      CITY_PROTOCOL_CHAIN_ID: '84532',
      CITY_PROTOCOL_TREASURY: '0x00000000000000000000000000000000000007e5',
      CITY_PROTOCOL_ROUTER: '0x0000000000000000000000000000000000000040',
      CITY_PROTOCOL_START_BLOCK: '100',
      CITY_ARC: '1',
      CITY_ARC_FEE_ROUTER3: ROUTER,
      CITY_ARC_FEE_ROUTER3_FROM_BLOCK: '1000',
    },
    chainFor: () => base.chain,
    arcChainFor: () => arc.chain,
    log: (l) => void lines.push(l),
  });
  const cron = () =>
    app.inject({
      method: 'GET',
      url: PROTOCOL_FEE_SCAN_PATH,
      headers: { authorization: `Bearer ${'x'.repeat(32)}` },
    });
  const ok = await cron();
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().arc.to, '2999');
  assert.deepEqual(headers(arc.requests), []);
  const logReads = arc.requests.filter((r) => r.startsWith('logs ')).map((r) => r.split(' ')[2]!);
  assert.ok(
    logReads.every((r) => {
      const [a, b] = r.split('-').map(BigInt);
      return b! - a! + 1n <= ARC_LOG_RANGE;
    }),
  );

  state.latest = 3100n;
  state.finalized = 3100n;
  state.refuse = (request) => (request.startsWith('logs ') ? limited() : undefined);
  const slowed = await cron();
  assert.equal(slowed.statusCode, 200);
  assert.equal(slowed.json().arc.partial, 'rate_limit');
  assert.equal(slowed.json().arc.failed, undefined);
  assert.ok(lines.some((l) => l.includes('protocol.fee_scan_rate_limited')));
  assert.ok(!lines.some((l) => l.includes('arc_failed')));
});
