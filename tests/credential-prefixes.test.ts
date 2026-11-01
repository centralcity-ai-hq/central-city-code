import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createApp } from '../server/app.js';
import {
  ASSISTANT_GRANT_PREFIX,
  RUNTIME_CREDENTIAL_PREFIX,
} from '../server/credential-prefixes.js';
import { partsContainCredential } from '../server/rooms/contract.js';
import { signedHeaders } from '../connector/signing.js';

type App = Awaited<ReturnType<typeof createApp>>;
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const password = 'Synthetic credential prefix password';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function api(app: App, cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...headers, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await api(app, '', 'POST', '/api/auth/register', { name: 'Prefix owner', password });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  return { app, cookie };
}

test('CCA-642: a new runtime credential carries ccrt_ and still authenticates; an old bare one too', async (t) => {
  const { app, cookie } = await setup(t);
  const created = await api(app, cookie, 'POST', '/api/agents', {
    name: 'Prefix runtime',
    mode: 'external',
    capability: 'extract',
    description: 'Synthetic prefix check',
  });
  assert.equal(created.statusCode, 201, created.body);
  const { token, agent } = created.json() as { token: string; agent: { id: string } };
  assert.match(token, /^ccrt_[A-Za-z0-9_-]{43}$/);
  const beat = (credential: string) => {
    const body = JSON.stringify({ sequence: 1 });
    return app.inject({
      method: 'POST',
      url: '/api/runtime/heartbeat',
      headers: signedHeaders(credential, 'POST', '/api/runtime/heartbeat', body),
      payload: body,
    });
  };
  assert.equal((await beat(token)).statusCode, 200);
  // A credential issued before the prefix (bare base64url) keeps working until rotated.
  const legacy = randomBytes(32).toString('base64url');
  await app.city.db.query('UPDATE credentials SET token_hash=$1 WHERE agent_id=$2', [
    sha(legacy),
    agent.id,
  ]);
  assert.equal((await beat(legacy)).statusCode, 200);
});

test('CCA-642: a new assistant grant token carries ccag_ and works; an old bare one too', async (t) => {
  const { app, cookie } = await setup(t);
  const res = await api(app, cookie, 'POST', '/api/assistant-access', {
    label: 'Prefix client',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  const { token, grant } = res.json() as { token: string; grant: { id: string } };
  assert.match(token, /^ccag_[A-Za-z0-9_-]{43}$/);
  const call = (bearer: string) =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_workspace',
      headers: { ...headers, authorization: `Bearer ${bearer}` },
      payload: '{}',
    });
  assert.equal((await call(token)).statusCode, 200);
  const legacy = randomBytes(32).toString('base64url');
  await app.city.db.query('UPDATE assistant_grants SET token_hash=$1 WHERE id=$2', [
    sha(legacy),
    grant.id,
  ]);
  assert.equal((await call(legacy)).statusCode, 200);
});

test('CCA-642: room posts refuse the new prefixes and the secret scanner has a rule for them', () => {
  for (const prefix of [RUNTIME_CREDENTIAL_PREFIX, ASSISTANT_GRANT_PREFIX]) {
    const value = `${prefix}${randomBytes(32).toString('base64url')}`;
    assert.equal(partsContainCredential([{ kind: 'text', text: `use ${value}` }]), true, prefix);
  }
  const config = readFileSync('.gitleaks.toml', 'utf8');
  const regex = /regex = '''(.+)'''/.exec(config)?.[1];
  assert.ok(regex, 'a project rule in .gitleaks.toml');
  assert.match(config, /useDefault = true/);
  const rule = new RegExp(regex!);
  for (const prefix of [RUNTIME_CREDENTIAL_PREFIX, ASSISTANT_GRANT_PREFIX])
    assert.match(`TOKEN=${prefix}${randomBytes(32).toString('base64url')}\n`, rule);
});
