import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentsPath,
  isPagedWorkspace,
  mergeAgents,
  noteOpenAgent,
  noteSnapshotPaging,
  pagedRosterCounts,
  pageSummary,
  pollSnapshotPath,
  snapshotPage,
  snapshotPath,
} from '../src/agents/agentPages.js';
import { readSnapshot } from '../src/agents/v4/settingsRequests.js';
import type { SettingsRun } from '../src/agents/v4/settingsLifecycle.js';
import { AGENT_PAGES } from '../shared/agent-pages.js';
import type { Agent, AgentsPageInfo } from '../shared/types.js';

/*
 * The console's side of paged owner agent lists (src/agents/agentPages.ts): a workspace that is
 * not paged sends exactly the requests it sent before; a paged one asks the snapshot to include
 * the agent a screen shows and reads pages and searches from GET /api/agents. Synthetic data.
 */

const at = '2026-10-15T08:00:00.000Z';
function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
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
const info = (overrides: Partial<AgentsPageInfo> = {}): AgentsPageInfo => ({
  total: 1234,
  live: 1200,
  online: 40,
  limit: 100,
  count: 2,
  nextCursor: 'cursor-1',
  ...overrides,
});
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';

test('a workspace that is not paged reads the snapshot exactly as before', () => {
  noteSnapshotPaging(null, {});
  assert.equal(isPagedWorkspace(null), false);
  assert.equal(snapshotPath(null, [A]), '/api/snapshot');
  assert.equal(snapshotPath(W, [A]), '/api/snapshot');
});

test('a paged workspace asks the snapshot to include the agents of the screen, per workspace', () => {
  noteSnapshotPaging(W, { agentsPage: info() });
  assert.equal(isPagedWorkspace(W), true);
  assert.equal(isPagedWorkspace(null), false);
  assert.equal(snapshotPath(W, [A, B, A, '']), `/api/snapshot?include=${A},${B}`);
  assert.equal(snapshotPath(W, []), '/api/snapshot');
  assert.equal(snapshotPath(null, [A]), '/api/snapshot');
  const many = Array.from(
    { length: AGENT_PAGES.include + 5 },
    (_, index) => `${A.slice(0, -2)}${String(index).padStart(2, '0')}`,
  );
  assert.equal(snapshotPath(W, many).split(',').length, AGENT_PAGES.include);
  // A hand-typed #agent=<not an id> never reaches the poll (the server would answer 400).
  assert.equal(snapshotPath(W, ['not-a-uuid']), '/api/snapshot');
  assert.equal(snapshotPath(W, ['not-a-uuid', A]), `/api/snapshot?include=${A}`);
  // The workspace is small again (agents removed): back to the plain path.
  noteSnapshotPaging(W, {});
  assert.equal(snapshotPath(W, [A]), '/api/snapshot');
});

test('settings screens read the snapshot with their agent included only when paged', async () => {
  const paths: string[] = [];
  const run = (workspace: string | null) =>
    ({
      agentId: A,
      workspace,
      generation: 1,
      signal: new AbortController().signal,
      live: () => true,
      commit: () => true,
      api: async <T>(path: string) => {
        paths.push(path);
        return { agents: [] } as T;
      },
    }) satisfies SettingsRun;
  await readSnapshot(run(null));
  noteSnapshotPaging(W, { agentsPage: info() });
  await readSnapshot(run(W));
  noteSnapshotPaging(W, {});
  assert.deepEqual(paths, ['/api/snapshot', `/api/snapshot?include=${A}`]);
});

test('agentsPath sends only what is given; an empty search is no search', () => {
  assert.equal(agentsPath(), '/api/agents');
  assert.equal(agentsPath({ q: '   ' }), '/api/agents');
  assert.equal(
    agentsPath({ limit: 100, cursor: 'abc', q: ' harbour lead ' }),
    '/api/agents?limit=100&cursor=abc&q=harbour+lead',
  );
  assert.equal(agentsPath({ ids: [A, B] }), `/api/agents?ids=${encodeURIComponent(`${A},${B}`)}`);
  assert.equal(agentsPath({ under: A, limit: 200 }), `/api/agents?limit=200&under=${A}`);
  assert.equal(
    agentsPath({ q: 'x'.repeat(AGENT_PAGES.query + 50) }),
    `/api/agents?q=${'x'.repeat(AGENT_PAGES.query)}`,
  );
});

test('mergeAgents keeps each agent once, the first copy wins', () => {
  const fresh = agent(A, { name: 'Fresh' });
  const merged = mergeAgents([fresh], [agent(A, { name: 'Stale' }), agent(B)], [agent(B)]);
  assert.deepEqual(
    merged.map((item) => [item.id, item.name]),
    [
      [A, 'Fresh'],
      [B, `Agent ${B}`],
    ],
  );
});

test('the list of a paged snapshot is its page; the related agents after it are names only', () => {
  const agents = [agent(A), agent(B), agent(W)];
  assert.deepEqual(snapshotPage({ agents }), agents);
  assert.deepEqual(
    snapshotPage({ agents, agentsPage: info({ count: 2 }) }).map((item) => item.id),
    [A, B],
  );
});

test('the page pill counts every agent from the server, without Elric', () => {
  const elric = agent(W, { status: 'online' });
  assert.deepEqual(pagedRosterCounts(info(), [elric], W), { total: 1199, online: 39 });
  assert.deepEqual(pagedRosterCounts(info(), [elric], null), { total: 1200, online: 40 });
  // Elric paused or not in the snapshot: only what is known is taken off.
  assert.deepEqual(pagedRosterCounts(info(), [{ ...elric, pausedAt: at }], W), {
    total: 1199,
    online: 40,
  });
  assert.deepEqual(pagedRosterCounts(info(), [], W), { total: 1200, online: 40 });
});

test('the pager says how many are shown of all', () => {
  assert.equal(pageSummary(100, 12345, false), 'Showing 100 of 12,345 agents');
  assert.equal(pageSummary(1, 1, true), '1 of 1 match');
  assert.equal(pageSummary(12, 40, true), '12 of 40 matches');
});

test('the console snapshot poll includes the agent open in My agents, only when paged', () => {
  noteOpenAgent(null);
  assert.equal(pollSnapshotPath(W), '/api/snapshot');
  noteOpenAgent(A);
  // Not paged: the poll is unchanged.
  noteSnapshotPaging(W, {});
  assert.equal(pollSnapshotPath(W), '/api/snapshot');
  // Paged: the open agent (perhaps of a later page) is in every poll, so its status is fresh.
  noteSnapshotPaging(W, { agentsPage: info() });
  assert.equal(pollSnapshotPath(W), `/api/snapshot?include=${A}`);
  noteOpenAgent(B);
  assert.equal(pollSnapshotPath(W), `/api/snapshot?include=${B}`);
  // Closed: back to the plain poll.
  noteOpenAgent(null);
  assert.equal(pollSnapshotPath(W), '/api/snapshot');
  noteSnapshotPaging(W, {});
});
