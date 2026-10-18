import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL,
  BASE_AGENT_PAY_CONSENTS_SQL,
  BASE_TABLES,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_VAULT_SQL,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';
import {
  AgentPayConsentError,
  assertAgentPayConsent,
  createAgentPayConsentService,
  type AgentPayRecipient,
} from '../server/base/wallet/agent-pay-consent.js';
import { registerAgentPayRoutes } from '../server/base/wallet/agent-pay-routes.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID as CHAIN_ID } from '../shared/base/wallet-network.js';

/*
 * Base Pay P2b: the owner's consent that one agent may pay on its own. Bound to exactly one chain,
 * token, wallet and spending limit (id and hash); given and withdrawn only by the wallet's owner
 * account; a new limit is never covered by a consent for another one. Bound to the recipients the
 * owner confirmed (migration 118): Central City agents only, or Feed services as well (offered only
 * while Feed pay is on). Synthetic rows only.
 */

const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const USDC = BASE_NETWORKS[CHAIN_ID].tokens.USDC.address.toLowerCase();
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const AGENTS = 'central-city-agents';
const WIDE = 'central-city-agents-and-feed-services';

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { recipientsMigration?: boolean } = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  await pg.exec(BASE_WALLET_LIMITS_SQL);
  await pg.exec(BASE_AGENT_PAY_CONSENTS_SQL);
  if (options.recipientsMigration !== false) await pg.exec(BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const wallet = async (id: string, agent: string, account: string, n: string) =>
    pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1,$2,$3,${CHAIN_ID},$4,$5,$6,'v1:k','{}','derived',0,0,$3)`,
      [id, agent, account, `0x${n.repeat(40)}`, `0x${'e'.repeat(40)}`, `0x${'f'.repeat(40)}`],
    );
  await wallet('w-1', AGENT, 'person-1', '1');
  await wallet('w-2', OTHER_AGENT, 'person-2', '2');
  const limit = (id: string, walletId: string, hash: string, state = 'signed') =>
    pg.query(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature,
         state, token, permission_hash, period_kind, cap_raw, onchain_model, created_at, updated_at,
         revoked_block)
       VALUES ($1,$2,${CHAIN_ID},'{}','\\x00',$3,$4,$5,'day',10000000,'half',0,0,$6)`,
      [id, walletId, state, USDC, hash, state === 'revoked' ? 1 : null],
    );
  let clock = 1_000;
  // The flags as the service reads them per request: Feed pay off unless a test switches it on.
  const env: Record<string, string | undefined> = { CITY_FEED_PAY: '0' };
  const service = createAgentPayConsentService({
    db,
    chainId: CHAIN_ID,
    now: () => ++clock,
    env,
  });
  const covered = (
    permissionId: string,
    permissionHash: string,
    walletId = 'w-1',
    recipient: AgentPayRecipient = 'central-city-agent',
  ) =>
    assertAgentPayConsent(db, {
      chainId: CHAIN_ID,
      walletId,
      token: USDC,
      permissionId,
      permissionHash,
      recipient,
    }).then(
      () => true,
      (e) => {
        if (e instanceof AgentPayConsentError && e.code === 'no_consent') return false;
        throw e;
      },
    );
  /** The refusal of a payment to a Feed service under limit p-a, or null when covered. */
  const feedServiceRefusal = () =>
    assertAgentPayConsent(db, {
      chainId: CHAIN_ID,
      walletId: 'w-1',
      token: USDC,
      permissionId: 'p-a',
      permissionHash: HASH_A,
      recipient: 'feed-service',
    }).then(
      () => null,
      (e) => {
        if (e instanceof AgentPayConsentError) return e;
        throw e;
      },
    );
  const consents = () =>
    pg
      .query<{ recipients: string; live: boolean }>(
        `SELECT recipients, revoked_at IS NULL AS live FROM base_agent_pay_consents
         ORDER BY granted_at`,
      )
      .then((res) => res.rows);
  const audits = () =>
    pg
      .query<{ kind: string; detail: { recipients?: string } }>(
        'SELECT kind, detail FROM base_audit_events ORDER BY event_id',
      )
      .then((res) => res.rows.map((row) => [row.kind, row.detail.recipients ?? null]));
  return { pg, db, env, service, limit, covered, feedServiceRefusal, consents, audits };
}

