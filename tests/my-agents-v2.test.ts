import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent } from '../shared/types';
import {
  agentKindLabel,
  confirmsName,
  inRosterTab,
  messagesToday,
  roomChips,
  rosterAgents,
  rosterCounts,
  showElricRow,
  agentStateV2,
  countAgentStates,
  expiryLabel,
  isElricAgent,
  pendingRequests,
  removalDescendants,
  visibleAgents,
} from '../src/agents/myAgentsModel';

const at = '2026-10-04T12:00:00.000Z';
const now = Date.parse(at);

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
    description: '',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: at,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

function request(id: string, overrides: Partial<ConnectionRequest> = {}): ConnectionRequest {
  return {
    id,
    direction: 'incoming',
    status: 'pending',
    from_agent_id: 'remote',
    from_agent_name: 'Remote helper',
    from_owner_label: 'Account 4a12b8c9',
    to_agent_id: 'mine',
    to_agent_name: null,
    note: '',
    requested_at: at,
    expires_at: new Date(now + 5 * 86_400_000).toISOString(),
    decided_at: null,
    revoked_at: null,
    ...overrides,
  };
}

test('status comes from real fields: removal, then pause, then presence', () => {
  assert.equal(agentStateV2(agent('a')), 'online');
  assert.equal(agentStateV2(agent('a', { status: 'working' })), 'online');
  assert.equal(agentStateV2(agent('a', { status: 'offline' })), 'offline');
  assert.equal(agentStateV2(agent('a', { pausedAt: at })), 'paused');
  assert.equal(agentStateV2(agent('a', { pausedAt: at, status: 'offline' })), 'paused');
  assert.equal(agentStateV2(agent('a', { status: 'revoked' })), 'revoked');
  assert.equal(agentStateV2(agent('a', { revokedAt: at, pausedAt: at })), 'revoked');
});

test('kind label names how the agent runs, never a model', () => {
  assert.equal(agentKindLabel(agent('a', { isDemo: true, mode: 'hosted' })), 'CC agent');
  assert.equal(agentKindLabel(agent('a')), 'Runs on your computer');
  assert.equal(agentKindLabel(agent('a', { mode: 'hosted' })), 'Template agent');
});

test('counts, filters, search and order', () => {
  const list = [
    agent('gone', { revokedAt: at, status: 'revoked' }),
    agent('off', { status: 'offline', name: 'Quiet one' }),
    agent('on', { name: 'Scout' }),
    agent('held', { pausedAt: at }),
  ];
  assert.deepEqual(countAgentStates(list), {
    all: 4,
    online: 1,
    offline: 1,
    paused: 1,
    revoked: 1,
  });
  assert.deepEqual(
    visibleAgents(list, 'all', '').map((item) => item.id),
    ['on', 'held', 'off', 'gone'],
  );
  assert.deepEqual(
    visibleAgents(list, 'offline', '').map((item) => item.id),
    ['off'],
  );
  assert.deepEqual(
    visibleAgents(list, 'all', ' scout ').map((item) => item.id),
    ['on'],
  );
});

test('removal cascades to live descendants only', () => {
  const list = [
    agent('root'),
    agent('child', { parentAgentId: 'root' }),
    agent('grandchild', { parentAgentId: 'child' }),
    agent('removed', { parentAgentId: 'root', revokedAt: at }),
    agent('other'),
  ];
  assert.deepEqual(
    removalDescendants(list, 'root').map((item) => item.id),
    ['child', 'grandchild'],
  );
  assert.deepEqual(removalDescendants(list, 'other'), []);
});

test('pending requests: incoming, pending, not expired, soonest first, with labels', () => {
  const items = pendingRequests(
    [
      request('later'),
      request('sooner', {
        expires_at: new Date(now + 3_600_000 * 2).toISOString(),
        from_agent_name: null,
        from_owner_label: '',
      }),
      request('approved', { status: 'approved' }),
      request('outgoing', { direction: 'outgoing' }),
      request('stale', { expires_at: new Date(now - 1).toISOString() }),
    ],
    [{ id: 'mine', name: 'My scout' }],
    now,
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ['sooner', 'later'],
  );
  assert.equal(items[0]!.agentName, 'An agent');
  assert.equal(items[0]!.ownerLabel, 'Another owner');
  assert.equal(items[1]!.agentName, 'Remote helper');
  assert.equal(items[1]!.ownerLabel, 'Account 4a12b8c9');
  assert.equal(items[1]!.toAgentName, 'My scout');
});

