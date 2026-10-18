import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, CityEvent, Snapshot } from '../shared/types';
import { openAddAgentDialog } from './my-agents-open';
import { workspaceTarget } from './workspace-density';

/*
 * My agents, Workspace v3 (docs/design/WORKSPACE_V3_ELRIC_AGENTS.md §2): the roster with Elric
 * pinned, the filter tabs, the detail panel and its tabs, and Remove with a typed name. The agent
 * list, rooms, requests and Elric's state are synthetic fixtures served through page.route.
 * MY_AGENTS_SHOTS=<dir> also saves the design-review screenshots there.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-03T12:00:00.000Z';
const REQUESTS = '/api/v2/connections/requests';

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: 'Synthetic fixture',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

const scout = agent('11111111-1111-4111-8111-111111111111', 'Research scout');
const writer = agent('22222222-2222-4222-8222-222222222222', 'Draft writer', {
  status: 'offline',
  mode: 'hosted',
  lastSeenAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
});
const held = agent('33333333-3333-4333-8333-333333333333', 'Held reviewer', { pausedAt: at });
const child = agent('44444444-4444-4444-8444-444444444444', 'Scout helper', {
  parentAgentId: scout.id,
  depth: 1,
});
const gone = agent('55555555-5555-4555-8555-555555555555', 'Retired agent', {
  status: 'revoked',
  revokedAt: at,
});
const elric = agent('88888888-8888-4888-8888-888888888888', 'Elric', { mode: 'hosted' });

function room(id: string, name: string) {
  return {
    id,
    slug: name,
    name,
    topic: '',
    role: 'host',
    closed: false,
    read_only: false,
    history: 'full',
    member_count: 2,
    member_cap: 50,
    latest_seq: 1,
    url: `/rooms/${name}`,
    created_at: at,
    closed_at: null,
    responders_allowed: true,
    auto_responders: [],
  };
}
const rooms = [
  room('aaaaaaa1-0000-4000-8000-000000000001', 'launch-week'),
  room('aaaaaaa1-0000-4000-8000-000000000002', 'design-review'),
  room('aaaaaaa1-0000-4000-8000-000000000003', 'support-desk'),
];
function member(who: Agent, role: 'host' | 'member', messagesToday: number) {
  return {
    ...who,
    kind: 'agent',
    role,
    owner_label: 'You',
    own: true,
    joined_at: at,
    status: 'active',
    messages_today: messagesToday,
  };
}
const members: Record<string, unknown[]> = {
  [rooms[0]!.id]: [member(scout, 'member', 3), member(elric, 'member', 1)],
  [rooms[1]!.id]: [member(scout, 'host', 2), member(child, 'member', 0)],
  [rooms[2]!.id]: [member(scout, 'member', 1)],
};

function pending(): ConnectionRequest {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    direction: 'incoming',
    status: 'pending',
    from_agent_id: '77777777-7777-4777-8777-777777777777',
    from_agent_name: 'Agent Horizon',
    from_owner_label: 'Account 4a12b8c9',
    to_agent_id: scout.id,
    to_agent_name: scout.name,
    note: '',
    requested_at: at,
    expires_at: new Date(Date.now() + 5 * 86_400_000 + 60_000).toISOString(),
    decided_at: null,
    revoked_at: null,
  };
}

function event(id: string, message: string, minutesAgo: number): CityEvent {
  return {
    id,
    type: 'agent.event',
    message,
    agentId: scout.id,
    jobId: null,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

async function fixture(
  page: Page,
  options: { elric?: 'active' | 'paused'; elricPending?: number } = {},
) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `My-agents-v3-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const snapshot: Snapshot = {
    ...baseline,
    agents: [elric, scout, writer, held, child, gone],
    events: [
      event('e1', 'Research scout posted in launch-week.', 2),
      event('e2', 'Research scout connected.', 90),
      ...baseline.events,
    ],
  };
  const calls: string[] = [];
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { rooms } }) : route.fallback(),
  );
  await page.route('**/api/rooms/*/members*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    return route.fulfill({ json: { room_id: id, members: members[id] ?? [] } });
  });
  await page.route('**/api/rooms/*/leave', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    const body = route.request().postDataJSON() as { agent_id: string };
    calls.push(`leave ${id} ${body.agent_id}`);
    return route.fulfill({ json: { left: true } });
  });
  await page.route(`**${REQUESTS}**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/decide')) {
      calls.push(`decide ${(request.postDataJSON() as { decision: string }).decision}`);
      return route.fulfill({ json: { ok: true } });
    }
    const direction = new URL(request.url()).searchParams.get('direction');
    const status = new URL(request.url()).searchParams.get('status');
    return route.fulfill({
      json: {
        incoming: direction === 'incoming' && status === 'pending' ? [pending()] : [],
        outgoing: [],
        next_before: null,
      },
    });
  });
  await page.route('**/api/agents/*/totals', (route) =>
    route.fulfill({ json: { tasks_done: 1234, messages_sent: 56789 } }),
  );
  await page.route(/\/api\/agents\/[^/]+\/(pause|resume)$/, (route) => {
    const [, , , id, action] = new URL(route.request().url()).pathname.split('/');
    calls.push(`${action} ${id}`);
    return route.fulfill({ json: { agent: {}, changed: true } });
  });
  await page.route('**/api/agents/*/revoke', (route) => {
    calls.push(`revoke ${new URL(route.request().url()).pathname.split('/')[3]}`);
    return route.fulfill({ json: { ok: true } });
  });
  const none = { short: 0, summary: 0, tool: 0 };
  const waiting = Array.from({ length: options.elricPending ?? 0 }, (_, index) => ({
    id: `pending-${index + 1}`,
    tool: 'room_task_create',
    summary: `Create task ${index + 1}`,
    args_hash: 'hash',
    room: null,
    created_at: at,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  await page.route('**/api/elric**', (route) => {
    const path = new URL(route.request().url()).pathname;
    // Pause and resume (POST /api/elric/pause, /resume): recorded, answered like the server.
    if (route.request().method() === 'POST') calls.push(`elric ${path.split('/').pop()}`);
    return route.fulfill({
      json:
        path === '/api/elric'
          ? {
              agent_id: elric.id,
              status: options.elric ?? 'active',
              eligible: true,
              host_may_invoke: false,
              usage: { used: none, allowance: none, resets_at: at },
            }
          : path === '/api/elric/pending'
            ? { pending: waiting }
            : { turns: [], next_cursor: null },
    });
  });
  return calls;
}

