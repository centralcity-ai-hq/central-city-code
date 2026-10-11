import { test, expect, type Page } from '@playwright/test';
import {
  openAccountMenu,
  openAdvancedGroup,
  openSettingsSection,
  workspaceSwitcher,
} from './settings-nav';
import { workspaceTarget } from './workspace-density';
const headers = { 'x-city-request': '1' };
async function register(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `workspace-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

test('preview shell connects Rooms, console history, account actions and advanced work', async ({
  page,
}) => {
  await register(page);
  await page.goto('/?workspace=v2');
  await expect(page).toHaveURL(/\/rooms$/);
  await page.getByRole('link', { name: 'Skip to content', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#workspace-page-content')).toBeFocused();
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  await nav.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'My agents' }).click();
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  // The Account menu keeps Settings, Help and the account controls; the rest live in Settings.
  const accountMenu = await openAccountMenu(page);
  await expect(accountMenu.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(accountMenu.getByRole('link', { name: 'Help', exact: true })).toBeVisible();
  for (const name of ['Connected apps', 'Data & export', 'Activity log']) {
    await expect(accountMenu.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(accountMenu.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  await openSettingsSection(page, 'Connected apps');
  await expect(page.getByRole('heading', { name: 'Connected apps', exact: true })).toBeVisible();
  await openSettingsSection(page, 'Data & export');
  await expect(page.getByRole('heading', { name: 'Data & export', exact: true })).toBeVisible();
  await (
    await openAdvancedGroup(page)
  )
    .getByRole('button', { name: 'Research & review', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Research & review', exact: true })).toBeVisible();
  await (await openAccountMenu(page)).getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: 'Rooms', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
});

test('mobile navigation supports keyboard close, focus return and narrow layouts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);
  await page.goto('/?workspace=v2');
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  await opener.click();
  await expect(
    page.getByRole('button', { name: 'Close navigation', exact: true }).last(),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await opener.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Messages', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'work/workspace-phone.png' });
});

test('failed pending-request reads stay unavailable and retry reports the real count', async ({
  page,
}) => {
  await register(page);
  let unavailable = true;
  await page.route('**/api/v2/connections/requests', (route) =>
    route.fulfill({
      status: unavailable ? 503 : 200,
      json: unavailable
        ? { error: 'Unavailable' }
        : {
            incoming: [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }],
            outgoing: [],
          },
    }),
  );
  await page.goto('/?workspace=v2');
  await expect(page.getByText('Connection requests unavailable', { exact: false })).toBeVisible();
  expect(
    (await page
      .getByRole('button', { name: 'Retry connection requests', exact: true })
      .boundingBox())!.height,
  ).toBeGreaterThanOrEqual(workspaceTarget(page.viewportSize()!.width));
  unavailable = false;
  await page.getByRole('button', { name: 'Retry connection requests', exact: true }).click();
  const agents = page.getByRole('button', { name: 'My agents', exact: true });
  const badge = agents.locator('.wv2-pending');
  await expect(badge).toHaveText('2');
  // The badge never changes the entry's name; its words are the button's description.
  await expect(agents).toHaveAccessibleDescription('2 pending connection requests');
  await expect(page.locator('.wv2-request')).toHaveCount(0);
  // A filled accent circle, white on the same blue in both themes (WORKSPACE_V3.md §3).
  await expect(badge).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(badge).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.locator('html').evaluate((el) => el.setAttribute('data-theme', 'dark'));
  await expect(badge).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(badge).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: 'work/workspace-desktop.png' });
});

test('existing hash links work after the preview console mounts and unknown paths stay 404', async ({
  page,
}) => {
  await register(page);
  await page.goto('/?workspace=v2#connect');
  await expect(page.getByRole('heading', { name: 'Connect AI', exact: true })).toBeVisible();
  const claimToken = `ccclaim_${'a'.repeat(43)}`;
  await page.evaluate((token) => {
    location.hash = `#claim=${token}`;
  }, claimToken);
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible();
  await expect(page.getByLabel('Claim agents your AI created')).toHaveValue(claimToken);
  await page.goto('/settings/unknown');
  await expect(
    page.getByRole('heading', { name: 'This page doesn’t exist.', exact: true }),
  ).toBeVisible();
});

