import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  toHex,
  type Hex,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  arcFeeChain,
  PROTOCOL_FEE_SCAN_PATH,
  protocolArcFeeConfigFromEnv,
  registerProtocolFeeCron,
} from '../server/protocol/fees/cron.js';
import {
  FEE_EVENTS_ABI,
  PROTOCOL_FEE_LEDGER_SQL,
  type ChainLog,
  type FeeChain,
} from '../server/protocol/fees/ledger.js';
import { arcChainIdsMigrations } from '../server/base/arc-chain-ids-schema.js';
import { ARC_MAINNET, ARC_USDC } from '../shared/chains.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { bloomReads } from './fee-chain-bloom.js';

const SECRET = 'x'.repeat(32);
const auth = { authorization: `Bearer ${SECRET}` };
const BASE_TREASURY = '0x00000000000000000000000000000000000007e5' as Hex;
const BASE_ROUTER = '0x0000000000000000000000000000000000000040' as Hex;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex;
const ARC_ROUTER = getAddress('0x0000000000000000000000000000000000000a33') as Hex;
const ARC_TREASURY = PROTOCOL_BASE_MAINNET.treasury as Hex;
const PAYER = '0x00000000000000000000000000000000000000a1' as Hex;
const PAYEE = '0x00000000000000000000000000000000000005e1' as Hex;
const baseEnv = {
  CITY_PROTOCOL_FEES: '1',
  CITY_PROTOCOL_CHAIN_ID: '84532',
  CITY_PROTOCOL_TREASURY: BASE_TREASURY,
  CITY_PROTOCOL_ROUTER: BASE_ROUTER,
  CITY_PROTOCOL_START_BLOCK: '100',
};
const arcEnv = {
  CITY_ARC: '1',
  CITY_ARC_FEE_ROUTER3: ARC_ROUTER,
  CITY_ARC_FEE_ROUTER3_FROM_BLOCK: '1000',
};

function feeLogs(router: Hex, usdc: Hex, treasury: Hex, block: bigint, tag: string): ChainLog[] {
  const tx = keccak256(toHex(`tx-${tag}`));
  const hash = keccak256(toHex(`${tag}${block}`));
  return [
    {
      address: router,
      topics: encodeEventTopics({
        abi: FEE_EVENTS_ABI,
        eventName: 'FeeCharged',
        args: { payer: PAYER, payee: PAYEE, ref: keccak256(toHex(tag)) },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
        [1, 100_000n, 10_000n],
      ),
      transactionHash: tx,
      logIndex: 1,
      blockNumber: block,
      blockHash: hash,
    },
    {
      address: usdc,
      topics: encodeEventTopics({
        abi: FEE_EVENTS_ABI,
        eventName: 'Transfer',
        args: { from: PAYER, to: treasury },
      }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }], [10_000n]),
      transactionHash: tx,
      logIndex: 0,
      blockNumber: block,
      blockHash: hash,
    },
  ];
}

function fakeChain(
  logs: ChainLog[],
  head: bigint,
  finalized: bigint | null,
  tag: string,
  calls: string[],
) {
  const state = { failing: false };
  const hashOf = (n: bigint) =>
    logs.find((l) => l.blockNumber === n)?.blockHash ?? keccak256(toHex(`${tag}${n}`));
  const chain: FeeChain = {
    latestBlock: async () => {
      calls.push('latest');
      if (state.failing) throw new Error('down at https://rpc.secret.example/key');
      return head;
    },
    finalizedBlock: async () => {
      calls.push('finalized');
      if (finalized === null) throw new Error('no finalized tag');
      return finalized;
    },
    block: async (n) => (calls.push('block'), { timestamp: 1_791_936_000n + n, hash: hashOf(n) }),
    ...bloomReads(() => logs, hashOf),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      calls.push('logs');
      return logs.filter(
        (l) =>
          l.address.toLowerCase() === address.toLowerCase() &&
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock,
      );
    },
  };
  return { chain, state };
}

