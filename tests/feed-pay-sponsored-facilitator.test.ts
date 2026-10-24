import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import type { AuthorizationStore, IssuedAuthorization } from '../server/base/chain/x402.js';
import { feeRef } from '../server/protocol/fees/fee-call.js';
import { FEED_PAY_SPONSOR_SQL } from '../server/feed/pay/sponsor-schema.js';
import { createSponsorCredits } from '../server/feed/pay/sponsor.js';
import { createSponsorSigner } from '../server/feed/pay/sponsor-signer.js';
import { createSponsoredCalls, FEED_PAY_SPONSORED_SQL } from '../server/feed/pay/sponsored.js';
import { ROUTER, setup } from './helpers/x402-fake-base.js';

/*
 * The sponsored first purchase against the REAL router-3 facilitator (review SFP #14): sponsor
 * members join its batch lane (grant null) and go out in one settleBatch; a member the facilitator
 * moves back to the single path (it fails alone while the batch is built) is handed over again by
 * the sponsored worker under the same key, with the very same signed pair, and then finishes.
 */

const START = 1_000_000_000;
const network = BASE_NETWORKS[84532];

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

test('sponsored buys ride the real facilitator batch lane; a member sent back to single finishes', async (t) => {
  const f = await setup(t, { batch: { maxItems: 3, windowMs: 1_500 } });
  await f.pg.exec(`CREATE TABLE base_identities (agent_id text, chain_id integer, state text,
      erc8004_agent_id numeric, started_at bigint, updated_at bigint);
    CREATE TABLE base_wallets (wallet_id text PRIMARY KEY, agent_id text, chain_id integer,
      operator_id text, owner_account_id text, state text);
    CREATE TABLE city_offers (offer_id text PRIMARY KEY, operator_id text, agent_id text, wallet_id text);
    INSERT INTO base_wallets VALUES ('w-s', 's1', 84532, 'ws-s', 'o2', 'deployed');
    INSERT INTO city_offers VALUES ('of_1', 'ws-s', 's1', 'w-s');`);
  await f.pg.exec(FEED_PAY_SPONSOR_SQL);
  await f.pg.exec(FEED_PAY_SPONSORED_SQL);
  for (const a of ['a1', 'a2', 'a3'])
    await f.pg
      .exec(`INSERT INTO base_identities VALUES ('${a}', 84532, 'confirmed', 1, ${START + 1}, 1);
      INSERT INTO base_wallets VALUES ('w-${a}', '${a}', 84532, 'ws-fleet', 'o1', 'deployed');`);
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
  const calls = createSponsoredCalls({
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
    pay: async () => ({
      signer,
      facilitator: f.facilitator,
      usdcBalance: async () => 1_000_000_000n,
      expiredUnused: async () => false,
    }),
  });
  const ask = (agentId: string) => ({
    serviceId: 'svc',
    agentId,
    inputs: {},
    maxAmountRaw: 2_000_000n,
    idempotencyKey: `sfp-${agentId}`,
  });
  // Member 2 fails alone while its batch is built: the facilitator sends it back to single.
  const failing: string[] = [];
  f.base.revertWhen = (data) => failing.some((ref) => data.includes(ref));
  const c1 = await calls.start('o1', ask('a1'));
  const c2 = await calls.start('o1', ask('a2'));
  failing.push(feeRef(c2.callId).slice(2));
  const c3 = await calls.start('o1', ask('a3'));
  assert.equal(f.base.sends.length, 1, 'one settleBatch for the batchable members');
  const r1 = await f.row(`sfp:${c1.callId}`);
  const r2 = await f.row(`sfp:${c2.callId}`);
  assert.ok(String(r1.batch_key).startsWith('batch:'), 'member 1 rode the batch');
  assert.equal(r2.batch_key, null);
  assert.equal(r2.batch_lane, false, 'member 2 back to the single path');
  assert.equal(r2.status, 'queued');
  const signedBefore = (await signer.stored(`sfp:${c2.callId}`))!;
  // Fixed on Base: the worker hands the same key over again and it goes out alone.
  failing.length = 0;
  await calls.step(c2.callId);
  assert.equal(f.base.sends.length, 2, 'member 2 sent alone');
  const signedAfter = (await signer.stored(`sfp:${c2.callId}`))!;
  assert.equal(signedAfter.seller.signature, signedBefore.seller.signature, 'the same signed pair');
  // Mined: every call pays, and its credit is used for good.
  for (const raw of f.base.sends) f.base.mine(keccak256(raw), 60n);
  for (const c of [c1, c2, c3]) await calls.step(c.callId);
  for (const c of [c1, c2, c3]) assert.equal((await calls.callFor('o1', c.callId))!.state, 'paid');
  const credits = await f.pg.query<{ state: string }>('SELECT state FROM feed_pay_sponsor_credits');
  assert.deepEqual(
    credits.rows.map((r) => r.state),
    ['used', 'used', 'used'],
  );
});
