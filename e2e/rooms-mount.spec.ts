import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * The app shell mounts the Rooms experience (docs/ROOMS_UX.md, "Mounting it"): the real app,
 * not the harness. End to end: sign up → Rooms → create a room → Invite → copy the /j link →
 * a second browser opens it → signs up through /signin?next → joins → posts; the host sees it.
 * Screenshots go to test-results when ROOMS_SCREENSHOTS=1.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const shots = process.env.ROOMS_SCREENSHOTS === '1';

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function signUpAt(page: Page, name: string) {
  // The form opens in sign-in mode, or in registration mode on a fresh installation. Wait for
  // it to settle on one of the two, then switch to registration if needed.
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createWorkspace = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createWorkspace)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createWorkspace).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createWorkspace.click();
}

async function newAccount(browser: Browser, label: string) {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  return { context, page, name, errors };
}

const pollNow = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('rooms end to end in the app: create, invite, join from a second browser, post', async ({
  browser,
}) => {
  const host = await newAccount(browser, 'Host');
  await host.page.goto('/#signin');
  await signUpAt(host.page, host.name);
  // A new account lands on the Overview (the Network map in the workspace).
  await expect(host.page.getByRole('heading', { name: 'Network map', level: 1 })).toBeVisible();
  expect(new URL(host.page.url()).pathname).toBe('/');

  // In the workspace, "Rooms" is the first item of the sidebar.
  const nav = host.page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.locator('.nav-item').first()).toHaveText('Rooms');
  // Styled like the other items: no underline, the same colour as My agents.
  const rooms = nav.getByRole('button', { name: 'Rooms', exact: true });
  const agents = nav.getByRole('button', { name: 'My agents', exact: true });
  expect(await rooms.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('none');
  expect(await rooms.evaluate((el) => getComputedStyle(el).color)).toBe(
    await agents.evaluate((el) => getComputedStyle(el).color),
  );
  await rooms.click();
  await expect(host.page).toHaveURL(/\/rooms$/);
  await expect(host.page.getByRole('heading', { name: 'No rooms yet' })).toBeVisible();
  await shot(host.page, '01-rooms-empty');

  // Create a room (the account has no agent yet, so it names one to host).
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Launch plan');
  await dialog.getByLabel("Your AI's name").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  const roomUrl = host.page.url();
  await shot(host.page, '02-room-created');

  // Invite: one /j link, copied to the clipboard.
  await host.page.getByRole('button', { name: 'Invite', exact: true }).first().click();
  const sheet = host.page.getByRole('dialog', { name: 'Invite a person' });
  await expect(sheet.locator('.rm-code')).toBeVisible();
  await sheet.getByRole('button', { name: 'Copy invite link' }).click();
  await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await host.page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    /^Join my Central City room, read it, and reply when I ask you to check it: http:\/\/127\.0\.0\.1:\d+\/j\/[A-Za-z0-9_-]+$/,
  );
  const link = copied.slice(copied.lastIndexOf(' ') + 1);
  await shot(host.page, '03-invite-sheet');
  await sheet.getByRole('button', { name: 'Close' }).first().click();

  // A second browser opens the link, signs up through /signin?next, joins and posts.
  const guest = await newAccount(browser, 'Guest');
  await guest.page.goto(link);
  await guest.page.getByRole('link', { name: 'Join room' }).click();
  await expect(guest.page).toHaveURL(/\/r\/[A-Za-z0-9_-]+$/); // the code left the address bar
  await shot(guest.page, '04-join-signed-out');
  await guest.page.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(guest.page).toHaveURL(/\/signin\?next=%2Fr%2F[A-Za-z0-9_-]+$/);
  await signUpAt(guest.page, guest.name);
  await expect(guest.page).toHaveURL(/\/r\/[A-Za-z0-9_-]+$/);
  await shot(guest.page, '05-join-as');
  await guest.page.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  const box = guest.page.getByLabel('Message', { exact: true });
  await box.fill('Hello from the guest AI');
  await box.press('Enter');
  const list = (page: Page) => page.getByRole('list', { name: 'Room messages' });
  await expect(
    list(guest.page).getByText('Hello from the guest AI', { exact: true }),
  ).toBeVisible();
  await shot(guest.page, '06-guest-posted');
  // The join code never reached a URL in the guest's history.
  const code = new URL(link).pathname.split('/').pop()!;
  expect(guest.page.url()).not.toContain(code);

  // The host sees the message in the same room.
  expect(host.page.url()).toBe(roomUrl);
  await pollNow(host.page);
  await expect(list(host.page).getByText('Hello from the guest AI', { exact: true })).toBeVisible();
  await shot(host.page, '07-host-sees-message');

  // Back to the workspace: signed in, "/" opens Rooms.
  await host.page.goto('/');
  await expect(host.page).toHaveURL(/\/rooms$/);
  await expect(rooms).toBeVisible();

  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('signed-in "Invite your AI" opens the person\'s room, creating "My first room" once', async ({
  browser,
}) => {
  const person = await newAccount(browser, 'Inviter');
  await person.page.goto('/#signin');
  await signUpAt(person.page, person.name);
  // A new account lands on the workspace Overview.
  await expect(person.page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();

  // "Invite your AI" from a public page's header, signed in: /rooms#invite.
  await person.page.goto('/downtown');
  await person.page.getByRole('link', { name: 'Invite your AI' }).click();
  // With no room yet, the person creates it with one click (never on page load).
  await person.page.getByRole('button', { name: 'Create my first room' }).click();
  await expect(person.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  const first = person.page.url();
  await expect(person.page.getByRole('link', { name: 'My first room' }).first()).toBeVisible();
  await expect(
    person.page.getByRole('button', { name: 'Invite', exact: true }).first(),
  ).toBeVisible();
  await shot(person.page, '08-my-first-room');

  // On a public page the header's "Invite your AI" goes to the same room; no second room.
  await person.page.goto('/downtown');
  const invite = person.page.getByRole('link', { name: 'Invite your AI' });
  await expect(invite).toHaveAttribute('href', '/rooms#invite');
  await invite.click();
  await expect(person.page).toHaveURL(first);
  // Still one room (the workspace may list it twice: in Rooms and in its recent rooms).
  expect((await (await person.page.request.get('/api/rooms')).json()).rooms).toHaveLength(1);
  expect(person.errors).toEqual([]);
  await person.context.close();
});

test('signed out: room pages offer sign-in and "Invite your AI" goes to /invite', async ({
  page,
}) => {
  await page.goto('/rooms');
  await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Frooms$/);
  await page.goto('/');
  // Signed out, Invite your AI opens the Connect page.
  await expect(page.getByRole('link', { name: 'Invite your AI' }).first()).toHaveAttribute(
    'href',
    '/connect',
  );
  // An unsafe next is ignored: the new account stays on this site, on its Overview.
  await page.goto('/signin?next=https%3A%2F%2Fexample.com');
  await signUpAt(page, `Next-${crypto.randomUUID().slice(0, 8)}`);
  await expect(page.getByRole('heading', { name: 'Network map', level: 1 })).toBeVisible();
  expect(new URL(page.url()).origin).not.toBe('https://example.com');
  expect(new URL(page.url()).pathname).toBe('/');
});

for (const width of [390, 1440]) {
  test(`signed-out /rooms at ${width} px: what a room is, sized to its content`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1400 });
    await page.goto('/rooms');
    const main = page.getByRole('main');
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Central City home' }),
    ).toBeVisible();
    await expect(
      main.getByText('Rooms are shared spaces where people and their AIs work together.'),
    ).toBeVisible();
    await expect(main.getByRole('button', { name: 'Sign in' })).toBeVisible();
    // No tall empty band: the page ends a section's padding below the Sign in button.
    const gap = await page.evaluate(() => {
      const main = document.querySelector('main')!.getBoundingClientRect();
      const last = document.querySelector('main > :last-child')!.getBoundingClientRect();
      return main.bottom - last.bottom;
    });
    expect(gap).toBeLessThanOrEqual(120);
  });
}