test('expiry label', () => {
  const plus = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(expiryLabel(plus(5 * 86_400_000 + 10), now), 'Expires in 5 days');
  assert.equal(expiryLabel(plus(86_400_000), now), 'Expires in 1 day');
  assert.equal(expiryLabel(plus(3 * 3_600_000), now), 'Expires in 3 hours');
  assert.equal(expiryLabel(plus(60_000), now), 'Expires in under an hour');
  assert.equal(expiryLabel(plus(-1), now), 'Expired');
  assert.equal(expiryLabel('not a date', now), 'No expiry date');
});

test('Elric is recognised by its agent id, never by name', () => {
  assert.equal(isElricAgent(agent('e'), 'e'), true);
  assert.equal(isElricAgent(agent('x', { name: 'Elric' }), 'e'), false);
  assert.equal(isElricAgent(agent('x', { name: 'Elric' }), null), false);
  assert.equal(isElricAgent(agent(''), ''), false);
});

test('v3 roster tabs map onto the real states', () => {
  assert.equal(inRosterTab('online', 'active'), true);
  assert.equal(inRosterTab('offline', 'active'), true);
  assert.equal(inRosterTab('paused', 'active'), false);
  assert.equal(inRosterTab('paused', 'paused'), true);
  assert.equal(inRosterTab('revoked', 'removed'), true);
  assert.equal(inRosterTab('revoked', 'active'), false);
  assert.equal(inRosterTab('revoked', 'all'), true);
});

test('v3 roster leaves Elric out, filters, searches and counts live agents', () => {
  const list = [
    agent('elric', { name: 'Elric', mode: 'hosted' }),
    agent('gone', { revokedAt: at, status: 'revoked' }),
    agent('off', { status: 'offline', name: 'Quiet one' }),
    agent('on', { name: 'Scout' }),
    agent('held', { pausedAt: at }),
  ];
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  assert.deepEqual(ids(rosterAgents(list, 'all', '', 'elric')), ['on', 'held', 'off', 'gone']);
  assert.deepEqual(ids(rosterAgents(list, 'active', '', 'elric')), ['on', 'off']);
  assert.deepEqual(ids(rosterAgents(list, 'paused', '', 'elric')), ['held']);
  assert.deepEqual(ids(rosterAgents(list, 'removed', '', 'elric')), ['gone']);
  assert.deepEqual(ids(rosterAgents(list, 'all', 'scout', 'elric')), ['on']);
  // Without Elric's id (no Elric on this server) an agent named Elric is an ordinary agent.
  assert.equal(rosterAgents(list, 'all', '', null).length, 5);
  assert.deepEqual(rosterCounts(list, 'elric'), { total: 3, online: 1 });
});

test("Elric's pinned row follows its own state", () => {
  assert.equal(showElricRow('active', 'all', ''), true);
  assert.equal(showElricRow('active', 'active', ''), true);
  assert.equal(showElricRow('active', 'paused', ''), false);
  assert.equal(showElricRow('paused', 'paused', ''), true);
  assert.equal(showElricRow('paused', 'active', ''), false);
  assert.equal(showElricRow('revoked', 'all', ''), false);
  assert.equal(showElricRow(null, 'all', ''), false);
  assert.equal(showElricRow('active', 'all', 'EL'), true);
  assert.equal(showElricRow('active', 'all', 'scout'), false);
});

test('room chips, messages today and the typed remove confirm', () => {
  assert.deepEqual(roomChips([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]), {
    shown: ['a', 'b'],
    more: 2,
  });
  assert.deepEqual(roomChips([{ name: 'a' }]), { shown: ['a'], more: 0 });
  assert.equal(
    messagesToday([{ messagesToday: 2 }, { messagesToday: null }, { messagesToday: 3 }]),
    5,
  );
  assert.equal(messagesToday([{ messagesToday: null }]), null);
  assert.equal(messagesToday([]), null);
  assert.equal(confirmsName('Research scout', 'Research scout'), true);
  assert.equal(confirmsName('  Research scout ', 'Research scout'), true);
  assert.equal(confirmsName('research scout', 'Research scout'), false);
  assert.equal(confirmsName('Research', 'Research scout'), false);
  assert.equal(confirmsName('', '   '), false);
});
