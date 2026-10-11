import assert from 'node:assert/strict';
import test from 'node:test';
import { activeGrants, connectedSince } from '../src/connect/connectedApps.js';
import type { AssistantGrant } from '../shared/assistant.js';

const NOW = Date.parse('2026-10-11T12:00:00');

function grant(id: string, overrides: Partial<AssistantGrant> = {}): AssistantGrant {
  return {
    id,
    label: id,
    scopes: ['workspace:read', 'rooms:join'],
    createdAt: '2026-10-10T09:00:00.000Z',
    expiresAt: '2026-11-10T09:00:00.000Z',
    renewal: 'rolling',
    endsAtLatest: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

test('Connected lists only grants that still work, newest first', () => {
  const grants = [
    grant('older', { createdAt: '2026-10-01T09:00:00.000Z' }),
    grant('removed', { revokedAt: '2026-10-09T09:00:00.000Z' }),
    grant('ended', { expiresAt: '2026-10-11T11:59:00' }),
    grant('newer', { createdAt: '2026-10-11T08:00:00' }),
  ];
  assert.deepEqual(
    activeGrants(grants, NOW).map((item) => item.id),
    ['newer', 'older'],
  );
  assert.deepEqual(activeGrants([], NOW), []);
});

test('the connected line counts local calendar days', () => {
  assert.equal(connectedSince('2026-10-11T00:05:00', NOW), 'Connected today');
  // Clock skew: a time just ahead of now is still today.
  assert.equal(connectedSince('2026-10-11T12:05:00', NOW), 'Connected today');
  assert.equal(connectedSince('2026-10-10T23:59:00', NOW), 'Connected yesterday');
  assert.equal(connectedSince('2026-10-09T08:00:00', NOW), 'Connected 2 days ago');
  assert.equal(connectedSince('2026-09-12T08:00:00', NOW), 'Connected 29 days ago');
  assert.equal(connectedSince('2026-09-04T08:00:00', NOW, 'en-GB'), 'Connected on 4 Sept');
  assert.equal(connectedSince('not a date', NOW), 'Connected');
});
