import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, Connection, Job, Snapshot } from '../shared/types';
import { workspaceTarget } from './workspace-density';
import { workspaceSwitcher } from './settings-nav';
import { NO_AGENT_DIALOG, openAgentDialog } from './my-agents-open';

// Every spec here inspects the agent's full dialog, which has no entry point any more.
test.skip(true, NO_AGENT_DIALOG);

const headers = { 'X-City-Request': '1' };
const recordedAt = '2026-10-03T12:00:00.000Z';
const crossRequestsPath = '/api/v2/connections/requests';

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: 'Synthetic inspection fixture',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: recordedAt,
    createdAt: recordedAt,
    revokedAt: null,
    ...overrides,
  };
}

const inspected = agent('test-agent-inspected', 'Inspection scout');
const peer = agent('test-agent-peer', 'Review partner');
const unrelated = agent('test-agent-unrelated', 'Unrelated specialist');

function job(index: number, overrides: Partial<Job> = {}): Job {
  const createdAt = new Date(Date.parse(recordedAt) - index * 60_000).toISOString();
  return {
    id: `test-job-${index}`,
    requesterId: inspected.id,
    providerId: peer.id,
    capability: 'research',
    input: `Synthetic private input ${index}`,
    status: 'completed',
    acceptance: 'pending',
    output: { summary: `Synthetic private output ${index}` },
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
    acceptedAt: null,
    costCents: null,
    error: null,
    isDemo: false,
    ...overrides,
  };
}

function connection(id: string, fromAgentId: string, toAgentId: string): Connection {
  return { id, fromAgentId, toAgentId, createdAt: recordedAt };
}

type Direction = ConnectionRequest['direction'];
type ApprovedQuery = {
  direction: Direction;
  before: string | null;
  workspace: string | null;
  params: URLSearchParams;
};

function foreignConnection(
  id: string,
  direction: Direction,
  overrides: Partial<ConnectionRequest> = {},
): ConnectionRequest {
  return {
    id,
    direction,
    status: 'approved',
    from_agent_id: direction === 'incoming' ? 'test-remote-requester' : inspected.id,
    from_agent_name: direction === 'incoming' ? 'Remote requester' : inspected.name,
    from_owner_label: direction === 'incoming' ? 'Requesting workspace' : 'Own workspace label',
    to_agent_id: direction === 'incoming' ? inspected.id : 'test-remote-provider',
    to_agent_name: direction === 'incoming' ? inspected.name : 'Remote provider',
    note: 'Synthetic private connection note',
    requested_at: recordedAt,
    // This deadline applies to pending requests, not to the lifetime of an approved connection.
    expires_at: '2025-01-01T12:00:00.000Z',
    decided_at: recordedAt,
    revoked_at: null,
    ...overrides,
  };
}

function connectionPage(
  direction: Direction,
  connections: ConnectionRequest[],
  next: string | null = null,
) {
  return {
    incoming: direction === 'incoming' ? connections : [],
    outgoing: direction === 'outgoing' ? connections : [],
    next_before: next,
  };
}

async function approvedRoute(
  page: Page,
  handler: (route: Route, query: ApprovedQuery) => Promise<void>,
) {
  await page.route(`**${crossRequestsPath}?*`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const direction = url.searchParams.get('direction');
    if (
      request.method() !== 'GET' ||
      (direction !== 'incoming' && direction !== 'outgoing') ||
      // My agents v2 reads pending requests for its own list; only approved reads count here.
      url.searchParams.get('status') === 'pending'
    ) {
      return route.fallback();
    }
    await handler(route, {
      direction,
      before: url.searchParams.get('before'),
      workspace: request.headers()['x-city-workspace'] ?? null,
      params: url.searchParams,
    });
  });
}

function crossRegion(panel: Locator) {
  return panel.getByRole('region', { name: 'Connections with other workspaces', exact: true });
}

function foreignRows(panel: Locator) {
  return crossRegion(panel)
    .getByRole('list', { name: 'Approved cross-workspace connections', exact: true })
    .getByRole('listitem');
}

