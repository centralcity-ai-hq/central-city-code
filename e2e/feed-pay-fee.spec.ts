import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { FeedService } from '../shared/feed';
import type { FeedPayCall, FeedPayHistoryItem } from '../shared/feed-pay';
import type { Agent, Snapshot } from '../shared/types';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';
import { lowContrast } from './contrast';
import {
  mockFeed,
  mockFeedPay,
  PAID_RUN,
  PAY_AGENT_IDS,
  payAgent,
  payCall,
  payQuote,
  sampleServices,
  type FeedPayFakeOptions,
} from './feed-fixtures';

/*
 * Central City's fee on top in "Use with my agent" (Operation Protocol Z2b, docs/FEED_PAY.md
 * section 15): with protocol fees on, the quote's three lines (price, Central City fee (10%),
 * total), the confirm that names all three, the caps on the total, and the call and the wallet
 * History with price, fee and total and their Base transactions. With fees off, the one price
 * exactly as before. At 390 and 1440 px, light and dark, without sideways scroll. Every Feed and
 * Feed pay route is mocked (e2e/feed-fixtures.ts): nothing is paid. FEED_PAY_SHOTS=<dir> saves
 * screenshots there.
 */

const headers = { 'x-city-request': '1' };
const SIGN_IN_PHRASE = 'Local-test-only-passphrase-2026';
/** Arrow characters and arrow-like quotes: none anywhere in the Feed. */
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const MACHINE_TEXT = /city_[a-z]|idempoten|undefined|NaN|null\b|protocolFee/i;

/** Otto AI's domain lookup, listed at 0.02 USDC here (an example price). */
const WHOIS = 'svc_4frm2ulydi7axsyvtxhv';
const HOST = 'x402.ottoai.services';
const FEE_TX = `0x${'5'.repeat(64)}`;
/** The sheet's intro: true with the fee on top and without it, so it never says only "the price". */
const INTRO =
  'Your agent pays from its own wallet. You see what it pays, and to whom, before anything is paid.';

function services(): FeedService[] {
  return sampleServices().map((service) =>
    service.id === WHOIS
      ? { ...service, price: { raw: '20000', decimals: 6, display: '0.02', unit: 'per_call' } }
      : service,
  );
}

/** The engine's run of a paid call with the fee: the price first, then the fee after it. */
function feeRun(service: FeedService) {
  return (callId: string): FeedPayCall[] => [
    ...PAID_RUN.map(({ state, paymentState }) =>
      payCall(state, { service, callId, paymentState, fee: true }),
    ),
    // Done (the price settled), the fee still on its way: followed for its transaction.
    payCall('result_saved', { service, callId, fee: 'sent' }),
    payCall('result_saved', { service, callId, fee: 'charged' }),
  ];
}

async function setup(page: Page, pay: FeedPayFakeOptions = {}) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Fee ${randomUUID().slice(0, 8)}`, password: SIGN_IN_PHRASE },
  });
  expect(created.status()).toBe(201);
  const list = pay.services ?? services();
  await mockFeed(page, { services: list });
  return mockFeedPay(page, { services: list, agents: [payAgent()], ...pay });
}

const drawer = (page: Page) => page.getByRole('dialog');
const payButton = (page: Page) => drawer(page).getByRole('button', { name: /^Pay [\d.]+ USDC$/ });
const confirmLine = (page: Page) => drawer(page).locator('.fp-confirm');
const stateLine = (page: Page) => drawer(page).locator('.fp-state');

async function toQuote(page: Page) {
  await page.goto(`/feed?host=${HOST}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await page.locator(`#fd-t-${WHOIS}`).click();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole('button', { name: 'Use with my agent' }).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  const hhuo = drawer(page).getByRole('radio', { name: /^hhuo\b/ });
  if (!(await hhuo.isChecked())) await hhuo.check();
  await drawer(page)
    .getByRole('button', { name: /^Check price/ })
    .click();
}

