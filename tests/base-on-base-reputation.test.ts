import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import Fastify from 'fastify';
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  type Hex,
} from 'viem';
import type { Database } from '../server/database.js';
import { FEEDBACK_TAG_MAX, registerOnBaseRoutes } from '../server/base/explorer/routes.js';
import {
  baseChainReader,
  CLIENTS_READ_MS,
  FEEDBACK_CLIENTS_MAX,
  FEEDBACK_READ_MAX,
  FEEDBACK_SPLIT_CALLS_MAX,
  MULTICALL3,
  RATER_ENTRIES_MAX,
  reputationClientsAbi,
  reputationEntryAbi,
  reputationReadAbi,
  type FeedbackRead,
  type OnBaseChainReader,
} from '../server/base/explorer/head.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import {
  feedbackScore,
  ON_BASE_REPUTATION_MAX,
  type OnBasePassport,
} from '../shared/base/on-base.js';
import { cityScore } from '../shared/base/rating-score.js';
import {
  MIN,
  NOW,
  REGISTRY,
  SEPOLIA_REGISTRY,
  add,
  addRating,
  agentWallet,
  setup,
  spender,
} from './on-base-fixture.js';

/*
 * A passport's Reputation: the feedback Base's ERC-8004 Reputation Registry holds for the id,
 * read by the server at the head block (head.ts, routes.ts). Anyone can give feedback, so only
 * Central City's own listed agents are named, with their tags.
 */

const REPUTATION = BASE_NETWORKS[BASE_MAINNET].contracts.reputationRegistry;
const NOT_READ = {
  readAtBlock: null,
  readAt: null,
  count: 0,
  entries: [],
  score: null,
  scoredBy: [],
};
const outsider = (n: number) => getAddress(`0x${'9'.repeat(38)}${n.toString(16).padStart(2, '0')}`);
const read = (
  client: string,
  index: number | bigint,
  value: bigint,
  decimals = 0,
  tags = ['', ''],
) =>
  ({
    client: getAddress(client),
    index: BigInt(index),
    value,
    decimals,
    tag1: tags[0],
    tag2: tags[1],
  }) satisfies FeedbackRead;

function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  db: Database,
  chain: OnBaseChainReader | undefined,
  now: () => number = () => NOW,
) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now, chain });
  return app;
}

/** Base stand-in with a head, owners as recorded, and the feedback per id. Counts its reads. */
function fakeBase(feedback: Record<string, FeedbackRead[]>) {
  const state = {
    block: 40n,
    down: false,
    feedbackReads: 0,
    feedback,
    /** The clients the last read was told to take first. */
    preferred: null as ReadonlySet<string> | null,
  };
  const chain: OnBaseChainReader = {
    async head() {
      if (state.down) throw new Error('down');
      return { block: state.block };
    },
    async owners(ids) {
      return new Map(ids.map((id) => [id, null]));
    },
    async feedback(baseId, block, prefer) {
      state.feedbackReads++;
      if (state.down) throw new Error('down');
      assert.equal(block, state.block);
      const entries = state.feedback[baseId] ?? [];
      state.preferred = prefer
        ? await prefer([...new Set(entries.map((entry) => entry.client))])
        : null;
      return { entries, total: entries.length, bounded: false, ratersSkipped: 0 };
    },
  };
  return { state, chain };
}

test('a feedback value with its decimals is an exact decimal string', () => {
  assert.equal(feedbackScore(1n, 0), '1');
  assert.equal(feedbackScore(-15n, 1), '-1.5');
  assert.equal(feedbackScore(8725n, 2), '87.25');
  assert.equal(feedbackScore(500n, 3), '0.5');
  assert.equal(feedbackScore(-5n, 3), '-0.005');
  assert.equal(feedbackScore(100n, 2), '1');
  assert.equal(feedbackScore(0n, 4), '0');
  assert.equal(feedbackScore(10n ** 38n, 18), '100000000000000000000');
});

test('the passport names feedback from listed agents with their tags; anyone else is an address', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  await add(db, { n: 3, kind: 'finalizing', id: 122, name: 'Compass' });
  await add(db, { n: 4, kind: 'final', id: 123, name: 'Hidden', visibility: 'private' });
  await add(db, { n: 5, kind: 'pending', name: 'Pending' }); // not listed: never named
  const base = fakeBase({
    '120': [
      // From Meridian's registration smart account, and from Compass's own wallet.
      read(spender(2), 1, 1n, 0, ['research', 'on time']),
      read(agentWallet(3), 1, 8725n, 2, ['answered\nwith sources', '']),
      read(outsider(1), 1, -5n, 1, ['spam text anyone can write', 'x']),
      read(agentWallet(4), 1, 2n), // listed, but its card is not public
      read(agentWallet(5), 1, 3n, 0, ['not listed', '']),
      read(spender(2), 2, 1n, 0, ['t'.repeat(60), '']),
    ],
  });
  const app = routes(t, db, base.chain);

  const passport = (
    await app.inject({ url: '/api/public/base/agents/120' })
  ).json() as OnBasePassport;
  assert.deepEqual(passport.reputation, {
    readAtBlock: 40,
    readAt: NOW,
    count: 6,
    // The registry's list, last first.
    entries: [
      {
        client: getAddress(spender(2)),
        index: 2,
        from: { name: 'Meridian', baseId: '121' },
        score: '1',
        tags: [`${'t'.repeat(FEEDBACK_TAG_MAX - 1)}…`],
      },
      { client: getAddress(agentWallet(5)), index: 1, from: null, score: '3', tags: [] },
      {
        client: getAddress(agentWallet(4)),
        index: 1,
        from: { name: '', baseId: '123' },
        score: '2',
        tags: [],
      },
      { client: outsider(1), index: 1, from: null, score: '-0.5', tags: [] },
      {
        client: getAddress(agentWallet(3)),
        index: 1,
        from: { name: 'Compass', baseId: '122' },
        score: '87.25',
        tags: ['answered with sources'],
      },
      {
        client: getAddress(spender(2)),
        index: 1,
        from: { name: 'Meridian', baseId: '121' },
        score: '1',
        tags: ['research', 'on time'],
      },
    ],
    // None of these is a star rating.
    score: null,
    scoredBy: [],
  });

  // An id without feedback: read, and none.
  const quiet = (await app.inject({ url: '/api/public/base/agents/121' })).json() as OnBasePassport;
  assert.deepEqual(quiet.reputation, {
    readAtBlock: 40,
    readAt: NOW,
    count: 0,
    entries: [],
    score: null,
    scoredBy: [],
  });
});

