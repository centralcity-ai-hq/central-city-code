import { test, expect, type Browser } from '@playwright/test';

/*
 * Agents are labelled as AI, never as "another person" (src/rooms/AgentLabel.tsx, people.ts
 * agentOwners): another account's agent reads "AI · Mia's agent" when its owner is in the room as
 * a person (the owner's name is visible there), else "AI agent". The badge is the one Elric's
 * messages use, and screen readers hear "AI agent". People stay labelled as people.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { context, request: context.request, page: await context.newPage() };
}

async function post(
  owner: Awaited<ReturnType<typeof account>>,
  roomId: string,
  agentId: string,
  text: string,
) {
  const posted = await owner.request.post(`/api/rooms/${roomId}/messages`, {
    headers,
    data: { agent_id: agentId, text, idempotency_key: crypto.randomUUID() },
  });
  expect(posted.status(), await posted.text()).toBe(201);
}

test('agents read as AI: with the owner’s name when known, else "AI agent"', async ({
  browser,
}) => {
  const host = await account(browser, 'labels-host');
  const agent = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  const created = await host.request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Label room',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const roomId = (await created.json()).room.id as string;
  const mint = async () =>
    (await (await host.request.post(`/api/rooms/${roomId}/link`, { headers, data: {} })).json())
      .link as string;

  // Mia joins as herself, then brings her AI: her name is visible, so is "Mia's agent".
  const mia = await account(browser, 'labels-mia');
  const joined = await mia.request.post('/api/rooms/join', {
    headers,
    data: { link: await mint(), name: 'Mia', idempotency_key: crypto.randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  const brought = await mia.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { create: { name: 'Mia helper' }, idempotency_key: crypto.randomUUID() },
  });
  expect(brought.ok(), await brought.text()).toBeTruthy();
  await post(mia, roomId, (await brought.json()).agent_id, 'Helper here.');

  // Another account joins with an agent only: its owner has no visible name.
  const other = await account(browser, 'labels-other');
  const token = new URL(await mint()).hash.slice(1);
  const scout = await other.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { token, create: { name: 'Scout' }, idempotency_key: crypto.randomUUID() },
  });
  expect(scout.ok(), await scout.text()).toBeTruthy();
  await post(other, roomId, (await scout.json()).agent_id, 'Scout here.');

  const page = host.page;
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Label room' })).toBeVisible();
  const messages = page.getByTestId('room-message');
  const helper = messages.filter({ hasText: 'Helper here.' }).locator('.rm-byline');
  await expect(helper.locator('.rm-badge-elric')).toHaveText('AI');
  await expect(helper.locator('.rm-agent-label > [aria-hidden]')).toHaveText("AI · Mia's agent");
  await expect(helper.locator('.rm-visually-hidden')).toHaveText('AI agent owned by Mia');
  const scoutLine = messages.filter({ hasText: 'Scout here.' }).locator('.rm-byline');
  await expect(scoutLine.locator('.rm-agent-label > [aria-hidden]')).toHaveText('AI agent');
  await expect(scoutLine.locator('.rm-visually-hidden')).toHaveText('AI agent');
  // The privacy hash stays a tooltip only.
  await expect(scoutLine.locator('.rm-agent-label')).toHaveAttribute(
    'title',
    /^Account [0-9a-f]{8}$/,
  );
  await expect(messages.filter({ hasText: 'another person' })).toHaveCount(0);

  // The members list: the same labels; Mia herself stays a person.
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  const ais = panel.getByRole('list', { name: 'AIs', exact: true }).getByRole('listitem');
  const helperRow = ais.filter({ hasText: 'Mia helper' });
  await expect(helperRow.getByTestId('member-badge')).toHaveText(["AI · Mia's agent"]);
  await expect(helperRow.locator('.rm-visually-hidden')).toHaveText('AI agent owned by Mia');
  const scoutRow = ais.filter({ hasText: 'Scout' });
  await expect(scoutRow.getByTestId('member-badge')).toHaveText(['AI agent']);
  await expect(scoutRow.locator('.rm-visually-hidden')).toHaveText('AI agent');
  await expect(panel.getByText('another person')).toHaveCount(0);
  // People: Mia and the host's own person (A1); neither is ever labelled an AI.
  const people = panel.getByRole('list', { name: 'People' }).getByRole('listitem');
  await expect(people).toHaveCount(2);
  const person = people.filter({ hasText: 'Mia' });
  await expect(person.locator('strong')).toHaveText('Mia');
  await expect(people.getByTestId('member-badge').filter({ hasText: /\bAI\b/ })).toHaveCount(0);
  await host.context.close();
  await mia.context.close();
  await other.context.close();
});
