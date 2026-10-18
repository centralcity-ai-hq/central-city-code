import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  signedIn,
  ALL_SCOPES,
  approve,
  authorizeUrl,
  consentPost,
  fixture,
  fullFlow,
  mcpCall,
  openAuthorize,
  ownerApi,
  OWNER,
  PASSWORD,
  pkce,
  postForm,
  REDIRECT,
  redirectFrom,
  registerClient,
  RESOURCE,
  tokenRequest,
  type App,
} from './oauth-helpers.js';
import { clientAddressKey, LOGIN_FAILURES } from '../server/rate-limit.js';
import { autoRedirectAllowed, OAUTH_CAPS, OAUTH_LIFETIMES } from '../server/oauth/server.js';
import { metadataRedirectAllowed, validateMetadataDocument } from '../server/oauth/clients.js';
import type { AssistantGrant } from '../shared/assistant.js';

const CIMD = 'https://client.example.test/oauth/metadata.json';
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

test('consent pages use same-origin referrers; Origin null needs Sec-Fetch-Site same-origin', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const url = authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge });
  const page = await app.inject({ method: 'GET', url });
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  const form = await openAuthorize(app, url);
  const fields = { action: 'login', name: OWNER, password: PASSWORD };
  assert.equal((await consentPost(app, form, fields, { origin: 'null' })).statusCode, 403);
  assert.equal(
    (await consentPost(app, form, fields, { origin: 'null', 'sec-fetch-site': 'same-site' }))
      .statusCode,
    403,
  );
  const ok = await consentPost(app, form, fields, {
    origin: 'null',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('one source cannot lock an owner out, and lockout never reveals which names exist', async (t) => {
  const { app } = await fixture(t);
  const login = (name: string, password: string, remoteAddress: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress,
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password }),
    });
  // Fastify inject's default client address, so the consent flow below comes from it too.
  const attacker = '127.0.0.1';
  const prober = '198.51.100.9';
  const client = await registerClient(app);
  const url = () => authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge });
  // A malformed credential on the consent page gets the generic message, not a server error.
  const other = await openAuthorize(app, url());
  const malformed = await consentPost(app, other, {
    action: 'login',
    name: 'x',
    password: 'short',
  });
  assert.equal(malformed.statusCode, 401);
  assert.match(malformed.body, /Invalid account name or password/);
  for (let i = 0; i < LOGIN_FAILURES.perAccountAddress; i++) {
    assert.equal((await login(OWNER, 'wrong password value', attacker)).statusCode, 401);
    assert.equal((await login('No such owner', 'wrong password value', prober)).statusCode, 401);
  }
  // The attacking source is refused, identically for existing and missing names...
  const locked = await login(OWNER, PASSWORD, attacker);
  const missing = await login('No such owner', PASSWORD, prober);
  assert.equal(locked.statusCode, 429);
  assert.equal(missing.statusCode, 429);
  assert.equal(locked.json().error, missing.json().error);
  // ...while the owner signing in from elsewhere is unaffected.
  assert.equal((await login(OWNER, PASSWORD, '192.0.2.50')).statusCode, 200);
  // The consent-page login shares the per-source budget.
  const form = await openAuthorize(app, url());
  const consent = await consentPost(app, form, {
    action: 'login',
    name: OWNER,
    password: PASSWORD,
  });
  assert.equal(consent.statusCode, 429);
  // Refused by the per-source budgets (the per-address login limit may trip first).
  assert.match(consent.body, /Too many (sign-in attempts|requests)/);
});

