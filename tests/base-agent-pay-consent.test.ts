import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_AGENT_PAY_CONSENTS_SQL,
  BASE_TABLES,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_VAULT_SQL,
} from '../server/base/schema.js';
import {
  AgentPayConsentError,
  assertAgentPayConsent,
  createAgentPayConsentService,
} from '../server/base/wallet/agent-pay-consent.js';
import { registerAgentPayRoutes } from '../server/base/wallet/agent-pay-routes.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID as CHAIN_ID } from '../shared/base/wallet-network.js';

/*
 * Base Pay P2b: the owner's consent that one agent may pay on its own. Bound to exactly one chain,
 * token, wallet and spending limit (id and hash); given and withdrawn only by the wallet's owner
 * account; a new limit is never covered by a consent for another one. Synthetic rows only.
 */

const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const USDC = BASE_NETWORKS[CHAIN_ID].tokens.USDC.address.toLowerCase();
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  await pg.exec(BASE_WALLET_LIMITS_SQL);
  await pg.exec(BASE_AGENT_PAY_CONSENTS_SQL);
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
  const service = createAgentPayConsentService({ db, chainId: CHAIN_ID, now: () => ++clock });
  const covered = (permissionId: string, permissionHash: string, walletId = 'w-1') =>
    assertAgentPayConsent(db, {
      chainId: CHAIN_ID,
      walletId,
      token: USDC,
      permissionId,
      permissionHash,
    }).then(
      () => true,
      (e) => {
        if (e instanceof AgentPayConsentError && e.code === 'no_consent') return false;
        throw e;
      },
    );
  return { pg, db, service, limit, covered };
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