test('local room actions remain available in the shared desktop and phone shell', async ({
  page,
}) => {
  await register(page);
  await page.goto('/?workspace=v2');
  await expect(page.locator('.rm-app')).toHaveAttribute('data-embedded', 'true');
  await expect(
    page
      .getByRole('navigation', { name: 'Rooms', exact: true })
      .getByRole('link', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.rm-sidebar-brand-wrap')).toHaveCount(0);
  // The rooms app has no list column of its own: New room sits under Rooms in the sidebar.
  await expect(page.locator('.rm-sidebar')).toHaveCount(0);
  await page
    .locator('.sidebar')
    .getByRole('navigation', { name: 'Rooms', exact: true })
    .getByRole('button', { name: 'New room', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: 'work/workspace-desktop-dark.png' });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect.poll(async () => (await page.locator('.sidebar.open').boundingBox())?.x).toBe(0);
  await page.screenshot({ path: 'work/workspace-phone-nav-dark.png' });
  await page.keyboard.press('Escape');
  // One menu button on a phone: the room list page itself offers New room and Join a room.
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toHaveCount(0);
  const overview = page.locator('.rm-overview');
  await expect(overview.getByRole('button', { name: 'New room', exact: true })).toBeVisible();
  await overview.getByRole('button', { name: 'Join a room', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('switching workspaces remounts room shortcuts and never reuses another scope', async ({
  page,
}) => {
  await register(page);
  const session = await (await page.request.get('/api/session')).json();
  const owner = session.operator;
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: owner.id, name: owner.name, kind: 'owner', role: 'owner' },
          { id: 'test-other-workspace', name: 'Other test workspace', kind: 'ai', role: 'owner' },
        ],
      },
    }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        operator: route.request().headers()['x-city-workspace']
          ? { id: 'test-other-workspace', name: 'Other test workspace' }
          : owner,
      },
    }),
  );
  await page.route('**/api/rooms', (route) => route.fulfill({ json: { rooms: [] } }));
  await page.route('**/api/v2/connections/requests', (route) =>
    route.fulfill({
      json: {
        incoming: route.request().headers()['x-city-workspace'] ? [{ status: 'pending' }] : [],
        outgoing: [],
      },
    }),
  );
  await page.goto('/?workspace=v2');
  await (await workspaceSwitcher(page)).selectOption('test-other-workspace');
  await expect(page.getByText('AI workspace · you co-own it')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'My agents', exact: true }),
  ).toHaveAccessibleDescription('1 pending connection request');
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Messages', exact: true })
    .click();
  await (await workspaceSwitcher(page)).selectOption(owner.id);
  await expect(page.getByText('Private workspace', { exact: true })).toBeVisible();
  await expect(page.locator('.wv2-pending')).toHaveCount(0);
});