test('an account-wide failure ceiling needs many sources and there is no deployment-wide lock', async (t) => {
  const { app } = await fixture(t);
  const login = (name: string, password: string, remoteAddress: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress,
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password }),
    });
  // The owner's own browser signed in once before the attack and holds a known-device cookie.
  const first = await login(OWNER, PASSWORD, '192.0.2.70');
  assert.equal(first.statusCode, 200);
  const device = first.cookies.find((cookie) => cookie.name === 'cc_device');
  assert.ok(device?.httpOnly && device.sameSite === 'Strict');
  const perSource = LOGIN_FAILURES.perAccountAddress;
  const sources = LOGIN_FAILURES.perAccount / perSource;
  for (let s = 0; s < sources; s++)
    for (let i = 0; i < perSource; i++)
      assert.equal((await login(OWNER, 'wrong password value', `10.0.${s}.1`)).statusCode, 401);
  // The ceiling is reached only after failures from many distinct sources, and then blocks
  // unknown browsers even with the correct password...
  assert.equal((await login(OWNER, PASSWORD, '192.0.2.60')).statusCode, 429);
  // ...but not the owner's known browser, from any address; a forged cookie does not help.
  const known = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '192.0.2.71',
    headers: { ...jsonHeaders, cookie: `cc_device=${device!.value}` },
    payload: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(known.statusCode, 200, known.body);
  const forged = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '192.0.2.72',
    headers: { ...jsonHeaders, cookie: 'cc_device=forged-device-token-value' },
    payload: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(forged.statusCode, 429);
  // Other accounts are unaffected: failures never lock the whole deployment.
  assert.equal(
    (await login('Unrelated owner', 'wrong password value', '192.0.2.61')).statusCode,
    401,
  );
});

test('IPv6 clients are rate limited per /64 prefix', async (t) => {
  assert.equal(clientAddressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(clientAddressKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(clientAddressKey('2001:DB8:0001:0002::9'), '2001:db8:1:2::/64');
  assert.equal(clientAddressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientAddressKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(clientAddressKey('198.51.100.7'), '198.51.100.7');
  assert.notEqual(clientAddressKey('2001:db8:1:3::1'), clientAddressKey('2001:db8:1:2::1'));
  const { app } = await fixture(t);
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++)
    statuses.push(
      (
        await app.inject({
          method: 'POST',
          url: '/oauth/register',
          remoteAddress: `2001:db8:77:1:${(i + 1).toString(16)}::1`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ redirect_uris: [REDIRECT] }),
        })
      ).statusCode,
    );
  assert.equal(statuses.at(-1), 429);
  assert.equal(statuses.at(-2), 201);
});

test('unauthenticated pending authorizations are evicted, never refused, at the global bound', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const operator = (await app.city.db.query<{ id: string }>('SELECT id FROM operators')).rows[0]!;
  const base = Date.now();
  for (let i = 0; i < OAUTH_CAPS.pending; i++)
    await app.city.db.query(
      `INSERT INTO oauth_pending(id,form_hash,browser_hash,client_id,client_name,client_verified,
       redirect_uri,code_challenge,resource,scopes,state,operator_id,created_at,expires_at)
       VALUES($1,'x','x',$2,'n',false,$3,'c',$4,'["workspace:read"]',null,$5,$6,$7)`,
      [
        randomUUID(),
        client.client_id,
        REDIRECT,
        RESOURCE,
        i === 0 ? operator.id : null,
        base - 60_000 + i,
        base + 3_600_000,
      ],
    );
  const page = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
  );
  assert.equal(page.status, 200, page.body);
  const counts = (
    await app.city.db.query<{ n: string; signed: string }>(
      'SELECT count(*) AS n, count(operator_id) AS signed FROM oauth_pending',
    )
  ).rows[0]!;
  assert.equal(Number(counts.n), OAUTH_CAPS.pending);
  // The owner-authenticated request (the oldest row) survives eviction.
  assert.equal(Number(counts.signed), 1);
});

test('dynamic registration evicts the oldest unused clients instead of refusing', async (t) => {
  const { app } = await fixture(t);
  const flow = await fullFlow(app);
  const now = Date.now();
  for (let i = 0; i < OAUTH_CAPS.clients - 1; i++)
    await app.city.db.query(
      'INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES($1,$2,$3::jsonb,$4)',
      [`ccc_filler_${i}`, 'n', JSON.stringify([REDIRECT]), now - 1_000 + i],
    );
  // The used client is the oldest row but is never evicted.
  await app.city.db.query('UPDATE oauth_clients SET created_at=0 WHERE client_id=$1', [
    flow.client.client_id,
  ]);
  const fresh = await registerClient(app);
  const ids = (
    await app.city.db.query<{ client_id: string }>('SELECT client_id FROM oauth_clients')
  ).rows.map((row) => row.client_id);
  assert.equal(ids.length, OAUTH_CAPS.clients);
  assert.ok(ids.includes(flow.client.client_id));
  assert.ok(ids.includes(fresh.client_id));
  assert.ok(!ids.includes('ccc_filler_0'));
});