async function openMyAgents(page: Page, theme = 'light') {
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  const region = page.getByRole('region', { name: 'Agents', exact: true });
  await expect(region).toBeVisible();
  const rows = region.getByRole('list', { name: 'Agents', exact: true }).getByRole('listitem');
  await expect(rows.filter({ hasText: 'Research scout' })).toHaveCount(1);
  return { region, rows };
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  await page.screenshot({
    path: dir ? `${dir}/build-${name}.png` : test.info().outputPath(`${name}.png`),
  });
}

const views = [
  { width: 1440, height: 900, theme: 'light' },
  { width: 1440, height: 900, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dark' },
];

for (const view of views)
  test(`roster: Elric pinned first, real counts and rooms at ${view.width}px ${view.theme}`, async ({
    page,
  }) => {
    await page.setViewportSize(view);
    await fixture(page);
    const { region, rows } = await openMyAgents(page, view.theme);
    // One quiet header: "Agents" and the online count (Elric on, 2 agents online).
    await expect(
      region.getByRole('heading', { level: 1, name: 'My agents', exact: true }),
    ).toBeVisible();
    await expect(region.locator('.ma4-title')).toContainText('3 online');
    // Elric first and built in; the removed agent last, under "Removed".
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText('Elric');
    await expect(rows.first()).toContainText('Built in');
    await expect(rows.last()).toContainText('Retired agent');
    await expect(rows.last()).toContainText('Removed');
    await expect(region).not.toContainText('Hosted by Central City');
    // No invented model names, no table header, no filter tabs, no row actions.
    await expect(region).not.toContainText(/self-reported|GPT|Claude/);
    await expect(region.locator('.ma3-head')).toHaveCount(0);
    await expect(region.getByRole('group', { name: 'Filter agents by status' })).toHaveCount(0);
    const row = rows.filter({ hasText: 'Research scout' });
    await expect(row.getByRole('button')).toHaveCount(1);
    await expect(row).toContainText('Active now');
    // Requests: one icon with the real pending count in its name.
    await expect(region.getByRole('button', { name: 'Requests, 1 pending' })).toBeVisible();
    const desktop = view.width > 900;
    if (desktop) {
      // The detail side is never blank: the first agent opens on arrival.
      await expect(page.getByRole('complementary', { name: /details$/ })).toBeVisible();
    } else {
      // Phone: the list only; an agent opens full screen.
      await expect(page.getByRole('complementary', { name: /details$/ })).toHaveCount(0);
      for (const button of await region.getByRole('button').all()) {
        if (!(await button.isVisible())) continue;
        const box = (await button.boundingBox())!;
        expect(Math.round(box.height), await button.innerText()).toBeGreaterThanOrEqual(
          workspaceTarget(view.width),
        );
      }
      await region.getByRole('button', { name: 'Search agents' }).click();
      const fontSize = await region
        .getByRole('textbox', { name: 'Search agents' })
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, `roster-${view.width}-${view.theme}`);
  });

test('search narrows the list; removed agents sit under Removed', async ({ page }) => {
  await fixture(page);
  const { region, rows } = await openMyAgents(page);
  await expect(rows).toHaveCount(6);
  await expect(region.getByText('Removed', { exact: true })).toBeVisible();
  // On a wide screen the first agent is open beside the list; searching leaves it open.
  const detail = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(detail).toBeVisible();
  await region.getByRole('button', { name: 'Search agents' }).click();
  const field = region.getByRole('textbox', { name: 'Search agents' });
  await expect(field).toBeFocused();
  await field.fill('draft');
  await expect(rows).toHaveCount(1);
  // A search shows live agents only; the Removed group belongs to the full list.
  await field.fill('retired');
  await expect(region.getByText('Removed', { exact: true })).toHaveCount(0);
  await field.fill('no-such-agent');
  await expect(region.getByRole('status')).toContainText('No agent called “no-such-agent”.');
  // Escape clears the search, shows everyone again and returns focus to Search.
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(region.getByRole('button', { name: 'Search agents' })).toBeFocused();
  await expect(rows).toHaveCount(6);
  // That Escape belonged to the search: the open agent stays open.
  await expect(detail).toBeVisible();
});

test('phone: Tab stays in the open agent; crossing 900px frees and locks the list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const { rows } = await openMyAgents(page);
  const locked = () =>
    page.evaluate(() => ({
      inert: document.querySelector<HTMLElement>('.ma4-list')?.inert ?? false,
      header: document.querySelector<HTMLElement>('.cc-app-header')?.inert ?? false,
      overflow: document.body.style.overflow,
    }));
  await rows.getByRole('button', { name: 'Research scout, Active now', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(panel.getByRole('heading', { level: 2, name: 'Research scout' })).toBeFocused();
  expect(await locked()).toEqual({ inert: true, header: true, overflow: 'hidden' });
  // One back link at a time: a pushed screen's own back link replaces "‹ Agents".
  const toList = page.getByRole('button', { name: 'Agents', exact: true });
  await expect(toList).toBeVisible();
  await panel.getByRole('button', { name: /^Rooms/ }).click();
  await expect(toList).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Research scout', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toList).toBeVisible();
  // Tab never reaches what the agent covers: the list, or the app header's menu button.
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press('Tab');
    const hidden = await page.evaluate(() => {
      const el = document.activeElement;
      return Boolean(el?.closest('.ma4-list, .cc-app-header'));
    });
    expect(hidden).toBe(false);
  }
  // Wider than 900px: the list sits beside the agent again, usable, and the page scrolls.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(locked).toEqual({ inert: false, header: false, overflow: '' });
  await rows.getByRole('button', { name: /^Draft writer/ }).click();
  await expect(page.getByRole('complementary', { name: 'Draft writer details' })).toBeVisible();
  // Narrower again: the agent covers the list, which is locked once more.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(locked).toEqual({ inert: true, header: true, overflow: 'hidden' });
});

test('a paused Elric stays pinned, says Paused and resumes from its detail', async ({ page }) => {
  const calls = await fixture(page, { elric: 'paused' });
  const { rows } = await openMyAgents(page);
  await expect(rows.first()).toContainText('Elric');
  await expect(rows.first()).toContainText('Paused · Built in');
  await rows.first().getByRole('button', { name: 'Elric, Paused · Built in', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Elric details' });
  await expect(panel).toContainText('Paused · Built in');
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByText('Elric is on again.')).toBeVisible();
  // The pane and the row follow at once; focus stays on the button, which now says Pause.
  await expect(panel).toContainText('On · Built in');
  await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
  await expect(rows.first()).not.toContainText('Paused');
  expect(calls).toEqual(['elric resume']);
});

for (const view of views.filter((item) => item.theme === 'light'))
  test(`a row opens the agent's detail at ${view.width}px`, async ({ page }) => {
    await page.setViewportSize(view);
    await fixture(page);
    const { rows } = await openMyAgents(page);
    const trigger = rows
      .filter({ hasText: 'Research scout' })
      .getByRole('button', { name: 'Research scout, Active now', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('complementary', { name: 'Research scout details' });
    await expect(panel).toBeVisible();
    // A small header: the name (focused) and one line, no tabs.
    await expect(panel.getByRole('heading', { level: 2, name: 'Research scout' })).toBeFocused();
    await expect(panel).toContainText('Active now · Runs on your computer');
    await expect(panel.getByRole('tab')).toHaveCount(0);
    // Message <name> · Pause · ⋯, then the three groups; values only from real data (3 rooms).
    for (const name of ['Message Research scout', 'Pause'])
      await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
    for (const name of ['Base', 'Messages', 'Activity', 'Auto-reply', 'Permissions'])
      await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Rooms/ })).toContainText('3');
    if (view.width > 900) await shot(page, `detail-${view.width}-${view.theme}`);
    // ⋯: Rename, Developer details, then (after a separator) Remove agent.
    await panel.getByRole('button', { name: 'More for Research scout' }).click();
    const menu = panel.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Rename',
      'Developer details',
      'Remove agent',
    ]);
    await expect(menu.locator('hr')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // Escape on the home screen closes the detail; focus returns to the row.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

test('focus follows the screens: the opened title, then back to what opened it', async ({
  page,
}) => {
  await fixture(page);
  const { rows } = await openMyAgents(page);
  await rows.getByRole('button', { name: 'Research scout, Active now', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  const name = panel.getByRole('heading', { level: 2, name: 'Research scout' });
  await expect(name).toBeFocused();
  // A row opens its screen with focus on the screen's title; Escape comes back to that row.
  await panel.getByRole('button', { name: /^Rooms/ }).click();
  await expect(panel.getByRole('heading', { name: 'Rooms', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: /^Rooms/ })).toBeFocused();
  // The same from the keyboard, on the Messages row (the agent's inbox; Message opens a chat).
  await panel.getByRole('button', { name: /^Messages/ }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { name: 'Messages', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: /^Messages/ })).toBeFocused();
  // A screen that focuses its own field keeps it; back from there returns to ⋯.
  await panel.getByRole('button', { name: 'More for Research scout' }).click();
  await panel.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(panel.getByRole('textbox')).toBeFocused();
  await panel.getByRole('button', { name: 'Research scout', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'More for Research scout' })).toBeFocused();
});

/** A dark button's label (or glyph) has its own colour, never the button's. */
async function inkDiffers(button: import('@playwright/test').Locator) {
  const [ink, fill] = await button.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.color, style.backgroundColor];
  });
  expect(ink).not.toBe(fill);
}

