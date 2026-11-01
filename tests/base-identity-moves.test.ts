import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import {
  RECHECK_EVERY_MS,
  WATCHED_TOPICS,
  tokenIdOf,
  watchChainOf,
  watchConfirmedIdentities,
  watchIdentities,
  type WatchChain,
  type WatchLog,
} from '../server/base/identity/moves.js';
import { BASE_DOMAIN_FILES_SQL, buildDomainFile } from '../server/base/identity/domain-file.js';
import { registerShortLinks } from '../server/base/identity/short-links.js';
import { basePassport } from '../server/base/identity/passport.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import {
  NOW,
  add,
  agentId,
  agentWallet,
  handoverTx,
  mintTx,
  setup,
  shortOf,
} from './on-base-fixture.js';

/*
 * A confirmed Base ID whose holder transfers it or points its agent URI elsewhere leaves the
 * domain file, its registration file's registrations and the Agent Card passport, until a check
 * at the finalized block finds it back (server/base/identity/moves.ts).
 */

const abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event MetadataUpdate(uint256 _tokenId)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
]);
const OTHER = `0x${'9'.repeat(40)}` as Hex;
const foreignTx = (n: number) => `0x${'7'.repeat(60)}${n.toString(16).padStart(4, '0')}` as Hex;

const transfer = (id: number, to: Hex, tx: Hex, block: number): WatchLog => ({
  topics: encodeEventTopics({
    abi,
    eventName: 'Transfer',
    args: { from: agentWallet(id - 100) as Hex, to, tokenId: BigInt(id) },
  }) as Hex[],
  data: '0x',
  transactionHash: tx,
  blockNumber: BigInt(block),
});
const uriUpdated = (id: number, uri: string, tx: Hex, block: number): WatchLog => ({
  topics: encodeEventTopics({
    abi,
    eventName: 'URIUpdated',
    args: { agentId: BigInt(id), updatedBy: OTHER },
  }) as Hex[],
  data: encodeAbiParameters([{ type: 'string' }], [uri]),
  transactionHash: tx,
  blockNumber: BigInt(block),
});
const metadataUpdate = (id: number, tx: Hex, block: number): WatchLog => ({
  topics: encodeEventTopics({ abi, eventName: 'MetadataUpdate' }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(id)]),
  transactionHash: tx,
  blockNumber: BigInt(block),
});

/** A chain with these logs and these ids' state at the finalized block (ours by default). */
function fakeChain(logs: WatchLog[], finalized = 5000n) {
  const ranges: Array<[bigint, bigint]> = [];
  const state = new Map<number, { owner: string; tokenUri: string } | 'missing'>();
  const reads: number[] = [];
  const chain: WatchChain & { finalized: bigint } = {
    finalized,
    finalizedBlock: async () => chain.finalized,
    logs: async ({ topics, fromBlock, toBlock }) => {
      assert.deepEqual(topics, WATCHED_TOPICS);
      ranges.push([fromBlock, toBlock]);
      return logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    identityAt: async (id) => {
      reads.push(Number(id));
      const n = Number(id) - 100;
      return (
        state.get(Number(id)) ?? {
          owner: agentWallet(n),
          tokenUri: `${AGENT_URI_ORIGIN}/a/${shortOf(n)}`,
        }
      );
    },
  };
  return { chain, ranges, state, reads };
}

async function world(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await setup(t);
  await db.exec(BASE_DOMAIN_FILES_SQL);
  for (let n = 1; n <= 4; n += 1) await add(db, { n, kind: 'final', id: 100 + n });
  return db;
}

async function domainFile(db: Database, t: { after: (fn: () => Promise<unknown>) => void }) {
  await buildDomainFile(db, AGENT_URI_ORIGIN, { logLine: () => {} });
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, {
    db,
    originOf: () => AGENT_URI_ORIGIN,
    card: async () => ({ name: 'Agent' }),
  });
  const file = (await app.inject({ url: '/.well-known/agent-registration.json' })).json() as {
    registrations: Array<{ agentId: number }>;
  };
  const registrationsOf = async (n: number) =>
    (
      (await app.inject({ url: `/a/${shortOf(n)}` })).json() as {
        registrations: Array<{ agentId: number }>;
      }
    ).registrations.map((entry) => entry.agentId);
  return { listed: file.registrations.map((entry) => entry.agentId), registrationsOf };
}

test('the watched logs name their token ids', () => {
  assert.equal(tokenIdOf(transfer(105, OTHER, foreignTx(1), 1)), 105n);
  assert.equal(
    tokenIdOf(uriUpdated(106, 'https://elsewhere.example/x.json', foreignTx(1), 1)),
    106n,
  );
  assert.equal(tokenIdOf(metadataUpdate(107, foreignTx(1), 1)), 107n);
  assert.equal(
    tokenIdOf({ topics: ['0x01'], data: '0x', transactionHash: foreignTx(1), blockNumber: 1n }),
    null,
  );
});