async function setup(t: test.TestContext, overrides: Record<string, string | undefined> = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  for (const m of arcChainIdsMigrations)
    if (/protocol_fee_(events|scan_state)_chain/.test(m.sql))
      await pg.exec(m.sql.replace(/SET LOCAL[^;]*;/, ''));
  const queries: string[] = [];
  const db: Database = {
    query: (sql, params) => (
      queries.push(`${sql} ${JSON.stringify(params ?? [])}`),
      pg.query(sql, params) as never
    ),
    exec: (sql) => pg.exec(sql),
    transaction: (action) =>
      pg.transaction((tx) =>
        action({
          ...tx,
          query: (sql: string, params?: unknown[]) => (
            queries.push(`${sql} ${JSON.stringify(params ?? [])}`),
            tx.query(sql, params)
          ),
        } as never),
      ),
    close: () => pg.close(),
  };
  const baseCalls: string[] = [];
  const arcCalls: string[] = [];
  const arcAsked: number[] = [];
  const base = fakeChain(
    feeLogs(BASE_ROUTER, BASE_USDC, BASE_TREASURY, 150n, 'base'),
    200n,
    160n,
    'b',
    baseCalls,
  );
  // Arc has no finalized tag here: the pass must never ask for one.
  const arc = fakeChain(
    feeLogs(ARC_ROUTER, ARC_USDC as Hex, ARC_TREASURY, 1500n, 'arc'),
    2000n,
    null,
    'a',
    arcCalls,
  );
  const app = Fastify();
  const lines: string[] = [];
  registerProtocolFeeCron(app, {
    db,
    cronSecret: SECRET,
    env: { ...baseEnv, ...overrides },
    chainFor: (id) => (id === 84532 ? base.chain : null),
    arcChainFor: (id) => (arcAsked.push(id), arcFeeChain(arc.chain, async () => id, id)),
    log: (line) => lines.push(line),
  });
  t.after(() => app.close());
  const rows = async (chainId: number) =>
    (
      await pg.query<{ emitter: string; source: string; kind: number; finalized: boolean }>(
        'SELECT emitter, source, kind, finalized FROM protocol_fee_events WHERE chain_id = $1',
        [chainId],
      )
    ).rows;
  const cursor = async (chainId: number) =>
    (
      await pg.query<{ next_block: string; finalized_through: string | null }>(
        'SELECT next_block::text, finalized_through::text FROM protocol_fee_scan_state WHERE chain_id = $1',
        [chainId],
      )
    ).rows[0];
  return { app, lines, queries, baseCalls, arcCalls, arcAsked, base, arc, rows, cursor };
}

test('config: a test network reads the treasury its fees reach, a real-money one never', () => {
  const throwaway = '0x00000000000000000000000000000000000007A4';
  const withOwn = { ...arcEnv, CITY_ARC_TREASURY: throwaway };
  // Otherwise every fee on the test network has no transfer to back it, and the scan stops there.
  assert.equal(
    protocolArcFeeConfigFromEnv({ ...withOwn, CITY_ARC_CHAIN_ID: '5042002' })?.treasury,
    getAddress(throwaway),
  );
  assert.equal(
    protocolArcFeeConfigFromEnv({ ...arcEnv, CITY_ARC_CHAIN_ID: '5042002' })?.treasury,
    getAddress(PROTOCOL_BASE_MAINNET.treasury),
  );
  assert.equal(
    protocolArcFeeConfigFromEnv({ ...withOwn, CITY_ARC_CHAIN_ID: String(ARC_MAINNET) })?.treasury,
    getAddress(PROTOCOL_BASE_MAINNET.treasury),
  );
  assert.equal(
    protocolArcFeeConfigFromEnv({
      ...withOwn,
      CITY_ARC_CHAIN_ID: '5042002',
      CITY_ARC_TREASURY: 'nonsense',
    })?.treasury,
    getAddress(PROTOCOL_BASE_MAINNET.treasury),
  );
});

test('config: off unless CITY_ARC=1 and a router; deployment beats env; Base treasury, Arc USDC', () => {
  assert.equal(protocolArcFeeConfigFromEnv({}), null);
  assert.equal(protocolArcFeeConfigFromEnv({ ...arcEnv, CITY_ARC: undefined }), null);
  assert.equal(protocolArcFeeConfigFromEnv({ ...arcEnv, CITY_ARC: '0' }), null);
  assert.equal(protocolArcFeeConfigFromEnv({ CITY_ARC: '1' }), null);
  assert.equal(
    protocolArcFeeConfigFromEnv({ ...arcEnv, CITY_ARC_FEE_ROUTER3_FROM_BLOCK: 'x' }),
    null,
  );
  assert.equal(protocolArcFeeConfigFromEnv({ ...arcEnv, CITY_ARC_CHAIN_ID: '8453' }), null);
  assert.deepEqual(protocolArcFeeConfigFromEnv(arcEnv), {
    chainId: 5042,
    usdc: ARC_USDC,
    treasury: getAddress(PROTOCOL_BASE_MAINNET.treasury),
    router: ARC_ROUTER,
    escrow: null,
    startBlock: 1000n,
  });
  assert.equal(
    protocolArcFeeConfigFromEnv({ ...arcEnv, CITY_ARC_CHAIN_ID: '5042002' })?.chainId,
    5042002,
  );
  // A deployment fixed in code for the Arc id wins over the env: its router 3 and deploy block.
  const record = {
    ...PROTOCOL_BASE_MAINNET,
    chainId: 5042,
    feeRouter3: '0x0000000000000000000000000000000000000B77',
    feeRouter3DeployBlock: 77n,
  } as typeof PROTOCOL_BASE_MAINNET;
  const pinned = protocolArcFeeConfigFromEnv(arcEnv, (id) => (id === 5042 ? record : null));
  assert.equal(pinned?.router, getAddress('0x0000000000000000000000000000000000000b77'));
  assert.equal(pinned?.startBlock, 77n);
  assert.equal(pinned?.addedRouters, undefined);
  assert.equal(pinned?.escrow, null);
  // Today no Arc record exists: the env applies.
  assert.equal(protocolArcFeeConfigFromEnv(arcEnv)?.router, ARC_ROUTER);
});

