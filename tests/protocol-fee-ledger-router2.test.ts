import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeAbiParameters, encodeEventTopics, keccak256, pad, toHex, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import {
  FEE_EVENTS_ABI,
  PROTOCOL_FEE_LEDGER_SQL,
  feeRowsFromLogs,
  scanFees,
  type ChainLog,
  type FeeChain,
  type FeeLedgerConfig,
} from '../server/protocol/fees/ledger.js';
import { PROTOCOL_FEE_ROUTER_STARTS_SQL } from '../server/protocol/fees/router-starts-schema.js';
import { protocolFeeConfigFromEnv, protocolRouter2FromEnv } from '../server/protocol/fees/cron.js';

// Operation Fee Contract: the ledger counts FeeCharged from router 1 and router 2 (the same event,
// another address), dedupes on chain + tx + log index, and reads router 2 from its deploy block
// even when it is configured after the scan passed that block.

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const USDC = addr(0xc0);
const TREASURY = addr(0x7e);
const ROUTER = addr(0x40);
const ROUTER2 = addr(0x42);
const PAYER = addr(0xa1);
const SELLER = addr(0x5e);
const base: FeeLedgerConfig = {
  chainId: 84532,
  usdc: USDC,
  treasury: TREASURY,
  router: ROUTER,
  escrow: null,
  startBlock: 100n,
};
const withRouter2 = (fromBlock: bigint): FeeLedgerConfig => ({
  ...base,
  addedRouters: [{ address: ROUTER2, fromBlock }],
});
const ref = (s: string) => keccak256(toHex(s));
const hash = (s: string) => keccak256(toHex(`tx:${s}`));
const blockHash = (n: bigint) => keccak256(toHex(`block:${n}`));

function feeCharged(tx: string, block: bigint, emitter: Hex, gross: bigint): ChainLog {
  return {
    address: emitter,
    topics: encodeEventTopics({
      abi: FEE_EVENTS_ABI,
      eventName: 'FeeCharged',
      args: { payer: PAYER, payee: SELLER, ref: ref(tx) },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
      [1, gross, gross / 10n],
    ),
    transactionHash: hash(tx),
    logIndex: 1,
    blockNumber: block,
    blockHash: blockHash(block),
  };
}

function transfer(tx: string, block: bigint, value: bigint): ChainLog {
  return {
    address: USDC,
    topics: encodeEventTopics({
      abi: FEE_EVENTS_ABI,
      eventName: 'Transfer',
      args: { from: PAYER, to: TREASURY },
    }) as Hex[],
    data: pad(toHex(value), { size: 32 }),
    transactionHash: hash(tx),
    logIndex: 0,
    blockNumber: block,
    blockHash: blockHash(block),
  };
}

/** A fee-included payment of `gross` through `emitter`: its event and the fee's treasury transfer. */
const payment = (tx: string, block: bigint, emitter: Hex, gross: bigint) => [
  feeCharged(tx, block, emitter, gross),
  transfer(tx, block, gross / 10n),
];

async function setup(t: test.TestContext) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  await pg.exec(PROTOCOL_FEE_ROUTER_STARTS_SQL);
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
    block: async (n) => ({ timestamp: 1_791_936_000n + n * 2n, hash: blockHash(n) }),
    getLogs: async ({ address, fromBlock, toBlock }) =>
      state.logs.filter(
        (l) =>
          l.address.toLowerCase() === address.toLowerCase() &&
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock,
      ),
  };
}

const rowsOf = async (db: Database) =>
  (
    await db.query<{ emitter: string; gross: string; fee: string; finalized: boolean }>(
      'SELECT emitter, gross::text AS gross, fee::text AS fee, finalized FROM protocol_fee_events ORDER BY block_number',
    )
  ).rows;

test('router 2 FeeCharged counts only when router 2 is configured; a forged emitter never', () => {
  const logs = [
    ...payment('r1', 200n, ROUTER, 100_000n),
    ...payment('r2', 201n, ROUTER2, 10_000_000n),
    ...payment('x', 202n, addr(0xf00), 10_000_000n),
  ];
  assert.deepEqual(
    feeRowsFromLogs(base, logs).map((r) => r.emitter),
    [ROUTER.toLowerCase()],
  );
  const both = feeRowsFromLogs(withRouter2(150n), logs);
  assert.deepEqual(
    both.map((r) => [r.emitter, r.gross, r.fee]),
    [
      [ROUTER.toLowerCase(), 100_000n, 10_000n],
      [ROUTER2.toLowerCase(), 10_000_000n, 1_000_000n],
    ],
  );
});

