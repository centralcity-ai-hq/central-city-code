import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import {
  signedIn,
  approve,
  authorizeUrl,
  consentPost,
  fixture,
  fullFlow,
  mcpCall,
  openAuthorize,
  ORIGIN,
  ownerApi,
  PASSWORD,
  OWNER,
  pkce,
  postForm,
  REDIRECT,
  redirectFrom,
  errorLinkFrom,
  registerClient,
  RESOURCE,
  rpcResult,
  tokenRequest,
} from './oauth-helpers.js';
import {
  fetchClientMetadataDocument,
  isPublicAddress,
  redirectUriAllowed,
} from '../server/oauth/clients.js';
import type { AssistantGrant } from '../shared/assistant.js';

const CIMD = 'https://client.example.test/oauth/metadata.json';

test('discovery metadata advertises OAuth 2.1, CIMD, DCR and the /mcp resource', async (t) => {
  const { app } = await fixture(t);
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const res = await app.inject({ method: 'GET', url: path });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    const body = res.json();
    assert.equal(body.resource, RESOURCE);
    assert.deepEqual(body.authorization_servers, [ORIGIN]);
    assert.deepEqual(body.scopes_supported, [
      'workspace:read',
      'agents:create',
      'jobs:create',
      'jobs:cancel',
      'connections:create',
      'agents:control',
      'messages:send',
      'messages:read',
      'workspace:keys',
      'connections:approve',
      'rooms:join',
      'rooms:host',
      'rooms:apply',
      'agents:wake',
      'results:read',
      'results:publish',
      'pay',
      'services:pay',
      'services:sell',
    ]);
  }
  const as = (
    await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
  ).json();
  assert.equal(as.issuer, ORIGIN);
  assert.equal(as.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(as.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.equal(as.revocation_endpoint, `${ORIGIN}/oauth/revoke`);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  // Non-loopback hosts are refused in local mode.
  const foreign = await app.inject({
    method: 'GET',
    url: '/.well-known/oauth-authorization-server',
    headers: { host: 'evil.example' },
  });
  assert.equal(foreign.statusCode, 403);
});

test('unauthenticated and invalid MCP requests receive a Bearer challenge', async (t) => {
  const { app } = await fixture(t);
  const anonymous = await mcpCall(app, undefined, 'tools/list');
  assert.equal(anonymous.statusCode, 401);
  assert.equal(
    anonymous.headers['www-authenticate'],
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="workspace:read agents:create rooms:join rooms:host messages:read messages:send"`,
  );
  for (const token of ['cca_' + 'A'.repeat(43), 'not-a-token']) {
    const res = await mcpCall(app, token, 'tools/list');
    assert.equal(res.statusCode, 401);
    assert.match(String(res.headers['www-authenticate']), /error="invalid_token"/);
    assert.match(String(res.headers['www-authenticate']), /resource_metadata=/);
  }
  const crossOrigin = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(crossOrigin.statusCode, 403);
});

test('dynamic client registration accepts public clients and validates redirect URIs', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app, [REDIRECT, 'https://app.example.test/cb']);
  assert.match(client.client_id, /^ccc_/);
  const full = (
    await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        redirect_uris: ['com.example.app:/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    })
  ).json();
  assert.equal(full.token_endpoint_auth_method, 'none');
  assert.equal(full.client_secret, undefined);
  for (const redirect_uris of [
    [],
    ['javascript:alert(1)'],
    ['http://evil.example/cb'],
    ['https://app.example.test/cb#frag'],
    ['https://user:pw@app.example.test/cb'],
    ['data:text/html,x'],
    'https://app.example.test/cb',
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ redirect_uris }),
    });
    assert.equal(res.statusCode, 400, JSON.stringify(redirect_uris));
    assert.equal(res.json().error, 'invalid_redirect_uri');
  }
  const badGrant = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }),
  });
  assert.equal(badGrant.statusCode, 400);
  assert.equal(badGrant.json().error, 'invalid_client_metadata');
});

test('client ID metadata documents are fetched, bound to their URL and SSRF-guarded', async (t) => {
  const fetched: string[] = [];
  const documents = new Map<string, unknown>([
    [
      CIMD,
      {
        client_id: CIMD,
        client_name: 'Metadata Client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      },
    ],
    [
      'https://client.example.test/mismatch.json',
      { client_id: 'https://attacker.example/other.json', redirect_uris: [REDIRECT] },
    ],
    [
      'https://client.example.test/secret.json',
      {
        client_id: 'https://client.example.test/secret.json',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'private_key_jwt',
      },
    ],
  ]);
  const { app } = await fixture(t, {
    fetchClientMetadata: async (url) => {
      fetched.push(url.href);
      if (!documents.has(url.href)) throw new Error('not found');
      return documents.get(url.href);
    },
  });
  const { verifier, challenge } = pkce();
  const back = await approve(app, authorizeUrl({ client_id: CIMD, code_challenge: challenge }));
  assert.equal(fetched[0], CIMD);
  const tokens = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: CIMD,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
  });
  assert.equal(tokens.statusCode, 200, tokens.body);
  const page = await openAuthorize(
    app,
    authorizeUrl({ client_id: CIMD, code_challenge: challenge }),
  );
  assert.match(page.body, /client\.example\.test/);
  for (const [clientId, pattern] of [
    ['https://client.example.test/mismatch.json', /does not match/],
    ['https://client.example.test/secret.json', /exactly one of jwks or jwks_uri/],
    ['https://client.example.test/missing.json', /could not be verified/],
    ['https://client.example.test/', /canonical https URL/],
    ['https://client.example.test:8443/x.json', /canonical https URL/],
  ] as const) {
    const res = await openAuthorize(
      app,
      authorizeUrl({ client_id: clientId, code_challenge: challenge }),
    );
    assert.equal(res.status, 400, clientId);
    assert.match(res.body, pattern);
    assert.doesNotMatch(res.body, /http-equiv="refresh"/);
  }
  // CIMD redirect URIs are enforced like registered ones.
  const wrong = await openAuthorize(
    app,
    authorizeUrl({
      client_id: CIMD,
      code_challenge: challenge,
      redirect_uri: 'https://attacker.example/cb',
    }),
  );
  assert.equal(wrong.status, 400);

  // The real fetcher refuses private, loopback and special-purpose destinations.
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.215.14', '2606:4700::1111'])
    assert.equal(isPublicAddress(address), true);
  for (const url of [
    'https://127.0.0.1/client.json',
    'https://[::1]/client.json',
    'https://10.0.0.8/client.json',
    'https://localhost/client.json',
    'https://metadata.localhost/client.json',
    'http://client.example.test/client.json',
    'https://client.example.test:444/client.json',
  ])
    await assert.rejects(fetchClientMetadataDocument(new URL(url)), url);
  // Default wiring (no injected fetcher) blocks a loopback metadata URL.
  const { app: guarded } = await fixture(t);
  const blocked = await openAuthorize(
    guarded,
    authorizeUrl({ client_id: 'https://localhost/client.json', code_challenge: challenge }),
  );
  assert.equal(blocked.status, 400);
  assert.match(blocked.body, /not a public address|could not be retrieved/);
});

test('full authorization code + PKCE flow with login on the consent page', async (t) => {
  const { app, cookie } = await fixture(t);
  const flow = await fullFlow(app);
  assert.equal(flow.back.origin + flow.back.pathname, REDIRECT);
  assert.equal(flow.back.searchParams.get('state'), 'synthetic-state');
  assert.equal(flow.back.searchParams.get('iss'), ORIGIN);
  assert.equal(flow.tokens.token_type, 'Bearer');
  assert.equal(flow.tokens.expires_in, 3600);
  assert.match(flow.tokens.access_token, /^cca_/);
  assert.match(flow.tokens.refresh_token, /^ccr_/);
  assert.equal(flow.tokens.scope, 'workspace:read agents:create jobs:create jobs:cancel');
  const grants = (await ownerApi(app, cookie, '/api/assistant-access')).json()
    .grants as AssistantGrant[];
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.label, 'Synthetic MCP client');
  const stored = await app.city.db.query<{ token_hash: string }>(
    'SELECT token_hash FROM oauth_tokens',
  );
  assert.ok(stored.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)));
  assert.ok(!JSON.stringify(stored.rows).includes(flow.tokens.access_token.slice(4)));
  const call = await mcpCall(app, flow.tokens.access_token, 'tools/call', {
    name: 'city_workspace',
    arguments: {},
  });
  assert.equal(call.statusCode, 200, call.body);
  assert.equal(rpcResult(call.body).result.structuredContent.operator.name, OWNER);
  // Codes are single use; replay revokes the family it produced.
  const replay = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: flow.code,
    code_verifier: flow.verifier,
    client_id: flow.client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error, 'invalid_grant');
  assert.equal((await mcpCall(app, flow.tokens.access_token, 'tools/list')).statusCode, 401);
});

test('an existing owner session skips login; deny returns access_denied with state and iss', async (t) => {
  const { app, cookie } = await fixture(t);
  const client = await registerClient(app);
  const { challenge } = pkce();
  const form = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge }),
    cookie,
  );
  assert.match(form.body, /Signed in as <strong>OAuth owner/);
  assert.match(form.body, /self-registered|registered itself/);
  const deny = await consentPost(app, form, { action: 'deny' });
  const back = redirectFrom(deny.body);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'synthetic-state');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  assert.equal(back.searchParams.get('code'), null);
});

test('consent POST requires the flow cookie, CSRF token, same origin and valid password', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const { challenge } = pkce();
  const url = authorizeUrl({ client_id: client.client_id, code_challenge: challenge });
  const form = await openAuthorize(app, url);
  assert.match(form.cookie, /^cc_oauth_/);
  const fields = { action: 'login', name: OWNER, password: PASSWORD };
  assert.equal((await consentPost(app, { ...form, cookie: '' }, fields)).statusCode, 400);
  assert.equal((await consentPost(app, { ...form, csrf: 'x'.repeat(43) }, fields)).statusCode, 400);
  assert.equal(
    (await consentPost(app, form, fields, { origin: 'https://evil.example' })).statusCode,
    403,
  );
  assert.equal(
    (await consentPost(app, form, fields, { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }))
      .statusCode,
    403,
  );
  const approveWithoutLogin = await consentPost(app, form, { action: 'approve' });
  assert.equal(approveWithoutLogin.statusCode, 401);
  const wrong = await consentPost(app, form, {
    action: 'login',
    name: OWNER,
    password: 'x'.repeat(16),
  });
  assert.equal(wrong.statusCode, 401);
  assert.match(wrong.body, /Invalid account name or password/);
  const login = await consentPost(app, form, fields);
  assert.equal(login.statusCode, 200);
  const session = signedIn(form, login);
  const approved = await consentPost(app, session, { action: 'approve', expires_in_days: '1' });
  assert.ok(redirectFrom(approved.body).searchParams.get('code'));
  // The pending request is consumed.
  assert.equal((await consentPost(app, session, { action: 'approve' })).statusCode, 400);
});

test('PKCE is mandatory and a wrong verifier is rejected', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  for (const params of [
    { code_challenge: 'OMIT' },
    { code_challenge: pkce().challenge, code_challenge_method: 'plain' },
  ]) {
    const res = await openAuthorize(app, authorizeUrl({ client_id: client.client_id, ...params }));
    const back = errorLinkFrom({ status: res.status, body: res.body });
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('iss'), ORIGIN);
  }
  const unsupported = await openAuthorize(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: pkce().challenge,
      response_type: 'token',
    }),
  );
  assert.equal(errorLinkFrom(unsupported).searchParams.get('error'), 'unsupported_response_type');
  const { challenge } = pkce();
  const back = await approve(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge }),
  );
  const res = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: pkce().verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_grant');
});

test('redirect URIs match exactly, except loopback ports (RFC 8252)', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app, [REDIRECT, 'https://app.example.test/cb']);
  const { verifier, challenge } = pkce();
  for (const redirect_uri of [
    'https://app.example.test/cb/extra',
    'https://app.example.test/cb?x=1',
    'http://127.0.0.1:43123/other',
    'http://localhost:43123/callback',
    'https://evil.example/cb',
  ]) {
    const res = await openAuthorize(
      app,
      authorizeUrl({ client_id: client.client_id, code_challenge: challenge, redirect_uri }),
    );
    assert.equal(res.status, 400, redirect_uri);
    assert.doesNotMatch(res.body, /http-equiv="refresh"/);
  }
  const anyPort = 'http://127.0.0.1:59999/callback';
  const back = await approve(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge, redirect_uri: anyPort }),
  );
  assert.equal(back.host, '127.0.0.1:59999');
  // The token request must repeat the exact redirect URI used for authorization.
  const mismatch = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(mismatch.json().error, 'invalid_grant');
  assert.equal(redirectUriAllowed(['http://localhost/cb'], 'http://localhost:8080/cb'), true);
  assert.equal(redirectUriAllowed(['http://[::1]:1/cb'], 'http://[::1]:2/cb'), true);
  assert.equal(redirectUriAllowed(['https://a.example/cb'], 'https://a.example:444/cb'), false);
  // A client cannot redeem another client's code.
  const other = await registerClient(app);
  const second = pkce();
  const code = (
    await approve(
      app,
      authorizeUrl({ client_id: client.client_id, code_challenge: second.challenge }),
    )
  ).searchParams.get('code')!;
  const stolen = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code,
    code_verifier: second.verifier,
    client_id: other.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(stolen.json().error, 'invalid_grant');
});

test('resource indicators must name this /mcp endpoint and tokens are audience bound', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const { challenge } = pkce();
  const res = await openAuthorize(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: challenge,
      resource: 'https://other.example/mcp',
    }),
  );
  assert.equal(errorLinkFrom(res).searchParams.get('error'), 'invalid_target');
  const flow = await fullFlow(app);
  const wrongResource = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
    resource: 'https://other.example/mcp',
  });
  assert.equal(wrongResource.json().error, 'invalid_target');
  // Tokens issued for http://localhost/mcp do not work at another loopback origin.
  const otherHost = await mcpCall(
    app,
    flow.tokens.access_token,
    'tools/list',
    {},
    '127.0.0.1:4310',
  );
  assert.equal(otherHost.statusCode, 401);
  const refreshElsewhere = await tokenRequest(
    app,
    {
      grant_type: 'refresh_token',
      refresh_token: flow.tokens.refresh_token,
      client_id: flow.client.client_id,
    },
    '127.0.0.1:4310',
  );
  assert.equal(refreshElsewhere.json().error, 'invalid_grant');
  const scoped = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge, scope: 'admin:all' }),
  );
  assert.equal(errorLinkFrom(scoped).searchParams.get('error'), 'invalid_scope');
});

test('refresh tokens rotate and reuse revokes the whole family', async (t) => {
  let time = 1_800_000_000_000;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app);
  time += 3_600_000;
  assert.equal((await mcpCall(app, flow.tokens.access_token, 'tools/list')).statusCode, 401);
  const refreshed = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
    resource: RESOURCE,
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const next = refreshed.json();
  assert.notEqual(next.refresh_token, flow.tokens.refresh_token);
  assert.equal((await mcpCall(app, next.access_token, 'tools/list')).statusCode, 200);
  const wrongClient = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: next.refresh_token,
    client_id: 'ccc_someone_else',
  });
  assert.equal(wrongClient.json().error, 'invalid_grant');
  const reuse = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
  });
  assert.equal(reuse.statusCode, 400);
  assert.equal(reuse.json().error, 'invalid_grant');
  assert.equal((await mcpCall(app, next.access_token, 'tools/list')).statusCode, 401);
  const afterReuse = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: next.refresh_token,
    client_id: flow.client.client_id,
  });
  assert.equal(afterReuse.json().error, 'invalid_grant');
  const unsupported = await tokenRequest(app, { grant_type: 'password', client_id: 'x' });
  assert.equal(unsupported.json().error, 'unsupported_grant_type');
  const json = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(json.json().error, 'invalid_request');
});

test('refresh stops when the underlying grant expires', async (t) => {
  let time = 1_800_000_000_000;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: '1' });
  time += 86_400_000;
  const res = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
  });
  assert.equal(res.json().error, 'invalid_grant');
});

test('owner revocation in AI connections cuts MCP access and refresh', async (t) => {
  const { app, cookie } = await fixture(t);
  const flow = await fullFlow(app);
  const grant = (await ownerApi(app, cookie, '/api/assistant-access')).json()
    .grants[0] as AssistantGrant;
  assert.equal((await mcpCall(app, flow.tokens.access_token, 'tools/list')).statusCode, 200);
  const revoke = await ownerApi(app, cookie, `/api/assistant-access/${grant.id}`, {}, 'DELETE');
  assert.equal(revoke.statusCode, 200, revoke.body);
  const denied = await mcpCall(app, flow.tokens.access_token, 'tools/list');
  assert.equal(denied.statusCode, 401);
  assert.match(String(denied.headers['www-authenticate']), /invalid_token/);
  const refresh = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
  });
  assert.equal(refresh.json().error, 'invalid_grant');
});

test('RFC 7009 revocation of a refresh token revokes its family', async (t) => {
  const { app } = await fixture(t);
  const flow = await fullFlow(app);
  const other = await postForm(app, '/oauth/revoke', {
    token: flow.tokens.refresh_token,
    client_id: 'ccc_other',
  });
  assert.equal(other.statusCode, 200);
  assert.equal((await mcpCall(app, flow.tokens.access_token, 'tools/list')).statusCode, 200);
  const res = await postForm(app, '/oauth/revoke', {
    token: flow.tokens.refresh_token,
    client_id: flow.client.client_id,
  });
  assert.equal(res.statusCode, 200);
  assert.equal((await mcpCall(app, flow.tokens.access_token, 'tools/list')).statusCode, 401);
  const unknown = await postForm(app, '/oauth/revoke', { token: 'unknown', client_id: 'x' });
  assert.equal(unknown.statusCode, 200);
});

test('tools outside the approved scopes are refused with insufficient_scope', async (t) => {
  const { app } = await fixture(t);
  const flow = await fullFlow(app, { scopes: [] });
  assert.equal(flow.tokens.scope, 'workspace:read');
  const read = await mcpCall(app, flow.tokens.access_token, 'tools/call', {
    name: 'city_workspace',
    arguments: {},
  });
  assert.equal(read.statusCode, 200);
  const write = await mcpCall(app, flow.tokens.access_token, 'tools/call', {
    name: 'city_create_agent',
    arguments: {
      name: 'Blocked',
      capability: 'extract',
      mode: 'hosted',
      idempotencyKey: 'blocked-key-1',
    },
  });
  assert.equal(write.statusCode, 403, write.body);
  const challenge = String(write.headers['www-authenticate']);
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /agents:create/);
  const state = (
    await mcpCall(app, flow.tokens.access_token, 'tools/call', {
      name: 'city_workspace',
      arguments: {},
    })
  ).body;
  assert.deepEqual(rpcResult(state).result.structuredContent.agents, []);
});

test('rate limits apply to the token endpoint', async (t) => {
  const { app } = await fixture(t);
  let last = 0;
  for (let i = 0; i < 61; i++)
    last = (
      await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'x' })
    ).statusCode;
  assert.equal(last, 429);
});

// ---- private_key_jwt (RFC 7523) for metadata-document clients such as ChatGPT ------------------

const JWT_CLIENT = 'https://jwt.example.test/oauth/client.json';
const JWT_KEYS = 'https://jwt.example.test/oauth/jwks.json';
const INLINE_CLIENT = 'https://inline.example.test/client.json';
const PUBLIC_CLIENT = 'https://public.example.test/client.json';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
type Alg = 'RS256' | 'ES256' | 'EdDSA';
type Signer = { alg: Alg; kid: string; key: KeyObject; jwk: Record<string, unknown> };
function signer(alg: Alg, kid: string, modulusLength = 2048): Signer {
  const pair =
    alg === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength })
      : alg === 'ES256'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('ed25519');
  return {
    alg,
    kid,
    key: pair.privateKey,
    jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig' },
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function assertion(
  by: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const input = `${encode({ alg: by.alg, typ: 'JWT', kid: by.kid, ...header })}.${encode(claims)}`;
  const data = Buffer.from(input);
  const signature =
    by.alg === 'RS256'
      ? sign('sha256', data, by.key)
      : by.alg === 'ES256'
        ? sign('sha256', data, { key: by.key, dsaEncoding: 'ieee-p1363' })
        : sign(null, data, by.key);
  return `${input}.${signature.toString('base64url')}`;
}
const claimsFor = (clientId: string, now: number, extra: Record<string, unknown> = {}) => ({
  iss: clientId,
  sub: clientId,
  aud: `${ORIGIN}/oauth/token`,
  iat: Math.floor(now / 1000),
  exp: Math.floor(now / 1000) + 120,
  jti: randomUUID(),
  ...extra,
});
const withAssertion = (jwt: string) => ({
  client_assertion_type: ASSERTION_TYPE,
  client_assertion: jwt,
});

test('private_key_jwt clients (ChatGPT) authenticate every token request with a signed assertion', async (t) => {
  let time = 1_800_000_000_000;
  const rsa = signer('RS256', 'rsa-1');
  const stranger = signer('RS256', 'rsa-stranger');
  const documents = new Map<string, unknown>([
    [
      JWT_CLIENT,
      {
        client_id: JWT_CLIENT,
        client_name: 'Signed Client',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        token_endpoint_auth_signing_alg: 'RS256',
        jwks_uri: JWT_KEYS,
      },
    ],
    [JWT_KEYS, { keys: [rsa.jwk] }],
    [PUBLIC_CLIENT, { client_id: PUBLIC_CLIENT, redirect_uris: [REDIRECT] }],
  ]);
  const { app } = await fixture(t, {
    clock: () => time,
    fetchClientMetadata: async (url) => {
      if (!documents.has(url.href)) throw new Error('not found');
      return structuredClone(documents.get(url.href));
    },
  });
  const metadata = (
    await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
  ).json();
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none', 'private_key_jwt']);
  assert.deepEqual(metadata.token_endpoint_auth_signing_alg_values_supported, [
    'RS256',
    'ES256',
    'EdDSA',
  ]);
  assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, [
    'none',
    'private_key_jwt',
  ]);

  const { verifier, challenge } = pkce();
  const code = (
    await approve(app, authorizeUrl({ client_id: JWT_CLIENT, code_challenge: challenge }))
  ).searchParams.get('code')!;
  assert.match(code, /^jw/);
  const exchange = (fields: Record<string, string>) =>
    tokenRequest(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      ...fields,
    });
  // Without its assertion the client is refused, and the code is not consumed.
  const bare = await exchange({ client_id: JWT_CLIENT });
  assert.equal(bare.statusCode, 401);
  assert.equal(bare.json().error, 'invalid_client');
  const exchanged = await exchange({
    client_id: JWT_CLIENT,
    ...withAssertion(assertion(rsa, claimsFor(JWT_CLIENT, time))),
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  let tokens = exchanged.json();
  const refresh = (jwt?: string) =>
    tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      ...(jwt ? withAssertion(jwt) : { client_id: JWT_CLIENT }),
    });
  // Each assertion works once; the issuer identifier is an accepted audience too.
  const once = assertion(rsa, claimsFor(JWT_CLIENT, time, { aud: ORIGIN }));
  let res = await refresh(once);
  assert.equal(res.statusCode, 200, res.body);
  tokens = res.json();
  res = await refresh(once);
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error_description, /already used/);
  // A stolen refresh token without the client's key can neither be used nor burned.
  res = await refresh();
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_client');
  const seconds = Math.floor(time / 1000);
  for (const [label, jwt] of [
    ['audience', assertion(rsa, claimsFor(JWT_CLIENT, time, { aud: 'https://other.example/t' }))],
    ['expired', assertion(rsa, claimsFor(JWT_CLIENT, time, { exp: seconds - 120 }))],
    ['lifetime', assertion(rsa, claimsFor(JWT_CLIENT, time, { exp: seconds + 3600 }))],
    ['iat', assertion(rsa, claimsFor(JWT_CLIENT, time, { iat: seconds + 600 }))],
    ['jti', assertion(rsa, claimsFor(JWT_CLIENT, time, { jti: undefined }))],
    ['sub', assertion(rsa, claimsFor(JWT_CLIENT, time, { sub: PUBLIC_CLIENT }))],
    ['key', assertion({ ...stranger, kid: 'rsa-1' }, claimsFor(JWT_CLIENT, time))],
    ['kid', assertion(stranger, claimsFor(JWT_CLIENT, time))],
    [
      'header key',
      assertion(stranger, claimsFor(JWT_CLIENT, time), { kid: undefined, jwk: stranger.jwk }),
    ],
    ['alg none', `${encode({ alg: 'none' })}.${encode(claimsFor(JWT_CLIENT, time))}.`],
    [
      'HS256',
      `${encode({ alg: 'HS256', kid: 'rsa-1' })}.${encode(claimsFor(JWT_CLIENT, time))}.${'A'.repeat(43)}`,
    ],
  ] as const) {
    res = await refresh(jwt);
    assert.equal(res.statusCode, 401, label);
    assert.equal(res.json().error, 'invalid_client', label);
  }
  res = await refresh(assertion(rsa, claimsFor(JWT_CLIENT, time)));
  assert.equal(res.statusCode, 200, res.body);
  tokens = res.json();
  // Key rotation: an unknown kid refetches the JWK Set, at most every 30 seconds.
  const rotated = signer('RS256', 'rsa-2');
  documents.set(JWT_KEYS, { keys: [rsa.jwk, rotated.jwk] });
  assert.equal((await refresh(assertion(rotated, claimsFor(JWT_CLIENT, time)))).statusCode, 401);
  time += 31_000;
  res = await refresh(assertion(rotated, claimsFor(JWT_CLIENT, time)));
  assert.equal(res.statusCode, 200, res.body);
  tokens = res.json();
  // RFC 7009 revocation needs the assertion too; without it the family is untouched.
  await postForm(app, '/oauth/revoke', { token: tokens.refresh_token, client_id: JWT_CLIENT });
  assert.equal((await mcpCall(app, tokens.access_token, 'tools/list')).statusCode, 200);
  const revoked = await postForm(app, '/oauth/revoke', {
    token: tokens.refresh_token,
    ...withAssertion(
      assertion(rsa, claimsFor(JWT_CLIENT, time, { aud: `${ORIGIN}/oauth/revoke` })),
    ),
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal((await mcpCall(app, tokens.access_token, 'tools/list')).statusCode, 401);

  // A public metadata-document client cannot present assertions, and keeps working without.
  const plain = pkce();
  const plainCode = (
    await approve(app, authorizeUrl({ client_id: PUBLIC_CLIENT, code_challenge: plain.challenge }))
  ).searchParams.get('code')!;
  assert.doesNotMatch(plainCode, /^jw/);
  const plainExchange = (fields: Record<string, string>) =>
    tokenRequest(app, {
      grant_type: 'authorization_code',
      code: plainCode,
      code_verifier: plain.verifier,
      redirect_uri: REDIRECT,
      ...fields,
    });
  res = await plainExchange(withAssertion(assertion(rsa, claimsFor(PUBLIC_CLIENT, time))));
  assert.equal(res.json().error, 'invalid_client');
  assert.equal((await plainExchange({ client_id: PUBLIC_CLIENT })).statusCode, 200);
});

test('private_key_jwt accepts a fractional exp (RFC 7519 NumericDate) and still refuses its reuse', async (t) => {
  const time = 1_800_000_000_000;
  const rsa = signer('RS256', 'rsa-frac');
  const documents = new Map<string, unknown>([
    [
      JWT_CLIENT,
      {
        client_id: JWT_CLIENT,
        client_name: 'Signed Client',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'RS256',
        jwks_uri: JWT_KEYS,
      },
    ],
    [JWT_KEYS, { keys: [rsa.jwk] }],
  ]);
  const { app } = await fixture(t, {
    clock: () => time,
    fetchClientMetadata: async (url) => {
      if (!documents.has(url.href)) throw new Error('not found');
      return structuredClone(documents.get(url.href));
    },
  });
  const { verifier, challenge } = pkce();
  const code = (
    await approve(app, authorizeUrl({ client_id: JWT_CLIENT, code_challenge: challenge }))
  ).searchParams.get('code')!;
  // Microsecond precision, as `time.time() + 60` gives: not a whole number of milliseconds.
  const fractional = (extra: Record<string, unknown> = {}) =>
    assertion(rsa, claimsFor(JWT_CLIENT, time, { exp: time / 1000 + 60.123456, ...extra }));
  const exchanged = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
    ...withAssertion(fractional({ iat: time / 1000 + 0.5 })),
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  const once = fractional();
  let tokens = exchanged.json();
  const refresh = () =>
    tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      ...withAssertion(once),
    });
  const first = await refresh();
  assert.equal(first.statusCode, 200, first.body);
  tokens = first.json();
  const replay = await refresh();
  assert.equal(replay.statusCode, 401);
  assert.match(replay.json().error_description, /already used/);
});

test('private_key_jwt with an inline JWK Set (ES256, EdDSA); unusable key documents are refused', async (t) => {
  const time = 1_800_000_000_000;
  const ec = signer('ES256', 'ec-1');
  const ed = signer('EdDSA', 'ed-1');
  const weak = signer('RS256', 'weak', 1024);
  const bad = (name: string, extra: Record<string, unknown>) => {
    const clientId = `https://bad.example.test/${name}.json`;
    return [
      clientId,
      {
        client_id: clientId,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'private_key_jwt',
        ...extra,
      },
    ] as const;
  };
  const refused = [
    bad('nokeys', {}),
    bad('both', { jwks: { keys: [ec.jwk] }, jwks_uri: 'https://bad.example.test/jwks.json' }),
    bad('private', { jwks: { keys: [{ ...ec.jwk, d: 'AAAA' }] } }),
    bad('http', { jwks_uri: 'http://bad.example.test/jwks.json' }),
    bad('hs256', { token_endpoint_auth_signing_alg: 'HS256', jwks: { keys: [ec.jwk] } }),
    bad('weak', { jwks: { keys: [weak.jwk] } }),
  ];
  const documents = new Map<string, unknown>([
    [
      INLINE_CLIENT,
      {
        client_id: INLINE_CLIENT,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: { keys: [ec.jwk, ed.jwk] },
      },
    ],
    ...refused,
  ]);
  const { app } = await fixture(t, {
    clock: () => time,
    fetchClientMetadata: async (url) => structuredClone(documents.get(url.href)),
  });
  const reasons: Record<string, RegExp> = {
    nokeys: /exactly one of jwks or jwks_uri/,
    both: /exactly one of jwks or jwks_uri/,
    private: /publishes private key material/,
    http: /jwks_uri must be an https URL/,
    hs256: /must use RS256, ES256 or EdDSA/,
    weak: /no usable signing key/,
  };
  for (const [clientId] of refused) {
    const page = await openAuthorize(
      app,
      authorizeUrl({ client_id: clientId, code_challenge: pkce().challenge }),
    );
    assert.equal(page.status, 400, clientId);
    const name = clientId.slice('https://bad.example.test/'.length, -'.json'.length);
    assert.match(page.body, reasons[name]!, clientId);
  }
  const { verifier, challenge } = pkce();
  const code = (
    await approve(app, authorizeUrl({ client_id: INLINE_CLIENT, code_challenge: challenge }))
  ).searchParams.get('code')!;
  // The assertion's iss identifies the client; a conflicting client_id is refused.
  const exchange = (fields: Record<string, string>) =>
    tokenRequest(app, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      ...fields,
    });
  const conflicting = await exchange({
    client_id: PUBLIC_CLIENT,
    ...withAssertion(assertion(ec, claimsFor(INLINE_CLIENT, time))),
  });
  assert.equal(conflicting.json().error, 'invalid_client');
  const exchanged = await exchange(withAssertion(assertion(ec, claimsFor(INLINE_CLIENT, time))));
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  const refreshed = await tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: exchanged.json().refresh_token,
    ...withAssertion(assertion(ed, claimsFor(INLINE_CLIENT, time))),
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
});
