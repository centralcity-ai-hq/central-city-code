import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import Fastify from 'fastify';
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  type Hex,
} from 'viem';
import type { Database } from '../server/database.js';
import { createApp } from '../server/app.js';
import {
  NO_OWNER,
  ON_BASE_LIST_LIVE,
  ON_BASE_LIST_LIVE_EDGE,
  ON_BASE_LIVE,
  ON_BASE_LIVE_EDGE,
  ON_BASE_NOT_FOUND,
  registerOnBaseRoutes,
} from '../server/base/explorer/routes.js';
import { RATED_AGENTS_SQL, parseQuery } from '../server/base/explorer/store.js';
import {
  MULTICALL3,
  baseChainReader,
  type OnBaseChainReader,
} from '../server/base/explorer/head.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
import { SHORT_URI_ORIGIN } from '../shared/base/short-id.js';
import {
  AGENT_URI_ORIGIN,
  ON_BASE_PAGE_SIZE,
  type OnBaseList,
  type OnBasePassport,
} from '../shared/base/on-base.js';
import {
  MIN,
  NOW,
  REGISTRY,
  SEPOLIA_REGISTRY,
  add,
  addOp,
  addRating,
  agentId,
  agentWallet,
  handoverTx,
  mintTx,
  ownerWallet,
  registerOpKey,
  setup,
  shortOf,
  spender,
} from './on-base-fixture.js';

function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  db: Database,
  options: { now?: () => number; chain?: OnBaseChainReader } = {},
) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now: options.now ?? (() => NOW), chain: options.chain });
  return app;
}

/** A Base stand-in: a head block, and ownerOf per id (missing ids revert). Counts its reads. */
function fakeBase(initial: { block: bigint; owners: Record<string, string> }) {
  const state = { ...initial, down: false, heads: 0, ownerReads: [] as string[][] };
  const chain: OnBaseChainReader = {
    async head() {
      state.heads++;
      if (state.down) throw new Error('down');
      return { block: state.block };
    },
    async owners(ids, block) {
      state.ownerReads.push([...ids]);
      if (state.down) throw new Error('down');
      assert.equal(block, state.block);
      return new Map(ids.map((id) => [id, state.owners[id] ?? null]));
    },
  };
  return { state, chain };
}

/** The longest any shared cache may serve a copy (fresh + stale), from a Cache-Control value. */
function staleBound(value: string, freshKey: 'max-age' | 's-maxage') {
  const field = (key: string) => Number(new RegExp(`${key}=(\\d+)`).exec(value)?.[1] ?? 0);
  return field(freshKey) + field('stale-while-revalidate');
}

test('the agent URI origin matches the one the identity service writes on chain', () => {
  assert.equal(AGENT_URI_ORIGIN, SHORT_URI_ORIGIN);
});