const refused = (code: string) => (e: unknown) =>
  e instanceof AgentPayConsentError && e.code === code;

test('by default an agent may not pay; the owner consents for exactly the limit they saw', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  const before = await s.service.view('person-1', AGENT);
  assert.equal(before.mayPay, false);
  assert.equal(before.consent, null);
  assert.equal(before.scope.recipients, 'central-city-agents');
  assert.equal(before.scope.withinLimit?.permissionHash, HASH_A);
  assert.equal(before.scope.withinLimit?.capDisplay, '10');
  assert.equal(await s.covered('p-a', HASH_A), false);

  const after = await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  assert.equal(after.mayPay, true);
  assert.equal(after.consent?.coversCurrentLimit, true);
  assert.equal(await s.covered('p-a', HASH_A), true);
  // Bound to the exact limit: another hash, another limit id or another wallet is not covered.
  assert.equal(await s.covered('p-a', HASH_B), false);
  assert.equal(await s.covered('p-x', HASH_A), false);
  assert.equal(await s.covered('p-a', HASH_A, 'w-2'), false);
  const audit = await s.pg.query<{ kind: string; actor: string }>(
    'SELECT kind, actor FROM base_audit_events ORDER BY event_id',
  );
  assert.deepEqual(audit.rows, [{ kind: 'agent_pay_consent_granted', actor: 'person-1' }]);
});

test('a consent for a limit the owner did not see, or with no limit at all, is refused', async (t) => {
  const s = await setup(t);
  await assert.rejects(
    s.service.grant('person-1', AGENT, { permissionHash: HASH_A }),
    refused('no_spending_limit'),
  );
  await s.limit('p-a', 'w-1', HASH_A);
  await assert.rejects(
    s.service.grant('person-1', AGENT, { permissionHash: HASH_B }),
    refused('limit_changed'),
  );
  await assert.rejects(s.service.grant('person-1', AGENT, {}), refused('invalid_body'));
  await assert.rejects(
    s.service.grant('person-1', AGENT, { permissionHash: HASH_A, agentId: OTHER_AGENT }),
    refused('invalid_body'),
  );
  assert.equal(await s.covered('p-a', HASH_A), false);
});

test('only the wallet owner account sees or changes it; another person gets 404', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  await assert.rejects(s.service.view('person-2', AGENT), refused('not_found'));
  await assert.rejects(
    s.service.grant('person-2', AGENT, { permissionHash: HASH_A }),
    refused('not_found'),
  );
  await assert.rejects(s.service.revoke('person-2', AGENT), refused('not_found'));
  assert.equal(await s.covered('p-a', HASH_A), false);
});

test('a replaced or revoked limit is never covered by the consent for the old one', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  // The owner revokes that limit and sets a new one: the consent does not follow.
  await s.pg.query(
    `UPDATE base_spend_permissions SET state='revoke_pending' WHERE permission_id='p-a'`,
  );
  assert.equal(await s.covered('p-a', HASH_A), false, 'revoke pending: no new spends');
  await s.pg.query(
    `UPDATE base_spend_permissions SET state='revoked', revoked_block=1 WHERE permission_id='p-a'`,
  );
  await s.limit('p-b', 'w-1', HASH_B);
  const view = await s.service.view('person-1', AGENT);
  assert.equal(view.mayPay, false);
  assert.equal(view.consent?.coversCurrentLimit, false);
  assert.equal(await s.covered('p-b', HASH_B), false);
  // Consenting to the new limit replaces the old consent (one live consent per wallet and token).
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_B });
  assert.equal(await s.covered('p-b', HASH_B), true);
  const live = await s.pg.query(
    'SELECT permission_hash FROM base_agent_pay_consents WHERE revoked_at IS NULL',
  );
  assert.deepEqual(live.rows, [{ permission_hash: HASH_B }]);
});

