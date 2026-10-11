import { test, expect } from '@playwright/test';

test('legacy peer conversations combine and structured updates disclose raw data', async ({
  page,
}) => {
  const headers = { 'X-City-Request': '1' };
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Chat view ${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  await page.request.post('/api/demo/start', { headers, data: {} });
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const from = snapshot.agents.find((agent: { name: string }) => agent.name === 'Atlas');
  const to = snapshot.agents.find((agent: { name: string }) => agent.name === 'Relay');
  for (let i = 0; i < 2; i++) {
    const sent = await page.request.post(`/api/agents/${from.id}/messages`, {
      headers,
      data: {
        to_agent_id: to.id,
        text: `Separate old thread ${i}`,
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(sent.status()).toBe(201);
  }
  const dataSent = await page.request.post(`/api/agents/${from.id}/messages`, {
    headers,
    data: {
      to_agent_id: to.id,
      context_id: 'city-desk',
      parts: [
        {
          type: 'data',
          data: {
            schema: 'city.desk/v1',
            kind: 'session.register',
            session: 'synthetic-browser-session',
          },
        },
      ],
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(dataSent.status()).toBe(201);
  const desk = (kind: string, extra: Record<string, string>) =>
    page.request.post(`/api/agents/${from.id}/messages`, {
      headers,
      data: {
        to_agent_id: to.id,
        context_id: 'city-desk',
        parts: [
          {
            type: 'data',
            data: { schema: 'city.desk/v1', kind, session: 'synthetic-browser-session', ...extra },
          },
        ],
        idempotency_key: crypto.randomUUID(),
      },
    });
  for (const [kind, extra] of [
    ['claim.request', { claim_id: 'DEMO1' }],
    ['claim.status', { claim_id: 'DEMO1', status: 'review' }],
    ['claim.heartbeat', { claim_id: 'DEMO1' }],
    ['note', { claim_id: 'DEMO1', body: 'synthetic note' }],
  ] as const)
    expect((await desk(kind, extra)).status()).toBe(201);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: /^Messages\b/ })
    .click();
  const conversations = page.getByRole('navigation', { name: 'Conversations' });
  await expect(conversations.getByRole('button')).toHaveCount(1);
  await expect(conversations).toContainText('Desk');
  await conversations.getByRole('button').click();
  await expect(page.getByText('Atlas registered').last()).toBeVisible();
  const thread0 = page.getByRole('list', { name: 'Thread messages' });
  for (const label of [
    'Atlas requested claim DEMO1',
    'Atlas: claim DEMO1 → review',
    'Atlas: heartbeat for claim DEMO1',
    'Atlas: note for claim DEMO1',
  ])
    await expect(thread0.getByText(label, { exact: true })).toBeVisible();
  // The UI reports what a message says; only the desk fold decides whether a claim is granted.
  await expect(thread0).not.toContainText('granted');
  // Raw JSON stays behind Details for every structured message.
  for (const raw of await page.getByText('synthetic-browser-session', { exact: false }).all())
    await expect(raw).toBeHidden();
  await page.getByText('Details', { exact: true }).first().click();
  await expect(page.locator('.msg-data').first()).toContainText('synthetic-browser-session');
  await expect(page.locator('.msg-v2-head')).toContainText('Desk');
  const thread = page.getByRole('list', { name: 'Thread messages' });
  await expect(thread).toContainText('Separate old thread 0');
  await expect(thread).toContainText('Separate old thread 1');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
    if (width === 390) await expect(page.locator('.sidebar')).not.toBeInViewport();
    await page.screenshot({
      path: `test-results/messages-chat-${width}.png`,
      // Full page only on mobile: at 1440 the fixed-height sidebar ends at the viewport edge.
      fullPage: width === 390,
      animations: 'disabled',
    });
  }
});
