import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { getAddress } from 'viem';
import { arcChainIdsMigrations } from '../server/base/arc-chain-ids-schema.js';
import type { BalanceReader } from '../server/base/chain/balances.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SPONSOR_EXPOSURE_SQL,
  BASE_WALLET_LANES_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_ONE_UNSIGNED_SQL,
  BASE_WALLET_PAYMENTS_SQL,
  BASE_WALLET_RATINGS_SQL,
  BASE_WALLET_VAULT_SQL,
  BASE_WALLET_WITHDRAWALS_SAFE_SQL,
  BASE_WALLET_WITHDRAWALS_SQL,
} from '../server/base/schema.js';
import {
  agentChainOf,
  arcBalanceReader,
  NOT_ON_ARC_YET_PREFIX,
  REGISTERED_ELSEWHERE,
  registerBaseWalletRoutes,
  WALLET_CHAIN_ID,
} from '../server/base/wallet/routes.js';
import type { Database } from '../server/database.js';
import type { Address } from '../shared/base/chains.js';
import { FEED_PAY_PATHS } from '../shared/feed-pay.js';
import { ARC_MAINNET, ARC_TESTNET } from '../shared/chains.js';

const BASE_AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const ARC_AGENT = '1a2b3c4d-5b4a-4321-8fed-cba987654321';
const BOTH_AGENT = '2b3c4d5e-5b4a-4321-8fed-cba987654321';
const NEW_AGENT = '3c4d5e6f-5b4a-4321-8fed-cba987654321';
const OUTSIDE_ARC_AGENT = '4d5e6f70-5b4a-4321-8fed-cba987654321';
const WALLET = getAddress(`0x${'1'.repeat(40)}`);
const OWNER = getAddress(`0x${'2'.repeat(40)}`);
const SPENDER = getAddress(`0x${'3'.repeat(40)}`);
const OTHER_OWNER = getAddress(`0x${'4'.repeat(40)}`);
const OTHER_WALLET = getAddress(`0x${'8'.repeat(40)}`);
const NOW = 1_760_000_000_000;

const ARC_OFF = { CITY_BASE_WALLET: '1' };
const ARC_ON = {
  CITY_BASE_WALLET: '1',
  CITY_BASE_MAINNET: '1',
  CITY_BASE_RATE: '1',
  CITY_BASE_LANES: '1',
  CITY_ARC: '1',
  CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
};

