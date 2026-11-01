import { test, expect, type APIResponse } from '@playwright/test';

/*
 * A room left open shows a delete made elsewhere: a pasted secret its sender removed must not stay
 * on this screen until a reload (docs/ROOMS.md, Delete).
 */
const headers = { 'x-city-request': '1' };

const why = async (response: APIResponse) =>
  `${response.status()} ${(await response.text()).slice(0, 300)}`;

test('an open room shows a message deleted elsewhere, without a reload', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const request = context.request;
  const created = await request.post('/api/auth/register', {
    headers,
    data: {
      name: `Refresh-${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(created.status(), await why(created)).toBe(201);
  const agent = await request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', capability: 'research', mode: 'external' },
  });
  expect(agent.ok(), await why(agent)).toBeTruthy();
  const room = await request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Refresh room',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(room.status(), await why(room)).toBe(201);
  const roomId = (await room.json()).room.id as string;
  const text = 'A message that will be taken back';
  const posted = await request.post(`/api/rooms/${roomId}/messages`, {
    headers,
    data: { text, idempotency_key: crypto.randomUUID() },
  });
  expect(posted.status(), await why(posted)).toBe(201);
  const { seq } = (await posted.json()).message as { seq: number };

  const page = await context.newPage();
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByText(text)).toBeVisible();

  // Through the API, so this page learns of it only from its own reads.
  const deleted = await request.delete(`/api/rooms/${roomId}/messages/${seq}`, {
    headers,
    data: {},
  });
  expect(deleted.ok(), await why(deleted)).toBeTruthy();
  await expect(page.getByText(text)).toHaveCount(0, { timeout: 60_000 });
  await context.close();
});
