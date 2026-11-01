import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Agent } from '../shared/types.js';
import type { Workspace } from '../server/model.js';
import { decryptApiKey } from '../server/responder/crypto.js';
import { deriveKek, responderKeys } from '../server/responder/keys.js';
import type { ProviderRequest } from '../server/responder/providers.js';
import { registerResponderMigration } from '../server/responder/schema.js';
import { revokeResponderCredentials } from '../server/responder/revoke.js';
import { ResponderError, createResponder } from '../server/responder/service.js';

/**
 * Hosted responder owner settings and write-only provider keys at the service layer, on the real schema
 * (migration 20 on PGlite) with a fake provider transport (no network). The console routes are
 * wired into server/app.ts in a follow-up commit once app.ts is free (route-level tests come with
 * it). Synthetic keys and passwords only.
 */
registerResponderMigration();

// Everything written to stderr or the console while this file runs, checked for key material at
// the end (no raw errors, no key in any log).
const captured: string[] = [];
const originalWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
  return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    captured.push(
      args
        .map((item) => (item instanceof Error ? `${item.message} ${item.stack}` : String(item)))
        .join(' '),
    );
    original(...args);
  };
}
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
// Low-entropy placeholders in the providers' formats (never real keys; secret scanners stay quiet).
const FAKE_OPENAI = 'sk-proj-test-openai-placeholder-0000';
const FAKE_ANTHROPIC = 'sk-ant-api03-test-anthropic-placeholder-0000';
const HAIKU = 'claude-haiku-4-5-20251001';
const OPUS = 'claude-opus-5-5';
const key = (text: string) => Buffer.from(text, 'latin1');

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  env: Record<string, string> | null = null,
) {
  const kek = randomBytes(32);
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const register = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password: `Synthetic responder password ${name}` }),
    });
    assert.equal(res.statusCode, 201, res.body);
    const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({
        name: `${name} agent`,
        description: 'Synthetic responder agent',
        capability: 'research',
        mode: 'external',
      }),
    });
    assert.equal(agentRes.statusCode, 201, agentRes.body);
    const operatorId = (
      await db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { operatorId, agent: (agentRes.json() as { agent: Agent }).agent };
  };
  const calls: ProviderRequest[] = [];
  let status = 200;
  let fail = false;
  const hits = new Map<string, number>();
  let time = 1_800_000_000_000;
  const responder = createResponder({
    db,
    clock: () => time,
    // A counting limiter with the shared limiter's contract (throws when over budget).
    async limit(bucket, max) {
      const count = (hits.get(bucket) ?? 0) + 1;
      hits.set(bucket, count);
      if (count > max) throw new ResponderError(429, 'rate_limited', 'Too many requests.');
    },
    // The app's mutate: the owner's workspace row locked, changed and written back in one transaction.
    mutate: (operatorId, action) =>
      db.transaction(async (tx) => {
        const workspace = (
          await tx.query<{ data: Workspace }>(
            'SELECT data FROM workspaces WHERE operator_id=$1 FOR UPDATE',
            [operatorId],
          )
        ).rows[0]!.data;
        time += 1000;
        const result = await action(workspace, tx, time);
        await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
          operatorId,
          JSON.stringify(workspace),
        ]);
        return result;
      }),
    keys: responderKeys(env ?? { CITY_RESPONDER_KEK: kek.toString('base64') }, { hosted: true }),
    transport: async (request) => {
      calls.push(request);
      if (fail) throw new Error(`network ${JSON.stringify(request.headers)}`);
      return { status };
    },
  });
  const owner = await register('Responder owner');
  const events = async (operatorId: string) =>
    (
      await db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0]!.data.events.map((item) => item.type);
  return {
    db,
    kek,
    responder,
    owner,
    register,
    calls,
    events,
    setStatus: (value: number) => (status = value),
    setFail: (value: boolean) => (fail = value),
  };
}

/** Refusal code of a promise that must reject with a ResponderError. */
async function code(promise: Promise<unknown>): Promise<[number, string]> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ResponderError, String(error));
    return [error.statusCode, error.errorCode];
  }
  assert.fail('expected a refusal');
}

