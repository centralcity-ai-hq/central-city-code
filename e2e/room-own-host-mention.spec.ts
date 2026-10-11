import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * Operation Agency A3: writing as yourself, "@<your own host>" is a mention, and it wakes your own
 * agent. The host's owner, in the room as a person, writes as themselves by default ("Post as"
 * offers both identities); the @ picker offers their own host. Writing as the host agent itself,
 * it isn't offered (an agent never mentions itself). A second member mentions it as before.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `${name}-${randomUUID().slice(0, 6)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return page;
}

async function personId(page: Page, roomId: string) {
  const res = await page.request.get(`/api/rooms/${roomId}/members`, { headers });
  const members = (await res.json()).members as Array<{ id: string; own: boolean; kind?: string }>;
  return members.find((m) => m.own && m.kind === 'person')!.id;
}

test('writing as yourself, your own host is in your @ picker and your @mention of it is one', async ({
  browser,
}) => {
  // The host: an agent "Hostbot" hosts the room; its owner is also in the room as a person.
  const host = await account(browser, 'host');
  const agent = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Hostbot', capability: 'research', mode: 'hosted' },
  });
  expect(agent.ok()).toBe(true);
  const room = await host.request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Mentions',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;
  const link = await host.request.post('/api/links', {
    headers,
    data: { target: 'room', room_id: roomId },
  });
  const code = (await link.json()).code as string;
  const join = (page: Page, name: string) =>
    page.request.post('/api/rooms/join', {
      headers,
      data: { code, name, idempotency_key: randomUUID() },
    });
  expect((await join(host, 'Hana')).ok()).toBe(true);

  // A second member, Bea, joins as a person.
  const bea = await account(browser, 'bea');
  expect((await join(bea, 'Bea')).ok()).toBe(true);

  // Both write "@Hostbot …" as themselves.
  const say = async (page: Page, text: string) =>
    expect(
      (
        await page.request.post(`/api/rooms/${roomId}/messages`, {
          headers,
          data: { text, idempotency_key: randomUUID(), agent_id: await personId(page, roomId) },
        })
      ).status(),
    ).toBe(201);
  await say(host, 'Reminder to myself: @Hostbot summarize later');
  await say(bea, 'Question for @Hostbot please');

  // The host's view: Hana writes as herself by default; "Post as" offers Hostbot too.
  await host.goto(`/rooms/${roomId}`);
  const postAs = host.locator('.rm3-postas select');
  await expect(postAs).toHaveValue(await personId(host, roomId));
  // The host is in their room as themselves from its creation (A1), under their account name.
  await expect(postAs.locator('option')).toHaveText([/ \(you\)$/, 'Hostbot']);
  // As herself, the picker offers her own Hostbot (her @mention wakes it) and Bea.
  const box = host.getByRole('textbox', { name: 'Message' });
  await box.click();
  await box.pressSequentially('@');
  const picker = host.getByRole('listbox', { name: 'Mention a member' });
  await expect(picker.getByRole('option', { name: /Bea/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /Hostbot/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /Hana/ })).toHaveCount(0);
  await box.press('Escape');
  await box.fill('');
  // As Hostbot, Hostbot isn't offered: an agent never mentions itself.
  await postAs.selectOption({ label: 'Hostbot' });
  await box.click();
  await box.pressSequentially('@');
  await expect(picker.getByRole('option', { name: /Bea/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /Hostbot/ })).toHaveCount(0);
  await box.press('Escape');
  // Both "@Hostbot"s are mentions: Hana's as herself and Bea's.
  const messages = host.getByTestId('room-message');
  await expect(
    messages.filter({ hasText: 'Reminder to myself' }).locator('.rm-mention'),
  ).toHaveText('@Hostbot');
  await expect(messages.filter({ hasText: 'Question for' }).locator('.rm-mention')).toHaveText(
    '@Hostbot',
  );

  // Bea's view: Hostbot is offered, and both mentions are highlighted.
  await bea.goto(`/rooms/${roomId}`);
  const beaBox = bea.getByRole('textbox', { name: 'Message' });
  await beaBox.click();
  await beaBox.pressSequentially('@Host');
  await expect(
    bea.getByRole('listbox', { name: 'Mention a member' }).getByRole('option', { name: /Hostbot/ }),
  ).toBeVisible();
  for (const text of ['Question for', 'Reminder to myself'])
    await expect(
      bea.getByTestId('room-message').filter({ hasText: text }).locator('.rm-mention'),
    ).toHaveText('@Hostbot');
});