test('only verified metadata-document clients receive automatic error redirects', async (t) => {
  const { app } = await fixture(t, {
    fetchClientMetadata: async () => ({ client_id: CIMD, redirect_uris: [REDIRECT] }),
  });
  const verified = await openAuthorize(
    app,
    authorizeUrl({ client_id: CIMD, code_challenge: pkce().challenge, response_type: 'token' }),
  );
  assert.equal(redirectFrom(verified.body).searchParams.get('error'), 'unsupported_response_type');
  const client = await registerClient(app);
  const unverified = await openAuthorize(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: pkce().challenge,
      response_type: 'token',
    }),
  );
  assert.equal(unverified.status, 400);
  assert.doesNotMatch(unverified.body, /http-equiv="refresh"/);
  assert.match(unverified.body, /unverified client/);
});

test('metadata-document clients return only to their own origin or loopback', async (t) => {
  const own = 'https://client.example.test/callback';
  const foreign = [
    'https://evil.example/cb',
    'https://sub.client.example.test/cb',
    'https://client.example.test:8443/cb',
    'com.example.client:/cb',
  ];
  const FOREIGN_ONLY = 'https://foreign.example.test/meta.json';
  const documents = new Map<string, unknown>([
    [CIMD, { client_id: CIMD, client_name: 'Bound', redirect_uris: [own, ...foreign, REDIRECT] }],
    [FOREIGN_ONLY, { client_id: FOREIGN_ONLY, redirect_uris: ['https://evil.example/cb'] }],
  ]);
  const { app } = await fixture(t, {
    fetchClientMetadata: async (url) => documents.get(url.href),
  });
  for (const redirect_uri of foreign) {
    const res = await openAuthorize(
      app,
      authorizeUrl({
        client_id: CIMD,
        code_challenge: pkce().challenge,
        redirect_uri,
        response_type: 'token',
      }),
    );
    assert.equal(res.status, 400, redirect_uri);
    assert.match(res.body, /only return to its own origin or a loopback address/);
    assert.doesNotMatch(res.body, /http-equiv="refresh"/);
    assert.doesNotMatch(res.body, /evil\.example|sub\.client|8443|com\.example\.client/);
  }
  // Errors on the client's own (not well-known) origin get a link page, never an automatic
  // redirect: anyone can publish a metadata document on their own domain (RFC 9700 4.11.2).
  const sameOrigin = await openAuthorize(
    app,
    authorizeUrl({
      client_id: CIMD,
      code_challenge: pkce().challenge,
      redirect_uri: own,
      response_type: 'token',
    }),
  );
  assert.equal(sameOrigin.status, 400);
  assert.doesNotMatch(sameOrigin.body, /http-equiv="refresh"/);
  assert.match(sameOrigin.body, /client.example.test/);
  // ...and to loopback on any port (RFC 8252), where the approval flow completes.
  const { verifier, challenge } = pkce();
  const loopback = 'http://127.0.0.1:50123/callback';
  const code = (
    await approve(
      app,
      authorizeUrl({ client_id: CIMD, code_challenge: challenge, redirect_uri: loopback }),
    )
  ).searchParams.get('code')!;
  const tokens = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: CIMD,
    redirect_uri: loopback,
    resource: RESOURCE,
  });
  assert.equal(tokens.statusCode, 200, tokens.body);
  // A document with no redirect URI on its own origin or loopback is refused outright.
  const refused = await openAuthorize(
    app,
    authorizeUrl({
      client_id: FOREIGN_ONLY,
      code_challenge: pkce().challenge,
      redirect_uri: 'https://evil.example/cb',
    }),
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body, /no redirect_uris on its own origin or a loopback address/);
  assert.doesNotMatch(refused.body, /http-equiv="refresh"/);

  // The rule keeps the real clients working: their published documents (fetched 2026-09-26)
  // bind every redirect URI to the client_id origin or to loopback.
  const code_flow = {
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  const published = [
    {
      client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      ],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    {
      client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      ...code_flow,
      token_endpoint_auth_method: 'none',
    },
    {
      client_id: 'https://chatgpt.com/oauth/client.json',
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      ...code_flow,
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
    },
    {
      client_id: 'https://chatgpt.com/oauth/codex/abc123ABC_-x/client.json',
      client_name: 'Codex',
      application_type: 'native',
      redirect_uris: [
        'http://127.0.0.1/callback/abc123ABC_-x',
        'http://localhost/callback/abc123ABC_-x',
      ],
      ...code_flow,
      token_endpoint_auth_method: 'none',
    },
  ];
  for (const document of published) {
    const resolved = validateMetadataDocument(document.client_id, document);
    assert.equal(resolved.clientName, document.client_name);
    assert.deepEqual(resolved.redirectUris, document.redirect_uris);
    assert.deepEqual(resolved.refusedRedirectUris, []);
    assert.equal(
      resolved.authMethod,
      document.client_name === 'ChatGPT' ? 'private_key_jwt' : 'none',
    );
  }
  // Shared-secret methods are never accepted.
  assert.throws(
    () =>
      validateMetadataDocument(CIMD, {
        client_id: CIMD,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
        token_endpoint_auth_methods_supported: ['none'],
      }),
    /"none" \(PKCE\) or "private_key_jwt"/,
  );
  assert.equal(
    metadataRedirectAllowed(
      'https://chatgpt.com/oauth/client.json',
      'https://chatgpt.com/connector_platform_oauth_redirect',
    ),
    true,
  );
  assert.equal(
    metadataRedirectAllowed(
      'https://claude.ai/oauth/x',
      'https://claude.com/api/mcp/auth_callback',
    ),
    false,
  );
  assert.equal(metadataRedirectAllowed('https://a.example/x', 'http://[::1]:9/cb'), true);
  assert.equal(metadataRedirectAllowed('https://a.example/x', 'https://a.example:443/cb'), true);
  assert.equal(metadataRedirectAllowed('https://a.example/x', 'https://A.EXAMPLE/cb'), true);
  assert.equal(metadataRedirectAllowed('https://a.example/x', 'https://a.example./cb'), false);
});