/** No returned value or plain column may contain the key or a recognizable part of it. */
function assertNeverShown(haystacks: string[], secret: string) {
  for (const text of haystacks)
    for (const part of [secret, secret.slice(0, 16), secret.slice(-8)])
      assert.equal(text.includes(part), false, `found key material: ${text.slice(0, 120)}`);
}

test('a key is validated, stored encrypted, zeroized and never returned', async (t) => {
  const { db, kek, responder, owner, calls, events } = await setup(t);
  const { operatorId, agent } = owner;
  const buffer = key(FAKE_OPENAI);
  const saved = await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: buffer },
    'addr',
  );
  assert.deepEqual(Object.keys(saved.key).sort(), [
    'added_at',
    'provider',
    'status',
    'validated_at',
  ]);
  assert.ok(
    buffer.every((byte) => byte === 0),
    'the caller buffer is zeroized',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/models/gpt-6-sol', 'default model');
  const view = await responder.get(operatorId, agent.id);
  assert.equal(view.provider, 'openai');
  assert.equal(view.enabled, false);
  assert.equal(view.status, 'off');
  assert.equal(view.replies_available, true, 'the root key is set: replies are delivered');
  assert.equal(view.key?.status, 'active');

  const row = (
    await db.query<{ id: string; wrapped_dek: Uint8Array; ciphertext: Uint8Array }>(
      "SELECT id,wrapped_dek,ciphertext FROM responder_credentials WHERE status='active'",
    )
  ).rows[0]!;
  const plain = await db.query<{ s: string }>(
    `SELECT s::text AS s FROM responder_settings s
     UNION ALL SELECT row(c.id,c.agent_id,c.owner_id,c.provider,c.kek_id,c.status,c.created_by)::text FROM responder_credentials c
     UNION ALL SELECT data::text FROM workspaces`,
  );
  assertNeverShown(
    [
      JSON.stringify(saved),
      JSON.stringify(view),
      ...plain.rows.map((item) => item.s),
      Buffer.from(row.ciphertext).toString('latin1'),
      Buffer.from(row.wrapped_dek).toString('latin1'),
    ],
    FAKE_OPENAI,
  );
  // Only the HKDF subkey of the configured root opens it (N1).
  assert.throws(() =>
    decryptApiKey(
      kek,
      { id: row.id, agentId: agent.id, ownerId: operatorId, provider: 'openai' },
      { wrappedDek: Buffer.from(row.wrapped_dek), ciphertext: Buffer.from(row.ciphertext) },
    ),
  );
  const opened = decryptApiKey(
    deriveKek(kek),
    { id: row.id, agentId: agent.id, ownerId: operatorId, provider: 'openai' },
    { wrappedDek: Buffer.from(row.wrapped_dek), ciphertext: Buffer.from(row.ciphertext) },
  );
  assert.equal(opened.toString('latin1'), FAKE_OPENAI);
  opened.fill(0);
  assert.ok((await events(operatorId)).includes('responder.key_set'));
});

test('bad keys and provider answers map to fixed codes; nothing is stored', async (t) => {
  const { db, responder, owner, calls, setStatus, setFail } = await setup(t);
  const { operatorId, agent } = owner;
  const save = (provider: 'openai' | 'anthropic', text: string, model?: string) =>
    responder.setKey(
      operatorId,
      'the owner',
      agent.id,
      { provider, model, key: key(text) },
      'addr',
    );
  assert.deepEqual(await code(save('anthropic', FAKE_OPENAI)), [400, 'invalid_key_format']);
  assert.deepEqual(await code(save('openai', `sk-admin-${'A'.repeat(30)}`)), [
    400,
    'unsupported_key',
  ]);
  assert.deepEqual(await code(save('openai', FAKE_OPENAI, 'gpt-unlisted')), [
    400,
    'model_not_allowed',
  ]);
  assert.equal(calls.length, 0, 'no provider call before local checks pass');
  for (const [answer, expected] of [
    [401, [400, 'invalid_key']],
    [403, [400, 'forbidden_key']],
    [404, [400, 'model_unavailable']],
    [429, [502, 'provider_unreachable']],
    [500, [502, 'provider_unreachable']],
  ] as const) {
    setStatus(answer);
    assert.deepEqual(await code(save('anthropic', FAKE_ANTHROPIC, HAIKU)), expected);
  }
  setFail(true);
  const [status, refusal] = await code(save('anthropic', FAKE_ANTHROPIC));
  assert.deepEqual([status, refusal], [502, 'provider_unreachable']);
  assert.equal((await db.query('SELECT 1 FROM responder_credentials')).rows.length, 0);
  assert.equal((await db.query('SELECT 1 FROM responder_settings')).rows.length, 0);
});