/** A reader that writes down every wallet it was asked for. */
function fakeReader(usdc: bigint, eth: bigint) {
  const reads: string[] = [];
  const reader: BalanceReader = {
    balances: async (wallet: Address) => {
      reads.push(wallet);
      return { usdc, eth, deployed: true, blockNumber: 77n };
    },
  };
  return { reader, reads };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES
      ('${BASE_AGENT}', 'person-1', 1, '{}'), ('${ARC_AGENT}', 'person-1', 1, '{}'),
      ('${BOTH_AGENT}', 'person-1', 1, '{}'), ('${NEW_AGENT}', 'person-1', 1, '{}'),
      ('${OUTSIDE_ARC_AGENT}', 'person-1', 1, '{}');`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    BASE_SHARED_ADDITIONS_SQL,
    BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
    BASE_WALLET_VAULT_SQL,
    BASE_WALLET_WITHDRAWALS_SQL,
    BASE_WALLET_LIMITS_SQL,
    BASE_WALLET_PAYMENTS_SQL,
    BASE_WALLET_RATINGS_SQL,
    BASE_WALLET_ONE_UNSIGNED_SQL,
    BASE_WALLET_LANES_SQL,
    BASE_WALLET_WITHDRAWALS_SAFE_SQL,
    BASE_SPONSOR_EXPOSURE_SQL,
  ])
    await pg.exec(sql);
  // Only the wallets table: the others name tables this fixture doesn't need.
  const walletChains = arcChainIdsMigrations.find((each) => each.sql.includes('base_wallets '));
  await pg.exec((walletChains as { sql: string }).sql);
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, 5, 1, 1)`,
    [OWNER],
  );
  const wallet = (
    id: string,
    agent: string,
    chainId: number,
    owner: string = OWNER,
    account: string | null = 'person-1',
    address: string = WALLET,
  ) =>
    pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         owner_account_id, spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ($1, $2, 'person-1', $3, $4, $5, $6, $7, 'v1:k', '{}', 'derived', 1, 1)`,
      [id, agent, chainId, address, owner, account, SPENDER],
    );
  await wallet('w-base', BASE_AGENT, WALLET_CHAIN_ID);
  await wallet('w-arc', ARC_AGENT, ARC_TESTNET);
  await wallet('w-both-base', BOTH_AGENT, WALLET_CHAIN_ID, OWNER, 'person-1', OTHER_WALLET);
  await wallet('w-both-arc', BOTH_AGENT, ARC_TESTNET, OWNER, 'person-1', OTHER_WALLET);
  await wallet('w-outside', OUTSIDE_ARC_AGENT, ARC_TESTNET, OTHER_OWNER, null, SPENDER);
  const queries: string[] = [];
  const db: Database = {
    query: (sql, params) => {
      queries.push(sql);
      return pg.query(sql, params) as never;
    },
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return { pg, db, queries };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function appOn(
  t: { after: (fn: () => Promise<unknown>) => void },
  f: Fixture,
  env: Record<string, string>,
  options: {
    balances?: BalanceReader;
    arcBalances?: (chainId: number) => BalanceReader | undefined;
    runtimes?: number[];
    person?: string;
  } = {},
) {
  const app = Fastify();
  t.after(() => app.close());
  const person = options.person ?? 'person-1';
  registerBaseWalletRoutes(app, {
    db: f.db,
    env,
    log: () => {},
    currentPerson: async () => ({ id: person }),
    currentWorkspace: async () => ({ id: person }),
    runtime: async (chainId) => {
      options.runtimes?.push(chainId);
      return {
        walletPort: {
          deriveSmartAccount: async () => `0x${'5'.repeat(40)}`,
          createSpender: async () => ({ spender: `0x${'6'.repeat(40)}`, keyRef: 'v1:new' }),
          commitSpender: async () => {},
          implementationVersion: 'test',
        },
      } as unknown as ChainRuntime;
    },
    balances: options.balances,
    arcBalances: options.arcBalances,
    now: () => NOW,
  });
  // Added by another module after the wallet routes, as in server/app.ts.
  app.get(FEED_PAY_PATHS.history, async () => ({ calls: [] }));
  return app;
}

const walletUrl = (agent: string) => `/api/base/agents/${agent}/wallet`;
const ANY_ID = '00000000-0000-4000-8000-000000000000';

/** Every route under .../wallet/: the list the next slice goes by. */
const GATED: ReadonlyArray<readonly ['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
  ['POST', 'withdrawals'],
  ['GET', 'withdrawals?open=1'],
  ['GET', `withdrawals/${ANY_ID}`],
  ['POST', `withdrawals/${ANY_ID}/signature`],
  ['POST', `withdrawals/${ANY_ID}/cancel`],
  ['POST', `withdrawals/${ANY_ID}/cancel/signature`],
  ['GET', 'limits'],
  ['POST', 'limits/prepare'],
  ['POST', 'limits'],
  ['POST', `limits/${ANY_ID}/revoke`],
  ['POST', `limits/${ANY_ID}/revoke/signature`],
  ['GET', 'agent-pay'],
  ['PUT', 'agent-pay'],
  ['DELETE', 'agent-pay'],
  ['POST', 'payments'],
  ['GET', 'agent-payments'],
  ['GET', 'ratings/status'],
  ['POST', 'ratings/lookup'],
  ['GET', 'ratings'],
  ['POST', 'ratings'],
  ['GET', 'service-calls'],
];

const send = (
  app: ReturnType<typeof appOn>,
  agent: string,
  [method, path]: (typeof GATED)[number],
) =>
  app.inject({
    method,
    url: `${walletUrl(agent)}/${path}`,
    ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}),
  });

test('Arc off: GET asks the database nothing new and answers the same JSON, byte for byte', async (t) => {
  const f = await fixture(t);
  const base = fakeReader(2_500_000n, 10n ** 15n);
  const arc = fakeReader(1n, 1n);
  let asked = 0;
  const app = appOn(t, f, ARC_OFF, {
    balances: base.reader,
    arcBalances: () => {
      asked += 1;
      return arc.reader;
    },
  });
  f.queries.length = 0;
  const response = await app.inject({ url: walletUrl(BASE_AGENT) });
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body,
    JSON.stringify({
      chainId: 8453,
      network: 'Base',
      testnet: false,
      address: WALLET,
      ownerAddress: OWNER,
      spenderAddress: SPENDER,
      deployed: true,
      fundingLocked: false,
      usdc: { raw: '2500000', decimals: 6, display: '2.5' },
      eth: { raw: '1000000000000000', decimals: 18, display: '0.001' },
      readAtBlock: 77,
      readAt: NOW,
      stale: false,
      explorerUrl: `https://basescan.org/address/${WALLET}`,
    }),
  );
  // The person, the agent, the wallet: as before, and nothing about chains or identities.
  assert.equal(f.queries.length, 3);
  assert.match(f.queries[0], /FROM operators/);
  assert.match(f.queries[1], /FROM agent_manifests/);
  assert.match(f.queries[2], /FROM base_wallets w/);
  assert.equal(asked, 0);
  assert.deepEqual(arc.reads, []);
  assert.deepEqual(base.reads, [WALLET]);
});

