import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

/*
 * Smart Rooms v2 context pins (src/rooms/ContextPins.tsx with ?rooms=v2): pinning a message from
 * its menu shows a chip in the Context row under the header, and a chip jumps to its message or
 * opens its task.
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
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

async function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  const response = await patient(() => request.post(url, { headers, data }));
  expect(response.ok(), await why(response)).toBeTruthy();
  return response.json();
}

/** A host's room with 30 messages (the first one well above the fold) and one task. */
async function seededRoom(browser: Browser) {
  const context = await browser.newContext();
  opened.push(context);
  const created = await patient(() =>
    context.request.post('/api/auth/register', {
      headers,
      data: { name: `pins-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const request = context.request;
  const agent = await post(request, '/api/agents', {
    name: 'Host agent',
    capability: 'research',
    mode: 'external',
  });
  const hostAgent = agent.agent.id as string;
  const { room } = (await post(request, '/api/rooms', {
    agent_id: hostAgent,
    name: 'Pinned plan',
    idempotency_key: crypto.randomUUID(),
  })) as { room: { id: string } };
  const seqs: number[] = [];
  for (let index = 1; index <= 30; index++) {
    const text =
      index === 1
        ? 'Kickoff: the release branch is release/4.2 and staging is the test target.'
        : `Update ${index}: ${'progress on the launch checklist, '.repeat(3)}`;
    const { message } = await post(request, `/api/rooms/${room.id}/messages`, {
      text,
      agent_id: hostAgent,
      idempotency_key: crypto.randomUUID(),
    });
    seqs.push(message.seq as number);
  }
  const { task } = await post(request, `/api/rooms/${room.id}/tasks`, {
    agent_id: hostAgent,
    title: 'Write the release notes',
    idempotency_key: crypto.randomUUID(),
  });
  return { context, request, room, hostAgent, seqs, task: task as { id: string } };
}

test('v2 pins: pin a message from its menu, the chip shows and jumps; a task chip opens it', async ({
  browser,
}) => {
  const { context, request, room, hostAgent, seqs } = await seededRoom(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/rooms/${room.id}?rooms=v2`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pinned plan' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.rm-app')).toHaveAttribute('data-rooms', 'v2');
  // No pins yet: no Context row.
  await expect(page.getByTestId('context-pins')).toHaveCount(0);

  // Pin the newest message from its menu.
  const newest = page.getByTestId('room-message').filter({ hasText: 'Update 30' });
  await newest.hover();
  await newest.getByTestId('message-pin').click();
  const row = page.getByTestId('context-pins');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Context:');
  await expect(row.getByTestId('context-pin')).toHaveCount(1);
  await expect(row.getByTestId('context-pin').first()).toContainText('Update 30');
  // The row sits right below the header.
  const below = await page.evaluate(() => {
    const header = document.querySelector('.rm-room-head');
    return header?.nextElementSibling?.getAttribute('data-testid') ?? null;
  });
  expect(below).toBe('context-pins');

  // An older pin (the kickoff message, far above the fold) jumps into the thread.
  const pinned = await post(request, `/api/rooms/${room.id}/pins`, {
    message_seq: seqs[0],
    note: 'Release branch',
    agent_id: hostAgent,
  });
  expect(pinned.created).toBe(true);
  await page.reload();
  const kickoff = page.getByTestId('room-message').filter({ hasText: 'Kickoff:' });
  const chips = page.getByTestId('context-pin');
  await expect(chips).toHaveCount(2);
  const chip = chips.filter({ hasText: 'Release branch' });
  await chip.click();
  await expect(kickoff).toBeInViewport();
  await expect(kickoff).toHaveClass(/rm-found/);

  // Pin the task from its card; its chip opens the task.
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await panel.getByTestId('task-pin').first().click();
  await expect(chips).toHaveCount(3);
  const taskChip = chips.filter({ hasText: 'Write the release notes' });
  await expect(taskChip).toContainText('T1');
  await taskChip.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'T1: Write the release notes' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'All tasks' })).toBeVisible();

  // More than three pins: three chips, then "+N".
  await post(request, `/api/rooms/${room.id}/pins`, {
    message_seq: seqs[1],
    agent_id: hostAgent,
  });
  await page.reload();
  await expect(chips).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Show 1 more pinned' })).toHaveText('+1');
  expect(errors).toEqual([]);
});
