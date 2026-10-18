import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress } from 'viem';
import {
  FEED_PAY_NOT_PAYABLE,
  FEED_PAY_NOT_PAYABLE_MESSAGES,
  FEED_PAY_PATHS,
  type FeedPayCall,
} from '../shared/feed-pay.js';
import { PayFailure } from '../src/feed/payApi.js';
import {
  notPayableBody,
  notPayableView,
  OWN_SERVICE_TITLE,
  refusalText,
} from '../src/feed/pay/payModel.js';
import { BODY, CHAIN_ID, json, setup, SVC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * Feed pay: an agent never pays its own listing (own_service). A listing whose pay_to is the
 * paying agent's own wallet or its spender account is refused in the quote (when the quote names
 * the agent) and in the call (Feed and MCP alike), before anything is reserved or signed. Another
 * agent of the same owner may pay it. The real app, engine and chain side against a fake x402
 * service and a fake Base (tests/helpers/feed-pay-app.ts). Synthetic data, no network.
 */

/** A Feed price check that names the agent that would pay. */
async function quoteFor(f: FeedPayApp, agentId: string, inputs: unknown = BODY) {
  f.advance(6_100);
  return f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.quote.replace(':id', SVC),
    headers: { ...json, cookie: f.owner.cookie },
    payload: JSON.stringify({ inputs, agentId }),
  });
}

/** Everything the engine stores, signs or sends for a payment. */
async function traces(f: FeedPayApp) {
  const [calls] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_calls');
  const [payments] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM base_payments');
  return {
    calls: Number(calls!.n),
    payments: Number(payments!.n),
    requests: f.service.requests.length,
    paid: f.service.paid().length,
    signatures: f.base.state.signatures,
    sends: f.base.state.sends.length,
  };
}