const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      [...document.querySelectorAll<HTMLElement>('.fd-drawer, .fd-d-body, main, .fp-lines')].every(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
  );

async function plainText(locator: Locator) {
  const text = await locator.evaluate((element) => (element as HTMLElement).innerText);
  expect(ARROWS.exec(text)?.[0] ?? null).toBeNull();
  // The result is the service's own text and may hold anything; everything else is ours.
  const ours = text.replace(/\{[\s\S]*\}/g, '');
  const hit = MACHINE_TEXT.exec(ours);
  expect(hit ? ours.slice(Math.max(0, hit.index - 40), hit.index + 40) : null).toBeNull();
}

async function shot(page: Page, name: string) {
  const dir = process.env.FEED_PAY_SHOTS;
  if (!dir) return;
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.screenshot({ path: `${dir}/${name}.png` });
}

/** The rows of a .fp-lines list as [label, amount]. */
const rows = (lines: Locator) =>
  lines
    .locator('.fp-line')
    .evaluateAll((items) =>
      items.map((item) => [
        item.querySelector('dt')?.textContent ?? '',
        item.querySelector('.fp-line-v')?.textContent ?? '',
      ]),
    );

const SIZES = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
] as const;

for (const theme of ['light', 'dark'] as const)
  for (const size of SIZES)
    test(`fees on at ${size.width} px (${theme}): price, Central City fee and total, one confirm, the call`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      const list = services();
      const whois = list.find((service) => service.id === WHOIS)!;
      const pay = await setup(page, {
        services: list,
        quotes: [{ answer: (service) => payQuote(service, { fee: true }) }],
        calls: [{ steps: feeRun(whois) }],
      });
      await toQuote(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(drawer(page).locator('.fp-head .fd-fine')).toHaveText(INTRO);
      const quote = drawer(page).locator('.fp-quote');
      const lines = quote.locator('dl[aria-label="What this call costs"]');
      await expect(lines).toBeVisible();
      expect(await rows(lines)).toEqual([
        ['Price', '$0.02'],
        ['Central City fee (10%)', '$0.002'],
        ['Total', '$0.022'],
      ]);
      // Today's single price is not shown beside them.
      await expect(quote.locator('.fp-price')).toHaveCount(0);
      await expect(quote).toContainText(
        `The price goes to ${HOST}, the address its listing names. The fee goes to Central City.`,
      );
      await expect(confirmLine(page)).toHaveText(
        `Pay 0.022 USDC from hhuo: 0.02 to ${HOST} and 0.002 Central City fee? You can’t undo it.`,
      );
      await expect(payButton(page)).toHaveText('Pay 0.022 USDC');
      // The confirm and its button stay in view.
      const box = await payButton(page).boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
      // 44 px targets on a phone.
      if (size.width < 768) expect(box!.height).toBeGreaterThanOrEqual(43.5);
      expect(await fits(page)).toBe(true);
      expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
      await plainText(drawer(page));
      await shot(page, `fee-confirm-${size.width}-${theme}`);

      await payButton(page).click();
      await expect(stateLine(page)).toHaveText(`Paid 0.02 USDC to ${HOST}.`, { timeout: 15_000 });
      // The person confirmed the price and the total, fee included: both bind the call.
      expect(pay.calls).toHaveLength(1);
      expect(pay.calls[0]!.body.maxAmountRaw).toBe('20000');
      expect(pay.calls[0]!.body.maxTotalRaw).toBe('22000');
      const card = drawer(page).locator('.fp-call');
      const paid = card.locator('dl[aria-label="Payment"]');
      expect(await rows(paid)).toEqual([
        ['Price', '$0.02'],
        ['Central City fee (10%)', '$0.002'],
        ['Total', '$0.022'],
      ]);
      await expect(paid.locator('[data-k="price"]')).toContainText(`to ${HOST}`);
      await expect(paid.locator('[data-k="total"]')).toContainText('from hhuo');
      await expect(paid.getByRole('link', { name: /^Base transaction/ })).toHaveAttribute(
        'href',
        /^https:\/\/basescan\.org\/tx\/0x7{64}$/,
      );
      // The fee is charged after the call is done: followed until its transaction shows.
      await expect(paid.getByRole('link', { name: /^Fee transaction/ })).toHaveAttribute(
        'href',
        `https://basescan.org/tx/${FEE_TX}`,
        { timeout: 15_000 },
      );
      await expect(paid.locator('.fp-tag')).toHaveCount(0);
      if (size.width < 768)
        for (const link of await paid.getByRole('link').all())
          expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      expect(await fits(page)).toBe(true);
      expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
      await plainText(drawer(page));
      await shot(page, `fee-call-${size.width}-${theme}`);
      // Done and charged: no more reads.
      const reads = pay.statusReads.length;
      await page.waitForTimeout(2_000);
      expect(pay.statusReads.length).toBe(reads);
    });

