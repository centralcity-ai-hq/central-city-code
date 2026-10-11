import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { createPendingAction } from '../server/elric/pending.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Elric security (invocation gate; pause, revoke, remove): credentials other than the owner's
 * console session. An all-scopes assistant grant of the SAME owner must not be able to drive,
 * resume, re-scope or approve for Elric, and must not reach the Elric console routes.
 * Synthetic data only.
 */
type F = Awaited<ReturnType<typeof elricFixture>>;

async function grant(f: F, cookie: string) {
  const res = await f.call(cookie, 'POST', '/api/assistant-access', {
    label: 'Third-party AI (synthetic)',
    scopes: [...ASSISTANT_SCOPES],
    expiresInDays: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token as string;
}
function tool(f: F, token: string, name: string, body: unknown = {}) {
  return f.app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify(body),
  });
}
async function elricStatus(f: F, cookie: string) {
  return (await f.call(cookie, 'GET', '/api/elric')).json().status as string | null;
}

test('grant: a room post mentioning Elric through an AI grant costs nothing', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const helper = await f.agent(s.owner, 'Owner helper');
  await f.joinAgent(s.owner, s.room, helper);
  const token = await grant(f, s.owner.cookie);
  const posted = await tool(f, token, 'city_room_post', {
    room_id: s.room.id,
    agent_id: helper,
    text: '@Elric summarize the room for me',
    idempotency_key: randomUUID(),
  });
  assert.equal(posted.statusCode, 200, posted.body);
  // The grant can never post as the owner's person member either.
  const asPerson = await tool(f, token, 'city_room_post', {
    room_id: s.room.id,
    agent_id: s.person,
    text: '@Elric summarize',
    idempotency_key: randomUUID(),
  });
  assert.ok(asPerson.statusCode >= 400, asPerson.body);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0);
  assert.equal(await f.usage(s.owner.operatorId), undefined);
  assert.equal((await f.invocations(s.elricId)).length, 0);
});

test('grant: city_control resume cannot un-pause an owner-paused Elric', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const token = await grant(f, s.owner.cookie);
  assert.equal((await f.call(s.owner.cookie, 'POST', '/api/elric/pause')).statusCode, 200);
  assert.equal(await elricStatus(f, s.owner.cookie), 'paused');
  // Pause then resume the underlying workspace agent through the third-party grant.
  await tool(f, token, 'city_control', { agent_id: s.elricId, action: 'pause' });
  await tool(f, token, 'city_control', { agent_id: s.elricId, action: 'resume' });
  assert.equal(await elricStatus(f, s.owner.cookie), 'paused', 'still paused');
  await f.say(s.owner, s.room, '@Elric are you there?', s.person);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0, 'a paused Elric costs nothing');
});

test('grant: city_control pause or revoke on Elric is refused (409 elric_managed)', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const token = await grant(f, s.owner.cookie);
  for (const action of ['pause', 'revoke']) {
    const response = await tool(f, token, 'city_control', { agent_id: s.elricId, action });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'elric_managed');
  }
  assert.equal(await elricStatus(f, s.owner.cookie), 'active');
});

test('grant: Elric console routes and pending approval refuse bearer credentials', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const token = await grant(f, s.owner.cookie);
  const action = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_task_create',
      args: { room_id: s.room.id, title: 'Synthetic pending' },
    },
    f.now(),
    60_000,
  );
  const bearer = {
    'content-type': 'application/json',
    'x-city-request': '1',
    authorization: `Bearer ${token}`,
  };
  for (const [method, url, body] of [
    ['GET', '/api/elric', undefined],
    ['POST', '/api/elric/resume', {}],
    ['POST', '/api/elric/revoke', {}],
    ['PUT', '/api/elric/settings', { host_may_invoke: true }],
    ['GET', '/api/elric/turns', undefined],
    ['POST', `/api/elric/pending/${action.id}/approve`, { args_hash: action.args_hash }],
  ] as const) {
    const res = await f.app.inject({
      method,
      url,
      headers: bearer,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    assert.equal(res.statusCode, 401, `${method} ${url}: ${res.body}`);
  }
  // Another owner's session, and the right owner with a wrong hash, are refused too.
  const other = await f.account('Other owner');
  const foreign = await f.call(other.cookie, 'POST', `/api/elric/pending/${action.id}/approve`, {
    args_hash: action.args_hash,
  });
  assert.ok([403, 404].includes(foreign.statusCode), foreign.body);
  const wrongHash = await f.call(
    s.owner.cookie,
    'POST',
    `/api/elric/pending/${action.id}/approve`,
    {
      args_hash: 'f'.repeat(64),
    },
  );
  assert.ok(wrongHash.statusCode >= 400, wrongHash.body);
  const row = (
    await f.db.query<{ status: string }>('SELECT status FROM elric_pending_actions WHERE id=$1', [
      action.id,
    ])
  ).rows[0]!;
  assert.equal(row.status, 'pending', 'nothing approved it');
  assert.equal(await elricStatus(f, s.owner.cookie), 'active');
});

test('grant: city_create_agent and city_apply_team cannot rewrite the Elric agent record', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const token = await grant(f, s.owner.cookie);
  const snapshot = async () =>
    (
      (await f.call(s.owner.cookie, 'GET', '/api/snapshot')).json().agents as Array<{
        id: string;
        name: string;
        mode: string;
        description: string;
      }>
    ).find((agent) => agent.id === s.elricId);
  const before = JSON.stringify(await snapshot());
  // A valid manifest whose display name and slug collide with Elric's.
  for (const name of ['elric', 'Elric']) {
    const created = await tool(f, token, 'city_create_agent', {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: name.toLowerCase(), displayName: 'Elric' },
        spec: { extends: 'template:extractor@1.0.0', visibility: 'public' },
      },
      idempotency_key: randomUUID(),
    });
    t.diagnostic(`city_create_agent manifest ${name}: ${created.statusCode}`);
    assert.ok(created.statusCode < 500, created.body);
    assert.equal(JSON.stringify(await snapshot()), before, 'Elric record unchanged');
  }
  const elricRow = (
    await f.db.query<{ agent_id: string }>(
      'SELECT agent_id FROM elric_agents WHERE owner_id=$1 AND revoked_at IS NULL',
      [s.owner.operatorId],
    )
  ).rows;
  assert.deepEqual(
    elricRow.map((row) => row.agent_id),
    [s.elricId],
    'one Elric, the same agent',
  );
});