test('Arc off: the helper asks nothing, and no route under the wallet refuses or asks the chain', async (t) => {
  const f = await fixture(t);
  f.queries.length = 0;
  assert.equal(await agentChainOf(f.db, ARC_OFF, ARC_AGENT), WALLET_CHAIN_ID);
  assert.deepEqual(f.queries, []);
  const app = appOn(t, f, ARC_OFF);
  for (const route of GATED) {
    const answer = await send(app, ARC_AGENT, route);
    assert.notEqual(answer.json().code, 'not_on_arc_yet', route.join(' '));
  }
  assert.equal(f.queries.filter((sql) => /chain_id IN \(\$2, \$3\)/.test(sql)).length, 0);
});

test('Arc off: a row left on Arc is not read as the agent wallet', async (t) => {
  const f = await fixture(t);
  const base = fakeReader(1n, 1n);
  const app = appOn(t, f, ARC_OFF, { balances: base.reader });
  assert.deepEqual((await app.inject({ url: walletUrl(ARC_AGENT) })).json(), { wallet: null });
  assert.deepEqual(base.reads, []);
});

test('the agent chain: its row, else the wallet network; only the Arc network that is on', async (t) => {
  const f = await fixture(t);
  assert.equal(await agentChainOf(f.db, ARC_ON, BASE_AGENT), WALLET_CHAIN_ID);
  assert.equal(await agentChainOf(f.db, ARC_ON, ARC_AGENT), ARC_TESTNET);
  assert.equal(await agentChainOf(f.db, ARC_ON, NEW_AGENT), WALLET_CHAIN_ID);
  // A row on the other Arc network, the one not switched on, is not the agent's chain.
  assert.equal(
    await agentChainOf(f.db, { ...ARC_ON, CITY_ARC_CHAIN_ID: String(ARC_MAINNET) }, ARC_AGENT),
    WALLET_CHAIN_ID,
  );
});