for (const theme of ['light', 'dark'] as const)
  for (const size of SIZES)
    test(`fees off at ${size.width} px (${theme}): the one price, exactly as before`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      await setup(page);
      await toQuote(page);
      await expect(drawer(page).locator('.fp-head .fd-fine')).toHaveText(INTRO);
      const quote = drawer(page).locator('.fp-quote');
      await expect(quote.locator('.fp-price')).toHaveText(/Price now\s*0\.02 USDC per call/);
      await expect(quote).toContainText(`Paid to ${HOST}, the address its listing names.`);
      await expect(quote.locator('.fp-lines')).toHaveCount(0);
      await expect(drawer(page)).not.toContainText('Central City fee');
      await expect(confirmLine(page)).toHaveText(
        `Pay 0.02 USDC from hhuo to ${HOST}? You can’t undo it.`,
      );
      await expect(payButton(page)).toHaveText('Pay 0.02 USDC');
      expect(await fits(page)).toBe(true);
      await payButton(page).click();
      await expect(stateLine(page)).toHaveText(`Paid 0.02 USDC to ${HOST}.`, { timeout: 15_000 });
      const card = drawer(page).locator('.fp-call');
      await expect(card.locator('.fp-pay')).toContainText(`0.02 USDC from hhuo to ${HOST}`);
      await expect(card.locator('.fp-lines')).toHaveCount(0);
      await expect(card).not.toContainText('Central City fee');
      expect(await fits(page)).toBe(true);
      expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
      await shot(page, `nofee-call-${size.width}-${theme}`);
    });

// A quote without the fee, then fees switched on before the click: the server refuses the call
// (quote_mismatch, it pays at most the total confirmed). Checked again, the fee is shown first.
for (const [size, theme] of [
  [SIZES[0], 'light'],
  [SIZES[1], 'dark'],
] as const)
  test(`a fee that applies only since the confirm at ${size.width} px (${theme}): refused, checked again, a new confirm`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: theme });
    const list = services();
    const whois = list.find((service) => service.id === WHOIS)!;
    const pay = await setup(page, {
      services: list,
      quotes: [
        { answer: (service) => payQuote(service) },
        { answer: (service) => payQuote(service, { fee: true }) },
      ],
      calls: [{ failure: { code: 'quote_mismatch' } }, { steps: feeRun(whois) }],
    });
    await toQuote(page);
    const quote = drawer(page).locator('.fp-quote');
    await expect(confirmLine(page)).toHaveText(
      `Pay 0.02 USDC from hhuo to ${HOST}? You can’t undo it.`,
    );
    await expect(drawer(page)).not.toContainText('Central City fee');
    await payButton(page).click();
    // The page sent the total it showed: the price, no fee.
    await expect(quote).toContainText(
      'The price check didn’t match this payment, so we checked again. Central City’s fee of 0.002 USDC now comes on top. Confirm to pay.',
    );
    expect(pay.calls).toHaveLength(1);
    expect(pay.calls[0]!.body.maxAmountRaw).toBe('20000');
    expect(pay.calls[0]!.body.maxTotalRaw).toBe('20000');
    expect(pay.quotes).toHaveLength(2);
    expect(await rows(quote.locator('dl[aria-label="What this call costs"]'))).toEqual([
      ['Price', '$0.02'],
      ['Central City fee (10%)', '$0.002'],
      ['Total', '$0.022'],
    ]);
    await expect(confirmLine(page)).toHaveText(
      `Pay 0.022 USDC from hhuo: 0.02 to ${HOST} and 0.002 Central City fee? You can’t undo it.`,
    );
    await expect(payButton(page)).toHaveText('Pay 0.022 USDC');
    // Nothing more was sent: a new confirm is needed.
    expect(pay.calls).toHaveLength(1);
    expect(await fits(page)).toBe(true);
    expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
    await plainText(drawer(page));
    await shot(page, `fee-since-confirm-${size.width}-${theme}`);

    await payButton(page).click();
    await expect(stateLine(page)).toHaveText(`Paid 0.02 USDC to ${HOST}.`, { timeout: 15_000 });
    expect(pay.calls).toHaveLength(2);
    expect(pay.calls[1]!.body.maxAmountRaw).toBe('20000');
    expect(pay.calls[1]!.body.maxTotalRaw).toBe('22000');
    expect(pay.calls[1]!.body.idempotencyKey).not.toBe(pay.calls[0]!.body.idempotencyKey);
  });