test('the Central City score: the latest star rating of each final Central City agent wallet', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  await add(db, { n: 3, kind: 'final', id: 122, name: 'Compass' });
  await add(db, { n: 4, kind: 'finalizing', id: 123, name: 'Lantern' });
  await add(db, { n: 5, kind: 'pending', name: 'Pending' });
  await add(db, { n: 6, kind: 'final', id: 125, name: 'Quiet', visibility: 'private' });
  await add(db, {
    n: 7,
    kind: 'final',
    id: 126,
    name: 'Elsewhere',
    chainId: 84532,
    registry: SEPOLIA_REGISTRY,
  });
  const star = (client: string, index: number, stars: number, tag = 'starred') =>
    read(client, index, BigInt(stars * 20), 0, [tag, '']);
  const base = fakeBase({
    '120': [
      // Meridian rated 5, then 3: the latest counts.
      star(agentWallet(2), 1, 5),
      star(agentWallet(2), 2, 3),
      // Compass rated 4, then gave other feedback: still 4.
      star(agentWallet(3), 1, 4),
      star(agentWallet(3), 2, 1, 'quality'),
      read(agentWallet(3), 3, 50n, 0, ['starred', '']),
      // A listed agent without a public card is still a Central City agent with a final Base ID.
      star(agentWallet(6), 1, 5),
      // Never counted: Harbor's own wallet rating Harbor (an agent doesn't rate itself), a
      // finalizing agent, a registration smart account, an agent not listed,
      // another network's agent, anyone else.
      star(agentWallet(1), 1, 1),
      star(agentWallet(4), 1, 1),
      star(spender(2), 1, 1),
      star(agentWallet(5), 1, 1),
      star(agentWallet(7), 1, 1),
      // Enough outsiders that the counted ratings are no longer among the entries shown.
      ...Array.from({ length: ON_BASE_REPUTATION_MAX + 5 }, (_, i) => star(outsider(i), 1, 1)),
    ],
    '121': [star(outsider(1), 1, 5), star(agentWallet(4), 1, 5)],
  });
  const app = routes(t, db, base.chain);
  const reputationOf = async (id: string) =>
    ((await app.inject({ url: `/api/public/base/agents/${id}` })).json() as OnBasePassport)
      .reputation;

  const scored = await reputationOf('120');
  assert.deepEqual(scored.score, { average: '4.0', raters: 3 });
  assert.deepEqual(
    scored.scoredBy,
    [agentWallet(2), agentWallet(3), agentWallet(6)].map(getAddress),
  );
  assert.equal(scored.count, 11 + ON_BASE_REPUTATION_MAX + 5);
  assert.ok(scored.entries.every((entry) => entry.from === null));
  // The same answer as the shared function on every entry read, with the final agents' wallets
  // (Harbor's among them) and Harbor's own wallet as the rated one.
  assert.deepEqual(
    scored.score,
    cityScore(
      base.state.feedback['120']!,
      [agentWallet(1), agentWallet(2), agentWallet(3), agentWallet(6)],
      agentWallet(1),
    ),
  );
  // Harbor's own wallet is a rater of every other agent: its rating of Compass counts.
  base.state.feedback['122'] = [star(agentWallet(1), 1, 2)];
  const other = await reputationOf('122');
  assert.deepEqual(other.score, { average: '2.0', raters: 1 });
  assert.deepEqual(other.scoredBy, [getAddress(agentWallet(1))]);

  // Ratings, but none from a Central City agent with a final Base ID: no score.
  const none = await reputationOf('121');
  assert.equal(none.count, 2);
  assert.equal(none.score, null);
  assert.deepEqual(none.scoredBy, []);
});