test('turning on needs a working key; caps are stored; removing the key turns it off', async (t) => {
  const { db, responder, owner, events } = await setup(t);
  const { operatorId, agent } = owner;
  assert.deepEqual(
    await code(responder.update(operatorId, 'the owner', agent.id, { enabled: true })),
    [409, 'key_required'],
  );
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'anthropic', key: key(FAKE_ANTHROPIC) },
    'addr',
  );
  const on = await responder.update(operatorId, 'the owner', agent.id, {
    enabled: true,
    model: OPUS,
    instructions: 'Answer briefly.',
    daily_reply_cap: 1000,
    daily_spend_cap_usd: 2.5,
  });
  assert.equal(on.status, 'active');
  assert.equal(on.model, OPUS);
  // Retired or superseded ids are not on the allowlist.
  for (const model of ['claude-opus-5', 'claude-haiku-4-5'])
    assert.deepEqual(
      await code(responder.update(operatorId, 'the owner', agent.id, { model })),
      [400, 'model_not_allowed'],
      model,
    );
  assert.equal(on.daily_reply_cap, 1000);
  assert.equal(on.daily_spend_cap_usd, 2.5);
  assert.deepEqual(
    await code(responder.update(operatorId, 'the owner', agent.id, { model: 'gpt-6-sol' })),
    [400, 'model_not_allowed'],
  );
  const removed = await responder.removeKey(operatorId, 'the owner', agent.id);
  assert.deepEqual(removed, { agent_id: agent.id, removed: true });
  const off = await responder.get(operatorId, agent.id);
  assert.equal(off.enabled, false);
  assert.equal(off.key, null);
  assert.equal(off.pause_reason, 'key_removed');
  const shredded = (
    await db.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM responder_credentials WHERE status='revoked' AND ciphertext IS NULL AND wrapped_dek IS NULL AND kek_id IS NULL",
    )
  ).rows[0]!;
  assert.equal(Number(shredded.n), 1);
  // A new valid key clears the key pause; turning on resumes.
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'anthropic', key: key(FAKE_ANTHROPIC) },
    'addr',
  );
  const again = await responder.update(operatorId, 'the owner', agent.id, { enabled: true });
  assert.equal(again.status, 'active');
  assert.equal(again.pause_reason, null);
  const types = await events(operatorId);
  for (const type of ['responder.key_set', 'responder.enabled', 'responder.key_removed'])
    assert.ok(types.includes(type), type);
});

test('the database bounds hold even if a caller skips validation', async (t) => {
  const { db, responder, owner } = await setup(t);
  const { operatorId, agent } = owner;
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: key(FAKE_OPENAI) },
    'addr',
  );
  for (const [column, value] of [
    ['daily_reply_cap', 1001],
    ['daily_reply_cap', 0],
    ['daily_spend_cap_microusd', 50_000_001],
    ['instructions', 'x'.repeat(2001)],
  ] as const)
    await assert.rejects(
      db.query(`UPDATE responder_settings SET ${column}=$1 WHERE agent_id=$2`, [value, agent.id]),
      column,
    );
  // A live key cannot be written without its secret, and two live keys per agent are refused.
  await assert.rejects(
    db.query(
      "INSERT INTO responder_credentials(id,agent_id,owner_id,provider,status,created_at,created_by) VALUES('x',$1,$2,'openai','active',1,'t')",
      [agent.id, operatorId],
    ),
  );
});