/** A second agent of the same owner, with its own wallet on Base (synthetic addresses). */
async function secondAgent(f: FeedPayApp) {
  const created = await f.tool(f.main.token, 'city_create_agent', {
    name: 'qpmt',
    description: 'Synthetic agent',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const agentId = created.json().agent.id as string;
  const wallet = getAddress(`0x${'b1'.repeat(20)}`);
  await f.sql(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at,
       owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000002', '{}',
       'derived', 1, 1, $3)`,
    [
      `wallet-${agentId}`,
      agentId,
      f.owner.id,
      CHAIN_ID,
      wallet,
      f.ownerKey.address,
      getAddress(`0x${'c2'.repeat(20)}`),
    ],
  );
  return { agentId, wallet };
}

test('own_service: the reason, its sentence and how the page shows it', () => {
  assert.ok(FEED_PAY_NOT_PAYABLE.includes('own_service'));
  const sentence = FEED_PAY_NOT_PAYABLE_MESSAGES.own_service;
  assert.match(sentence, /own wallet/);
  assert.doesNotMatch(sentence, /[→↗›⟶]/);
  // No address to copy and nothing that passes by itself: the person picks another agent.
  assert.deepEqual(notPayableView('own_service'), {
    title: OWN_SERVICE_TITLE,
    tone: 'warn',
    copy: false,
    checkAgain: false,
  });
  assert.equal(notPayableBody('own_service'), notPayableBody('own_service').trim());
  // A call refused with it: the sentence, then that nothing was paid.
  const text = refusalText(new PayFailure(409, 'not_payable', false, { reason: 'own_service' }));
  assert.match(text, /own wallet/);
  assert.match(text, /Nothing was paid\.$/);
});

test('an agent never pays its own listing: refused in quote and call, nothing reserved or signed', async (t) => {
  const f = await setup(t);
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);

  // The listing is paid to the agent's own wallet (another case: a lowercased pay_to).
  for (const payTo of [f.wallet, f.wallet.toLowerCase(), f.base.spender]) {
    await f.list({ payTo });
    const before = await traces(f);

    // The price check that names the agent: not payable, and the service is not even asked.
    const quoted = await quoteFor(f, f.agentId);
    assert.equal(quoted.statusCode, 200, quoted.body);
    assert.deepEqual(quoted.json(), {
      payable: false,
      serviceId: SVC,
      reason: 'own_service',
      message: FEED_PAY_NOT_PAYABLE_MESSAGES.own_service,
    });
    assert.deepEqual(await traces(f), before);

    // A page that does not name the agent gets a price; the call is still refused.
    const priced = await f.quote();
    assert.equal(priced.statusCode, 200, priced.body);
    assert.equal(priced.json().payable, true);
    const asked = await traces(f);
    const res = await f.callService({
      agentId: f.agentId,
      inputs: BODY,
      quoteId: priced.json().quoteId,
      maxAmountRaw: priced.json().amount.raw,
      maxTotalRaw: priced.json().total.raw,
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'not_payable');
    assert.equal(res.json().reason, 'own_service');
    assert.equal(res.json().error, FEED_PAY_NOT_PAYABLE_MESSAGES.own_service);
    assert.equal(res.json().retryable, false);
    // Nothing reserved, signed or sent, and the service was not asked again.
    assert.deepEqual(await traces(f), asked);

    // The owner's AI on its own (city_service_call): the same refusal, nothing paid.
    f.advance(12_100);
    const mcp = await f.tool(f.main.token, 'city_service_call', {
      service_id: SVC,
      agent_id: f.agentId,
      inputs: BODY,
      max_price_usdc: '0.05',
      idempotency_key: randomUUID(),
    });
    assert.equal(mcp.statusCode, 409, mcp.body);
    assert.equal(mcp.json().code, 'not_payable');
    assert.equal(mcp.json().error, FEED_PAY_NOT_PAYABLE_MESSAGES.own_service);
    assert.deepEqual(await traces(f), asked);
  }

  // Nothing at all was stored, signed or paid for the agent's own listing.
  const after = await traces(f);
  assert.equal(after.calls, 0);
  assert.equal(after.payments, 0);
  assert.equal(after.paid, 0);
  assert.equal(after.signatures, 0);
  assert.equal(after.sends, 0);
});

test('the quote names only the person’s own agents', async (t) => {
  const f = await setup(t);
  await f.list();
  await f.limit();
  for (const agentId of [
    'agent-unknown',
    f.agentId.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')),
  ]) {
    const res = await quoteFor(f, agentId);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().code, 'agent_not_found');
  }
  // Another person's agent is unknown to this person, the same answer.
  const other = await f.register('Synthetic Other', 'synthetic-password-0123');
  f.advance(6_100);
  const theirs = await f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.quote.replace(':id', SVC),
    headers: { ...json, cookie: other.cookie },
    payload: JSON.stringify({ inputs: BODY, agentId: f.agentId }),
  });
  assert.equal(theirs.statusCode, 404, theirs.body);
  assert.equal(theirs.json().code, 'agent_not_found');
  // Any other field is still refused.
  f.advance(6_100);
  const extra = await f.app.inject({
    method: 'POST',
    url: FEED_PAY_PATHS.quote.replace(':id', SVC),
    headers: { ...json, cookie: f.owner.cookie },
    payload: JSON.stringify({ inputs: BODY, agentId: f.agentId, walletId: 'x' }),
  });
  assert.equal(extra.statusCode, 400, extra.body);
  assert.equal(extra.json().code, 'invalid_request');
  // The own agent and a listing paid elsewhere: an ordinary price.
  const ok = await quoteFor(f, f.agentId);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().payable, true);
});

test('another agent of the same owner may pay the listing, from the Feed and over MCP', async (t) => {
  const f = await setup(t);
  const permission = await f.limit();
  assert.equal((await f.consent(permission.hash)).statusCode, 200);
  const seller = await secondAgent(f);
  await f.list({ payTo: seller.wallet });

  // The Feed: the price check names the paying agent, then the confirm pays.
  const quoted = await quoteFor(f, f.agentId);
  assert.equal(quoted.statusCode, 200, quoted.body);
  assert.equal(quoted.json().payable, true);
  assert.equal(quoted.json().payTo, seller.wallet);
  const res = await f.callService({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: quoted.json().quoteId,
    maxAmountRaw: quoted.json().amount.raw,
    maxTotalRaw: quoted.json().total.raw,
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const call = await f.settled(res.json().callId);
  assert.equal(call.state, 'result_saved', JSON.stringify(call));
  assert.equal(call.moneyMoved, 'yes');
  assert.equal(call.payment!.payTo, seller.wallet);
  assert.equal(f.base.balanceOf(seller.wallet), 20_000n);

  // The owner's AI on its own: the same.
  f.advance(12_100);
  const mcp = await f.tool(f.main.token, 'city_service_call', {
    service_id: SVC,
    agent_id: f.agentId,
    inputs: BODY,
    max_price_usdc: '0.05',
    idempotency_key: randomUUID(),
  });
  assert.equal(mcp.statusCode, 200, mcp.body);
  assert.equal(mcp.json().state, 'result_saved');
  assert.equal(f.service.paid().length, 2);
  assert.equal(f.base.balanceOf(seller.wallet), 40_000n);

  // The seller agent itself still can't pay its own listing (its own wallet is the payee).
  const own = await quoteFor(f, seller.agentId);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().reason, 'own_service');
  const history = (await f.history()).json() as { calls: Array<Pick<FeedPayCall, 'state'>> };
  assert.equal(history.calls.length, 2);
});
