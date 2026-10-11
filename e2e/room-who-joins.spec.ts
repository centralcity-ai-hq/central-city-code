import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * "Who should join?" and Add an AI (src/rooms/WhoJoins.tsx, src/rooms/AddAiSheet.tsx,
 * docs/design/ROOM_WHO_JOINS.md §2 and §3): the host of a room nobody else has joined sees two
 * tiles, An AI and A person. An AI opens one sheet for every AI app whose height never changes
 * between apps; A person opens the Invite sheet. Hide is remembered per room and More room
 * actions brings it back. Desktop light and a 390 px phone in dark mode.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const SHOTS = 'test-results/who-joins';
const APPS = ['Claude', 'ChatGPT', 'Gemini CLI', 'Claude Code', 'Codex', 'Cursor', 'Other'];
// Open for a deep link, Copy for an address or command. On a local server (this suite) Claude and
// ChatGPT cannot reach it, so they open the live site instead (unit: tests/room-who-joins.test.ts).
const OPEN_APPS = new Set(['Claude', 'ChatGPT', 'Cursor']);

async function account(browser: Browser, colorScheme: 'light' | 'dark') {
  const context = await browser.newContext({ colorScheme });
  // The app ignores the OS setting; the theme toggle stores its choice (src/shell/theme.ts).
  if (colorScheme === 'dark')
    await context.addInitScript(() => window.localStorage.setItem('cc-theme', 'dark'));
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `who-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const agent = await context.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok(), await agent.text()).toBeTruthy();
  return { context, page: await context.newPage() };
}

/** New room from the Product team template, through the New room sheet. */
async function newRoom(page: Page, width: number, name: string) {
  await page.goto('/rooms');
  await (
    width < 900
      ? page.getByRole('region', { name: 'Your rooms' })
      : page.getByRole('navigation', { name: 'Rooms' })
  )
    .getByRole('button', { name: 'New room' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill(name);
  await dialog
    .getByRole('group', { name: 'Start from' })
    .getByRole('radio', { name: 'Product team', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

for (const viewport of [
  { name: 'desktop, light', width: 1440, height: 1000, scheme: 'light' as const },
  { name: '390 px, dark', width: 390, height: 844, scheme: 'dark' as const },
])
  test(`Who should join?: the card, Add an AI and A person (${viewport.name})`, async ({
    browser,
  }) => {
    const tag = `${viewport.width}-${viewport.scheme}`;
    const { context, page } = await account(browser, viewport.scheme);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await newRoom(page, viewport.width, 'Who joins');

    const card = page.getByRole('region', { name: 'Who should join?' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Nobody joins until you invite them.');
    const ai = card.getByRole('button', { name: /^An AI/ });
    const person = card.getByRole('button', { name: /^A person/ });
    await expect(ai).toContainText('Builds, reviews or helps');
    await expect(person).toContainText('Decides and approves');
    // No template wording anywhere, and the old card is gone.
    await expect(page.getByRole('region', { name: 'Suggested for this room' })).toHaveCount(0);
    await expect(card).not.toContainText(/template/i);
    await expect(page.getByText(/From the .* template/)).toHaveCount(0);
    // Side by side on desktop, one column on a phone; equal widths either way.
    const [a, b] = [await ai.boundingBox(), await person.boundingBox()];
    expect(Math.abs(a!.width - b!.width)).toBeLessThan(1);
    if (viewport.width >= 520) expect(Math.abs(a!.y - b!.y)).toBeLessThan(1);
    else expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
    // Touch: the tiles and the hide button are at least 44px on a phone.
    if (viewport.width < 640) {
      for (const target of [
        ai,
        person,
        card.getByRole('button', { name: 'Hide Who should join?' }),
      ])
        expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Hover: accent-soft background.
    const before = await ai.evaluate((element) => getComputedStyle(element).backgroundColor);
    await ai.hover();
    await expect
      .poll(() => ai.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(before);
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/card-${tag}.png` });

    // An AI: one sheet, seven apps as a radio group, Claude first.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin,
    });
    await ai.click();
    const sheet = page.getByRole('dialog', { name: 'Add an AI' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Pick your AI app. It joins this room only.');
    await expect(sheet).not.toContainText(/Builds|Reviews|Helps/);
    const group = sheet.getByRole('radiogroup', { name: 'Which AI?' });
    await expect(group.getByRole('radio')).toHaveCount(7);
    for (const [index, name] of APPS.entries())
      await expect(group.getByRole('radio').nth(index)).toHaveAccessibleName(name);
    await expect(group.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
    await expect(group.getByRole('radio', { name: 'Claude', exact: true })).toBeFocused();
    await expect(sheet.getByText('Waiting for your AI to join…')).toBeVisible();
    // The sheet fits the viewport width.
    expect(
      await sheet.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
          ).length,
      ),
    ).toBe(0);
    // Two columns on a phone, three on desktop; seven tiles, the last one spans the row.
    const columns = await group.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
    expect(columns).toBe(viewport.width <= 480 ? 2 : 3);
    const lastTile = group.getByRole('radio', { name: 'Other', exact: true });
    const firstTile = group.getByRole('radio').first();
    const [lastBox, firstBox] = [await lastTile.boundingBox(), await firstTile.boundingBox()];
    expect(lastBox!.width).toBeGreaterThan(firstBox!.width * 1.5);
    await page.waitForTimeout(300); // The sheet's entrance animation.
    await page.screenshot({ path: `${SHOTS}/add-ai-${tag}.png` });

    // Every app: the same sheet height, one action row (Open or Copy), nothing overflowing.
    const height = (await sheet.boundingBox())!.height;
    const how = sheet.locator('.rm-add-ai-how');
    for (const name of APPS) {
      const radio = group.getByRole('radio', { name, exact: true });
      await radio.click();
      await expect(radio).toBeChecked();
      await expect(sheet).toContainText(
        `Then paste the room invite into ${name === 'Other' ? 'your AI' : name}.`,
      );
      expect((await sheet.boundingBox())!.height, name).toBe(height);
      expect(
        await how.evaluate((element) => element.scrollHeight <= element.clientHeight + 0.5),
        `${name}: the steps fit their block`,
      ).toBe(true);
      // Clear space above the invite button for every app (Gemini CLI's two-line step once
      // pushed it against the last step).
      const invite = (await sheet.locator('.rm-add-ai-invite').boundingBox())!;
      const last = (await sheet.locator('.rm-add-ai-step').last().boundingBox())!;
      expect(invite.y - (last.y + last.height), name).toBeGreaterThanOrEqual(20);
      const row = sheet.locator('.rm-add-ai-row');
      await expect(row).toHaveCount(1);
      await expect(row.locator('a, button')).toHaveText(OPEN_APPS.has(name) ? 'Open' : 'Copy');
    }
    // The commands are today's (the Connect page's), here for the local server.
    const endpoint = `${new URL(page.url()).origin}/mcp`;
    await group.getByRole('radio', { name: 'Claude Code', exact: true }).click();
    await expect(sheet.locator('.rm-add-ai-row')).toContainText(
      `claude mcp add --transport http central-city ${endpoint}`,
    );
    await group.getByRole('radio', { name: 'Codex', exact: true }).click();
    await expect(sheet.locator('.rm-add-ai-row')).toContainText(
      `codex mcp add central-city --url ${endpoint}`,
    );
    await expect(sheet).toContainText('codex mcp login central-city');
    await sheet.getByRole('button', { name: 'Copy Codex command' }).click();
    await expect(sheet.getByRole('button', { name: 'Copy Codex command' })).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `codex mcp add central-city --url ${endpoint}`,
    );
    // Gemini CLI: on this local server the sheet adds by hand (the published extension line is
    // for the live site; unit: tests/room-who-joins.test.ts), and the line is copyable.
    await group.getByRole('radio', { name: 'Gemini CLI', exact: true }).click();
    await expect(sheet.locator('.rm-add-ai-row')).toContainText(
      `gemini mcp add --transport http central-city ${endpoint}`,
    );
    await expect(sheet).toContainText('Then open Gemini CLI and run: /mcp auth central-city');
    await sheet.getByRole('button', { name: 'Copy Gemini CLI command' }).click();
    await expect(sheet.getByRole('button', { name: 'Copy Gemini CLI command' })).toHaveText(
      'Copied',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `gemini mcp add --transport http central-city ${endpoint}`,
    );
    await group.getByRole('radio', { name: 'Cursor', exact: true }).click();
    await expect(sheet.getByRole('link', { name: 'Open Cursor' })).toHaveAttribute(
      'href',
      /^https:\/\/cursor\.com\/en\/install-mcp\?name=central-city&config=/,
    );

    // Keyboard: arrow keys move the choice (radio group), wrapping around.
    await group.getByRole('radio', { name: 'Cursor', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: 'Other' })).toBeChecked();
    await expect(group.getByRole('radio', { name: 'Other' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(group.getByRole('radio', { name: 'Other' })).toBeChecked();

    // Copy room invite: the same ready line for an AI as the Invite sheet's Copy.
    await sheet.getByRole('button', { name: 'Copy room invite for your AI' }).click();
    await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();
    const line = await page.evaluate(() => navigator.clipboard.readText());
    expect(line).toMatch(
      /^Join my Central City room, read it, and reply when I ask you to check it: https?:\/\/\S+\/j\/[A-Za-z0-9_-]{43}$/,
    );

    // Escape closes; focus goes back to the tile.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(ai).toBeFocused();

    // A person: the Invite sheet copies the same one link (one link per room).
    await person.click();
    const invite = page.getByRole('dialog', { name: 'Invite a person' });
    await expect(invite).toBeVisible();
    await expect(invite.locator('.rm-code')).toBeVisible();
    await invite.screenshot({ path: `${SHOTS}/invite-person.png` });
    await invite.getByRole('button', { name: 'Copy invite link' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
    await page.keyboard.press('Escape');
    await expect(invite).toHaveCount(0);
    await expect(person).toBeFocused();

    // Hide: gone, still gone after a reload; More room actions brings it back.
    await card.getByRole('button', { name: 'Hide Who should join?' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Who joins' })).toBeAttached();
    await expect(page.locator('.rm-empty').getByRole('button', { name: 'Invite' })).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'More room actions' }).click();
    await page.getByRole('menuitem', { name: 'Show Who should join?' }).click();
    await expect(card).toBeVisible();
    await page.reload();
    await expect(card).toBeVisible();

    // An AI joins while the sheet waits: the sheet closes and the card goes away.
    await card.getByRole('button', { name: /^An AI/ }).click();
    await expect(sheet).toBeVisible();
    const guest = await browser.newContext();
    const registered = await guest.request.post('/api/auth/register', {
      headers,
      data: { name: `who-ai-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    });
    expect(registered.status()).toBe(201);
    const roomId = new URL(page.url()).pathname.split('/').pop()!;
    const joined = await guest.request.post(`/api/rooms/${roomId}/join`, {
      headers,
      data: {
        link: line.split(' ').at(-1),
        create: { name: 'Guest AI' },
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(joined.ok(), await joined.text()).toBeTruthy();
    await expect(sheet).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Show Who should join?' })).toHaveCount(0);

    expect(errors).toEqual([]);
    await guest.close();
    await context.close();
  });