test('the list shows only registrations Central City sent and saw on Base, newest first', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'finalizing', id: 130, name: 'Fable', seenAt: NOW - 6 * MIN });
  await add(db, { n: 3, kind: 'final', id: 110, name: 'Gone', revoked: true });
  await add(db, { n: 4, kind: 'final', id: 100, name: 'Hidden', visibility: 'private' });
  // Never listed or counted:
  await add(db, { n: 5, kind: 'included', id: 140 }); // hand-over not yet safe
  await add(db, { n: 6, kind: 'pending' }); // still registering
  await add(db, { n: 7, kind: 'failed' });
  await add(db, { n: 8, kind: 'final', id: 150, registry: SEPOLIA_REGISTRY }); // another registry
  await add(db, { n: 9, kind: 'final', id: 160, uri: 'https://example.com/a/S00009' }); // not our URI
  await add(db, { n: 10, kind: 'final', id: 170, chainId: 84532 }); // another network
  await add(db, { n: 11, kind: 'lost', id: 180 }); // mint receipt missing now
  await add(db, { n: 12, kind: 'final', id: 190, shortId: false }); // no short id
  await add(db, { n: 13, kind: 'final', id: 200, seenAt: null }); // mint never seen on Base
  await add(db, { n: 14, kind: 'final', id: 90, seenAt: NOW - 30 * 60 * MIN }); // older than 24 h

  const app = routes(t, db);
  const response = await app.inject({ url: '/api/public/base/agents' });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OnBaseList;
  assert.deepEqual(
    body.rows.map((row) => row.baseId),
    ['130', '120', '110', '100', '90'],
  );
  assert.deepEqual(body.rows[0], {
    baseId: '130',
    name: 'Fable',
    owner: getAddress(agentWallet(2)),
    short: shortOf(2),
    mintTx: mintTx(2),
    status: 'finalizing',
    finalizingSince: NOW - 6 * MIN,
    score: null,
  });
  assert.deepEqual(body.rows[1], {
    baseId: '120',
    name: 'Harbor',
    owner: getAddress(agentWallet(1)),
    short: shortOf(1),
    mintTx: mintTx(1),
    status: 'final',
    score: null,
  });
  assert.equal('finalizingSince' in body.rows[1], false);
  // The exact keys of the client contract, in its order.
  assert.deepEqual(Object.keys(body), ['rows', 'totals', 'registry', 'nextBefore']);
  assert.deepEqual(Object.keys(body.rows[1]), [
    'baseId',
    'name',
    'owner',
    'short',
    'mintTx',
    'status',
    'score',
  ]);
  // Names are Central City metadata, only while the card is public; no colour is published.
  assert.equal(body.rows[2].name, '');
  assert.equal(body.rows[3].name, '');
  assert.ok(body.rows.every((row) => !('colour' in row)));
  assert.deepEqual(body.totals, {
    onBase: 5,
    new24h: 4,
    finalizingNow: 1,
    ratedAgents: 0,
    // No Base reader: Central City's records, as old as the oldest of them.
    readAtBlock: 1005 + 1,
    readAt: NOW - 5 * MIN,
    servedAt: NOW,
  });
  assert.equal(body.registry, REGISTRY);
  assert.equal(body.nextBefore, null);

  // Privacy: no agent id, owner wallet, registration account, key reference or workspace id.
  const text = response.body.toLowerCase();
  for (const n of [1, 2, 3, 4])
    for (const secret of [agentId(n), ownerWallet(n), spender(n)])
      assert.equal(text.includes(secret.toLowerCase()), false, secret);
  assert.equal(text.includes('v1:key'), false);
  assert.equal(text.includes('"ws"'), false);

  // The list: an HTTP copy at most 60 s old in shared caches (fresh 10 s, then served while it
  // refreshes); browsers always revalidate. A passport keeps the 15 s bound.
  assert.equal(response.headers['cache-control'], ON_BASE_LIST_LIVE);
  assert.equal(response.headers['vercel-cdn-cache-control'], ON_BASE_LIST_LIVE_EDGE);
  assert.match(ON_BASE_LIST_LIVE, /(^|, )max-age=0(,|$)/);
  assert.ok(staleBound(ON_BASE_LIST_LIVE, 's-maxage') <= 60);
  assert.ok(staleBound(ON_BASE_LIST_LIVE_EDGE, 'max-age') <= 60);
  assert.ok(staleBound(ON_BASE_LIVE, 's-maxage') <= 15);
  assert.ok(staleBound(ON_BASE_LIVE_EDGE, 'max-age') <= 15);
});

test('finalizing stays listed after the mint goes final and its id is stored, until confirmed', async (t) => {
  // The product owner's live check, 11 Oct: the agent vanished between finalizing and final. The identity
  // service stores the final id as soon as the mint is final, while the hand-over still settles.
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'finalizing', id: 130, name: 'Loner', finalIdStored: true });
  const app = routes(t, db);
  const list = (await app.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;
  assert.deepEqual(
    list.rows.map((row) => [row.baseId, row.status]),
    [
      ['130', 'finalizing'],
      ['120', 'final'],
    ],
  );
  assert.equal(list.totals.onBase, 2);
  assert.equal(list.totals.finalizingNow, 1);
  const one = await app.inject({ url: '/api/public/base/agents/130' });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as { status: string }).status, 'finalizing');
  // A stored final id that isn't the minted one can't exist: the schema refuses it.
  await assert.rejects(
    db.query(`UPDATE base_identities SET erc8004_agent_id = 999 WHERE provisional_agent_id = 130`),
    /base_identities_final_id_matches/,
  );
});