for (const width of [390, 1440]) {
  test(`signed out, /r/<slug> without its invite at ${width} px: header, home and Sign in, the same for any slug`, async ({
    browser,
  }) => {
    // A real room, made by another account through the API.
    const owner = await browser.newContext();
    const headers = { 'X-City-Request': '1' };
    const registered = await owner.request.post('/api/auth/register', {
      headers,
      data: { name: `Host-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    });
    expect(registered.status()).toBe(201);
    const agent = await owner.request.post('/api/agents', {
      headers,
      data: { name: 'Host agent', capability: 'research', mode: 'hosted' },
    });
    expect(agent.status()).toBe(201);
    const created = await owner.request.post('/api/rooms', {
      headers,
      data: {
        agent_id: (await agent.json()).agent.id,
        name: 'Launch plan',
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const room = (await created.json()).room as { slug: string };
    await owner.close();

    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const seen: string[] = [];
    for (const slug of [room.slug, 'no-such-room-zz9']) {
      await page.goto(`/r/${slug}`);
      const main = page.getByRole('main');
      await expect(
        main.getByText('This invite link is incomplete; ask the host for a new link.'),
      ).toBeVisible();
      await expect(
        page.getByRole('banner').getByRole('link', { name: 'Central City home' }),
      ).toBeVisible();
      await expect(main.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
      await expect(main.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByRole('contentinfo')).toBeVisible();
      // No room name or other hint: valid and invalid slugs read the same.
      seen.push((await main.innerText()).trim());
    }
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toContain('Launch plan');
    // Sign in comes back to this address, where a member opens the room.
    await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/signin\?next=%2Fr%2Fno-such-room-zz9$/);
    await page.goto('/r/no-such-room-zz9');
    await page.getByRole('main').getByRole('link', { name: 'Go home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await context.close();
  });
}

test('the Connect page says what comes after connecting: paste an invite link', async ({
  page,
}) => {
  await page.goto('/#connect');
  const section = page.getByRole('region', { name: 'Invite your AI into a room.' });
  await expect(section).toBeVisible();
  await expect(section).toContainText(
    'Once your AI app is connected, you never type commands. Open a room, copy its invite link and paste it into your AI.',
  );
  await expect(section.getByRole('link', { name: /Invite your AI/ })).toHaveAttribute(
    'href',
    '/invite',
  );
  // Addresses for scripts and developers live in the docs, not here.
  await expect(section).not.toContainText('/mcp');
  await expect(section).toContainText(
    'Works with ChatGPT, Claude, Cursor, VS Code, Codex and other AI apps that support connectors.',
  );
  await expect(section).toContainText(
    'ChatGPT Business, Team or Enterprise: your workspace admin must allow custom apps first.',
  );
});

test('signed-out /rooms keeps the public header and says what signing in is for', async ({
  page,
}) => {
  await page.goto('/rooms');
  await expect(
    page.getByRole('banner').getByRole('link', { name: 'Central City home' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Your rooms' })).toBeVisible();
  await expect(page.getByText('Sign in to create a room and invite your AI.')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  // A room address comes back to that room after sign-in.
  await page.goto('/rooms/abc123');
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Frooms%2Fabc123$/);
});
