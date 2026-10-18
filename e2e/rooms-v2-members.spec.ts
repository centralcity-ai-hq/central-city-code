import {
  test,
  expect as baseExpect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * Smart Rooms v2 Members panel (src/rooms/MembersV2.tsx with ?rooms=v2): people and AIs grouped
 * with counts, the search runs on the server (?q=), "Show more" loads the next page, Ctrl/Cmd+K
 * focuses the search only while the panel is open, "Message privately" opens the Messages thread,
 * the host's row menu offers Mute, and phone widths never scroll sideways. Set RV2_SHOTS=<dir> to also save screenshots at 1440 and 390, light and dark.
 * Synthetic accounts only.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const SCOUTS = 56;

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
const why = async (response: APIResponse) =>
  `${response.status()} ${(await response.text()).slice(0, 300)}`;

// One seeded room for the whole file (seeding takes ~20 accounts); each test opens its own pages.
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.flatMap((context) => context.pages().map((page) => page.close())));
});
test.afterAll(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  opened.push(context);
  const created = await patient(() =>
    context.request.post('/api/auth/register', {
      headers,
      data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  return { context, request: context.request };
}

async function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  const response = await patient(() => request.post(url, { headers, data }));
  expect(response.ok(), await why(response)).toBeTruthy();
  return response.json();
}

/**
 * A host's room (its agent "Host agent", which posts once) with Dana, a person, and SCOUTS AIs
 * ("Scout 01"...; Dana brought the first two): 1 person and SCOUTS + 1 AIs, more than one page.
 */
let seeded: ReturnType<typeof seed> | null = null;
const seededRoom = (browser: Browser) => (seeded ??= seed(browser));

async function seed(browser: Browser) {
  const host = await account(browser, 'rv2m-host');
  const agent = await post(host.request, '/api/agents', {
    name: 'Host agent',
    capability: 'research',
    mode: 'external',
  });
  const hostAgent = agent.agent.id as string;
  const { room } = (await post(host.request, '/api/rooms', {
    agent_id: hostAgent,
    name: 'Members room',
    member_cap: 100,
    idempotency_key: crypto.randomUUID(),
  })) as { room: { id: string } };
  await post(host.request, `/api/rooms/${room.id}/messages`, {
    agent_id: hostAgent,
    text: 'Welcome, everyone.',
    idempotency_key: crypto.randomUUID(),
  });
  const { link } = (await post(host.request, `/api/rooms/${room.id}/link`, {})) as {
    link: string;
  };
  const dana = await account(browser, 'rv2m-dana');
  await post(dana.request, '/api/rooms/join', {
    link,
    name: 'Dana',
    idempotency_key: crypto.randomUUID(),
  });
  // An owner may have at most 3 members in a room: Dana (herself and 2 AIs), then other
  // accounts with 3 AIs each, joined with the invite link.
  const token = new URL(link).hash.slice(1);
  let helper: APIRequestContext | null = null;
  for (let index = 1; index <= SCOUTS; index++) {
    const name = `Scout ${String(index).padStart(2, '0')}`;
    if (index <= 2) {
      await post(dana.request, `/api/rooms/${room.id}/join`, {
        create: { name },
        idempotency_key: crypto.randomUUID(),
      });
      continue;
    }
    if ((index - 3) % 3 === 0) helper = (await account(browser, 'rv2m-ai')).request;
    await post(helper!, `/api/rooms/${room.id}/join`, {
      token,
      create: { name },
      idempotency_key: crypto.randomUUID(),
    });
  }
  return { host, dana, room };
}

async function openMembers(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Members room' })).toBeVisible();
  // The room pill opens Members (the top bar has no separate Members chip, §4.1).
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Whether a Ctrl+K keydown on the page was taken (default prevented). */
const ctrlKTaken = (page: Page) =>
  page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });

test('v2 members: groups with counts, server search, Show more, Ctrl+K, host Mute', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // With the panel closed, Ctrl+K is left alone.
  await page.goto(`/rooms/${room.id}?rooms=v2`);
  await expect(page.getByRole('heading', { level: 1, name: 'Members room' })).toBeVisible();
  expect(await ctrlKTaken(page)).toBe(false);

  const panel = await openMembers(page, room.id);
  await expect(page.locator('.rm-app')).toHaveAttribute('data-rooms', 'v2');
  // The host agent, the scouts, the joiner, and the host's own person (A1).
  const total = 1 + SCOUTS + 1 + 1;
  await expect(panel.getByTestId('members-total')).toHaveText(
    `${total} members · 2 people · ${SCOUTS + 1} AIs`,
  );
  const people = panel.getByRole('list', { name: 'People' });
  const ais = panel.getByRole('list', { name: 'AIs', exact: true });
  const rows = panel.getByTestId('member-row');
  // The first page only: 50 rows, People 2 (Dana and the host's own person), AIs from the
  // room counts.
  await expect(rows).toHaveCount(50);
  await expect(panel.getByRole('heading', { name: 'People 2' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: `AIs ${SCOUTS + 1}` })).toBeVisible();
  await expect(people.getByTestId('member-row')).toHaveCount(2);
  await expect(panel.getByTestId('members-shown')).toHaveText(`Showing 50 of ${total}`);

  // The host's own AI: Host and its AI label, with exact activity and today's count.
  const hostRow = ais.getByTestId('member-row').filter({ hasText: 'Host agent' });
  await expect(hostRow.getByTestId('member-badge')).toHaveText(['Host', 'AI · your agent']);
  await expect(hostRow.getByTestId('member-activity')).toContainText(/^Active now · 1 today$/);
  const danaRow = people.getByTestId('member-row').filter({ hasText: 'Dana' });
  await expect(danaRow.getByRole('link', { name: 'Message Dana privately' })).toBeVisible();
  await expect(
    ais.getByTestId('member-row').filter({ hasText: 'Scout 01' }).getByTestId('member-badge'),
  ).toHaveText(["AI · Dana's agent"]);

  // Show more: the next page from the server.
  const more = panel.getByRole('button', { name: 'Show more' });
  const nextPage = page.waitForRequest(
    (request) => request.url().includes('/members?') && request.url().includes('cursor='),
  );
  await more.click();
  await nextPage;
  await expect(rows).toHaveCount(total);
  await expect(more).toHaveCount(0);
  await expect(panel.getByTestId('members-shown')).toHaveText(`Showing ${total} of ${total}`);

  // Ctrl+K (panel open) focuses the search; the search runs on the server.
  const search = panel.getByRole('searchbox', { name: 'Search members' });
  expect(await ctrlKTaken(page)).toBe(true);
  await expect(search).toBeFocused();
  const searched = page.waitForRequest(
    (request) => request.url().includes('/members?') && request.url().includes('q=scout+0'),
  );
  await page.keyboard.type('scout 0');
  await searched;
  await expect(rows).toHaveCount(9);
  for (const row of await rows.all()) await expect(row).toContainText(/Scout 0\d/);
  await expect(people).toHaveCount(0);
  // "Starts with": "dan" finds Dana, but "ana" (inside the name) finds no one.
  await search.fill('dan');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Dana');
  await search.fill('ana');
  await expect(panel.getByText('No members match “ana”.')).toBeVisible();
  await search.fill('nobody by this name');
  await expect(panel.getByText('No members match “nobody by this name”.')).toBeVisible();
  await panel.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await expect(rows).toHaveCount(50);

  // The host's row menu: Mute (then Unmute), Remove; never on the host itself.
  await expect(hostRow.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  const scout = ais.getByTestId('member-row').filter({ hasText: 'Scout 05' });
  await scout.getByRole('button', { name: 'Actions for Scout 05' }).click();
  const menu = scout.getByRole('menu', { name: 'Actions for Scout 05' });
  await expect(menu.getByRole('menuitem', { name: 'Message privately' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Remove' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Mute' }).click();
  await expect(scout.getByText('Muted', { exact: true })).toBeVisible();
  await scout.getByRole('button', { name: 'Actions for Scout 05' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Unmute' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  const mutes = await host.request.get(`/api/rooms/${room.id}/mutes`);
  expect(JSON.stringify(await mutes.json())).toContain(
    (await (await host.request.get(`/api/rooms/${room.id}/members?q=scout%2005`)).json()).members[0]
      .id,
  );
  expect(errors).toEqual([]);
});

test('v2 members: "Message privately" opens the Messages thread', async ({ browser }) => {
  test.setTimeout(150_000);
  const { dana, room } = await seededRoom(browser);
  const page = await dana.context.newPage();
  const panel = await openMembers(page, room.id);
  const rows = panel.getByTestId('member-row');
  // Dana's own row: You, no private message to herself; no host menu for a member.
  const own = panel
    .getByRole('list', { name: 'People' })
    .getByTestId('member-row')
    .filter({ has: page.getByTestId('member-badge').filter({ hasText: /^You$/ }) });
  await expect(own.getByTestId('member-badge')).toHaveText(['You']);
  await expect(own.getByRole('link', { name: /privately/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  const hostRow = rows.filter({ hasText: 'Host agent' });
  // Its owner is in the room as a person (A1), so the label names them.
  await expect(hostRow.getByTestId('member-badge')).toHaveText(['Host', /^AI · .+'s agent$/]);
  await hostRow.getByRole('link', { name: 'Message Host agent privately' }).click();
  const head = page.locator('.msg-v2-head');
  await expect(head.getByRole('heading', { name: 'Host agent', exact: true })).toBeVisible();
  await expect(head).toContainText('From #Members room');
  await expect(page.getByRole('form', { name: 'Private message' })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const)
  for (const width of [360, 390])
    test(`v2 members: no horizontal scroll at ${width}px, ${theme}`, async ({ browser }) => {
      test.setTimeout(150_000);
      const { host, room } = await seededRoom(browser);
      const page = await host.context.newPage();
      await page.addInitScript((value) => localStorage.setItem('cc-theme', value), theme);
      await page.setViewportSize({ width, height: 812 });
      const panel = await openMembers(page, room.id);
      await expect(panel.getByTestId('member-row')).toHaveCount(50);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const scroll = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(scroll.page, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      const sheet = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(sheet, 'the sheet scrolls sideways').toBeLessThanOrEqual(0);
      // Every row and its Message pill sit inside the viewport; targets stay 44 px tall.
      for (const row of (await panel.getByTestId('member-row').all()).slice(0, 6)) {
        const box = (await row.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      const pill = panel.getByRole('link', { name: 'Message Dana privately' });
      const pillBox = (await pill.boundingBox())!;
      expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(width);
      const hit = await pill.evaluate((el) => {
        const after = getComputedStyle(el, '::after');
        return el.getBoundingClientRect().height - parseFloat(after.top) - parseFloat(after.bottom);
      });
      expect(hit).toBeGreaterThanOrEqual(44);
      // The row menu opens inside the viewport.
      const scout = panel.getByTestId('member-row').filter({ hasText: 'Scout 01' });
      await scout.getByRole('button', { name: 'Actions for Scout 01' }).click();
      const menuBox = (await scout.getByRole('menu').boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      const after = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(after).toBeLessThanOrEqual(0);
    });

test('screenshots at 1440 and 390, light and dark', async ({ browser }) => {
  const dir = process.env.RV2_SHOTS;
  test.skip(!dir, 'set RV2_SHOTS to save screenshots');
  test.setTimeout(180_000);
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => localStorage.setItem('cc-theme', value), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const panel = await openMembers(page, room.id);
      await expect(panel.getByTestId('member-row')).toHaveCount(50);
      await page.screenshot({ path: `${dir}/members-${width}-${theme}.png` });
      const scout = panel.getByTestId('member-row').filter({ hasText: 'Scout 01' });
      await scout.getByRole('button', { name: 'Actions for Scout 01' }).click();
      await page.screenshot({ path: `${dir}/members-menu-${width}-${theme}.png` });
      await page.keyboard.press('Escape');
      await panel.getByRole('searchbox', { name: 'Search members' }).fill('scout 1');
      await expect(panel.getByTestId('member-row')).toHaveCount(10);
      await page.screenshot({ path: `${dir}/members-search-${width}-${theme}.png` });
    }
  }
});

test('Invite agent: the host types a passport number, sees the agent, and sends', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  const now = Date.now();
  await page.route('**/api/public/base/agents*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const rows =
      q === 'k3P9xQ'
        ? [
            {
              baseId: '1532',
              name: 'Linet',
              owner: '0x' + '1'.repeat(40),
              short: 'k3P9xQ',
              status: 'final',
            },
          ]
        : [];
    return route.fulfill({
      json: {
        rows,
        totals: {
          onBase: 1,
          new24h: 0,
          finalizingNow: 0,
          readAtBlock: 1,
          readAt: now,
          servedAt: now,
        },
        registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        nextBefore: null,
      },
    });
  });
  const sent: Array<Record<string, unknown>> = [];
  await page.route(`**/api/rooms/${room.id}/invitations`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { invitations: [] } });
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    // The first answer is lost on the way (a 502): the retry must be the same request.
    if (sent.length === 1) return route.fulfill({ status: 502, json: { error: 'Bad gateway' } });
    return route.fulfill({ status: 201, json: { id: 'inv-1', state: 'open' } });
  });
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Members room' })).toBeVisible();
  await page.getByRole('button', { name: 'Invite agent' }).click();
  const sheet = page.getByRole('dialog', { name: 'Invite an agent' });
  const field = sheet.getByRole('textbox', { name: 'Passport number' });
  await expect(field).toBeFocused();
  // Not a passport number: says what one looks like; a Base ID is not one.
  await field.fill('1532');
  await expect(sheet.getByText('A passport number is CC- and 6 letters and digits')).toBeVisible();
  // An unknown one, then the agent's: its name shows before anything is sent.
  await field.fill('CC-zzzzzz');
  await expect(sheet.getByText('No Central City agent has this passport number.')).toBeVisible();
  await field.fill('centralcity.ai/a/k3P9xQ');
  await expect(sheet.getByText('Linet')).toBeVisible();
  await sheet
    .getByRole('textbox', { name: 'Note (optional)' })
    .fill('  Please check our sources.  ');
  await sheet.getByRole('button', { name: 'Send invite' }).click();
  await expect(sheet.getByRole('alert')).toBeVisible();
  // Send again: the same key, so the server replays the first one instead of a second invite.
  await sheet.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('dialog', { name: 'Invitation sent' })).toContainText(
    'Linet’s owner gets it in their inbox and decides.',
  );
  expect(sent).toHaveLength(2);
  expect(sent[1]!.idempotencyKey).toEqual(sent[0]!.idempotencyKey);
  sent.shift();
  expect(sent[0]).toMatchObject({ passport: 'k3P9xQ', note: 'Please check our sources.' });
  expect(sent[0]).not.toHaveProperty('baseId');
  expect(typeof sent[0]!.fromAgentId).toBe('string');
  // Invite another: a second agent is a new request with its own key.
  await page.getByRole('button', { name: 'Invite another' }).click();
  await sheet.getByRole('textbox', { name: 'Passport number' }).fill('k3P9xQ');
  await expect(sheet.getByText('Linet')).toBeVisible();
  await sheet.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('dialog', { name: 'Invitation sent' })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.idempotencyKey).not.toEqual(sent[0]!.idempotencyKey);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('v2 members: the host sees its invited agents, only joined or not, and can withdraw', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, room } = await seededRoom(browser);
  const page = await host.context.newPage();
  const at = Date.UTC(2026, 9, 12, 9, 0);
  const sentView = (id: string, name: string, state: string) => ({
    id,
    roomId: room.id,
    to: { baseId: null, short: 'k3P9xQ', name },
    from: { agentId: 'a1', name: 'Host agent' },
    note: '',
    state,
    createdAt: at,
    expiresAt: at + 7 * 86_400_000,
    answeredAt: state === 'open' ? null : at,
  });
  const withdrawn: string[] = [];
  await page.route(`**/api/rooms/${room.id}/invitations`, (route) =>
    route.fulfill({
      json: {
        invitations: [
          sentView('i1', 'Linet', 'open'),
          sentView('i2', 'Briolo', 'joined'),
          sentView('i3', 'Tuba', 'not_joined'),
        ],
      },
    }),
  );
  await page.route(`**/api/rooms/${room.id}/invitations/*/withdraw`, (route) => {
    withdrawn.push(route.request().url());
    return route.fulfill({ json: sentView('i1', 'Linet', 'withdrawn') });
  });
  const panel = await openMembers(page, room.id);
  const list = panel.getByRole('list', { name: 'Invited agents' });
  await expect(list.locator('li')).toHaveCount(3);
  await expect(list.locator('li').nth(0)).toContainText('Waiting · by Host agent');
  await expect(list.locator('li').nth(1)).toContainText('Joined');
  await expect(list.locator('li').nth(2)).toContainText("Didn't join");
  await panel.getByRole('button', { name: 'Withdraw the invitation to Linet' }).click();
  await expect(list.locator('li').nth(0)).toContainText('Withdrawn');
  expect(withdrawn).toHaveLength(1);
});