async function readsSettled(panel: Locator) {
  await expect(
    crossRegion(panel).getByRole('button', { name: 'Refresh connections', exact: true }),
  ).toHaveAttribute('aria-disabled', 'false');
  await expect(crossRegion(panel).getByRole('status')).toHaveCount(0);
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestSettlement(page: Page, request: Request) {
  const tracker = {
    outcome: null as 'finished' | 'failed' | null,
    cleanup: () => {
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
    },
  };
  const settle = (candidate: Request, outcome: 'finished' | 'failed') => {
    if (candidate !== request) return;
    tracker.outcome = outcome;
    tracker.cleanup();
  };
  const finished = (candidate: Request) => settle(candidate, 'finished');
  const failed = (candidate: Request) => settle(candidate, 'failed');
  page.on('requestfinished', finished);
  page.on('requestfailed', failed);
  return tracker;
}

async function holdApprovedReads(
  page: Page,
  matches: (query: ApprovedQuery) => boolean,
  respond: (query: ApprovedQuery) => { status?: number; json: unknown },
) {
  const release = signal();
  let armed = true;
  const held: {
    query: ApprovedQuery;
    settlement: ReturnType<typeof requestSettlement>;
    delivered: boolean;
    deliveryError?: unknown;
  }[] = [];
  await approvedRoute(page, async (route, query) => {
    if (!armed || !matches(query)) return route.fallback();
    const request = route.request();
    const entry: (typeof held)[number] = {
      query,
      settlement: requestSettlement(page, request),
      delivered: false,
    };
    held.push(entry);
    // Every caller waits with bounded assertions inside try/finally, then calls finish().
    await release.promise;
    try {
      await route.fulfill(respond(query));
    } catch (error) {
      entry.deliveryError = error;
    } finally {
      entry.delivered = true;
    }
  });
  return {
    held,
    disarm: () => {
      armed = false;
    },
    finish: async () => {
      armed = false;
      release.resolve();
      try {
        await expect
          .poll(() => held.every((entry) => entry.delivered && entry.settlement.outcome !== null), {
            timeout: 5_000,
            message: 'Released approved reads finish or fail before cleanup',
          })
          .toBe(true);
        for (const entry of held) {
          if (entry.deliveryError && entry.settlement.outcome !== 'failed') {
            throw entry.deliveryError;
          }
        }
      } finally {
        for (const entry of held) entry.settlement.cleanup();
      }
    },
  };
}

async function fixture(page: Page, overrides: Partial<Snapshot> = {}) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Agent-inspection-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  const response = await page.request.get('/api/snapshot');
  expect(response.ok()).toBe(true);
  const baseline = (await response.json()) as Snapshot;
  const snapshot: Snapshot = {
    ...baseline,
    agents: [inspected, peer, unrelated],
    jobs: [job(0)],
    connections: [connection('test-connection-outgoing', inspected.id, peer.id)],
    ...overrides,
  };
  // A static fixture also survives the console's periodic refresh; no ordinal responses.
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**${crossRequestsPath}*`, (route) =>
    route.fulfill({ json: { incoming: [], outgoing: [], next_before: null } }),
  );
  return snapshot;
}

async function agentsPage(page: Page, theme = 'light') {
  await page.goto(`/?theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Agents', exact: true })).toBeVisible();
}

function card(page: Page, name = inspected.name) {
  // What opens the full dialog: the classic card, or ⋯ in the My agents v4 detail.
  return page
    .locator('.agent-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .or(
      page
        .getByRole('complementary', { name: `${name} details` })
        .getByRole('button', { name: `More for ${name}` }),
    );
}

async function inspectAgent(page: Page, name = inspected.name) {
  await openAgentDialog(page, name);
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog.getByRole('tablist', { name: 'Agent details' })).toBeVisible();
  return dialog;
}

function mutations(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') {
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  return requests;
}

async function permissions(dialog: Locator) {
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click();
  return dialog.getByRole('tabpanel', { name: 'Permissions', exact: true });
}

test('runs retain workspace order, both roles and every exchange state without exposing payloads', async ({
  page,
}) => {
  const states: Partial<Job>[] = [
    { status: 'queued', output: null, completedAt: null },
    { status: 'running', output: null, completedAt: null },
    { status: 'completed' },
    { status: 'completed', acceptance: 'accepted', acceptedAt: recordedAt },
    { status: 'failed', error: 'Synthetic private diagnostic', output: null },
    { status: 'canceled', output: null },
  ];
  // Source order is authoritative even when its timestamps are not chronological.
  const minuteOffsets = [4, 0, 5, 1, 3, 2];
  const jobs = states.map((state, index) => {
    const timestamp = new Date(
      Date.parse(recordedAt) - minuteOffsets[index] * 60_000,
    ).toISOString();
    return job(index, {
      ...state,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: state.completedAt === null ? null : timestamp,
      ...(index % 2 ? { requesterId: peer.id, providerId: inspected.id } : {}),
    });
  });
  jobs.splice(2, 0, job(90, { requesterId: peer.id, providerId: unrelated.id }));
  await fixture(page, { jobs });
  const writes = mutations(page);
  await agentsPage(page);
  const dialog = await inspectAgent(page);
  const panel = dialog.getByRole('tabpanel', { name: 'Runs', exact: true });
  const rows = panel.getByRole('list', { name: 'Recent runs' }).getByRole('listitem');
  await expect(rows).toHaveCount(6);
  const labels = [
    'Waiting to start',
    'In progress',
    'Needs your review',
    'Accepted',
    'Failed',
    'Canceled',
  ];
  for (let index = 0; index < labels.length; index++) {
    await expect(rows.nth(index)).toContainText(labels[index]);
    await expect(rows.nth(index)).toContainText(index % 2 ? 'Performer' : 'Requested');
    await expect(rows.nth(index)).toContainText(peer.name);
  }
  await expect(panel).not.toContainText('Synthetic private');
  await expect(panel).not.toContainText(unrelated.name);
  await expect(panel).not.toContainText('test-job-');
  expect(writes).toEqual([]);
});

test('missing peer records have honest fallbacks in runs and directional connections', async ({
  page,
}) => {
  await fixture(page, {
    jobs: [
      job(0, { providerId: 'test-missing-provider' }),
      job(1, { requesterId: 'test-missing-requester', providerId: inspected.id }),
    ],
    connections: [
      connection('test-connection-missing-out', inspected.id, 'test-missing-provider'),
      connection('test-connection-missing-in', 'test-missing-requester', inspected.id),
    ],
  });
  await agentsPage(page);
  const dialog = await inspectAgent(page);
  const runs = dialog.getByRole('list', { name: 'Recent runs' }).getByRole('listitem');
  await expect(runs).toHaveCount(2);
  for (const row of await runs.all()) {
    await expect(row).toContainText('An agent outside this list');
    await expect(
      row.getByRole('button', { name: /Open .+ run with An agent outside this list/ }),
    ).toBeEnabled();
  }
  const panel = await permissions(dialog);
  const edges = panel.getByRole('list', { name: 'Workspace connections' }).getByRole('listitem');
  await expect(edges).toHaveCount(2);
  await expect(edges.nth(0)).toContainText('Outgoing');
  await expect(edges.nth(1)).toContainText('Incoming');
  await expect(
    panel.getByRole('heading', { name: 'An agent outside this list', exact: true }),
  ).toHaveCount(2);
  await expect(panel.getByText('Agent unavailable in this list', { exact: true })).toHaveCount(2);
  await expect(panel).not.toContainText('test-missing-');
});

