import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import {
  transferAuthorizationTypedData,
  type AuthorizationStore,
  type IssuedAuthorization,
} from '../server/base/chain/x402.js';
import type { FeedPayOp } from '../server/base/chain/feed-pay-chain.js';
import type { Router3FacilitatorPort } from '../server/feed/pay/router3.js';
import { FEED_PAY_SPONSOR_SQL } from '../server/feed/pay/sponsor-schema.js';
import { createSponsorCredits } from '../server/feed/pay/sponsor.js';
import { createSponsorSigner } from '../server/feed/pay/sponsor-signer.js';
import {
  createSponsoredCalls,
  FEED_PAY_SPONSORED_SQL,
  SponsoredRefusal,
} from '../server/feed/pay/sponsored.js';
import { TERMS_VERSION } from '../shared/terms.js';

const network = BASE_NETWORKS[BASE_MAINNET];
const USDC = network.tokens.USDC!.address as Address;
const ROUTER = `0x${'9'.repeat(40)}` as Address;
const TREASURY = `0x${'7'.repeat(40)}` as Address;
const PAYEE = `0x${'5'.repeat(40)}` as Address;
const START = 1_800_000_000_000;

/** A facilitator port double: stores what is submitted, answers the status the test sets. */
function fakeFacilitator() {
  const submitted = new Map<string, Parameters<Router3FacilitatorPort['submit']>[0]>();
  const status = new Map<string, FeedPayOp>();
  let failSubmit = false;
  let gas = true;
  const port: Router3FacilitatorPort = {
    submit: async (input) => {
      if (failSubmit) throw new Error('node down');
      submitted.set(input.key, input);
      const op = status.get(input.key) ?? {
        key: input.key,
        status: 'submitted' as FeedPayOp['status'],
        txHash: null,
        blockNumber: null,
        neverSent: false,
        errorCode: null,
      };
      status.set(input.key, op);
      return op;
    },
    status: async (key) => status.get(key) ?? null,
    endUnsent: async () => true,
    canPay: async () => gas,
    flushBatches: async () => {},
  };
  return {
    port,
    submitted,
    set: (key: string, op: Partial<FeedPayOp>) =>
      status.set(key, { ...(status.get(key) as FeedPayOp), ...op }),
    /** The facilitator holds nothing for this key (as if never stored). */
    forget: (key: string) => {
      submitted.delete(key);
      status.delete(key);
    },
    failSubmit: (on: boolean) => {
      failSubmit = on;
    },
    setGas: (on: boolean) => {
      gas = on;
    },
  };
}