test('the account menu cycles the theme and signs out when Rooms is embedded', async ({ page }) => {
  await register(page);
  await page.goto('/?workspace=v2');
  await expect(page.locator('.rm-app')).toHaveAttribute('data-embedded', 'true');
  // The separate Account group is gone: the account card's menu holds its items.
  await expect(page.locator('.wv2-navigation summary')).toHaveCount(0);
  const menu = await openAccountMenu(page);
  await expect(menu.locator('a, button')).toHaveText([
    'Settings',
    'Help',
    /^Theme/,
    'Refresh',
    // The former workspace footer's control. Downtown and Open Source stay on the public
    // site's header and footer, not in the account menu.
    /^Pause workspace/,
    'Sign out',
  ]);
  const theme = menu.getByRole('button', { name: /^Theme: / });
  // Theme cycles System, Light, Dark and back, and shows the current choice.
  await expect(theme).toHaveAccessibleName('Theme: System');
  await theme.click();
  await expect(theme).toHaveAccessibleName('Theme: Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await theme.click();
  await expect(theme).toHaveAccessibleName('Theme: Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'work/account-menu-desktop-dark.png' });
  await theme.click();
  await expect(theme).toHaveAccessibleName('Theme: System');
  expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneMenu = await openAccountMenu(page);
  await expect(page.locator('.sidebar.open')).toBeVisible();
  await page.screenshot({ path: 'work/account-menu-phone-light.png' });
  await phoneMenu.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  const session = await (await page.request.get('/api/session')).json();
  expect(session.operator).toBeNull();
});

test('the account menu closes with Escape, and ADVANCED stays as the person left it', async ({
  page,
}) => {
  await register(page);
  await page.goto('/?workspace=v2');
  const card = page.getByRole('button', { name: /^Account: / });
  await card.click();
  const menu = page.getByRole('navigation', { name: 'Account', exact: true });
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  // The menu opens above the card.
  const menuBox = await menu.boundingBox();
  const cardBox = await card.boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(cardBox!.y);
  await menu.getByRole('link', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(card).toBeFocused();
  // A click outside closes it too.
  await card.click();
  await expect(menu).toBeVisible();
  await page.locator('#workspace-page-content').click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);

  const group = page.getByRole('button', { name: 'Advanced', exact: true });
  const advanced = page.getByRole('navigation', { name: 'Advanced', exact: true });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(advanced.getByRole('button')).toHaveText([
    'Research & review',
    'Agent permissions',
    'Network map',
  ]);
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(advanced).toBeHidden();
  await page.reload();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await group.click();
  await expect(advanced).toBeVisible();
});

test('Elric trailing-slash entry exposes the current page to assistive technology', async ({
  page,
}) => {
  await register(page);
  await page.route('**/api/elric', (route) =>
    route.fulfill({ json: { eligible: false, eligibility_reason: 'google_required' } }),
  );
  await page.goto('/elric/?workspace=v2');
  const elric = page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Elric', exact: true });
  await expect(elric).toHaveAttribute('aria-current', 'page');
  await expect(elric).toHaveClass(/active/);
});

test('preview activity exposes errors without a snapshot and data view survives reload', async ({
  page,
}) => {
  await register(page);
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 503, json: { error: 'Workspace unavailable' } }),
  );
  await page.goto('/?workspace=v2#connect');
  await openSettingsSection(page, 'Activity log');
  await expect(page.getByRole('heading', { name: 'Activity log', exact: true })).toBeVisible();
  const activity = page.getByRole('region', { name: 'Activity log', exact: true });
  await expect(activity.getByText('Activity couldn’t be loaded.')).toBeVisible();
  await expect(activity.getByRole('button', { name: 'Refresh activity' })).toBeEnabled();
  await openSettingsSection(page, 'Data & export');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Data & export', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your workspace records' })).toBeVisible();
});

