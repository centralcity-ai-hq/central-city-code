import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, toHex, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import {
  dailyFees,
  FEE_EVENTS_ABI,
  feeOnChain,
  historyComplete,
  markServiceVerified,
  feeRowsFromLogs,
  PROTOCOL_FEE_LEDGER_SQL,
  protocolFeeLedgerMigration,
  REORG_DEPTH,
  resetLearnedLogRange,
  scanFees,
  type ChainLog,
  type FeeChain,
  type FeeLedgerConfig,
} from '../server/protocol/fees/ledger.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const USDC = addr(0xc0);
const TREASURY = addr(0x7e);
const ROUTER = addr(0x40);
const ESCROW = addr(0xe5);
const OPERATOR = addr(0x0b);
const PAYER = addr(0xa1);
const SELLER = addr(0x5e);
const config: FeeLedgerConfig = {
  chainId: 84532,
  usdc: USDC,
  treasury: TREASURY,
  router: ROUTER,
  escrow: { address: ESCROW, operator: OPERATOR },
  startBlock: 100n,
};
const ref = (s: string) => keccak256(toHex(s));
const hash = (s: string) => keccak256(toHex(`tx:${s}`));
const blockHash = (n: bigint, fork = '') => keccak256(toHex(`block:${n}${fork}`));

function feeCharged(
  tx: string,
  block: bigint,
  logIndex: number,
  a: { ref: string; kind: number; gross: bigint; fee: bigint; emitter?: Hex; fork?: string },
): ChainLog {
  return {
    address: a.emitter ?? ROUTER,
    topics: encodeEventTopics({
      abi: FEE_EVENTS_ABI,
      eventName: 'FeeCharged',
      args: { payer: PAYER, payee: SELLER, ref: ref(a.ref) },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
      [a.kind, a.gross, a.fee],
    ),
    transactionHash: hash(tx),
    logIndex,
    blockNumber: block,
    blockHash: blockHash(block, a.fork),
  };
}
function transfer(
  tx: string,
  block: bigint,
  logIndex: number,
  to: Hex,
  value: bigint,
  token = USDC,
  fork = '',
): ChainLog {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: FEE_EVENTS_ABI,
      eventName: 'Transfer',
      args: { from: PAYER, to },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    transactionHash: hash(tx),
    logIndex,
    blockNumber: block,
    blockHash: blockHash(block, fork),
  };
}
function paymentCharged(
  tx: string,
  block: bigint,
  logIndex: number,
  a: { operator?: Hex; feeReceiver?: Hex; token?: Hex; amount: bigint; fee: bigint },
): ChainLog {
  const info = {
    operator: a.operator ?? OPERATOR,
    payer: PAYER,
    receiver: SELLER,
    token: a.token ?? USDC,
    maxAmount: a.amount,
    preApprovalExpiry: 1,
    authorizationExpiry: 2,
    refundExpiry: 3,
    minFeeBps: 1000,
    maxFeeBps: 1000,
    feeReceiver: a.feeReceiver ?? TREASURY,
    salt: 7n,
  };
  const ev = FEE_EVENTS_ABI.find((x) => x.type === 'event' && x.name === 'PaymentCharged')!;
  const inputs = (ev as { inputs: readonly { indexed?: boolean }[] }).inputs.filter(
    (i) => !i.indexed,
  );
  return {
    address: ESCROW,
    topics: encodeEventTopics({
      abi: FEE_EVENTS_ABI,
      eventName: 'PaymentCharged',
      args: { paymentInfoHash: ref(`pi:${tx}`) },
    }) as Hex[],
    data: encodeAbiParameters(
      inputs as never,
      [info, a.amount, addr(0x3009), a.fee, a.feeReceiver ?? TREASURY] as never,
    ),
    transactionHash: hash(tx),
    logIndex,
    blockNumber: block,
    blockHash: blockHash(block),
  };
}

async function recorded(db: Database, r: Hex, finalizedOnly = false) {
  const res = await db.query(
    `SELECT 1 FROM protocol_fee_events WHERE chain_id = 84532 AND payer = $1 AND ref = $2 ${finalizedOnly ? 'AND finalized' : ''}`,
    [PAYER.toLowerCase(), r],
  );
  return res.rows.length > 0;
}

async function setup(t: test.TestContext) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return db;
}