test('JSON-RPC batches are refused on /mcp', async (t) => {
  const { app } = await fixture(t);
  const { tokens } = await fullFlow(app);
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, -32600);
});

async function tokenRows(app: App) {
  const rows = (
    await app.city.db.query<{ kind: string; rotated: boolean }>(
      'SELECT kind, used_at IS NOT NULL AS rotated FROM oauth_tokens',
    )
  ).rows;
  return {
    access: rows.filter((row) => row.kind === 'access').length,
    rotated: rows.filter((row) => row.kind === 'refresh' && row.rotated).length,
    current: rows.filter((row) => row.kind === 'refresh' && !row.rotated).length,
    codes: (await app.city.db.query('SELECT 1 FROM oauth_codes')).rows.length,
    families: (await app.city.db.query('SELECT 1 FROM oauth_families')).rows.length,
  };
}
const refreshWith = (app: App, clientId: string, refresh_token: string) =>
  tokenRequest(app, { grant_type: 'refresh_token', refresh_token, client_id: clientId });

test('reuse detection lasts until the grant ends; dead rows are cleaned up', async (t) => {
  let time = 1_800_000_000_000;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: '30' });
  const refreshes = [flow.tokens.refresh_token];
  for (let i = 0; i < 5; i++) {
    time += 3_600_000;
    const res = await refreshWith(app, flow.client.client_id, refreshes.at(-1)!);
    assert.equal(res.statusCode, 200, res.body);
    refreshes.push(res.json().refresh_token);
  }
  // Twenty days later expired access tokens are gone, but every rotated refresh token and the
  // exchanged code remain as tombstones (the grant runs for 30 days).
  time += 20 * 86_400_000;
  const res = await refreshWith(app, flow.client.client_id, refreshes.at(-1)!);
  assert.equal(res.statusCode, 200, res.body);
  const live = res.json().access_token as string;
  assert.deepEqual(await tokenRows(app), {
    access: 1,
    rotated: 6,
    current: 1,
    codes: 1,
    families: 1,
  });
  // Replaying the code twenty days after its exchange still revokes the family.
  const replay = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: flow.code,
    code_verifier: flow.verifier,
    client_id: flow.client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(replay.json().error, 'invalid_grant');
  assert.equal((await mcpCall(app, live, 'tools/list')).statusCode, 401);
  // (The owner's browser session has expired by now, so the grant is read directly.)
  const grant = await app.city.db.query<{ revoked_at: string | null }>(
    'SELECT revoked_at FROM assistant_grants',
  );
  assert.equal(Number(grant.rows[0]!.revoked_at), time);
  // Revoked rows go at the next token request, the family a day after its revocation.
  time += 86_400_000 + 1;
  assert.equal(
    (await refreshWith(app, flow.client.client_id, refreshes[0]!)).json().error,
    'invalid_grant',
  );
  assert.deepEqual(await tokenRows(app), {
    access: 0,
    rotated: 0,
    current: 0,
    codes: 0,
    families: 0,
  });
});

