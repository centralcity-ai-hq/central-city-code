import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  EXPLORER_READ_SETTING,
  explorerReadUrls,
  type OnBaseChainReader,
} from '../server/base/explorer/head.js';
import {
  ON_BASE_CHAIN_READS,
  ON_BASE_RATE,
  ON_BASE_RATE_NETWORK,
  ON_BASE_RATE_SITE,
  registerOnBaseRoutes,
} from '../server/base/explorer/routes.js';
import { ON_BASE_PATHS } from '../shared/base/on-base.js';
import { NOW, add, setup } from './on-base-fixture.js';

/*
 * What anonymous passport reads may spend of the Base endpoint the bundler and every wallet read
 * also use: one address per passport (a padded Base ID is sent on to its canonical one), IPv6
 * limits per /56 and /48 beside the /64 one, and a deployment-wide budget of passports that read
 * Base, past which a passport answers with its last read.
 */

/** The shared limiter's behaviour: counts per key, refuses past `max` (as the app's 429). */
function counter() {
  const hits = new Map<string, number>();
  const caps = new Map<string, number>();
  const limit = async (key: string, max: number) => {
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    caps.set(key, max);
    if (n > max) throw Object.assign(new Error('Too many requests.'), { statusCode: 429 });
  };
  return { hits, caps, limit };
}

/** Base stand-in: a head that moves on demand, and how often each read ran. */
function fakeBase() {
  const state = { block: 40n, heads: 0, owners: 0, feedback: 0 };
  const chain: OnBaseChainReader = {
    async head() {
      state.heads++;
      return { block: state.block };
    },
    async owners(ids) {
      state.owners++;
      return new Map(ids.map((id) => [id, null]));
    },
    async feedback() {
      state.feedback++;
      return { entries: [], total: 0, bounded: false, ratersSkipped: 0 };
    },
  };
  return { state, chain };
}

function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  db: Database,
  deps: { chain?: OnBaseChainReader; limit?: (key: string, max: number) => Promise<void> },
  now: () => number = () => NOW,
) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now, ...deps });
  return app;
}

test('a padded Base ID is sent on to its canonical passport, before the limiter and the database', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Harbor' });
  const limits = counter();
  const app = routes(t, db, { limit: limits.limit });
  for (const padded of ['0101', '000000101', '00']) {
    const moved = await app.inject({ url: `${ON_BASE_PATHS.passport}/${padded}` });
    assert.equal(moved.statusCode, 308, padded);
    assert.equal(
      moved.headers.location,
      `${ON_BASE_PATHS.passport}/${BigInt(padded).toString(10)}`,
      padded,
    );
  }
  assert.equal(limits.hits.size, 0, 'no limiter write for a redirect');
  const canonical = await app.inject({ url: `${ON_BASE_PATHS.passport}/101` });
  assert.equal(canonical.statusCode, 200, canonical.body);
  assert.equal((await app.inject({ url: `${ON_BASE_PATHS.passport}/0` })).statusCode, 404);
});

test('IPv6 reads are limited per /64, /56 and /48; IPv4 per address only', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Harbor' });
  const limits = counter();
  const app = routes(t, db, { limit: limits.limit });
  await app.inject({ url: `${ON_BASE_PATHS.passport}/101`, remoteAddress: '2001:db8:1:2a::7' });
  assert.deepEqual([...limits.hits.keys()].sort(), [
    'ip:onbase-network:2001:db8:1::/48',
    'ip:onbase-site:2001:db8:1:0::/56',
    'ip:onbase:2001:db8:1:2a::/64',
  ]);
  assert.equal(limits.caps.get('ip:onbase:2001:db8:1:2a::/64'), ON_BASE_RATE.max);
  assert.equal(limits.caps.get('ip:onbase-site:2001:db8:1:0::/56'), ON_BASE_RATE_SITE.max);
  assert.equal(limits.caps.get('ip:onbase-network:2001:db8:1::/48'), ON_BASE_RATE_NETWORK.max);

  // Rotating /64s inside one /56 runs into its limit.
  for (let n = 0; n < ON_BASE_RATE_SITE.max; n++)
    await app.inject({
      url: `${ON_BASE_PATHS.passport}/101`,
      remoteAddress: `2001:db8:2:${(n % 256).toString(16)}::1`,
    });
  const refused = await app.inject({
    url: `${ON_BASE_PATHS.passport}/101`,
    remoteAddress: '2001:db8:2:ff::1',
  });
  assert.equal(refused.statusCode, 429, refused.body);

  limits.hits.clear();
  await app.inject({ url: `${ON_BASE_PATHS.passport}/101`, remoteAddress: '198.51.100.7' });
  assert.deepEqual([...limits.hits.keys()], ['ip:onbase:198.51.100.7']);
});

