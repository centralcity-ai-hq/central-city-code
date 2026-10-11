import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * First-run audit fixes:
 * P1 a member leaves a room (confirm, then the room is gone from its list); the host is told it
 * closes the room instead. P2 the host agent reads as an AI ("AI agent"), never "another
 * person". P3 at 360 px the Invite sheet puts the wide Copy invite link button above the
 * Room access disclosure, on the first screen.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUpAt(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createWorkspace = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createWorkspace)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createWorkspace).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createWorkspace.click();
  await expect(createWorkspace).toHaveCount(0);
}

async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors, name: `${label}-${crypto.randomUUID().slice(0, 8)}` };
}

test('a member leaves a room; the host closes instead; labels and the invite sheet read right', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  await host.page.goto('/#signin');
  await signUpAt(host.page, host.name);
  await host.page.goto('/rooms');
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Leave plan');
  await dialog.getByLabel("Your AI's name").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);

  // P3: at 360 px, the wide Copy invite link button sits above the Room access disclosure,
  // on the first screen.
  await host.page.setViewportSize({ width: 360, height: 780 });
  // On a phone, Invite stays in the room header row (icon-only when tight, still named "Invite").
  const headerInvite = host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'Invite', exact: true });
  await expect(headerInvite).toBeVisible();
  await headerInvite.click();
  const sheet = host.page.getByRole('dialog', { name: 'Invite a person' });
  await expect(sheet.locator('.rm-code')).toBeVisible();
  const copy = sheet.getByRole('button', { name: 'Copy invite link' });
  const more = sheet.getByText('Room access');
  const [copyBox, moreBox] = await Promise.all([copy.boundingBox(), more.boundingBox()]);
  expect(copyBox!.y).toBeLessThan(moreBox!.y);
  expect(copyBox!.y + copyBox!.height).toBeLessThanOrEqual(780);
  const roomId = host.page.url().split('/rooms/')[1]!;
  const { link } = (await (
    await host.page.request.post(`/api/rooms/${roomId}/link`, {
      headers: { 'x-city-request': '1' },
      data: {},
    })
  ).json()) as { link: string };
  await sheet.getByRole('button', { name: 'Close' }).first().click();

  const guest = await account(browser, 'Guest');
  await guest.page.goto('/#signin');
  await signUpAt(guest.page, guest.name);
  // Joining with the link by API: the room's /j page flow is covered in rooms.spec.ts, and a
  // second link mint in one test runs into the host's link rate limit.
  const joined = await guest.page.request.post('/api/rooms/join', {
    headers: { 'x-city-request': '1' },
    data: { link, name: guest.name, idempotency_key: crypto.randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  await guest.page.goto('/rooms');
  await guest.page.getByRole('link', { name: 'Leave plan' }).first().click();
  await expect(guest.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);

  // P2: the host's agent is labelled as an AI and as the host: "Host" and "AI agent".
  await guest.page.getByRole('button', { name: /^Members of / }).click();
  const panel = guest.page.getByRole('complementary', { name: 'Members' });
  const hostRow = panel
    .getByRole('list', { name: 'AIs', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Host agent' });
  // With its owner in the room as a person (A1), the label may name them: "AI · <owner>'s agent".
  await expect(hostRow.getByTestId('member-badge')).toHaveText([
    'Host',
    /^AI( agent| · .+'s agent)$/,
  ]);

  // P1: Leave, with a confirm; Cancel keeps the membership.
  await panel.getByRole('button', { name: 'Leave room' }).click();
  await expect(panel.getByText(/stops reading and posting here/)).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await panel.getByRole('button', { name: 'Leave room' }).click();
  await panel.getByRole('button', { name: 'Confirm leave' }).click();
  await expect(guest.page).toHaveURL(/\/rooms$/);
  await expect(guest.page.getByRole('link', { name: /Leave plan/ })).toHaveCount(0);

  // The host sees its AI and itself as a person (A1) left and cannot leave itself. No host block here: Close room is in
  // Room settings (room-settings.spec.ts).
  await host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: /^Members of / })
    .click();
  const hostPanel = host.page.getByRole('complementary', { name: 'Members' });
  await expect(hostPanel.getByTestId('member-row')).toHaveCount(2);
  await expect(hostPanel.getByText(/You host this room/)).toHaveCount(0);
  await expect(hostPanel.getByRole('button', { name: 'Leave room' })).toHaveCount(0);
  await expect(hostPanel.getByRole('button', { name: 'Close room' })).toHaveCount(0);

  // The guest left on its own: the host sees it under "Recently left", listed only (no action).
  await expect(hostPanel.getByText('Recently left')).toBeVisible();
  const recent = hostPanel.getByRole('list', { name: 'Recently left' });
  await expect(recent.getByRole('listitem')).toHaveCount(1);
  await expect(recent.getByRole('button')).toHaveCount(0);

  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});
