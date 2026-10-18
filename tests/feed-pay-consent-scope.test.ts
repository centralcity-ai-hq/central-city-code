import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getAddress } from 'viem';
import type { FeedPayAgent } from '../shared/feed-pay.js';
import { BODY, CHAIN_ID, json, setup, SVC, USDC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * The owner's consent is bound to the recipients the owner confirmed (migration 118,
 * server/base/wallet/agent-pay-consent.ts). Feed pay is live by default, so a consent given while
 * it was off (the screen said Central City agents only), or before migration 118, must never let
 * the agent pay a Feed service through city_service_call: the owner confirms again to include
 * them. A payment from the Feed page (the person confirms each one) never depends on that consent.
 * createApp on PGlite with a fake x402 service and a fake Base; nothing reaches a network.
 * Synthetic data.
 */

const AGENTS = 'central-city-agents';
const WIDE = 'central-city-agents-and-feed-services';

const args = (f: FeedPayApp, extra: Record<string, unknown> = {}) => ({
  service_id: `https://centralcity.ai/feed/services/${SVC}`,
  agent_id: f.agentId,
  inputs: BODY,
  max_price_usdc: '0.05',
  idempotency_key: randomUUID(),
  ...extra,
});

async function nothingStored(f: FeedPayApp) {
  const [calls] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM feed_pay_calls');
  const [payments] = await f.sql<{ n: string }>('SELECT count(*)::text AS n FROM base_payments');
  const [moves] = await f.sql<{ n: string }>(
    'SELECT count(*)::text AS n FROM feed_pay_float_moves',
  );
  assert.deepEqual([calls!.n, payments!.n, moves!.n], ['0', '0', '0'], 'nothing reserved');
  assert.equal(f.base.state.signatures, 0, 'nothing signed');
  assert.equal(f.base.state.sends.length, 0, 'nothing sent to Base');
  assert.equal(f.service.paid().length, 0, 'nothing paid');
}

async function agentOf(f: FeedPayApp): Promise<FeedPayAgent> {
  const res = await f.agents();
  assert.equal(res.statusCode, 200, res.body);
  const agent = (res.json().agents as FeedPayAgent[]).find((a) => a.agentId === f.agentId);
  assert.ok(agent);
  return agent;
}

function refusedForFeedServices(res: { statusCode: number; body: string; json(): unknown }) {
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((res.json() as { code: string }).code, 'no_consent');
  assert.match(res.body, /Central City agents only/);
  assert.match(res.body, /confirm again to include services in the Feed/);
}

test('a consent confirmed while Feed pay was off never pays a Feed service; confirming again with Feed services does', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();

  // Feed pay is off when the owner confirms: the screen offers Central City agents only.
  process.env.CITY_FEED_PAY = '0';
  const offered = await f.consentView();
  assert.equal(offered.statusCode, 200, offered.body);
  assert.equal(offered.json().scope.recipients, AGENTS);
  assert.equal(offered.json().confirmRecipients, AGENTS);
  // Feed services can't be confirmed while they are not offered.
  const wider = await f.consent(permission.hash, WIDE);
  assert.equal(wider.statusCode, 409, wider.body);
  assert.equal(wider.json().code, 'scope_changed');
  const given = await f.consent(permission.hash);
  assert.equal(given.statusCode, 200, given.body);
  assert.equal(given.json().consent.recipients, AGENTS);

  // Feed pay comes on (unset: live for every owner).
  delete process.env.CITY_FEED_PAY;
  const view = await f.consentView();
  assert.equal(view.json().mayPay, true);
  assert.equal(view.json().scope.recipients, AGENTS, 'never wider than what was confirmed');
  assert.equal(view.json().consent.recipients, AGENTS);
  assert.equal(view.json().confirmRecipients, WIDE);
  assert.equal(view.json().reconfirmAddsFeedServices, true);

  // The main grant holds services:pay, and still nothing is reserved, signed or sent.
  refusedForFeedServices(await f.tool(f.main.token, 'city_service_call', args(f)));
  await nothingStored(f);
  assert.equal((await agentOf(f)).hasConsent, false, 'the Feed says the agent may not pay alone');

  // The owner confirms again, as the screen now offers: Feed services included.
  const again = await f.consent(permission.hash, view.json().confirmRecipients);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().scope.recipients, WIDE);
  assert.equal(again.json().consent.recipients, WIDE);
  assert.equal(again.json().reconfirmAddsFeedServices, false);
  const rows = await f.sql<{ recipients: string; live: boolean }>(
    `SELECT recipients, revoked_at IS NULL AS live FROM base_agent_pay_consents
     ORDER BY granted_at`,
  );
  assert.deepEqual(rows, [
    { recipients: AGENTS, live: false },
    { recipients: WIDE, live: true },
  ]);
  assert.equal((await agentOf(f)).hasConsent, true);

  const paid = await f.tool(f.main.token, 'city_service_call', args(f));
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().state, 'result_saved');
  assert.equal(paid.json().money_moved, 'yes');
  assert.equal(f.service.paid().length, 1);
});

