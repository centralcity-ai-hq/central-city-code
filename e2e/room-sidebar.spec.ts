import { test, expect, type Browser } from '@playwright/test';

/*
 * The room list in the workspace sidebar (docs/design/WORKSPACE_V3.md §3): Hosting and Joined
 * groups (labelled when both have rooms) with the active highlight; ended rooms wait behind
 * "Show ended rooms", which opens by itself for an ended room.
 */

const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function registerAccount(browser: Browser, label: string) {
  const context = await browser.newContext();
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { context, name, request: context.request, page: await context.newPage() };
}

async function createAgent(account: { request: any }, name: string) {
  const res = await account.request.post('/api/agents', {
    headers,
    data: { name, description: 'Test agent', capability: 'research', mode: 'external' },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  return data.agent.id as string;
}

async function createRoom(account: { request: any }, agentId: string, name: string) {
  const res = await account.request.post('/api/rooms', {
    headers,
    data: { agent_id: agentId, name, idempotency_key: crypto.randomUUID() },
  });
  expect(res.status()).toBe(201);
  const data = await res.json();
  return data.room as { id: string; slug: string; name: string };
}

test('room grouping: Hosting vs Joined vs Closed with accordion and active highlight', async ({
  browser,
}) => {
  const host = await registerAccount(browser, 'Host-User');
  const hostAgent = await createAgent(host, 'Host Agent');
  const hostedRoom = await createRoom(host, hostAgent, 'Hosted Space');

  // Another account creates a room and invites the host
  const other = await registerAccount(browser, 'Other-User');
  const otherAgent = await createAgent(other, 'Other Agent');
  const joinedRoom = await createRoom(other, otherAgent, 'Collaborative Hub');

  // Mint link and host joins
  const linkRes = await other.request.post(`/api/rooms/${joinedRoom.id}/link`, {
    headers,
    data: {},
  });
  expect(linkRes.status()).toBe(200);
  const { link } = await linkRes.json();
  const token = new URL(link).hash.slice(1);

  // Host joins joinedRoom
  const joinRes = await host.request.post(`/api/rooms/${joinedRoom.id}/join`, {
    headers,
    data: { token, create: { name: 'Host As Guest' }, idempotency_key: crypto.randomUUID() },
  });
  expect(joinRes.status()).toBe(200);

  // Host creates another room and closes it
  const closedRoom = await createRoom(host, hostAgent, 'Archived Discussion');
  const closeRes = await host.request.post(`/api/rooms/${closedRoom.id}/close`, {
    headers,
    data: {},
  });
  expect(closeRes.status()).toBe(200);

  // Navigate to hosted room
  await host.page.goto(`/rooms/${hostedRoom.id}`);
  const sidebar = host.page.locator('.sidebar').getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar).toBeVisible();

  // Verify groups
  await expect(sidebar.getByText('Hosting', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('Joined', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('list', { name: 'Hosting' }).getByRole('link')).toHaveText([
    'Hosted Space',
  ]);
  await expect(sidebar.getByRole('list', { name: 'Joined' }).getByRole('link')).toHaveText([
    'Collaborative Hub',
  ]);
  await expect(sidebar.getByRole('button', { name: 'Show ended rooms 1' })).toBeVisible();

  // Verify hosted room is active
  await expect(sidebar.getByRole('link', { name: 'Hosted Space' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Verify closed rooms accordion toggling
  const closedToggle = sidebar.getByRole('button', { name: /ended rooms/ });
  const closedLink = sidebar.getByRole('link', { name: /Archived Discussion/ });

  // Initially closed rooms list is collapsed
  await expect(closedLink).toBeHidden();

  // Click accordion toggle to expand
  await closedToggle.click();
  await expect(closedLink).toBeVisible();

  // Click again to collapse
  await closedToggle.click();
  await expect(closedLink).toBeHidden();

  // When visiting a closed room directly, accordion auto-expands
  await host.page.goto(`/rooms/${closedRoom.id}`);
  await expect(sidebar.getByRole('link', { name: /Archived Discussion/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Archived Discussion/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

/** GET /api/elric for an account that has not added Elric yet (the fields the app reads). */
const ELRIC_OFF_SHAPE = {
  agent_id: null,
  status: null,
  host_may_invoke: false,
  eligible: false,
  usage: {
    allowance: { short: 20, summary: 4, tool: 5 },
    used: { short: 0, summary: 0, tool: 0 },
    resets_at: new Date(Date.now() + 3_600_000).toISOString(),
  },
};

test('the sidebar lists rooms in the same order on every page: latest activity first', async ({
  browser,
}) => {
  const host = await registerAccount(browser, 'Order-User');
  const agent = await createAgent(host, 'Order Agent');
  const alpha = await createRoom(host, agent, 'Alpha room');
  await createRoom(host, agent, 'Beta room');
  const gamma = await createRoom(host, agent, 'Gamma room');
  // The oldest room has the newest message.
  const posted = await host.request.post(`/api/rooms/${alpha.id}/messages`, {
    headers,
    data: { text: 'Fresh news in the oldest room.', idempotency_key: crypto.randomUUID() },
  });
  expect(posted.ok()).toBeTruthy();
  const expected = ['Alpha room', 'Gamma room', 'Beta room'];
  const rows = host.page
    .locator('.sidebar')
    .getByRole('navigation', { name: 'Rooms' })
    .locator('a.ws-room');

  // A room page orders by activity.
  await host.page.goto(`/rooms/${gamma.id}`);
  await expect(rows).toHaveText(expected);
  // Another page in the app shows the same order: in-app, and after a reload.
  await host.page
    .locator('.sidebar')
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages/ })
    .click();
  await expect(
    host.page.getByRole('heading', { level: 1, name: 'Messages', exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveText(expected);
  await host.page.goto('/settings/account');
  await expect(rows).toHaveText(expected);
  // And the rooms overview agrees.
  await host.page.goto('/rooms');
  await expect(rows).toHaveText(expected);
});
