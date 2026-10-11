import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * "Join a room": the host shares a short code from the Invite sheet; a signed-in
 * person types it under Rooms → Join a room, lands in the room with an "Invited by" banner, posts
 * as a person, and sees how to bring their own AI. Tolerant input and one uniform error.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUpAt(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createAccount = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createAccount)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createAccount).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createAccount.click();
  await expect(createAccount).toHaveCount(0);
}

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `${label}-${crypto.randomUUID().slice(0, 6)}`;
  await page.goto('/#signin');
  await signUpAt(page, name);
  return { context, page, errors, name };
}

test('a person joins with the host’s short code and posts as a person', async ({ browser }) => {
  const host = await account(browser, 'Host');
  await host.page.goto('/rooms');
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Tea room');
  await dialog.getByLabel("Your AI's name").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  await host.page.getByRole('button', { name: 'Invite' }).first().click();
  const sheet = host.page.getByRole('dialog', { name: 'Invite a person' });
  const code = (await sheet.locator('.rm-code').textContent())!.trim();
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await sheet.getByText('Room access').click();
  await expect(sheet.getByRole('checkbox', { name: 'People join as themselves' })).toBeChecked();
  await sheet.getByRole('button', { name: 'Close' }).first().click();

  const guest = await account(browser, 'Guest');
  await guest.page.goto('/rooms');
  await guest.page.getByRole('button', { name: 'Join a room' }).first().click();
  const join = guest.page.getByRole('dialog', { name: 'Join a room' });
  // A wrong code: one uniform message, no hint whether it exists.
  await join.getByLabel('Invite link or code').fill('zzzz-zzzz');
  await join.getByRole('button', { name: 'Join room' }).click();
  await expect(join.getByRole('alert')).toHaveText(
    'This invite is invalid or has expired. Ask the host for a new one.',
  );
  // Tolerant input: lowercase with spaces around it.
  await join.getByLabel('Invite link or code').fill(`  ${code.toLowerCase()}  `);
  // You join as yourself by default; the name override sits behind a subtle toggle.
  await join.getByRole('button', { name: 'Use a different name' }).click();
  await join.getByLabel('Your name in the room').fill('Mia');
  await join.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.page.getByRole('heading', { name: 'Tea room', level: 1 })).toBeVisible();
  await expect(
    guest.page.getByRole('status').filter({ hasText: 'You joined as Mia.' }),
  ).toContainText('Invited by Host agent.');
  // Bringing their own AI: "Add my AI", no invite link needed. With no AI yet, the sheet
  // points to Connect your AI, with no tool names, JSON or keys.
  const banner = guest.page.getByRole('status').filter({ hasText: 'You joined as Mia.' });
  await expect(banner).toContainText('Want to bring your AI too? Add my AI');
  await banner.getByRole('button', { name: 'Add my AI' }).click();
  const addSheet = guest.page.getByRole('dialog', { name: 'Add my AI' });
  await expect(addSheet).toContainText('None of your AIs can join yet.');
  await expect(addSheet.getByRole('link', { name: 'Connect your AI' })).toHaveAttribute(
    'href',
    '/connect',
  );
  await expect(addSheet.getByRole('button', { name: 'Add to room' })).toBeDisabled();
  await addSheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(addSheet).toHaveCount(0);
  // The link opens the console straight on Connect your AI.
  const connect = await guest.context.newPage();
  await connect.goto('/#connect');
  await expect(connect.getByRole('heading', { name: 'Choose your AI' })).toBeVisible();
  await expect(
    connect.getByRole('navigation', { name: 'Workspace' }).getByRole('button', {
      name: 'Connect AI',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'page');
  await connect.close();
  const visible = await guest.page.locator('main, [role="main"], body').first().innerText();
  for (const jargon of [/idempotency/i, /city_join_room/, /"room_id"/, /\bUUID\b/i])
    expect(visible).not.toMatch(jargon);
  const shots = process.env.ADD_AI_SHOTS_DIR;
  if (shots)
    for (const colorScheme of ['light', 'dark'] as const)
      for (const [width, height] of [
        [1440, 900],
        [360, 780],
      ] as const) {
        const shot = await guest.context.newPage();
        await shot.setViewportSize({ width, height });
        await shot.addInitScript((theme) => localStorage.setItem('cc-theme', theme), colorScheme);
        await shot.goto(guest.page.url());
        await expect(shot.getByText('Want to bring your AI?')).toBeVisible();
        await shot.screenshot({ path: `${shots}/room-person-banner-${width}-${colorScheme}.png` });
        await shot.close();
      }

  const box = guest.page.getByLabel('Message', { exact: true });
  await box.fill('Hello, Mia here in person');
  await box.press('Enter');
  const mine = guest.page
    .getByTestId('room-message')
    .filter({ hasText: 'Hello, Mia here in person' });
  // Your own message is a bubble without a byline; the host sees it labelled as a person.
  await expect(mine.locator('.rm-own-bubble')).toBeVisible();
  await expect(
    host.page
      .getByTestId('room-message')
      .filter({ hasText: 'Hello, Mia here in person' })
      .locator('.rm-person'),
  ).toHaveText('person');

  // The host sees the person in the members list, listed under People (not as an AI).
  await host.page.getByRole('button', { name: /^Members of / }).click();
  const panel = host.page.getByRole('complementary', { name: 'Members' });
  const mia = panel.getByRole('list', { name: 'People' }).getByRole('listitem').filter({
    hasText: 'Mia',
  });
  await expect(mia).toBeVisible();
  await expect(mia.locator('.rm-avatar')).toHaveAttribute('data-kind', 'person');
  await expect(mia.getByTestId('member-badge').filter({ hasText: /\bAI\b/ })).toHaveCount(0);
  await expect(
    panel.getByRole('list', { name: 'AIs' }).getByRole('listitem').filter({ hasText: 'Mia' }),
  ).toHaveCount(0);

  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('a person member adds their own AI with "Add my AI", no invite link needed', async ({
  browser,
}) => {
  const host = await account(browser, 'Host2');
  await host.page.goto('/rooms');
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Family room');
  await dialog.getByLabel("Your AI's name").fill('Host desk');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  await host.page.getByRole('button', { name: 'Invite' }).first().click();
  const invite = host.page.getByRole('dialog', { name: 'Invite a person' });
  const code = (await invite.locator('.rm-code').textContent())!.trim();
  await invite.getByRole('button', { name: 'Close' }).first().click();

  // The brother: his own account with his own AI, joining as himself.
  const brother = await account(browser, 'Brother');
  const created = await brother.page.request.post('/api/agents', {
    headers: { 'x-city-request': '1' },
    data: { name: 'Brother GPT', capability: 'research', mode: 'external' },
  });
  expect(created.ok()).toBe(true);
  await brother.page.goto('/rooms');
  await brother.page.getByRole('button', { name: 'Join a room' }).first().click();
  const join = brother.page.getByRole('dialog', { name: 'Join a room' });
  await join.getByLabel('Invite link or code').fill(code);
  await join.getByRole('button', { name: 'Join room' }).click();
  await expect(brother.page.getByRole('heading', { name: 'Family room', level: 1 })).toBeVisible();

  const roomApi = host.page.url().replace(/.*\/rooms\//, '/api/rooms/');
  const hostPost = (path: string, data: object) =>
    host.page.request.post(`${roomApi}${path}`, { headers: { 'x-city-request': '1' }, data });

  // A full room (host agent + the host's own person + the brother = 3): the server's own
  // sentence, nothing added.
  expect((await hostPost('/settings', { member_cap: 3 })).ok()).toBe(true);
  await brother.page.getByRole('button', { name: 'Add my AI' }).click();
  const sheet = brother.page.getByRole('dialog', { name: 'Add my AI' });
  // His only AI is preselected; one click adds it.
  await expect(sheet.getByRole('radio', { name: 'Brother GPT' })).toBeChecked();
  await sheet.getByRole('button', { name: 'Add to room' }).click();
  await expect(sheet.getByRole('alert')).toContainText(/room is full/i);

  // Room again: it joins, and the host sees it.
  expect((await hostPost('/settings', { member_cap: 10 })).ok()).toBe(true);
  await sheet.getByRole('button', { name: 'Add to room' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(async () => {
    const members = await host.page.request.get(`${roomApi}/members`);
    const list = (await members.json()).members as Array<{ name: string }>;
    expect(list.some((member) => member.name === 'Brother GPT')).toBe(true);
  }).toPass({ timeout: 15_000 });

  // The host turns "Members can bring their AI" off: the action is gone.
  expect((await hostPost('/people', { members_may_bring_ai: false })).ok()).toBe(true);
  await brother.page.reload();
  await expect(brother.page.getByRole('heading', { name: 'Family room', level: 1 })).toBeVisible();
  await expect(brother.page.getByText('You joined as')).toBeVisible();
  await expect(brother.page.getByRole('button', { name: 'Add my AI' })).toHaveCount(0);
  await host.context.close();
  await brother.context.close();
});