test('withdrawing it stops new spends at once; withdrawing twice is harmless', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  const off = await s.service.revoke('person-1', AGENT);
  assert.equal(off.mayPay, false);
  assert.equal(await s.covered('p-a', HASH_A), false);
  await s.service.revoke('person-1', AGENT);
  const kinds = await s.pg.query<{ kind: string }>(
    'SELECT kind FROM base_audit_events ORDER BY event_id',
  );
  assert.deepEqual(
    kinds.rows.map((r) => r.kind),
    ['agent_pay_consent_granted', 'agent_pay_consent_revoked'],
  );
  // Granting again for the same limit makes a new consent row; the withdrawn one stays as history.
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  const rows = await s.pg.query('SELECT 1 FROM base_agent_pay_consents');
  assert.equal(rows.rows.length, 2);
});

test('the routes exist only with wallets on and only for a signed-in person', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  let on = false;
  const app = Fastify();
  t.after(() => app.close());
  registerAgentPayRoutes(app, {
    enabled: () => on,
    person: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { ok: true, accountId: who } : { ok: false, code: 401 };
    },
    service: s.service,
  });
  const url = `/api/base/agents/${AGENT}/wallet/agent-pay`;
  const call = (method: 'GET' | 'PUT' | 'DELETE', person?: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: person ? { 'x-test-person': person } : {},
      ...(payload ? { payload } : {}),
    });
  assert.equal((await call('GET', 'person-1')).statusCode, 404, 'wallets off');
  on = true;
  assert.equal((await call('GET')).statusCode, 401);
  assert.equal((await call('GET', 'person-2')).statusCode, 404);
  const put = await call('PUT', 'person-1', { permissionHash: HASH_A });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json().mayPay, true);
  const changed = await call('PUT', 'person-1', { permissionHash: HASH_B });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().code, 'limit_changed');
  const del = await call('DELETE', 'person-1', {});
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().mayPay, false);
});

test('the migration only adds: no drop, delete or truncate', () => {
  assert.doesNotMatch(BASE_AGENT_PAY_CONSENTS_SQL, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);
});

test('the consents table is a recognized Base table (recovery never exports it)', () => {
  assert.ok(BASE_TABLES.includes('base_agent_pay_consents'));
});

// --- recipients (migration 118) ----------------------------------------------------------------

