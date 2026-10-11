import test from 'node:test';
import assert from 'node:assert/strict';
import { elricEligibility } from '../server/elric/access.js';
import { elricFixture } from './elric-fixture.js';

/** Elric identity: who may own one (verified person only), one per owner, re-checked per call. */

test('eligibility: only a person owner with a server-stored verified Google identity', async (t) => {
  const f = await elricFixture(t);
  const unverified = await f.account('Unverified Uma');
  const res = await f.call(unverified.cookie, 'POST', '/api/elric', {});
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().code, 'elric_not_eligible');
  assert.deepEqual(await elricEligibility(f.db, unverified.operatorId), {
    eligible: false,
    reason: 'unverified',
  });

  // A stored identity whose email is not verified does not count.
  const halfway = await f.account('Halfway Hal');
  await f.verify(halfway, false);
  assert.equal((await f.call(halfway.cookie, 'POST', '/api/elric', {})).statusCode, 403);

  // AI and unclaimed operators never qualify, even with an identity row.
  const ai = await f.account('Robot Rob');
  await f.verify(ai);
  await f.db.query("UPDATE operators SET kind='ai' WHERE id=$1", [ai.operatorId]);
  assert.deepEqual(await elricEligibility(f.db, ai.operatorId), {
    eligible: false,
    reason: 'not_person',
  });
  await f.db.query("UPDATE operators SET kind='unclaimed' WHERE id=$1", [ai.operatorId]);
  assert.equal((await elricEligibility(f.db, ai.operatorId)).eligible, false);
  assert.deepEqual(await elricEligibility(f.db, 'no-such-operator'), {
    eligible: false,
    reason: 'unknown',
  });
  // No session (a guest, a runtime, an OAuth client): the console route is not reachable.
  const anonymous = await f.app.inject({
    method: 'POST',
    url: '/api/elric',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: '{}',
  });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((await f.db.query('SELECT 1 FROM elric_agents')).rows.length, 0);
});

test('addElric is idempotent: one Elric per owner, a first-party workspace agent', async (t) => {
  const f = await elricFixture(t);
  const owner = await f.account('Owner Olga');
  await f.verify(owner);
  const first = await f.call(owner.cookie, 'POST', '/api/elric', {});
  assert.equal(first.statusCode, 201, first.body);
  const again = await f.call(owner.cookie, 'POST', '/api/elric', { name: 'Other name' });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().agent_id, first.json().agent_id);
  const [a, b] = await Promise.all([
    f.elric.addElric(owner.operatorId),
    f.elric.addElric(owner.operatorId),
  ]);
  assert.equal(a.agent_id, first.json().agent_id);
  assert.equal(b.agent_id, first.json().agent_id);
  const rows = (
    await f.db.query('SELECT * FROM elric_agents WHERE owner_id=$1', [owner.operatorId])
  ).rows;
  assert.equal(rows.length, 1);
  const snapshot = await f.call(owner.cookie, 'GET', '/api/snapshot');
  const agent = (
    snapshot.json().agents as Array<{ id: string; name: string; isDemo: boolean }>
  ).find((item) => item.id === first.json().agent_id)!;
  assert.equal(agent.name, 'Elric');
  assert.equal(agent.isDemo, false);
  const status = await f.call(owner.cookie, 'GET', '/api/elric');
  assert.equal(status.json().status, 'active');
  assert.equal(status.json().host_may_invoke, false);
  assert.deepEqual(status.json().usage.allowance, { short: 20, summary: 4, tool: 5 });
  assert.equal(status.json().usage.resets_at, '2026-10-01T00:00:00.000Z');

  // After a revoke the owner may add a new one (the old one stays revoked).
  assert.equal((await f.call(owner.cookie, 'POST', '/api/elric/revoke')).statusCode, 200);
  const fresh = await f.call(owner.cookie, 'POST', '/api/elric', {});
  assert.equal(fresh.statusCode, 201);
  assert.notEqual(fresh.json().agent_id, first.json().agent_id);
});

test('eligibility is re-checked on every invocation, not only at addElric', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  await f.say(s.owner, s.room, '@Elric what is the plan?', s.person);
  // The verified identity disappears (e.g. the Google link was removed) before the run.
  await f.db.query('DELETE FROM elric_verified_identities WHERE operator_id=$1', [
    s.owner.operatorId,
  ]);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0);
  const turns = await f.turns(s.owner.operatorId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.outcome, 'refused_ineligible');
  assert.equal(turns[0]!.reason, 'unverified');
  assert.equal((await f.messages(s.room.id)).length, 1, 'nothing posted');
  assert.equal(await f.usage(s.owner.operatorId), undefined, 'nothing reserved');
});

test('the name "Elric" (and look-alikes) is reserved for first-party Elric agents', async (t) => {
  const f = await elricFixture(t);
  const other = await f.account('Impostor Ivo');
  for (const name of [
    'Elric',
    'ELRIC',
    ' elric ',
    'E1ric',
    'Еlric',
    'Elгic',
    'Elrіc',
    'E-l-r-i-c',
    'Elric​',
  ]) {
    const res = await f.call(other.cookie, 'POST', '/api/agents', {
      name,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(res.statusCode, 409, `${JSON.stringify(name)}: ${res.body}`);
  }
  for (const name of ['Elric Fan', 'Eric', 'Elrico'])
    assert.equal(
      (
        await f.call(other.cookie, 'POST', '/api/agents', {
          name,
          capability: 'research',
          mode: 'hosted',
        })
      ).statusCode,
      201,
      name,
    );
});

test('the reserved name holds on every path: grant create, join-with-new-agent, person join', async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Name host');
  const hostAgent = await f.agent(host, 'Name desk');
  const room = await f.room(host, hostAgent, 'Name room');
  const other = await f.account('Name squatter');
  // A connected AI's plain city_create_agent.
  const granted = await f.call(other.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic client',
    scopes: ['workspace:read', 'agents:create'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  for (const name of ['Elric', 'ELRIC', 'E l r i c', 'Еlric', 'Elrіc', 'E1ric']) {
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_create_agent',
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        authorization: `Bearer ${granted.json().token}`,
      },
      payload: JSON.stringify({
        name,
        capability: 'research',
        mode: 'external',
        idempotencyKey: `name-test-${Buffer.from(name).toString('hex')}`.slice(0, 64),
      }),
    });
    assert.equal(created.statusCode, 409, `${JSON.stringify(name)}: ${created.body}`);
    // Joining a room with a NEW agent of that name.
    const joined = await f.call(other.cookie, 'POST', `/api/rooms/${room.slug}/join`, {
      token: room.token,
      create: { name },
      idempotency_key: `join-${Buffer.from(name).toString('hex')}`.slice(0, 64),
    });
    assert.equal(joined.statusCode, 409, `${JSON.stringify(name)}: ${joined.body}`);
    assert.equal(joined.json().code, 'name_reserved');
    // A person joining as themselves under that name.
    const person = await f.call(other.cookie, 'POST', '/api/rooms/join', {
      link: room.link,
      name,
      idempotency_key: `person-${Buffer.from(name).toString('hex')}`.slice(0, 64),
    });
    assert.equal(person.statusCode, 409, `${JSON.stringify(name)}: ${person.body}`);
    assert.equal(person.json().code, 'name_reserved');
  }
  // So the owner's real Elric joins under its name without a clash.
  const owner = await f.account('Name owner');
  await f.verify(owner);
  const elricId = await f.addElric(owner);
  await f.joinPerson(owner, room, 'Olive');
  await f.joinAgent(owner, room, elricId, { legacy: true });
});