test('recent window and empty copy do not claim complete agent history or invented pagination', async ({
  page,
}) => {
  const idle = agent('test-agent-idle', 'Idle specialist');
  const jobs = Array.from({ length: 50 }, (_, index) =>
    job(index, {
      requesterId: index === 0 || index === 49 ? inspected.id : peer.id,
      providerId: unrelated.id,
    }),
  );
  // An older matching record must not expand the advertised workspace window.
  jobs.push(job(50));
  await fixture(page, { agents: [inspected, peer, unrelated, idle], jobs });
  await agentsPage(page);
  let dialog = await inspectAgent(page);
  let panel = dialog.getByRole('tabpanel', { name: 'Runs', exact: true });
  await expect(panel.getByRole('list', { name: 'Recent runs' }).getByRole('listitem')).toHaveCount(
    2,
  );
  await expect(panel).toContainText('latest 50 workspace exchanges');
  await expect(panel).toContainText('Older runs may not appear here.');
  await expect(panel.getByRole('button', { name: /next|previous|load more/i })).toHaveCount(0);
  await expect(panel).not.toContainText(/all[- ]time|total runs|complete history/i);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  dialog = await inspectAgent(page, idle.name);
  panel = dialog.getByRole('tabpanel', { name: 'Runs', exact: true });
  await expect(
    panel.getByRole('heading', { name: 'No runs in recent workspace history' }),
  ).toBeVisible();
  await expect(panel).toContainText('latest 50 workspace exchanges');
  await expect(panel.getByRole('button', { name: /^Open .+ run with/ })).toHaveCount(0);
  const access = await permissions(dialog);
  await expect(access.getByRole('heading', { name: 'No workspace connections' })).toBeVisible();
  await expect(access).not.toContainText(/no permissions|no access|cannot access anything/i);
});