test('a transferred or repointed Base ID leaves the domain file, its registrations and the passport', async (t) => {
  const db = await world(t);
  const before = await domainFile(db, t);
  assert.deepEqual(before.listed, [101, 102, 103, 104]);
  const { chain, ranges, state, reads } = fakeChain([
    // Its own mint and hand-over: how it got here, never a move.
    transfer(101, agentWallet(1) as Hex, mintTx(1) as Hex, 1500),
    metadataUpdate(101, handoverTx(1) as Hex, 1501),
    // The holder points 102's URI elsewhere, and transfers 103.
    uriUpdated(102, 'https://elsewhere.example/x.json', foreignTx(1), 2500),
    metadataUpdate(102, foreignTx(1), 2500),
    transfer(103, OTHER, foreignTx(2), 4200),
    // Someone else's ID in the same registry.
    transfer(999, OTHER, foreignTx(3), 3000),
  ]);
  state.set(102, { owner: agentWallet(2), tokenUri: 'https://elsewhere.example/x.json' });
  state.set(103, { owner: OTHER, tokenUri: `${AGENT_URI_ORIGIN}/a/${shortOf(3)}` });
  const run = await watchIdentities(db, 8453, chain, { now: () => NOW });
  assert.deepEqual(run, { chainId: 8453, scannedTo: '5000', moved: 2, checked: 2, verified: 0 });
  // From the earliest mint block on, in pages of at most 1,000 blocks, contiguous.
  assert.deepEqual(
    ranges.map(([from, to]) => [Number(from), Number(to)]),
    [
      [1001, 2000],
      [2001, 3000],
      [3001, 4000],
      [4001, 5000],
    ],
  );
  assert.deepEqual(reads.sort(), [102, 103]);
  assert.deepEqual(
    (
      await db.query<{ agent_id: string; reason: string }>(
        'SELECT agent_id, reason FROM base_identity_moves ORDER BY agent_id',
      )
    ).rows,
    [
      { agent_id: agentId(2), reason: 'uri' },
      { agent_id: agentId(3), reason: 'owner' },
    ],
  );
  const after = await domainFile(db, t);
  assert.deepEqual(after.listed, [101, 104]);
  assert.deepEqual(await after.registrationsOf(2), []);
  assert.deepEqual(await after.registrationsOf(1), [101]);
  assert.equal(await basePassport(db, agentId(2)), null);
  assert.equal(await basePassport(db, agentId(3)), null);
  assert.equal((await basePassport(db, agentId(4)))?.erc8004AgentId, '104');

  // Nothing new: the next run reads no logs and checks nothing before RECHECK_EVERY_MS.
  ranges.length = 0;
  reads.length = 0;
  const idle = await watchIdentities(db, 8453, chain, { now: () => NOW + 60_000 });
  assert.deepEqual(idle, { chainId: 8453, scannedTo: null, moved: 0, checked: 0, verified: 0 });
  assert.deepEqual(ranges, []);

  // The holder points 102 back to its /a/<short> URI: re-verified at the next check, listed again.
  state.delete(102);
  const later = await watchIdentities(db, 8453, chain, { now: () => NOW + RECHECK_EVERY_MS });
  assert.deepEqual(later, { chainId: 8453, scannedTo: null, moved: 0, checked: 2, verified: 1 });
  assert.deepEqual((await domainFile(db, t)).listed, [101, 102, 104]);
  assert.equal((await basePassport(db, agentId(2)))?.erc8004AgentId, '102');
});

test('a run that cannot read Base commits what it read and continues from there', async (t) => {
  const db = await world(t);
  const { chain, ranges } = fakeChain([
    uriUpdated(102, 'https://elsewhere.example/x.json', foreignTx(1), 1200),
  ]);
  const logs = chain.logs.bind(chain);
  let fail = true;
  chain.logs = async (input) => {
    if (fail && input.fromBlock > 2000n)
      throw Object.assign(new Error('rpc https://node.example/key'), {});
    return logs(input);
  };
  chain.identityAt = async () => {
    throw new Error('down');
  };
  const run = await watchIdentities(db, 8453, chain, { now: () => NOW });
  assert.equal(run.error, 'unavailable');
  assert.equal(run.scannedTo, '2000');
  assert.equal(run.moved, 1);
  // Moved before its check: left out at once.
  assert.deepEqual((await domainFile(db, t)).listed, [101, 103, 104]);
  fail = false;
  ranges.length = 0;
  await watchIdentities(db, 8453, chain, { now: () => NOW });
  assert.equal(Number(ranges[0]![0]), 2001);
});

test('every network with confirmed IDs is watched; one without reads is skipped', async (t) => {
  const db = await world(t);
  const runs = await watchConfirmedIdentities(db, async () => {
    throw new Error('not configured');
  });
  assert.deepEqual(runs, [
    { chainId: 8453, scannedTo: null, moved: 0, checked: 0, verified: 0, error: 'not_configured' },
  ]);
});

test('Arc is watched only while it is on, and its failing reads leave Base alone', async (t) => {
  const db = await world(t);
  await db.query(
    `INSERT INTO base_identities
     SELECT (jsonb_populate_record(i, '{"chain_id": 5042002}')).*
     FROM base_identities i WHERE chain_id = 8453 LIMIT 1`,
  );
  const asked: number[] = [];
  const runtime = async (chainId: number) => {
    asked.push(chainId);
    throw new Error('not configured');
  };
  const off = await watchConfirmedIdentities(db, runtime);
  assert.deepEqual(
    off.map((run) => run.chainId),
    [8453],
  );
  asked.length = 0;
  const on = await watchConfirmedIdentities(db, runtime, { arcChainId: 5042002 });
  assert.deepEqual(
    on.map((run) => run.chainId),
    [8453, 5042002],
  );
  assert.deepEqual(asked, [8453, 5042002]);
});

test('watchChainOf has a registry to read on Arc and on Base', () => {
  const client = {} as never;
  const identityAt = (async () => ({ owner: '', tokenUri: '' })) as never;
  assert.ok(watchChainOf(5042002, client, identityAt));
  assert.ok(watchChainOf(8453, client, identityAt));
});