test('a row on both chains: Arc only with a live identity there', async (t) => {
  const f = await fixture(t);
  assert.equal(await agentChainOf(f.db, ARC_ON, BOTH_AGENT), WALLET_CHAIN_ID);
  await f.pg.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
       owner_of_identity, state, updated_at)
     VALUES ($1, $2, 'person-1', $3, 'https://card', $4, 'failed', 1)`,
    [BOTH_AGENT, ARC_TESTNET, `0x${'7'.repeat(40)}`, OWNER],
  );
  assert.equal(await agentChainOf(f.db, ARC_ON, BOTH_AGENT), WALLET_CHAIN_ID);
  await f.pg.query(`UPDATE base_identities SET state = 'pending' WHERE agent_id = $1`, [
    BOTH_AGENT,
  ]);
  assert.equal(await agentChainOf(f.db, ARC_ON, BOTH_AGENT), ARC_TESTNET);
});

test('Arc on: an Arc agent reads through the Arc reader only, in USDC with no ETH figure', async (t) => {
  const f = await fixture(t);
  const base = fakeReader(111n, 222n);
  const arc = fakeReader(4_000_000n, 4n * 10n ** 18n);
  const built: number[] = [];
  const app = appOn(t, f, ARC_ON, {
    balances: base.reader,
    arcBalances: (chainId) => {
      built.push(chainId);
      return arc.reader;
    },
  });
  // Nothing built until an Arc wallet is read: a Base agent never asks for it.
  const onBase = (await app.inject({ url: walletUrl(BASE_AGENT) })).json();
  assert.equal(onBase.chainId, WALLET_CHAIN_ID);
  assert.equal(onBase.usdc.raw, '111');
  assert.equal('gasAsset' in onBase, false);
  assert.deepEqual(built, []);
  assert.deepEqual(arc.reads, []);
  assert.deepEqual(base.reads, [WALLET]);

  // The same address as the Base agent's: Base's cached read is not reused.
  const body = (await app.inject({ url: walletUrl(ARC_AGENT) })).json();
  assert.deepEqual(arc.reads, [WALLET]);
  assert.deepEqual(base.reads, [WALLET]);
  assert.deepEqual(body, {
    chainId: ARC_TESTNET,
    network: 'Arc Testnet',
    testnet: true,
    address: WALLET,
    ownerAddress: OWNER,
    spenderAddress: SPENDER,
    deployed: true,
    fundingLocked: false,
    usdc: { raw: '4000000', decimals: 6, display: '4' },
    eth: { raw: '0', decimals: 18, display: '0' },
    gasAsset: 'USDC',
    readAtBlock: 77,
    readAt: NOW,
    stale: false,
    explorerUrl: `https://explorer.testnet.arc.io/address/${WALLET}`,
  });
  // Built once, then that chain's cache answers.
  await app.inject({ url: walletUrl(ARC_AGENT) });
  assert.deepEqual(built, [ARC_TESTNET]);
  assert.deepEqual(arc.reads, [WALLET]);
});

test('Arc on: no Arc reader answers 503 naming Arc and is asked again; Base never stands in', async (t) => {
  const f = await fixture(t);
  const base = fakeReader(1n, 1n);
  let asks = 0;
  const app = appOn(t, f, ARC_ON, {
    balances: base.reader,
    arcBalances: () => {
      asks += 1;
      return undefined;
    },
  });
  for (let i = 0; i < 2; i += 1) {
    const answer = await app.inject({ url: walletUrl(ARC_AGENT) });
    assert.equal(answer.statusCode, 503);
    assert.deepEqual(answer.json(), {
      error: 'Arc Testnet could not be read.',
      code: 'chain_unavailable',
      details: { chainId: ARC_TESTNET },
    });
  }
  assert.equal(asks, 2);
  assert.deepEqual(base.reads, []);
});

test('an Arc agent registered with an outside owner: named on Arc, no read at all', async (t) => {
  const f = await fixture(t);
  const arc = fakeReader(1n, 1n);
  const app = appOn(t, f, ARC_ON, { arcBalances: () => arc.reader });
  const body = (await app.inject({ url: walletUrl(OUTSIDE_ARC_AGENT) })).json();
  assert.equal(body.kind, 'registered_elsewhere');
  assert.equal(body.chainId, ARC_TESTNET);
  assert.equal(body.network, 'Arc Testnet');
  assert.equal(body.testnet, true);
  assert.equal(body.message, REGISTERED_ELSEWHERE.replace('Base ID', 'Arc Testnet ID'));
  assert.deepEqual(arc.reads, []);
  // POST finds the conflict on that same chain, and says it the same way.
  const post = await app.inject({
    method: 'POST',
    url: walletUrl(OUTSIDE_ARC_AGENT),
    payload: {},
  });
  assert.equal(post.statusCode, 409);
  assert.equal(post.json().code, 'wallet_registered_elsewhere');
  assert.equal(post.json().error, body.message);
});