test('a stale tab: a confirmation built while Feed pay was off, sent after it came on, stays agents only', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  process.env.CITY_FEED_PAY = '0';
  const stale = (await f.consentView()).json();
  assert.equal(stale.confirmRecipients, AGENTS);
  // Feed pay comes on before the owner presses confirm in the tab opened above.
  delete process.env.CITY_FEED_PAY;
  assert.equal((await f.consentView()).json().confirmRecipients, WIDE);
  const given = await f.consent(stale.scope.withinLimit.permissionHash, stale.confirmRecipients);
  assert.equal(given.statusCode, 200, given.body);
  assert.equal(given.json().consent.recipients, AGENTS, 'what that screen said, not the flags');
  assert.equal(given.json().scope.recipients, AGENTS);
  assert.equal(given.json().reconfirmAddsFeedServices, true);
  refusedForFeedServices(await f.tool(f.main.token, 'city_service_call', args(f)));
  await nothingStored(f);
  assert.equal(permission.hash, stale.scope.withinLimit.permissionHash);
});

test('a consent narrowed or withdrawn after the call is reserved stops it before anything is sent', async (t) => {
  const cases = [
    ['narrowed', 'top-up'],
    ['withdrawn', 'top-up'],
    ['narrowed', 'float ready'],
    ['withdrawn', 'float ready'],
  ] as const;
  for (const [change, float] of cases) {
    await t.test(`${change}, ${float}`, async (st) => {
      const f = await setup(st);
      await f.list();
      const permission = await f.limit();
      assert.equal((await f.consent(permission.hash)).json().consent.recipients, WIDE);
      if (float === 'float ready') {
        // One paid call first: its top-up leaves the float ready for the next call, so the next
        // check is the one right before the payment is signed (no top-up to broadcast).
        const first = await f.tool(f.main.token, 'city_service_call', args(f));
        assert.equal(first.json().state, 'result_saved', first.body);
      }
      const before = {
        signatures: f.base.state.signatures,
        sends: f.base.state.sends.length,
        moves: (await f.sql('SELECT 1 FROM feed_pay_float_moves')).length,
      };
      // Once the call is reserved (its row exists) and the engine reads the float to go on, the
      // owner confirms again for Central City agents only, or withdraws the consent.
      let changed: { statusCode: number; body: string; reservedState: unknown } | null = null;
      f.base.state.beforeBalanceRead = async (address) => {
        if (changed || getAddress(address) !== getAddress(f.base.spender)) return;
        const reserved = await f.sql<{ state: string }>(
          "SELECT state FROM feed_pay_calls WHERE state = 'reserved'",
        );
        if (!reserved.length) return;
        const res =
          change === 'narrowed'
            ? await f.consent(permission.hash, AGENTS)
            : await f.app.inject({
                method: 'DELETE',
                url: `/api/base/agents/${f.agentId}/wallet/agent-pay`,
                headers: { ...json, cookie: f.owner.cookie },
                payload: '{}',
              });
        changed = { statusCode: res.statusCode, body: res.body, reservedState: reserved[0]!.state };
      };
      const res = await f.tool(f.main.token, 'city_service_call', args(f));
      f.base.state.beforeBalanceRead = null;
      assert.ok(changed, 'the consent changed after the call was reserved');
      const done = changed as { statusCode: number; body: string; reservedState: unknown };
      assert.equal(done.statusCode, 200, done.body);
      assert.equal(done.reservedState, 'reserved');
      const live = await f.sql<{ recipients: string }>(
        'SELECT recipients FROM base_agent_pay_consents WHERE revoked_at IS NULL',
      );
      assert.deepEqual(live, change === 'narrowed' ? [{ recipients: AGENTS }] : []);
      assert.equal(res.statusCode, 200, res.body);
      const out = res.json();
      assert.equal(out.state, 'refused', res.body);
      assert.equal(out.money_moved, 'no');
      assert.equal(out.failure.code, 'limit_changed');
      assert.equal(out.payment, null, 'no payment was signed');
      const [row] = await f.sql<{ state: string }>(
        'SELECT state FROM feed_pay_calls WHERE call_id = $1',
        [out.call_id],
      );
      assert.equal(row!.state, 'refused');
      if (float === 'top-up') {
        // The one signature is the float top-up (the agent's wallet to its own spender account),
        // prepared before its broadcast check refused it: never sent. No payment was signed.
        assert.equal(f.base.state.signatures, before.signatures + 1);
        const moves = await f.sql<{ kind: string }>('SELECT kind FROM feed_pay_float_moves');
        assert.deepEqual(moves, [{ kind: 'top_up' }]);
      } else {
        // Refused right before the payment would have been signed: nothing signed at all.
        assert.equal(f.base.state.signatures, before.signatures, 'nothing signed');
        assert.equal((await f.sql('SELECT 1 FROM feed_pay_float_moves')).length, before.moves);
      }
      assert.equal(f.base.state.sends.length, before.sends, 'nothing sent to Base');
      assert.equal(
        f.service.paid().length,
        float === 'float ready' ? 1 : 0,
        'the service was not paid for this call',
      );
    });
  }
});

