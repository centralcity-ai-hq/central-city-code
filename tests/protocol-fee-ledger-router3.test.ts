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
import {
  protocolFeeConfigFromEnv,
  protocolRouter2FromEnv,
  protocolRouter3FromEnv,
} from '../server/protocol/fees/cron.js';
import { FEE_ROUTER2_FLAG, FEE_ROUTER3_FLAG } from '../shared/protocol.js';

// Fee router 3 (x402 settlement, docs/protocol/FEE_ROUTER_3.md): the same FeeCharged event (kind 1)
// from a third address. The ledger counts it exactly like router 2: from CITY_PROTOCOL_FEE_ROUTER3
// and CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK, from its deploy block, re-read once when configured
// after the scan passed that block, independent of the enable flag.

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const USDC = addr(0xc0);
const TREASURY = addr(0x7e);
const ROUTER = addr(0x40);
const ROUTER2 = addr(0x42);
const ROUTER3 = addr(0x43);
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
const withRouters23 = (from2: bigint, from3: bigint): FeeLedgerConfig => ({
  ...base,
  addedRouters: [
    { address: ROUTER2, fromBlock: from2 },
    { address: ROUTER3, fromBlock: from3 },
  ],
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

test('router 3 config from env: both values valid, else none; listed after router 2', () => {
  const env = {
    CITY_PROTOCOL_CHAIN_ID: '84532',
    CITY_PROTOCOL_TREASURY: TREASURY,
    CITY_PROTOCOL_ROUTER: ROUTER,
    CITY_PROTOCOL_START_BLOCK: '100',
  };
  assert.equal(protocolFeeConfigFromEnv(env)?.addedRouters, undefined);
  // Router 3 alone.
  const three = {
    ...env,
    CITY_PROTOCOL_FEE_ROUTER3: ROUTER3,
    CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '3000',
  };
  assert.deepEqual(protocolFeeConfigFromEnv(three)?.addedRouters, [
    { address: ROUTER3, fromBlock: 3_000n },
  ]);
  // Router 2 and router 3.
  const both = {
    ...three,
    CITY_PROTOCOL_FEE_ROUTER2: ROUTER2,
    CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK: '2000',
  };
  assert.deepEqual(protocolFeeConfigFromEnv(both)?.addedRouters, [
    { address: ROUTER2, fromBlock: 2_000n },
    { address: ROUTER3, fromBlock: 3_000n },
  ]);
  // Router 2's own parser is unchanged by router 3 (the payment engine reads router 2 from it).
  assert.deepEqual(protocolRouter2FromEnv(both), [{ address: ROUTER2, fromBlock: 2_000n }]);
  // Counted independent of the enable flag, on or off.
  assert.deepEqual(protocolFeeConfigFromEnv({ ...three, [FEE_ROUTER3_FLAG]: '0' })?.addedRouters, [
    { address: ROUTER3, fromBlock: 3_000n },
  ]);
  // Incomplete or invalid: none.
  assert.deepEqual(protocolRouter3FromEnv({ CITY_PROTOCOL_FEE_ROUTER3: ROUTER3 }), []);
  assert.deepEqual(protocolRouter3FromEnv({ CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '3000' }), []);
  assert.deepEqual(
    protocolRouter3FromEnv({
      CITY_PROTOCOL_FEE_ROUTER3: 'not-an-address',
      CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '1',
    }),
    [],
  );
  assert.deepEqual(
    protocolRouter3FromEnv({
      CITY_PROTOCOL_FEE_ROUTER3: ROUTER3,
      CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '-1',
    }),
    [],
  );
  // The same address set for router 2 and router 3 is read once (router 2's start wins).
  assert.deepEqual(
    protocolFeeConfigFromEnv({ ...both, CITY_PROTOCOL_FEE_ROUTER3: ROUTER2 })?.addedRouters,
    [{ address: ROUTER2, fromBlock: 2_000n }],
  );
  // Base mainnet (the deployment fixed in code) reads router 3 from env too.
  assert.deepEqual(
    protocolFeeConfigFromEnv({
      CITY_PROTOCOL_FEE_ROUTER3: ROUTER3,
      CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK: '52900000',
    })?.addedRouters,
    [{ address: ROUTER3, fromBlock: 52_900_000n }],
  );
});

test('the router 3 flag sits next to router 2 and has its own name', () => {
  assert.equal(FEE_ROUTER2_FLAG, 'CITY_PROTOCOL_FEE_ROUTER2_ENABLED');
  assert.equal(FEE_ROUTER3_FLAG, 'CITY_PROTOCOL_FEE_ROUTER3_ENABLED');
});

test('router 3 FeeCharged counts only when router 3 is configured; a forged emitter never', () => {
  const logs = [
    ...payment('r1', 200n, ROUTER, 100_000n),
    ...payment('r2', 201n, ROUTER2, 10_000_000n),
    ...payment('r3', 202n, ROUTER3, 50_000_000n),
    ...payment('x', 203n, addr(0xf00), 10_000_000n),
  ];
  assert.deepEqual(
    feeRowsFromLogs(withRouter2(150n), logs).map((r) => r.emitter),
    [ROUTER.toLowerCase(), ROUTER2.toLowerCase()],
  );
  assert.deepEqual(
    feeRowsFromLogs(withRouters23(150n, 150n), logs).map((r) => [r.emitter, r.gross, r.fee]),
    [
      [ROUTER.toLowerCase(), 100_000n, 10_000n],
      [ROUTER2.toLowerCase(), 10_000_000n, 1_000_000n],
      [ROUTER3.toLowerCase(), 50_000_000n, 5_000_000n],
    ],
  );
});

test('router 3 rows below its configured start block are excluded', () => {
  const rows = feeRowsFromLogs(withRouters23(100n, 300n), [
    ...payment('before-start', 299n, ROUTER3, 1_000_000n),
    ...payment('at-start', 300n, ROUTER3, 1_000_000n),
  ]);
  assert.deepEqual(
    rows.map((r) => r.blockNumber),
    [300n],
  );
});

test('router 3 configured after the scan passed its deploy block: its early fees are read once', async (t) => {
  const db = await setup(t);
  const state = {
    latest: 5_000n,
    finalized: 5_000n,
    logs: [
      ...payment('a', 1_000n, ROUTER, 100_000n),
      ...payment('b', 2_100n, ROUTER2, 100_000_000n),
      // Router 3 deployed at 3_000; a fee at 3_100, before router 3 was configured.
      ...payment('c', 3_100n, ROUTER3, 2_000_000n),
      ...payment('d', 4_000n, ROUTER, 50_000n),
    ],
  };
  const chain = fakeChain(state);
  // Routers 1 and 2: the scan reaches the head and finalizes everything; router 3's fee is unseen.
  while ((await scanFees(db, chain, withRouter2(2_000n)))!.to < state.latest);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.emitter),
    [ROUTER.toLowerCase(), ROUTER2.toLowerCase(), ROUTER.toLowerCase()],
  );

  // Router 3 configured now: the next scan rewinds once to its deploy block and picks the fee up.
  const config = withRouters23(2_000n, 3_000n);
  state.logs.push(...payment('e', 5_050n, ROUTER3, 1_000_000n));
  state.latest = 5_100n;
  state.finalized = 5_100n;
  for (let i = 0; i < 5; i++) await scanFees(db, chain, config);
  const rows = await rowsOf(db);
  assert.deepEqual(
    rows.map((r) => [r.emitter, r.gross, r.fee, r.finalized]),
    [
      [ROUTER.toLowerCase(), '100000', '10000', true],
      [ROUTER2.toLowerCase(), '100000000', '10000000', true],
      [ROUTER3.toLowerCase(), '2000000', '200000', true],
      [ROUTER.toLowerCase(), '50000', '5000', true],
      [ROUTER3.toLowerCase(), '1000000', '100000', true],
    ],
  );
  const starts = await db.query<{ router: string; from_block: string }>(
    'SELECT router, from_block::text AS from_block FROM protocol_fee_router_starts ORDER BY from_block',
  );
  assert.deepEqual(starts.rows, [
    { router: ROUTER2.toLowerCase(), from_block: '2000' },
    { router: ROUTER3.toLowerCase(), from_block: '3000' },
  ]);

  // The rewind happens once: later scans read only the tail, and nothing is counted twice.
  const later = await scanFees(db, chain, config);
  assert.ok(later!.from > 3_000n);
  assert.equal((await rowsOf(db)).length, 5);
});