test('POST: the wallet is ensured on the agent chain, through that chain runtime', async (t) => {
  const f = await fixture(t);
  const runtimes: number[] = [];
  const app = appOn(t, f, ARC_ON, { runtimes });
  const arc = await app.inject({ method: 'POST', url: walletUrl(ARC_AGENT), payload: {} });
  assert.equal(arc.statusCode, 200);
  assert.equal(arc.json().chainId, ARC_TESTNET);
  assert.equal(arc.json().network, 'Arc Testnet');
  assert.equal(arc.json().address, WALLET);
  assert.equal(arc.json().explorerUrl, `https://explorer.testnet.arc.io/address/${WALLET}`);
  const base = await app.inject({ method: 'POST', url: walletUrl(BASE_AGENT), payload: {} });
  assert.equal(base.statusCode, 200);
  assert.equal(base.json().chainId, WALLET_CHAIN_ID);
  // No row yet: the wallet network. The browser names a chain only at registration.
  const fresh = await app.inject({ method: 'POST', url: walletUrl(NEW_AGENT), payload: {} });
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.json().chainId, WALLET_CHAIN_ID);
  assert.deepEqual(runtimes, [ARC_TESTNET, WALLET_CHAIN_ID, WALLET_CHAIN_ID]);
  const { rows } = await f.pg.query<{ chain_id: number }>(
    'SELECT chain_id FROM base_wallets WHERE agent_id = $1',
    [ARC_AGENT],
  );
  assert.deepEqual(
    rows.map((row) => row.chain_id),
    [ARC_TESTNET],
  );
});

/** What follows the agent's chain now: tested in arc-limits-chain and arc-withdraw-chain.test.ts. */
const STILL_GATED = GATED.filter(
  ([, path]) =>
    !/^(limits(\/|$)|agent-pay$|service-calls$|withdrawals(\/|\?|$)|payments$|agent-payments$)/.test(
      path,
    ),
);

test('Arc on: every gated route refuses an Arc agent, its service untouched', async (t) => {
  const f = await fixture(t);
  const app = appOn(t, f, ARC_ON);
  for (const route of STILL_GATED) {
    f.queries.length = 0;
    const answer = await send(app, ARC_AGENT, route);
    assert.equal(answer.statusCode, 409, route.join(' '));
    assert.equal(answer.json().code, 'not_on_arc_yet', route.join(' '));
    // Who, which chain, and may they know: nothing a service would read or write.
    assert.equal(f.queries.length, 3, route.join(' '));
  }
});

test('the gated list above is every wallet route under the prefix', async (t) => {
  const f = await fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  const seen = new Set<string>();
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(NOT_ON_ARC_YET_PREFIX)) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods)
      if (method !== 'HEAD') seen.add(`${method} ${route.url.slice(NOT_ON_ARC_YET_PREFIX.length)}`);
  });
  registerBaseWalletRoutes(app, {
    db: f.db,
    env: ARC_ON,
    log: () => {},
    currentPerson: async () => null,
    currentWorkspace: async () => null,
    runtime: async () => ({}) as ChainRuntime,
  });
  await app.ready();
  const shape = (path: string) =>
    path
      .replace(/\?.*/, '')
      .replace(`withdrawals/${ANY_ID}`, 'withdrawals/:withdrawalId')
      .replace(`limits/${ANY_ID}`, 'limits/:permissionId');
  const listed = GATED.filter(([, path]) => path !== 'service-calls').map(
    ([method, path]) => `${method} ${shape(path)}`,
  );
  assert.deepEqual([...seen].sort(), [...listed].sort());
});

test('Arc on: a Base agent gets from every gated route just what it gets with Arc off', async (t) => {
  const f = await fixture(t);
  const on = appOn(t, f, ARC_ON);
  const off = appOn(t, f, { ...ARC_ON, CITY_ARC: '' });
  for (const route of GATED) {
    const withArc = await send(on, BASE_AGENT, route);
    const without = await send(off, BASE_AGENT, route);
    assert.notEqual(withArc.json().code, 'not_on_arc_yet', route.join(' '));
    assert.equal(withArc.statusCode, without.statusCode, route.join(' '));
    assert.deepEqual(withArc.json(), without.json(), route.join(' '));
  }
  // And one that's a real answer, not a refusal of an empty body.
  const limits = await on.inject({ url: `${walletUrl(BASE_AGENT)}/limits` });
  assert.equal(limits.statusCode, 200);
});

