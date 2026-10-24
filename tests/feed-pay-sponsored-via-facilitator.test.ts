import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import type { AuthorizationStore, IssuedAuthorization } from '../server/base/chain/x402.js';
import { router3BatchFromEnv } from '../server/base/chain/runtime.js';
import { feeRef } from '../server/protocol/fees/fee-call.js';
import {
  createRouter3Facilitator,
  encodeSettle,
  router3SettleAbi,
  type Router3Settlement,
} from '../server/protocol/x402/facilitator.js';
import { FEED_PAY_SPONSOR_SQL } from '../server/feed/pay/sponsor-schema.js';
import { createSponsorCredits } from '../server/feed/pay/sponsor.js';
import { createSponsorSigner } from '../server/feed/pay/sponsor-signer.js';
import {
  createSponsoredCalls,
  FEED_PAY_SPONSORED_SQL,
  SFP_SENDER_MIN_ETH_DEFAULT,
  SponsoredRefusal,
  SPONSORED_KEY_PREFIX,
  sponsoredSenderMinEthWei,
  type SponsorPay,
} from '../server/feed/pay/sponsored.js';
import { CHAIN_ID, ROUTER, setup } from './helpers/x402-fake-base.js';

/*
 * CITY_SFP_SEND_VIA_FACILITATOR against the REAL router-3 facilitator: the sponsor only signs the
 * legs (payer = sponsor), the router-3 facilitator's EOA sends the settleBatch (tx_from) on its own
 * nonce lane beside the engine's single settlements, sponsored members in their own batch group.
 * Settlements already stored on the sponsor's own lane are finished there after the switch, and
 * those on the facilitator after a switch back.
 */

const START = 1_000_000_000;
const network = BASE_NETWORKS[84532];
const SFP_GROUP = {
  keyPrefix: SPONSORED_KEY_PREFIX,
  maxItems: 3,
  windowMs: 1_500,
  maxMemberAgeMs: 120_000,
};

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