test('CCA-144: a rating sent on Base by a wallet of the same owner key never counts in the score', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  await add(db, { n: 3, kind: 'final', id: 122, name: 'Compass' });
  // Meridian's wallet has Harbor's owner key (one person's two agents); Compass is someone else.
  await db.query(
    `UPDATE base_wallets SET owner_address = (SELECT owner_address FROM base_wallets
       WHERE wallet_id = 'w-1') WHERE wallet_id = 'w-2'`,
  );
  const star = (client: string, index: number, stars: number) =>
    read(client, index, BigInt(stars * 20), 0, ['starred', '']);
  const base = fakeBase({
    '120': [star(agentWallet(2), 1, 5), star(agentWallet(3), 1, 2)],
    '121': [star(agentWallet(1), 1, 5), star(agentWallet(3), 1, 4)],
    '122': [star(agentWallet(1), 1, 5), star(agentWallet(2), 1, 3)],
  });
  const app = routes(t, db, base.chain);
  const reputationOf = async (id: string) =>
    ((await app.inject({ url: `/api/public/base/agents/${id}` })).json() as OnBasePassport)
      .reputation;
  // Harbor and Meridian rating each other directly on Base: left out both ways.
  const harbor = await reputationOf('120');
  assert.deepEqual(harbor.score, { average: '2.0', raters: 1 });
  assert.deepEqual(harbor.scoredBy, [getAddress(agentWallet(3))]);
  assert.equal(harbor.count, 2, 'every entry is still listed; only the score leaves it out');
  const meridian = await reputationOf('121');
  assert.deepEqual(meridian.score, { average: '4.0', raters: 1 });
  assert.deepEqual(meridian.scoredBy, [getAddress(agentWallet(3))]);
  // Another owner's agent: both of that person's wallets count, one rating each.
  const compass = await reputationOf('122');
  assert.deepEqual(compass.score, { average: '4.0', raters: 2 });
  assert.deepEqual(compass.scoredBy, [agentWallet(1), agentWallet(2)].map(getAddress));
});

test('a passport lists the last entries only, and counts them all', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const many = Array.from({ length: ON_BASE_REPUTATION_MAX + 20 }, (_, i) =>
    read(outsider(i % 200), i + 1, BigInt(i)),
  );
  const base = fakeBase({ '120': many });
  const passport = (
    await routes(t, db, base.chain).inject({ url: '/api/public/base/agents/120' })
  ).json() as OnBasePassport;
  assert.equal(passport.reputation.count, ON_BASE_REPUTATION_MAX + 20);
  assert.equal(passport.reputation.entries.length, ON_BASE_REPUTATION_MAX);
  assert.equal(passport.reputation.entries[0].index, ON_BASE_REPUTATION_MAX + 20);
  assert.equal(passport.reputation.entries.at(-1)?.index, 21);
});

test('not read is never "no feedback": a failed read keeps the earlier one, with its own block', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  const base = fakeBase({ '120': [read(outsider(1), 1, 1n)] });
  let clock = NOW;
  const app = routes(t, db, base.chain, () => clock);
  const reputationOf = async (id: string) =>
    ((await app.inject({ url: `/api/public/base/agents/${id}` })).json() as OnBasePassport)
      .reputation;

  // Base down before the first read: not read.
  base.state.down = true;
  assert.deepEqual(await reputationOf('121'), NOT_READ);

  base.state.down = false;
  clock = NOW + MIN;
  assert.deepEqual(await reputationOf('120'), {
    readAtBlock: 40,
    readAt: NOW + MIN,
    count: 1,
    entries: [{ client: outsider(1), index: 1, from: null, score: '1', tags: [] }],
    score: null,
    scoredBy: [],
  });
  // The same head: no second read.
  const reads = base.state.feedbackReads;
  await reputationOf('120');
  assert.equal(base.state.feedbackReads, reads);

  // A new head, then Base stops answering: the earlier read stands with its own block and time.
  base.state.block = 41n;
  base.state.feedback['120'] = [];
  clock = NOW + 2 * MIN;
  base.state.down = true;
  const kept = await reputationOf('120');
  assert.equal(kept.readAtBlock, 40);
  assert.equal(kept.readAt, NOW + MIN);
  assert.equal(kept.count, 1);
});

test('without a reputation registry the passport says not read and never asks Base', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  const { chain, state } = fakeBase({});
  const { feedback: _unused, ...withoutFeedback } = chain;
  const passport = (
    await routes(t, db, withoutFeedback).inject({ url: '/api/public/base/agents/120' })
  ).json() as OnBasePassport;
  assert.deepEqual(passport.reputation, NOT_READ);
  assert.equal(state.feedbackReads, 0);
});

/** Thrown by a stand-in answer: the node answers with an error of its own (out of gas). */
class OutOfGas extends Error {}

/** One stored feedback entry of the stand-in registry, for readFeedback. */
interface Stored {
  value: bigint;
  decimals?: number;
  tag1?: string;
  tag2?: string;
  revoked?: boolean;
  /** Too large for the node to answer: the inner call fails (a whole call errors). */
  huge?: boolean;
}

/**
 * A local JSON-RPC stand-in for the Reputation Registry (no network): getClients answers
 * `clients` (or `clientsFail`: an error of the node's own), getLastIndex (through Multicall3
 * aggregate3) answers `counts`, readFeedback (through aggregate3) answers `stored`, and
 * readAllFeedback answers `answer`. An answer that throws OutOfGas is a JSON-RPC error of the
 * node (a failed inner call inside aggregate3).
 */
