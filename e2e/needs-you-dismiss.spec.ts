import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * "Needs you" dismissals in the v2 room header: a tick box per item with "Dismiss", "Dismiss
 * all", opening an item dismisses it, optimistic with a rollback and a toast, and the badge
 * counting only what is left (the real number up to 99, then 99+). The room and the signed-in
 * host are real; the queue and its dismiss route are a stateful page.route mock, so the spec
 * can hold exactly the items it needs.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

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

async function roomHost(browser: Browser) {
  const context = await browser.newContext();
  opened.push(context);
  const request = context.request;
  const created = await patient(() =>
    request.post('/api/auth/register', {
      headers,
      data: { name: `Needs-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
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
      data: { agent_id: agentId, name: 'Needs you room', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  return { context, roomId: (await room.json()).room.id as string };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const threeItems = () => [
  {
    kind: 'task_to_review',
    id: 'task-7',
    since: minutesAgo(30),
    task: { id: 'task-7', number: 7, title: 'Header fits at 360 px', status: 'in_review' },
  },
  {
    kind: 'mention',
    id: 'ai-sonnet:1',
    since: minutesAgo(5),
    agent_id: 'x',
    message_seq: 1,
    from_name: 'Sonnet Scout',
    excerpt: 'can you check this?',
  },
  {
    kind: 'mention',
    id: 'ai-gpt:2',
    since: minutesAgo(2),
    agent_id: 'x',
    message_seq: 1,
    from_name: 'GPT Helper',
    excerpt: 'one more question',
  },
];
type Item = ReturnType<typeof threeItems>[number] | { kind: string; id: string; since: string };

/** A stateful queue: GET pages it (limit + cursor), dismiss removes items like the server. */
async function mockQueue(page: Page, roomId: string, initial: Item[]) {
  const state = {
    items: [...initial],
    calls: [] as unknown[],
    failNext: false,
  };
  await page.route(
    (url) => url.pathname === `/api/rooms/${roomId}/needs-you`,
    (route) => {
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get('limit') ?? '20');
      const start = Number(url.searchParams.get('cursor')?.replace('page-', '') ?? '0');
      const items = state.items.slice(start, start + limit);
      const next = start + limit < state.items.length ? `page-${start + limit}` : undefined;
      return route.fulfill({
        json: { room_id: roomId, items, ...(next ? { next_cursor: next } : {}) },
      });
    },
  );
  await page.route(`**/api/rooms/${roomId}/needs-you/dismiss`, async (route) => {
    const body = route.request().postDataJSON() as { ids?: string[]; all?: true };
    state.calls.push(body);
    if (state.failNext) {
      state.failNext = false;
      return route.fulfill({
        status: 500,
        json: { error: 'The operation could not be completed.' },
      });
    }
    const before = state.items.length;
    state.items = body.all ? [] : state.items.filter((item) => !body.ids?.includes(item.id));
    return route.fulfill({
      json: { room_id: roomId, dismissed: before - state.items.length, more: false },
    });
  });
  // The Tasks panel opens on a task entry; keep it quiet.
  await page.route(
    (url) => url.pathname === `/api/rooms/${roomId}/tasks`,
    (route) => route.fulfill({ json: { stages: [], tasks: [] } }),
  );
  return state;
}

for (const width of [1440, 390])
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width > 600 ? 1000 : 844 } });

    test('tick one and Dismiss leaves 2; Dismiss all leaves none', async ({ browser }) => {
      const { context, roomId } = await roomHost(browser);
      const page = await context.newPage();
      const queue = await mockQueue(page, roomId, threeItems());
      await page.goto(`/rooms/${roomId}`);

      const chip = page.getByTestId('needs-you-chip');
      await expect(chip).toHaveAccessibleName('Needs you (3)');
      // "Needs you" and the count on wider screens; the inbox icon and the count on phones.
      await expect(chip.locator('.rv2-chip-short')).toHaveText('3');
      if (width > 600) await expect(chip.locator('.rv2-chip-full')).toHaveText('Needs you');
      else await expect(chip.locator('.rv2-chip-full')).toBeHidden();
      await chip.click();
      const list = page.getByRole('region', { name: 'Needs you', exact: true });
      await expect(list.getByRole('checkbox')).toHaveCount(3);
      // "Dismiss" shows once something is ticked.
      await expect(list.getByRole('button', { name: /^Dismiss \(/ })).toHaveCount(0);
      await list.getByRole('checkbox', { name: /Sonnet Scout mentioned you/ }).check();
      await list.getByRole('button', { name: 'Dismiss (1)' }).click();
      await expect(chip).toHaveAccessibleName('Needs you (2)');
      await expect(list.getByText(/Sonnet Scout mentioned you/)).toHaveCount(0);
      await expect(list.getByRole('checkbox')).toHaveCount(2);
      expect(queue.calls).toEqual([{ ids: ['ai-sonnet:1'] }]);

      await list.getByRole('button', { name: 'Dismiss all' }).click();
      await expect(chip).toHaveCount(0);
      expect(queue.calls.at(-1)).toEqual({ all: true });
      // A reload asks the server again: nothing comes back.
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Needs you room' })).toBeVisible();
      await expect(page.getByTestId('needs-you-chip')).toHaveCount(0);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);
    });

    test('opening an item dismisses it; a failed dismissal comes back with a toast', async ({
      browser,
    }) => {
      const { context, roomId } = await roomHost(browser);
      const page = await context.newPage();
      const queue = await mockQueue(page, roomId, threeItems());
      await page.goto(`/rooms/${roomId}`);
      const chip = page.getByTestId('needs-you-chip');
      await expect(chip).toHaveAccessibleName('Needs you (3)');

      // A task entry opens the Tasks panel and leaves the list.
      await chip.click();
      const list = page.getByRole('region', { name: 'Needs you', exact: true });
      await list.getByRole('button', { name: /Review T7: Header fits at 360 px/ }).click();
      await expect(list).toBeHidden();
      await expect(chip).toHaveAccessibleName('Needs you (2)');
      expect(queue.calls).toEqual([{ ids: ['task-7'] }]);
      await expect(page.getByRole('button', { name: /^Tasks/ }).first()).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      // Under 900 px the Tasks panel is full screen (Workspace v3 §4.5) and covers the room's
      // header: close it to reach Needs you again.
      if (width < 900) {
        const tasks = page.getByRole('complementary', { name: 'Tasks' });
        expect((await tasks.boundingBox())!.width).toBe(width);
        await tasks.getByRole('button', { name: 'Close tasks' }).click();
        await expect(tasks).toHaveCount(0);
      }

      // The server refuses the next one: it is back in its place, with a toast.
      queue.failNext = true;
      await chip.click();
      const tick = list.getByRole('checkbox', { name: /GPT Helper mentioned you/ });
      await tick.check();
      await list.getByRole('button', { name: 'Dismiss (1)' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Could not dismiss' })).toHaveText(
        /Could not dismiss\. Try again\./,
      );
      await expect(chip).toHaveAccessibleName('Needs you (2)');
      await expect(list.getByText(/GPT Helper mentioned you/)).toBeVisible();
      await page
        .getByRole('alert')
        .filter({ hasText: 'Could not dismiss' })
        .getByRole('button', { name: 'OK' })
        .click();
      await expect(page.getByRole('alert').filter({ hasText: 'Could not dismiss' })).toHaveCount(0);
    });
  });

test('the badge shows the real number up to 99, then 99+', async ({ browser }) => {
  const { context, roomId } = await roomHost(browser);
  const page = await context.newPage();
  const many = (n: number): Item[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'mention',
      id: `ai-many:${i + 1}`,
      since: minutesAgo(n - i),
      agent_id: 'x',
      message_seq: 1,
      from_name: `Helper ${i + 1}`,
      excerpt: 'ping',
    }));
  const queue = await mockQueue(page, roomId, many(99));
  await page.goto(`/rooms/${roomId}`);
  const chip = page.getByTestId('needs-you-chip');
  // 99 waiting, read over two pages of 50: the exact number, not "50+".
  await expect(chip).toHaveAccessibleName('Needs you (99)');
  queue.items = many(140);
  await page.reload();
  await expect(chip).toHaveAccessibleName('Needs you (99+)');
  await chip.click();
  const list = page.getByRole('region', { name: 'Needs you', exact: true });
  await list.getByRole('checkbox').first().check();
  await list.getByRole('button', { name: 'Dismiss (1)' }).click();
  // 139 left on the server, 99 of the loaded 100 shown: still 99+.
  await expect(chip).toHaveAccessibleName('Needs you (99+)');
});