test('a replaced key revokes the previous one; one live key per agent', async (t) => {
  const { db, responder, owner } = await setup(t);
  const { operatorId, agent } = owner;
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: key(FAKE_OPENAI) },
    'addr',
  );
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'anthropic', key: key(FAKE_ANTHROPIC) },
    'addr',
  );
  const rows = (
    await db.query<{ provider: string; status: string }>(
      'SELECT provider,status FROM responder_credentials ORDER BY provider',
    )
  ).rows;
  assert.deepEqual(rows, [
    { provider: 'anthropic', status: 'active' },
    { provider: 'openai', status: 'revoked' },
  ]);
  const view = await responder.get(operatorId, agent.id);
  assert.equal(view.provider, 'anthropic');
  assert.equal(view.model, 'claude-sonnet-5', 'Sonnet 5 is the Anthropic default');
});

test("another owner's agent is not found", async (t) => {
  const { responder, owner, register } = await setup(t);
  const other = await register('Someone else');
  assert.deepEqual(await code(responder.get(other.operatorId, owner.agent.id)), [
    404,
    'agent_not_found',
  ]);
  assert.deepEqual(
    await code(
      responder.setKey(
        other.operatorId,
        'the owner',
        owner.agent.id,
        { provider: 'openai', key: key(FAKE_OPENAI) },
        'addr',
      ),
    ),
    [404, 'agent_not_found'],
  );
  assert.deepEqual(await code(responder.removeKey(other.operatorId, 'the owner', owner.agent.id)), [
    404,
    'agent_not_found',
  ]);
});

test('key saves are rate limited per owner, bad keys included', async (t) => {
  const { responder, owner, setStatus } = await setup(t);
  setStatus(401);
  const save = () =>
    code(
      responder.setKey(
        owner.operatorId,
        'the owner',
        owner.agent.id,
        { provider: 'openai', key: key(FAKE_OPENAI) },
        'addr',
      ),
    );
  for (let index = 0; index < 10; index++) assert.deepEqual(await save(), [400, 'invalid_key']);
  assert.deepEqual(await save(), [429, 'rate_limited']);
});

test('models list with estimates and one default per provider', async (t) => {
  const { responder } = await setup(t);
  const { models } = responder.models('anthropic');
  assert.ok(models.length >= 2 && models.every((model) => model.provider === 'anthropic'));
  assert.equal(models.filter((model) => model.default).length, 1);
});

test('without a valid root key every operation answers 503 responder_unavailable', async (t) => {
  const { responder, owner } = await setup(t, { CITY_RESPONDER_KEK: 'not-32-bytes' });
  assert.equal(responder.available, false);
  const buffer = key(FAKE_OPENAI);
  assert.deepEqual(
    await code(
      responder.setKey(
        owner.operatorId,
        'the owner',
        owner.agent.id,
        { provider: 'openai', key: buffer },
        'a',
      ),
    ),
    [503, 'responder_unavailable'],
  );
  assert.ok(
    buffer.every((byte) => byte === 0),
    'zeroized on refusal too',
  );
  // Reading the settings needs no root key (CCA-622).
  assert.equal((await responder.get(owner.operatorId, owner.agent.id)).enabled, false);
});

test('CCA-622: with the keyring unavailable an owner can still turn Auto-reply off and delete the key', async (t) => {
  const { db, responder, owner } = await setup(t);
  const { operatorId, agent } = owner;
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: key(FAKE_OPENAI) },
    'addr',
  );
  await responder.update(operatorId, 'the owner', agent.id, { enabled: true });
  // The same database served by an instance whose root key does not decode.
  const broken = createResponder({
    db,
    clock: () => 1_900_000_000_000,
    async limit() {},
    mutate: (id, action) =>
      db.transaction(async (tx) => {
        const workspace = (
          await tx.query<{ data: Workspace }>(
            'SELECT data FROM workspaces WHERE operator_id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0]!.data;
        const result = await action(workspace, tx, 1_900_000_000_000);
        await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
          id,
          JSON.stringify(workspace),
        ]);
        return result;
      }),
    keys: responderKeys({ CITY_RESPONDER_KEK: 'not-32-bytes' }, { hosted: true }),
    transport: async () => ({ status: 200 }),
  });
  assert.equal(broken.available, false);
  assert.equal((await broken.get(operatorId, agent.id)).enabled, true);
  // Other setting changes still need the root key.
  assert.deepEqual(
    await code(broken.update(operatorId, 'the owner', agent.id, { instructions: 'x' })),
    [503, 'responder_unavailable'],
  );
  const off = await broken.update(operatorId, 'the owner', agent.id, { enabled: false });
  assert.equal(off.enabled, false);
  const removed = await broken.removeKey(operatorId, 'the owner', agent.id);
  assert.equal(removed.removed, true);
  const row = (
    await db.query<{ status: string; ciphertext: Uint8Array | null }>(
      'SELECT status, ciphertext FROM responder_credentials WHERE agent_id=$1',
      [agent.id],
    )
  ).rows[0]!;
  assert.equal(row.status, 'revoked');
  assert.equal(row.ciphertext, null);
});