test('fees on: the per-call maximum and the limit left hold for the total, fee included', async ({
  page,
}) => {
  const pay = await setup(page, {
    agents: [payAgent({ perCallMaxRaw: '20000', perCallMaxIsDefault: false })],
    quotes: [{ answer: (service) => payQuote(service, { fee: true }) }],
  });
  await toQuote(page);
  const quote = drawer(page).locator('.fp-quote');
  // 0.02 fits a 0.02 maximum; 0.022 with the fee doesn't.
  await expect(quote).toContainText(
    '0.022 USDC in total is above hhuo’s per-call maximum of 0.02 USDC.',
  );
  await expect(payButton(page)).toHaveCount(0);
  await quote.getByRole('button', { name: 'Change maximum' }).click();
  const input = drawer(page).getByRole('textbox', { name: /Per-call maximum for hhuo/ });
  await input.fill('0.021');
  await drawer(page).getByRole('button', { name: 'Save' }).click();
  await expect(quote).toContainText('Saved. hhuo now pays at most 0.021 USDC per call.');
  await expect(payButton(page)).toHaveCount(0);
  await expect(quote.getByRole('button', { name: 'Change maximum' })).toBeFocused();
  await quote.getByRole('button', { name: 'Change maximum' }).click();
  await input.fill('0.022');
  await drawer(page).getByRole('button', { name: 'Save' }).click();
  await expect(confirmLine(page)).toHaveText(
    `Pay 0.022 USDC from hhuo: 0.02 to ${HOST} and 0.002 Central City fee? You can’t undo it.`,
  );
  await expect(confirmLine(page)).toBeFocused();
  expect(pay.puts.map((put) => put.body.perCallMaxRaw)).toEqual(['21000', '22000']);
});

test('fees on: above what the agent may still spend, or above 0.10 USDC in total: said, no confirm', async ({
  page,
}) => {
  await setup(page, {
    agents: [payAgent({ limitLeftRaw: '21000', limitPeriod: 'week' })],
    quotes: [
      { answer: (service) => payQuote(service, { fee: true }) },
      { answer: (service) => payQuote(service, { fee: true, amountRaw: '95000' }) },
    ],
  });
  await toQuote(page);
  const quote = drawer(page).locator('.fp-quote');
  await expect(quote).toContainText(
    '0.022 USDC in total is more than hhuo may still spend this week.',
  );
  await expect(payButton(page)).toHaveCount(0);
  await drawer(page).getByRole('button', { name: 'Check price again' }).click();
  await expect(quote).toContainText(
    '0.1045 USDC in total is above 0.10 USDC, the most an agent pays for one call.',
  );
  // No per-call maximum can allow it: Change maximum isn't offered.
  await expect(quote.getByRole('button', { name: 'Change maximum' })).toHaveCount(0);
  await expect(payButton(page)).toHaveCount(0);
  expect(await rows(quote.locator('dl'))).toEqual([
    ['Price', '$0.095'],
    ['Central City fee (10%)', '$0.0095'],
    ['Total', '$0.1045'],
  ]);
});

