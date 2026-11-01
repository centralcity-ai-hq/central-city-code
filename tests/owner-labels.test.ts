import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { ownerLabel } from '../server/connections/service.js';
import { reservedOwnerName } from '../server/workspaces/owner-names.js';
import { agentOwners, otherOwner } from '../src/rooms/people.js';
import type { Member } from '../src/rooms/api.js';

/**
 * An AI workspace's name is its agents' owner label, next to people's privacy labels and the
 * console's own words ("Your AI"): no workspace may take a name that reads as one of those.
 * Synthetic data only.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-owner-labels-test-root-stand-in-secret';

const ORIGIN = 'https://centralcity.ai';

test('workspace names that read as a person, your own AI, the host or Central City are refused', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 20;
  const create = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/public/workspaces',
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        host: 'centralcity.ai',
        origin: ORIGIN,
      },
      payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
      remoteAddress: `203.0.113.${address++}`,
    });
  for (const name of [
    'Your AI',
    'your  ai',
    'Y0ur AI',
    'Account 605d8baa',
    'ACCOUNT-605D8BAA',
    'AI workspace 1a2b3c4d',
    'Host',
    'Central City',
    'Elric',
    'Person 2',
  ]) {
    const res = await create(name);
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
    assert.doesNotMatch(res.body, /workspace_id/);
  }
  for (const name of ['Account Managers', 'Host workspace', 'Dana helper', 'Personal lab']) {
    const res = await create(name);
    assert.equal(res.statusCode, 201, `${name}: ${res.body}`);
  }
});

test('reserved names cover look-alikes but leave ordinary names', () => {
  for (const name of ['Your agent', 'You', 'Acc0unt 605d8baa', 'Another person', 'AI agent'])
    assert.equal(reservedOwnerName(name), true, name);
  for (const name of ['Accounting', 'Young team', 'Your way', 'Ann Creator'])
    assert.equal(reservedOwnerName(name), false, name);
});

test('a workspace named before the rule never gets a label that reads as a person or your AI', () => {
  for (const name of ['Your AI', 'Account 605d8baa']) {
    const label = ownerLabel({ id: randomUUID(), name, kind: 'ai' });
    assert.match(label, /^AI workspace [0-9a-f]{8}$/);
  }
  assert.equal(ownerLabel({ id: randomUUID(), name: 'Bravo lab', kind: 'ai' }), 'Bravo lab');
  assert.match(
    ownerLabel({ id: randomUUID(), name: 'Ann', kind: 'owner' }),
    /^Account [0-9a-f]{8}$/,
  );
});

test("an AI workspace named like a person in the room is never shown as that person's agent", () => {
  const member = (over: Partial<Member>): Member =>
    ({
      id: randomUUID(),
      name: 'Member',
      role: 'member',
      kind: 'agent',
      owner_label: 'Account 605d8baa',
      own: false,
      joined_at: '2026-10-01T00:00:00.000Z',
      ...over,
    }) as Member;
  const ann = member({ kind: 'person', name: 'Ann Creator', owner_label: 'Account 605d8baa' });
  const annAgent = member({ name: 'Ann helper' });
  const owners = agentOwners([ann, annAgent]);
  assert.equal(owners('Account 605d8baa'), 'Ann Creator');
  // A workspace named "ann creator" joins: neither label passes for Ann's any more.
  const impostor = member({ name: 'Ann helper', owner_label: 'ann  Creator' });
  const after = agentOwners([ann, annAgent, impostor]);
  assert.equal(after('ann  Creator'), null);
  assert.equal(after('Account 605d8baa'), null);
  // A message of a workspace that already left is judged the same way.
  assert.equal(agentOwners([ann, annAgent])('Ann Creator'), null);
  assert.equal(agentOwners([ann, annAgent])('Bravo lab'), 'Bravo lab');
});

test('another owner is never labelled with words reserved for your own AI', () => {
  assert.equal(otherOwner('Your AI'), null);
  assert.equal(otherOwner('your agent'), null);
  assert.equal(otherOwner('Bravo lab'), 'Bravo lab');
  assert.equal(otherOwner(null), null);
});