test('private-message fragments open Messages on initial and same-document preview entries', async ({
  page,
}) => {
  await register(page);
  const opened: string[] = [];
  await page.route('**/api/rooms/*/direct', async (route) => {
    opened.push(route.request().url());
    await route.fulfill({ status: 404, json: { error: 'Private thread unavailable' } });
  });
  await page.goto('/?workspace=v2#dm=test-room.00000000-0000-4000-8000-000000000001');
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await expect.poll(() => opened.length).toBe(1);
  await page.getByRole('button', { name: 'My agents', exact: true }).click();
  await page.evaluate(() => {
    window.location.hash = 'dm=second-room.00000000-0000-4000-8000-000000000002';
  });
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await expect.poll(() => opened.some((url) => url.includes('/second-room/direct'))).toBe(true);
  await expect(page.getByText(/Couldn't open the private chat/)).toBeVisible();
});

test('preview claim links update an already open claim form and remove the secret fragment', async ({
  page,
}) => {
  await register(page);
  await page.goto('/?workspace=v2');
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  // My agents v4: the claim form opens from "Claim from a link".
  await page.getByRole('button', { name: 'Claim from a link' }).first().click();
  const input = page.getByLabel('Claim agents your AI created');
  await expect(input).toHaveValue('');
  for (const letter of ['a', 'b']) {
    const token = `ccclaim_${letter.repeat(43)}`;
    await page.goto(`/#claim=${token}`);
    await expect(input).toHaveValue(token);
    await expect(page).toHaveURL(/\/$/);
  }
});

test('Messages shows the unread count, and counts of one read in the singular', async ({
  page,
}) => {
  await register(page);
  let unread = 3;
  await page.route('**/api/messages/summary', (route) =>
    route.fulfill({
      json: {
        inboxes: [
          { agent_id: 'test-agent-one', latest_seq: 5, acked_seq: 5 - unread, unread },
          { agent_id: 'test-agent-two', latest_seq: 2, acked_seq: 2, unread: 0 },
        ],
      },
    }),
  );
  await page.route('**/api/v2/connections/requests', (route) =>
    route.fulfill({ json: { incoming: [{ status: 'pending' }], outgoing: [] } }),
  );
  await page.goto('/?workspace=v2');
  const messages = page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Messages', exact: true });
  await expect(messages).toHaveAccessibleDescription('3 unread messages');
  await expect(messages.locator('.nav-count')).toHaveText('3');
  await expect(
    page.getByRole('button', { name: 'My agents', exact: true }).locator('.wv2-pending'),
  ).toHaveText('1');
  unread = 1;
  await page.reload();
  await expect(messages).toHaveAccessibleDescription('1 unread message');
  await expect(messages.locator('.nav-count')).toHaveText('1');
  unread = 0;
  await page.reload();
  await expect(messages).toBeVisible();
  await expect(messages.locator('.nav-count')).toHaveCount(0);
});

test('preview inbox rows show room origin safely and preserve deleted-room fallback', async ({
  page,
}) => {
  await register(page);
  const roomNames = ['Research <script>alert(1)</script>', 'Deleted room'];
  await page.route('**/api/messages/conversations', (route) =>
    route.fulfill({
      json: {
        conversations: roomNames.map((room_name, i) => ({
          context_id: `room-dm-test-${i}`,
          message_count: 1,
          participants: ['test-self', 'test-peer'],
          last_message: {
            id: `message-${i}`,
            from_agent_id: 'test-peer',
            to_agent_id: 'test-self',
            context_id: `room-dm-test-${i}`,
            created_at: new Date().toISOString(),
            parts: [{ type: 'text', text: 'Private hello' }],
          },
          direct: {
            context_id: `room-dm-test-${i}`,
            room_id: `room-${i}`,
            room_name,
            self: { id: 'test-self', name: 'You', kind: 'person' },
            peer: { id: 'test-peer', name: 'Peer', kind: 'person' },
          },
        })),
      },
    }),
  );
  await page.goto('/?workspace=v2#connect');
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  const list = page.getByRole('navigation', { name: 'Conversations', exact: true });
  for (const name of roomNames)
    await expect(list.getByText(`From #${name}`, { exact: true })).toBeVisible();
  await expect(list.locator('script')).toHaveCount(0);
});

async function createRoom(page: Page, name: string) {
  const agent = await page.request.post('/api/agents', {
    headers,
    data: { name: 'Test host', capability: 'research', mode: 'hosted' },
  });
  expect(agent.ok()).toBe(true);
  const { agent: host } = await agent.json();
  const created = await page.request.post('/api/rooms', {
    headers,
    data: { agent_id: host.id, name, idempotency_key: crypto.randomUUID() },
  });
  expect(created.ok()).toBe(true);
  return (await created.json()).room as { id: string };
}

test('a phone shows one menu button in a room, and Rooms is reachable inside it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);
  const room = await createRoom(page, 'Phone menu room');
  await page.goto(`/rooms/${room.id}?workspace=v2`);
  await expect(page.getByRole('region', { name: 'Phone menu room' })).toBeVisible();
  const menus = page.getByRole('button', { name: /^Open (navigation|menu)$/ });
  await expect(menus.filter({ visible: true })).toHaveCount(1);
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(opener).toBeVisible();
  // One top bar: the ☰ chip sits in the room's own top bar, beside the room pill; the shell's
  // phone row steps aside on room pages (it is back on the rooms overview below).
  await expect(page.locator('header.cc-app-header')).toBeHidden();
  const roomBar = page.locator('.rm-room-head');
  await expect(roomBar.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
  const [chip, pill] = await Promise.all([
    opener.boundingBox(),
    roomBar.locator('.rm3-pill').boundingBox(),
  ]);
  expect(Math.abs(chip!.y + chip!.height / 2 - (pill!.y + pill!.height / 2))).toBeLessThanOrEqual(
    1,
  );
  expect(chip!.y).toBeLessThan(40);

  // The drawer traps focus, Escape closes it and focus returns to the button.
  await opener.click();
  const drawer = page.locator('.sidebar.open');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Close navigation', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate((aside) => aside.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await drawer.evaluate((aside) => aside.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar.open')).toHaveCount(0);
  await expect(opener).toBeFocused();

  // No per-device room shortcuts in the drawer: the room list sits under Rooms.
  await opener.click();
  await expect(page.getByRole('region', { name: 'Room shortcuts', exact: true })).toHaveCount(0);
  const current = drawer
    .getByRole('navigation', { name: 'Rooms', exact: true })
    .getByRole('link', { name: 'Phone menu room' });
  await expect(current).toHaveAttribute('aria-current', 'page');
  expect((await current.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Rooms', exact: true })
    .click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.locator('.sidebar.open')).toHaveCount(0);
  await expect(
    page
      .getByRole('list', { name: 'All rooms', exact: true })
      .getByRole('link', { name: /Phone menu room/ }),
  ).toBeVisible();
  await expect(menus.filter({ visible: true })).toHaveCount(1);
  await expect(page.locator('header.cc-app-header')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('preview page headings and tab titles match the menu labels', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  await page.goto('/?workspace=v2#connect');
  await expect(page.getByRole('heading', { name: 'Connect AI', exact: true })).toBeVisible();
  const advanced = await openAdvancedGroup(page);
  for (const label of ['Research & review', 'Agent permissions', 'Network map']) {
    await advanced.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
    // No header bar on desktop: the page's own h1 carries the title (the phone row keeps it).
    await expect(page.locator('header.cc-app-header')).toBeHidden();
    await expect(page.locator('.cc-app-header-title p')).toHaveText(label);
    await expect(page).toHaveTitle(`${label} · Central City`);
  }
  // Network map shows the map only; agents, activity and next steps have their own pages.
  await expect(page.getByRole('heading', { name: 'Agent map', exact: true })).toBeVisible();
  for (const name of ['Your agents', 'Recent activity', 'Bring your AI in.'])
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  // Views are history entries, not routes: back and reload still land on the same view.
  await page.goBack();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agent permissions', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agent permissions', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Agent permissions · Central City');
});

test('calm canvas: pages keep their h1 without the "Central City / …" breadcrumb label', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  await page.goto('/?workspace=v2#connect');
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const noCrumb = async (title: string) => {
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    await expect(page.getByText(/^Central City \//)).toHaveCount(0);
    await expect(page.locator('.page-kicker, .stv2-kicker')).toHaveCount(0);
  };
  await noCrumb('Connect AI');
  await nav.getByRole('button', { name: /^My agents/ }).click();
  await noCrumb('My agents');
  const advanced = await openAdvancedGroup(page);
  for (const label of ['Research & review', 'Agent permissions', 'Network map']) {
    await advanced.getByRole('button', { name: label, exact: true }).click();
    await noCrumb(label);
  }
  await openSettingsSection(page, 'Account');
  await noCrumb('Settings');
  await openSettingsSection(page, 'Data & export');
  await noCrumb('Settings');
});

test('phone rooms overview: one title, the page h1, and no second title in the top row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);
  await page.goto('/rooms');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your rooms', exact: true }),
  ).toBeVisible();
  const row = page.locator('header.cc-app-header');
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(row.locator('.cc-app-header-title p')).toBeHidden();
  // Other pages keep their title in the row (their own heading is not a pill).
  await page.goto('/?workspace=v2#connect');
  await expect(row.locator('.cc-app-header-title p')).toBeVisible();
});

test('the sidebar room list replaces the rooms column and works from every page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  const ended = await createRoom(page, 'Old launch room');
  const closed = await page.request.post(`/api/rooms/${ended.id}/close`, { headers, data: {} });
  expect(closed.ok()).toBe(true);
  const room = await createRoom(page, 'Sidebar room');
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('region', { name: 'Sidebar room' })).toBeVisible();
  // One list, in the sidebar under Rooms; the rooms app draws no column of its own.
  await expect(page.locator('.rm-sidebar')).toHaveCount(0);
  const list = page.locator('.sidebar').getByRole('navigation', { name: 'Rooms', exact: true });
  const row = list.getByRole('link', { name: 'Sidebar room' });
  await expect(row).toHaveAttribute('aria-current', 'page');
  await expect(row).toHaveCSS('background-color', 'rgb(234, 241, 255)');
  // Only one group with open rooms: no group labels. Ended rooms wait behind a toggle.
  await expect(list.getByText('Hosting', { exact: true })).toHaveCount(0);
  await expect(list.getByRole('link', { name: /Old launch room/ })).toHaveCount(0);
  const toggle = list.getByRole('button', { name: /Show ended rooms/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await list.getByRole('link', { name: /Old launch room/ }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${ended.id}$`));
  await expect(list.getByRole('link', { name: /Old launch room/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  // Nav items: 40px design size at the workspace's 90% (36px), 12px radius at 90%.
  const messages = nav.getByRole('button', { name: 'Messages', exact: true });
  expect(Math.round((await messages.boundingBox())!.height)).toBe(36);
  await messages.click();
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await expect(messages).toHaveCSS('font-weight', '600');
  // The list stays on other pages: a row opens its room, New room opens the sheet on Rooms.
  await list.getByRole('link', { name: 'Sidebar room' }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}$`));
  await expect(page.getByRole('region', { name: 'Sidebar room' })).toBeVisible();
  await nav.getByRole('button', { name: 'My agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'New room', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: 'Connect AI', exact: true }).click();
  await list.getByRole('button', { name: 'Join a room', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('the account menu works from the keyboard, also inside the phone drawer', async ({ page }) => {
  await register(page);
  await page.goto('/?workspace=v2');
  const card = page.getByRole('button', { name: /^Account: / });
  const menu = page.getByRole('navigation', { name: 'Account', exact: true });
  const focused = (name: string | RegExp) =>
    expect(
      menu.getByRole(name === 'Settings' || name === 'Help' ? 'link' : 'button', { name }),
    ).toBeFocused();
  await card.focus();
  await page.keyboard.press('Enter');
  // Focus moves into the menu; Tab and the arrow keys go through its items.
  await focused('Settings');
  await page.keyboard.press('Tab');
  await focused('Help');
  await page.keyboard.press('Tab');
  await focused(/^Theme/);
  await page.keyboard.press('ArrowDown');
  await focused('Refresh');
  await page.keyboard.press('ArrowUp');
  await focused(/^Theme/);
  await page.keyboard.press('End');
  await focused('Sign out');
  await page.keyboard.press('Home');
  await focused('Settings');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(card).toBeFocused();
  // Tab past the last item closes the menu.
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await focused('Sign out');
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);

  // Phone: inside the drawer's focus trap, Escape closes the menu first, then the drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  await opener.click();
  // The opening drawer takes focus (its Close button) in an effect after the click; focusing the
  // card before that runs would lose the card's focus to it.
  await expect(
    page.locator('.wv2-navigation').getByRole('button', { name: 'Close navigation', exact: true }),
  ).toBeFocused();
  await card.focus();
  await page.keyboard.press('Enter');
  await focused('Settings');
  await page.keyboard.press('End');
  await focused('Sign out');
  await page.keyboard.press('Tab');
  // The menu closes on the next task; focus wraps inside the drawer and stays there.
  await expect(menu).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator('.sidebar.open').evaluate((aside) => aside.contains(document.activeElement)),
    )
    .toBe(true);
  await card.focus();
  await page.keyboard.press('Enter');
  await focused('Settings');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(card).toBeFocused();
  await expect(page.locator('.sidebar.open')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar.open')).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('one calm canvas: no header bar or footer, an h1 on every page, the footer controls in the account menu', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page);
  await page.route('**/api/messages/summary', (route) =>
    route.fulfill({
      json: { inboxes: [{ agent_id: 'test-agent', latest_seq: 2, acked_seq: 0, unread: 2 }] },
    }),
  );
  await page.goto('/rooms');
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const bar = page.locator('header.cc-app-header');
  const chrome = async () => {
    await expect(bar).toBeHidden();
    await expect(page.locator('.workspace-footer')).toHaveCount(0);
    for (const text of ['Live updates', 'Updates every few seconds', 'Export workspace'])
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  };
  // Rooms: the page's own heading is the h1; the Messages badge shows here too.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your rooms', exact: true }),
  ).toBeVisible();
  await chrome();
  const messagesButton = nav.getByRole('button', { name: 'Messages', exact: true });
  await expect(messagesButton).toHaveAccessibleDescription('2 unread messages');
  await expect(messagesButton.locator('.nav-count')).toHaveText('2');
  // Messages: the floating pill carries the title.
  await messagesButton.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Messages', exact: true }),
  ).toBeVisible();
  await chrome();
  // Network map.
  await (
    await openAdvancedGroup(page)
  )
    .getByRole('button', { name: 'Network map', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Network map', exact: true }),
  ).toBeVisible();
  await chrome();
  // The account card's avatar takes its palette colour (not grey), with white initials.
  const avatar = page.locator('.ws-account-card .workspace-avatar');
  await expect(avatar).toHaveCSS('color', 'rgb(255, 255, 255)');
  expect(await avatar.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(
    /^rgba?\((\d+), \1, \1/,
  );
  // The footer's control: pause / resume in the account menu. No Downtown link there (the
  // public site's header and footer keep it).
  const account = await openAccountMenu(page);
  await expect(account.getByRole('link', { name: /Downtown|Open Source/ })).toHaveCount(0);
  await expect(account.locator('a[href="/downtown"]')).toHaveCount(0);
  const pause = account.getByRole('button', { name: 'Pause workspace', exact: true });
  await expect(pause).toHaveAccessibleDescription('Running');
  await pause.click();
  await expect(page.getByText('Workspace paused.', { exact: true })).toBeVisible();
  const resume = account.getByRole('button', { name: 'Resume workspace', exact: true });
  await expect(resume).toHaveAccessibleDescription('Paused');
  // Focus stays on the item through the change (aria-disabled while busy, never disabled).
  await expect(resume).toBeFocused();
  await resume.click();
  await expect(pause).toBeVisible();
  await expect(pause).toBeFocused();
  await expect(page.getByText('Workspace paused.', { exact: true })).toHaveCount(0);
  // The phone keeps a minimal top row: the round ☰ chip and the page title.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
  await expect(bar.locator('.cc-app-header-title p')).toHaveText('Network map');
  const chip = (await bar.getByRole('button', { name: 'Open navigation' }).boundingBox())!;
  expect(chip.width).toBeGreaterThanOrEqual(44);
  expect(chip.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText('Updates every few seconds', { exact: true })).toHaveCount(0);
});