test('stored keys are revoked when agents change owner or an AI workspace is claimed', async (t) => {
  const { db, responder, owner } = await setup(t);
  const { operatorId, agent } = owner;
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: key(FAKE_OPENAI) },
    'addr',
  );
  await responder.update(operatorId, 'the owner', agent.id, { enabled: true });
  // Another owner's scope is a no-op.
  assert.equal(
    await db.transaction((tx) =>
      revokeResponderCredentials(tx, { ownerId: 'someone-else' }, 1, 't'),
    ),
    0,
  );
  assert.equal((await responder.get(operatorId, agent.id)).key?.status, 'active');
  assert.equal(
    await db.transaction((tx) =>
      revokeResponderCredentials(
        tx,
        { ownerId: operatorId, agentIds: [agent.id] },
        2,
        'agent claimed',
      ),
    ),
    1,
  );
  const view = await responder.get(operatorId, agent.id);
  assert.equal(view.key, null);
  assert.equal(view.enabled, false);
  assert.equal(view.pause_reason, 'key_removed');
  const row = (
    await db.query<{ ciphertext: unknown; revoked_by: string }>(
      'SELECT ciphertext,revoked_by FROM responder_credentials',
    )
  ).rows[0]!;
  assert.equal(row.ciphertext, null);
  assert.equal(row.revoked_by, 'agent claimed');
});

test('claiming an AI workspace revokes its stored responder keys (the claim flow calls it)', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/public/workspaces',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Responder AI',
        idempotency_key: 'responder-ai-workspace-1',
      }),
    })
  ).json() as { workspace_id: string; claim_token: string };
  // A credential row for the AI operator (as a co-owner would have stored it).
  await app.city.db.query(
    `INSERT INTO responder_credentials(id,agent_id,owner_id,provider,kek_id,wrapped_dek,ciphertext,status,created_at,created_by)
     VALUES('rsk_t','agent-t',$1,'openai','k_test',$2,$2,'active',1,'test')`,
    [created.workspace_id, Buffer.alloc(60, 1)],
  );
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Claiming person', password: 'Synthetic claim password' }),
  });
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: created.claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const row = (
    await app.city.db.query<{ status: string; ciphertext: unknown; revoked_by: string }>(
      "SELECT status,ciphertext,revoked_by FROM responder_credentials WHERE id='rsk_t'",
    )
  ).rows[0]!;
  assert.deepEqual(row, { status: 'revoked', ciphertext: null, revoked_by: 'workspace claimed' });
});

test('nothing written to stderr or the console contains key material', () => {
  assertNeverShown(captured, FAKE_OPENAI);
  assertNeverShown(captured, FAKE_ANTHROPIC);
});

