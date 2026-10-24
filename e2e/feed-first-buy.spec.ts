import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { FEED_HOSTED_SOURCE, type FeedService } from '../shared/feed';
import type {
  FeedSponsoredCall,
  FeedSponsoredCallRequest,
  FeedSponsoredCreditView,
} from '../shared/feed-sponsored';
import { mockFeed, mockFeedPay, payAgent, sampleServices } from './feed-fixtures';

/*
 * Free first buys in the browser (the First service free mockup): the Feed's "First buy free"
 * chip on a Central City service, the free filter, and in Use with my agent the agent chips, the
 * price Central City pays and Use free, then Done with the split and the result. Every Feed, Feed
 * pay and sponsored route is mocked: nothing is paid. FEED_PAY_SHOTS=<dir> saves screenshots.
 */

const headers = { 'x-city-request': '1' };
const PASSWORD = 'Local-test-only-passphrase-2026';
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const CC = 'svc_cccccccccccccccccccc';
const NOVA = 'agt-nova-0001';
const ORIN = 'agt-orin-0001';

/** Exa's POST listing made into a Central City service sold by Edward, 1.10 USDC. */
function services(): FeedService[] {
  const all = sampleServices();
  const exa = all.find((service) => service.method === 'POST')!;
  const cc: FeedService = {
    ...exa,
    id: CC,
    title: 'Base USDC balance pro',
    provider: { host: 'centralcity.ai', name: 'Edward' },
    url: 'https://centralcity.ai/api/public/x402/off_cc1',
    price: { raw: '1100000', decimals: 6, display: '1.1', unit: 'per_call' },
    input: {
      format: 'json',
      fields: [
        { name: 'address', in: 'body', type: 'string', required: true, description: 'Address' },
      ],
      more: 0,
      example: null,
      exampleState: null,
    },
    usage: { ...exa.usage, paidCalls30d: 999_999 },
    source: {
      ...exa.source,
      name: FEED_HOSTED_SOURCE.name,
      credit: FEED_HOSTED_SOURCE.credit,
      url: FEED_HOSTED_SOURCE.url,
      recordId: 'cc:off_cc1',
    },
  };
  return [cc, ...all];
}

async function setup(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Free ${randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const list = services();
  await mockFeed(page, { services: list });
  await mockFeedPay(page, {
    services: list,
    agents: [
      payAgent({ agentId: ORIN, name: 'Orin' }),
      payAgent({
        agentId: NOVA,
        name: 'Nova',
        usdcRaw: '0',
        floatRaw: '0',
        ready: false,
        notReady: 'no_funds',
      }),
    ],
  });
  const seen = { creditReads: 0, calls: [] as FeedSponsoredCallRequest[], statusReads: 0 };
  let used = false;
  await page.route(/\/api\/feed\/sponsored-credit$/, (route) => {
    seen.creditReads += 1;
    expect(route.request().headers()['x-city-request']).toBe('1');
    const answer: FeedSponsoredCreditView = {
      agents: [
        { agentId: NOVA, credit: used ? 'used' : 'available' },
        { agentId: ORIN, credit: 'used' },
      ],
      serviceIds: [CC],
      maxPriceRaw: '2000000',
    };
    return route.fulfill({ json: answer });
  });
  const call = (state: FeedSponsoredCall['state']): FeedSponsoredCall => ({
    callId: 'sp_aaaaaaaaaaaaaaaaaaaa',
    agentId: NOVA,
    serviceId: CC,
    offerId: 'off_cc1',
    state,
    sponsored: true,
    priceRaw: '1100000',
    payment: { payer: `0x${'5'.repeat(40)}`, router: 'router3', txHash: null },
    failure: null,
    result:
      state === 'delivered'
        ? { format: 'json', mime: 'application/json', text: '{"balance":"9214.51"}' }
        : null,
  });
  await page.route(/\/api\/feed\/services\/[^/]+\/sponsored-call$/, (route) => {
    seen.calls.push(route.request().postDataJSON() as FeedSponsoredCallRequest);
    used = true;
    return route.fulfill({ json: call('sent') });
  });
  await page.route(/\/api\/feed\/sponsored-calls\//, (route) => {
    seen.statusReads += 1;
    return route.fulfill({ json: call(seen.statusReads > 1 ? 'delivered' : 'paid') });
  });
  return seen;
}

async function shot(page: Page, name: string) {
  const dir = process.env.FEED_PAY_SHOTS;
  if (!dir) return;
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.screenshot({ path: `${dir}/${name}.png` });
}

const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const size of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 375, height: 812 },
]) {
  test(`first buy free (${size.name}): chip, free filter, Use free, Done paid by Central City`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const seen = await setup(page);
    await page.goto('/feed');
    const card = page.locator('.fd-card', { hasText: 'Base USDC balance pro' });
    await expect(card.locator('.fd-free-chip')).toHaveText('First buy free');
    // Only Central City's service has it.
    await expect(page.locator('.fd-free-chip')).toHaveCount(1);
    await shot(page, `first-buy-feed-${size.name}`);

    // The free filter (the agent page's Choose): only that service, said as a filter.
    await page.goto('/feed?free=1');
    await expect(page.locator('.fd-card')).toHaveCount(1);
    await expect(page.locator('.fd-active')).toContainText('First buy free');

    await page.locator('.fd-card .fd-hit').first().click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Use with my agent' }).click();
    const nova = drawer.locator('.fp-agent', { hasText: 'Nova' });
    await expect(nova.locator('.fp-a-free')).toHaveText('First buy free');
    await expect(drawer.locator('.fp-agent', { hasText: 'Orin' }).locator('.fp-a-free')).toHaveText(
      'Used',
    );
    // Nova has no USDC but is picked: Central City pays.
    await expect(nova.getByRole('radio')).toBeChecked();
    const lines = drawer.locator('.fp-free-price');
    await expect(lines).toContainText('Central City pays');
    await expect(lines.locator('.fp-line[data-k="total"]')).toContainText('You pay0 USDC');
    await expect(drawer.getByRole('button', { name: 'Check price' })).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await shot(page, `first-buy-sheet-${size.name}`);

    await drawer.getByRole('textbox').first().fill('0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9');
    await drawer.getByRole('button', { name: 'Use free' }).click();
    await expect(drawer.locator('.fp-free-ok')).toContainText('Done. Paid by Central City.');
    await expect(drawer.locator('.fp-free-ok')).toContainText(
      'Nova’s first service. 1.10 USDC: 0.99 to Edward, 0.11 fee.',
    );
    await expect(drawer.locator('.fp-result')).toContainText('9214.51');
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]).toMatchObject({
      agent_id: NOVA,
      use_credit: true,
      max_price_usdc: '1.1',
      inputs: { body: { address: '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9' } },
    });
    expect(seen.calls[0]!.idempotency_key).toMatch(/^sfp-/);
    const text = await drawer.evaluate((element) => (element as HTMLElement).innerText);
    expect(ARROWS.exec(text)?.[0] ?? null).toBeNull();
    expect(await fits(page)).toBe(true);
    await shot(page, `first-buy-done-${size.name}`);
  });
}
