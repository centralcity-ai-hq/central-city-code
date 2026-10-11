import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import Fastify from 'fastify';
import { decodeFunctionData, encodeFunctionResult, getAddress, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import { FEEDBACK_TAG_MAX, registerOnBaseRoutes } from '../server/base/explorer/routes.js';
import {
  baseChainReader,
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
  const state = { block: 40n, down: false, feedbackReads: 0, feedback };
  const chain: OnBaseChainReader = {
    async head() {
      if (state.down) throw new Error('down');
      return { block: state.block };
    },
    async owners(ids) {
      return new Map(ids.map((id) => [id, null]));
    },
    async feedback(baseId, block) {
      state.feedbackReads++;
      if (state.down) throw new Error('down');
      assert.equal(block, state.block);
      return state.feedback[baseId] ?? [];
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

/** A local JSON-RPC stand-in answering readAllFeedback (no network). */
async function mockReputation(
  t: { after: (fn: () => Promise<unknown>) => void },
  answer: (args: readonly unknown[]) => Hex,
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      calls.push(call);
      const result = (value: unknown) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: value }));
      };
      if (call.method === 'eth_chainId') return result('0x2105');
      const [tx] = call.params as [{ to: string; data: Hex }];
      assert.equal(getAddress(tx.to), getAddress(REPUTATION));
      const { args } = decodeFunctionData({ abi: reputationReadAbi, data: tx.data });
      return result(answer(args));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('the Base reader reads all feedback of an id at one block and leaves revoked entries out', async (t) => {
  const a = outsider(1);
  const b = outsider(2);
  const rpc = await mockReputation(t, (args) => {
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
  });
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  assert.deepEqual(await reader.feedback?.('120', 16n), [
    read(a, 1, 1n, 0, ['research', '']),
    read(b, 2n ** 53n + 1n, 8725n, 2, ['x', 'y']),
  ]);
  const ethCall = rpc.calls.find((call) => call.method === 'eth_call')!;
  assert.equal(ethCall.params[1], '0x10');

  // Without a reputation registry there is no feedback read at all.
  assert.equal(baseChainReader(rpc.url, 8453, REGISTRY).feedback, undefined);
});

test('a feedback answer whose lists disagree in length is rejected, never half read', async (t) => {
  const rpc = await mockReputation(t, () =>
    encodeFunctionResult({
      abi: reputationReadAbi,
      functionName: 'readAllFeedback',
      result: [[outsider(1)], [1n, 2n], [1n], [0], [''], [''], [false]],
    }),
  );
  const reader = baseChainReader(rpc.url, 8453, REGISTRY, 3_000, REPUTATION);
  await assert.rejects(reader.feedback!('120', 16n), /Malformed feedback answer/);
});