test('pages follow ?before= without gaps or repeats', async (t) => {
  const db = await setup(t);
  const total = ON_BASE_PAGE_SIZE * 2 + 1;
  for (let n = 1; n <= total; n++) await add(db, { n, kind: 'final', id: 5000 + n });
  const app = routes(t, db);
  const seen: string[] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const url: string = `/api/public/base/agents${before ? `?before=${before}` : ''}`;
    const body = (await app.inject({ url })).json() as OnBaseList;
    seen.push(...body.rows.map((row) => row.baseId));
    before = body.nextBefore;
    pages++;
    assert.equal(body.totals.onBase, total);
  } while (before && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(
    seen,
    Array.from({ length: total }, (_, index) => String(5000 + total - index)),
  );
});

test('search finds Base IDs, short ids, agent wallets, transactions and current public names', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  await add(db, { n: 2, kind: 'finalizing', id: 130, name: 'Fable' });
  await add(db, { n: 3, kind: 'final', id: 110, name: 'Secret', visibility: 'private' });
  await add(db, { n: 4, kind: 'final', id: 105, name: 'Newname', formerNames: ['Oldname'] });
  await add(db, { n: 5, kind: 'final', id: 101, name: '100% Agent' });
  await add(db, { n: 6, kind: 'final', id: 150, registry: SEPOLIA_REGISTRY, name: 'Harbor two' });
  const app = routes(t, db);
  const ids = async (q: string) => {
    const response = await app.inject({
      url: `/api/public/base/agents?q=${encodeURIComponent(q)}`,
    });
    assert.equal(response.statusCode, 200, q);
    return ((response.json() as OnBaseList).rows ?? []).map((row) => row.baseId);
  };
  assert.deepEqual(await ids('120'), ['120']);
  assert.deepEqual(await ids('#130'), ['130']);
  assert.deepEqual(await ids(shortOf(1)), ['120']);
  assert.deepEqual(await ids(`CC-${shortOf(2)}`), ['130']);
  assert.deepEqual(await ids(agentWallet(1).toUpperCase().replace('0X', '0x')), ['120']);
  assert.deepEqual(await ids(mintTx(2)), ['130']);
  assert.deepEqual(await ids(handoverTx(1)), ['120']);
  assert.deepEqual(await ids('harb'), ['120']);
  assert.deepEqual(await ids('  FABLE '), ['130']);
  // Only the current public name: never a private one or a former one.
  assert.deepEqual(await ids('Secret'), []);
  assert.deepEqual(await ids('Oldname'), []);
  assert.deepEqual(await ids('Newname'), ['105']);
  // LIKE wildcards are literal.
  assert.deepEqual(await ids('0%'), ['101']);
  assert.deepEqual(await ids('%%'), []);
  // The owner's own wallet is not published, so it is not searchable either.
  assert.deepEqual(await ids(ownerWallet(1)), []);
  // Never a row the list does not show.
  assert.deepEqual(await ids('150'), []);
  assert.deepEqual(await ids('Harbor two'), []);

  assert.deepEqual(parseQuery('cc-Ab12Cd').shortId, 'Ab12Cd');
  assert.equal(parseQuery('0x12').name, null);
  assert.equal(parseQuery('a\u0000b').name, '%a b%', 'a NUL never reaches the LIKE parameter');
});