function fakeChain(state: { latest: bigint; finalized: bigint; logs: ChainLog[] }): FeeChain {
  return {
    latestBlock: async () => state.latest,
    finalizedBlock: async () => state.finalized,
    // 2026-10-14T00:00:00Z + 2 s blocks; the canonical hash is the one the current logs carry.
    block: async (n) => ({
      timestamp: 1_791_936_000n + n * 2n,
      hash: state.logs.find((l) => l.blockNumber === n)?.blockHash ?? blockHash(n),
    }),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      assert.ok(toBlock - fromBlock < 1_000n, 'getLogs range stays within 1,000 blocks');
      return state.logs.filter(
        (l) =>
          l.address.toLowerCase() === address.toLowerCase() &&
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock,
      );
    },
  };
}

test('migration 113 is the protocol fee ledger and is not registered yet', () => {
  assert.equal(protocolFeeLedgerMigration.version, 113);
  assert.equal(protocolFeeLedgerMigration.name, 'protocol_fee_ledger');
});

test('a fee counts only with the matching USDC transfer to the treasury in the same tx', () => {
  const rows = feeRowsFromLogs(config, [
    feeCharged('a', 200n, 1, { ref: 'a', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('a', 200n, 0, TREASURY, 9_000n),
    feeCharged('b', 200n, 3, { ref: 'b', kind: 1, gross: 100_000n, fee: 10_000n }), // no transfer
    feeCharged('c', 200n, 5, { ref: 'c', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('c', 200n, 4, TREASURY, 8_999n), // wrong amount
    feeCharged('d', 200n, 7, { ref: 'd', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('d', 200n, 6, addr(0xbad), 9_000n), // not the treasury
    feeCharged('e', 200n, 9, { ref: 'e', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('e', 200n, 8, TREASURY, 9_000n, addr(0xfa4e)), // not USDC
    feeCharged('f', 200n, 11, {
      ref: 'f',
      kind: 0,
      gross: 90_000n,
      fee: 9_000n,
      emitter: addr(0xf00),
    }), // forged emitter
    transfer('f', 200n, 10, TREASURY, 9_000n),
  ]);
  assert.deepEqual(
    rows.map((r) => r.ref),
    [ref('a')],
  );
  assert.equal(rows[0].source, 'router');
  assert.equal(rows[0].kind, 0);
});

test('two fees in one tx need two transfers; one transfer cannot back both', () => {
  const rows = feeRowsFromLogs(config, [
    feeCharged('m', 300n, 1, { ref: 'm1', kind: 0, gross: 50_000n, fee: 5_000n }),
    feeCharged('m', 300n, 3, { ref: 'm2', kind: 0, gross: 50_000n, fee: 5_000n }),
    transfer('m', 300n, 0, TREASURY, 5_000n),
  ]);
  assert.equal(rows.length, 1);
});

test('escrow charges count only for our operator, USDC and the treasury as fee receiver', () => {
  const rows = feeRowsFromLogs(config, [
    paymentCharged('p', 400n, 2, { amount: 100_000n, fee: 10_000n }),
    transfer('p', 400n, 1, TREASURY, 10_000n),
    paymentCharged('q', 400n, 5, { amount: 100_000n, fee: 10_000n, operator: addr(0x0ff) }),
    transfer('q', 400n, 4, TREASURY, 10_000n),
    paymentCharged('r', 400n, 8, { amount: 100_000n, fee: 10_000n, feeReceiver: addr(0x0ff) }),
    transfer('r', 400n, 7, TREASURY, 10_000n),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'escrow');
  assert.equal(rows[0].gross, 100_000n);
  assert.equal(rows[0].fee, 10_000n);
  assert.equal(rows[0].payee, SELLER);
});

test('scan is idempotent, resumable, chunked, and marks finality', async (t) => {
  const db = await setup(t);
  const state = { latest: 2_600n, finalized: 150n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('s1', 120n, 1, { ref: 's1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('s1', 120n, 0, TREASURY, 9_000n),
    feeCharged('s2', 2_500n, 1, { ref: 's2', kind: 1, gross: 100_000n, fee: 10_000n }),
    transfer('s2', 2_500n, 0, TREASURY, 10_000n),
  );
  const chain = fakeChain(state);
  const first = await scanFees(db, chain, config, { maxBlocks: 1_500n });
  assert.deepEqual([first?.from, first?.to, first?.written], [100n, 1_599n, 1]);
  const second = await scanFees(db, chain, config, { maxBlocks: 1_500n });
  // Finality was verified through block 150, so the next scan re-reads from 151 (earlier than
  // the 64-block reorg window).
  assert.equal(second?.from, 151n);
  assert.ok(second!.from <= 1_600n - REORG_DEPTH);
  while ((await scanFees(db, chain, config, { maxBlocks: 1_500n }))!.to < state.latest);
  await scanFees(db, chain, config, { maxBlocks: 1_500n }); // rescans the tail; no duplicates
  const all = await db.query<{ ref: string; finalized: boolean }>(
    'SELECT ref, finalized FROM protocol_fee_events ORDER BY block_number',
  );
  assert.deepEqual(
    all.rows.map((r) => [r.ref, r.finalized]),
    [
      [ref('s1'), true],
      [ref('s2'), false],
    ],
  );
  assert.equal(await recorded(db, ref('s2')), true);
  assert.equal(await recorded(db, ref('nope')), false);
});

test('a reorg inside the rescan window removes the vanished fee and keeps the replacement', async (t) => {
  const db = await setup(t);
  const state = { latest: 500n, finalized: 100n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('old', 480n, 1, { ref: 'old', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('old', 480n, 0, TREASURY, 9_000n),
  );
  const chain = fakeChain(state);
  await scanFees(db, chain, config);
  assert.equal(await recorded(db, ref('old')), true);
  // Block 480 is reorged: the old tx is gone and a different fee lands at 481.
  state.logs = [
    feeCharged('new', 481n, 1, { ref: 'new', kind: 0, gross: 50_000n, fee: 5_000n, fork: 'b' }),
    transfer('new', 481n, 0, TREASURY, 5_000n, USDC, 'b'),
  ];
  state.latest = 520n;
  const res = await scanFees(db, chain, config);
  assert.equal(res?.removed, 0); // one row replaced by one row
  assert.equal(await recorded(db, ref('old')), false);
  assert.equal(await recorded(db, ref('new')), true);
});

test('daily metrics: volume = sum of prices, fees = sum of 10% fees, per UTC day', async (t) => {
  const db = await setup(t);
  const state = { latest: 50_000n, finalized: 50_000n, logs: [] as ChainLog[] };
  // Day boundary at block 43,200 (2 s blocks from midnight).
  state.logs.push(
    feeCharged('d1', 1_000n, 1, { ref: 'd1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('d1', 1_000n, 0, TREASURY, 9_000n),
    feeCharged('d2', 43_199n, 1, { ref: 'd2', kind: 1, gross: 100_000n, fee: 10_000n }),
    transfer('d2', 43_199n, 0, TREASURY, 10_000n),
    feeCharged('d3', 43_200n, 1, { ref: 'd3', kind: 1, gross: 60_000n, fee: 6_000n }),
    transfer('d3', 43_200n, 0, TREASURY, 6_000n),
  );
  const cfg = { ...config, startBlock: 0n };
  while ((await scanFees(db, fakeChain(state), cfg, { maxBlocks: 20_000n }))!.to < state.latest);
  const days = await dailyFees(db, 84532, 1_791_936_000, 1_791_936_000 + 2 * 86_400);
  assert.deepEqual(days, [
    // d1 is a fee-on-top call whose seller settlement is not matched yet: its fee counts, its
    // price does not count as volume.
    { day: '2026-10-14', payments: 1, feeCount: 2, volume: 100_000n, fees: 19_000n },
    { day: '2026-10-15', payments: 1, feeCount: 1, volume: 60_000n, fees: 6_000n },
  ]);
});

test('a scan that finds the checkpoint moved meanwhile writes nothing (busy)', async (t) => {
  const db = await setup(t);
  const state = { latest: 300n, finalized: 0n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('b1', 250n, 1, { ref: 'b1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('b1', 250n, 0, TREASURY, 9_000n),
  );
  const chain = fakeChain(state);
  const slow: FeeChain = {
    ...chain,
    finalizedBlock: async () => {
      // Another scan finishes while this one is reading the chain.
      await db.query(
        `INSERT INTO protocol_fee_scan_state (chain_id, next_block, updated_at) VALUES (84532, 999, 0)
         ON CONFLICT (chain_id) DO UPDATE SET next_block = 999`,
      );
      return 0n;
    },
  };
  const res = await scanFees(db, slow, config);
  assert.equal(res?.busy, true);
  assert.equal(res?.written, 0);
  assert.equal(await recorded(db, ref('b1')), false);
});

test('a fee reorged away more than 64 blocks before finality is never promoted to final', async (t) => {
  const db = await setup(t);
  const state = { latest: 1_000n, finalized: 500n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('deep', 900n, 1, { ref: 'deep', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('deep', 900n, 0, TREASURY, 9_000n),
  );
  const chain = fakeChain(state);
  await scanFees(db, chain, config);
  assert.equal(await recorded(db, ref('deep')), true);
  assert.equal(await recorded(db, ref('deep'), true), false);
  // The chain moves far ahead: block 900 is now > 64 blocks behind the checkpoint, and its branch
  // was replaced (the fee is gone) before it became final.
  state.logs = [];
  state.latest = 1_400n;
  state.finalized = 1_100n;
  await scanFees(db, chain, config);
  assert.equal(
    await recorded(db, ref('deep')),
    false,
    'the vanished fee is removed, not finalized',
  );
  const st = await db.query<{ finalized_through: string }>(
    'SELECT finalized_through FROM protocol_fee_scan_state WHERE chain_id = 84532',
  );
  assert.equal(String(st.rows[0].finalized_through), '1100');
});

test('finality is promoted only up to the blocks this run re-read', async (t) => {
  const db = await setup(t);
  const state = { latest: 3_000n, finalized: 2_900n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('f1', 150n, 1, { ref: 'f1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('f1', 150n, 0, TREASURY, 9_000n),
    feeCharged('f2', 2_500n, 1, { ref: 'f2', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('f2', 2_500n, 0, TREASURY, 9_000n),
  );
  const chain = fakeChain(state);
  await scanFees(db, chain, config, { maxBlocks: 1_000n }); // 100..1099
  assert.equal(await recorded(db, ref('f1'), true), true);
  while ((await scanFees(db, chain, config, { maxBlocks: 1_000n }))!.to < state.latest);
  assert.equal(await recorded(db, ref('f2'), true), true);
});

test('feeOnChain matches every field of the owed fee', async (t) => {
  const db = await setup(t);
  const state = { latest: 300n, finalized: 300n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('m1', 200n, 1, { ref: 'm1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('m1', 200n, 0, TREASURY, 9_000n),
  );
  await scanFees(db, fakeChain(state), config);
  const expected = {
    chainId: 84532,
    emitter: ROUTER,
    payer: PAYER,
    payee: SELLER,
    ref: ref('m1'),
    kind: 0 as const,
    gross: 90_000n,
    fee: 9_000n,
  };
  assert.equal(await feeOnChain(db, expected, { finalizedOnly: true }), true);
  for (const change of [
    { chainId: 8453 },
    { emitter: addr(0x41) },
    { payer: addr(0xa2) },
    { payee: addr(0x5f) },
    { ref: ref('other') },
    { kind: 1 as const },
    { gross: 89_999n },
    { fee: 8_999n },
  ])
    assert.equal(await feeOnChain(db, { ...expected, ...change }), false, Object.keys(change)[0]);
});

test('logs read from a branch that is replaced before the hash check are never written or finalized', async (t) => {
  const db = await setup(t);
  const state = { latest: 400n, finalized: 400n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('orphan', 300n, 1, { ref: 'orphan', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('orphan', 300n, 0, TREASURY, 9_000n),
  );
  const base = fakeChain(state);
  // getLogs returns the old branch; by the time the block is checked, block 300 was replaced and
  // the replacement is final.
  const racing: FeeChain = {
    ...base,
    block: async (n) => ({ timestamp: 1_791_936_000n + n * 2n, hash: blockHash(n, 'replaced') }),
  };
  const res = await scanFees(db, racing, config);
  assert.equal(res?.busy, true);
  assert.equal(await recorded(db, ref('orphan')), false);
  const st = await db.query('SELECT 1 FROM protocol_fee_scan_state');
  assert.equal(st.rows.length, 0, 'no checkpoint or finality moved');
});

test('a transfer from another block (hash) cannot back the fee', () => {
  const ev = feeCharged('x', 500n, 1, { ref: 'x', kind: 0, gross: 90_000n, fee: 9_000n });
  const tr = transfer('x', 500n, 0, TREASURY, 9_000n, USDC, 'other');
  assert.equal(feeRowsFromLogs(config, [ev, tr]).length, 0);
});

test('volume counts a fee-on-top call only after its service is marked verified', async (t) => {
  const db = await setup(t);
  const state = { latest: 300n, finalized: 300n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('v1', 200n, 1, { ref: 'v1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('v1', 200n, 0, TREASURY, 9_000n),
  );
  await scanFees(db, fakeChain(state), config);
  const window = [1_791_936_000, 1_791_936_000 + 86_400] as const;
  assert.equal((await dailyFees(db, 84532, ...window))[0].volume, 0n);
  const expected = {
    chainId: 84532,
    emitter: ROUTER,
    payer: PAYER,
    payee: SELLER,
    ref: ref('v1'),
    kind: 0 as const,
    gross: 90_000n,
    fee: 9_000n,
  };
  assert.equal(await markServiceVerified(db, { ...expected, gross: 1n }), false);
  assert.equal(await markServiceVerified(db, expected), true);
  const [day] = await dailyFees(db, 84532, ...window);
  assert.deepEqual([day.volume, day.fees], [90_000n, 9_000n]);
});

test('a fee-included payment (router pay, kind 1) is service-verified by itself and counts as volume at once', async (t) => {
  const db = await setup(t);
  const state = { latest: 300n, finalized: 300n, logs: [] as ChainLog[] };
  // router.pay: the seller's 90% and the treasury's 10% in one transaction, one FeeCharged kind 1.
  state.logs.push(
    transfer('i1', 210n, 0, SELLER, 45_000n),
    transfer('i1', 210n, 1, TREASURY, 5_000n),
    feeCharged('i1', 210n, 2, { ref: 'i1', kind: 1, gross: 50_000n, fee: 5_000n }),
  );
  await scanFees(db, fakeChain(state), config);
  const { rows } = await db.query<{ kind: number; service_verified: boolean; gross: string }>(
    'SELECT kind, service_verified, gross::text AS gross FROM protocol_fee_events WHERE ref = $1',
    [ref('i1')],
  );
  assert.deepEqual(rows, [{ kind: 1, service_verified: true, gross: '50000' }]);
  const window = [1_791_936_000, 1_791_936_000 + 86_400] as const;
  const [day] = await dailyFees(db, 84532, ...window);
  assert.deepEqual([day.volume, day.fees], [50_000n, 5_000n]);
  // The engine's confirmation finds exactly that row (kind 1, the price as gross), never kind 0.
  const expected = {
    chainId: 84532,
    emitter: ROUTER,
    payer: PAYER,
    payee: SELLER,
    ref: ref('i1'),
    kind: 1 as const,
    gross: 50_000n,
    fee: 5_000n,
  };
  assert.equal(await markServiceVerified(db, expected), true);
  assert.equal(await markServiceVerified(db, { ...expected, kind: 0 }), false);
  assert.equal(await markServiceVerified(db, { ...expected, gross: 45_000n }), false);
});

test('restore: empty ledger tables rebuild fees and finality from the chain; history is labelled incomplete until caught up; service verification must be re-applied', async (t) => {
  const db = await setup(t);
  const state = { latest: 3_000n, finalized: 2_000n, logs: [] as ChainLog[] };
  state.logs.push(
    // Finalized, fee on top (kind 0): its service is verified from the call record.
    feeCharged('r1', 500n, 1, { ref: 'r1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('r1', 500n, 0, TREASURY, 9_000n),
    // Finalized, fee included (kind 1): verified by construction.
    feeCharged('r2', 1_500n, 1, { ref: 'r2', kind: 1, gross: 100_000n, fee: 10_000n }),
    transfer('r2', 1_500n, 0, TREASURY, 10_000n),
    // Not finalized yet.
    feeCharged('r3', 2_500n, 1, { ref: 'r3', kind: 0, gross: 50_000n, fee: 5_000n }),
    transfer('r3', 2_500n, 0, TREASURY, 5_000n),
  );
  const chain = fakeChain(state);
  const cfg = { ...config, startBlock: 0n };
  const drain = async () => {
    while ((await scanFees(db, chain, cfg, { maxBlocks: 1_000n }))!.to < state.latest);
  };
  await drain();
  const r1 = {
    chainId: 84532,
    emitter: ROUTER,
    payer: PAYER,
    payee: SELLER,
    ref: ref('r1'),
    kind: 0 as const,
    gross: 90_000n,
    fee: 9_000n,
  };
  assert.equal(await markServiceVerified(db, r1), true);
  const window = [1_791_936_000, 1_791_936_000 + 86_400] as const;
  const before = await dailyFees(db, 84532, ...window, { finalizedOnly: true });
  assert.deepEqual(
    before.map((d) => [d.payments, d.volume, d.fees]),
    [[2, 190_000n, 19_000n]],
  );
  assert.equal(await historyComplete(db, 84532), true);

  // A restore never exports these tables: both come back empty.
  await db.exec('DELETE FROM protocol_fee_events; DELETE FROM protocol_fee_scan_state;');
  assert.equal(await historyComplete(db, 84532), false, 'partial history is labelled');
  await scanFees(db, chain, cfg, { maxBlocks: 1_000n });
  assert.equal(await historyComplete(db, 84532), false, 'still catching up');
  await drain();
  assert.equal(await historyComplete(db, 84532), true);

  // Fees, payments and finality come back exactly from the chain.
  const after = await dailyFees(db, 84532, ...window, { finalizedOnly: true });
  assert.deepEqual(
    after.map((d) => [d.feeCount, d.fees, d.payments]),
    // Every fee is back; only the atomic fee-included call counts as a proven payment until the
    // fee-on-top call's verification is re-applied.
    [[2, 19_000n, 1]],
  );
  // The fee-on-top call's service verification lives in its call record, not on-chain: until
  // the engine re-applies it, that call's price is not counted as volume.
  assert.equal(after[0].volume, 100_000n);
  assert.equal(await markServiceVerified(db, r1), true);
  const reapplied = await dailyFees(db, 84532, ...window, { finalizedOnly: true });
  assert.equal(reapplied[0].volume, 190_000n);
  // The unfinalized fee is rebuilt too, and not final.
  assert.equal(await recorded(db, ref('r3')), true);
  assert.equal(await recorded(db, ref('r3'), true), false);
});

test('a rescan keeps the service-verified mark of a row that is still there', async (t) => {
  const db = await setup(t);
  const state = { latest: 300n, finalized: 0n, logs: [] as ChainLog[] };
  state.logs.push(
    feeCharged('k1', 250n, 1, { ref: 'k1', kind: 0, gross: 90_000n, fee: 9_000n }),
    transfer('k1', 250n, 0, TREASURY, 9_000n),
  );
  const chain = fakeChain(state);
  await scanFees(db, chain, config);
  const expected = {
    chainId: 84532,
    emitter: ROUTER,
    payer: PAYER,
    payee: SELLER,
    ref: ref('k1'),
    kind: 0 as const,
    gross: 90_000n,
    fee: 9_000n,
  };
  assert.equal(await markServiceVerified(db, expected), true);
  // The next scans re-read block 250 (inside the reorg window, not final yet): the mark stays.
  state.latest = 320n;
  await scanFees(db, chain, config);
  state.latest = 340n;
  await scanFees(db, chain, config);
  const rows = await db.query<{ service_verified: boolean }>(
    'SELECT service_verified FROM protocol_fee_events WHERE ref = $1',
    [ref('k1')],
  );
  assert.deepEqual(
    rows.rows.map((r) => r.service_verified),
    [true],
  );
});

test('USDC is read only for Transfer events to the treasury (topic-filtered), the fee contracts whole', async (t) => {
  const db = await setup(t);
  const seen: { address: string; topics?: (string | null)[] }[] = [];
  const chain: FeeChain = {
    latestBlock: async () => 200n,
    finalizedBlock: async () => 0n,
    block: async (n) => ({ timestamp: 1n, hash: blockHash(n) }),
    getLogs: async (input) => {
      seen.push({ address: input.address.toLowerCase(), topics: input.topics });
      return [];
    },
  };
  await scanFees(db, chain, config);
  const usdc = seen.filter((s) => s.address === USDC.toLowerCase());
  assert.ok(usdc.length > 0);
  for (const call of usdc) {
    assert.equal(call.topics?.length, 3);
    assert.equal(call.topics?.[1], null, 'any sender');
    assert.equal(
      call.topics?.[2],
      pad(TREASURY, { size: 32 }).toLowerCase(),
      'to the treasury only',
    );
  }
  assert.ok(seen.some((s) => s.address === ROUTER.toLowerCase() && !s.topics));
});

async function scanState(db: Database) {
  const st = await db.query<{ next_block: string; finalized_through: string; caught_up: boolean }>(
    'SELECT next_block::text, finalized_through::text, caught_up FROM protocol_fee_scan_state',
  );
  return st.rows[0];
}

/** One fee per block from `first`, every `step` blocks, `count` fees. */
function feeEveryBlocks(first: bigint, step: bigint, count: number): ChainLog[] {
  const logs: ChainLog[] = [];
  for (let i = 0; i < count; i++) {
    const n = first + BigInt(i) * step;
    logs.push(
      feeCharged(`w${i}`, n, 1, { ref: `w${i}`, kind: 1, gross: 100_000n, fee: 10_000n }),
      transfer(`w${i}`, n, 0, TREASURY, 10_000n),
    );
  }
  return logs;
}

test('finality stall: blocks not final yet and already stored with the same hash are not read again', async (t) => {
  const db = await setup(t);
  // Finality is stuck at 100 while the chain moves on: the whole window stays not-yet-final.
  const state = { latest: 2_000n, finalized: 100n, logs: feeEveryBlocks(200n, 5n, 300) };
  const base = fakeChain(state);
  let reads = 0;
  const chain: FeeChain = { ...base, block: async (n) => (reads++, base.block(n)) };
  await scanFees(db, chain, config);
  assert.equal(reads, 300, 'first run reads each new block once');
  reads = 0;
  state.latest = 2_050n;
  const again = await scanFees(db, chain, config);
  assert.equal(again?.from, 101n, 'the whole not-yet-final window is re-read');
  assert.equal(again?.written, 300);
  assert.equal(reads, 0, 'stored times are reused, no block read per stored block');
  const times = await db.query<{ n: string }>(
    'SELECT count(DISTINCT block_time)::text AS n FROM protocol_fee_events WHERE block_time > 0',
  );
  assert.equal(times.rows[0].n, '300');
});

test('a run out of time commits the confirmed final prefix and advances finality; later runs drain the rest', async (t) => {
  const db = await setup(t);
  const state = { latest: 2_000n, finalized: 100n, logs: feeEveryBlocks(200n, 5n, 300) };
  await scanFees(db, fakeChain(state), config);
  assert.equal((await scanState(db)).finalized_through, '100');
  assert.equal((await scanState(db)).caught_up, true);
  // Finality recovers: every stored block must now be confirmed against the canonical chain
  // before it is promoted, and each read costs time.
  state.finalized = 1_990n;
  let clock = 0;
  const base = fakeChain(state);
  let reads = 0;
  const slow: FeeChain = {
    ...base,
    block: async (n) => {
      reads++;
      clock += 100;
      return base.block(n);
    },
  };
  const run = await scanFees(db, slow, config, { now: () => clock, budgetMs: 5_000 });
  assert.equal(run?.partial, 'deadline');
  assert.equal(reads, 50, 'stops at the budget');
  // The confirmed prefix: blocks 200..445 hold the first 50 fees; the run stops before block 450.
  assert.equal(run?.to, 449n);
  assert.equal(run?.written, 50);
  const after = await scanState(db);
  assert.equal(after.finalized_through, '449', 'finality advanced over the confirmed prefix');
  assert.equal(after.next_block, '2001', 'the checkpoint is not moved back');
  assert.equal(after.caught_up, true, 'a prefix run below the checkpoint keeps history complete');
  const final = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM protocol_fee_events WHERE finalized',
  );
  assert.equal(final.rows[0].n, '50');
  const total = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM protocol_fee_events',
  );
  assert.equal(total.rows[0].n, '300', 'rows past the prefix stay as they were');
  // Later runs continue from the new finality mark and drain the window.
  let runs = 0;
  while ((await scanFees(db, slow, config, { now: () => clock, budgetMs: 5_000 }))?.partial)
    assert.ok(++runs < 10);
  const done = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM protocol_fee_events WHERE finalized',
  );
  assert.equal(done.rows[0].n, '300');
  assert.equal((await scanState(db)).finalized_through, '1990');
  assert.equal((await scanState(db)).caught_up, true);
});

test('a block that cannot be confirmed after confirmed ones commits the prefix; with none it writes nothing', async (t) => {
  const db = await setup(t);
  const state = { latest: 400n, finalized: 400n, logs: feeEveryBlocks(200n, 10n, 5) };
  const base = fakeChain(state);
  const replaced: FeeChain = {
    ...base,
    block: async (n) => (n === 220n ? { timestamp: 1n, hash: blockHash(n, 'x') } : base.block(n)),
  };
  const run = await scanFees(db, replaced, config);
  assert.equal(run?.partial, 'reorg');
  assert.deepEqual([run?.from, run?.to, run?.written], [100n, 219n, 2]);
  assert.equal((await scanState(db)).finalized_through, '219');
  assert.equal((await scanState(db)).caught_up, false, 'new blocks were not all read');

  const db2 = await setup(t);
  const failing: FeeChain = {
    ...base,
    block: async (n) => {
      if (n === 230n) throw new Error('429');
      return base.block(n);
    },
  };
  const partial = await scanFees(db2, failing, config);
  assert.deepEqual([partial?.partial, partial?.to, partial?.written], ['error', 229n, 3]);
  const db3 = await setup(t);
  const down: FeeChain = {
    ...base,
    block: async () => {
      throw new Error('429');
    },
  };
  await assert.rejects(scanFees(db3, down, config));
  assert.equal((await db3.query('SELECT 1 FROM protocol_fee_scan_state')).rows.length, 0);
});

test('a fee-on-top row replaced by a rescan (another block, a missed run, a restore) gets its service mark back from the call record', async (t) => {
  const db = await setup(t);
  // The two Feed pay columns the scan reads, in their own shape (server/feed/pay/schema.ts).
  await db.exec(`
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, spender_address text NOT NULL);
    CREATE TABLE feed_pay_calls (call_id text PRIMARY KEY, chain_id integer, wallet_id text,
      pay_to text, fee_router text, amount_raw numeric, fee_raw numeric, payment_state text,
      fee_state text, fee_verified boolean);`);
  await db.query(`INSERT INTO base_wallets VALUES ('w-1', $1)`, [PAYER]);
  const callRow = (id: string, verified: boolean, amount = 90_000) =>
    db.query(
      `INSERT INTO feed_pay_calls VALUES ($1, 84532, 'w-1', $2, $3, $4, 9000, 'settled', 'charged', $5)`,
      [id, SELLER, ROUTER.toLowerCase(), amount, verified],
    );
  await callRow('v1', true);
  await callRow('v2', false); // not verified by the engine yet: never marked by the scan
  await callRow('v3', true, 80_000); // another price than the row's: never marked
  const verified = async () =>
    (
      await db.query<{ ref: string }>(
        'SELECT ref FROM protocol_fee_events WHERE service_verified ORDER BY ref',
      )
    ).rows.map((r) => r.ref);
  const state = { latest: 300n, finalized: 0n, logs: [] as ChainLog[] };
  for (const [i, id] of ['v1', 'v2', 'v3'].entries())
    state.logs.push(
      feeCharged(id, 250n + BigInt(i), 1, { ref: id, kind: 0, gross: 90_000n, fee: 9_000n }),
      transfer(id, 250n + BigInt(i), 0, TREASURY, 9_000n),
    );
  const chain = fakeChain(state);
  await scanFees(db, chain, config);
  assert.deepEqual(await verified(), [ref('v1')]);
  // The same fee re-included in another block (a new block hash): the mark comes back.
  state.logs = [
    feeCharged('v1', 260n, 1, { ref: 'v1', kind: 0, gross: 90_000n, fee: 9_000n, fork: 'b' }),
    transfer('v1', 260n, 0, TREASURY, 9_000n, USDC, 'b'),
  ];
  state.latest = 320n;
  await scanFees(db, chain, config);
  assert.deepEqual(await verified(), [ref('v1')]);
  // One run misses the log, the next one finds it again.
  const saved = state.logs;
  state.logs = [];
  state.latest = 330n;
  await scanFees(db, chain, config);
  assert.deepEqual(await verified(), []);
  state.logs = saved;
  state.latest = 340n;
  await scanFees(db, chain, config);
  assert.deepEqual(await verified(), [ref('v1')]);
  // A restore: empty ledger tables, rebuilt from the chain, the mark included.
  await db.exec('DELETE FROM protocol_fee_events; DELETE FROM protocol_fee_scan_state;');
  await scanFees(db, chain, config);
  assert.deepEqual(await verified(), [ref('v1')]);
});

test('a node that refuses a dense range: the range is split and every fee is still recorded (22 Oct)', async (t) => {
  const db = await setup(t);
  // 400 fees in 400 blocks; the node refuses any answer with more than 50 logs.
  const state = { latest: 600n, finalized: 600n, logs: feeEveryBlocks(150n, 1n, 400) };
  const base = fakeChain(state);
  let refused = 0;
  const chain: FeeChain = {
    ...base,
    getLogs: async (input) => {
      const logs = await base.getLogs(input);
      if (logs.length > 50) {
        refused++;
        throw new Error('query returned more than 10000 results');
      }
      return logs;
    },
  };
  await scanFees(db, chain, config);
  assert.ok(refused > 0, 'the node refused the dense ranges');
  const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM protocol_fee_events');
  assert.equal(rows.rows[0]!.n, '400', 'every fee recorded after splitting');
});

test('a node that is down still fails the scan (splitting stops at the smallest range)', async (t) => {
  const db = await setup(t);
  const state = { latest: 600n, finalized: 600n, logs: feeEveryBlocks(150n, 1n, 10) };
  const base = fakeChain(state);
  let calls = 0;
  const chain: FeeChain = {
    ...base,
    getLogs: async () => {
      calls++;
      throw new Error('fetch failed');
    },
  };
  await assert.rejects(scanFees(db, chain, config));
  assert.ok(calls < 400, `bounded retries (${calls})`);
});

test('after a split the next chunks start at the size that worked (no refused full-size read each time)', async (t) => {
  resetLearnedLogRange();
  const db = await setup(t);
  // 2,000 dense blocks: the node refuses any answer over 50 logs.
  const state = { latest: 2_200n, finalized: 2_200n, logs: feeEveryBlocks(150n, 1n, 2_000) };
  const base = fakeChain(state);
  let refused = 0;
  let calls = 0;
  const chain: FeeChain = {
    ...base,
    getLogs: async (input) => {
      calls++;
      const logs = await base.getLogs(input);
      if (logs.length > 50) {
        refused++;
        throw new Error('query returned more than 10000 results');
      }
      return logs;
    },
  };
  await scanFees(db, chain, config, { maxBlocks: 2_100n });
  const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM protocol_fee_events');
  assert.equal(rows.rows[0]!.n, '2000', 'every fee recorded');
  // Without learning the same scan has 122 refused reads (every dense chunk refused at 1,000, 500,
  // 250 and 125 blocks for each source); with it 66, almost all while the size is first found.
  assert.ok(refused <= 70, `few refused reads (${refused} of ${calls})`);
});