test('router 2 configured after the scan passed its deploy block: its early fees are read once', async (t) => {
  const db = await setup(t);
  const state = {
    latest: 5_000n,
    finalized: 5_000n,
    logs: [
      ...payment('a', 1_000n, ROUTER, 100_000n),
      // Router 2 deployed at 2_000; a fee at 2_100, before router 2 was configured.
      ...payment('b', 2_100n, ROUTER2, 100_000_000n),
      ...payment('c', 4_000n, ROUTER, 50_000n),
    ],
  };
  const chain = fakeChain(state);
  // Router 1 only: the scan reaches the head and finalizes everything; router 2's fee is unseen.
  while ((await scanFees(db, chain, base))!.to < state.latest);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.emitter),
    [ROUTER.toLowerCase(), ROUTER.toLowerCase()],
  );

  // Router 2 configured now: the next scan rewinds once to its deploy block and picks the fee up.
  const config = withRouter2(2_000n);
  state.logs.push(...payment('d', 5_050n, ROUTER2, 1_000_000n));
  state.latest = 5_100n;
  state.finalized = 5_100n;
  for (let i = 0; i < 5; i++) await scanFees(db, chain, config);
  const rows = await rowsOf(db);
  assert.deepEqual(
    rows.map((r) => [r.emitter, r.gross, r.fee, r.finalized]),
    [
      [ROUTER.toLowerCase(), '100000', '10000', true],
      [ROUTER2.toLowerCase(), '100000000', '10000000', true],
      [ROUTER.toLowerCase(), '50000', '5000', true],
      [ROUTER2.toLowerCase(), '1000000', '100000', true],
    ],
  );
  const starts = await db.query<{ router: string; from_block: string }>(
    'SELECT router, from_block::text AS from_block FROM protocol_fee_router_starts',
  );
  assert.deepEqual(starts.rows, [{ router: ROUTER2.toLowerCase(), from_block: '2000' }]);

  // The rewind happens once: later scans read only the tail, and nothing is counted twice.
  const later = await scanFees(db, chain, config);
  assert.ok(later!.from > 2_000n);
  assert.equal((await rowsOf(db)).length, 4);
});

test('router 2 config from env: both values valid, else none (router 1 alone, as before)', () => {
  const env = {
    CITY_PROTOCOL_CHAIN_ID: '84532',
    CITY_PROTOCOL_TREASURY: TREASURY,
    CITY_PROTOCOL_ROUTER: ROUTER,
    CITY_PROTOCOL_START_BLOCK: '100',
  };
  assert.equal(protocolFeeConfigFromEnv(env)?.addedRouters, undefined);
  const set = {
    ...env,
    CITY_PROTOCOL_FEE_ROUTER2: ROUTER2,
    CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: '2000',
  };
  assert.deepEqual(protocolFeeConfigFromEnv(set)?.addedRouters, [
    { address: ROUTER2, fromBlock: 2_000n },
  ]);
  assert.deepEqual(protocolRouter2FromEnv({ CITY_PROTOCOL_FEE_ROUTER2: ROUTER2 }), []);
  assert.deepEqual(
    protocolRouter2FromEnv({
      CITY_PROTOCOL_FEE_ROUTER2: 'not-an-address',
      CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: '1',
    }),
    [],
  );
  // Base mainnet (the deployment fixed in code) reads router 2 from env too.
  assert.deepEqual(
    protocolFeeConfigFromEnv({
      CITY_PROTOCOL_FEE_ROUTER2: ROUTER2,
      CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: '52800000',
    })?.addedRouters,
    [{ address: ROUTER2, fromBlock: 52_800_000n }],
  );
});

test('router 2 rows below its configured start block are excluded', () => {
  const rows = feeRowsFromLogs(withRouter2(200n), [
    ...payment('before-start', 199n, ROUTER2, 100_000n),
    ...payment('at-start', 200n, ROUTER2, 100_000n),
  ]);
  assert.deepEqual(
    rows.map((r) => r.blockNumber),
    [200n],
  );
});

test('removing and restoring router configuration recovers its historical rows', async (t) => {
  const db = await setup(t);
  const state = {
    latest: 300n,
    finalized: 300n,
    logs: payment('restore-router', 290n, ROUTER2, 100_000n),
  };
  const chain = fakeChain(state);
  await scanFees(db, chain, withRouter2(200n));
  assert.equal((await rowsOf(db)).length, 1);
  await scanFees(db, chain, base);
  state.latest = 5_000n;
  state.finalized = 5_000n;
  await scanFees(db, chain, base);
  await scanFees(db, chain, withRouter2(200n));
  assert.equal((await rowsOf(db)).length, 1);
});