for (const view of views.filter((item) => item.theme === 'light'))
  test(`an unread chip in Messages opens that agent's Messages in My agents at ${view.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(view);
    await fixture(page);
    // Unread waits for Draft writer, not the first agent (which a wide screen opens on its own).
    await page.route('**/api/messages/summary', (route) =>
      route.fulfill({
        json: { inboxes: [{ agent_id: writer.id, latest_seq: 2, acked_seq: 0, unread: 2 }] },
      }),
    );
    await page.goto('/?workspace=v2&theme=light#connect');
    await expect(page.locator('.app-shell')).toBeVisible();
    const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: /^Messages/ })
      .first()
      .click();
    await page
      .getByLabel('Agents with unread messages')
      .getByRole('button', { name: /^Draft writer/ })
      .click();
    // My agents, the agent's pane on its Messages (no agent dialog), focus on the screen's title.
    await expect(page.getByRole('region', { name: 'Agents', exact: true })).toBeVisible();
    const panel = page.getByRole('complementary', { name: 'Draft writer details' });
    await expect(panel.getByRole('heading', { name: 'Messages', exact: true })).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Back lands on the agent's home, on its Messages row.
    await page.keyboard.press('Escape');
    await expect(panel.getByRole('heading', { level: 2, name: 'Draft writer' })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Messages/ })).toBeFocused();
    // Another agent from the list opens on its home, not on Messages.
    if (view.width > 900) {
      await page
        .getByRole('list', { name: 'Agents', exact: true })
        .getByRole('button', { name: 'Research scout, Active now', exact: true })
        .click();
      const other = page.getByRole('complementary', { name: 'Research scout details' });
      await expect(other.getByRole('heading', { level: 2, name: 'Research scout' })).toBeFocused();
    }
  });

test('with no room shared, Messages says so and offers Add to a room', async ({ page }) => {
  await fixture(page);
  await page.route(`**/api/messages/conversations?agent_id=${scout.id}&limit=100`, (route) =>
    route.fulfill({ json: { conversations: [] } }),
  );
  await page.route('**/api/messages/recipients*', (route) =>
    route.fulfill({ json: { recipients: [] } }),
  );
  const { rows } = await openMyAgents(page);
  await rows.getByRole('button', { name: 'Research scout, Active now', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await panel.getByRole('button', { name: /^Messages/ }).click();
  await expect(panel).toContainText('No messages yet');
  await expect(panel).toContainText("Research scout isn't in a room with you yet.");
  await expect(panel.getByRole('button', { name: 'New message' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add to a room', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Add to a room', exact: true })).toBeVisible();
});

test('a full thread page still marks a new arrival read and shows it', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  // A thread of exactly one page (50): a new message pushes the oldest off, the length stays 50.
  const message = (n: number) => ({
    origin: 'internal',
    from_owner_label: null,
    id: `msg_${String(n).padStart(3, '0')}`,
    seq: n,
    kind: 'message',
    from_agent_id: 'peer-agent',
    from_agent_name: 'Peer',
    to_agent_id: scout.id,
    to_agent_name: scout.name,
    context_id: 'ctx_full',
    reply_to: null,
    parts: [{ type: 'text', text: `Note ${n}.` }],
    created_at: new Date(Date.parse(at) + n * 1000).toISOString(),
  });
  let newest = 50;
  await page.route(`**/api/messages/conversations?agent_id=${scout.id}&limit=100`, (route) =>
    route.fulfill({
      json: {
        conversations: [
          {
            context_id: 'ctx_full',
            message_count: newest,
            participants: [scout.id, 'peer-agent'],
            last_message: message(newest),
            unread: 1,
            unread_capped: false,
          },
        ],
      },
    }),
  );
  await page.route('**/api/messages/conversations/ctx_full?*', (route) =>
    route.fulfill({
      json: { messages: Array.from({ length: 50 }, (_, index) => message(newest - 49 + index)) },
    }),
  );
  const reads: number[] = [];
  await page.route('**/api/messages/direct/ctx_full/read', (route) => {
    reads.push(newest);
    return route.fulfill({ json: { ok: true } });
  });
  const { rows } = await openMyAgents(page);
  await rows.getByRole('button', { name: 'Research scout, Active now', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await panel.getByRole('button', { name: /^Messages/ }).click();
  await panel.getByRole('button', { name: /^Peer/ }).click();
  // Each message: its text, then its time (which may start with a digit, as in '3. Okt.'); the
  // period ends the number whatever the locale.
  const note = (n: number) =>
    panel.locator('.amr4-bub').filter({ hasText: new RegExp(`^Note ${n}\\.`) });
  await expect(note(50)).toBeInViewport();
  await panel.getByRole('textbox').fill('Hello');
  await inkDiffers(panel.getByRole('button', { name: 'Send', exact: true }));
  await expect.poll(() => reads).toEqual([50]);
  // Message 51 arrives on the next read: it is marked read and scrolled into view.
  newest = 51;
  await page.clock.fastForward(10_500);
  await expect(note(51)).toBeInViewport();
  await expect(note(1)).toHaveCount(0);
  await expect.poll(() => reads).toEqual([50, 51]);
});

test('Activity names agents and rooms, never their IDs', async ({ page }) => {
  await fixture(page);
  // The lines production showed with raw IDs: another owner's agent, a deleted room, and one of
  // the owner's own agents in a room the owner sees.
  const other = 'e9764f84-3b1a-4c2e-9d7f-1a2b3c4d5e6f';
  const deleted = '89c1fa37-5d2e-4f1a-8b3c-6d7e8f9a0b1c';
  const line = (id: string, text: string, minutesAgo: number) => ({
    kind: 'event',
    id,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    type: 'room.event',
    text,
    jobId: null,
  });
  await page.route(`**/api/agents/${scout.id}/activity*`, (route) =>
    route.fulfill({
      json: {
        items: [
          line(
            'a1',
            `Agent ${other} of another owner joined your room ${rooms[0]!.id} with its invite link.`,
            5,
          ),
          line(
            'a2',
            `Room ${deleted} deleted by the owner: its messages, tasks and files are erased and every link is revoked.`,
            6,
          ),
          line('a3', `Agent ${child.id} removed from room ${rooms[1]!.id} by the owner.`, 7),
        ],
        nextBefore: null,
      },
    }),
  );
  const { rows } = await openMyAgents(page);
  await rows.getByRole('button', { name: 'Research scout, Active now', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await panel.getByRole('button', { name: /^Activity/ }).click();
  await expect(panel.getByRole('listitem').locator('b')).toHaveText([
    'An agent of another owner joined your room launch-week with its invite link.',
    'A room deleted by the owner: its messages, tasks and files are erased and every link is revoked.',
    'Scout helper removed from room design-review by the owner.',
  ]);
  expect(await panel.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

for (const view of views.filter((item) => item.theme === 'light'))
  test(`every screen puts its back link and title in the same place at ${view.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(view);
    await fixture(page);
    const { rows } = await openMyAgents(page);
    await rows.getByRole('button', { name: 'Research scout, Active now', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Research scout details' });
    const back = panel.getByRole('button', { name: 'Research scout', exact: true });
    const place = async (title: string) => {
      const heading = panel.getByRole('heading', { name: title, exact: true });
      await expect(heading).toBeVisible();
      await page.waitForTimeout(250); // the screen's 0.18 s slide-in
      const [b, h] = [await back.boundingBox(), await heading.boundingBox()];
      return { backX: b!.x, backY: b!.y, titleX: h!.x, titleY: h!.y };
    };
    // One of each frame: the pane's own (Auto-reply), Messages and Rooms', and Base's.
    const seen: Record<string, Awaited<ReturnType<typeof place>>> = {};
    for (const [row, title] of [
      [/^Auto-reply/, 'Auto-reply'],
      [/^Rooms/, 'Rooms'],
      [/^Base/, 'Base'],
    ] as const) {
      await panel.getByRole('button', { name: row }).click();
      seen[title] = await place(title);
      await page.keyboard.press('Escape');
    }
    // And one button size everywhere (Rooms' small pill): Rooms' action matches the home's Message.
    const message = await panel
      .getByRole('button', { name: 'Message Research scout', exact: true })
      .boundingBox();
    await panel.getByRole('button', { name: /^Rooms/ }).click();
    const add = await panel.getByRole('button', { name: /Add to a room/ }).boundingBox();
    expect(Math.abs(add!.height - message!.height)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    const first = seen['Auto-reply']!;
    for (const [title, at] of Object.entries(seen)) {
      for (const key of ['backX', 'titleX', 'backY', 'titleY'] as const)
        expect(Math.abs(at[key] - first[key]), `${title} ${key}`).toBeLessThanOrEqual(1.5);
    }
  });

test('a hosted agent says how it runs', async ({ page }) => {
  await fixture(page);
  const { rows } = await openMyAgents(page);
  await rows
    .filter({ hasText: 'Draft writer' })
    .getByRole('button', { name: /^Draft writer, / })
    .click();
  const panel = page.getByRole('complementary', { name: 'Draft writer details' });
  await expect(panel).toContainText('Template agent');
});

for (const view of views.filter((item) => item.theme === 'light'))
  test(`Remove asks for the agent's exact name at ${view.width}px`, async ({ page }) => {
    await page.setViewportSize(view);
    const calls = await fixture(page);
    const { rows } = await openMyAgents(page);
    await rows
      .filter({ hasText: 'Research scout' })
      .getByRole('button', { name: 'Research scout, Active now', exact: true })
      .click();
    const panel = page.getByRole('complementary', { name: 'Research scout details' });
    await panel.getByRole('button', { name: 'More for Research scout' }).click();
    await panel.getByRole('menuitem', { name: 'Remove agent' }).click();
    // A screen inside the pane: what goes, the sub-agent that goes with it, the typed name.
    await expect(panel.getByRole('heading', { name: 'Remove Research scout' })).toBeVisible();
    await expect(panel).toContainText('It leaves every room and its key stops working.');
    await expect(panel).toContainText('Messages stay.');
    await expect(panel).toContainText('1 agent created under it goes too: Scout helper.');
    const field = panel.getByRole('textbox', { name: 'Type Research scout to confirm' });
    const confirm = panel.getByRole('button', { name: 'Remove agent', exact: true });
    await expect(field).toBeFocused();
    await expect(confirm).toBeDisabled();
    await field.fill('Research');
    await expect(confirm).toBeDisabled();
    await field.press('Enter');
    expect(calls).toEqual([]);
    // Escape goes back to the agent, not out of the pane.
    await page.keyboard.press('Escape');
    await expect(panel.getByRole('heading', { level: 2, name: 'Research scout' })).toBeVisible();
    await panel.getByRole('button', { name: 'More for Research scout' }).click();
    await panel.getByRole('menuitem', { name: 'Remove agent' }).click();
    await field.fill('Research scout');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText('Research scout was removed.')).toBeVisible();
    expect(calls).toEqual([`revoke ${scout.id}`]);
  });

test('a refused Remove stays on the Remove screen and says why', async ({ page }) => {
  const calls = await fixture(page);
  // Registered after the fixture's revoke route, so it answers first.
  await page.route('**/api/agents/*/revoke', (route) => {
    calls.push('revoke refused');
    return route.fulfill({
      status: 409,
      json: { error: 'This agent cannot be removed right now.' },
    });
  });
  const { rows } = await openMyAgents(page);
  await rows
    .filter({ hasText: 'Research scout' })
    .getByRole('button', { name: 'Research scout, Active now', exact: true })
    .click();
  const panel = page.getByRole('complementary', { name: 'Research scout details' });
  await panel.getByRole('button', { name: 'More for Research scout' }).click();
  await panel.getByRole('menuitem', { name: 'Remove agent' }).click();
  const field = panel.getByRole('textbox', { name: 'Type Research scout to confirm' });
  await field.fill('Research scout');
  await panel.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('This agent cannot be removed right now.');
  // Still on Remove, the typed name kept, the agent not reported as removed.
  await expect(panel.getByRole('heading', { name: 'Remove Research scout' })).toBeVisible();
  await expect(field).toHaveValue('Research scout');
  await expect(page.getByText('Research scout was removed.')).toHaveCount(0);
  expect(calls).toEqual(['revoke refused']);
  // Another try goes out again (nothing stuck busy).
  await panel.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
});

test('Pause / Resume one agent from its detail', async ({ page }) => {
  const calls = await fixture(page);
  const { rows } = await openMyAgents(page);
  // Rows carry no actions: pausing happens in the open agent.
  await expect(rows.getByRole('button', { name: /^(Pause|Resume) / })).toHaveCount(0);
  await rows
    .filter({ hasText: 'Draft writer' })
    .getByRole('button', { name: /^Draft writer, / })
    .click();
  const panel = page.getByRole('complementary', { name: 'Draft writer details' });
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Draft writer is paused.')).toBeVisible();
  expect(calls).toEqual([`pause ${writer.id}`]);
});

test('Elric’s row opens Elric’s detail and focus comes back', async ({ page }) => {
  const calls = await fixture(page, { elricPending: 2 });
  const { rows } = await openMyAgents(page);
  const trigger = rows.first().getByRole('button', { name: 'Elric, Built in', exact: true });
  // One control on the row, as on every other row.
  await expect(rows.first().getByRole('button')).toHaveCount(1);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(rows.first()).toHaveAttribute('data-open', 'true');
  const panel = page.getByRole('complementary', { name: 'Elric details' });
  // The header: Elric's name (focused) and its state; then Chat · Pause.
  await expect(panel.getByRole('heading', { level: 2, name: 'Elric' })).toBeFocused();
  await expect(panel).toContainText('On · Built in');
  for (const name of ['Chat', 'Pause'])
    await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
  // Real values only: 2 approvals waiting (GET /api/elric/pending); no chat history is served
  // here, so Chats and Settings show no value.
  await expect(panel.getByRole('button', { name: /^Approvals/ })).toContainText('2');
  await expect(panel.getByRole('button', { name: /^Chats/ })).toHaveText('Chats');
  await expect(panel.getByRole('button', { name: /^Settings/ })).toHaveText('Settings');
  // Elric is never removed or rotated from here: no ⋯ menu, no Remove, no rotate.
  await expect(panel.getByRole('button', { name: /Remove|Rotate|More for/ })).toHaveCount(0);
  await shot(page, 'elric-detail-1440-light');
  // Settings opens Manage Elric over the pane; Escape closes the sheet first, then the pane.
  const settings = panel.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  const sheet = page.getByRole('dialog', { name: 'Manage Elric' });
  await expect(sheet.getByRole('button', { name: 'Pause Elric' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(settings).toBeFocused();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(calls).toEqual([]);
});

test('Elric’s detail pauses Elric and opens its approvals', async ({ page }) => {
  const calls = await fixture(page, { elricPending: 2 });
  const { rows } = await openMyAgents(page);
  await rows.first().getByRole('button', { name: 'Elric, Built in', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Elric details' });
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Elric is paused.')).toBeVisible();
  await expect(panel).toContainText('Paused · Built in');
  await expect(panel.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
  await expect(rows.first()).toContainText('Paused · Built in');
  expect(calls).toEqual(['elric pause']);
  // Approvals: the console's Elric view, where the waiting actions are approved.
  await panel.getByRole('button', { name: /^Approvals/ }).click();
  await expect(
    page.getByRole('list', { name: 'Waiting for your approval' }).getByRole('listitem'),
  ).toHaveCount(2);
});

test('Chat opens Elric’s chat on the Elric page', async ({ page }) => {
  await fixture(page);
  const { rows } = await openMyAgents(page);
  await rows.first().getByRole('button', { name: 'Elric, Built in', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Elric details' });
  await panel.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page).toHaveURL(/\/elric$/);
});

test('Requests opens the existing requests list', async ({ page }) => {
  const calls = await fixture(page);
  const { region } = await openMyAgents(page);
  const review = region.getByRole('button', { name: 'Requests, 1 pending' });
  await review.click();
  const sheet = page.getByRole('complementary', { name: 'Connection requests' });
  const list = sheet.getByRole('list', { name: 'Pending connection requests' });
  await expect(list).toContainText('Agent Horizon');
  await expect(list).toContainText('Account 4a12b8c9');
  await expect(list).toContainText('Expires in 5 days');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(review).toBeFocused();
  await review.click();
  await sheet
    .getByRole('button', { name: 'Approve connection request from Agent Horizon' })
    .click();
  await expect(page.getByText('Connection from Agent Horizon approved.')).toBeVisible();
  expect(calls).toEqual(['decide approve']);
});

test('a new template agent opens in its pane in My agents, not in a dialog', async ({ page }) => {
  // A real, empty workspace: the agent is created on the server and read back.
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `My-agents-v3-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Agents', exact: true })).toBeVisible();
  await openAddAgentDialog(page);
  const dialog = page.getByRole('dialog', { name: 'Add an agent.' });
  await expect(dialog.getByRole('button', { name: /^Use a template/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByLabel('Agent name', { exact: true }).fill('Template scout');
  await dialog.getByRole('button', { name: 'Add template agent', exact: true }).click();
  await expect(page.getByText('Template scout added to your workspace.')).toBeVisible();
  // The dialog closes and the new agent shows in the pane, focused on its name.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const panel = page.getByRole('complementary', { name: 'Template scout details' });
  await expect(panel.getByRole('heading', { level: 2, name: 'Template scout' })).toBeFocused();
  await expect(panel).toContainText('CC agent');
  await expect(
    page
      .getByRole('list', { name: 'Agents', exact: true })
      .getByRole('button', { name: /^Template scout, / }),
  ).toHaveAttribute('aria-expanded', 'true');
});

test('room invitations from the summary: the agent’s line and the sidebar say so', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/messages/summary', (route) =>
    route.fulfill({
      json: {
        inboxes: [],
        invitations: { [writer.id]: 2, [scout.id]: 0, unknown: 'x' },
      },
    }),
  );
  const { region } = await openMyAgents(page);
  const list = region.getByRole('list', { name: 'Agents', exact: true });
  const writerRow = list.getByRole('button', { name: /^Draft writer, .*2 invitation requests/ });
  await expect(writerRow).toBeVisible();
  // Like unread messages: the row's badge counts the open requests, so it stands out among many.
  await expect(writerRow.locator('.ma4-badge')).toHaveText('2');
  await expect(writerRow).toContainText('2 invitation requests');
  await expect(list.getByRole('button', { name: /^Research scout, / })).not.toContainText(
    'invitation',
  );
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  await expect(nav.getByRole('button', { name: 'My agents' })).toHaveAccessibleDescription(
    /2 room invitations/,
  );
});

test('a summary without invitations shows no invitation counts', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/messages/summary', (route) => route.fulfill({ json: { inboxes: [] } }));
  const { region } = await openMyAgents(page);
  await expect(region.getByText(/invitation request/)).toHaveCount(0);
});