async function mockReputation(
  t: { after: (fn: () => Promise<unknown>) => void },
  answer: (args: readonly unknown[]) => Hex,
  registry: {
    clients: string[];
    counts: Record<string, bigint>;
    stored?: Record<string, Stored[]>;
    clientsFail?: boolean;
    /** getClients answers only after this long. */
    clientsDelayMs?: number;
    /** Every aggregate3 of readFeedback calls answers this JSON-RPC error of the node. */
    entriesError?: { code: number; message: string };
    /** An aggregate3 of readFeedback calls holding a huge entry is too large as a whole. */
    hugeFailsWhole?: boolean;
    /** A registry without readFeedback: every readFeedback call reverts. */
    noReadFeedback?: boolean;
  } = { clients: [], counts: {} },
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  /** The size of each aggregate3 of readFeedback calls the stand-in was asked. */
  const entryCalls: number[] = [];
  const asked: string[] = [];
  const entriesRead: Array<[string, bigint]> = [];
  const reply = (data: Hex): Hex => {
    const abi = [...reputationReadAbi, ...reputationClientsAbi, ...reputationEntryAbi];
    const { functionName, args } = decodeFunctionData({ abi, data });
    if (functionName === 'getClients') {
      if (registry.clientsFail) throw new OutOfGas();
      return encodeFunctionResult({
        abi: reputationClientsAbi,
        functionName: 'getClients',
        result: registry.clients.map((client) => getAddress(client)),
      });
    }
    if (functionName === 'getLastIndex') {
      const client = getAddress(args[1]);
      asked.push(client);
      return encodeFunctionResult({
        abi: reputationClientsAbi,
        functionName: 'getLastIndex',
        result: registry.counts[client] ?? 0n,
      });
    }
    if (functionName === 'readFeedback') {
      const client = getAddress(args[1]);
      const index = args[2];
      entriesRead.push([client, index]);
      if (registry.noReadFeedback) throw new OutOfGas();
      const entry = registry.stored?.[client]?.[Number(index) - 1];
      if (!entry || entry.huge) throw new OutOfGas();
      return encodeFunctionResult({
        abi: reputationEntryAbi,
        functionName: 'readFeedback',
        result: [
          entry.value,
          entry.decimals ?? 0,
          entry.tag1 ?? '',
          entry.tag2 ?? '',
          entry.revoked ?? false,
        ],
      });
    }
    return answer(args);
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      calls.push(call);
      const send = (body: unknown) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(body as object) }));
      };
      const result = (value: unknown) => send({ result: value });
      if (call.method === 'eth_chainId') return result('0x2105');
      const [tx] = call.params as [{ to: string; data: Hex }];
      const getClients = encodeFunctionData({
        abi: reputationClientsAbi,
        functionName: 'getClients',
        args: [0n],
      }).slice(0, 10);
      if (registry.clientsDelayMs && tx.data.startsWith(getClients)) {
        const { clientsDelayMs } = registry;
        registry = { ...registry, clientsDelayMs: 0 };
        setTimeout(() => {
          raw = JSON.stringify(call);
          request.emit('end');
        }, clientsDelayMs);
        return;
      }
      try {
        if (getAddress(tx.to) === getAddress(MULTICALL3)) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
          const inner = args[0] as readonly { target: string; callData: Hex }[];
          if (inner[0]?.callData.startsWith(READ_FEEDBACK_SELECTOR)) {
            entryCalls.push(inner.length);
            if (registry.entriesError) return send({ error: registry.entriesError });
            const huge = inner.some(({ callData }) => {
              const { args: entryArgs } = decodeFunctionData({
                abi: reputationEntryAbi,
                data: callData,
              });
              return registry.stored?.[getAddress(entryArgs[1])]?.[Number(entryArgs[2]) - 1]?.huge;
            });
            if (registry.hugeFailsWhole && huge && inner.length > 1) throw new OutOfGas();
          }
          return result(
            encodeFunctionResult({
              abi: multicall3Abi,
              functionName: 'aggregate3',
              result: inner.map((one) => {
                assert.equal(getAddress(one.target), getAddress(REPUTATION));
                try {
                  return { success: true, returnData: reply(one.callData) };
                } catch (error) {
                  if (error instanceof OutOfGas) return { success: false, returnData: '0x' as Hex };
                  throw error;
                }
              }),
            }),
          );
        }
        assert.equal(getAddress(tx.to), getAddress(REPUTATION));
        return result(reply(tx.data));
      } catch (error) {
        if (error instanceof OutOfGas)
          return send({ error: { code: -32000, message: 'out of gas' } });
        throw error;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    calls,
    asked,
    entriesRead,
    entryCalls,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

/** The readAllFeedback calls the stand-in answered, decoded. */
const feedbackCalls = (calls: Array<{ method: string; params: unknown[] }>) =>
  calls
    .filter((call) => call.method === 'eth_call')
    .map((call) => (call.params as [{ to: string; data: Hex }, string])[0])
    .filter((tx) => getAddress(tx.to) === getAddress(REPUTATION))
    .map((tx) =>
      decodeFunctionData({
        abi: [...reputationReadAbi, ...reputationClientsAbi, ...reputationEntryAbi],
        data: tx.data,
      }),
    )
    .filter((decoded) => decoded.functionName === 'readAllFeedback');

test('the Base reader reads all feedback of an id at one block and leaves revoked entries out', async (t) => {
  const a = outsider(1);
  const b = outsider(2);
  const rpc = await mockReputation(
    t,
    (args) => {
      // Every client, any tags, revoked ones excluded by the registry itself.
      assert.deepEqual(args, [120n, [], '', '', false]);
      return encodeFunctionResult({
        abi: reputationReadAbi,
        functionName: 'readAllFeedback',
        result: [
          [a, a, b],
          // A uint64 index above 2^53 stays exact (a JS number would round it).
          [1n, 2n, 2n ** 53n + 1n],
          [1n, -15n, 8725n],
          [0, 1, 2],
          ['research', '', 'x'],
          ['', '', 'y'],
          [false, true, false],
        ],
      });
    },
    { clients: [a, b], counts: { [a]: 2n, [b]: 1n } },
  );
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  assert.deepEqual(await reader.feedback?.('120', 16n), {
    entries: [read(a, 1, 1n, 0, ['research', '']), read(b, 2n ** 53n + 1n, 8725n, 2, ['x', 'y'])],
    total: 2,
    bounded: false,
    ratersSkipped: 0,
  });
  // Every read at the one block.
  for (const call of rpc.calls.filter((call) => call.method === 'eth_call'))
    assert.equal(call.params[1], '0x10');

  // Without a reputation registry there is no feedback read at all.
  assert.equal(baseChainReader(rpc.url, 8453, REGISTRY).feedback, undefined);
});

test('an id without feedback clients is read as none, without a readAllFeedback call', async (t) => {
  const rpc = await mockReputation(t, () => {
    throw new Error('not asked');
  });
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  assert.deepEqual(await reader.feedback!('120', 16n), {
    entries: [],
    total: 0,
    bounded: false,
    ratersSkipped: 0,
  });
  assert.equal(feedbackCalls(rpc.calls).length, 0);
});

test('feedback spam cannot make the read unbounded: each rater on its own, then the newest clients that fit', async (t) => {
  const rater = getAddress(agentWallet(2));
  const spammer = outsider(1);
  const early = outsider(2);
  const late = outsider(3);
  const rpc = await mockReputation(
    t,
    (args) => {
      // Only the other clients that fit, newest first, in registry order; never every client.
      assert.deepEqual(args, [120n, [early, late], '', '', false]);
      return encodeFunctionResult({
        abi: reputationReadAbi,
        functionName: 'readAllFeedback',
        result: [[late], [1n], [5n], [0], [''], [''], [false]],
      });
    },
    {
      clients: [early, rater, spammer, late],
      counts: {
        [early]: BigInt(FEEDBACK_READ_MAX - 2),
        [rater]: 2n,
        [spammer]: 50_000n,
        [late]: 1n,
      },
      stored: {
        [rater]: [
          { value: 100n, tag1: 'starred' },
          { value: 80n, tag1: 'starred' },
        ],
      },
    },
  );
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const got = await reader.feedback!('120', 16n, async (clients) => {
    assert.equal(clients.length, 4);
    return new Set([rater.toLowerCase()]);
  });
  assert.equal(got.bounded, true);
  assert.equal(got.ratersSkipped, 0);
  assert.equal(got.total, FEEDBACK_READ_MAX - 2 + 2 + 50_000 + 1);
  // The rater's newest entry is its latest rating: one read of it, nothing older.
  assert.deepEqual(rpc.entriesRead, [[rater, 2n]]);
  assert.deepEqual(
    got.entries.map((entry) => [entry.client, entry.index]),
    [
      [rater, 2n],
      [late, 1n],
    ],
  );
  assert.equal(feedbackCalls(rpc.calls).length, 1);
});

test('past FEEDBACK_CLIENTS_MAX clients only the raters and the newest are counted', async (t) => {
  const clients = Array.from({ length: FEEDBACK_CLIENTS_MAX + 200 }, (_, i) =>
    getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`),
  );
  const rater = clients[0]!;
  const counts = Object.fromEntries(clients.map((client) => [client, 1n]));
  let readClients: readonly string[] = [];
  const rpc = await mockReputation(
    t,
    (args) => {
      readClients = args[1] as readonly string[];
      return encodeFunctionResult({
        abi: reputationReadAbi,
        functionName: 'readAllFeedback',
        result: [[], [], [], [], [], [], []],
      });
    },
    { clients, counts, stored: { [rater]: [{ value: 100n, tag1: 'starred' }] } },
  );
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const got = await reader.feedback!('120', 16n, async () => new Set([rater.toLowerCase()]));
  assert.equal(rpc.asked.length, FEEDBACK_CLIENTS_MAX + 1);
  assert.equal(got.total, clients.length);
  // The rater on its own; the newest others that fit in one read.
  assert.deepEqual(rpc.entriesRead, [[rater, 1n]]);
  assert.deepEqual(
    got.entries.map((entry) => [entry.client, entry.index]),
    [[rater, 1n]],
  );
  assert.equal(readClients.length, FEEDBACK_READ_MAX);
  assert.ok(!readClients.map((client) => getAddress(client)).includes(rater));
  assert.equal(getAddress(readClients.at(-1)!), clients.at(-1));
});

const stars = (n: number): Stored => ({ value: BigInt(n * 20), tag1: 'starred' });
const notAsked = () => {
  throw new Error('not asked');
};

test('a rater with FEEDBACK_READ_MAX entries never pushes the later raters out of the score', async (t) => {
  // The first rater in registry order holds a full read's worth of entries, the latest 1 star;
  // four later raters gave 5 stars each.
  const early = getAddress(agentWallet(9));
  const honest = [2, 3, 4, 5].map((n) => getAddress(agentWallet(n)));
  const rpc = await mockReputation(t, notAsked, {
    clients: [early, ...honest],
    counts: {
      [early]: BigInt(FEEDBACK_READ_MAX),
      ...Object.fromEntries(honest.map((wallet) => [wallet, 1n])),
    },
    stored: {
      [early]: Array.from({ length: FEEDBACK_READ_MAX }, (_, i) =>
        stars(i === FEEDBACK_READ_MAX - 1 ? 1 : 5),
      ),
      ...Object.fromEntries(honest.map((wallet) => [wallet, [stars(5)]])),
    },
  });
  const raters = new Set([early, ...honest].map((wallet) => wallet.toLowerCase()));
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const got = await reader.feedback!('120', 16n, async () => raters);
  assert.deepEqual(cityScore(got.entries, raters, agentWallet(1)), { average: '4.2', raters: 5 });
  assert.equal(got.ratersSkipped, 0);
  // Each rater's newest entry, once: never all of the early rater's entries.
  assert.equal(rpc.entriesRead.length, 5);
  assert.equal(feedbackCalls(rpc.calls).length, 0);
});

test('a rater walks back at most RATER_ENTRIES_MAX entries to its latest rating, else it is skipped', async (t) => {
  const walker = getAddress(agentWallet(2));
  const noisy = getAddress(agentWallet(3));
  const filler = outsider(1);
  const rpc = await mockReputation(
    t,
    () =>
      encodeFunctionResult({
        abi: reputationReadAbi,
        functionName: 'readAllFeedback',
        result: [[], [], [], [], [], [], []],
      }),
    {
      clients: [walker, noisy, filler],
      counts: { [walker]: 3n, [noisy]: 5n, [filler]: BigInt(FEEDBACK_READ_MAX) },
      stored: {
        // Its 4 stars, then a revoked rating and a note: the 4 stars still count.
        [walker]: [stars(4), { ...stars(1), revoked: true }, { value: 1n, tag1: 'note' }],
        // Its rating sits behind more notes than the walk reads: skipped, never an older one.
        [noisy]: [stars(2), ...Array.from({ length: 4 }, () => ({ value: 1n, tag1: 'note' }))],
      },
    },
  );
  const raters = new Set([walker, noisy].map((wallet) => wallet.toLowerCase()));
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const got = await reader.feedback!('120', 16n, async () => raters);
  assert.deepEqual(cityScore(got.entries, raters), { average: '4.0', raters: 1 });
  assert.equal(got.ratersSkipped, 1);
  assert.equal(rpc.entriesRead.filter(([client]) => client === noisy).length, RATER_ENTRIES_MAX);
});

test('oversized tags: a read too large to answer whole still yields the score', async (t) => {
  const big = getAddress(agentWallet(2));
  const fine = getAddress(agentWallet(3));
  const rpc = await mockReputation(
    t,
    () => {
      // Every readAllFeedback is too large for the node (oversized tags).
      throw new OutOfGas();
    },
    {
      clients: [big, fine, outsider(1)],
      counts: { [big]: 2n, [fine]: 1n, [outsider(1)]: 3n },
      stored: {
        // Its newest entry is too large to read: skipped, its older rating does not stand in.
        [big]: [stars(1), { ...stars(5), huge: true }],
        [fine]: [stars(3)],
      },
    },
  );
  const raters = new Set([big, fine].map((wallet) => wallet.toLowerCase()));
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const got = await reader.feedback!('120', 16n, async () => raters);
  assert.equal(got.bounded, true);
  assert.equal(got.ratersSkipped, 1);
  assert.equal(got.total, 6);
  assert.deepEqual(cityScore(got.entries, raters), { average: '3.0', raters: 1 });
  // The whole read, then the outsider alone: asked again smaller, never in a loop.
  assert.equal(feedbackCalls(rpc.calls).length, 2);
});

/*
 * The registry's own selectors and one readFeedback answer, as Base Sepolia's Reputation
 * Registry (0x8004B663…8713) answered them read only at block 50105770: agent 1, client
 * 0xE725…7Ea1, index 4. A wrong signature here would make every rater's read fail.
 */
const READ_FEEDBACK_SELECTOR = '0x232b0810';
const SEPOLIA_READ_FEEDBACK_ANSWER: Hex =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000b72656c696162696c6974790000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008746573742d72756e000000000000000000000000000000000000000000000000';

test("the feedback reads use the deployed registry's selectors and answer layout", () => {
  const selector = (
    abi: Parameters<typeof encodeFunctionData>[0]['abi'],
    functionName: string,
    args: unknown[],
  ) => encodeFunctionData({ abi, functionName, args } as never).slice(0, 10);
  const client = '0xE7251742c6f4F8849600d44c6aed62e07DaA7Ea1';
  assert.equal(
    selector(reputationEntryAbi, 'readFeedback', [1n, client, 4n]),
    READ_FEEDBACK_SELECTOR,
  );
  assert.equal(
    selector(reputationReadAbi, 'readAllFeedback', [1n, [], '', '', false]),
    '0xd9d84224',
  );
  assert.equal(selector(reputationClientsAbi, 'getClients', [1n]), '0x42dd519c');
  assert.equal(selector(reputationClientsAbi, 'getLastIndex', [1n, client]), '0xf2d81759');
  assert.deepEqual(
    decodeFunctionResult({
      abi: reputationEntryAbi,
      functionName: 'readFeedback',
      data: SEPOLIA_READ_FEEDBACK_ANSWER,
    }),
    [-20n, 0, 'reliability', 'test-run', true],
  );
});

test('a registry without readFeedback rejects the bounded read, never a score from nobody', async (t) => {
  const raters = [2, 3, 4].map((n) => getAddress(agentWallet(n)));
  const rpc = await mockReputation(t, notAsked, {
    clients: raters,
    counts: Object.fromEntries(raters.map((wallet) => [wallet, BigInt(FEEDBACK_READ_MAX)])),
    noReadFeedback: true,
  });
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const preferred = new Set(raters.map((wallet) => wallet.toLowerCase()));
  await assert.rejects(reader.feedback!('120', 16n, async () => preferred));
  // One round of reads, nothing older asked.
  assert.equal(rpc.entriesRead.length, raters.length);
});

test('a node error that is not about size is an outage: one call per part, the read rejects', async (t) => {
  const raters = Array.from({ length: 250 }, (_, i) =>
    getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`),
  );
  const rpc = await mockReputation(t, notAsked, {
    clients: raters,
    counts: Object.fromEntries(raters.map((wallet) => [wallet, 2n])),
    entriesError: { code: -32603, message: 'internal error' },
  });
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  const preferred = new Set(raters.map((wallet) => wallet.toLowerCase()));
  await assert.rejects(reader.feedback!('120', 16n, async () => preferred));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(rpc.entryCalls, [100, 100, 50]);
  // A lagging node ("header not found") is no reason to split either.
  const lagging = await mockReputation(t, notAsked, {
    clients: raters,
    counts: Object.fromEntries(raters.map((wallet) => [wallet, 2n])),
    entriesError: { code: -32000, message: 'header not found' },
  });
  await assert.rejects(
    baseChainReader(lagging.url, 8453, REGISTRY, 3_000, REPUTATION).feedback!(
      '120',
      16n,
      async () => preferred,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(lagging.entryCalls, [100, 100, 50]);
});

test('an answer too large is asked again in halves, within FEEDBACK_SPLIT_CALLS_MAX', async (t) => {
  const raters = Array.from({ length: 150 }, (_, i) =>
    getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`),
  );
  const big = raters[7]!;
  const preferred = new Set(raters.map((wallet) => wallet.toLowerCase()));
  // One rater's entry too large: only that rater is skipped, the rest score.
  const one = await mockReputation(t, notAsked, {
    clients: raters,
    counts: Object.fromEntries(raters.map((wallet) => [wallet, 2n])),
    stored: Object.fromEntries(
      raters.map((wallet) => [
        wallet,
        [stars(1), wallet === big ? { ...stars(5), huge: true } : stars(5)],
      ]),
    ),
    hugeFailsWhole: true,
  });
  const got = await baseChainReader(one.url, 8453, REGISTRY, 3_000, REPUTATION).feedback!(
    '120',
    16n,
    async () => preferred,
  );
  assert.equal(got.ratersSkipped, 1);
  assert.deepEqual(cityScore(got.entries, preferred), { average: '5.0', raters: 149 });
  assert.ok(one.entryCalls.length - 2 <= FEEDBACK_SPLIT_CALLS_MAX);
  // Every part too large: the halves stop at the bound, and with no rater read the read rejects.
  const all = await mockReputation(t, notAsked, {
    clients: raters,
    counts: Object.fromEntries(raters.map((wallet) => [wallet, 2n])),
    entriesError: { code: -32000, message: 'out of gas' },
  });
  await assert.rejects(
    baseChainReader(all.url, 8453, REGISTRY, 3_000, REPUTATION).feedback!(
      '120',
      16n,
      async () => preferred,
    ),
  );
  assert.equal(all.entryCalls.length, 2 + FEEDBACK_SPLIT_CALLS_MAX);
});

test('a client list Base cannot answer: the rater wallets in the records are read instead', async (t) => {
  const rater = getAddress(agentWallet(2));
  const formerRater = getAddress(agentWallet(7));
  const rpc = await mockReputation(
    t,
    (args) => {
      // The former rater is no longer a rater: read as any other client.
      assert.deepEqual(args, [120n, [formerRater], '', '', false]);
      return encodeFunctionResult({
        abi: reputationReadAbi,
        functionName: 'readAllFeedback',
        result: [[formerRater], [1n], [20n], [0], ['starred'], [''], [false]],
      });
    },
    {
      clients: [],
      clientsFail: true,
      counts: { [rater]: 1n, [formerRater]: 1n },
      stored: { [rater]: [stars(5)], [formerRater]: [stars(1)] },
    },
  );
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  let preferred: readonly string[] = [];
  const got = await reader.feedback!(
    '120',
    16n,
    async (clients) => {
      preferred = clients;
      // Only current raters count: the former one is no longer a listed agent.
      return new Set([rater.toLowerCase()]);
    },
    async () => [rater.toLowerCase(), formerRater.toLowerCase()],
  );
  assert.deepEqual(preferred, [rater, formerRater]);
  assert.equal(got.bounded, true);
  assert.deepEqual(cityScore(got.entries, [rater]), { average: '5.0', raters: 1 });
  // Without the records' raters it rejects as before (never "no feedback").
  await assert.rejects(reader.feedback!('120', 16n));
});

test('a client list too slow to answer: the read goes on with the records within the time', async (t) => {
  const rater = getAddress(agentWallet(2));
  const rpc = await mockReputation(t, notAsked, {
    clients: [rater],
    counts: { [rater]: 1n },
    stored: { [rater]: [stars(4)] },
    clientsDelayMs: CLIENTS_READ_MS + 500,
  });
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 5_000, REPUTATION);
  const started = Date.now();
  const got = await reader.feedback!(
    '120',
    16n,
    async (clients) => new Set(clients.map((client) => client.toLowerCase())),
    async () => [rater.toLowerCase()],
  );
  assert.ok(Date.now() - started < CLIENTS_READ_MS + 400);
  assert.equal(got.bounded, true);
  assert.deepEqual(cityScore(got.entries, [rater]), { average: '4.0', raters: 1 });
});

test('the passport asks for its rater wallets first and counts every entry on Base', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  const star = read(agentWallet(2), 1, 100n, 0, ['starred', '']);
  const base = fakeBase({ '120': [star, read(outsider(1), 1, 1n)] });
  const chain: OnBaseChainReader = {
    ...base.chain,
    async feedback(baseId, block, prefer) {
      const answer = await base.chain.feedback!(baseId, block, prefer);
      // Most of it left out by the bound: the count is Base's, not the entries read.
      return { ...answer, total: 50_000, bounded: true };
    },
  };
  const reputation = (
    (
      await routes(t, db, chain).inject({ url: '/api/public/base/agents/120' })
    ).json() as OnBasePassport
  ).reputation;
  assert.deepEqual(base.state.preferred, new Set([agentWallet(2).toLowerCase()]));
  assert.equal(reputation.count, 50_000);
  assert.deepEqual(reputation.score, { average: '5.0', raters: 1 });
});

test('the passport says when not every entry or rater was read, and offers the recorded raters', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  await addRating(db, { id: 'r1', rater: 2, baseId: 120, rated: 1, stars: 5 });
  // Not final on Base: never offered.
  await addRating(db, { id: 'r2', rater: 1, baseId: 120, rated: 1, stars: 5, status: 'submitted' });
  let recorded: readonly string[] = [];
  const base = fakeBase({ '120': [read(agentWallet(2), 1, 100n, 0, ['starred', ''])] });
  const chain: OnBaseChainReader = {
    ...base.chain,
    async feedback(baseId, block, prefer, known) {
      recorded = await known!();
      const answer = await base.chain.feedback!(baseId, block, prefer);
      return { ...answer, bounded: true, ratersSkipped: 2 };
    },
  };
  const reputation = (
    (
      await routes(t, db, chain).inject({ url: '/api/public/base/agents/120' })
    ).json() as OnBasePassport
  ).reputation;
  assert.deepEqual(recorded, [agentWallet(2).toLowerCase()]);
  assert.equal(reputation.bounded, true);
  assert.equal(reputation.ratersSkipped, 2);
  assert.deepEqual(reputation.score, { average: '5.0', raters: 1 });
});

test('a feedback answer whose lists disagree in length is rejected, never half read', async (t) => {
  const rpc = await mockReputation(
    t,
    () =>
      encodeFunctionResult({
        abi: reputationReadAbi,
        functionName: 'readAllFeedback',
        result: [[outsider(1)], [1n, 2n], [1n], [0], [''], [''], [false]],
      }),
    { clients: [outsider(1)], counts: { [outsider(1)]: 2n } },
  );
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  await assert.rejects(reader.feedback!('120', 16n), /Malformed feedback answer/);
});

test('records the passport cannot read in time: Base entries, unnamed, scoreUnread, never a hang', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Meridian' });
  const base = fakeBase({ '120': [read(agentWallet(2), 1, 100n, 0, ['starred', ''])] });
  // The rater-name read fails inside Postgres, as a statement timeout would.
  const slow: Database = {
    ...db,
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          ...tx,
          query: ((sql: string, params?: unknown[]) =>
            /WITH hit AS/.test(sql)
              ? tx.query('SELECT 1 FROM no_such_table_for_the_records', [])
              : tx.query(sql, params as never)) as Database['query'],
        }),
      ),
  };
  const app = routes(t, slow, base.chain);
  const answer = await app.inject({ url: '/api/public/base/agents/120' });
  assert.equal(answer.statusCode, 200);
  const passport = answer.json() as OnBasePassport;
  assert.deepEqual(passport.reputation, {
    readAtBlock: 40,
    readAt: NOW,
    count: 1,
    entries: [{ client: getAddress(agentWallet(2)), index: 1, from: null, score: '100', tags: [] }],
    score: null,
    scoredBy: [],
    scoreUnread: true,
  });
});

test('a spender address is asked for in both stored forms, lower case and checksummed', async () => {
  const { spenderForms } = await import('../server/base/explorer/store.js');
  const mixed = '0x524c827cd1D5691817706763FB67574d107578B1';
  assert.deepEqual(spenderForms([mixed, mixed.toLowerCase(), 'not an address']), [
    mixed.toLowerCase(),
    getAddress(mixed),
  ]);
});