function memoryStore(): AuthorizationStore {
  const rows = new Map<string, IssuedAuthorization>();
  return {
    get: async (id) => rows.get(id) ?? null,
    insert: async (row) => {
      if (!rows.has(row.paymentIntentId)) rows.set(row.paymentIntentId, row);
      return rows.get(row.paymentIntentId)!;
    },
  };
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE base_identities (agent_id text, chain_id integer, state text,
      erc8004_agent_id numeric, started_at bigint, updated_at bigint);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, agent_id text, chain_id integer,
      operator_id text, owner_account_id text, state text);
    CREATE TABLE city_offers (offer_id text PRIMARY KEY, operator_id text, agent_id text, wallet_id text);
    CREATE TABLE operators (id text PRIMARY KEY, salt text, kind text);
    CREATE TABLE account_terms_acceptances (operator_id text PRIMARY KEY, version text);
    CREATE TABLE operator_links (human_operator_id text, ai_operator_id text);
    CREATE TABLE elric_verified_identities (operator_id text PRIMARY KEY);`);
  await pg.exec(FEED_PAY_SPONSOR_SQL);
  await pg.exec(FEED_PAY_SPONSORED_SQL);
  // The buyer: owner o1 (verified, onboarded) with agent a1 in workspace ws1, identity final.
  await pg.exec(`INSERT INTO operators VALUES ('o1','x','owner'), ('o2','x','owner');
    INSERT INTO elric_verified_identities VALUES ('o1');
    INSERT INTO account_terms_acceptances VALUES ('o1', '${TERMS_VERSION}');
    INSERT INTO base_identities VALUES ('a1', 8453, 'confirmed', 1, ${START + 1}, ${START + 1});
    INSERT INTO base_wallets VALUES ('w-a1', 'a1', 8453, 'ws1', 'o1', 'deployed');
    INSERT INTO base_wallets VALUES ('w-s', 's1', 8453, 'ws-s', 'o2', 'deployed');
    INSERT INTO city_offers VALUES ('of_1', 'ws-s', 's1', 'w-s');`);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const env: Record<string, string> = {
    CITY_SFP_ENABLED: '1',
    CITY_SFP_START_MS: String(START),
    CITY_SFP_OFFERS: 'of_1',
  };
  const clock = { now: START + 3_600_000 };
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const signer = createSponsorSigner({
    network,
    keystore: { withSigner: async (_ref, use) => use(sponsor) },
    keyRef: 'v1:sponsor',
    sponsor: sponsor.address as Address,
    token: USDC,
    store: memoryStore(),
    now: () => clock.now,
    router: ROUTER,
    treasuryOf: async () => TREASURY,
  });
  const facilitator = fakeFacilitator();
  const credits = createSponsorCredits({ db, env, now: () => clock.now });
  let runs = 0;
  let runFails = false;
  const wallet = { usdc: 1_000_000_000n };
  /** What Base shows for the legs past validBefore: unused (true) or not yet / used (false). */
  const chain = { expiredUnused: false, asked: 0 };
  const calls = createSponsoredCalls({
    db,
    env,
    now: () => clock.now,
    chainId: 8453,
    credits,
    hosted: {
      forSponsor: async (serviceId) => {
        if (serviceId !== 'svc-1') throw new Error('service_not_found');
        return {
          offerId: 'of_1',
          kind: 'echo',
          version: 1,
          payTo: PAYEE,
          split: { gross: 1_500_000n, fee: 150_000n, net: 1_350_000n },
          input: '{"q":"hi"}',
        };
      },
      run: async () => {
        runs += 1;
        return runFails
          ? { ok: false as const, failure: 'service_error' }
          : {
              ok: true as const,
              text: '{"a":1}',
              mime: 'application/json',
              format: 'json' as const,
            };
      },
    },
    pay: async () => ({
      signer,
      facilitator: facilitator.port,
      usdcBalance: async () => wallet.usdc,
      expiredUnused: async () => {
        chain.asked += 1;
        return chain.expiredUnused;
      },
    }),
    serviceIdOf: (offerId) => (offerId === 'of_1' ? 'svc-1' : `svc-${offerId}`),
  });
  const credit = async (agentId: string) =>
    (
      await pg.query<{ state: string }>(
        'SELECT state FROM feed_pay_sponsor_credits WHERE agent_id = $1',
        [agentId],
      )
    ).rows[0]?.state ?? null;
  return {
    pg,
    env,
    clock,
    sponsor,
    facilitator,
    calls,
    credit,
    runs: () => runs,
    setRunFails: (on: boolean) => {
      runFails = on;
    },
    wallet,
    chain,
  };
}

const ask = (key = 'sfp-a1') => ({
  serviceId: 'svc-1',
  agentId: 'a1',
  inputs: { body: { q: 'hi' } },
  maxAmountRaw: 2_000_000n,
  idempotencyKey: key,
});

test('sponsored call: the sponsor signs and its facilitator sends; paid, credit used, delivered', async (t) => {
  const f = await setup(t);
  const started = await f.calls.start('o1', ask());
  assert.equal(started.state, 'sent');
  assert.equal(started.sponsored, true);
  assert.equal(started.payment.payer, f.sponsor.address);
  assert.equal(await f.credit('a1'), 'reserved');
  const sent = f.facilitator.submitted.get(`sfp:${started.callId}`)!;
  assert.equal(sent.settlement.payer, f.sponsor.address);
  assert.equal(sent.settlement.payee, getAddress(PAYEE));
  assert.equal(sent.settlement.gross, 1_500_000n);
  assert.ok(sent.batch, 'every sponsored settlement may go out in a batch');
  // Both legs are the sponsor's own ECDSA signatures.
  assert.match(sent.settlement.sellerSignature, /^0x[0-9a-f]{130}$/i);
  // Included on Base: paid, the credit is spent for good, then delivered once.
  f.facilitator.set(`sfp:${started.callId}`, {
    status: 'included',
    txHash: `0x${'ab'.repeat(32)}` as Hex,
    blockNumber: 10n,
  });
  assert.equal(await f.calls.step(started.callId), true);
  assert.equal(await f.credit('a1'), 'used');
  assert.equal(await f.calls.step(started.callId), true);
  const done = (await f.calls.callFor('o1', started.callId))!;
  assert.equal(done.state, 'delivered');
  assert.deepEqual(done.result, { format: 'json', mime: 'application/json', text: '{"a":1}' });
  assert.equal(f.runs(), 1);
  assert.equal(await f.calls.step(started.callId), false, 'nothing left to do');
  assert.equal(await f.calls.callFor('o2', started.callId), null, 'only its owner reads it');
});

test('sponsored call: refused credits store nothing; others agents and keys are checked', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.calls.start('o2', ask()),
    (e: SponsoredRefusal) => e.code === 'agent_not_found',
  );
  f.env.CITY_SFP_ENABLED = '0';
  await assert.rejects(
    f.calls.start('o1', ask()),
    (e: SponsoredRefusal) => e.code === 'credit_unavailable' && e.reason === 'disabled',
  );
  f.env.CITY_SFP_ENABLED = '1';
  await assert.rejects(
    f.calls.start('o1', { ...ask(), maxAmountRaw: 1_000_000n }),
    (e: SponsoredRefusal) => e.code === 'credit_unavailable' && e.reason === 'over_price',
  );
  const n = await f.pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM feed_pay_sponsored_calls',
  );
  assert.equal(n.rows[0]!.n, 0);
  // Idempotent per (owner, key); another body under the same key is a conflict.
  const one = await f.calls.start('o1', ask());
  assert.equal((await f.calls.start('o1', ask())).callId, one.callId);
  await assert.rejects(
    f.calls.start('o1', { ...ask(), maxAmountRaw: 1_900_000n }),
    (e: SponsoredRefusal) => e.code === 'idempotency_conflict',
  );
  // A second key for the same agent: its one credit is taken.
  await assert.rejects(
    f.calls.start('o1', ask('another')),
    (e: SponsoredRefusal) => e.code === 'credit_unavailable' && e.reason === 'used',
  );
});

test('sponsored call: never broadcast → failed and the credit comes back at once', async (t) => {
  const f = await setup(t);
  const c = await f.calls.start('o1', ask());
  f.facilitator.set(`sfp:${c.callId}`, {
    status: 'failed',
    neverSent: true,
    errorCode: 'REFUSED_BEFORE_BROADCAST',
  });
  assert.equal(await f.calls.step(c.callId), true);
  assert.equal((await f.calls.callFor('o1', c.callId))!.state, 'failed');
  assert.equal(await f.credit('a1'), 'released');
  // The agent may use its credit again (a new key).
  assert.equal((await f.calls.start('o1', ask('retry'))).state, 'sent');
});

test('sponsored call: failed after a broadcast → released only once Base shows both legs expired and unused', async (t) => {
  const f = await setup(t);
  const c = await f.calls.start('o1', ask());
  f.facilitator.set(`sfp:${c.callId}`, {
    status: 'failed',
    neverSent: false,
    errorCode: 'REVERTED',
    txHash: `0x${'cd'.repeat(32)}` as Hex,
  });
  assert.equal(await f.calls.step(c.callId), false, 'legs still valid: wait');
  assert.equal(await f.credit('a1'), 'reserved');
  // Past validBefore by the clock alone: still waits (a late receipt or a resubmit can still pay).
  f.clock.now += 601_000;
  assert.equal(await f.calls.step(c.callId), false);
  assert.equal(await f.credit('a1'), 'reserved');
  assert.ok(f.chain.asked >= 1, 'Base was asked');
  // Base: safe block past validBefore, both nonces unused. Only now.
  f.chain.expiredUnused = true;
  assert.equal(await f.calls.step(c.callId), true);
  assert.equal(await f.credit('a1'), 'released');
});

test('sponsored call: a failed hand-over is retried with the same signed pair', async (t) => {
  const f = await setup(t);
  f.facilitator.failSubmit(true);
  const c = await f.calls.start('o1', ask());
  assert.equal(c.state, 'reserved');
  f.facilitator.failSubmit(false);
  assert.equal(await f.calls.work({ maxCalls: 10, budgetMs: 5_000 }), 1);
  const first = f.facilitator.submitted.get(`sfp:${c.callId}`)!;
  assert.equal((await f.calls.callFor('o1', c.callId))!.state, 'sent');
  // The facilitator forgot it (never stored): handed over again, the very same signatures.
  f.facilitator.forget(`sfp:${c.callId}`);
  const again = await f.calls.step(c.callId);
  assert.equal(again, true);
  const second = f.facilitator.submitted.get(`sfp:${c.callId}`)!;
  assert.equal(second.settlement.sellerSignature, first.settlement.sellerSignature);
  assert.equal(second.settlement.feeSignature, first.settlement.feeSignature);
});

test('sponsored call: a paid offer that gives no result ends paid_no_result (credit stays used)', async (t) => {
  const f = await setup(t);
  f.setRunFails(true);
  const c = await f.calls.start('o1', ask());
  f.facilitator.set(`sfp:${c.callId}`, {
    status: 'final',
    txHash: `0x${'ef'.repeat(32)}` as Hex,
    blockNumber: 11n,
  });
  await f.calls.step(c.callId);
  await f.calls.step(c.callId);
  const done = (await f.calls.callFor('o1', c.callId))!;
  assert.equal(done.state, 'paid_no_result');
  assert.equal(done.failure, 'service_error');
  assert.equal(await f.credit('a1'), 'used');
});

test('sponsored legs verify as the sponsor for USDC (signature recovery)', async (t) => {
  const f = await setup(t);
  const c = await f.calls.start('o1', ask());
  const s = f.facilitator.submitted.get(`sfp:${c.callId}`)!.settlement;
  const recovered = await recoverTypedDataAddress({
    ...transferAuthorizationTypedData(network, USDC, {
      from: f.sponsor.address as Address,
      to: getAddress(PAYEE) as Address,
      value: 1_350_000n,
      validAfter: s.validAfter,
      validBefore: s.validBefore,
      nonce: (await import('../server/feed/pay/router3.js')).router3Nonce({
        chainId: 8453,
        router: ROUTER,
        treasury: TREASURY,
        payer: f.sponsor.address as Address,
        payee: PAYEE,
        gross: 1_500_000n,
        ref: s.ref,
        validAfter: s.validAfter,
        validBefore: s.validBefore,
        leg: 0,
      }),
    }),
    signature: s.sellerSignature,
  });
  assert.equal(recovered, f.sponsor.address);
});

test('sponsor low on USDC or ETH: first buys pause (unavailable, nothing reserved), never fail halfway', async (t) => {
  const f = await setup(t);
  const reserved = async () =>
    (await f.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM feed_pay_sponsor_credits'))
      .rows[0]!.n;
  // ETH below the facilitator's floor.
  f.facilitator.setGas(false);
  await assert.rejects(
    f.calls.start('o1', ask()),
    (e: SponsoredRefusal) => e.code === 'unavailable',
  );
  assert.equal(await reserved(), 0);
  f.facilitator.setGas(true);
  // USDC: 1.4 USDC cannot pay a 1.5 USDC buy.
  f.wallet.usdc = 1_400_000n;
  await assert.rejects(
    f.calls.start('o1', ask()),
    (e: SponsoredRefusal) => e.code === 'unavailable',
  );
  assert.equal(await reserved(), 0);
  // Funded again (the cached read expires): it goes.
  f.wallet.usdc = 2_000_000n;
  f.clock.now += 11_000;
  const c = await f.calls.start('o1', ask());
  assert.equal(c.state, 'sent');
  // 2.0 USDC with 1.5 in flight cannot pay a second 1.5 buy (another agent of the same owner,
  // whose daily count allows it: the balance check under the lock is what refuses).
  f.env.CITY_SFP_OWNER_DAILY_MAX = '5';
  await f.pg
    .exec(`INSERT INTO base_identities VALUES ('a2', 8453, 'confirmed', 2, ${START + 1}, ${START + 1});
    INSERT INTO base_wallets VALUES ('w-a2', 'a2', 8453, 'ws2', 'o1', 'deployed');`);
  await assert.rejects(
    f.calls.start('o1', { ...ask('k2'), agentId: 'a2' }),
    (e: SponsoredRefusal) => e.code === 'unavailable',
  );
});

test('sponsored call: a reservation never handed over is fenced, then failed and released (S3)', async (t) => {
  const f = await setup(t);
  f.facilitator.failSubmit(true);
  const c = await f.calls.start('o1', ask());
  assert.equal(c.state, 'reserved');
  // Within its window: just retried, nothing ends.
  assert.equal(await f.calls.step(c.callId), false);
  f.clock.now += 1_201_000;
  assert.equal(await f.calls.step(c.callId), true);
  const done = (await f.calls.callFor('o1', c.callId))!;
  assert.deepEqual([done.state, done.failure], ['failed', 'not_sent']);
  assert.equal(await f.credit('a1'), 'released');
});

test('sponsored call: the credit and the call row commit together (C2)', async (t) => {
  const f = await setup(t);
  const c = await f.calls.start('o1', ask());
  const both = await f.pg.query<{ call: string; credit: string }>(
    `SELECT s.call_id AS call, k.call_id AS credit FROM feed_pay_sponsored_calls s
     JOIN feed_pay_sponsor_credits k ON k.call_id = s.call_id`,
  );
  assert.deepEqual(both.rows, [{ call: c.callId, credit: c.callId }]);
});

test('credit view: the owner sees its agent available, then in progress, then used; and the covered services', async (t) => {
  const f = await setup(t);
  const before = await f.calls.credit('o1');
  assert.deepEqual(before.agents, [{ agentId: 'a1', credit: 'available' }]);
  assert.deepEqual(before.serviceIds, ['svc-1']);
  assert.equal(before.maxPriceRaw, '2000000');
  // Another owner's agents never show.
  assert.deepEqual(
    (await f.calls.credit('o2')).agents.map((a) => a.agentId),
    ['s1'],
  );
  await f.calls.start('o1', ask());
  assert.deepEqual((await f.calls.credit('o1')).agents, [{ agentId: 'a1', credit: 'in_progress' }]);
});

test('GET /api/feed/sponsored-credit: 401 signed out, 404 while off, the owner view when on', async (t) => {
  const f = await setup(t);
  const { default: Fastify } = await import('fastify');
  const { registerSponsoredRoutes, SFP_PATHS } =
    await import('../server/feed/pay/sponsored-routes.js');
  const app = Fastify();
  t.after(() => app.close());
  const env: Record<string, string | undefined> = { ...f.env }; // Feed pay is live unless turned off
  let who: string | null = null;
  registerSponsoredRoutes(app, {
    sponsored: f.calls,
    env,
    person: async () => (who ? { accountId: who } : null),
  });
  const get = () => app.inject({ method: 'GET', url: SFP_PATHS.credit });
  assert.equal((await get()).statusCode, 401);
  who = 'o1';
  const ok = await get();
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.deepEqual(ok.json().agents, [{ agentId: 'a1', credit: 'available' }]);
  env.CITY_SFP_ENABLED = '0';
  assert.equal((await get()).statusCode, 404);
});