test('permissions show direct incoming and outgoing connections without inferring app scopes from lineage', async ({
  page,
}) => {
  const child = {
    ...inspected,
    createdBy: { kind: 'assistant' as const, id: 'test-grant-origin' },
    parentAgentId: peer.id,
    depth: 1,
  };
  await fixture(page, {
    agents: [child, peer, unrelated],
    connections: [
      connection('test-connection-out', child.id, peer.id),
      connection('test-connection-in', unrelated.id, child.id),
      connection('test-connection-unrelated', peer.id, unrelated.id),
    ],
  });
  const writes = mutations(page);
  await agentsPage(page);
  const panel = await permissions(await inspectAgent(page));
  const edges = panel.getByRole('list', { name: 'Workspace connections' }).getByRole('listitem');
  await expect(edges).toHaveCount(2);
  await expect(edges.nth(0)).toContainText('Outgoing');
  await expect(edges.nth(0)).toContainText(peer.name);
  await expect(edges.nth(1)).toContainText('Incoming');
  await expect(edges.nth(1)).toContainText(unrelated.name);
  await expect(panel).toContainText('Connected apps manages AI access across this workspace.');
  await expect(panel).toContainText(
    'These permissions are separate from this agent’s connections.',
  );
  await expect(panel).not.toContainText(
    /workspace:read|agents:create|inherited permissions|trusted creator/i,
  );
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('keyboard tabs expose one labelled panel and open the existing exchange dialog', async ({
  page,
}) => {
  await fixture(page);
  const writes = mutations(page);
  await agentsPage(page);
  const opener = card(page);
  const dialog = await inspectAgent(page);
  const runs = dialog.getByRole('tab', { name: 'Runs', exact: true });
  const access = dialog.getByRole('tab', { name: 'Permissions', exact: true });
  const base = dialog.getByRole('tab', { name: 'Base', exact: true });
  // Keep this selector aligned with Modal's actual trap, which does not filter hidden nodes.
  const modalFocusable =
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]';
  async function assertTabTraversal() {
    const inactive = dialog.locator('[role="tabpanel"][hidden]');
    await expect(inactive).toHaveCount(2);
    for (const hidden of await inactive.all())
      await expect(hidden).toHaveAttribute('tabindex', '-1');
    await expect(inactive.locator(modalFocusable)).toHaveCount(0);
    const focusables = dialog.locator(modalFocusable);
    const first = focusables.first();
    const last = focusables.last();
    await expect(first).toBeVisible();
    await expect(last).toBeVisible();
    await first.focus();
    await first.press('Shift+Tab');
    await expect(last).toBeFocused();
    await last.press('Tab');
    await expect(first).toBeFocused();
    await first.press('Tab');
    const selectedTab = dialog.locator('[role="tab"][aria-selected="true"]');
    await expect(selectedTab).toBeFocused();
    await selectedTab.press('Tab');
    const activePanel = dialog.getByRole('tabpanel');
    await expect(activePanel).toBeFocused();
    if ((await access.getAttribute('aria-selected')) === 'true') await readsSettled(activePanel);
    await activePanel.press('Tab');
    await expect(activePanel.locator('button:not(:disabled)').first()).toBeFocused();
  }
  await expect(runs).toHaveAttribute('aria-selected', 'true');
  await expect(runs).toHaveAttribute('tabindex', '0');
  await expect(access).toHaveAttribute('tabindex', '-1');
  await assertTabTraversal();
  await runs.focus();
  await runs.press('ArrowRight');
  await expect(access).toBeFocused();
  await expect(access).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tabpanel')).toHaveCount(1);
  let panel = dialog.getByRole('tabpanel', { name: 'Permissions', exact: true });
  await expect(panel).toHaveAttribute('id', (await access.getAttribute('aria-controls'))!);
  await expect(panel).toHaveAttribute('aria-labelledby', (await access.getAttribute('id'))!);
  await assertTabTraversal();
  await access.focus();
  await access.press('Home');
  await expect(runs).toBeFocused();
  await runs.press('End');
  await expect(base).toBeFocused();
  await base.press('ArrowRight');
  await expect(runs).toBeFocused();
  await runs.press('ArrowLeft');
  await expect(base).toBeFocused();
  await base.press('ArrowLeft');
  await expect(access).toBeFocused();
  await access.press('ArrowLeft');
  await expect(runs).toBeFocused();
  panel = dialog.getByRole('tabpanel', { name: 'Runs', exact: true });
  await expect(panel).toHaveAttribute('id', (await runs.getAttribute('aria-controls'))!);
  await expect(panel).not.toContainText('Synthetic private input 0');
  const openRun = panel.getByRole('button', { name: /^Open .+ run with/ });
  await openRun.focus();
  await openRun.press('Enter');
  const exchange = page.getByRole('dialog', { name: 'Exchange', exact: true });
  await expect(exchange).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(exchange).toContainText('Synthetic private input 0');
  await expect(exchange).toContainText('Synthetic private output 0');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Closing an agent dialog directly restores its card, including after inspecting its tabs.
  const reopened = await inspectAgent(page);
  await permissions(reopened);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  expect(writes).toEqual([]);
});

test('permission destinations close inspection and navigate without changing access', async ({
  page,
}) => {
  await fixture(page);
  const writes = mutations(page);
  await agentsPage(page);
  let panel = await permissions(await inspectAgent(page));
  await panel.getByRole('button', { name: 'Manage connections', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The workspace names the connections view Agent permissions.
  await expect(page.getByRole('heading', { name: 'Agent permissions', level: 1 })).toBeVisible();
  await agentsPage(page);
  panel = await permissions(await inspectAgent(page));
  await panel.getByRole('button', { name: 'Connected apps', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page
      .locator('.assistant-preview')
      .getByRole('heading', { name: 'Connected apps', exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test('paused and revoked agents retain history without presenting connections as permission to run', async ({
  page,
}) => {
  const paused = agent('test-agent-paused', 'Paused scout', { pausedAt: recordedAt });
  const revoked = agent('test-agent-revoked', 'Removed scout', {
    status: 'revoked',
    revokedAt: recordedAt,
  });
  const snapshot = await fixture(page, {
    agents: [paused, revoked, peer],
    jobs: [
      job(0, { requesterId: paused.id }),
      job(1, { requesterId: revoked.id, status: 'canceled', output: null }),
    ],
    connections: [
      connection('test-paused-edge', paused.id, peer.id),
      connection('test-revoked-edge', peer.id, revoked.id),
    ],
  });
  const writes = mutations(page);
  await agentsPage(page);
  for (const current of [paused, revoked]) {
    // My agents v4 lists a removed agent faded and does not open it (nothing left to manage);
    // the classic console still opens its card.
    if (current === revoked && !(await page.locator('.agent-card').count())) {
      await expect(
        page.getByRole('listitem').filter({ hasText: revoked.name }).getByRole('button'),
      ).toHaveCount(0);
      continue;
    }
    const dialog = await inspectAgent(page, current.name);
    await expect(
      dialog.getByRole('list', { name: 'Recent runs' }).getByRole('listitem'),
    ).toHaveCount(1);
    const panel = await permissions(dialog);
    await expect(
      panel.getByRole('list', { name: 'Workspace connections' }).getByRole('listitem'),
    ).toHaveCount(1);
    await expect(panel).toContainText(
      current === revoked ? /revoked|removed/i : /agent is paused/i,
    );
    await expect(panel).not.toContainText(/ready to run|can run now|full access/i);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
  }
  // Explicit fixture phase: every later poll sees the paused workspace, independent of timing.
  snapshot.paused = true;
  await agentsPage(page);
  const panel = await permissions(await inspectAgent(page, peer.name));
  await expect(panel).toContainText(
    'This workspace is paused. Recorded connections do not mean work can run now.',
  );
  expect(writes).toEqual([]);
});

test('workspace switches reopen inspection with only the selected workspace snapshot', async ({
  page,
}) => {
  const personal = await fixture(page);
  const otherId = 'test-other-workspace';
  const otherPeer = agent('test-other-peer', 'Other workspace reviewer');
  const other: Snapshot = {
    ...personal,
    operator: { id: otherId, name: 'Other inspection workspace' },
    agents: [inspected, otherPeer],
    jobs: [
      job(1, {
        requesterId: otherPeer.id,
        providerId: inspected.id,
        status: 'failed',
        output: null,
      }),
    ],
    connections: [connection('test-other-edge', otherPeer.id, inspected.id)],
  };
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { ...personal.operator, kind: 'owner', role: 'owner' },
          { ...other.operator, kind: 'ai', role: 'owner' },
        ],
      },
    }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: route.request().headers()['x-city-workspace'] === otherId ? other : personal,
    }),
  );
  await page.route('**/api/rooms', (route) => route.fulfill({ json: { rooms: [] } }));
  await page.route('**/api/v2/connections/requests', (route) =>
    route.fulfill({ json: { incoming: [], outgoing: [] } }),
  );
  await agentsPage(page);
  const personalDialog = await inspectAgent(page);
  await expect(personalDialog.getByRole('list', { name: 'Recent runs' })).toContainText(peer.name);
  await personalDialog.getByRole('button', { name: 'Close dialog' }).click();
  const switched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/snapshot' &&
      response.request().headers()['x-city-workspace'] === otherId,
  );
  await (await workspaceSwitcher(page)).selectOption(otherId);
  await (await switched).finished();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  let dialog = await inspectAgent(page);
  await expect(dialog.getByRole('list', { name: 'Recent runs' })).toContainText(otherPeer.name);
  await expect(dialog.getByRole('list', { name: 'Recent runs' })).not.toContainText(peer.name);
  let panel = await permissions(dialog);
  await expect(panel.getByRole('list', { name: 'Workspace connections' })).toContainText(
    otherPeer.name,
  );
  await expect(panel).not.toContainText(peer.name);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  const returned = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/snapshot' &&
      !response.request().headers()['x-city-workspace'],
  );
  await (await workspaceSwitcher(page)).selectOption(personal.operator.id);
  await (await returned).finished();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  dialog = await inspectAgent(page);
  await expect(dialog.getByRole('tab', { name: 'Runs', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.getByRole('list', { name: 'Recent runs' })).not.toContainText(otherPeer.name);
  panel = await permissions(dialog);
  await expect(panel.getByRole('list', { name: 'Workspace connections' })).toContainText(peer.name);
});

test('Permissions lazily reads both approved directions and keeps remote facts separate from local agents', async ({
  page,
}) => {
  await fixture(page);
  const queries: ApprovedQuery[] = [];
  await approvedRoute(page, async (route, query) => {
    queries.push(query);
    const incoming = query.direction === 'incoming';
    const relevant = foreignConnection(`test-cross-${query.direction}`, query.direction);
    const unknown = foreignConnection(
      `test-unnamed-${query.direction}`,
      query.direction,
      incoming ? { from_agent_name: null } : { to_agent_name: null },
    );
    const wrongEndpoint = foreignConnection(
      `test-wrong-endpoint-${query.direction}`,
      query.direction,
      incoming
        ? {
            from_agent_id: inspected.id,
            to_agent_id: unrelated.id,
            from_agent_name: 'Wrong local endpoint',
          }
        : {
            from_agent_id: unrelated.id,
            to_agent_id: inspected.id,
            to_agent_name: 'Wrong local endpoint',
          },
    );
    const nonApproved = foreignConnection(`test-not-approved-${query.direction}`, query.direction, {
      status: incoming ? 'pending' : 'revoked',
      from_agent_name: 'Not an approved connection',
      to_agent_name: 'Not an approved connection',
    });
    const wrongDirection = foreignConnection(
      `test-wrong-direction-${query.direction}`,
      incoming ? 'outgoing' : 'incoming',
      {
        from_agent_id: inspected.id,
        to_agent_id: inspected.id,
        from_agent_name: 'Wrong direction record',
        to_agent_name: 'Wrong direction record',
      },
    );
    await route.fulfill({
      json: connectionPage(query.direction, [
        relevant,
        unknown,
        wrongEndpoint,
        nonApproved,
        wrongDirection,
      ]),
    });
  });
  const writes = mutations(page);
  await agentsPage(page);
  const dialog = await inspectAgent(page);
  await expect(dialog.getByRole('tabpanel', { name: 'Runs', exact: true })).toContainText(
    'latest 50 workspace exchanges',
  );
  expect(queries).toHaveLength(0);
  const panel = await permissions(dialog);
  await readsSettled(panel);
  expect(queries).toHaveLength(2);
  expect(queries.map((query) => query.direction).sort()).toEqual(['incoming', 'outgoing']);
  for (const query of queries) {
    expect(Object.fromEntries(query.params)).toEqual({
      direction: query.direction,
      status: 'approved',
      limit: '100',
    });
    expect(query.workspace).toBeNull();
  }
  const rows = foreignRows(panel);
  await expect(rows).toHaveCount(4);
  const incomingRow = rows.filter({
    has: page.getByRole('heading', { name: 'Remote requester', exact: true }),
  });
  await expect(incomingRow).toContainText('Incoming');
  await expect(incomingRow).toContainText(`Route from Remote requester to ${inspected.name}`);
  await expect(incomingRow).toContainText('Requesting workspace: Requesting workspace');
  const outgoingRow = rows.filter({
    has: page.getByRole('heading', { name: 'Remote provider', exact: true }),
  });
  await expect(outgoingRow).toContainText('Outgoing');
  await expect(outgoingRow).toContainText(`Route from ${inspected.name} to Remote provider`);
  await expect(outgoingRow).not.toContainText(/Own workspace label|Requesting workspace:/);
  await expect(
    crossRegion(panel).getByRole('heading', { name: 'Agent name unavailable', exact: true }),
  ).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.getByText('Approved', { exact: true })).toBeVisible();
    await expect(row).not.toContainText(
      /expired|expires|online|offline|paused|2025|test-|Synthetic private/i,
    );
  }
  await expect(crossRegion(panel)).not.toContainText(
    /Wrong local endpoint|Not an approved connection|Wrong direction record/,
  );
  await expect(
    panel.getByRole('list', { name: 'Workspace connections', exact: true }),
  ).toContainText(peer.name);
  await expect(panel).toContainText('Connected apps manages AI access across this workspace.');
  expect(writes).toEqual([]);
});

test('approved connections follow each returned cursor, filter every page and replace pages on refresh', async ({
  page,
}) => {
  await fixture(page);
  const cursors = {
    incoming: '1791028800000.test-incoming-cursor',
    outgoing: '1791028800000.test-outgoing-cursor',
  };
  const lastIncomingCursor = '1791028700000.test-incoming-last';
  const queries: ApprovedQuery[] = [];
  let refreshed = false;
  await approvedRoute(page, async (route, query) => {
    queries.push(query);
    if (refreshed) {
      await route.fulfill({
        json: connectionPage(
          query.direction,
          query.direction === 'outgoing'
            ? [
                foreignConnection('test-refreshed', 'outgoing', {
                  to_agent_name: 'Replacement peer',
                }),
              ]
            : [],
        ),
      });
      return;
    }
    if (!query.before) {
      const unrelatedConnection = foreignConnection(
        `test-unrelated-${query.direction}`,
        query.direction,
        {
          from_agent_id: unrelated.id,
          to_agent_id: unrelated.id,
        },
      );
      await route.fulfill({
        json: connectionPage(query.direction, [unrelatedConnection], cursors[query.direction]),
      });
      return;
    }
    if (query.direction === 'incoming' && query.before === cursors.incoming) {
      await route.fulfill({
        json: connectionPage(
          'incoming',
          [foreignConnection('test-paged-in-1', 'incoming')],
          lastIncomingCursor,
        ),
      });
    } else if (query.direction === 'outgoing' && query.before === cursors.outgoing) {
      await route.fulfill({
        json: connectionPage('outgoing', [foreignConnection('test-paged-out-1', 'outgoing')]),
      });
    } else if (query.direction === 'incoming' && query.before === lastIncomingCursor) {
      await route.fulfill({
        json: connectionPage('incoming', [
          foreignConnection('test-paged-in-1', 'incoming'),
          foreignConnection('test-paged-in-2', 'incoming', {
            from_agent_name: 'Last incoming peer',
          }),
        ]),
      });
    } else {
      await route.fulfill({
        status: 400,
        json: { error: 'The page cursor was not returned by this fixture.' },
      });
    }
  });
  await agentsPage(page);
  const panel = await permissions(await inspectAgent(page));
  const cross = crossRegion(panel);
  await readsSettled(panel);
  await expect(
    cross.getByRole('heading', { name: 'No matching approved connections in the loaded results' }),
  ).toBeVisible();
  await expect(cross).toContainText('More workspace connections are available to check.');
  const more = cross.getByRole('button', { name: 'Load more connections', exact: true });
  await more.click();
  await expect(foreignRows(panel)).toHaveCount(2);
  await readsSettled(panel);
  expect(queries).toHaveLength(4);
  expect(
    queries
      .slice(2)
      .map(({ direction, before }) => ({ direction, before }))
      .sort((a, b) => a.direction.localeCompare(b.direction)),
  ).toEqual([
    { direction: 'incoming', before: cursors.incoming },
    { direction: 'outgoing', before: cursors.outgoing },
  ]);
  await more.focus();
  await more.press('Enter');
  await expect(foreignRows(panel)).toHaveCount(3);
  await readsSettled(panel);
  expect(queries).toHaveLength(5);
  expect(queries[4].direction).toBe('incoming');
  expect(queries[4].before).toBe(lastIncomingCursor);
  await expect(more).toHaveCount(0);
  const refresh = cross.getByRole('button', { name: 'Refresh connections', exact: true });
  await expect(refresh).toBeFocused();
  await expect(cross).not.toContainText(
    /test-incoming-cursor|test-outgoing-cursor|total connections/i,
  );
  refreshed = true;
  await refresh.press('Enter');
  await expect(foreignRows(panel)).toHaveCount(1);
  await expect(foreignRows(panel)).toContainText('Replacement peer');
  await readsSettled(panel);
  expect(queries).toHaveLength(7);
  expect(queries.slice(5).map((query) => query.before)).toEqual([null, null]);
  for (const query of queries) {
    expect(query.params.get('status')).toBe('approved');
    expect(query.params.get('limit')).toBe('100');
  }
});

for (const failedDirection of ['incoming', 'outgoing'] as const) {
  test(`an initial ${failedDirection} approved read failure reports unavailable and Retry loads both directions`, async ({
    page,
  }) => {
    await fixture(page);
    let failed = true;
    const queries: ApprovedQuery[] = [];
    await approvedRoute(page, async (route, query) => {
      queries.push(query);
      if (failed && query.direction === failedDirection) {
        await route.fulfill({
          status: 503,
          json: { error: 'Approved connections are temporarily unavailable.' },
        });
      } else {
        await route.fulfill({
          json: connectionPage(query.direction, [
            foreignConnection(`test-recovered-${query.direction}`, query.direction),
          ]),
        });
      }
    });
    const writes = mutations(page);
    await agentsPage(page);
    const panel = await permissions(await inspectAgent(page));
    const cross = crossRegion(panel);
    await expect(cross.getByRole('alert')).toContainText(
      'Connections with other workspaces could not be loaded.',
    );
    await expect(cross.getByRole('status')).toHaveCount(0);
    await expect(
      cross.getByRole('heading', {
        name: 'No matching approved connections in the loaded results',
      }),
    ).toHaveCount(0);
    await expect(foreignRows(panel)).toHaveCount(0);
    await expect(
      panel.getByRole('list', { name: 'Workspace connections', exact: true }),
    ).toContainText(peer.name);
    const retry = cross.getByRole('button', { name: 'Retry connections', exact: true });
    await expect(retry).toHaveAttribute('aria-disabled', 'false');
    failed = false;
    await retry.click();
    await expect(foreignRows(panel)).toHaveCount(2);
    await readsSettled(panel);
    await expect(cross.getByRole('alert')).toHaveCount(0);
    expect(queries).toHaveLength(4);
    expect(
      queries
        .slice(2)
        .map((query) => query.direction)
        .sort(),
    ).toEqual(['incoming', 'outgoing']);
    expect(writes).toEqual([]);
  });
}

test('refresh announces pending work and keeps prior approved rows through failure until recovery', async ({
  page,
}) => {
  await fixture(page);
  let recovered = false;
  await approvedRoute(page, async (route, query) => {
    await route.fulfill({
      json: connectionPage(query.direction, [
        foreignConnection(
          `test-current-${query.direction}`,
          query.direction,
          recovered
            ? {
                from_agent_name: 'Recovered incoming peer',
                to_agent_name: 'Recovered outgoing peer',
              }
            : {},
        ),
      ]),
    });
  });
  await agentsPage(page);
  const panel = await permissions(await inspectAgent(page));
  await expect(foreignRows(panel)).toHaveCount(2);
  await readsSettled(panel);
  const held = await holdApprovedReads(
    page,
    () => true,
    (query) =>
      query.direction === 'incoming'
        ? { status: 503, json: { error: 'Approved connections are temporarily unavailable.' } }
        : { json: connectionPage('outgoing', []) },
  );
  const cross = crossRegion(panel);
  const refresh = cross.getByRole('button', { name: 'Refresh connections', exact: true });
  try {
    await refresh.click();
    await expect.poll(() => held.held.length, { timeout: 5_000 }).toBe(2);
    await expect(cross.getByRole('status')).toHaveText('Refreshing approved connections…');
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await expect(foreignRows(panel)).toHaveCount(2);
    await expect(foreignRows(panel).filter({ hasText: 'Remote requester' })).toBeVisible();
    await refresh.press('Enter');
    expect(held.held).toHaveLength(2);
  } finally {
    await held.finish();
  }
  await expect(cross.getByRole('alert')).toContainText(
    'Connections could not be refreshed. Showing previously loaded results; they may have changed.',
  );
  await expect(foreignRows(panel)).toHaveCount(2);
  await expect(foreignRows(panel).filter({ hasText: 'Remote provider' })).toBeVisible();
  await readsSettled(panel);
  recovered = true;
  await refresh.click();
  await expect(foreignRows(panel).filter({ hasText: 'Recovered incoming peer' })).toBeVisible();
  await expect(foreignRows(panel).filter({ hasText: 'Recovered outgoing peer' })).toBeVisible();
  await readsSettled(panel);
  await expect(cross.getByRole('alert')).toHaveCount(0);
  await expect(cross).not.toContainText(/Remote requester|Remote provider/);
});

test('leaving Permissions aborts held reads and their responses cannot enter another agent inspection', async ({
  page,
}) => {
  await fixture(page);
  await approvedRoute(page, async (route, query) => {
    await route.fulfill({
      json: connectionPage(query.direction, [
        foreignConnection(`test-peer-scope-${query.direction}`, query.direction, {
          from_agent_id: query.direction === 'outgoing' ? peer.id : 'test-peer-remote',
          to_agent_id: query.direction === 'incoming' ? peer.id : 'test-peer-remote',
          from_agent_name: 'Fresh peer connection',
          to_agent_name: 'Fresh peer connection',
        }),
      ]),
    });
  });
  const held = await holdApprovedReads(
    page,
    () => true,
    (query) => ({
      json: connectionPage(query.direction, [
        foreignConnection(`test-stale-${query.direction}`, query.direction, {
          from_agent_name: 'Stale inspected connection',
          to_agent_name: 'Stale inspected connection',
        }),
      ]),
    }),
  );
  let panel: Locator;
  try {
    await agentsPage(page);
    const original = await inspectAgent(page);
    panel = await permissions(original);
    await expect.poll(() => held.held.length, { timeout: 5_000 }).toBe(2);
    await expect(crossRegion(panel).getByRole('status')).toHaveText(
      'Loading approved connections…',
    );
    await original.getByRole('tab', { name: 'Runs', exact: true }).click();
    await expect(original.getByRole('tabpanel', { name: 'Runs', exact: true })).toBeVisible();
    await expect(original.locator('[role="tabpanel"][hidden] button')).toHaveCount(0);
    held.disarm();
    await original.getByRole('button', { name: 'Close dialog' }).click();
    panel = await permissions(await inspectAgent(page, peer.name));
    await expect(foreignRows(panel)).toHaveCount(2);
    await readsSettled(panel);
    await expect(crossRegion(panel)).toContainText('Fresh peer connection');
  } finally {
    await held.finish();
  }
  expect(held.held.map((entry) => entry.settlement.outcome)).toEqual(['failed', 'failed']);
  await expect(foreignRows(panel!)).toHaveCount(2);
  await expect(crossRegion(panel!)).not.toContainText('Stale inspected connection');
  await expect(crossRegion(panel!).getByRole('alert')).toHaveCount(0);
});

test('late responses from a closed inspection stay isolated after switching workspace, and new reads use its header', async ({
  page,
}) => {
  const personal = await fixture(page);
  const otherId = 'test-other-inspection-workspace';
  const other = { ...personal.operator, id: otherId, name: 'Other permission workspace' };
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { ...personal.operator, kind: 'owner', role: 'owner' },
          { ...other, kind: 'ai', role: 'co-owner' },
        ],
      },
    }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: {
        ...personal,
        operator:
          route.request().headers()['x-city-workspace'] === otherId ? other : personal.operator,
      },
    }),
  );
  await page.route('**/api/rooms', (route) => route.fulfill({ json: { rooms: [] } }));
  const queries: ApprovedQuery[] = [];
  await approvedRoute(page, async (route, query) => {
    queries.push(query);
    await route.fulfill({
      json: connectionPage(query.direction, [
        foreignConnection(`test-new-workspace-${query.direction}`, query.direction, {
          from_agent_name: 'Selected workspace remote agent',
          to_agent_name: 'Selected workspace remote agent',
        }),
      ]),
    });
  });
  const held = await holdApprovedReads(
    page,
    (query) => query.workspace === null,
    (query) => ({
      json: connectionPage(query.direction, [
        foreignConnection(`test-old-workspace-${query.direction}`, query.direction, {
          from_agent_name: 'Previous workspace remote agent',
          to_agent_name: 'Previous workspace remote agent',
        }),
      ]),
    }),
  );
  let panel: Locator;
  try {
    await agentsPage(page);
    const original = await inspectAgent(page);
    await permissions(original);
    await expect.poll(() => held.held.length, { timeout: 5_000 }).toBe(2);
    await original.getByRole('button', { name: 'Close dialog' }).click();
    const switched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/snapshot' &&
        response.request().headers()['x-city-workspace'] === otherId,
    );
    await (await workspaceSwitcher(page)).selectOption(otherId);
    await (await switched).finished();
    // The switch lands on the Network map, which reads the selected workspace's approved
    // cross-owner routes itself: one page per direction, under the new workspace's header.
    await expect(page.locator('.nm')).toBeVisible();
    await expect.poll(() => queries.length).toBe(2);
    expect(queries.every((query) => query.workspace === otherId)).toBe(true);
    queries.length = 0;
    await page
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'My agents', exact: true })
      .click();
    panel = await permissions(await inspectAgent(page));
    await expect(foreignRows(panel)).toHaveCount(2);
    await readsSettled(panel);
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.workspace === otherId)).toBe(true);
  } finally {
    await held.finish();
  }
  expect(held.held.map((entry) => entry.settlement.outcome)).toEqual(['failed', 'failed']);
  await expect(crossRegion(panel!)).toContainText('Selected workspace remote agent');
  await expect(crossRegion(panel!)).not.toContainText('Previous workspace remote agent');
  await expect(crossRegion(panel!).getByRole('alert')).toHaveCount(0);
});

