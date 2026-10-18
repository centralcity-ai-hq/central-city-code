import test from 'node:test';
import assert from 'node:assert/strict';
import { agentsPath, isPagedWorkspace, noteSnapshotPaging } from '../src/agents/agentPages.js';
import { readAgentsById, searchLiveAgents } from '../src/agents/ownAgents.js';
import { pickerAgents } from '../src/agents/useAgentPicker.js';
import { agentSearchOf, listOwnAgents, searchOwnAgents } from '../src/rooms/api.js';
import { newRoomAgents, newRoomHostSearch } from '../src/feed/respondApi.js';
import { AGENT_PAGES } from '../shared/agent-pages.js';
import type { Agent, AgentsPageInfo } from '../shared/types.js';

/*
 * The agent pickers of a paged workspace (src/agents/useAgentPicker.ts, src/agents/ownAgents.ts):
 * the act-as lists start from the snapshot's page and search every agent on the server, names not
 * in the snapshot are read by id 50 at a time, and a workspace that is not paged sends exactly
 * the requests it sent before. No network: fetch is replaced. Synthetic data.
 */

const at = '2026-10-15T08:00:00.000Z';
function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id.slice(0, 4)}`,
    description: '',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'offline',
    lastSeenAt: null,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}
const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const info = (count: number): AgentsPageInfo => ({
  total: 900,
  live: 880,
  online: 10,
  limit: 100,
  count,
  nextCursor: 'next',
});
const ELRIC = id(99);

type Route = (path: string) => unknown;
function stubFetch(t: { after: (fn: () => void) => void }, route: Route): string[] {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    seen.push(path);
    const body = route(path);
    return new Response(JSON.stringify(body ?? { error: 'Not found' }), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
    noteSnapshotPaging(null, {});
  });
  return seen;
}
const page = (agents: Agent[]) => ({
  agents,
  total: 900,
  matched: agents.length,
  limit: 50,
  nextCursor: null,
});

test('agentsPath asks for live agents only when told to', () => {
  assert.equal(
    agentsPath({ q: 'scout', live: true, limit: 50 }),
    '/api/agents?limit=50&q=scout&live=1',
  );
  assert.equal(agentsPath({ q: 'scout' }), '/api/agents?q=scout');
});

test('a picker offers its list, or the search results, led by the chosen agents it would miss', () => {
  const a = { id: 'a', name: 'A' };
  const b = { id: 'b', name: 'B' };
  const old = { id: 'old', name: 'Older agent' };
  const known = new Map([a, b, old].map((item) => [item.id, item]));
  assert.equal(pickerAgents(null, null, [], known), null);
  // No search: exactly the list (a workspace that is not paged sees no change).
  assert.deepEqual(pickerAgents([a, b], null, ['a'], known), [a, b]);
  // Searching: the results; the chosen agent stays offered so the select keeps its value.
  assert.deepEqual(pickerAgents([a, b], [old], ['a'], known), [a, old]);
  // Search cleared after choosing an older agent: it stays first in the list.
  assert.deepEqual(pickerAgents([a, b], null, ['old'], known), [old, a, b]);
  // Ids it never saw ('', 'me', 'new') add nothing.
  assert.deepEqual(pickerAgents([a], null, ['', 'me', 'new'], known), [a]);
});

test('act as in a small workspace: the whole snapshot, no search, no other request', async (t) => {
  const agents = [agent(id(1)), agent(id(2), { revokedAt: at, status: 'revoked' }), agent(ELRIC)];
  const seen = stubFetch(t, (path) =>
    path === '/api/snapshot'
      ? { agents, paused: false }
      : path === '/api/elric'
        ? { agent_id: ELRIC }
        : undefined,
  );
  assert.deepEqual(await listOwnAgents(), [{ id: id(1), name: agents[0]!.name }]);
  assert.equal(isPagedWorkspace(null), false);
  assert.equal(agentSearchOf({ searchAgents: searchOwnAgents }), null);
  assert.equal(newRoomHostSearch(false), null);
  assert.deepEqual(seen.sort(), ['/api/elric', '/api/snapshot']);
});

test('act as in a paged workspace: the page, then a server search over every agent', async (t) => {
  const newest = agent(id(1));
  const related = agent(id(2), { name: 'Named by a job' });
  const older = agent(id(3), { name: 'Harbour scout' });
  const pausedOlder = agent(id(4), { name: 'Harbour paused', pausedAt: at });
  const seen = stubFetch(t, (path) => {
    if (path === '/api/snapshot')
      return { agents: [newest, related], agentsPage: info(1), paused: false };
    if (path === '/api/elric') return { agent_id: ELRIC };
    if (path.startsWith('/api/agents?'))
      return page([older, pausedOlder, agent(ELRIC, { name: 'Harbour Elric' })]);
    return undefined;
  });
  // The list is the page (the related agents are names only, not the list).
  assert.deepEqual(await listOwnAgents(), [{ id: newest.id, name: newest.name }]);
  assert.equal(isPagedWorkspace(null), true);
  const search = agentSearchOf({ searchAgents: searchOwnAgents });
  assert.ok(search);
  const found = await search('harbour', new AbortController().signal);
  // Live agents of the whole workspace, never Elric; a paused one may still be joined as.
  assert.deepEqual(
    found.map((item) => item.id),
    [older.id, pausedOlder.id],
  );
  assert.ok(seen.includes('/api/agents?limit=50&q=harbour&live=1'), seen.join(' '));

  // A new room's hosts: the page now, and the search leaves paused agents out.
  const hosts = await newRoomAgents();
  assert.deepEqual(hosts.agents, [{ id: newest.id, name: newest.name }]);
  const hostSearch = newRoomHostSearch(hosts.workspacePaused);
  assert.ok(hostSearch);
  assert.deepEqual(
    (await hostSearch('harbour', new AbortController().signal)).map((item) => item.id),
    [older.id],
  );
  // A paused workspace offers no host, searched or not.
  assert.deepEqual(await newRoomHostSearch(true)!('harbour', new AbortController().signal), []);
});

test('names not in a paged snapshot are read by id, 200 at a time, one request at a time', async (t) => {
  assert.equal(AGENT_PAGES.ids, 200);
  const ids = Array.from({ length: 2 * AGENT_PAGES.ids + 7 }, (_, n) => id(n + 10));
  const seen = stubFetch(t, (path) => {
    const url = new URL(path, 'http://local');
    const asked = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    assert.ok(asked.length <= AGENT_PAGES.ids, `${asked.length} ids in one request`);
    return page(asked.map((item) => agent(item)));
  });
  // Count requests in flight: every GET /api/agents reads the whole workspace document.
  const stubbed = globalThis.fetch;
  let inFlight = 0;
  let most = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    inFlight++;
    most = Math.max(most, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await stubbed(...args);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  const found = await readAgentsById([...ids, ids[0]!, '']);
  globalThis.fetch = stubbed;
  assert.deepEqual(
    found.map((item) => item.id),
    ids,
  );
  assert.equal(seen.length, 3);
  assert.equal(most, 1, 'the batches are read one after the other');
  assert.deepEqual(await readAgentsById([]), []);
  assert.equal(seen.length, 3);
  // The search reads live agents only.
  await searchLiveAgents('scout');
  assert.equal(seen.at(-1), '/api/agents?limit=50&q=scout&live=1');
});