test('passports read Base within a deployment-wide budget; past it they answer with the last read', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 3; n++) await add(db, { n, kind: 'final', id: 100 + n, name: `Agent ${n}` });
  const limits = counter();
  const base = fakeBase();
  let clock = NOW;
  const app = routes(t, db, { chain: base.chain, limit: limits.limit }, () => clock);
  const passport = (id: number) =>
    app.inject({ url: `${ON_BASE_PATHS.passport}/${id}`, remoteAddress: '198.51.100.7' });

  const first = await passport(101);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(base.state.owners, 1);
  assert.equal(base.state.feedback, 1);
  assert.equal(limits.hits.get('onbase-chain:passport'), 1);
  assert.equal(limits.caps.get('onbase-chain:passport'), ON_BASE_CHAIN_READS.max);
  // Read at this head already: nothing is read, nothing is charged.
  await passport(101);
  assert.equal(base.state.owners, 1);
  assert.equal(limits.hits.get('onbase-chain:passport'), 1);

  // The budget is spent (by many addresses together): a new id is answered without reading Base.
  limits.hits.set('onbase-chain:passport', ON_BASE_CHAIN_READS.max);
  const spent = await passport(102);
  assert.equal(spent.statusCode, 200, spent.body);
  assert.equal(base.state.owners, 1, 'no ownerOf read');
  assert.equal(base.state.feedback, 1, 'no feedback read');
  assert.equal(spent.json().reputation.readAtBlock, null, 'never read: not read, not "none"');

  // A new head with the budget spent: the last read stands, with its own block.
  base.state.block = 41n;
  clock += 10_000;
  const kept = await passport(101);
  assert.equal(kept.statusCode, 200, kept.body);
  assert.equal(kept.json().reputation.readAtBlock, 40);
  assert.equal(base.state.feedback, 1);
});

test('concurrent passports of one id at one head share one feedback read', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Harbor' });
  const base = fakeBase();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const feedback = base.chain.feedback!;
  base.chain.feedback = async (...args) => {
    await gate;
    return feedback(...args);
  };
  const app = routes(t, db, { chain: base.chain });
  const answers = Promise.all(
    [1, 2, 3].map(() => app.inject({ url: `${ON_BASE_PATHS.passport}/101` })),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  for (const answer of await answers) assert.equal(answer.statusCode, 200, answer.body);
  assert.equal(base.state.feedback, 1);
});

test('with its own endpoint set, the explorer never reads through the keyed Base endpoint (CCA-104)', () => {
  const keyed = 'https://keyed.example.test/rpc/k';
  const own = 'https://explorer.example.test/rpc/read-only';
  const second = 'https://fallback.example.test/rpc';
  assert.equal(EXPLORER_READ_SETTING, 'CITY_BASE_EXPLORER_RPC_URL');
  // Unset: as before, the keyed endpoint first.
  assert.deepEqual(
    explorerReadUrls(
      { CITY_BASE_CDP_RPC_URL: keyed, CITY_BASE_READ_FALLBACK_RPC_URL: second },
      true,
    ),
    [keyed, second],
  );
  const urls = explorerReadUrls(
    {
      CITY_BASE_CDP_RPC_URL: keyed,
      CITY_BASE_READ_FALLBACK_RPC_URL: second,
      [EXPLORER_READ_SETTING]: own,
    },
    true,
  );
  assert.deepEqual(urls, [own, second]);
  assert.ok(!urls.includes(keyed));
  // Hosted without a second endpoint setting: its own, then the public RPC; never the keyed one.
  const hosted = explorerReadUrls(
    { CITY_BASE_CDP_RPC_URL: keyed, [EXPLORER_READ_SETTING]: own },
    true,
  );
  assert.equal(hosted[0], own);
  assert.ok(!hosted.includes(keyed));
  // Not https: refused, never replaced by the keyed endpoint.
  assert.deepEqual(
    explorerReadUrls(
      { CITY_BASE_CDP_RPC_URL: keyed, [EXPLORER_READ_SETTING]: 'http://explorer.example.test' },
      true,
    ),
    [],
  );
});
