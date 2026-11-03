import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import { registerPublicOfferRoutes } from '../server/feed/offers/public-route.js';
import {
  exactEntry,
  exactPayloadOf,
  payExact,
  PUBLIC_EXACT_TIMEOUT_S,
  recordExactCall,
  type PublicExactDeps,
} from '../server/feed/offers/public-exact.js';
import { PAID_CALL_COUNT_PUBLIC_CHAIN_ID } from '../server/feed/pay/public-calls-schema.js';
import { checkPaidCalls } from '../server/stats/paid-calls.js';
import type { PublicHostedOffer } from '../server/feed/offers/public-pay.js';
import type { SettleAnswer, VerifyAnswer } from '../server/protocol/x402/public-facilitator.js';

const SELLER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const SENDER = '0x3333333333333333333333333333333333333333';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OFFER_ID = 'off_abcdefghijklmnop';
const NONCE = `0x${'ab'.repeat(32)}`;

const offer: PublicHostedOffer = {
  offerId: OFFER_ID,
  kind: 'csv-to-json',
  version: 1,
  payTo: SELLER,
  split: { gross: 60_000n, fee: 6_000n, net: 54_000n },
  input: 'a,b\n1,2',
};

/** A v2 payment header as a stock x402 client sends it. */
function header(overrides: { to?: string; value?: string; scheme?: string; nonce?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 2,
    accepted: { scheme: overrides.scheme ?? 'exact', network: 'eip155:8453' },
    payload: {
      signature: `0x${'cd'.repeat(65)}`,
      authorization: {
        from: PAYER,
        to: overrides.to ?? SELLER,
        value: overrides.value ?? '60000',
        validAfter: String(now - 10),
        validBefore: String(now + 200),
        nonce: overrides.nonce ?? NONCE,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function fakes(options: { verify?: VerifyAnswer; settle?: SettleAnswer; run?: boolean } = {}) {
  const calls = {
    verify: 0,
    settle: 0,
    run: 0,
    claims: new Set<string>(),
    admitted: new Set<string>(),
    recorded: [] as string[],
  };
  const deps: PublicExactDeps = {
    verify: async () => {
      calls.verify++;
      return options.verify ?? { isValid: true, payer: PAYER };
    },
    sender: () => ({
      address: SENDER,
      settle: async () => {
        calls.settle++;
        return (
          options.settle ?? {
            success: true,
            transaction: `0x${'ee'.repeat(32)}`,
            network: 'eip155:8453',
            payer: PAYER,
          }
        );
      },
    }),
    claim: async (payer, nonce) => {
      const key = `${payer}:${nonce}`;
      if (calls.claims.has(key)) return false;
      calls.claims.add(key);
      return true;
    },
    // One call per payer at a time, as the shared limiter's one-a-minute key.
    admit: async (payer) => {
      if (calls.admitted.has(payer)) return false;
      calls.admitted.add(payer);
      return true;
    },
    record: async (call) => {
      calls.recorded.push(`${call.payer}:${call.nonce}:${call.txHash}:${call.serviceId}`);
    },
    run: async () => {
      calls.run++;
      return options.run === false
        ? { ok: false as const, failure: 'kind_failed' }
        : {
            ok: true as const,
            text: '[{"a":"1","b":"2"}]',
            mime: 'application/json',
            format: 'json' as const,
          };
    },
  };
  return { deps, calls };
}

// Base mainnet is known only behind its gate, as in production.
const BASE_ON = { CITY_BASE_MAINNET: '1' };
const entry = exactEntry(offer, 8453, BASE_ON)!;
const challenge = (error: string) => ({ status: 402, json: { error } });

test('the exact entry pays the seller the full price in Base USDC, with USDC’s own domain', () => {
  assert.equal(entry.scheme, 'exact');
  assert.equal(entry.network, 'eip155:8453');
  assert.equal(entry.payTo, SELLER);
  assert.equal(entry.amount, '60000');
  assert.equal(entry.asset.toLowerCase(), USDC.toLowerCase());
  assert.equal(entry.maxTimeoutSeconds, PUBLIC_EXACT_TIMEOUT_S);
  assert.equal(entry.extra.assetTransferMethod, 'eip3009');
  assert.ok(entry.extra.name && entry.extra.version);
});

test('only an exact payment header is read by this lane', () => {
  assert.ok(exactPayloadOf({ 'payment-signature': header() }));
  assert.equal(
    exactPayloadOf({ 'payment-signature': header({ scheme: 'cc-router3-split-v1' }) }),
    null,
  );
  assert.equal(exactPayloadOf({}), null);
  assert.equal(exactPayloadOf({ 'x-payment': 'not base64 json' }), null);
});

test('paid: verified, run once, settled, and the result goes back with the settlement', async () => {
  const { deps, calls } = fakes();
  const payload = exactPayloadOf({ 'payment-signature': header() })!;
  const answer = await payExact({
    deps,
    offer,
    entry,
    payload,
    client: 'c',
    serviceId: 'svc_x',
    challenge,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.text?.body, '[{"a":"1","b":"2"}]');
  assert.ok(answer.headers?.['PAYMENT-RESPONSE']);
  assert.deepEqual([calls.verify, calls.run, calls.settle], [1, 1, 1]);
  assert.deepEqual(calls.recorded, [`${PAYER}:${NONCE}:0x${'ee'.repeat(32)}:svc_x`]);
});

test('two payments from one payer at once, fresh nonces each: the kind runs once', async () => {
  const { deps, calls } = fakes();
  const first = exactPayloadOf({ 'payment-signature': header({ nonce: `0x${'01'.repeat(32)}` }) })!;
  const second = exactPayloadOf({
    'payment-signature': header({ nonce: `0x${'02'.repeat(32)}` }),
  })!;
  const answers = await Promise.all(
    [first, second].map((payload) =>
      payExact({ deps, offer, entry, payload, client: 'c', serviceId: 'svc_x', challenge }),
    ),
  );
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 402]);
  assert.equal(
    (answers.find((a) => a.status === 402)!.json as { error: string }).error,
    'payer_busy',
  );
  assert.deepEqual([calls.run, calls.settle], [1, 1]);
});

test('a replay of the same payment never runs the kind again', async () => {
  const { deps, calls } = fakes();
  const payload = exactPayloadOf({ 'payment-signature': header() })!;
  await payExact({ deps, offer, entry, payload, client: 'c', serviceId: 'svc_x', challenge });
  // The payer's minute has passed: only the claim on this authorization can refuse it now.
  calls.admitted.clear();
  const again = await payExact({
    deps,
    offer,
    entry,
    payload,
    client: 'c',
    serviceId: 'svc_x',
    challenge,
  });
  assert.equal(again.status, 402);
  assert.equal((again.json as { error: string }).error, 'payment_already_used');
  assert.deepEqual([calls.run, calls.settle], [1, 1]);
});

test('a payment to someone else or for another amount is refused before anything runs', async () => {
  for (const wrong of [{ to: PAYER }, { value: '59999' }, { value: '60001' }]) {
    const { deps, calls } = fakes();
    const payload = exactPayloadOf({ 'payment-signature': header(wrong) })!;
    const answer = await payExact({
      deps,
      offer,
      entry,
      payload,
      client: 'c',
      serviceId: 'svc_x',
      challenge,
    });
    assert.equal(answer.status, 402, JSON.stringify(wrong));
    // The binding is the facilitator's verify; its refusal stops the lane before the kind runs.
    assert.equal(calls.run, 0);
    assert.equal(calls.settle, 0);
  }
});

test('nothing is charged when the payment is invalid, the kind fails or the transfer does not settle', async () => {
  const invalid = fakes({ verify: { isValid: false, invalidReason: 'insufficient_funds' } });
  const payload = exactPayloadOf({ 'payment-signature': header() })!;
  const refused = await payExact({
    deps: invalid.deps,
    offer,
    entry,
    payload,
    client: 'c',
    serviceId: 'svc_x',
    challenge,
  });
  assert.equal(refused.status, 402);
  assert.deepEqual([invalid.calls.run, invalid.calls.settle], [0, 0]);

  const failing = fakes({ run: false });
  const failed = await payExact({
    deps: failing.deps,
    offer,
    entry,
    payload,
    client: 'c',
    serviceId: 'svc_x',
    challenge,
  });
  assert.equal(failed.status, 502);
  assert.equal(failing.calls.settle, 0);

  const unsettled = fakes({
    settle: {
      success: false,
      errorReason: 'invalid_transaction_state',
      transaction: '',
      network: 'eip155:8453',
    },
  });
  const notPaid = await payExact({
    deps: unsettled.deps,
    offer,
    entry,
    payload,
    client: 'c',
    serviceId: 'svc_x',
    challenge,
  });
  assert.equal(notPaid.status, 402);
  assert.equal(notPaid.text, undefined);
});

test('a paid exact call is stored once with no fee and counts once, also for the daily check', async (t) => {
  const app = await createApp({ dataDir: 'memory://', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const at = Date.now();
  await db.query(
    `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
       description, tags, price_raw, discoverable, version, state, idem_key, risky,
       price_changed_at, created_at, updated_at)
     VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, 'csv-to-json', 'CSV to JSON',
       '', '{}', 60000, true, 1, 'active', $1, NULL, $3, $3, $3)`,
    [OFFER_ID, SELLER, at],
  );
  const count = async () =>
    (
      await db.query<{ total: string; value: string }>(
        'SELECT total::text, value_raw::text AS value FROM paid_call_count WHERE chain_id = $1',
        [PAID_CALL_COUNT_PUBLIC_CHAIN_ID],
      )
    ).rows[0] ?? { total: '0', value: '0' };
  const before = await count();
  const call = {
    serviceId: 'svc_x',
    offer,
    payer: PAYER,
    nonce: NONCE,
    client: 'c',
    validAfter: 1n,
    validBefore: 2n,
    txHash: `0x${'ee'.repeat(32)}`,
  };
  await recordExactCall(db, () => at, call);
  // The same authorization again (a retried save) stores and counts nothing more.
  await recordExactCall(db, () => at, call);
  const { rows } = await db.query<{ scheme: string; fee: string; state: string; agent: string }>(
    `SELECT scheme, fee_raw::text AS fee, state, agent_id AS agent FROM feed_pay_public_calls`,
  );
  assert.deepEqual(rows, [
    { scheme: 'exact', fee: '0', state: 'delivered', agent: 'agent-seller' },
  ]);
  const after = await count();
  assert.equal(BigInt(after.total) - BigInt(before.total), 1n);
  assert.equal(BigInt(after.value) - BigInt(before.value), 60_000n);
  // The daily check agrees with the counter: nothing to repair.
  const checked = await checkPaidCalls(db, { chainId: PAID_CALL_COUNT_PUBLIC_CHAIN_ID });
  assert.equal((await count()).total, after.total, JSON.stringify(checked));
  // A router 3 call still needs its fee: the relaxed check is for the exact scheme only.
  await assert.rejects(
    db.query(
      `INSERT INTO feed_pay_public_calls (call_id, payer, ref, input_hash, client_key, service_id,
         offer_id, offer_kind, offer_version, operator_id, agent_id, pay_to, gross_raw, fee_raw,
         state, op_key, valid_after, valid_before, created_at, updated_at)
       VALUES ('xp_aaaaaaaaaaaaaaaaaaaa', $1, 'r2', 'h', 'c', 's', $2, 'csv-to-json', 1, 'o', 'a',
         $3, 60000, 0, 'reserved', 'x402pub:xp_aaaaaaaaaaaaaaaaaaaa', 1, 2, 1, 1)`,
      [PAYER, OFFER_ID, SELLER],
    ),
  );
});

test('the route offers exact first only while its setting is on, and pays it through the lane', async (t) => {
  const build = (env: Record<string, string | undefined>) => {
    const app = Fastify();
    t.after(() => app.close());
    const { deps, calls } = fakes();
    registerPublicOfferRoutes(app, {
      env: {
        ...BASE_ON,
        CITY_X402_PUBLIC_OFFERS: '1',
        CITY_X402_PUBLIC_OFFERS_ALLOW: '*',
        CITY_FEE_ROUTER3: '0x4444444444444444444444444444444444444444',
        CITY_FEE_ROUTER3_ENABLED: '1',
        CITY_PROTOCOL_TREASURY: '0x5555555555555555555555555555555555555555',
        ...env,
      },
      chainId: 8453,
      origin: () => 'https://centralcity.ai',
      serviceIdOf: () => 'svc_x',
      hosted: async () => offer,
      limit: async () => {},
      exact: deps,
    });
    return { app, calls };
  };
  const ask = (app: ReturnType<typeof Fastify>, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/public/x402/${OFFER_ID}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: '{}',
    });

  const off = build({});
  const offAnswer = await ask(off.app);
  const offSchemes = (offAnswer.json().accepts ?? []).map((a: { scheme: string }) => a.scheme);
  assert.ok(!offSchemes.includes('exact'), offAnswer.body);

  const on = build({ CITY_X402_PUBLIC_OFFERS_EXACT: '1' });
  const challengeAnswer = await ask(on.app);
  if (challengeAnswer.statusCode === 402) {
    assert.equal(challengeAnswer.json().accepts[0].scheme, 'exact');
    assert.equal(challengeAnswer.json().accepts[0].payTo, SELLER);
  }
  const paid = await ask(on.app, { 'payment-signature': header() });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.body, '[{"a":"1","b":"2"}]');
  assert.deepEqual([on.calls.run, on.calls.settle], [1, 1]);
});