test('off: the cron makes exactly the Base queries and RPC calls, never an Arc one', async (t) => {
  const on = await setup(t, { ...arcEnv, CITY_ARC: undefined });
  const res = await on.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { from: '100', to: '200', written: 1, removed: 0, busy: false });
  assert.deepEqual(on.arcAsked, []);
  assert.deepEqual(on.arcCalls, []);
  assert.ok(!on.queries.some((q) => q.includes('5042')));
  // Same queries and calls as a cron with no Arc settings at all.
  const plain = await setup(t, {});
  await plain.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  const strip = (qs: string[]) => qs.map((q) => q.replace(/\d{13}/g, 'T'));
  assert.deepEqual(strip(on.queries), strip(plain.queries));
  assert.deepEqual(on.baseCalls, plain.baseCalls);
});

test('on: the Arc pass runs after Base, writes chain_id 5042 rows and its own cursor; Base untouched', async (t) => {
  const s = await setup(t, arcEnv);
  const res = await s.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    from: '100',
    to: '200',
    written: 1,
    removed: 0,
    busy: false,
    arc: { from: '1000', to: '2000', written: 1, removed: 0, busy: false },
  });
  assert.deepEqual(s.arcAsked, [5042]);
  assert.ok(!s.arcCalls.includes('finalized'), 'Arc never waits on a finalized tag');
  assert.deepEqual(await s.rows(5042), [
    { emitter: ARC_ROUTER.toLowerCase(), source: 'router', kind: 1, finalized: false },
  ]);
  assert.deepEqual(await s.rows(84532), [
    { emitter: BASE_ROUTER, source: 'router', kind: 1, finalized: false },
  ]);
  assert.equal((await s.cursor(5042))?.next_block, '2001');
  assert.equal((await s.cursor(84532))?.next_block, '201');
  // Base's queries all ran before the first Arc one.
  const firstArc = s.queries.findIndex((q) => q.includes('5042'));
  const lastBase = s.queries.map((q) => q.includes('84532')).lastIndexOf(true);
  assert.ok(firstArc > lastBase);
  // Next run: Arc's head is final, so its row is promoted (one run of delay, as on Base).
  await s.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal((await s.rows(5042))[0]?.finalized, true);
  assert.equal((await s.cursor(5042))?.finalized_through, '2000');
});

test('an Arc failure logs one line and never changes the Base pass or its answer', async (t) => {
  const s = await setup(t, arcEnv);
  s.arc.state.failing = true;
  const res = await s.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().written, 1);
  assert.deepEqual(res.json().arc, { failed: true });
  assert.deepEqual(
    s.lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'protocol_fee_scan.arc_failed'),
    [{ event: 'protocol_fee_scan.arc_failed', error: 'Error' }],
  );
  assert.ok(!s.lines.join('').includes('secret'));
  assert.equal((await s.rows(84532)).length, 1);
  assert.deepEqual(await s.rows(5042), []);
  // A Base failure still lets Arc run after it, and the answer stays Base's 503.
  const b = await setup(t, arcEnv);
  b.base.state.failing = true;
  const failed = await b.app.inject({ url: PROTOCOL_FEE_SCAN_PATH, headers: auth });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { error: 'unavailable', reason: 'scan_failed' });
  assert.equal((await b.rows(5042)).length, 1);
});

test('the Arc reader refuses an RPC on another chain', async () => {
  const calls: string[] = [];
  const { chain } = fakeChain([], 5n, null, 'x', calls);
  await assert.rejects(arcFeeChain(chain, async () => 8453, 5042).latestBlock());
});
