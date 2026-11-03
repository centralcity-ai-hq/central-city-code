/**
 * Money path review 4 (sponsored first purchase): the fixes for two Low findings. Each test FAILED
 * on the code before its fix (where the defect was present) and passes after it.
 * PGlite + doubles only: no chain, RPC, seller or network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import type { AuthorizationStore, IssuedAuthorization } from '../server/base/chain/x402.js';
import type { FeedPayOp } from '../server/base/chain/feed-pay-chain.js';
import type { Router3FacilitatorPort } from '../server/feed/pay/router3.js';
import { FEED_PAY_SPONSOR_SQL } from '../server/feed/pay/sponsor-schema.js';
import { FEED_PAY_SPONSORED_CHAIN_COLUMN_SQL } from '../server/feed/pay/sponsored-count-schema.js';
import { FEED_PAY_SPONSOR_FLEET_CEILING_SQL } from '../server/feed/pay/sponsor-ceiling-schema.js';
import { createSponsorCredits } from '../server/feed/pay/sponsor.js';
import { createSponsorSigner, pgSponsorReservations } from '../server/feed/pay/sponsor-signer.js';
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
  await pg.exec(FEED_PAY_SPONSORED_CHAIN_COLUMN_SQL);
  await pg.exec(FEED_PAY_SPONSOR_FLEET_CEILING_SQL);
  // o1: verified, onboarded owner of agent a1. o3: a signed-in owner with NO verified identity
  // (never eligible for a credit) and its own agent a3. Seller s1 belongs to o2.
  await pg.exec(`INSERT INTO operators VALUES ('o1','x','owner'), ('o2','x','owner'), ('o3','x','owner');
    INSERT INTO elric_verified_identities VALUES ('o1');
    INSERT INTO account_terms_acceptances VALUES ('o1', '${TERMS_VERSION}');
    INSERT INTO base_identities VALUES ('a1', 8453, 'confirmed', 1, ${START + 1}, ${START + 1});
    INSERT INTO base_wallets VALUES ('w-a1', 'a1', 8453, 'ws1', 'o1', 'deployed');
    INSERT INTO base_wallets VALUES ('w-a3', 'a3', 8453, 'ws3', 'o3', 'deployed');
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
    reservationOf: (key) => pgSponsorReservations(db)(key),
  });
  // Facilitator double that counts the live Base reads it would make (canPay/ethBalance read the
  // EOA's balance from the node on every call, server/protocol/x402/facilitator.ts:1731).
  const reads = { canPay: 0, ethBalance: 0, usdc: 0 };
  /** Runs at the first Base read of a start (after its database pre-check). */
  const hooks: { beforeBalance?: () => Promise<void> } = {};
  const status = new Map<string, FeedPayOp>();
  const facilitator: Router3FacilitatorPort = {
    submit: async (input) => {
      const op: FeedPayOp = {
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
    canPay: async () => {
      await hooks.beforeBalance?.();
      reads.canPay += 1;
      return true;
    },
    ethBalance: async () => {
      reads.ethBalance += 1;
      return 10n ** 18n;
    },
    flushBatches: async () => {},
  };
  const realCredits = createSponsorCredits({ db, env, now: () => clock.now });
  /** When set, the next credits.release throws once (a transient database error). */
  const faults = { releaseFailsOnce: false };
  const credits: typeof realCredits = {
    ...realCredits,
    release: async (callId, tx) => {
      if (faults.releaseFailsOnce) {
        faults.releaseFailsOnce = false;
        throw new Error('connection terminated unexpectedly');
      }
      return realCredits.release(callId, tx);
    },
  };
  const gate = { answer: null as string | null };
  const calls = createSponsoredCalls({
    db,
    env,
    now: () => clock.now,
    chainId: 8453,
    credits,
    hosted: {
      forSponsor: async () => ({
        offerId: 'of_1',
        kind: 'echo',
        version: 1,
        payTo: PAYEE,
        split: { gross: 1_500_000n, fee: 150_000n, net: 1_350_000n },
        input: '{"q":"hi"}',
      }),
      run: async () => ({
        ok: true as const,
        text: '{"a":1}',
        mime: 'application/json',
        format: 'json' as const,
      }),
    },
    pay: async () => ({
      signer,
      facilitator,
      // As with CITY_SFP_SEND_VIA_FACILITATOR=1 (runtime.ts:634): the sender's ETH is read too.
      minSenderEthWei: 20_000_000_000_000_000n,
      usdcBalance: async () => {
        reads.usdc += 1;
        return 1_000_000_000n;
      },
      expiredUnused: async () => false,
    }),
    preSign: async () => gate.answer,
  });
  const creditRow = async (agentId: string) =>
    (
      await pg.query<{ state: string; call_id: string }>(
        'SELECT state, call_id FROM feed_pay_sponsor_credits WHERE agent_id = $1',
        [agentId],
      )
    ).rows[0] ?? null;
  const daySpent = async () =>
    (
      await pg.query<{ spent: string }>(
        'SELECT spent_raw::text AS spent FROM feed_pay_sponsor_days',
      )
    ).rows[0]?.spent ?? '0';
  return { pg, clock, calls, creditRow, daySpent, faults, gate, hooks, reads };
}

const ask = (agentId: string, key: string) => ({
  serviceId: 'svc-1',
  agentId,
  inputs: { body: { q: 'hi' } },
  maxAmountRaw: 2_000_000n,
  idempotencyKey: key,
});

/** A sponsored call row and its credit, written directly (states the normal flow could leave). */
async function plant(
  f: Awaited<ReturnType<typeof setup>>,
  input: { callId: string; agentId: string; owner: string; call: string; credit: string },
) {
  const at = f.clock.now;
  await f.pg.query(
    `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key, request_hash,
       operator_id, agent_id, service_id, offer_id, offer_kind, offer_version, pay_to, gross_raw,
       fee_raw, input, state, op_key, created_at, updated_at)
     VALUES ($1, $2, $1, '0x', 'ws', $3, 'svc-1', 'of_1', 'echo', 1, $4, 1500000, 150000, '{}', $5,
       'sfp:' || $1, $6, $6)`,
    [input.callId, input.owner, input.agentId, PAYEE, input.call, at],
  );
  await f.pg.query(
    `INSERT INTO feed_pay_sponsor_credits (agent_id, chain_id, owner_account_id, call_id, amount_raw,
       state, created_at, updated_at) VALUES ($1, 8453, $2, $3, 1500000, $4, $5, $5)`,
    [input.agentId, input.owner, input.callId, input.credit, at],
  );
}

const callState = async (f: Awaited<ReturnType<typeof setup>>, callId: string) =>
  (
    await f.pg.query<{ state: string }>(
      'SELECT state FROM feed_pay_sponsored_calls WHERE call_id = $1',
      [callId],
    )
  ).rows[0]?.state ?? null;

test('mpr-4 stranded credit (atomic): a release write that fails once never strands the credit of a failed call', async (t) => {
  const f = await setup(t);
  // The engine's pre-send checks refuse the payment and the credit release right after hits a
  // transient database error. Fixed: failing the call and releasing its credit are ONE
  // transaction, so neither commits; the call stays open and the next step ends it cleanly.
  f.gate.answer = 'screening_blocked';
  f.faults.releaseFailsOnce = true;
  const first = await f.calls.start('o1', ask('a1', 'k1'));
  assert.equal(first.payment.txHash, null);
  // Never a failed call holding a reserved credit, at any point.
  assert.notEqual(first.state, 'failed');
  assert.equal((await f.creditRow('a1'))?.state, 'reserved');
  // The next cron pass refuses it again (key already fenced): failed AND released together.
  assert.equal(await f.calls.work({ maxCalls: 100, budgetMs: 5_000 }), 1);
  assert.equal(await callState(f, first.callId), 'failed');
  assert.equal((await f.creditRow('a1'))?.state, 'released');
  assert.equal((await f.creditRow('a1'))?.call_id, first.callId);
  assert.equal(await f.daySpent(), '0');
  // The agent's one sponsored purchase is still there.
  const view = await f.calls.credit('o1');
  assert.deepEqual(
    view.agents.find((a) => a.agentId === 'a1'),
    { agentId: 'a1', credit: 'available' },
  );
  f.gate.answer = null;
  const again = await f.calls.start('o1', ask('a1', 'k2'));
  assert.notEqual(again.callId, first.callId);
  assert.equal((await f.creditRow('a1'))?.call_id, again.callId);
});

test('mpr-4 stranded credit (sweep): the cron releases a credit left reserved on a failed call, never a paid or used one', async (t) => {
  const f = await setup(t);
  // A call failed (pre-send refusal) and its credit released, then the credit put back to what
  // the old two-write path left after a failed release: reserved, with the day still counting it.
  f.gate.answer = 'screening_blocked';
  const first = await f.calls.start('o1', ask('a1', 'k1'));
  assert.equal(first.state, 'failed');
  await f.pg.exec(`UPDATE feed_pay_sponsor_credits SET state = 'reserved' WHERE agent_id = 'a1';
    UPDATE feed_pay_sponsor_days SET spent_raw = spent_raw + 1500000, credits = credits + 1;`);
  assert.equal(await f.daySpent(), '1500000');
  // Credits the sweep must never touch: a paid (delivered) call whose credit was not yet marked
  // used, a paid_no_result one, and a used credit (whatever its call row says).
  await plant(f, {
    callId: 'sp_paid',
    agentId: 'b1',
    owner: 'o9',
    call: 'delivered',
    credit: 'reserved',
  });
  await plant(f, {
    callId: 'sp_nores',
    agentId: 'b2',
    owner: 'o9',
    call: 'paid_no_result',
    credit: 'reserved',
  });
  await plant(f, { callId: 'sp_used', agentId: 'b3', owner: 'o9', call: 'failed', credit: 'used' });
  f.gate.answer = null;
  assert.equal(await f.calls.work({ maxCalls: 100, budgetMs: 5_000 }), 1);
  assert.equal((await f.creditRow('a1'))?.state, 'released');
  assert.equal((await f.creditRow('a1'))?.call_id, first.callId);
  assert.equal(await f.daySpent(), '0');
  assert.equal((await f.creditRow('b1'))?.state, 'reserved');
  assert.equal((await f.creditRow('b2'))?.state, 'reserved');
  assert.equal((await f.creditRow('b3'))?.state, 'used');
  assert.equal(await callState(f, 'sp_paid'), 'delivered');
  // Idempotent: a second pass changes nothing (the day is not given the amount back twice).
  assert.equal(await f.calls.work({ maxCalls: 100, budgetMs: 5_000 }), 0);
  assert.equal(await f.daySpent(), '0');
  assert.equal((await f.creditRow('b1'))?.state, 'reserved');
  // The agent may use its credit again.
  const again = await f.calls.start('o1', ask('a1', 'k2'));
  assert.equal((await f.creditRow('a1'))?.call_id, again.callId);
});

test('mpr-4 reads before eligibility: requests that can never hold a credit make no Base read; the in-lock checks still decide', async (t) => {
  const f = await setup(t);
  const n = 25;
  for (let i = 0; i < n; i++) {
    // o3 has no verified identity: refused 'unverified_owner' every time. A fresh idempotency key
    // per request skips the stored-call short cut.
    await assert.rejects(
      f.calls.start('o3', ask('a3', `spam-${i}`)),
      (e: unknown) => e instanceof SponsoredRefusal && e.reason === 'unverified_owner',
    );
    f.clock.now += 11_000; // past the 10 s USDC balance cache
  }
  // Fixed: the database checks run first, so none of them read Base (ETH or USDC).
  assert.deepEqual(f.reads, { canPay: 0, ethBalance: 0, usdc: 0 });
  assert.equal((await f.pg.query('SELECT 1 FROM feed_pay_sponsored_calls')).rows.length, 0);
  // Each refusal is still counted once in the ops stats.
  const { rows } = await f.pg.query<{ n: number }>(
    "SELECT SUM(n)::int AS n FROM feed_pay_sponsor_refusals WHERE code = 'unverified_owner'",
  );
  assert.equal(rows[0]?.n, n);
  // A request that can reserve reads Base as before, once.
  const ok = await f.calls.start('o1', ask('a1', 'ok-1'));
  assert.equal((await f.creditRow('a1'))?.call_id, ok.callId);
  assert.deepEqual(f.reads, { canPay: 1, ethBalance: 1, usdc: 1 });
  // A credit already held: refused 'used' before any Base read.
  await assert.rejects(
    f.calls.start('o1', ask('a1', 'ok-2')),
    (e: unknown) => e instanceof SponsoredRefusal && e.reason === 'used',
  );
  assert.deepEqual(f.reads, { canPay: 1, ethBalance: 1, usdc: 1 });
});

test('mpr-4 reads before eligibility: a credit taken between the pre-check and the lock is still refused under the lock', async (t) => {
  const f = await setup(t);
  // The pre-check passes (credit free); while this request reads Base, another call for the same
  // agent takes the credit. reserve() checks again under its lock: refused 'used', nothing stored.
  let raced = false;
  f.hooks.beforeBalance = async () => {
    if (raced) return;
    raced = true;
    await f.pg.query(
      `INSERT INTO feed_pay_sponsor_credits (agent_id, chain_id, owner_account_id, call_id,
         amount_raw, state, created_at, updated_at) VALUES ('a1', 8453, 'o1', 'sp_other', 1500000,
         'reserved', $1, $1)`,
      [f.clock.now],
    );
  };
  await assert.rejects(
    f.calls.start('o1', ask('a1', 'race-1')),
    (e: unknown) => e instanceof SponsoredRefusal && e.reason === 'used',
  );
  assert.equal(raced, true);
  assert.equal((await f.creditRow('a1'))?.call_id, 'sp_other');
  assert.equal((await f.pg.query('SELECT 1 FROM feed_pay_sponsored_calls')).rows.length, 0);
});
