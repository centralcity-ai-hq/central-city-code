import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * A mention in the private Elric chat, end to end (docs/ELRIC.md "Dashboard chat"), on the
 * fake-Google e2e server with Elric on the mock model (e2e/google-server.ts, CITY_ELRIC_MOCK=1):
 * a person links a (fake) Google account and confirms 18+, adds Elric, opens the private chat,
 * @mentions Elric there, and gets a labelled reply in that room only. Synthetic data only.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

async function eligibleOwner(page: Page) {
  // Its own fake Google identity (google-signin.spec.ts uses the default one on the same server).
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Chat ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
}

test('a mention in the private chat gets a labelled reply there, and the chat stays locked', async ({
  page,
}) => {
  await eligibleOwner(page);
  const added = await page.request.post(`${base}/api/elric`, { headers, data: {} });
  expect(added.status(), await added.text()).toBeLessThan(300);
  const elricId = (await added.json()).agent_id as string;

  const chatRes = await page.request.get(`${base}/api/elric/chat`, { headers });
  expect(chatRes.status(), await chatRes.text()).toBe(200);
  const chat = (await chatRes.json()) as {
    room_id: string;
    person_member_id: string;
    latest_seq: number;
  };

  // The owner's person @mentions Elric in the private chat, as the dashboard does.
  const posted = await page.request.post(`${base}/api/rooms/${chat.room_id}/messages`, {
    headers,
    data: {
      text: '@Elric hello from the dashboard',
      agent_id: chat.person_member_id,
      idempotency_key: randomUUID(),
    },
  });
  expect(posted.status(), await posted.text()).toBe(201);

  // The cheap poll moves, then the reply is there with the public label.
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`${base}/api/elric/chat?since=${chat.latest_seq}`, { headers })
          ).json()
        ).latest_seq,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(chat.latest_seq + 2);
  const read = await page.request.get(`${base}/api/rooms/${chat.room_id}/messages?since=0`, {
    headers,
  });
  const messages = (await read.json()).messages as Array<{
    sender_agent_id: string;
    auto_reply?: { provider: string; label?: string } | null;
  }>;
  const reply = messages.find((message) => message.sender_agent_id === elricId);
  expect(reply?.auto_reply?.provider).toBe('elric');
  expect(reply?.auto_reply?.label).toBe('Elric · AI');

  // The activity lists the turn in this room, and the room stays locked.
  const turns = (await (await page.request.get(`${base}/api/elric/turns`, { headers })).json())
    .turns as Array<{ room_id: string | null; result: string }>;
  expect(turns.some((turn) => turn.room_id === chat.room_id && turn.result === 'posted')).toBe(
    true,
  );
  const link = await page.request.post(`${base}/api/rooms/${chat.room_id}/link/rotate`, {
    headers,
    data: { idempotency_key: randomUUID() },
  });
  expect(link.status()).toBe(409);
  expect((await link.json()).code).toBe('room_private');
});
