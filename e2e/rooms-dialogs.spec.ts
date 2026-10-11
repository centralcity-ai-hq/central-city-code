import { test, expect, type Page } from '@playwright/test';

/*
 * New room and Join a room are modal sheets (src/rooms/RoomsApp.tsx, src/rooms/JoinRoomSheet.tsx):
 * the backdrop covers the sidebar too, Tab stays inside the sheet, and Escape closes it even after
 * focus wandered. Before, the sidebar stayed clickable above the backdrop, so a second sheet could
 * open on top of the first, and Tab walked out into the sidebar.
 */
const headers = { 'x-city-request': '1' };

async function signedIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `dialogs-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/rooms');
  await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
}

/** Where focus is after each Tab: inside the open dialog or not. */
async function tabStaysInside(page: Page, presses: number) {
  for (let index = 0; index < presses; index += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')),
    );
    expect(inside, `focus left the dialog after ${index + 1} Tab presses`).toBe(true);
  }
}

for (const sheet of ['New room', 'Join a room'] as const) {
  test(`${sheet}: the sheet is modal (backdrop over the sidebar, Tab trapped, Escape closes)`, async ({
    page,
  }) => {
    await signedIn(page);
    const opener = page.getByRole('button', { name: sheet }).first();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: sheet });
    await expect(dialog).toBeVisible();

    // The sidebar's own buttons sit under the backdrop: what is on top there is not the sidebar.
    const join = page.getByRole('button', { name: 'Join a room' }).first();
    const box = (await join.boundingBox())!;
    const onTop = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.sidebar, .rm-sidebar')),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(onTop).toBe(false);

    await tabStaysInside(page, 14);
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test('phone, no rooms yet: the empty state opens New room and Join a room itself', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedIn(page);
  const empty = page.locator('.rm-overview-empty');
  await expect(empty.getByRole('heading', { name: 'No rooms yet' })).toBeVisible();
  // The copy no longer points at the sidebar, which a phone hides behind the menu.
  await expect(empty).not.toContainText('sidebar');

  for (const sheet of ['New room', 'Join a room'] as const) {
    const opener = empty.getByRole('button', { name: sheet });
    await expect(opener).toBeVisible();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: sheet });
    await expect(dialog).toBeVisible();
    await tabStaysInside(page, 6);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Focus returns to the empty state's button that opened the sheet.
    await expect(opener).toBeFocused();
  }
});

test('desktop, no rooms yet: the empty state stays calm (the sidebar has the buttons)', async ({
  page,
}) => {
  await signedIn(page);
  const empty = page.locator('.rm-overview-empty');
  await expect(empty.getByRole('heading', { name: 'No rooms yet' })).toBeVisible();
  await expect(empty.getByRole('button')).toHaveCount(0);
  await expect(empty).not.toContainText('sidebar');
});
