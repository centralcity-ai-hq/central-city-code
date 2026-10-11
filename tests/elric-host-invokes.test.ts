import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { elricFixture } from './elric-fixture.js';

/**
 * The owner hosts the room and posts as the host identity from the web app (never joined as a
 * person): an @mention invokes their Elric. The same host agent driven by an AI (an assistant
 * grant over MCP) is still refused, and another owner's host identity never invokes it.
 */
test('the owner posting as host from the console invokes Elric; the host agent over a grant does not', async (t) => {
  const f = await elricFixture(t);
  const owner = await f.account('Host owner');
  await f.verify(owner);
  const desk = await f.agent(owner, 'Host desk');
  const room = await f.room(owner, desk, 'Host room');
  const elricId = await f.addElric(owner);
  await f.joinAgent(owner, room, elricId);

  f.small.push({ text: 'Hello host.' });
  await f.say(owner, room, '@Elric hi from the host', desk);
  await f.elric.drain();
  const replies = (await f.messages(room.id)).filter((m) => m.sender_agent_id === elricId);
  assert.equal(replies.length, 1, 'Elric answered the owner posting as host');
  assert.equal((await f.turns(owner.operatorId)).at(-1)!.outcome, 'ok');

  // The same host agent driven by an AI (assistant grant, MCP): refused, no model call.
  const calls = f.adapterCalls();
  const granted = await f.call(owner.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic AI',
    scopes: ['workspace:read', 'rooms:host', 'rooms:join'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const viaGrant = await f.app.inject({
    method: 'POST',
    url: '/api/assistant/tools/city_room_post',
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${granted.json().token as string}`,
    },
    payload: JSON.stringify({
      room_id: room.id,
      agent_id: desk,
      text: '@Elric from the AI',
      idempotency_key: randomUUID(),
    }),
  });
  assert.ok(viaGrant.statusCode < 300, viaGrant.body);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), calls, 'no invocation from the AI-driven host agent');
  assert.equal((await f.turns(owner.operatorId)).at(-1)!.outcome, 'refused_invoker');

  // Another owner's room host posting as host never invokes this owner's Elric.
  const other = await f.account('Other host');
  const otherDesk = await f.agent(other, 'Other desk');
  const otherRoom = await f.room(other, otherDesk, 'Other room');
  await f.joinAgent(owner, otherRoom, elricId, { legacy: true });
  await f.say(other, otherRoom, '@Elric do something', otherDesk);
  await f.elric.drain();
  assert.equal(f.adapterCalls(), calls);
});