test('Arc on: someone else asking about an Arc agent gets 404, so its chain stays private', async (t) => {
  const f = await fixture(t);
  const app = appOn(t, f, ARC_ON, { person: 'person-2' });
  for (const route of STILL_GATED) {
    const answer = await send(app, ARC_AGENT, route);
    assert.equal(answer.statusCode, 404, route.join(' '));
    assert.deepEqual(answer.json(), { error: 'Not found.' }, route.join(' '));
  }
});

test('Arc on: a malformed agent id, or wallets off, reach the route as before', async (t) => {
  const f = await fixture(t);
  const on = appOn(t, f, ARC_ON);
  assert.equal((await on.inject({ url: `${walletUrl('not-a-uuid')}/limits` })).statusCode, 404);
  const walletsOff = appOn(t, f, { ...ARC_ON, CITY_BASE_WALLET: '' });
  f.queries.length = 0;
  const answer = await walletsOff.inject({ url: `${walletUrl(ARC_AGENT)}/limits` });
  assert.equal(answer.statusCode, 404);
  assert.deepEqual(f.queries, []);
});

async function rpcNode(
  t: { after: (fn: () => Promise<unknown>) => void },
  answer: (method: string) => { status: number; result?: unknown },
) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string };
      calls.push(body.method);
      const { status, result } = answer(body.method);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('arcBalanceReader: Arc only, Arc on only, with its endpoint and its contracts', () => {
  const url = 'https://arc.example';
  const withUrl = { ...ARC_ON, CITY_ARC_RPC_URL: url };
  assert.equal(arcBalanceReader(WALLET_CHAIN_ID, withUrl), undefined);
  assert.equal(arcBalanceReader(ARC_TESTNET, { ...withUrl, CITY_ARC: '' }), undefined);
  assert.equal(arcBalanceReader(ARC_TESTNET, ARC_ON), undefined);
  // Base's endpoint is no stand-in for Arc's.
  assert.equal(arcBalanceReader(ARC_TESTNET, { ...ARC_ON, CITY_BASE_CDP_RPC_URL: url }), undefined);
  // Mainnet: off while Arc is off or without its endpoint; its manager comes from the code.
  assert.equal(arcBalanceReader(ARC_MAINNET, { ...withUrl, CITY_ARC: '' }), undefined);
  assert.equal(arcBalanceReader(ARC_MAINNET, ARC_ON), undefined);
  assert.equal(arcBalanceReader(1, withUrl), undefined);
  assert.ok(arcBalanceReader(ARC_MAINNET, withUrl));
  assert.ok(arcBalanceReader(ARC_TESTNET, withUrl));
});

test('arcBalanceReader: a node on another chain is refused, and Base fallback is never asked', async (t) => {
  const wrong = await rpcNode(t, () => ({ status: 200, result: '0x2105' }));
  const down = await rpcNode(t, () => ({ status: 500 }));
  const baseFallback = await rpcNode(t, () => ({ status: 200, result: '0x2105' }));
  const wallet = WALLET as Address;
  const onWrong = arcBalanceReader(ARC_TESTNET, {
    ...ARC_ON,
    CITY_ARC_RPC_URL: wrong.url,
  }) as BalanceReader;
  await assert.rejects(onWrong.balances(wallet), /expected network/);
  const onDown = arcBalanceReader(ARC_TESTNET, {
    ...ARC_ON,
    CITY_ARC_RPC_URL: down.url,
    CITY_BASE_READ_FALLBACK_RPC_URL: baseFallback.url,
  }) as BalanceReader;
  await assert.rejects(onDown.balances(wallet));
  assert.ok(down.calls.length > 0);
  assert.deepEqual(baseFallback.calls, []);
});
