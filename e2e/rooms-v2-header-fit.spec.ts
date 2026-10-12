import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { workspaceTarget } from './workspace-density';

/*
 * The v3 room top bar (docs/design/WORKSPACE_V3.md §4.1) fits at every width: a busy room (a
 * very long name, Elric on, open tasks, AIs active and a Needs-you count) at laptop and desktop
 * widths with the rooms sidebar open and collapsed, in the workspace preview, and on phones. The
 * title truncates; the centred row wraps instead of hiding anything; Invite and More stay fully
 * inside the top bar, 44 px and clickable; nothing scrolls sideways. Under 640 px the bar is two
 * rows: the pill with More, then one strip of chips that scrolls sideways (Invite last, never
 * alone on a row).
 *
 * Overview, Needs-you, tasks and Elric come from page.route (the test server runs without
 * Elric); the room, the account and the member list are real.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const ROOM_NAME = 'Quarterly planning: design system, smart rooms upgrade and onboarding research'; // rooms allow 80 characters

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

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of opened)
    await Promise.all(context.pages().map((page) => page.unrouteAll({ behavior: 'ignoreErrors' })));
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

type Setup = { collapsed?: boolean; workspace?: boolean };

async function busyRoom(browser: Browser, setup: Setup) {
  const context = await browser.newContext();
  opened.push(context);
  await context.addInitScript((value) => {
    localStorage.setItem('cc-rooms-v2', 'v2');
    localStorage.setItem('cc.rooms.sidebar.collapsed', value.collapsed ? '1' : '0');
    if (value.workspace) localStorage.setItem('cc-workspace-v2', 'v2');
  }, setup);
  const request = context.request;
  const created = await patient(() =>
    request.post('/api/auth/register', {
      headers,
      data: { name: `Fit-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const agent = await patient(() =>
    request.post('/api/agents', {
      headers,
      data: { name: 'Host agent', capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  const agentId = (await agent.json()).agent.id as string;
  const room = await patient(() =>
    request.post('/api/rooms', {
      headers,
      data: { agent_id: agentId, name: ROOM_NAME, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  return { context, room: (await room.json()).room as { id: string } };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function mock(page: Page, roomId: string) {
  const base = `**/api/rooms/${roomId}`;
  await page.route(`${base}/overview`, (route) =>
    route.fulfill({
      json: {
        room_id: roomId,
        members: { total: 12_480, people: 12_455, ais: 25, ais_active_15m: 14 },
        tasks: { open: 18, claimed: 7, in_review: 4, done: 30 },
        unread: { messages: null, mentions: 0, mentions_capped: false },
        latest_seq: 1,
        as_of: new Date().toISOString(),
      },
    }),
  );
  await page.route(`${base}/needs-you*`, (route) =>
    route.fulfill({
      json: {
        room_id: roomId,
        items: Array.from({ length: 12 }, (_, index) => ({
          kind: 'task_to_review',
          id: `task-${index}`,
          since: minutesAgo(30 + index),
          task: {
            id: `task-${index}`,
            number: index + 1,
            title: `Review ${index}`,
            status: 'in_review',
          },
        })),
      },
    }),
  );
  // Elric is on: the account has Elric and it is a member of the room.
  await page.route('**/api/elric', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            agent_id: 'elric-agent',
            status: 'active',
            host_may_invoke: true,
            eligible: true,
            eligibility_reason: null,
            over_18: true,
            usage: {
              allowance: { short: 100, summary: 10, tool: 10 },
              used: { short: 0, summary: 0, tool: 0 },
              resets_at: new Date(Date.now() + 86_400_000).toISOString(),
            },
            limit_notices: [],
          },
        })
      : route.fallback(),
  );
  await page.route(`${base}/members`, async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as { members: Array<Record<string, unknown>> };
    const elric = {
      id: 'elric-agent',
      name: 'Elric',
      kind: 'agent',
      role: 'member',
      own: true,
      joined_at: minutesAgo(200),
      status: 'active',
      last_active_at: minutesAgo(1),
      messages_today: 40,
      says: null,
      auto_reply: { provider: 'elric' },
    };
    await route.fulfill({ response, json: { members: [...value.members, elric] } });
  });
  await page.route(
    (url) => url.pathname === `/api/rooms/${roomId}/tasks`,
    (route) =>
      route.fulfill({
        json: {
          stages: [],
          tasks: Array.from({ length: 18 }, (_, index) => ({
            id: `open-${index}`,
            number: index + 1,
            title: `Open task ${index + 1}`,
            body: null,
            status: 'open',
            created_by_agent_id: 'host',
            claim: null,
            result: null,
            created_at: minutesAgo(100),
            updated_at: minutesAgo(5),
          })),
        },
      }),
  );
}

async function expectHeaderFits(page: Page, width: number) {
  const header = page.locator('.rm-room-head');
  await expect(page.getByRole('heading', { level: 1, name: ROOM_NAME })).toBeVisible();
  // Everything that makes the room busy has loaded.
  await expect(page.getByTestId('needs-you-chip')).toBeVisible();
  // One count chip (Tasks); the room pill counts the members; no combined counts chip.
  await expect(page.getByTestId('activity-chip')).toHaveCount(0);
  await expect(header.getByRole('switch', { name: /Elric/ })).toBeVisible();

  const invite = header.getByRole('button', { name: 'Invite', exact: true });
  const more = header.getByRole('button', { name: 'More room actions' });
  await expect(invite).toBeVisible();
  await expect(more).toBeVisible();
  // The members (avatars, count and live line) and Elric's state land after the first paint and
  // widen the room pill by about 110 px, enough to move Invite to a second line at 1366 px.
  // Measure the settled bar only: a fit measured before they land is not the bar people see.
  await expect(page.getByTestId('room-live')).toHaveText('14 AIs active');
  await expect(header.getByRole('switch', { name: /Elric/ })).toBeChecked();

  // Let a resize settle (fonts and polls can land late).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector('.rm-room-head')!;
        return el.scrollWidth - el.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(0);
  // A wrap settles too: a chip that lands late can push the actions onto a second line for a
  // moment, which never shows as overflow. A wrap that stays still fails below.
  for (const button of [invite, more])
    await expect
      .poll(async () => {
        const [bar, box] = await Promise.all([header.boundingBox(), button.boundingBox()]);
        return bar && box ? box.y + box.height - (bar.y + bar.height) : Infinity;
      })
      .toBeLessThanOrEqual(0.5);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);

  const head = (await header.boundingBox())!;
  expect(head.x).toBeGreaterThanOrEqual(0);
  expect(head.x + head.width).toBeLessThanOrEqual(width + 0.5);
  for (const [name, button] of [
    ['Invite', invite],
    ['More', more],
  ] as const) {
    // On phones Invite ends the chip strip: scrolled into view, it sits fully inside the bar.
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.x, `${name} left`).toBeGreaterThanOrEqual(head.x - 0.5);
    expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(head.x + head.width + 0.5);
    expect(box.y, `${name} top`).toBeGreaterThanOrEqual(head.y - 0.5);
    expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(head.y + head.height + 0.5);
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(workspaceTarget(width));
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(workspaceTarget(width));
  }
  // The title truncates rather than pushing the actions out.
  const title = page.getByRole('heading', { level: 1, name: ROOM_NAME });
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  expect((await title.boundingBox())!.width).toBeGreaterThan(40);

  // Invite is clickable (nothing covers it); More opens with the room actions.
  await invite.click({ trial: true });
  await more.click();
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Connect AI' })).toBeVisible();
  // Tasks, Members (the room pill) and Search stay in the row, each reachable exactly once,
  // inside the top bar.
  for (const [inRow, inMenu] of [
    [
      header.getByRole('button', { name: /^Tasks, 18 to do/ }),
      menu.getByRole('menuitem', { name: /^Tasks/ }),
    ],
    [
      header.getByRole('button', {
        name: `Members of ${ROOM_NAME}: 12.4k members, 14 AIs active`,
      }),
      menu.getByRole('menuitem', { name: /^Members/ }),
    ],
    [
      header.getByRole('button', { name: 'Search this room' }),
      menu.getByRole('menuitem', { name: /^Search/ }),
    ],
  ] as const) {
    expect(await inRow.count(), 'in the row').toBe(1);
    expect(await inMenu.count(), 'not repeated in More').toBe(0);
    await inRow.scrollIntoViewIfNeeded();
    const box = (await inRow.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(head.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(head.x + head.width + 0.5);
    expect(box.height).toBeGreaterThanOrEqual(workspaceTarget(width));
  }
  // The live line in the room pill is the AIs active now.
  await expect(page.getByTestId('room-live')).toHaveText('14 AIs active');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

const desktop = [1024, 1280, 1366, 1440];
for (const width of desktop)
  for (const collapsed of [false, true])
    test(`busy v2 header fits ${width} px, sidebar ${collapsed ? 'collapsed' : 'open'}`, async ({
      browser,
    }) => {
      const { context, room } = await busyRoom(browser, { collapsed });
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await mock(page, room.id);
      await page.goto(`/rooms/${room.id}`);
      await expectHeaderFits(page, width);
    });

for (const width of [1024, 1280, 1440])
  test(`busy v2 header fits ${width} px in the workspace preview`, async ({ browser }) => {
    const { context, room } = await busyRoom(browser, { workspace: true });
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await mock(page, room.id);
    await page.goto(`/rooms/${room.id}?workspace=v2`);
    await expectHeaderFits(page, width);
  });

/** Vertical centre of each visible top-bar item, by role in the two-row phone layout. */
async function barLayout(page: Page) {
  return page.locator('.rm-room-head').evaluate((head) => {
    const centre = (element: Element) => {
      const box = element.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    };
    const strip = head.querySelector<HTMLElement>('.rm3-chips')!;
    const chips = [...strip.children].filter((item) => item.getClientRects().length);
    const style = getComputedStyle(strip);
    return {
      pill: centre(head.querySelector('.rm3-pill')!),
      more: centre(head.querySelector('.rm-more')!),
      moreInStrip: strip.contains(head.querySelector('.rm-more')),
      chips: chips.map((item) => ({
        name: item.getAttribute('aria-label') ?? item.textContent ?? '',
        centre: centre(item),
      })),
      lastChip: chips.at(-1)?.textContent ?? '',
      wrap: style.flexWrap,
      overflowX: style.overflowX,
      scrolls: strip.scrollWidth > strip.clientWidth,
      // Chips cut off by the strip's edges (reachable only by scrolling it).
      clipped: chips
        .filter((item) => {
          const box = item.getBoundingClientRect();
          const edge = strip.getBoundingClientRect();
          return box.left < edge.left - 0.5 || box.right > edge.right + 0.5;
        })
        .map((item) => item.getAttribute('aria-label') ?? item.textContent ?? ''),
      height: head.getBoundingClientRect().height,
    };
  });
}

for (const width of [390, 360])
  test(`busy v2 header fits a ${width} px phone in two rows`, async ({ browser }) => {
    const { context, room } = await busyRoom(browser, {});
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 844 });
    await mock(page, room.id);
    await page.goto(`/rooms/${room.id}`);
    await expectHeaderFits(page, width);
    const layout = await barLayout(page);
    // Row 1: the pill and More, side by side.
    expect(layout.moreInStrip, 'More is in row 1, not in the chip strip').toBe(false);
    expect(Math.abs(layout.more - layout.pill)).toBeLessThanOrEqual(1);
    // Members opens from the pill in row 1 (44 px); the strip has no Members chip.
    const pill = page.getByTestId('room-pill');
    await expect(pill).toHaveAccessibleName(
      `Members of ${ROOM_NAME}: 12.4k members, 14 AIs active`,
    );
    const pillBox = (await pill.boundingBox())!;
    expect(Math.abs(pillBox.y + pillBox.height / 2 - layout.pill)).toBeLessThanOrEqual(1);
    expect(pillBox.height).toBeGreaterThanOrEqual(44);
    expect(layout.chips.map((chip) => chip.name).filter((name) => /Members/.test(name))).toEqual(
      [],
    );
    // Row 2: every chip (Needs you, Tasks, Elric, Search, Invite) on one line that scrolls
    // sideways instead of wrapping; Invite is last and shares the line.
    expect(layout.wrap).toBe('nowrap');
    expect(layout.overflowX).toBe('auto');
    expect(layout.chips.length).toBeGreaterThanOrEqual(5);
    expect(layout.lastChip).toBe('Invite');
    for (const chip of layout.chips)
      expect(Math.abs(chip.centre - layout.chips[0]!.centre), chip.name).toBeLessThanOrEqual(1);
    expect(layout.chips[0]!.centre).toBeGreaterThan(layout.pill);
    // Two rows of 44 px controls and their spacing, no third row.
    expect(layout.height).toBeLessThanOrEqual(2 * 44 + 40);
    // Without a Members chip the busy room's strip fits this phone: nothing is cut off. When it
    // does not fit (a narrower phone, below) it scrolls, and the page does not.
    if (!layout.scrolls) expect(layout.clipped).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 320, height: 844 });
    await expect.poll(async () => (await barLayout(page)).scrolls).toBe(true);
    const narrow = await barLayout(page);
    expect(narrow.wrap).toBe('nowrap');
    expect(narrow.clipped.length).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width, height: 844 });
    // The pill shows at most three avatars on phones and "+N" for everyone else.
    expect(
      await page.locator('.rm3-pill .rm3-stack .rm3-av:not(.rm3-more)').count(),
    ).toBeLessThanOrEqual(3);
    await expect(page.locator('.rm3-pill .rm3-more')).toHaveText(/^\+\d/);
  });

test('the phone layout returns to one wrapping row when the window grows past 640 px', async ({
  browser,
}) => {
  const { context, room } = await busyRoom(browser, {});
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, room.id);
  await page.goto(`/rooms/${room.id}`);
  await expectHeaderFits(page, 390);
  expect((await barLayout(page)).moreInStrip).toBe(false);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => (await barLayout(page)).moreInStrip).toBe(true);
  await expect(page.locator('.rm-room-head')).not.toHaveAttribute('data-compact', /.*/);
  await expectHeaderFits(page, 1024);
});

test('the row wraps when narrow and is one line again when the window grows', async ({
  browser,
}) => {
  const { context, room } = await busyRoom(browser, {});
  const page = await context.newPage();
  await page.setViewportSize({ width: 1024, height: 900 });
  await mock(page, room.id);
  await page.goto(`/rooms/${room.id}`);
  await expectHeaderFits(page, 1024);
  const header = page.locator('.rm-room-head');
  const rows = () =>
    header.evaluate((element) => {
      const tops = [...element.querySelectorAll<HTMLElement>('.rm3-pill, .rm-head-actions > *')]
        .filter((item) => item.getClientRects().length)
        .map((item) => {
          const box = item.getBoundingClientRect();
          return Math.round(box.top + box.height / 2);
        });
      return new Set(tops).size;
    });
  expect(await rows()).toBeGreaterThan(1);
  await page.setViewportSize({ width: 2200, height: 900 });
  // With room to spare: one centred line, labels shown, Invite with its word.
  await expect.poll(rows).toBe(1);
  await expect(header.getByRole('button', { name: /^Tasks, 18 to do/ })).toContainText('Tasks');
  await expect(header.getByRole('button', { name: 'Invite', exact: true })).toHaveText('Invite');
  // Connect AI lives in More at every width (§6).
  await expect(header.getByRole('button', { name: 'Connect AI' })).toHaveCount(0);
  await expectHeaderFits(page, 2200);
});

test('one count chip (Tasks) and the room pill for Members, beside Invite and More', async ({
  browser,
}) => {
  const { context, room } = await busyRoom(browser, {});
  const page = await context.newPage();
  await page.setViewportSize({ width: 2200, height: 900 });
  await mock(page, room.id);
  await page.goto(`/rooms/${room.id}`);
  await expectHeaderFits(page, 2200);
  const header = page.locator('.rm-room-head');
  await expect(page.getByTestId('activity-chip')).toHaveCount(0);
  await expect(header.getByText(/AIs active ·/)).toHaveCount(0);
  // The one chip with a count badge is Tasks; the members are counted by the room pill (its
  // avatars and +N, its name), which is the top bar's only Members control.
  const counted = header.locator('button:has(.rm-count)');
  await expect(counted).toHaveCount(1);
  await expect(counted.nth(0)).toHaveAccessibleName('Tasks, 18 to do');
  await expect(counted.nth(0).locator('.rm-count')).toHaveText('18');
  await expect(page.getByTestId('members-button')).toHaveCount(0);
  const pill = header.getByTestId('room-pill');
  await expect(pill).toHaveAccessibleName(`Members of ${ROOM_NAME}: 12.4k members, 14 AIs active`);
  await expect(header.getByRole('button', { name: /Members/ })).toHaveCount(1);
  await expect(header.locator('.rm3-pill .rm3-more')).toHaveText(/^\+12\.\dk$/);
  await expect(header.getByRole('button', { name: 'Invite', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'More room actions' })).toBeVisible();
  // Members opens the roster from the pill (Workspace v3 §4.5): the search field on top, then
  // the PEOPLE and AIS groups — no Active-now section anymore.
  await pill.click();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('complementary', { name: 'Members' });
  await expect(panel.getByRole('region', { name: 'Active now' })).toHaveCount(0);
  // This room's loaded members are its AIs (the counts are mocked), so the AIs group shows,
  // right under the search field; People shows when people are loaded.
  const ais = panel.getByRole('heading', { name: /^AIs / });
  await expect(ais).toBeVisible();
  const [searchTop, aisTop] = await Promise.all([
    panel.getByRole('searchbox', { name: 'Search members' }).boundingBox(),
    ais.boundingBox(),
  ]);
  expect(searchTop!.y).toBeLessThan(aisTop!.y);
});