const senderOf = async (raw: Hex) =>
  (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
const settlementsOf = (raw: Hex): Router3Settlement[] => {
  const decoded = decodeFunctionData({ abi: router3SettleAbi, data: parseTransaction(raw).data! });
  return decoded.functionName === 'settleBatch'
    ? [...(decoded.args[0] as readonly Router3Settlement[])]
    : [decoded.args[0] as Router3Settlement];
};

/**
 * The router-3 facilitator of the fake Base (as runtime builds it with the setting on and no engine
 * allowlist: the sponsored group only), the sponsor's own facilitator on the same database, and the
 * sponsored calls over a mutable SponsorPay.
 */
async function world(t: Parameters<typeof setup>[0], agents = 8) {
  const f = await setup(t, {
    batch: { maxItems: 50, windowMs: 1_500, groups: [SFP_GROUP], groupsOnly: true },
    foreignReadOnly: true,
  });
  await f.pg.exec(`CREATE TABLE base_identities (agent_id text, chain_id integer, state text,
      erc8004_agent_id numeric, started_at bigint, updated_at bigint);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, agent_id text, chain_id integer,
      operator_id text, owner_account_id text, state text);
    CREATE TABLE city_offers (offer_id text PRIMARY KEY, operator_id text, agent_id text, wallet_id text);
    INSERT INTO base_wallets VALUES ('w-s', 's1', 84532, 'ws-s', 'o2', 'deployed');
    INSERT INTO city_offers VALUES ('of_1', 'ws-s', 's1', 'w-s');`);
  await f.pg.exec(FEED_PAY_SPONSOR_SQL);
  await f.pg.exec(FEED_PAY_SPONSORED_SQL);
  for (let i = 1; i <= agents; i++)
    await f.pg
      .exec(`INSERT INTO base_identities VALUES ('a${i}', 84532, 'confirmed', 1, ${START + 1}, 1);
      INSERT INTO base_wallets VALUES ('w-a${i}', 'a${i}', 84532, 'ws-fleet', 'o1', 'deployed');`);
  const env = {
    CITY_SFP_ENABLED: '1',
    CITY_SFP_START_MS: String(START),
    CITY_SFP_FLEET_WORKSPACES: 'ws-fleet',
    CITY_SFP_FLEET_OFFERS: 'of_1',
  };
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const signer = createSponsorSigner({
    network,
    keystore: { withSigner: async (_ref, use) => use(sponsor) },
    keyRef: 'v1:sponsor',
    sponsor: sponsor.address as Address,
    token: network.tokens.USDC!.address as Address,
    store: memoryStore(),
    now: () => f.clock.now,
    router: ROUTER as Address,
    treasuryOf: async () => `0x${'7'.repeat(40)}` as Address,
  });
  // The sponsor's own facilitator (its own key and lane, its whole batch lane sponsored).
  const own = createRouter3Facilitator({
    db: f.db,
    client: f.base.client,
    keystore: { withSigner: async (_ref, use) => use(sponsor) },
    keyRef: 'v1:sponsor',
    router: ROUTER,
    chainId: CHAIN_ID,
    now: () => f.clock.now,
    l1FeeWei: async () => 0n,
    batch: { maxItems: 3, windowMs: 1_500, maxMemberAgeMs: 120_000 },
    foreignReadOnly: true,
  });
  const money = {
    usdcBalance: async () => 1_000_000_000n,
    expiredUnused: async () => false,
  };
  /** CITY_SFP_SEND_VIA_FACILITATOR=1, as runtime.sponsorPay builds it. */
  const on = (shared = f.facilitator, mine = own): SponsorPay => ({
    signer,
    ...money,
    facilitator: shared,
    batch: { group: SPONSORED_KEY_PREFIX },
    previous: [{ facilitator: mine, batch: {} }],
  });
  /** The setting off, as runtime.sponsorPay builds it. */
  const off = (shared: SponsorPay['facilitator'] = f.facilitator): SponsorPay => ({
    signer,
    ...money,
    facilitator: own,
    batch: {},
    previous: [{ facilitator: shared }],
  });
  let pay: SponsorPay = on();
  const logs: string[] = [];
  const calls = createSponsoredCalls({
    log: (line) => logs.push(line),
    db: f.db,
    env,
    now: () => f.clock.now,
    chainId: 84532,
    credits: createSponsorCredits({ db: f.db, env, now: () => f.clock.now }),
    hosted: {
      forSponsor: async () => ({
        offerId: 'of_1',
        kind: 'echo',
        version: 1,
        payTo: `0x${'5'.repeat(40)}`,
        split: { gross: 1_000_000n, fee: 100_000n, net: 900_000n },
        input: '{}',
      }),
      run: async () => ({
        ok: true as const,
        text: '{}',
        mime: 'application/json',
        format: 'json' as const,
      }),
    },
    pay: async () => pay,
  });
  const ask = (agentId: string) => ({
    serviceId: 'svc',
    agentId,
    inputs: {},
    maxAmountRaw: 2_000_000n,
    idempotencyKey: `sfp-${agentId}`,
  });
  const credits = async () =>
    new Map(
      (
        await f.pg.query<{ call_id: string; state: string }>(
          'SELECT call_id, state FROM feed_pay_sponsor_credits',
        )
      ).rows.map((r) => [r.call_id, r.state]),
    );
  return {
    ...f,
    sponsor,
    signer,
    own,
    on,
    off,
    calls,
    ask,
    credits,
    logs,
    setPay: (next: SponsorPay) => {
      pay = next;
    },
  };
}

/** An engine (non-sponsored) single settlement on the router-3 facilitator. */
const engineSettlement = (i: number): Router3Settlement => ({
  payer: `0x${'1'.repeat(40)}`,
  payee: `0x${'2'.repeat(40)}`,
  gross: 1_000_000n + BigInt(i),
  ref: `0x${i.toString(16).padStart(64, '0')}`,
  validAfter: 0n,
  validBefore: 2_000_000_000n,
  sellerSignature: `0x${'cd'.repeat(65)}`,
  feeSignature: `0x${'ef'.repeat(65)}`,
});
const engineSubmit = (
  f: { facilitator: Awaited<ReturnType<typeof setup>>['facilitator'] },
  i: number,
) =>
  f.facilitator.submit({
    key: `feed-pay:pay:c${i}`,
    intentHash: `0x${(i + 0x500).toString(16).padStart(64, '0')}` as Hex,
    settlement: engineSettlement(i),
    beforeBroadcast: async () => {},
  });

test('runtime: the router-3 batch config gets the sponsored group only with the setting', () => {
  assert.equal(router3BatchFromEnv({}), undefined, 'off, no allowlist: no batch config, as before');
  assert.deepEqual(router3BatchFromEnv({ CITY_PAY_BATCH_WORKSPACES: 'ws-1' }), {
    maxItems: 50,
    windowMs: 1_500,
  });
  assert.deepEqual(router3BatchFromEnv({ CITY_SFP_SEND_VIA_FACILITATOR: '1' }), {
    maxItems: 50,
    windowMs: 1_500,
    groups: [{ keyPrefix: 'sfp:', maxItems: 50, windowMs: 1_500, maxMemberAgeMs: 120_000 }],
    groupsOnly: true,
  });
  const both = router3BatchFromEnv({
    CITY_SFP_SEND_VIA_FACILITATOR: '1',
    CITY_PAY_BATCH_WORKSPACES: 'ws-1',
    CITY_SFP_BATCH_MEMBER_AGE_MS: '90000',
  })!;
  assert.equal(both.groupsOnly, undefined, 'the engine lane stays');
  assert.equal(both.maxMemberAgeMs, undefined, 'engine members keep the default age');
  assert.equal(both.groups![0]!.maxMemberAgeMs, 90_000);
  assert.equal(router3BatchFromEnv({ CITY_SFP_SEND_VIA_FACILITATOR: 'yes' }), undefined);
});

test('setting on: ONE settleBatch sent by the facilitator, legs from the sponsor; engine singles unchanged on the same lane', async (t) => {
  const w = await world(t);
  const c1 = await w.calls.start('o1', w.ask('a1'));
  await engineSubmit(w, 1);
  const c2 = await w.calls.start('o1', w.ask('a2'));
  const c3 = await w.calls.start('o1', w.ask('a3'));
  await engineSubmit(w, 2);
  assert.equal(w.base.sends.length, 3, 'engine single, the sponsored batch, engine single');
  const txs = w.base.sends.map((raw) => parseTransaction(raw));
  assert.deepEqual(
    txs.map((tx) => tx.nonce),
    [0, 1, 2],
    'one gapless nonce lane',
  );
  const facilitator = w.account.address.toLowerCase();
  for (const raw of w.base.sends) assert.equal(await senderOf(raw), facilitator, 'tx_from');
  assert.equal(txs[0]!.data, encodeSettle(engineSettlement(1)), 'engine single as before');
  assert.equal(txs[2]!.data, encodeSettle(engineSettlement(2)));
  const batch = settlementsOf(w.base.sends[1]!);
  assert.equal(batch.length, 3, 'the three sponsored buys in one settleBatch');
  for (const s of batch) assert.equal(s.payer.toLowerCase(), w.sponsor.address.toLowerCase());
  assert.notEqual(facilitator, w.sponsor.address.toLowerCase(), 'from != tx_from');
  for (const c of [c1, c2, c3]) {
    const legs = (await w.signer.stored(`sfp:${c.callId}`))!;
    assert.equal(legs.seller.authorization.from, w.sponsor.address);
    assert.equal(legs.fee.authorization.from, w.sponsor.address);
    const r = await w.row(`sfp:${c.callId}`);
    assert.equal(r.facilitator, facilitator, 'stored on the facilitator lane');
    assert.ok(String(r.batch_key).startsWith('batch:sfp:'), 'in the sponsored batch group');
  }
  assert.equal((await w.row('feed-pay:pay:c1')).batch_lane, false, 'engine never batched');
  for (const raw of w.base.sends) w.base.mine(keccak256(raw), 60n);
  for (const c of [c1, c2, c3]) await w.calls.step(c.callId);
  for (const c of [c1, c2, c3])
    assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'paid');
  assert.deepEqual([...(await w.credits()).values()], ['used', 'used', 'used']);
});