test('rotated tombstones are capped per family; a pruned token still revokes the family', async (t) => {
  let time = 1_800_000_000_000;
  const { app, cookie } = await fixture(t, { clock: () => time });
  const other = await fullFlow(app, { days: '30' });
  time += 1_000;
  const flow = await fullFlow(app, { days: '30' });
  const refreshes = [flow.tokens.refresh_token];
  for (let i = 0; i < OAUTH_CAPS.rotatedPerFamily + 5; i++) {
    time += 2_000; // stays under 60 token requests per minute per address
    const res = await refreshWith(app, flow.client.client_id, refreshes.at(-1)!);
    assert.equal(res.statusCode, 200, res.body);
    refreshes.push(res.json().refresh_token);
  }
  const rotated = await app.city.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family_id
      WHERE f.client_id=$1 AND t.kind='refresh' AND t.used_at IS NOT NULL`,
    [flow.client.client_id],
  );
  assert.equal(Number(rotated.rows[0]!.n), OAUTH_CAPS.rotatedPerFamily);
  // Unknown tokens that name no live family change nothing: a forged family id and a token in
  // the earlier all-random format.
  const forged = `ccr_${Buffer.concat([
    Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
    randomBytes(16),
  ]).toString('base64url')}`;
  for (const unknown of [forged, `ccr_${randomBytes(32).toString('base64url')}`])
    assert.equal(
      (await refreshWith(app, flow.client.client_id, unknown)).json().error,
      'invalid_grant',
    );
  assert.equal((await refreshWith(app, flow.client.client_id, refreshes.at(-1)!)).statusCode, 200);
  // The first token's tombstone was pruned, yet its embedded family id revokes the family.
  const pruned = await refreshWith(app, flow.client.client_id, refreshes[0]!);
  assert.equal(pruned.json().error, 'invalid_grant');
  const grants = (await ownerApi(app, cookie, '/api/assistant-access')).json()
    .grants as AssistantGrant[];
  assert.deepEqual(
    grants.map((grant) => grant.revokedAt === null),
    [false, true],
  );
  // The other client's family is untouched.
  assert.equal(
    (await refreshWith(app, other.client.client_id, other.tokens.refresh_token)).statusCode,
    200,
  );
  // RFC 7009 revocation of a pruned token also finds its family.
  const third = await fullFlow(app, { days: '30' });
  const chain = [third.tokens.refresh_token];
  for (let i = 0; i < OAUTH_CAPS.rotatedPerFamily + 1; i++) {
    time += 2_000;
    const res = await refreshWith(app, third.client.client_id, chain.at(-1)!);
    assert.equal(res.statusCode, 200, res.body);
    chain.push(res.json().refresh_token);
  }
  await postForm(app, '/oauth/revoke', { token: chain[0]!, client_id: third.client.client_id });
  assert.equal(
    (await refreshWith(app, third.client.client_id, chain.at(-1)!)).json().error,
    'invalid_grant',
  );
});

test('a grant whose code is never exchanged stops holding a slot once the code expires', async (t) => {
  let time = 1_800_000_000_000;
  const { app, cookie } = await fixture(t, { clock: () => time });
  const grants = async () =>
    (await ownerApi(app, cookie, '/api/assistant-access')).json().grants as AssistantGrant[];
  const active = async () => (await grants()).filter((grant) => grant.revokedAt === null).length;
  // An exchanged grant and a local-bridge grant are never released.
  const used = await fullFlow(app, { days: '30' });
  const bridge = await ownerApi(app, cookie, '/api/assistant-access', {
    label: 'Local bridge',
    scopes: ['workspace:read'],
    expiresInDays: 30,
  });
  assert.equal(bridge.statusCode, 201, bridge.body);
  const client = await registerClient(app);
  const start = () =>
    authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge });
  for (let i = 0; i < 3; i++) await approve(app, start());
  assert.equal(await active(), 5);
  // A sixth approval is no longer refused while the unexchanged codes are still valid...
  await approve(app, start());
  assert.equal(await active(), 6);
  // ...and once the codes expired, the next approval first releases the four dead grants.
  time += OAUTH_LIFETIMES.codeMs + OAUTH_LIFETIMES.codeGraceMs;
  await approve(app, start());
  assert.equal(await active(), 3);
  const events = (await ownerApi(app, cookie, '/api/snapshot')).json().events as {
    message: string;
  }[];
  assert.equal(
    events.filter((event) =>
      /released because its authorization code expired without being exchanged/.test(event.message),
    ).length,
    4,
  );
  // Bounded cleanup on any token request releases the newest one after its code expires, too.
  time += OAUTH_LIFETIMES.codeMs + OAUTH_LIFETIMES.codeGraceMs;
  assert.equal(
    (await refreshWith(app, 'ccc_unknown', `ccr_${randomBytes(32).toString('base64url')}`)).json()
      .error,
    'invalid_grant',
  );
  assert.deepEqual(
    (await grants())
      .filter((grant) => grant.revokedAt === null)
      .map((grant) => grant.label)
      .sort(),
    ['Local bridge', 'Synthetic MCP client'],
  );
  assert.equal(
    (await refreshWith(app, used.client.client_id, used.tokens.refresh_token)).statusCode,
    200,
  );
});

test('revoking a grant’s last token family revokes the grant too', async (t) => {
  const { app, cookie } = await fixture(t);
  const active = async () =>
    (
      (await ownerApi(app, cookie, '/api/assistant-access')).json().grants as AssistantGrant[]
    ).filter((grant) => grant.revokedAt === null).length;
  const reused = await fullFlow(app);
  const rotate = () =>
    tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: reused.tokens.refresh_token,
      client_id: reused.client.client_id,
    });
  assert.equal((await rotate()).statusCode, 200);
  assert.equal((await rotate()).json().error, 'invalid_grant');
  assert.equal(await active(), 0);
  const revoked = await fullFlow(app);
  assert.equal(await active(), 1);
  await postForm(app, '/oauth/revoke', {
    token: revoked.tokens.refresh_token,
    client_id: revoked.client.client_id,
  });
  assert.equal(await active(), 0);
  const events = (await ownerApi(app, cookie, '/api/snapshot')).json().events as {
    message: string;
  }[];
  assert.ok(
    events.some((event) => /revoked because its OAuth tokens were revoked/.test(event.message)),
  );
});

test('an omitted scope requests the core set; core write scopes start checked, others unchecked', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const readOnly = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge, scope: 'OMIT' }),
  );
  const login = await consentPost(app, readOnly, {
    action: 'login',
    name: OWNER,
    password: PASSWORD,
  });
  // The core set (join rooms, create agent records) is requested and pre-checked: a plain Approve lets a ChatGPT user join a room from an invite link.
  assert.match(login.body, /name="scope" value="agents:create" checked>/);
  assert.match(login.body, /name="scope" value="rooms:join" checked>/);
  assert.equal((login.body.match(/name="scope"/g) ?? []).length, 2);
  const { verifier, challenge } = pkce();
  const back = await approve(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge, scope: 'OMIT' }),
    { scopes: ['agents:create'] },
  );
  const tokens = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  // The server grants exactly what the owner submits: unticking rooms:join drops it.
  assert.deepEqual(tokens.json().scope.split(' ').sort(), ['agents:create', 'workspace:read']);
  const writeFlow = pkce();
  const write = await openAuthorize(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: writeFlow.challenge,
      scope: ALL_SCOPES,
    }),
  );
  const consent = await consentPost(app, write, {
    action: 'login',
    name: OWNER,
    password: PASSWORD,
  });
  // Requested write scopes are marked; the core one (agents:create) starts checked, the others
  // unchecked: the owner opts in to each of those.
  assert.equal((consent.body.match(/class="badge">Write access/g) ?? []).length, 3);
  assert.match(
    consent.body,
    /Other permissions that change your workspace stay off until you select them/,
  );
  assert.match(consent.body, /name="scope" value="agents:create" checked>/);
  for (const scope of ['jobs:create', 'jobs:cancel'])
    assert.match(consent.body, new RegExp(`name="scope" value="${scope}">`));
  assert.deepEqual(
    [...consent.body.matchAll(/name="scope" value="([^"]+)" checked/g)].map((m) => m[1]),
    ['agents:create'],
  );
  assert.match(consent.body, /<input type="checkbox" checked disabled> <span><code>workspace:read/);
  const exchange = async (code: string, code_verifier: string) =>
    (
      await tokenRequest(app, {
        grant_type: 'authorization_code',
        code,
        code_verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
      })
    ).json().scope;
  // A POST that selects nothing (the core box unticked) grants read access only...
  const untouched = await consentPost(app, signedIn(write, consent), {
    action: 'approve',
    expires_in_days: '1',
  });
  assert.equal(
    await exchange(redirectFrom(untouched.body).searchParams.get('code')!, writeFlow.verifier),
    'workspace:read',
  );
  // ...and exactly the write scopes the owner selects.
  const selected = pkce();
  const chosen = await approve(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: selected.challenge,
      scope: ALL_SCOPES,
    }),
    { scopes: ['jobs:create'] },
  );
  assert.equal(
    await exchange(chosen.searchParams.get('code')!, selected.verifier),
    'workspace:read jobs:create',
  );
});

test('unverified clients show their redirect host and a warning; bad Basic auth is invalid_client', async (t) => {
  const { app } = await fixture(t);
  const client = await registerClient(app);
  const page = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
  );
  assert.match(
    page.body,
    /<h1>Sign in to connect Synthetic MCP client \(returns to http:\/\/127\.0\.0\.1:43123\)<\/h1>/,
  );
  assert.match(page.body, /class="danger"[^>]*><strong>Unverified client/);
  for (const authorization of [
    'Basic %%%notbase64',
    `Basic ${Buffer.from('%E0%A4%A:x').toString('base64')}`,
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
      payload: 'grant_type=refresh_token&refresh_token=x',
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, 'invalid_client');
  }
});

test('an owner without a password (Google sign-in) continues from the login page with their session', async (t) => {
  const { app, cookie } = await fixture(t);
  const client = await registerClient(app);
  const { verifier, challenge } = pkce();
  // The cross-site arrival carries no SameSite=Strict session cookie, so the login page shows.
  const login = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: challenge, scope: ALL_SCOPES }),
  );
  assert.equal(login.status, 200, login.body);
  assert.match(login.body, /Operator name/);
  const href = /<a href="(\/oauth\/authorize\?[^"]+)">continue here<\/a>/.exec(login.body)?.[1];
  assert.ok(href, login.body);
  // Clicking the same-origin link sends the session cookie: the consent page, no password.
  const form = await openAuthorize(app, href.replaceAll('&amp;', '&'), cookie);
  assert.equal(form.status, 200, form.body);
  assert.match(form.body, /Allow .* to access Central City/);
  const res = await consentPost(
    app,
    { ...form, cookie: `${form.cookie}; ${cookie}` },
    { action: 'approve', scope: ['jobs:create'], expires_in_days: '7' },
  );
  assert.equal(res.statusCode, 200, res.body);
  const back = redirectFrom(res.body);
  assert.equal(back.searchParams.get('state'), 'synthetic-state');
  const token = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
  });
  assert.equal(token.statusCode, 200, token.body);
  assert.equal(token.json().scope, 'workspace:read jobs:create');
});

test('an attacker-published metadata document cannot turn authorize errors into an open redirect', async (t) => {
  const EVIL = 'https://evil.example.test/client.json';
  const evilCallback = 'https://evil.example.test/x';
  const { app } = await fixture(t, {
    fetchClientMetadata: async () => ({ client_id: EVIL, redirect_uris: [evilCallback] }),
  });
  const res = await openAuthorize(
    app,
    authorizeUrl({
      client_id: EVIL,
      redirect_uri: evilCallback,
      code_challenge: pkce().challenge,
      response_type: 'token',
    }),
  );
  // RFC 9700 4.11.2: the owner sees a page with a link instead of being sent to evil.example.
  assert.equal(res.status, 400);
  assert.doesNotMatch(res.body, /http-equiv="refresh"/);
  assert.match(res.body, /evil\.example\.test/);
});

test('signing out, or another owner signing in, cancels an open consent request', async (t) => {
  const { app, cookie } = await fixture(t);
  const client = await registerClient(app);
  const url = authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge });
  // The owner is signed in: the page is stamped for them.
  const form = await openAuthorize(app, url, cookie);
  assert.match(form.body, /Allow .* to access Central City/);
  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { ...jsonHeaders, cookie },
    payload: '{}',
  });
  assert.equal(logout.statusCode, 200, logout.body);
  // The old tab approves after sign-out: refused, with the signed-out session or none.
  for (const withCookie of [form, { ...form, cookie: `${form.cookie}; ${cookie}` }]) {
    const res = await consentPost(app, withCookie, { action: 'approve', expires_in_days: '1' });
    assert.equal(res.statusCode, 401, res.body);
    assert.match(res.body, /Sign in before approving/);
  }
  // Another owner signs in on the same browser: still refused for the first owner's request.
  const other = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Second owner', password: PASSWORD }),
  });
  const otherCookie = `cc_session=${other.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const swapped = await consentPost(
    app,
    { ...form, cookie: `${form.cookie}; ${otherCookie}` },
    { action: 'approve', expires_in_days: '1' },
  );
  assert.equal(swapped.statusCode, 401, swapped.body);
  assert.match(swapped.body, /signed-in account changed/);
  // Signing in on the form re-stamps the request for whoever signs in, and approval works.
  const login = await consentPost(app, form, {
    action: 'login',
    name: 'Second owner',
    password: PASSWORD,
  });
  assert.equal(login.statusCode, 200, login.body);
  const approved = await consentPost(app, signedIn(form, login), {
    action: 'approve',
    expires_in_days: '1',
  });
  assert.ok(redirectFrom(approved.body).searchParams.get('code'));
});

test('a refresh that asks for fewer scopes is refused and the refresh token still works', async (t) => {
  const { app } = await fixture(t);
  const { client, tokens } = await fullFlow(app);
  const refresh = (scope?: string) =>
    tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      ...(scope === undefined ? {} : { scope }),
    });
  const narrower = await refresh('workspace:read');
  assert.equal(narrower.statusCode, 400, narrower.body);
  assert.equal(narrower.json().error, 'invalid_scope');
  // Nothing was rotated: the same refresh token still works with the granted scope.
  const same = await refresh();
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().scope, tokens.scope);
});

test('the IPv6 loopback redirect counts as loopback for verified clients', () => {
  assert.equal(autoRedirectAllowed(true, 'http://[::1]:5555/cb'), true);
  assert.equal(autoRedirectAllowed(true, 'http://127.0.0.1:5555/cb'), true);
  assert.equal(autoRedirectAllowed(false, 'http://[::1]:5555/cb'), false);
  assert.equal(autoRedirectAllowed(true, 'https://[::1]:5555/cb'), false);
});