test('a consent from before migration 118 reads Central City agents only and never pays a Feed service', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  // Inserted exactly as the code before migration 118 did (no recipients column named).
  await f.sql(
    `INSERT INTO base_agent_pay_consents (consent_id, chain_id, wallet_id, agent_id, token,
       permission_id, permission_hash, granted_by, granted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      CHAIN_ID,
      f.walletId,
      f.agentId,
      USDC.toLowerCase(),
      permission.id,
      permission.hash,
      f.owner.id,
      f.clock(),
    ],
  );
  const [row] = await f.sql<{ recipients: string }>(
    'SELECT recipients FROM base_agent_pay_consents',
  );
  assert.equal(row!.recipients, AGENTS);
  const view = await f.consentView();
  assert.equal(view.json().mayPay, true);
  assert.equal(view.json().scope.recipients, AGENTS);
  assert.equal(view.json().reconfirmAddsFeedServices, true);

  refusedForFeedServices(await f.tool(f.main.token, 'city_service_call', args(f)));
  await nothingStored(f);

  // A confirmation that names no recipients stays agents only (a replay of this one).
  const bare = await f.consent(permission.hash, null);
  assert.equal(bare.statusCode, 200, bare.body);
  assert.equal(bare.json().consent.recipients, AGENTS);
  assert.equal((await f.sql('SELECT 1 FROM base_agent_pay_consents')).length, 1);
  // Confirming again with what the screen offers now (its confirmRecipients) includes them.
  const again = await f.consent(permission.hash);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().consent.recipients, WIDE);
  const paid = await f.tool(f.main.token, 'city_service_call', args(f));
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(f.service.paid().length, 1);
});

test('a payment from the Feed page needs no consent, and a consent for agents only changes nothing there', async (t) => {
  const f = await setup(t);
  await f.list();
  const permission = await f.limit();
  // No consent at all: the person confirms the payment on the page.
  const first = await f.pay();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await f.settled(first.json().callId)).moneyMoved, 'yes');
  // The owner narrows the consent to Central City agents only (Feed pay on): stored as sent.
  const narrow = await f.consent(permission.hash, AGENTS);
  assert.equal(narrow.statusCode, 200, narrow.body);
  assert.equal(narrow.json().consent.recipients, AGENTS);
  assert.equal(narrow.json().reconfirmAddsFeedServices, true);
  const second = await f.pay();
  assert.equal(second.statusCode, 200, second.body);
  const call = await f.settled(second.json().callId);
  assert.equal(call.moneyMoved, 'yes');
  assert.equal(call.origin, 'feed');
  assert.equal(f.service.paid().length, 2);
  // The same agent can't pay a Feed service alone over MCP with it.
  refusedForFeedServices(await f.tool(f.main.token, 'city_service_call', args(f)));
  assert.equal(f.service.paid().length, 2);
});