test('setting on: a member failing alone goes back to the single path and finishes from the facilitator', async (t) => {
  const w = await world(t);
  const failing: string[] = [];
  w.base.revertWhen = (data) => failing.some((ref) => data.includes(ref));
  const c1 = await w.calls.start('o1', w.ask('a1'));
  const c2 = await w.calls.start('o1', w.ask('a2'));
  failing.push(feeRef(c2.callId).slice(2));
  const c3 = await w.calls.start('o1', w.ask('a3'));
  assert.equal(w.base.sends.length, 1, 'one settleBatch for the batchable members');
  const r2 = await w.row(`sfp:${c2.callId}`);
  assert.equal(r2.batch_key, null);
  assert.equal(r2.batch_lane, false, 'back to the single path');
  assert.equal(r2.status, 'queued');
  failing.length = 0;
  await w.calls.step(c2.callId);
  assert.equal(w.base.sends.length, 2, 'member 2 sent alone');
  const facilitator = w.account.address.toLowerCase();
  for (const raw of w.base.sends) assert.equal(await senderOf(raw), facilitator);
  assert.equal(
    settlementsOf(w.base.sends[1]!)[0]!.payer.toLowerCase(),
    w.sponsor.address.toLowerCase(),
  );
  for (const raw of w.base.sends) w.base.mine(keccak256(raw), 60n);
  for (const c of [c1, c2, c3]) await w.calls.step(c.callId);
  for (const c of [c1, c2, c3])
    assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'paid');
});

