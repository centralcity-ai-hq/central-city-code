import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { FeedService } from '../shared/feed';
import {
  mockFeed,
  mockFeedPay,
  payAgent,
  sampleServices,
  type FeedPayFakeOptions,
} from './feed-fixtures';

/*
 * Regression specs for the client findings on Feed pay ("Use with my agent"); each fails until its
 * finding is fixed. Every Feed and Feed pay route is mocked (e2e/feed-fixtures.ts): nothing is paid
 * and no real service is called. The server findings are in tests/feed-pay-audit.test.ts.
 */

const headers = { 'x-city-request': '1' };
const PASSWORD = 'Local-test-only-passphrase-2026';
/** Otto AI's domain lookup: GET, one required query field, 0.001 USDC, an example. */
const WHOIS = 'svc_4frm2ulydi7axsyvtxhv';
const WHOIS_HOST = 'x402.ottoai.services';
const UPTO = 'svc_7w5ucqnvla3f7kniukko';

function payServices(): FeedService[] {
  return sampleServices().map((service) =>
    service.id === UPTO ? { ...service, scheme: 'upto' as const } : service,
  );
}

async function setup(page: Page, pay: FeedPayFakeOptions = {}) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Pay ${randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const services = pay.services ?? payServices();
  await mockFeed(page, { services });
  return mockFeedPay(page, { services, ...pay });
}

const drawer = (page: Page) => page.getByRole('dialog');
const useButton = (page: Page) => drawer(page).getByRole('button', { name: 'Use with my agent' });
const payButton = (page: Page) => drawer(page).getByRole('button', { name: /^Pay [\d.]+ USDC$/ });

async function openDrawer(page: Page) {
  await page.goto(`/feed?host=${WHOIS_HOST}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await page.locator(`#fd-t-${WHOIS}`).click();
  await expect(drawer(page)).toBeVisible();
}

/** The use sheet with the example accepted and hhuo picked, up to the confirm. */
async function toConfirm(page: Page) {
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  const hhuo = drawer(page).getByRole('radio', { name: /^hhuo\b/ });
  if (!(await hhuo.isChecked())) await hhuo.check();
  await drawer(page)
    .getByRole('button', { name: /^Check price/ })
    .click();
  await expect(payButton(page)).toBeVisible();
}

test('finding 9 (client double payment): leaving the sheet while paying, then paying again, never starts a second payment', async ({
  page,
}) => {
  const pay = await setup(page, { agents: [payAgent()], callDelayMs: 4_000 });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  await expect(drawer(page).getByRole('button', { name: 'Paying…' })).toBeVisible();
  await expect.poll(() => pay.calls.length).toBe(1);

  // Leave the sheet while the first payment is on its way (if leaving is possible at all).
  const back = drawer(page).getByRole('button', { name: 'Back to the service' }).first();
  if ((await back.isVisible()) && (await back.isEnabled())) {
    await back.click();
    await useButton(page).click();
    // Reaching Pay again, as far as the sheet allows it.
    const example = drawer(page).getByRole('button', { name: 'Fill with example' });
    if (await example.isVisible().catch(() => false)) {
      await example.click();
      const hhuo = drawer(page).getByRole('radio', { name: /^hhuo\b/ });
      if ((await hhuo.isEnabled()) && !(await hhuo.isChecked())) await hhuo.check();
      const check = drawer(page).getByRole('button', { name: /^Check price/ });
      if ((await check.isVisible()) && (await check.isEnabled())) await check.click();
      if (
        await payButton(page)
          .isVisible({ timeout: 3_000 })
          .catch(() => false)
      )
        await payButton(page).click();
    }
  }
  await page.waitForTimeout(5_000);
  // One payment: the same idempotency key for every call sent, or no second call at all.
  const keys = new Set(pay.calls.map((call) => call.body.idempotencyKey));
  expect(keys.size, `calls sent: ${pay.calls.length}`).toBeLessThanOrEqual(1);
});

test('finding 11 (copy with pay on): the Offered strip and the Limitations do not say nothing is paid or that the service was never called', async ({
  page,
}) => {
  const pay = await setup(page, { agents: [payAgent()] });
  await openDrawer(page);
  await expect(useButton(page)).toBeVisible();
  expect(pay.agentReads).toBeGreaterThanOrEqual(1);
  await drawer(page).locator('summary').filter({ hasText: 'Technical details' }).click();
  const limits = drawer(page).getByRole('region', { name: 'Limitations' });
  await expect(limits).toBeVisible();
  await expect(limits).not.toContainText('Central City hasn’t called this service');
  await expect(drawer(page)).not.toContainText('Nothing is paid through the Feed');

  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  const strip = page.locator('.fd-strip');
  await expect(strip).toBeVisible();
  await expect(strip).not.toContainText('Nothing is paid through the Feed');
});
