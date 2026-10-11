import { test, expect, type Page } from '@playwright/test';

/*
 * Messages for a person with no connected agents (no route for the agent composer): the empty
 * state explains where private messages start and offers the two real ways in, never a
 * "Write the first message" / "New conversation" that opens a composer with nothing to type into.
 * Desktop and phone.
 */
const headers = { 'X-City-Request': '1' };

async function register(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Messages empty ${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

async function open(page: Page) {
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  const messages = page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^Messages/ });
  await expect(menu.or(messages).first()).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await messages.click();
}

const panel = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true });

{
  for (const width of [1440, 390]) {
    const label = `at ${width}`;

    test(`${label}: no connected agents shows guidance, not a dead-end composer`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
      await register(page);
      await open(page);
      const messages = panel(page);
      await expect(messages.getByText('No private messages yet', { exact: true })).toBeVisible();
      // No explanation text: the two actions speak for themselves.
      await expect(
        messages.getByText('You message people privately', { exact: false }),
      ).toHaveCount(0);
      await expect(
        messages.getByRole('link', { name: 'Message someone from a room' }),
      ).toBeVisible();
      // No way into the composer that cannot send.
      await expect(messages.getByRole('button', { name: 'Write the first message' })).toHaveCount(
        0,
      );
      await expect(
        messages.getByRole('button', { name: 'New conversation', exact: true }),
      ).toHaveCount(0);
      await expect(messages.getByRole('form')).toHaveCount(0);
      await expect(messages.getByRole('textbox')).toHaveCount(0);
      await expect(
        messages.getByText('Connect the two agents under Connections first.'),
      ).toHaveCount(0);
      // Both actions fit on a phone without sideways scrolling.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // "Let your agents talk to each other" opens Connections.
      await messages.getByRole('button', { name: 'Let your agents talk to each other' }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(
        page.getByRole('heading', {
          name: 'Agent permissions',
          exact: true,
        }),
      ).toBeVisible();

      // "Message someone from a room" goes to the rooms page.
      await open(page);
      const room = panel(page).getByRole('link', { name: 'Message someone from a room' });
      await expect(room).toHaveAttribute('href', '/rooms');
      await room.click();
      await expect(page).toHaveURL(/\/rooms\/?$/);
      await expect(panel(page)).toHaveCount(0);
    });
  }
}

test('your own connected agents alone do not open a composer (that would be you messaging yourself)', async ({
  page,
}) => {
  await register(page);
  await page.request.post('/api/demo/start', { headers, data: {} });
  await open(page);
  const messages = panel(page);
  await expect(messages.getByText('No private messages yet', { exact: true })).toBeVisible();
  await expect(messages.getByRole('link', { name: 'Message someone from a room' })).toBeVisible();
  await expect(messages.getByRole('button', { name: 'Write the first message' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'New conversation' })).toHaveCount(0);
});

test('with someone to message from a room the empty state offers New conversation', async ({
  page,
}) => {
  await register(page);
  await page.route('**/api/messages/recipients', (route) =>
    route.fulfill({
      json: {
        recipients: [
          {
            room_id: 'room-planning',
            room_name: 'planning',
            member_id: 'm-jamie',
            name: 'Jamie',
            kind: 'person',
            owner_label: 'Account 9f8e7d6c',
            own: false,
          },
        ],
      },
    }),
  );
  await open(page);
  const messages = panel(page);
  await expect(messages.getByText('No private messages yet', { exact: true })).toBeVisible();
  await expect(messages.getByRole('link', { name: 'Message someone from a room' })).toHaveCount(0);
  await expect(
    messages.getByRole('button', { name: 'New conversation', exact: true }),
  ).toBeVisible();
  await messages.getByRole('button', { name: 'Write the first message', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Message someone from a room' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'New conversation' })).toHaveCount(0);
});