test('Anthropic defaults to Sonnet 5; Haiku 4.5 stays selectable; current API ids', async (t) => {
  const { responder, owner, calls } = await setup(t);
  await responder.setKey(
    owner.operatorId,
    'the owner',
    owner.agent.id,
    { provider: 'anthropic', key: key(FAKE_ANTHROPIC) },
    'addr',
  );
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/models/claude-sonnet-5');
  const ids = responder.models('anthropic').models.map((model) => model.id);
  assert.deepEqual(ids, [HAIKU, 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1']);
  const listed = responder.models('anthropic').models;
  assert.equal(listed.find((model) => model.default)?.id, 'claude-sonnet-5');
  assert.match(listed.find((model) => model.id === HAIKU)!.name, /retiring/);
});

test('decryption selects the root key by the stored kek_id; rotation re-wraps and retires PREVIOUS', async (t) => {
  const { db, kek, responder, owner } = await setup(t);
  const { operatorId, agent } = owner;
  const { responderKeys } = await import('../server/responder/keys.js');
  const { openStoredKey, rewrapResponderKeys, UnknownRootKeyError } =
    await import('../server/responder/rotation.js');
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: key(FAKE_OPENAI) },
    'addr',
  );
  const stored = async () =>
    (
      await db.query<{
        id: string;
        agent_id: string;
        owner_id: string;
        provider: string;
        kek_id: string | null;
        wrapped_dek: Uint8Array | null;
        ciphertext: Uint8Array | null;
      }>(
        "SELECT id,agent_id,owner_id,provider,kek_id,wrapped_dek,ciphertext FROM responder_credentials WHERE status='active'",
      )
    ).rows[0]!;
  const oldRoot = kek.toString('base64');
  const before = await stored();
  const oldRing = responderKeys({ CITY_RESPONDER_KEK: oldRoot }, { hosted: true });
  assert.equal(openStoredKey(oldRing, before).toString('latin1'), FAKE_OPENAI);
  const newRoot = randomBytes(32).toString('base64');
  const rotated = responderKeys(
    { CITY_RESPONDER_KEK: newRoot, CITY_RESPONDER_KEK_PREVIOUS: oldRoot },
    { hosted: true },
  );
  const onlyNew = responderKeys({ CITY_RESPONDER_KEK: newRoot }, { hosted: true });
  // Selected by kid: the new-only keyring refuses instead of trying every key.
  assert.throws(() => openStoredKey(onlyNew, before), UnknownRootKeyError);
  const dry = await rewrapResponderKeys(db, rotated);
  assert.deepEqual(dry, { pending: 1, rewrapped: 0, unknownRoot: 0, failed: 0, dryRun: true });
  const done = await rewrapResponderKeys(db, rotated, { confirm: true });
  assert.deepEqual(done, { pending: 1, rewrapped: 1, unknownRoot: 0, failed: 0, dryRun: false });
  const after = await stored();
  assert.equal(after.kek_id, onlyNew.available ? onlyNew.current.kid : '');
  assert.deepEqual(
    Buffer.from(after.ciphertext!),
    Buffer.from(before.ciphertext!),
    'ciphertext unchanged',
  );
  // PREVIOUS can now be removed: the new root alone opens it.
  assert.equal(openStoredKey(onlyNew, after).toString('latin1'), FAKE_OPENAI);
  assert.deepEqual(await rewrapResponderKeys(db, onlyNew), {
    pending: 0,
    rewrapped: 0,
    unknownRoot: 0,
    failed: 0,
    dryRun: true,
  });
});

test('revoking an agent deletes its stored key and turns auto-reply off', async (t) => {
  const { db, responder, owner } = await setup(t);
  const { operatorId, agent } = owner;
  await responder.setKey(
    operatorId,
    'the owner',
    agent.id,
    { provider: 'openai', key: key(FAKE_OPENAI) },
    'addr',
  );
  await responder.update(operatorId, 'the owner', agent.id, { enabled: true });
  const { revokeStoredAgent } = await import('../server/agent-lifecycle.js');
  await db.transaction(async (tx) => {
    const workspace = (
      await tx.query<{ data: Workspace }>(
        'SELECT data FROM workspaces WHERE operator_id=$1 FOR UPDATE',
        [operatorId],
      )
    ).rows[0]!.data;
    const stored = workspace.agents.find((item) => item.id === agent.id)!;
    assert.equal(await revokeStoredAgent(workspace, tx, operatorId, stored, 5), true);
    await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
      operatorId,
      JSON.stringify(workspace),
    ]);
  });
  const row = (
    await db.query<{ status: string; ciphertext: unknown; revoked_by: string }>(
      'SELECT status,ciphertext,revoked_by FROM responder_credentials',
    )
  ).rows[0]!;
  assert.deepEqual(row, { status: 'revoked', ciphertext: null, revoked_by: 'agent revoked' });
  const settings = (
    await db.query<{ enabled: boolean; pause_reason: string }>(
      'SELECT enabled,pause_reason FROM responder_settings',
    )
  ).rows[0]!;
  assert.deepEqual(settings, { enabled: false, pause_reason: 'key_removed' });
});