test('a passport carries the chain facts and Central City records of one listed agent', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor', updatedAt: NOW - 3 * MIN });
  await add(db, { n: 2, kind: 'finalizing', id: 130, name: 'Fable', seenAt: NOW - 6 * MIN });
  await add(db, { n: 3, kind: 'final', id: 110, mintBlock: null, handoverBlock: null });
  await add(db, { n: 4, kind: 'final', id: 150, registry: SEPOLIA_REGISTRY });
  const app = routes(t, db);

  const final = await app.inject({ url: '/api/public/base/agents/120' });
  assert.equal(final.statusCode, 200);
  assert.deepEqual(final.json() as OnBasePassport, {
    baseId: '120',
    name: 'Harbor',
    owner: getAddress(agentWallet(1)),
    short: shortOf(1),
    mintTx: mintTx(1),
    status: 'final',
    registry: REGISTRY,
    agentWallet: getAddress(agentWallet(1)),
    mintAccount: getAddress(spender(1)),
    registrationTx: mintTx(1),
    registeredAt: NOW - 10 * MIN,
    final: { block: 1006, at: NOW - 3 * MIN },
    // No Base reader here: not read, which is never "no feedback".
    reputation: {
      readAtBlock: null,
      readAt: null,
      count: 0,
      entries: [],
      score: null,
      scoredBy: [],
    },
  });
  assert.equal(final.headers['cache-control'], ON_BASE_LIVE);
  assert.equal(final.body.toLowerCase().includes(ownerWallet(1).toLowerCase()), false);

  const pending = await app.inject({ url: '/api/public/base/agents/130' });
  const passport = pending.json() as OnBasePassport;
  assert.equal(passport.status, 'finalizing');
  assert.equal(passport.final, null);
  assert.equal(passport.finalizingSince, NOW - 6 * MIN);
  assert.equal(pending.headers['cache-control'], ON_BASE_LIVE);

  // A row from before blocks were kept: final, without a block.
  const legacy = (await app.inject({ url: '/api/public/base/agents/110' })).json();
  assert.deepEqual(legacy.final, { block: null, at: NOW - 5 * MIN });

  for (const url of [
    '/api/public/base/agents/150', // not listed (another registry)
    '/api/public/base/agents/abc',
    `/api/public/base/agents/${shortOf(1)}`, // a short id is never resolved here
    `/api/public/base/agents/${'1'.repeat(79)}`,
  ]) {
    const missing = await app.inject({ url });
    assert.equal(missing.statusCode, 404, url);
    assert.equal(missing.headers['cache-control'], ON_BASE_NOT_FOUND, url);
  }
  for (const url of [
    '/api/public/base/agents/120?x=1',
    '/api/public/base/agents?cursor=1',
    `/api/public/base/agents?q=${'x'.repeat(81)}`,
  ]) {
    const bad = await app.inject({ url });
    assert.equal(bad.statusCode, 400, url);
    assert.equal(bad.headers['cache-control'], 'no-store', url);
  }
});

test('owner is ownerOf as the server read it at readAtBlock, never the person', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, updatedAt: NOW - 50 * MIN });
  await add(db, { n: 2, kind: 'final', id: 121, updatedAt: NOW - 50 * MIN });
  await add(db, { n: 3, kind: 'final', id: 122, updatedAt: NOW - 50 * MIN });
  // On Base: 120 still with its agent wallet, 121 moved on by its holder, 122 unknown (reverts).
  const moved = getAddress(`0x${'7'.repeat(40)}`);
  const base = fakeBase({ block: 52_431_207n, owners: { '120': agentWallet(1), '121': moved } });
  let clock = NOW;
  const app = routes(t, db, { now: () => clock, chain: base.chain });
  const list = async () =>
    (await app.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;

  const first = await list();
  assert.deepEqual(
    first.rows.map((row) => [row.baseId, row.owner]),
    [
      ['122', NO_OWNER],
      ['121', moved],
      ['120', getAddress(agentWallet(1))],
    ],
  );
  assert.deepEqual(first.totals, {
    onBase: 3,
    new24h: 3,
    finalizingNow: 0,
    ratedAgents: 0,
    readAtBlock: 52_431_207,
    readAt: NOW,
    servedAt: NOW,
  });
  // Never the person's own wallet.
  for (const n of [1, 2, 3])
    assert.equal(JSON.stringify(first).toLowerCase().includes(ownerWallet(n).toLowerCase()), false);
  // One head read and one ownerOf read for the page; a request within HEAD_TTL_MS reads nothing.
  await list();
  assert.equal(base.state.heads, 1);
  assert.deepEqual(base.state.ownerReads, [['122', '121', '120']]);

  // The passport names the same owner, read the same way.
  const passport = (await app.inject({ url: '/api/public/base/agents/121' })).json();
  assert.equal(passport.owner, moved);
  assert.equal(passport.agentWallet, getAddress(agentWallet(2)));

  // A new block: the page is read again at it.
  clock = NOW + 6_000;
  base.state.block = 52_431_210n;
  base.state.owners['121'] = agentWallet(2);
  const second = await list();
  assert.equal(second.rows[1].owner, getAddress(agentWallet(2)));
  assert.deepEqual(
    [second.totals.readAtBlock, second.totals.readAt, second.totals.servedAt],
    [52_431_210, NOW + 6_000, NOW + 6_000],
  );

  // Base stops answering: the last reads, with their own (old) block and time, never a fresh one.
  base.state.down = true;
  clock = NOW + 90_000;
  const stale = await list();
  assert.equal(stale.rows[1].owner, getAddress(agentWallet(2)));
  assert.equal(stale.totals.readAtBlock, 52_431_210);
  assert.equal(stale.totals.readAt, NOW + 6_000);
  assert.equal(stale.totals.servedAt, NOW + 90_000);
  assert.ok(stale.totals.servedAt - stale.totals.readAt! > 60_000);
});

