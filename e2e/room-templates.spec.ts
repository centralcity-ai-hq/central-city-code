import { test, expect as baseExpect, type Browser } from '@playwright/test';

/*
 * Room templates (src/rooms/RoomTemplates.tsx, docs/ROOMS.md "Room templates"): New room asks for
 * the name first, offers name-only "Start from" chips and keeps Settings collapsed; a template never
 * touches the name, and the new room starts with no tasks. "Who should join?" (no template
 * wording) opens the room's own Add an AI or Invite sheet; nobody is invited and no agent is
 * created. Desktop light and a 390 px phone in dark mode.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, colorScheme: 'light' | 'dark') {
  const context = await browser.newContext({ colorScheme });
  // The app ignores the OS setting; the theme toggle stores its choice (src/shell/theme.ts).
  if (colorScheme === 'dark')
    await context.addInitScript(() => window.localStorage.setItem('cc-theme', 'dark'));
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `rtpl-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const agent = await context.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok(), await agent.text()).toBeTruthy();
  return { context, page: await context.newPage() };
}

for (const viewport of [
  { name: 'desktop, light', width: 1440, height: 1000, scheme: 'light' as const },
  { name: '390 px, dark', width: 390, height: 844, scheme: 'dark' as const },
])
  test(`create a room from a template: name, no tasks, who should join (${viewport.name})`, async ({
    browser,
  }) => {
    const { context, page } = await account(browser, viewport.scheme);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/rooms');
    // Phones: the room list page itself offers New room (the workspace shell owns the only menu
    // button); desktop shows the rooms sidebar.
    await (
      viewport.width < 900
        ? page.getByRole('region', { name: 'Your rooms' })
        : page.getByRole('navigation', { name: 'Rooms' })
    )
      .getByRole('button', { name: 'New room' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'New room' });

    // Name first and focused; Create stays disabled until there is a name.
    const name = dialog.getByLabel('Room name');
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('');
    const create = dialog.getByRole('button', { name: 'Create room' });
    await expect(create).toBeDisabled();
    await name.fill('   ');
    await expect(create).toBeDisabled();
    await name.fill('');

    // Host (the host agent) starts collapsed and names the current host.
    const settings = dialog.locator('details.rm-new-room-settings');
    await expect(settings).not.toHaveAttribute('open', /.*/);
    await expect(dialog.getByRole('radiogroup', { name: 'Host agent' })).toBeHidden();
    // Workspace v3: the history switch sits on the sheet itself (on by default), not in Settings.
    await expect(dialog.getByLabel('New members can read earlier messages')).toBeVisible();
    await expect(dialog.getByLabel('New members can read earlier messages')).toBeChecked();

    const picker = dialog.getByRole('group', { name: 'Start from' });
    await expect(picker.getByRole('radio', { name: 'Blank' })).toBeChecked();
    for (const name of ['Product team', 'Research squad', 'Writing room', 'Code review crew'])
      await expect(picker.getByRole('radio', { name })).toBeVisible();
    // Chips are names only; one line under them says what the picked template sets.
    await expect(dialog).toContainText('An empty room. You set the topic.');
    expect(
      (await picker.locator('.rm-room-template-chip').allInnerTexts()).map((t) => t.trim()),
    ).toEqual(['Blank', 'Product team', 'Research squad', 'Writing room', 'Code review crew']);
    await page.screenshot({ path: `shots/new-room-${viewport.width}-${viewport.scheme}.png` });

    await picker.getByRole('radio', { name: 'Product team', exact: true }).click();
    await expect(picker.getByRole('radio', { name: 'Product team' })).toBeChecked();
    // A template never fills in the name: it stays empty and Create stays disabled.
    await expect(name).toHaveValue('');
    await expect(create).toBeDisabled();
    await expect(dialog).not.toContainText('Starts with');
    await expect(dialog).not.toContainText('Write the product brief');
    await expect(dialog).not.toContainText('Suggested members');
    // The picked template's topic and who it suggests, never its tasks (NEW_ROOM.md).
    await expect(dialog).toContainText(
      'Plan, build and ship product changes together. Suggests a coding AI, a reviewer AI and a person.',
    );
    await page.screenshot({
      path: `shots/new-room-${viewport.width}-${viewport.scheme}-template.png`,
    });
    // Host opens on demand: the agents as radio rows; the history switch stays on.
    await settings.locator('summary').click();
    await expect(dialog.getByRole('radiogroup', { name: 'Host agent' })).toBeVisible();
    await expect(dialog.getByLabel('New members can read earlier messages')).toBeChecked();
    await page.screenshot({
      path: `shots/new-room-${viewport.width}-${viewport.scheme}-settings.png`,
    });
    await settings.locator('summary').click();
    // Every template leaves the name alone: empty stays empty, a typed name stays as typed.
    const templates = [
      'Blank',
      'Product team',
      'Research squad',
      'Writing room',
      'Code review crew',
    ];
    for (const template of templates) {
      await picker.getByRole('radio', { name: template, exact: true }).click();
      await expect(picker.getByRole('radio', { name: template, exact: true })).toBeChecked();
      await expect(name).toHaveValue('');
      await expect(create).toBeDisabled();
    }
    await name.fill('Launch crew');
    await expect(create).toBeEnabled();
    for (const template of [...templates].reverse()) {
      await picker.getByRole('radio', { name: template, exact: true }).click();
      await expect(name).toHaveValue('Launch crew');
    }
    await picker.getByRole('radio', { name: 'Product team', exact: true }).click();
    await expect(name).toHaveValue('Launch crew');

    // The dialog fits the phone: nothing wider than the viewport.
    expect(
      await dialog.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
          ).length,
      ),
    ).toBe(0);
    // Keyboard: arrow keys move between the chips (native radios).
    await picker.getByRole('radio', { name: 'Product team' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(picker.getByRole('radio', { name: 'Research squad' })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(picker.getByRole('radio', { name: 'Product team' })).toBeChecked();

    await create.click();
    await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
    const roomId = new URL(page.url()).pathname.split('/').pop()!;

    const card = page.getByRole('region', { name: 'Who should join?' });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText(/template/i);
    await expect(page.getByRole('region', { name: 'Suggested for this room' })).toHaveCount(0);

    // Each tile opens the room's own sheet; nothing is sent by the template.
    await card.getByRole('button', { name: /^An AI/ }).click();
    const addAi = page.getByRole('dialog', { name: 'Add an AI' });
    await expect(addAi).toBeVisible();
    await addAi.getByRole('button', { name: 'Close' }).first().click();
    await card.getByRole('button', { name: /^A person/ }).click();
    const invite = page.getByRole('dialog', { name: 'Invite a person' });
    await expect(invite).toBeVisible();
    await invite.getByRole('button', { name: 'Close' }).first().click();

    // A new room starts with no tasks, template or not; the host agent and the creator as a
    // person (A1) are its members.
    const stored = await (await context.request.get(`/api/rooms/${roomId}/tasks`)).json();
    expect(stored.tasks).toEqual([]);
    const members = await (await context.request.get(`/api/rooms/${roomId}/members`)).json();
    expect(
      (members.members as Array<{ kind: string; role: string }>)
        .map((member) => `${member.kind}:${member.role}`)
        .sort(),
    ).toEqual(['agent:host', 'person:member']);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    // Hide: gone, and still gone after a reload.
    await card.getByRole('button', { name: 'Hide Who should join?' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Launch crew' })).toBeAttached();
    await expect(
      page.locator('.rm-empty').getByRole('button', { name: 'Invite', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Who should join?' })).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });
