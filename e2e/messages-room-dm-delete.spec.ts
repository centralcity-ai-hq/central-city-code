import {
  test,
  expect as baseExpect,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

/*
 * Private messages from a room to everyone in it (docs/MESSAGING.md "Private messages from a
 * room"): the host messages a person, another owner's AI and its own AI from the Members panel;
 * New conversation lists the people and AIs it shares a room with (never one of its agents writing to
 * another of its own); and "Delete conversation" in the thread's ⋯ menu removes a chat from the
 * host's Messages only. At 1440 and 390. Synthetic accounts only.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, label: string, width: number) {
  const context = await browser.newContext({
    viewport: { width, height: width > 600 ? 1000 : 844 },
  });
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, request: context.request, errors };
}

async function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  const response = await request.post(url, { headers, data });
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function openMembers(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Planning room' })).toBeVisible();
  // The room pill opens Members (the top bar has no separate Members chip, §4.1).
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  await expect(panel).toBeVisible();
  return panel;
}

async function writePrivately(page: Page, peer: string, text: string) {
  // The open thread is the one with `peer`, not the last chat read: until the private chat has
  // opened, the send box must not belong to another conversation.
  await expect(
    page.locator('.msg-v2-head').getByRole('heading', { name: peer, exact: true }),
  ).toBeVisible();
  const compose = page.getByRole('form', { name: 'Private message' });
  await expect(compose).toBeVisible();
  await compose.getByRole('textbox').fill(text);
  await compose.getByRole('button', { name: 'Send privately' }).click();
  await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(text);
}

const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

for (const width of [1440, 390])
  test(`${width}: message a person, an outside AI and your own AI from a room; delete a chat`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // The host's AI hosts the room; the host brings a second AI of its own.
    const host = await account(browser, 'dm-host', width);
    const hostAgent = (
      await post(host.request, '/api/agents', {
        name: 'Host agent',
        capability: 'research',
        mode: 'external',
      })
    ).agent.id as string;
    const { room } = (await post(host.request, '/api/rooms', {
      agent_id: hostAgent,
      name: 'Planning room',
      idempotency_key: crypto.randomUUID(),
    })) as { room: { id: string } };
    const { link } = (await post(host.request, `/api/rooms/${room.id}/link`, {})) as {
      link: string;
    };
    const token = new URL(link).hash.slice(1);
    await post(host.request, `/api/rooms/${room.id}/join`, {
      create: { name: 'Host helper' },
      idempotency_key: crypto.randomUUID(),
    });
    // The host is also in the room as a person: a person writes to its own AIs without a
    // connection (two AIs of one owner need one).
    await post(host.request, '/api/rooms/join', {
      link,
      name: 'Sam',
      idempotency_key: crypto.randomUUID(),
    });
    // Dana joins as a person; another owner's AI joins with the link.
    const dana = await account(browser, 'dm-dana', width);
    await post(dana.request, '/api/rooms/join', {
      link,
      name: 'Dana',
      idempotency_key: crypto.randomUUID(),
    });
    const outsider = await account(browser, 'dm-outside', width);
    await post(outsider.request, `/api/rooms/${room.id}/join`, {
      token,
      create: { name: 'Outside AI' },
      idempotency_key: crypto.randomUUID(),
    });

    // Members: Message on other owners' members only. The host's own AI has none (the clean
    // roster, #630); a person reaches its own AI from Messages' New conversation instead.
    const page = host.page;
    const roster = await openMembers(page, room.id);
    await expect(roster.getByText('Host helper', { exact: true }).first()).toBeVisible();
    await expect(roster.getByRole('link', { name: 'Message Host helper privately' })).toHaveCount(
      0,
    );
    for (const [index, [name, text]] of (
      [
        ['Outside AI', 'Hello from the host.'],
        ['Dana', 'Dana, can we talk about the budget?'],
      ] as const
    ).entries()) {
      const panel = await openMembers(page, room.id);
      const message = panel.getByRole('link', { name: `Message ${name} privately` });
      await expect(message).toBeVisible();
      // Hold the request that opens the private chat: while it is on its way, Messages must not
      // offer the last chat's send box in its place (a message typed then reached the wrong
      // person, and this spec saw only two of the three chats).
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const opening = (url: URL) => url.pathname === `/api/rooms/${room.id}/direct`;
      let reached = false;
      await page.route(
        opening,
        async (route) => {
          reached = true;
          await held;
          await route.continue();
        },
        { times: 1 },
      );
      const listed =
        index > 0
          ? page.waitForResponse(
              (response) => new URL(response.url()).pathname === '/api/messages/conversations',
            )
          : null;
      await message.click();
      await expect.poll(() => reached).toBe(true);
      if (listed) {
        // The earlier chats have been read by now (the opening chat covers the list at every
        // width, so wait two frames for the answer to render); none of them takes its place.
        await listed;
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(page.getByRole('form', { name: 'Private message' })).toHaveCount(0);
      }
      release();
      await expect(page.getByText(/Couldn.t open the private chat/)).toHaveCount(0);
      await writePrivately(page, name, text);
      await noSideScroll(page);
    }

    // The three chats are in Messages (the AIs read theirs from their inbox). The open thread
    // replaces the inbox, so go back to it first.
    const list = page.getByRole('navigation', { name: 'Conversations' });
    const back = page.getByRole('button', { name: 'Back to inbox' });
    await expect(list).toBeHidden();
    await back.click();
    await expect(list.getByRole('button')).toHaveCount(2, { timeout: 25_000 });

    // The host's own AI: from New conversation (a person writes to its own AIs directly).
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const own = page.getByRole('form', { name: 'Message someone from a room' }).getByLabel('To');
    await own.selectOption({
      label: (await own.locator('option', { hasText: 'Host helper' }).textContent())!,
    });
    await page
      .getByRole('form', { name: 'Message someone from a room' })
      .getByRole('button', { name: 'Open chat' })
      .click();
    await writePrivately(page, 'Host helper', 'Helper, please draft the agenda.');
    await back.click();
    await expect(list.getByRole('button')).toHaveCount(3, { timeout: 25_000 });

    // New conversation: the people and AIs of the room, never agent → agent within the workspace.
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const picker = page.getByRole('form', { name: 'Message someone from a room' });
    await expect(picker).toBeVisible();
    const to = picker.getByLabel('To');
    for (const name of ['Dana', 'Outside AI', 'Host helper'])
      await expect(to.locator('option', { hasText: name })).toHaveCount(1);
    await expect(to.locator('option', { hasText: '→' })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'New conversation' })).toHaveCount(0);
    await to.selectOption({
      label: (await to.locator('option', { hasText: 'Dana' }).textContent())!,
    });
    await picker.getByRole('button', { name: 'Open chat' }).click();
    await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
      'Dana, can we talk about the budget?',
    );
    await noSideScroll(page);

    // Escape on the confirm closes only the confirm: the thread stays open.
    await page.getByRole('button', { name: 'Conversation actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete conversation' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete conversation?' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Delete conversation?' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Thread messages' })).toContainText(
      'Dana, can we talk about the budget?',
    );
    await expect(list).toBeHidden();

    // Delete conversation: the compact confirm, honest copy, and the chat leaves the list.
    await page.getByRole('button', { name: 'Conversation actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete conversation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete conversation?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("It's removed from your Messages.");
    await expect(dialog).toContainText('The other person keeps their copy.');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(440);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The chat closes and the inbox shows (on a phone too).
    await expect(list.getByRole('button')).toHaveCount(2);
    await expect(list.getByRole('button', { name: /Dana/ })).toHaveCount(0);
    await expect(list.getByRole('button', { name: /Outside AI/ })).toHaveCount(1);
    // The deleted chat's row is gone, so focus lands on a remaining chat (the last one opened,
    // else the first row).
    await expect(list.locator('button:focus')).toHaveCount(1);

    // Dana keeps her copy.
    const danaList = await dana.request.get('/api/messages/conversations');
    expect(JSON.stringify(await danaList.json())).toContain('Dana, can we talk about the budget?');

    expect(host.errors).toEqual([]);
    await Promise.all([host.context.close(), dana.context.close(), outsider.context.close()]);
  });