test('without any Base answer, owners and readAt are the records, as old as they are', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, updatedAt: NOW - 50 * MIN });
  await add(db, { n: 2, kind: 'finalizing', id: 121, updatedAt: NOW - 2 * MIN });
  const base = fakeBase({ block: 1n, owners: {} });
  base.state.down = true;
  const app = routes(t, db, { chain: base.chain });
  const body = (await app.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;
  assert.deepEqual(
    body.rows.map((row) => row.owner),
    [getAddress(agentWallet(2)), getAddress(agentWallet(1))],
  );
  // The oldest record in the answer: its block and the time it was recorded.
  assert.equal(body.totals.readAtBlock, 1005 + 1);
  assert.equal(body.totals.readAt, NOW - 50 * MIN);

  const empty = routes(t, await setup(t), { chain: base.chain });
  const none = (await empty.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;
  assert.deepEqual(none.totals, {
    onBase: 0,
    new24h: 0,
    finalizingNow: 0,
    ratedAgents: 0,
    readAtBlock: null,
    readAt: null,
    servedAt: NOW,
  });
  assert.deepEqual(none.rows, []);
});

type EthCallMode = 'ok' | 'http500' | 'rpcInternal' | 'rpcReverted' | 'malformed' | 'badEntry';

/** A local JSON-RPC stand-in for Base (no network): head, and ownerOf through aggregate3. */
async function mockBase(t: { after: (fn: () => Promise<unknown>) => void }) {
  const state = {
    chain: '0x2105',
    block: 16,
    owners: { '120': agentWallet(1), '121': agentWallet(2) } as Record<string, string>,
    mode: 'ok' as EthCallMode,
    calls: [] as Array<{ method: string; params: unknown[] }>,
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      state.calls.push(call);
      const send = (body: unknown, status = 200) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      };
      const result = (value: unknown) => send({ jsonrpc: '2.0', id: call.id, result: value });
      const error = (code: number, message: string, data?: string) =>
        send({ jsonrpc: '2.0', id: call.id, error: { code, message, ...(data ? { data } : {}) } });
      if (call.method === 'eth_chainId') return result(state.chain);
      if (call.method === 'eth_blockNumber') return result(`0x${state.block.toString(16)}`);
      if (call.method !== 'eth_call') return error(-32601, 'method not found');
      if (state.mode === 'http500') return send({ error: 'upstream down' }, 500);
      if (state.mode === 'rpcInternal') return error(-32603, 'internal error');
      if (state.mode === 'rpcReverted') return error(3, 'execution reverted', '0x');
      if (state.mode === 'malformed') return result('0x1234');
      const [tx] = call.params as [{ to: string; data: Hex }];
      assert.equal(getAddress(tx.to), MULTICALL3);
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
      const inner = args[0] as ReadonlyArray<{ target: string; callData: Hex }>;
      return result(
        encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: inner.map((item) => {
            assert.equal(getAddress(item.target), REGISTRY);
            const id = String(
              decodeFunctionData({ abi: identityRegistryAbi, data: item.callData }).args[0],
            );
            const owner = state.owners[id];
            if (state.mode === 'badEntry') return { success: true, returnData: '0x12' as Hex };
            // ownerOf of a token the registry does not have reverts (ERC721NonexistentToken).
            return owner
              ? {
                  success: true,
                  returnData: encodeFunctionResult({
                    abi: identityRegistryAbi,
                    functionName: 'ownerOf',
                    result: owner as Hex,
                  }),
                }
              : { success: false, returnData: `0x7e273289${id.padStart(64, '0')}` as Hex };
          }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('the Base reader reads the head and ownerOf at one block, only on the expected network', async (t) => {
  const base = await mockBase(t);
  const reader = baseChainReader(base.url, 8453, REGISTRY);
  assert.deepEqual(await reader.head(), { block: 16n });
  // A per-token revert means no owner for that id only; the others are read as they are.
  assert.deepEqual(
    await reader.owners(['120', '121', '999'], 16n),
    new Map([
      ['120', getAddress(agentWallet(1))],
      ['121', getAddress(agentWallet(2))],
      ['999', null],
    ]),
  );
  // ownerOf is read at the given block, in one call.
  const ethCalls = base.state.calls.filter((call) => call.method === 'eth_call');
  assert.equal(ethCalls.length, 1);
  assert.equal(ethCalls[0].params[1], '0x10');

  base.state.chain = '0x14a34'; // Base Sepolia
  await assert.rejects(baseChainReader(base.url, 8453, REGISTRY).head(), /expected network/);
  await assert.rejects(
    baseChainReader(base.url, 8453, REGISTRY).owners(['120'], 16n),
    /expected network/,
  );
});

test('the reader falls back to a second endpoint when the first does not answer', async (t) => {
  const base = await mockBase(t);
  // Nothing listens on the first endpoint: every read there fails at once.
  const reader = baseChainReader(['http://127.0.0.1:9', base.url], 8453, REGISTRY);
  assert.deepEqual(await reader.head(), { block: 16n });
  assert.deepEqual(
    await reader.owners(['120', '999'], 16n),
    new Map([
      ['120', getAddress(agentWallet(1))],
      ['999', null],
    ]),
  );
  // A failure on every endpoint still rejects; a single URL behaves as before.
  await assert.rejects(
    baseChainReader(['http://127.0.0.1:9', 'http://127.0.0.1:10'], 8453, REGISTRY).head(),
  );
  assert.deepEqual(await baseChainReader(base.url, 8453, REGISTRY).head(), { block: 16n });
});

test('a failed ownerOf read is never "no owner": the reader rejects, the list keeps its old read', async (t) => {
  const base = await mockBase(t);
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, updatedAt: NOW - 50 * MIN });
  await add(db, { n: 2, kind: 'final', id: 121, updatedAt: NOW - 50 * MIN });
  await add(db, { n: 3, kind: 'final', id: 122, updatedAt: NOW - 50 * MIN });
  const reader = baseChainReader(base.url, 8453, REGISTRY);
  let clock = NOW;
  const app = routes(t, db, { now: () => clock, chain: reader });
  const list = async () =>
    (await app.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;

  // Base answers: 122 has no token on the registry (ownerOf reverts), the others have owners.
  const good = await list();
  const owners = [NO_OWNER, getAddress(agentWallet(2)), getAddress(agentWallet(1))];
  assert.deepEqual(
    good.rows.map((row) => row.owner),
    owners,
  );
  assert.deepEqual([good.totals.readAtBlock, good.totals.readAt], [16, NOW]);

  for (const mode of ['http500', 'rpcInternal', 'rpcReverted', 'malformed', 'badEntry'] as const) {
    // The head still answers with a newer block; only the ownerOf read fails.
    base.state.mode = mode;
    base.state.block += 1;
    clock += 6_000;
    await assert.rejects(reader.owners(['120', '121'], BigInt(base.state.block)), mode);
    const after = await list();
    assert.deepEqual(
      after.rows.map((row) => row.owner),
      owners,
      mode,
    );
    // The answer stays as old as the last ownerOf read that answered: the banner can show.
    assert.deepEqual([after.totals.readAtBlock, after.totals.readAt], [16, NOW], mode);
    assert.equal(after.totals.servedAt, clock, mode);
  }

  // Base answers again: the owners are read at the new block, with a fresh time.
  base.state.mode = 'ok';
  base.state.block += 1;
  clock += 6_000;
  const back = await list();
  assert.deepEqual([back.totals.readAtBlock, back.totals.readAt], [base.state.block, clock]);
});

test('mintTx is the transaction that minted, or absent: never the hand-over in its place', async (t) => {
  const db = await setup(t);
  // A row from before migration 85: tx_hash holds the hand-over. Its one final register operation
  // (an earlier attempt failed) is the mint.
  await add(db, { n: 1, kind: 'final', id: 99029, legacy: true });
  await addOp(db, { key: registerOpKey(1), status: 'failed', txHash: mintTx(90) });
  await addOp(db, { key: registerOpKey(1, 1), status: 'final', txHash: mintTx(1) });
  await addOp(db, {
    key: `identity:transfer:8453:${agentId(1)}`,
    kind: 'transfer',
    status: 'final',
    txHash: handoverTx(1),
  });
  // Legacy, no stored register operation: the mint is unknown.
  await add(db, { n: 2, kind: 'final', id: 99030, legacy: true });
  // Legacy, two final register operations (a retry minted a second, unused id): ambiguous.
  await add(db, { n: 3, kind: 'final', id: 99031, legacy: true });
  await addOp(db, { key: registerOpKey(3), status: 'final', txHash: mintTx(91) });
  await addOp(db, { key: registerOpKey(3, 1), status: 'final', txHash: mintTx(92) });
  // Legacy, only another agent's (or another network's) register operation: unknown.
  await add(db, { n: 4, kind: 'final', id: 99032, legacy: true });
  await addOp(db, { key: registerOpKey(5), status: 'final', txHash: mintTx(93) });
  await addOp(db, {
    key: registerOpKey(4, 0, 84532),
    status: 'final',
    txHash: mintTx(94),
    chainId: 84532,
  });
  // A row the identity service verified itself: its stored mint.
  await add(db, { n: 6, kind: 'final', id: 99040 });

  const app = routes(t, db);
  const body = (await app.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;
  const byId = new Map(body.rows.map((row) => [row.baseId, row]));
  assert.equal(byId.get('99029')?.mintTx, mintTx(1));
  for (const id of ['99030', '99031', '99032']) {
    assert.ok(byId.has(id), id); // still listed: a confirmed registration
    assert.equal('mintTx' in byId.get(id)!, false, id);
  }
  assert.equal(byId.get('99040')?.mintTx, mintTx(6));
  // Never the hand-over, anywhere in the answer.
  for (const n of [1, 2, 3, 4]) assert.equal(JSON.stringify(body).includes(handoverTx(n)), false);

  const legacy = (
    await app.inject({ url: '/api/public/base/agents/99029' })
  ).json() as OnBasePassport;
  assert.equal(legacy.mintTx, mintTx(1));
  assert.equal(legacy.registrationTx, mintTx(1));
  assert.deepEqual(legacy.final, { block: null, at: NOW - 5 * MIN });
  const unknown = (
    await app.inject({ url: '/api/public/base/agents/99031' })
  ).json() as OnBasePassport;
  assert.equal('mintTx' in unknown, false);
  assert.equal('registrationTx' in unknown, false);

  // Search finds a legacy row by its mint, and by the hand-over it stored.
  const find = async (q: string) =>
    ((await app.inject({ url: `/api/public/base/agents?q=${q}` })).json() as OnBaseList).rows.map(
      (row) => row.baseId,
    );
  assert.deepEqual(await find(mintTx(1)), ['99029']);
  assert.deepEqual(await find(handoverTx(1)), ['99029']);
  assert.deepEqual(await find(mintTx(91)), []);
});

test("a row's score is the latest FINAL rating of each Central City rater, from the records, in one query", async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor' });
  for (const n of [2, 3, 4, 5]) await add(db, { n, kind: 'final', id: 119 + n });
  await add(db, { n: 6, kind: 'finalizing', id: 130 }); // not a rater: no final Base ID
  await add(db, { n: 7, kind: 'final', id: 126, name: 'Unrated' });
  const rate = (
    id: string,
    rater: number,
    stars: number,
    more: Partial<Parameters<typeof addRating>[1]> = {},
  ) => addRating(db, { id, rater, baseId: 120, rated: 1, stars, ...more });
  // Rater 2: rated 2 stars, then again 5 (a later block): the re-rate replaces the first. A
  // third at the same block with a lower nonce landed before it.
  await rate('r2a', 2, 2, { block: 2000, nonce: 0 });
  await rate('r2b', 2, 5, { block: 2010, nonce: 2 });
  await rate('r2c', 2, 1, { block: 2010, nonce: 1 });
  // Rater 3: 4 stars final; a later 1 star only included (not final yet): still 4.
  await rate('r3a', 3, 4, { block: 2001 });
  await rate('r3b', 3, 1, { block: 2020, status: 'included' });
  // Rater 4: nothing counts. Reverted on Base, failed, signed but its operation not stored.
  await rate('r4a', 4, 1, { block: 2002, reverted: true });
  await rate('r4b', 4, 1, { status: 'failed', block: null });
  await rate('r4c', 4, 1, { status: null });
  // Rater 5: 2 stars; its later rating on another network is not this explorer's.
  await rate('r5a', 5, 2, { block: 2003 });
  await rate('r5b', 5, 5, { block: 3000, chainId: 84532 });
  // Never raters here: a finalizing agent's wallet, and the rated agent itself.
  await rate('r6', 6, 1, { block: 2004 });
  await rate('r1', 1, 1, { block: 2005 });
  // Another agent's rating does not leak into this one's.
  await addRating(db, { id: 'x1', rater: 3, baseId: 121, rated: 2, stars: 4, block: 2006 });

  let ratingReads = 0;
  let ratedCounts = 0;
  const counting: Database = {
    ...db,
    query: ((sql: string, params?: unknown[]) => {
      if (sql === RATED_AGENTS_SQL) ratedCounts++;
      else if (sql.includes('base_wallet_withdrawals')) ratingReads++;
      return db.query(sql, params as never);
    }) as Database['query'],
  };
  const app = routes(t, counting);
  const body = (await app.inject({ url: '/api/public/base/agents' })).json() as OnBaseList;
  const scoreOf = (baseId: string) => body.rows.find((row) => row.baseId === baseId)?.score;
  // 5 (rater 2's latest) + 4 (rater 3's final) + 2 (rater 5) = 11 / 3 = 3.67, shown 3.7.
  assert.deepEqual(scoreOf('120'), { average: '3.7', raters: 3 });
  assert.deepEqual(scoreOf('121'), { average: '4.0', raters: 1 });
  assert.equal(scoreOf('126'), null);
  assert.equal(scoreOf('130'), null);
  assert.equal(scoreOf('122'), null);
  // One query for the whole page of 7 rows, never one per row.
  assert.equal(body.rows.length, 7);
  assert.equal(ratingReads, 1);
  // Rated agents: 120 and 121 have a final rating (on this network); counted once, not per row.
  assert.equal(body.totals.ratedAgents, 2);
  assert.equal(ratedCounts, 1);

  // A search page is scored the same way.
  const found = (
    await app.inject({ url: '/api/public/base/agents?q=Harbor' })
  ).json() as OnBaseList;
  assert.deepEqual(
    found.rows.map((row) => [row.baseId, row.score]),
    [['120', { average: '3.7', raters: 3 }]],
  );

  // The passport keeps its own score, read from Base (none without a chain reader): the list's
  // record-based score is never copied onto it.
  const passport = (
    await app.inject({ url: '/api/public/base/agents/120' })
  ).json() as OnBasePassport;
  assert.equal('score' in passport, false);
  assert.equal(passport.reputation.score, null);
});

test('the app serves the list from its own schema', async () => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  try {
    const response = await app.inject({ url: '/api/public/base/agents' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as OnBaseList;
    assert.deepEqual(body.rows, []);
    assert.equal(body.registry, REGISTRY);
    assert.equal((await app.inject({ url: '/api/public/base/agents/1' })).statusCode, 404);
  } finally {
    await app.close();
  }
});