test('setting on: the engine flush never judges sponsored members, the sponsored flush never engine ones', async (t) => {
  const w = await world(t);
  const c1 = await w.calls.start('o1', w.ask('a1'));
  // The engine's recover cron flushes the default group with its own authority check.
  const asked: string[] = [];
  await w.facilitator.flushBatches(async (keys) => {
    asked.push(...keys);
    return new Set(keys);
  }, true);
  assert.deepEqual(asked, []);
  assert.equal((await w.row(`sfp:${c1.callId}`)).status, 'queued', 'still waiting');
  // The sponsored worker's pass flushes its group: c1 goes out.
  w.clock.now += 2_000;
  await w.calls.work({ maxCalls: 10, budgetMs: 10_000 });
  assert.equal(w.base.sends.length, 1);
  assert.equal(await senderOf(w.base.sends[0]!), w.account.address.toLowerCase());
});

test('switch on: settlements already on the sponsor lane finish there; new ones go via the facilitator', async (t) => {
  const w = await world(t);
  w.setPay(w.off());
  const old = [];
  for (const a of ['a1', 'a2', 'a3']) old.push(await w.calls.start('o1', w.ask(a)));
  const waiting = await w.calls.start('o1', w.ask('a4'));
  assert.equal(w.base.sends.length, 1, 'one batch from the sponsor lane');
  const sponsorAddr = w.sponsor.address.toLowerCase();
  assert.equal(await senderOf(w.base.sends[0]!), sponsorAddr);
  assert.equal((await w.row(`sfp:${waiting.callId}`)).facilitator, sponsorAddr);
  // CITY_SFP_SEND_VIA_FACILITATOR=1 from here.
  w.setPay(w.on());
  const fresh = [];
  for (const a of ['a5', 'a6', 'a7']) fresh.push(await w.calls.start('o1', w.ask(a)));
  assert.equal(w.base.sends.length, 2);
  assert.equal(await senderOf(w.base.sends[1]!), w.account.address.toLowerCase());
  // The member still waiting on the sponsor lane goes out there (its window over), not elsewhere.
  w.clock.now += 2_000;
  await w.calls.work({ maxCalls: 50, budgetMs: 10_000 });
  assert.equal(w.base.sends.length, 3);
  assert.equal(await senderOf(w.base.sends[2]!), sponsorAddr);
  assert.equal(
    (await w.row(`sfp:${waiting.callId}`)).facilitator,
    sponsorAddr,
    'never moved to another lane',
  );
  for (const raw of w.base.sends) w.base.mine(keccak256(raw), 60n);
  await w.calls.work({ maxCalls: 50, budgetMs: 10_000 });
  for (const c of [...old, waiting, ...fresh])
    assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'paid', c.callId);
  assert.equal([...(await w.credits()).values()].filter((s) => s === 'used').length, 7);
});

test('switch back off: in-flight ops on the facilitator finish; a waiting member is fenced, never sent, credit back', async (t) => {
  const w = await world(t);
  const sent = [];
  for (const a of ['a1', 'a2', 'a3']) sent.push(await w.calls.start('o1', w.ask(a)));
  const waiting = await w.calls.start('o1', w.ask('a4'));
  assert.equal(w.base.sends.length, 1);
  // Unset: the router-3 facilitator is built without a batch config again (no engine allowlist).
  const plain = createRouter3Facilitator({
    db: w.db,
    client: w.base.client,
    keystore: { withSigner: async (_ref, use) => use(w.account) },
    keyRef: 'v1:facilitator',
    router: ROUTER,
    chainId: CHAIN_ID,
    now: () => w.clock.now,
    l1FeeWei: async () => 0n,
  });
  w.setPay(w.off(plain));
  w.base.mine(keccak256(w.base.sends[0]!), 60n);
  await w.calls.work({ maxCalls: 50, budgetMs: 10_000 });
  for (const c of sent) assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'paid');
  // The waiting member: followed where it is, never batched or sent there, nor anywhere else.
  assert.equal((await w.calls.callFor('o1', waiting.callId))!.state, 'sent');
  assert.equal(w.base.sends.length, 1);
  w.clock.now += 21 * 60_000;
  await w.calls.step(waiting.callId);
  const view = (await w.calls.callFor('o1', waiting.callId))!;
  assert.equal(view.state, 'failed');
  const r = await w.row(`sfp:${waiting.callId}`);
  assert.equal(r.never_sent, true);
  assert.equal(w.base.sends.length, 1, 'nothing more was ever sent');
  assert.equal((await w.credits()).get(waiting.callId), 'released');
});