// -------------------------------------------------------------------------------------------
// The agent's wallet

const OWNER_HEX = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_HEX).address;

/** The vault, the wallet and its reads as the wallet routes answer them (synthetic). */
async function walletOf(page: Page, agent: Agent) {
  const session = (await (await page.request.get('/api/session')).json()) as {
    operator: { id: string };
  };
  const envelope = await sealKey(OWNER_HEX, SIGN_IN_PHRASE, { N: 2 ** 17 });
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const address = expectedWallet(OWNER, agent.id);
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...baseline, agents: [agent] } }),
  );
  await page.route('**/api/agents/*/answering', (route) =>
    route.fulfill({
      json: {
        agent_id: agent.id,
        can: true,
        by: 'runtime',
        auto_reply: 'none',
        runtime_connected: true,
      },
    }),
  );
  await page.route('**/api/base/vault', (route) =>
    route.fulfill({
      json: {
        accountId: session.operator.id,
        exists: true,
        ownerAddress: OWNER,
        encryptedKey: envelope.encryptedKey,
        kdf: envelope.kdf,
        cipher: envelope.cipher,
        version: 1,
        backupConfirmedAt: Date.now(),
        challenge: { nonce: `0x${'1'.repeat(64)}`, expiresAt: Date.now() + 300_000 },
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet', (route) =>
    route.fulfill({
      json: {
        chainId: WALLET_CHAIN_ID,
        network: WALLET_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
        testnet: WALLET_CHAIN_ID !== 8453,
        address,
        ownerAddress: OWNER,
        deployed: true,
        fundingLocked: false,
        usdc: { raw: '4250000', decimals: 6, display: '4.25' },
        eth: { raw: '0', decimals: 18, display: '0' },
        readAtBlock: 18_402_113,
        readAt: Date.now(),
        stale: false,
        explorerUrl: `https://basescan.org/address/${address}`,
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet/history*', (route) => {
    const to = Date.now();
    return route.fulfill({
      json: {
        window: { from: to - 86_400_000, to },
        headBlock: 18_402_113,
        readAt: to,
        startBalance: { usdc: { raw: '4250000', decimals: 6, display: '4.25' } },
        transfers: [],
        scannedFrom: 18_300_000,
        complete: true,
      },
    });
  });
  await page.route('**/api/base/agents/*/wallet/agent-payments', (route) =>
    route.fulfill({ json: { payments: [] } }),
  );
}

test('the wallet History: the total spent, with price, fee and total and the fee’s transaction', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const list = services();
  const whois = list.find((service) => service.id === WHOIS)!;
  const agent: Agent = {
    id: PAY_AGENT_IDS.ready,
    name: 'hhuo',
    description: 'Synthetic fixture',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: '2026-10-10T12:00:00.000Z',
    revokedAt: null,
  };
  const now = Date.now();
  const item = (call: FeedPayCall, ago: number): FeedPayHistoryItem => ({
    callId: call.callId,
    origin: call.origin,
    state: call.state,
    moneyMoved: call.moneyMoved,
    service: { id: call.service.id, title: call.service.title, host: call.service.host },
    payment: call.payment,
    protocolFee: call.protocolFee,
    resultAvailable: call.result !== null,
    createdAt: now - ago,
    updatedAt: now - ago,
  });
  const withFee = payCall('result_saved', { service: whois, fee: true });
  const noFee = payCall('result_saved', { service: whois, amountRaw: '10000' });
  const history = {
    calls: [item(withFee, 60_000), item(noFee, 5 * 60_000)],
    moves: [],
    readyForServices: { raw: '978000', decimals: 6 as const, display: '0.978' },
    perCallMax: { raw: '100000', decimals: 6 as const, display: '0.1' },
    perCallMaxCapRaw: '100000',
  };
  await setup(page, {
    services: list,
    history: { [agent.id]: history },
    known: [withFee, noFee],
  });
  await walletOf(page, agent);
  for (const theme of ['light', 'dark'] as const)
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('about:blank');
      await page.goto(`/agents?workspace=v2&theme=${theme}#agent=${agent.id}:wallet`);
      const calls = page.locator('[aria-label="Service calls: hhuo"]');
      await expect(calls.locator('[data-k="service-call"]')).toHaveCount(2);
      const fee = calls.locator('[data-k="service-call"]').first();
      await expect(fee).toContainText(HOST);
      await expect(fee.locator('.w4-amt')).toHaveText('−0.022');
      const plain = calls.locator('[data-k="service-call"]').nth(1);
      await expect(plain.locator('.w4-amt')).toHaveText('−0.01');
      // The price, the fee and the total, and both transactions, in the call's sheet.
      const sheet = page.locator('[data-k="call-sheet"]');
      await fee.click();
      await expect(sheet.locator('.w4-sheet-line')).toHaveText(`Paid ${HOST} 0.02 USDC`);
      const money = sheet.locator('[data-k="service-call-fee"]');
      expect(
        await money
          .locator('.w4-fact')
          .evaluateAll((items) =>
            items.map((item) => [
              item.querySelector('dt')?.textContent ?? '',
              item.querySelector('dd')?.textContent ?? '',
            ]),
          ),
      ).toEqual([
        ['Price', '0.02 USDC'],
        ['Central City fee (10%)', '0.002 USDC'],
        ['Total', '0.022 USDC'],
        ['Found in', 'Feed'],
        ['Status', 'Paid'],
      ]);
      await expect(sheet.getByRole('link', { name: /^Base transaction/ })).toHaveAttribute(
        'href',
        /^https:\/\/basescan\.org\/tx\/0x7{64}$/,
      );
      await expect(sheet.getByRole('link', { name: /^Fee transaction/ })).toHaveAttribute(
        'href',
        `https://basescan.org/tx/${FEE_TX}`,
      );
      if (size.width < 768)
        for (const link of await sheet.getByRole('link').all())
          expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      expect(ARROWS.exec(await sheet.innerText())?.[0] ?? null).toBeNull();
      expect((await lowContrast(page, '[data-k="call-sheet"]')).low).toEqual([]);
      await shot(page, `fee-history-sheet-${size.width}-${theme}`);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(fee).toBeFocused();
      // A call from before the fee: the price, as before.
      await plain.click();
      await expect(sheet.locator('.w4-sheet-line')).toHaveText(`Paid ${HOST} 0.01 USDC`);
      await expect(sheet).not.toContainText('Central City fee');
      await expect(sheet.getByRole('link', { name: /^Fee transaction/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(ARROWS.exec(await calls.innerText())?.[0] ?? null).toBeNull();
      expect((await lowContrast(page, '[aria-label="Service calls: hhuo"]')).low).toEqual([]);
      await calls.scrollIntoViewIfNeeded();
      await shot(page, `fee-history-${size.width}-${theme}`);
    }
  // The call's own page shows the same lines.
  await page.setViewportSize(SIZES[0]);
  await page.goto(`/feed/calls/${withFee.callId}`);
  const sheet = page.locator('.fd-detail');
  await expect(sheet.locator('.fp-state')).toHaveText(`Paid 0.02 USDC to ${HOST}.`);
  expect(await rows(sheet.locator('dl[aria-label="Payment"]'))).toEqual([
    ['Price', '$0.02'],
    ['Central City fee (10%)', '$0.002'],
    ['Total', '$0.022'],
  ]);
  await plainText(page.locator('main'));
});
