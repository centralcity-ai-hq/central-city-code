import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * When a room screen cannot read your rooms or agents, it says so and offers "Try again", instead
 * of a form that only offers a new agent (Join), a Create button that never turns on (New room),
 * or "None of your AIs can join yet" (Add my AI). And a jump to a message in a room that fits
 * on screen still marks new messages read: nothing scrolls, so nothing else would re-pin it.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

/** Setup calls wait out a 429 (the suite shares one address's API budget). */
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

async function account(browser: Browser, label: string, agentName?: string) {
  const context = await browser.newContext();
  opened.push(context);
  const request = context.request;
  const created = await patient(() =>
    request.post('/api/auth/register', {
      headers,
      data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  let agentId = '';
  if (agentName) {
    const agent = await patient(() =>
      request.post('/api/agents', {
        headers,
        data: { name: agentName, capability: 'research', mode: 'external' },
      }),
    );
    expect(agent.ok(), await why(agent)).toBeTruthy();
    agentId = (await agent.json()).agent.id as string;
  }
  return { context, request, agentId, page: await context.newPage() };
}

async function hostRoom(request: APIRequestContext, agentId: string, name: string) {
  const res = await patient(() =>
    request.post('/api/rooms', {
      headers,
      data: { agent_id: agentId, name, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(res.status(), await why(res)).toBe(201);
  const body = await res.json();
  const link = body.link.link as string;
  return {
    id: body.room.id as string,
    slug: body.room.slug as string,
    link,
    token: link.split('#')[1]!,
  };
}

async function post(request: APIRequestContext, roomId: string, text: string) {
  const key = crypto.randomUUID();
  const res = await patient(() =>
    request.post(`/api/rooms/${roomId}/messages`, {
      headers,
      data: { text, idempotency_key: key },
    }),
  );
  expect(res.status(), await why(res)).toBe(201);
}

/** GET `pathname` answers 500 while `failing()` holds; everything else goes to the server. */
async function failWhile(page: Page, pathname: string, failing: () => boolean) {
  await page.route(
    (url) => url.pathname === pathname,
    (route) =>
      route.request().method() === 'GET' && failing()
        ? route.fulfill({ status: 500, json: { error: 'internal' } })
        : route.fallback(),
  );
}

test('Join: a failed read shows the error and Try again, never a new-agent-only form', async ({
  browser,
}) => {
  const host = await account(browser, 'Retry-host', 'Retry host agent');
  const room = await hostRoom(host.request, host.agentId, 'Retry join room');
  const guest = await account(browser, 'Retry-guest', 'Guest own agent');
  let failing = true;
  await failWhile(guest.page, '/api/rooms', () => failing);

  await guest.page.goto(`/r/${room.slug}#${room.token}`);
  await expect(guest.page.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  await expect(guest.page.getByRole('alert')).toBeVisible();
  await expect(guest.page.getByRole('button', { name: 'Join room' })).toHaveCount(0);
  await expect(guest.page.getByRole('textbox', { name: 'New agent name' })).toHaveCount(0);

  failing = false;
  await guest.page.getByRole('button', { name: 'Try again' }).click();
  await expect(guest.page.getByRole('radio', { name: 'Guest own agent' })).toBeChecked();
  await expect(guest.page.getByRole('button', { name: 'Join room' })).toBeEnabled();
  await expect(guest.page.getByRole('alert')).toHaveCount(0);
});

test('New room: a failed agents read offers Try again and keeps the typed name', async ({
  browser,
}) => {
  const owner = await account(browser, 'Retry-new', 'Retry new host');
  let failing = false;
  await failWhile(owner.page, '/api/snapshot', () => failing);
  await owner.page.goto('/rooms');
  await expect(owner.page.getByRole('button', { name: 'New room' }).first()).toBeVisible();

  failing = true;
  await owner.page.getByRole('button', { name: 'New room' }).first().click();
  const sheet = owner.page.getByRole('dialog', { name: 'New room' });
  await expect(sheet.getByRole('alert')).toBeVisible();
  await sheet.getByLabel('Room name').fill('Kept name');
  await expect(sheet.getByRole('button', { name: 'Create room' })).toBeDisabled();

  failing = false;
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet.getByRole('button', { name: 'Create room' })).toBeEnabled();
  await expect(sheet.getByLabel('Room name')).toHaveValue('Kept name');
  await expect(sheet.getByRole('alert')).toHaveCount(0);
});

test('Add my AI: a failed agents read is not "none can join", and Try again lists them', async ({
  browser,
}) => {
  const host = await account(browser, 'Retry-addhost', 'Retry add host');
  const room = await hostRoom(host.request, host.agentId, 'Retry add room');
  const person = await account(browser, 'Retry-person', 'Person own AI');
  const joined = await patient(() =>
    person.request.post('/api/rooms/join', {
      headers,
      data: { link: room.link, name: 'Pia', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(joined.ok(), await why(joined)).toBeTruthy();

  let failing = false;
  await failWhile(person.page, '/api/snapshot', () => failing);
  await person.page.goto(`/rooms/${room.id}`);
  const open = person.page.getByRole('button', { name: 'Add my AI' }).first();
  await expect(open).toBeVisible();

  failing = true;
  await open.click();
  const sheet = person.page.getByRole('dialog', { name: 'Add my AI' });
  await expect(sheet.getByRole('alert')).toBeVisible();
  await expect(sheet).not.toContainText('None of your AIs can join yet.');

  failing = false;
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet.getByRole('radio', { name: 'Person own AI' })).toBeChecked();
  await expect(sheet.getByRole('alert')).toHaveCount(0);
});

test('a jump in a room that fits on screen still marks new messages read', async ({ browser }) => {
  const host = await account(browser, 'Jump-host', 'Jump host agent');
  const room = await hostRoom(host.request, host.agentId, 'Jump room');
  const guest = await account(browser, 'Jump-guest', 'Jump guest agent');
  const joined = await patient(() =>
    guest.request.post(`/api/rooms/${room.slug}/join`, {
      headers,
      data: { token: room.token, agent_id: guest.agentId, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(joined.status(), await why(joined)).toBe(200);
  await post(host.request, room.id, 'The needle is right here');
  await post(host.request, room.id, 'A short second line');

  const page = host.page;
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByText('A short second line', { exact: true })).toBeVisible();
  // The whole thread fits: there is nothing to scroll.
  const scroll = page.getByTestId('room-scroll');
  expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThan(48);

  await page.getByTestId('room-search-button').click();
  const panel = page.getByRole('complementary', { name: 'Search this room' });
  await panel.getByRole('searchbox', { name: 'Search messages' }).fill('needle');
  await panel.getByTestId('room-search-result').click();
  await expect(page.getByTestId('room-message').filter({ hasText: 'The needle is' })).toHaveClass(
    /rm-found/,
  );

  await post(guest.request, room.id, 'Fresh from the guest');
  await expect(page.getByText('Fresh from the guest', { exact: true })).toBeVisible();
  await expect(page.locator('.rm-jump')).toHaveCount(0);
});
