import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Database, Transaction } from '../server/database.js';
import {
  approve,
  authorizeUrl,
  consentPost,
  fixture,
  openAuthorize,
  pkce,
  REDIRECT,
  registerClient,
  RESOURCE,
  signedIn,
  tokenRequest,
} from './oauth-helpers.js';
import { OAUTH_LIFETIMES } from '../server/oauth/server.js';

const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

/** Makes every query (also inside transactions) that `matches` fail; counts them. */
function failQueries(db: Database, matches: (sql: string, params?: unknown[]) => boolean) {
  const state = { failed: 0 };
  const guard = <T extends Pick<Transaction, 'query'>>(target: T): T => {
    const query = target.query.bind(target);
    return Object.assign(Object.create(target), {
      query: (sql: string, params?: unknown[]) => {
        if (matches(sql, params)) {
          state.failed++;
          return Promise.reject(new Error('Synthetic query failure.'));
        }
        return query(sql, params);
      },
    });
  };
  const query = db.query.bind(db);
  const transaction = db.transaction.bind(db);
  db.query = ((sql: string, params?: unknown[]) =>
    guard({ query } as Pick<Transaction, 'query'>).query(sql, params)) as Database['query'];
  db.transaction = ((action: (tx: Transaction) => Promise<unknown>) =>
    transaction((tx) => action(guard(tx)))) as Database['transaction'];
  return state;
}

test('a token exchange answers with its tokens when housekeeping on another owner fails', async (t) => {
  let time = 1_800_000_000_000;
  const { app } = await fixture(t, { clock: () => time });
  // A second owner leaves an approval unexchanged; its code expires.
  const other = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Other owner', password: 'Other synthetic password' }),
  });
  assert.equal(other.statusCode, 201, other.body);
  const otherId = other.json().operator.id as string;
  const client = await registerClient(app);
  const form = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
  );
  const login = await consentPost(app, form, {
    action: 'login',
    name: 'Other owner',
    password: 'Other synthetic password',
  });
  assert.equal(login.statusCode, 200, login.body);
  const approved = await consentPost(app, signedIn(form, login), {
    action: 'approve',
    scope: ['agents:create'],
    expires_in_days: '7',
  });
  assert.equal(approved.statusCode, 200, approved.body);
  time += OAUTH_LIFETIMES.codeMs + OAUTH_LIFETIMES.codeGraceMs + 1_000;
  // The first owner's flow; releasing the other owner's stale grant then fails.
  const { verifier, challenge } = pkce();
  const back = await approve(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge }),
  );
  // Only the locked read of the other owner's workspace (its housekeeping) fails.
  const state = failQueries(
    app.city.db,
    (sql, params) =>
      /^SELECT [\s\S]* AS data FROM workspaces ws [\s\S]*FOR UPDATE/.test(sql) &&
      params?.[0] === otherId,
  );
  const tokens = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
  });
  assert.ok(state.failed > 0, 'the housekeeping step did not run');
  assert.equal(tokens.statusCode, 200, tokens.body);
  assert.ok(tokens.json().access_token);
});

test('an AI workspace create returns its secrets when the capacity read after it fails', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const state = failQueries(app.city.db, (sql) =>
    /^SELECT workspaces FROM ai_workspace_stats WHERE scope_key='global'/.test(sql),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Best effort workspace', idempotency_key: randomUUID() }),
    remoteAddress: '198.51.100.77',
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(res.json().workspace_key);
  assert.ok(state.failed > 0, 'the capacity read did not run');
});

test('an anonymous agent create succeeds when releasing its hold and the capacity read fail', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const state = failQueries(app.city.db, (sql) =>
    /^(DELETE FROM unclaimed_stats WHERE scope_key=\$1 RETURNING agents|SELECT agents,buckets FROM unclaimed_stats WHERE scope_key='global')/.test(
      sql,
    ),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/agents',
    remoteAddress: '198.51.100.78',
    payload: {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'best-effort-agent' },
        spec: { capabilities: ['research'], runtime: { mode: 'external' } },
      },
      idempotency_key: randomUUID(),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(state.failed, 2);
});