test("setting on: first buys pause on the FACILITATOR's ETH, not the sponsor's", async (t) => {
  const w = await world(t);
  const poor = { ...w.facilitator, canPay: async () => false };
  const rich = { ...w.own, canPay: async () => true };
  w.setPay(w.on(poor, rich));
  await assert.rejects(
    w.calls.start('o1', w.ask('a1')),
    (e: unknown) => e instanceof SponsoredRefusal && e.code === 'unavailable',
  );
  assert.equal((await w.credits()).size, 0, 'nothing reserved');
  w.setPay(w.on(w.facilitator, { ...w.own, canPay: async () => false }));
  const c = await w.calls.start('o1', w.ask('a1'));
  assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'sent');
});

test('S2: the sender ETH floor setting defaults to 0.02 ETH and stays within 0.001 to 1 ETH', () => {
  assert.equal(SFP_SENDER_MIN_ETH_DEFAULT, 20_000_000_000_000_000n);
  assert.equal(sponsoredSenderMinEthWei({}), SFP_SENDER_MIN_ETH_DEFAULT);
  const at = (v: string) => sponsoredSenderMinEthWei({ CITY_SFP_SENDER_MIN_ETH_WEI: v });
  assert.equal(at('5000000000000000'), 5_000_000_000_000_000n);
  assert.equal(at('1000000000000000'), 1_000_000_000_000_000n);
  assert.equal(at('1000000000000000000'), 1_000_000_000_000_000_000n);
  for (const bad of ['999999999999999', '1000000000000000001', '0', '-1', '1e17', 'x', ' '])
    assert.equal(at(bad), SFP_SENDER_MIN_ETH_DEFAULT, bad);
});

test('S2: facilitator ETH between the engine floor and the sponsored floor pauses sponsored buys only', async (t) => {
  const w = await world(t);
  // 0.01 ETH: above the facilitator's own 0.0005 ETH floor, below the sponsored 0.02 ETH.
  w.base.balance = 10_000_000_000_000_000n;
  w.setPay({ ...w.on(), minSenderEthWei: SFP_SENDER_MIN_ETH_DEFAULT });
  await assert.rejects(
    w.calls.start('o1', w.ask('a1')),
    (e: unknown) => e instanceof SponsoredRefusal && e.code === 'unavailable' && e.status === 503,
    'the same paused answer as low USDC',
  );
  assert.ok(
    w.logs.some((l) => JSON.parse(l).event === 'sfp.paused' && JSON.parse(l).why === 'eth'),
  );
  assert.equal((await w.credits()).size, 0, 'nothing reserved');
  // The engine's submit on the same facilitator still goes through.
  const op = await engineSubmit(w, 1);
  assert.equal(op.status, 'submitted');
  assert.equal(w.base.sends.length, 1);
  // Topped up above the sponsored floor: first buys resume.
  w.base.balance = 30_000_000_000_000_000n;
  const c = await w.calls.start('o1', w.ask('a1'));
  assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'sent');
});

test('S2: flag off, the sponsor lane keeps only its own floor', async (t) => {
  const w = await world(t);
  w.base.balance = 10_000_000_000_000_000n;
  w.setPay(w.off());
  const c = await w.calls.start('o1', w.ask('a1'));
  assert.equal((await w.calls.callFor('o1', c.callId))!.state, 'sent');
});

test('S2: a sending facilitator whose ETH cannot be read pauses (fail closed)', async (t) => {
  const w = await world(t);
  const blind = { ...w.facilitator, ethBalance: async () => Promise.reject(new Error('down')) };
  w.setPay({ ...w.on(blind), minSenderEthWei: SFP_SENDER_MIN_ETH_DEFAULT });
  await assert.rejects(
    w.calls.start('o1', w.ask('a1')),
    (e: unknown) => e instanceof SponsoredRefusal && e.code === 'unavailable',
  );
});
