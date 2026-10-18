import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ConnectionRequest } from '../shared/assistant';
import type { Connection } from '../shared/types';
import {
  ARROW_GLYPHS,
  activeCount,
  connectionPlan,
  crossGroup,
  crossHistory,
  crossTone,
  crossWhen,
  matchesFilter,
  pendingRequests,
  revocable,
  routeLine,
} from '../src/permissions/model';

/*
 * Agent permissions v3 ("Your agents, your rules"): the route in words, what the New connection
 * sheet creates (each route one way; "both ways" is a second route), the filters over
 * connections with other people, and the page's styles: v3 tokens only, scoped to the page, no
 * arrow characters in what people read.
 */

const route = (from: string, to: string): Connection => ({
  id: `test-route-${from}-${to}`,
  fromAgentId: from,
  toAgentId: to,
  createdAt: '2026-10-03T12:00:00.000Z',
});

function request(status: ConnectionRequest['status'], direction: 'incoming' | 'outgoing') {
  return {
    id: `test-request-${status}-${direction}`,
    direction,
    status,
    from_agent_id: 'test-agent-0001',
    from_agent_name: 'Synthetic peer',
    from_owner_label: 'Synthetic workspace',
    to_agent_id: 'test-agent-0002',
    to_agent_name: null,
    note: '',
    requested_at: '2026-10-03T12:00:00.000Z',
    expires_at: '2026-10-10T12:00:00.000Z',
    decided_at: status === 'pending' ? null : '2026-10-04T12:00:00.000Z',
    revoked_at: status === 'revoked' ? '2026-10-05T12:00:00.000Z' : null,
  } satisfies ConnectionRequest;
}

test('a route is said in words, one way unless the way back exists', () => {
  assert.equal(
    routeLine('Scout', 'Porter', false),
    'Scout sends work to Porter. Not the other way.',
  );
  assert.equal(routeLine('Scout', 'Porter', true), 'Porter can also send work to Scout');
  assert.doesNotMatch(routeLine('A', 'B', false) + routeLine('A', 'B', true), ARROW_GLYPHS);
});

test('the New connection sheet creates one route per direction, never a duplicate', () => {
  const routes = [route('a', 'b')];
  assert.deepEqual(connectionPlan(routes, 'b', 'c', false), {
    same: false,
    forward: false,
    back: false,
    creates: [{ from: 'b', to: 'c' }],
    blocked: false,
  });
  // Both ways: the second route is the reverse, a second POST /api/connections.
  assert.deepEqual(connectionPlan(routes, 'b', 'c', true).creates, [
    { from: 'b', to: 'c' },
    { from: 'c', to: 'b' },
  ]);
  // Already connected one way: blocked, unless the way back is asked for (then only that).
  assert.equal(connectionPlan(routes, 'a', 'b', false).blocked, true);
  assert.equal(connectionPlan(routes, 'a', 'b', false).forward, true);
  assert.deepEqual(connectionPlan(routes, 'a', 'b', true).creates, [{ from: 'b', to: 'a' }]);
  // The reverse already exists: only the asked route.
  const plan = connectionPlan(routes, 'b', 'a', true);
  assert.equal(plan.back, true);
  assert.deepEqual(plan.creates, [{ from: 'b', to: 'a' }]);
  // Both directions exist, the same agent twice, or an agent missing: nothing to create.
  assert.equal(connectionPlan([...routes, route('b', 'a')], 'a', 'b', true).blocked, true);
  assert.equal(connectionPlan(routes, 'c', 'c', true).same, true);
  assert.equal(connectionPlan(routes, 'c', 'c', true).blocked, true);
  assert.equal(connectionPlan(routes, '', 'c', false).blocked, true);
});

test('connections with other people: waiting requests, history, filters and tones', () => {
  const lists = {
    incoming: [request('pending', 'incoming'), request('approved', 'incoming')],
    outgoing: [request('pending', 'outgoing'), request('revoked', 'outgoing')],
  };
  assert.deepEqual(
    pendingRequests(lists).map((item) => item.id),
    ['test-request-pending-incoming'],
  );
  // History: decided incoming first, then everything this workspace sent.
  assert.deepEqual(
    crossHistory(lists).map((item) => item.id),
    [
      'test-request-approved-incoming',
      'test-request-pending-outgoing',
      'test-request-revoked-outgoing',
    ],
  );
  assert.deepEqual(pendingRequests(null), []);
  assert.deepEqual(crossHistory(null), []);
  assert.equal(crossGroup('approved'), 'connected');
  assert.equal(crossGroup('pending'), 'waiting');
  for (const status of ['denied', 'revoked', 'expired'] as const) {
    assert.equal(crossGroup(status), 'ended');
    assert.equal(crossTone(status), 'idle');
    assert.equal(revocable(request(status, 'outgoing')), false);
  }
  assert.equal(crossTone('approved'), 'ok');
  assert.equal(crossTone('pending'), 'wait');
  assert.equal(revocable(request('approved', 'incoming')), true);
  assert.equal(revocable(request('pending', 'outgoing')), true);
  const history = crossHistory(lists);
  assert.equal(history.filter((item) => matchesFilter(item, 'all')).length, 3);
  assert.equal(history.filter((item) => matchesFilter(item, 'connected')).length, 1);
  assert.equal(history.filter((item) => matchesFilter(item, 'waiting')).length, 1);
  assert.equal(history.filter((item) => matchesFilter(item, 'ended')).length, 1);
  // Active: your own routes and approved connections with other people.
  assert.equal(activeCount([route('a', 'b'), route('b', 'c')], lists), 3);
  assert.equal(activeCount([], null), 0);
  assert.match(crossWhen(request('approved', 'incoming')), /^Connected /);
  assert.match(crossWhen(request('pending', 'outgoing')), /^Asked /);
  assert.match(crossWhen(request('revoked', 'outgoing')), /^Ended /);
  assert.match(crossWhen(request('denied', 'incoming')), /^Denied /);
  assert.match(crossWhen(request('expired', 'incoming')), /^Expired /);
});

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const css = read('src/permissions/agent-permissions.css');

test('the page styles stay scoped to Agent permissions and use theme tokens only', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let checked = 0;
  // Every rule, also those inside @media and @container blocks.
  for (const match of rules.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1]!.trim();
    if (prelude.startsWith('@') || /^(from|to|[\d.]+%)$/.test(prelude)) continue;
    for (const selector of prelude.split(/,(?![^(]*\))/).map((item) => item.trim())) {
      assert.match(selector, /\.perm3/, `unscoped: ${selector}`);
      checked += 1;
    }
  }
  assert.ok(checked > 100, `only ${checked} selectors checked`);
  // Colours come from the v3 tokens (light and dark follow html[data-theme]).
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'a literal colour');
  assert.doesNotMatch(rules, /\brgba?\(|\bhsla?\(/i, 'a literal colour');
  // The other Advanced views keep their own stylesheet; this page adds nothing there.
  assert.doesNotMatch(read('src/advanced-v2.css'), /perm3/);
});

test('no arrow characters on the page, its sheet or its cards', () => {
  for (const file of [
    'src/permissions/AgentPermissions.tsx',
    'src/permissions/ConnectionSheet.tsx',
    'src/permissions/parts.tsx',
    'src/permissions/model.ts',
    'src/Connections.tsx',
  ]) {
    // The pattern itself is written with escapes, so no file needs an exception.
    assert.doesNotMatch(read(file), ARROW_GLYPHS, `${file} has an arrow character`);
  }
});