test('migration 118: existing consents read Central City agents only; cheap DDL, no backfill', async (t) => {
  const s = await setup(t, { recipientsMigration: false });
  await s.limit('p-a', 'w-1', HASH_A);
  // A consent as the code before migration 118 stored it.
  await s.pg.query(
    `INSERT INTO base_agent_pay_consents (consent_id, chain_id, wallet_id, agent_id, token,
       permission_id, permission_hash, granted_by, granted_at)
     VALUES ('c-old', ${CHAIN_ID}, 'w-1', $1, $2, 'p-a', $3, 'person-1', 1)`,
    [AGENT, USDC, HASH_A],
  );
  await s.pg.exec(BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL);
  assert.deepEqual(await s.consents(), [{ recipients: AGENTS, live: true }]);
  // It still lets the agent pay Central City agents, and never a Feed service.
  assert.equal(await s.covered('p-a', HASH_A), true);
  const refusal = await s.feedServiceRefusal();
  assert.equal(refusal?.code, 'no_consent');
  assert.equal(refusal?.reason, 'recipient_not_covered');
  // The check is enforced on new rows, and was added NOT VALID (no scan of the existing ones).
  await assert.rejects(
    s.pg.query(`UPDATE base_agent_pay_consents SET recipients = 'everyone'`),
    /base_agent_pay_consents_recipients_check/,
  );
  const check = await s.pg.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = 'base_agent_pay_consents_recipients_check'`,
  );
  assert.deepEqual(check.rows, [{ convalidated: false }]);
  assert.doesNotMatch(
    BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL,
    /DROP|DELETE|TRUNCATE|UPDATE|INSERT|VALIDATE CONSTRAINT/i,
  );
  assert.match(BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL, /DEFAULT 'central-city-agents'/);
  registerBaseMigration();
  const registered = listMigrations().find((m) => m.version === 118);
  assert.equal(registered?.name, 'base_agent_pay_consent_recipients');
  assert.equal(registered?.sql, BASE_AGENT_PAY_CONSENT_RECIPIENTS_SQL);
});

test('a consent stores the recipients the screen showed; Feed services only while Feed pay is on', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  // Feed pay off: the screen offers Central City agents only, and that is what is stored.
  const off = await s.service.view('person-1', AGENT);
  assert.equal(off.scope.recipients, AGENTS);
  assert.equal(off.confirmRecipients, AGENTS);
  assert.equal(off.reconfirmAddsFeedServices, false);
  await assert.rejects(
    s.service.grant('person-1', AGENT, { permissionHash: HASH_A, recipients: WIDE }),
    refused('scope_changed'),
  );
  await assert.rejects(
    s.service.grant('person-1', AGENT, { permissionHash: HASH_A, recipients: 'everyone' }),
    refused('invalid_body'),
  );
  const given = await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  assert.equal(given.consent?.recipients, AGENTS);
  assert.equal(given.scope.recipients, AGENTS);

  // Feed pay comes on: the view stays truthful (agents only) and says confirming again adds them.
  s.env.CITY_FEED_PAY = undefined;
  const on = await s.service.view('person-1', AGENT);
  assert.equal(on.mayPay, true);
  assert.equal(on.scope.recipients, AGENTS, 'never wider than what is stored');
  assert.equal(on.consent?.recipients, AGENTS);
  assert.equal(on.confirmRecipients, WIDE);
  assert.equal(on.reconfirmAddsFeedServices, true);
  // Agent payments are covered; a Feed service is not, with the reason.
  assert.equal(await s.covered('p-a', HASH_A), true);
  const refusal = await s.feedServiceRefusal();
  assert.equal(refusal?.code, 'no_consent');
  assert.equal(refusal?.status, 403);
  assert.equal(refusal?.reason, 'recipient_not_covered');
  assert.match(refusal!.message, /confirm again to include services in the Feed/);

  // Confirming again with the wider offer covers Feed services.
  const wide = await s.service.grant('person-1', AGENT, {
    permissionHash: HASH_A,
    recipients: WIDE,
  });
  assert.equal(wide.scope.recipients, WIDE);
  assert.equal(wide.consent?.recipients, WIDE);
  assert.equal(wide.reconfirmAddsFeedServices, false);
  assert.equal(await s.feedServiceRefusal(), null);
  assert.equal(await s.covered('p-a', HASH_A), true);

  // Feed pay switched off again: the view never claims Feed services while they can't be paid.
  s.env.CITY_FEED_PAY = '0';
  const offAgain = await s.service.view('person-1', AGENT);
  assert.equal(offAgain.scope.recipients, AGENTS);
  assert.equal(offAgain.consent?.recipients, WIDE);
  assert.equal(offAgain.reconfirmAddsFeedServices, false);
});

test('confirming again: the same recipients are a replay, other recipients a new consent', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  // The same limit and the same recipients: nothing changes (no new row, no new audit event).
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A, recipients: AGENTS });
  assert.deepEqual(await s.consents(), [{ recipients: AGENTS, live: true }]);
  assert.deepEqual(await s.audits(), [['agent_pay_consent_granted', AGENTS]]);

  // Wider (Feed pay on now): a new consent that replaces the old one, audited with its recipients.
  s.env.CITY_FEED_PAY = undefined;
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A, recipients: WIDE });
  assert.deepEqual(await s.consents(), [
    { recipients: AGENTS, live: false },
    { recipients: WIDE, live: true },
  ]);
  // The same wide recipients again: a replay.
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A, recipients: WIDE });
  assert.equal((await s.consents()).length, 2);
  // Narrower (agents only while Feed pay is on): a new consent again, stored as sent.
  const narrow = await s.service.grant('person-1', AGENT, {
    permissionHash: HASH_A,
    recipients: AGENTS,
  });
  assert.equal(narrow.scope.recipients, AGENTS);
  assert.equal(narrow.reconfirmAddsFeedServices, true);
  // Recipients left out never take Feed services from the flags: agents only, here a replay.
  await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  assert.deepEqual(await s.consents(), [
    { recipients: AGENTS, live: false },
    { recipients: WIDE, live: false },
    { recipients: AGENTS, live: true },
  ]);
  assert.deepEqual(await s.audits(), [
    ['agent_pay_consent_granted', AGENTS],
    ['agent_pay_consent_granted', WIDE],
    ['agent_pay_consent_granted', AGENTS],
  ]);
  assert.equal((await s.feedServiceRefusal())?.reason, 'recipient_not_covered');
  assert.equal(await s.covered('p-a', HASH_A), true);
});

test('a stale tab: a confirmation built while Feed pay was off stores agents only after it came on', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  // The owner opens the screen while Feed pay is off: it offers Central City agents only.
  const stale = await s.service.view('person-1', AGENT);
  assert.equal(stale.confirmRecipients, AGENTS);
  // Feed pay comes on before the owner presses confirm in that tab.
  s.env.CITY_FEED_PAY = undefined;
  const given = await s.service.grant('person-1', AGENT, {
    permissionHash: stale.scope.withinLimit!.permissionHash,
    recipients: stale.confirmRecipients,
  });
  assert.equal(given.consent?.recipients, AGENTS, 'what that screen said, not the flags now');
  assert.equal(given.scope.recipients, AGENTS);
  assert.equal(given.reconfirmAddsFeedServices, true);
  assert.equal((await s.feedServiceRefusal())?.reason, 'recipient_not_covered');
  // An older screen that sends no recipients at all gets agents only too.
  await s.service.revoke('person-1', AGENT);
  const bare = await s.service.grant('person-1', AGENT, { permissionHash: HASH_A });
  assert.equal(bare.consent?.recipients, AGENTS);
  assert.equal((await s.feedServiceRefusal())?.reason, 'recipient_not_covered');
  assert.deepEqual(await s.consents(), [
    { recipients: AGENTS, live: false },
    { recipients: AGENTS, live: true },
  ]);
});

test('the route takes the recipients the screen showed and answers scope_changed for more', async (t) => {
  const s = await setup(t);
  await s.limit('p-a', 'w-1', HASH_A);
  const app = Fastify();
  t.after(() => app.close());
  registerAgentPayRoutes(app, {
    enabled: () => true,
    person: async () => ({ ok: true, accountId: 'person-1' }),
    service: s.service,
  });
  const url = `/api/base/agents/${AGENT}/wallet/agent-pay`;
  const put = (payload: object) => app.inject({ method: 'PUT', url, payload });
  const refusedWide = await put({ permissionHash: HASH_A, recipients: WIDE });
  assert.equal(refusedWide.statusCode, 409, refusedWide.body);
  assert.equal(refusedWide.json().code, 'scope_changed');
  s.env.CITY_FEED_PAY = undefined;
  const shown = await app.inject({ url });
  assert.equal(shown.json().confirmRecipients, WIDE);
  const given = await put({ permissionHash: HASH_A, recipients: shown.json().confirmRecipients });
  assert.equal(given.statusCode, 200, given.body);
  assert.equal(given.json().consent.recipients, WIDE);
  assert.equal(given.json().scope.recipients, WIDE);
});
