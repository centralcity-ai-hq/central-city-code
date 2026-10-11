import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../server/app.js';
import { vaultProofTypedData } from '../shared/base/vault.js';

/**
 * The wallet routes as the console reaches them (server/app.ts): behind CITY_BASE_WALLET, the
 * console session, the request guard on writes, person accounts only. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const guarded = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, flag: string | null) {
  const previous = process.env.CITY_BASE_WALLET;
  if (flag === null) delete process.env.CITY_BASE_WALLET;
  else process.env.CITY_BASE_WALLET = flag;
  t.after(async () => {
    if (previous === undefined) delete process.env.CITY_BASE_WALLET;
    else process.env.CITY_BASE_WALLET = previous;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return app;
}

async function person(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: guarded,
    payload: JSON.stringify({ name, password: 'Synthetic wallet owner password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((cookie) => cookie.name === 'cc_session')!.value}`;
}

test('with the flag off the wallet routes do not exist', async (t) => {
  const app = await fixture(t, null);
  const cookie = await person(app, 'Wallet person');
  assert.equal((await app.inject({ url: '/api/base/vault', headers: { cookie } })).statusCode, 404);
  const post = await app.inject({
    method: 'POST',
    url: `/api/base/agents/${randomUUID()}/wallet`,
    headers: { ...guarded, cookie },
    payload: '{}',
  });
  assert.equal(post.statusCode, 404);
  const withdrawals = `/api/base/agents/${randomUUID()}/wallet/withdrawals`;
  const withdraw = await app.inject({
    method: 'POST',
    url: withdrawals,
    headers: { ...guarded, cookie },
    payload: '{}',
  });
  assert.equal(withdraw.statusCode, 404);
  assert.equal(
    (await app.inject({ url: `${withdrawals}/${randomUUID()}`, headers: { cookie } })).statusCode,
    404,
  );
  const limits = await app.inject({
    url: `/api/base/agents/${randomUUID()}/wallet/limits`,
    headers: { cookie },
  });
  assert.equal(limits.statusCode, 404);
});

test('withdrawals through the console: request guard and session, only a wallet owner', async (t) => {
  const app = await fixture(t, '1');
  const cookie = await person(app, 'Withdrawing person');
  const withdrawals = `/api/base/agents/${randomUUID()}/wallet/withdrawals`;
  const body = JSON.stringify({
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    token: 'USDC',
    amount: '1',
    to: `0x${'5e'.repeat(20)}`,
  });
  // Writes need the console's request header; reads and writes need a session.
  const unguarded = await app.inject({
    method: 'POST',
    url: withdrawals,
    headers: { 'content-type': 'application/json', cookie },
    payload: body,
  });
  assert.equal(unguarded.statusCode, 403);
  const signedOut = await app.inject({
    method: 'POST',
    url: withdrawals,
    headers: guarded,
    payload: body,
  });
  assert.equal(signedOut.statusCode, 401);
  // Not the owner of any wallet of this agent: not found, nothing disclosed.
  const stranger = await app.inject({
    method: 'POST',
    url: withdrawals,
    headers: { ...guarded, cookie },
    payload: body,
  });
  assert.equal(stranger.statusCode, 404);
});

test('a person stores a vault through the console; guard, session and AI workspaces hold', async (t) => {
  const app = await fixture(t, '1');
  const cookie = await person(app, 'Wallet person');
  assert.equal((await app.inject({ url: '/api/base/vault' })).statusCode, 401);
  const first = await app.inject({ url: '/api/base/vault', headers: { cookie } });
  assert.equal(first.statusCode, 200, first.body);
  const { accountId, challenge } = first.json();

  const signer = privateKeyToAccount(generatePrivateKey());
  const encryptedKey = `0x${'5a'.repeat(48)}` as const;
  const kdf = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt: `0x${'ab'.repeat(16)}` as const };
  const cipher = { alg: 'AES-256-GCM', iv: `0x${'cd'.repeat(12)}` as const };
  const body = {
    ownerAddress: signer.address,
    encryptedKey,
    kdf,
    cipher,
    proof: {
      nonce: challenge.nonce,
      signature: await signer.signTypedData(
        vaultProofTypedData({
          accountId,
          ownerAddress: signer.address,
          envelope: { encryptedKey, kdf, cipher },
          version: 1,
          purpose: 'create',
          nonce: challenge.nonce,
        }),
      ),
    },
  };
  // Writes need the console's request header.
  const unguarded = await app.inject({
    method: 'POST',
    url: '/api/base/vault',
    headers: { 'content-type': 'application/json', cookie },
    payload: JSON.stringify(body),
  });
  assert.equal(unguarded.statusCode, 403);
  const created = await app.inject({
    method: 'POST',
    url: '/api/base/vault',
    headers: { ...guarded, cookie },
    payload: JSON.stringify(body),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().ownerAddress, signer.address);

  // An AI workspace the person co-owns has no vault, and its key is not a person.
  const workspace = (
    await app.inject({
      method: 'POST',
      url: '/api/public/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Wallet AI', idempotency_key: randomUUID() }),
    })
  ).json();
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...guarded, cookie },
    payload: JSON.stringify({ claim_token: workspace.claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const viaAi = await app.inject({
    url: '/api/base/vault',
    headers: { cookie, 'x-city-workspace': workspace.workspace_id },
  });
  assert.equal(viaAi.statusCode, 404);
  const viaKey = await app.inject({
    url: '/api/base/vault',
    headers: { authorization: `Bearer ${workspace.workspace_key}` },
  });
  assert.equal(viaKey.statusCode, 404);

  // No agent of this workspace: 404 without disclosing anything.
  const stranger = await app.inject({
    method: 'POST',
    url: `/api/base/agents/${randomUUID()}/wallet`,
    headers: { ...guarded, cookie },
    payload: '{}',
  });
  assert.equal(stranger.statusCode, 404);

  // The limit routes (W3): someone else's agent is not disclosed, writes need the request guard.
  const limitsUrl = `/api/base/agents/${randomUUID()}/wallet/limits`;
  assert.equal((await app.inject({ url: limitsUrl })).statusCode, 401);
  assert.equal((await app.inject({ url: limitsUrl, headers: { cookie } })).statusCode, 404);
  const unguardedLimit = await app.inject({
    method: 'POST',
    url: `${limitsUrl}/prepare`,
    headers: { 'content-type': 'application/json', cookie },
    payload: JSON.stringify({ capRaw: '20000000', period: 'day' }),
  });
  assert.equal(unguardedLimit.statusCode, 403);
  const guardedLimit = await app.inject({
    method: 'POST',
    url: `${limitsUrl}/prepare`,
    headers: { ...guarded, cookie },
    payload: JSON.stringify({ capRaw: '20000000', period: 'day' }),
  });
  assert.equal(guardedLimit.statusCode, 404);
});