for (const width of [360, 390, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`agent inspection fits ${width}px ${theme} with keyboard focus and readable long names`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      const longPeer = {
        ...peer,
        name: 'Synthetic research partner with a deliberately long descriptive name',
      };
      await fixture(page, {
        agents: [inspected, longPeer],
        jobs: [
          job(0),
          job(1, {
            requesterId: peer.id,
            providerId: inspected.id,
            status: 'queued',
            output: null,
          }),
        ],
        connections: [
          connection('test-edge-out', inspected.id, peer.id),
          connection('test-edge-in', peer.id, inspected.id),
        ],
      });
      await approvedRoute(page, async (route, query) => {
        await route.fulfill({
          json: connectionPage(query.direction, [
            foreignConnection(`test-visual-${query.direction}`, query.direction, {
              from_agent_name:
                'Remote research collaborator with a deliberately long descriptive name',
              to_agent_name:
                'Remote verification collaborator with a deliberately long descriptive name',
            }),
          ]),
        });
      });
      await agentsPage(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const dialog = await inspectAgent(page);
      for (const tabName of ['Runs', 'Permissions']) {
        const tab = dialog.getByRole('tab', { name: tabName, exact: true });
        await tab.click();
        await tab.focus();
        await expect(tab).toBeFocused();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        const panel = dialog.getByRole('tabpanel', { name: tabName, exact: true });
        await expect(panel).toBeVisible();
        if (tabName === 'Permissions') await readsSettled(panel);
        const action = panel.locator('button:not(:disabled)').first();
        await action.focus();
        await expect(action).toBeFocused();
        const actionBox = await action.boundingBox();
        expect(actionBox!.height).toBeGreaterThanOrEqual(workspaceTarget(width));
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        expect(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        // Reset focus-induced scrolling solely for a stable visual capture.
        await dialog.evaluate((element) =>
          element.scrollTo({ top: 0, left: 0, behavior: 'instant' }),
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
              requestAnimationFrame(() => resolve());
            }),
        );
        const captureName = `agent-inspection-${tabName.toLowerCase()}-${width}-${theme}`;
        const capturePath = testInfo.outputPath(`${captureName}.png`);
        await page.screenshot({ path: capturePath, fullPage: true });
        await testInfo.attach(captureName, {
          path: capturePath,
          contentType: 'image/png',
        });
        if (tabName === 'Permissions') {
          const cross = crossRegion(panel);
          await expect(foreignRows(panel)).toHaveCount(2);
          await cross.scrollIntoViewIfNeeded();
          const crossPath = testInfo.outputPath(
            `agent-inspection-cross-workspace-${width}-${theme}.png`,
          );
          await cross.screenshot({ path: crossPath });
          await testInfo.attach(`agent-inspection-cross-workspace-${width}-${theme}`, {
            path: crossPath,
            contentType: 'image/png',
          });
        }
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(card(page)).toBeFocused();
    });
  }
}

test('the Base tab lets the owner make a public agent a Base agent from this dialog too', async ({
  page,
}) => {
  await fixture(page, { agents: [{ ...inspected, visibility: 'public' }, peer, unrelated] });
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  await agentsPage(page);
  const dialog = await inspectAgent(page);
  await dialog.getByRole('tab', { name: 'Base', exact: true }).click();
  const panel = dialog.getByRole('tabpanel', { name: 'Base', exact: true });
  await expect(panel.getByLabel('Your wallet address')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Make it a Base agent' })).toBeVisible();
});
