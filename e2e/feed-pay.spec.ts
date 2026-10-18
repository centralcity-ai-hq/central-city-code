import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { FeedService } from '../shared/feed';
import {
  FEED_PAY_IDEMPOTENCY_KEY,
  FEED_PAY_LIMITS,
  FEED_PAY_NOTICE,
  type FeedPayCallState,
} from '../shared/feed-pay';
import type { Agent, Snapshot } from '../shared/types';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';
import { RESULT_NOTICE } from '../src/feed/pay/payModel';
import { lowContrast } from './contrast';
import {
  mockFeed,
  mockFeedPay,
  notPayable,
  PAID_RUN,
  PAY_AGENT_IDS,
  payAgent,
  payAgents,
  payCall,
  payHistory,
  payQuote,
  payResult,
  sampleServices,
  type FeedPayFakeOptions,
  type PayCallScript,
} from './feed-fixtures';

/*
 * Feed pay in the browser ("Use with my agent", docs/FEED_PAY.md section 15): the drawer's
 * actions, the use sheet (inputs, agents, price, confirm), every call state, the refusals, a
 * lost answer and a double click (one call, one key), the call's page, and the agent wallet's
 * Services. Every Feed and Feed pay route is mocked (e2e/feed-fixtures.ts): nothing is paid and
 * no real service is called. FEED_PAY_SHOTS=<dir> saves screenshots there.
 */

const headers = { 'x-city-request': '1' };
const PASSWORD = 'Local-test-only-passphrase-2026';
/** Arrow characters and arrow-like quotes: none anywhere in the Feed. */
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const MACHINE_TEXT = /city_[a-z]|[{}]|idempoten|undefined|NaN|null\b/i;

/** Otto AI's domain lookup: GET, one required query field, 0.001 USDC, an example. */
const WHOIS = 'svc_4frm2ulydi7axsyvtxhv';
const WHOIS_HOST = 'x402.ottoai.services';
/** Exa search: POST, typed body fields, 0.007 USDC. */
const EXA = 'svc_5dncjt22lvqsfdzf27sk';
/** Glassnode, made 'upto' here: not payable as listed. */
const UPTO = 'svc_7w5ucqnvla3f7kniukko';

function payServices(): FeedService[] {
  return sampleServices().map((service) =>
    service.id === UPTO ? { ...service, scheme: 'upto' as const } : service,
  );
}

async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Pay ${randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

async function setup(page: Page, pay: FeedPayFakeOptions = {}) {
  await signIn(page);
  const services = pay.services ?? payServices();
  await mockFeed(page, { services });
  return mockFeedPay(page, { services, ...pay });
}

const drawer = (page: Page) => page.getByRole('dialog');
const useButton = (page: Page) => drawer(page).getByRole('button', { name: 'Use with my agent' });
const sheetHeading = (page: Page) =>
  drawer(page).getByRole('heading', { level: 3, name: 'Use with my agent' });
const stateLine = (page: Page) => drawer(page).locator('.fp-state');
const payButton = (page: Page) => drawer(page).getByRole('button', { name: /^Pay [\d.]+ USDC$/ });
const confirmLine = (page: Page) => drawer(page).locator('.fp-confirm');
const agentRadio = (page: Page, name: string) =>
  drawer(page).getByRole('radio', { name: new RegExp(`^${name}\\b`) });

async function openDrawer(page: Page, id = WHOIS, host = WHOIS_HOST) {
  await page.goto(`/feed?host=${host}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await page.locator(`#fd-t-${id}`).click();
  await expect(drawer(page)).toBeVisible();
}

/** The use sheet with the example accepted and hhuo picked, up to the confirm. */
async function toConfirm(page: Page) {
  await useButton(page).click();
  await expect(sheetHeading(page)).toBeFocused();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  const hhuo = agentRadio(page, 'hhuo');
  if (!(await hhuo.isChecked())) await hhuo.check();
  await drawer(page)
    .getByRole('button', { name: /^Check price/ })
    .click();
  await expect(payButton(page)).toBeVisible();
}

async function plainText(locator: Locator) {
  const text = await locator.evaluate((element) => (element as HTMLElement).innerText);
  expect(ARROWS.exec(text)?.[0] ?? null).toBeNull();
  // The result is the service's own text and may hold anything; everything else is ours.
  const ours = text.replace(/\{[\s\S]*\}/g, '');
  const hit = MACHINE_TEXT.exec(ours);
  expect(hit ? ours.slice(Math.max(0, hit.index - 40), hit.index + 40) : null).toBeNull();
}

const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      [...document.querySelectorAll<HTMLElement>('.fd-drawer, .fd-d-body, main')].every(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
  );

async function shot(page: Page, name: string) {
  const dir = process.env.FEED_PAY_SHOTS;
  if (!dir) return;
  // After the drawer's open animation: mid-way, the list behind shows through it.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.screenshot({ path: `${dir}/${name}.png` });
}

const LOST =
  'We didn’t get an answer, so we can’t tell yet whether the payment started. Check again: it never pays twice.';
const STILL_LOST =
  'We still can’t tell whether the payment started. Check again in a minute: it never pays twice.';

// -------------------------------------------------------------------------------------------
// The drawer before paying

test('Feed pay off or not allowed: today’s drawer, without Open service or any pay action', async ({
  page,
}) => {
  const pay = await setup(page, { mode: 'off' });
  await openDrawer(page);
  const foot = drawer(page).locator('.fd-d-foot');
  await expect(foot.getByRole('button', { name: 'Copy service address' })).toHaveClass(
    /\bprimary\b/,
  );
  await expect(foot.getByRole('button', { name: /^Copy link/ })).toBeVisible();
  await expect.poll(() => pay.agentReads).toBe(0);
  await expect(useButton(page)).toHaveCount(0);
  await expect(drawer(page).getByRole('link', { name: /Open service/ })).toHaveCount(0);
  await expect(drawer(page)).not.toContainText('Sign in to use it');
  await drawer(page).locator('.fd-service-tech > summary').click();
  await expect(drawer(page).getByRole('region', { name: 'How to use it' })).toContainText(
    'Central City can’t pay it for your agents yet.',
  );
  await expect(drawer(page)).toContainText('Nothing is paid through the Feed.');
  await expect(drawer(page)).toContainText('Central City hasn’t called this service.');
  // Off, the Offered strip keeps today's words.
  await expect(page.locator('.fd-strip')).toContainText('Nothing is paid through the Feed.');
  expect(pay.quotes).toEqual([]);
});

test('signed out (the session lapsed): said, Sign in to use it first, the page stays readable', async ({
  page,
}) => {
  await setup(page, { mode: 'signed_out' });
  await openDrawer(page);
  const signIn = drawer(page).getByRole('button', { name: 'Sign in to use it' });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveClass(/\bprimary\b/);
  await expect(drawer(page).locator('.fd-d-foot')).toContainText(
    'You were signed out. Sign in again to use it with your agent.',
  );
  await expect(useButton(page)).toHaveCount(0);
  await expect(drawer(page).getByRole('button', { name: 'Copy service address' })).not.toHaveClass(
    /\bprimary\b/,
  );
  await expect(drawer(page)).toContainText('What it does');
});

test('signed out, the drawer is above the site header: its title and Close are its own', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await mockFeed(page, { services: payServices() });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await openDrawer(page);
      await expect(page.locator('.cc-header, .site-nav').first()).toBeAttached();
      for (const target of [
        drawer(page).getByRole('heading', { level: 2 }),
        drawer(page)
          .getByRole('button', { name: /^Close/ })
          .first(),
      ]) {
        const box = (await target.boundingBox())!;
        const inside = await page.evaluate(
          ([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('.fd-drawer')),
          [box.x + Math.min(box.width / 2, 12), box.y + box.height / 2],
        );
        expect(inside).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(drawer(page)).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

test('a payable listing: Use with my agent first; not payable as listed: why, and the address', async ({
  page,
}) => {
  const pay = await setup(page);
  await openDrawer(page);
  await expect(useButton(page)).toBeVisible();
  await expect(useButton(page)).toHaveClass(/\bprimary\b/);
  await expect(drawer(page).getByRole('button', { name: 'Copy service address' })).not.toHaveClass(
    /\bprimary\b/,
  );
  await expect(drawer(page).getByRole('link', { name: /Open service/ })).toHaveCount(0);
  await drawer(page).locator('.fd-service-tech > summary').click();
  await expect(drawer(page).getByRole('region', { name: 'How to use it' })).toContainText(
    'Use with my agent pays the service from your agent’s wallet and shows the result here. A program with its own x402 client can also call the service address.',
  );
  await expect(drawer(page)).not.toContainText('Nothing is paid through the Feed.');
  // Limitations true with pay on: Central City may call it for you; you see the price first.
  await expect(drawer(page)).not.toContainText('Central City hasn’t called this service.');
  await expect(drawer(page)).not.toContainText('The price is as listed.');
  await expect(drawer(page)).toContainText('you see what your agent pays before you confirm');
  // The Offered strip says how paying works, never that nothing is paid.
  const strip = page.locator('.fd-strip');
  await expect(strip).toContainText(
    'Use with my agent pays one from your agent’s own wallet after you confirm.',
  );
  await expect(strip).not.toContainText('Nothing is paid');
  expect(pay.agentReads).toBeGreaterThanOrEqual(1);
  // At 1440 the actions are one row, Close included.
  const tops = await drawer(page)
    .locator('.fd-d-foot > button, .fd-d-foot > .fd-btn')
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(new Set(tops.map(Math.round)).size).toBe(1);
  await shot(page, 'drawer-button-1440-light');
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);

  await openDrawer(page, UPTO, 'x402.glassnode.com');
  await expect(useButton(page)).toHaveCount(0);
  await expect(drawer(page).locator('.fp-setup')).toHaveText(
    'This one needs its own setup. This service only takes pay-per-use payments. Your agent pays fixed prices only.',
  );
  await expect(drawer(page).getByRole('button', { name: 'Copy service address' })).toHaveClass(
    /\bprimary\b/,
  );
  expect(pay.quotes).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// The use sheet

test('the whole run: inputs, agent, price, one confirm, every state, the External result', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const pay = await setup(page, { quoteDelayMs: 700 });
  await openDrawer(page);
  await useButton(page).click();
  await expect(sheetHeading(page)).toBeFocused();
  const sheet = drawer(page);
  // The form from the listing: required marked, the example a hint, the field empty.
  await expect(sheet.getByRole('heading', { level: 4, name: 'What to send' })).toBeVisible();
  const domain = sheet.getByRole('textbox', { name: /domain/ });
  await expect(domain).toHaveValue('');
  await expect(domain).toHaveAttribute('aria-required', 'true');
  await expect(sheet.locator('[data-key="query:domain"] .fp-req')).toHaveText('Required');
  await expect(sheet).toContainText('Example: { "domain": "stripe.com" }');
  // The agents: each with its lines, the blocked ones with why and the link that fixes it.
  const group = sheet.getByRole('group', { name: 'Agent that pays' });
  await expect(group).toBeVisible();
  await expect(agentRadio(page, 'hhuo')).toBeEnabled();
  await expect(agentRadio(page, 'hhuo')).not.toBeChecked();
  for (const blocked of ['Ledger Scout', 'Night Owl', 'Paused Pat'])
    await expect(agentRadio(page, blocked)).toBeDisabled();
  await expect(agentRadio(page, 'Slow Sam')).toBeEnabled();
  await expect(group).toContainText('4.25 USDC');
  await expect(group).toContainText('3.50 of 5.00 USDC left today');
  await expect(group).toContainText('Ready for services: 1.00 USDC');
  await expect(group).toContainText('Per-call maximum: 0.10 USDC');
  await expect(group).toContainText('Ledger Scout needs a spending limit first.');
  await expect(group.getByRole('link', { name: 'Set a spending limit' })).toHaveAttribute(
    'href',
    `/agents#agent=${PAY_AGENT_IDS.noLimit}:wallet-limits`,
  );
  await expect(group).toContainText('Night Owl has no USDC yet.');
  await expect(group.getByRole('link', { name: 'Add funds' })).toHaveAttribute(
    'href',
    `/agents#agent=${PAY_AGENT_IDS.noFunds}:wallet-add`,
  );
  await expect(group).toContainText('Paused Pat is paused.');
  await expect(group.getByRole('link', { name: 'Open Paused Pat' })).toHaveAttribute(
    'href',
    `/agents#agent=${PAY_AGENT_IDS.paused}`,
  );
  await expect(group).toContainText('Balance not available right now.');
  // The agents that can pay come first.
  await expect(group.locator('.fp-agent').first()).not.toHaveAttribute('data-blocked', 'true');
  await expect(group.locator('.fp-agent').last()).toHaveAttribute('data-blocked', 'true');
  await shot(page, 'use-sheet-1440-light');
  await plainText(sheet);

  // Check price first: nothing typed, no agent. Nothing is asked.
  await sheet.getByRole('button', { name: 'Check price' }).click();
  const summary = sheet.locator('.fd-errsum');
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('Fill in domain.');
  await expect(summary).toContainText('Pick the agent that pays.');
  await expect(domain).toHaveAttribute('aria-invalid', 'true');
  expect(pay.quotes).toEqual([]);

  // The example, accepted with one click; the agent picked.
  await sheet.getByRole('button', { name: 'Fill with example' }).click();
  await expect(domain).toHaveValue('stripe.com');
  await agentRadio(page, 'hhuo').check();
  await expect(summary).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Check price' }).click();
  await expect(sheet.getByRole('button', { name: 'Checking the price…' })).toBeVisible();
  await expect(sheet.locator('.fp-quote')).toContainText('Checking the price…');
  // The price, then the one confirm that names the amount, the agent and the payee.
  await expect(sheet.locator('.fp-price')).toHaveText(/Price now\s*0\.001 USDC per call/);
  await expect(confirmLine(page)).toHaveText(
    `Pay 0.001 USDC from hhuo to ${WHOIS_HOST}? You can’t undo it.`,
  );
  await expect(confirmLine(page)).toBeFocused();
  await expect(payButton(page)).toHaveText('Pay 0.001 USDC');
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeVisible();
  // Under the price: what hhuo may still spend (its card's numbers), and the fresh check.
  await expect(sheet.locator('.fp-allow-line')).toHaveText(
    'hhuo has 3.50 of 5.00 USDC left today · most per call 0.10',
  );
  await expect(sheet.locator('.fp-bar')).toHaveAttribute(
    'aria-label',
    '3.50 of 5.00 USDC left today',
  );
  await expect(sheet.locator('.fp-ok')).toHaveText('Price checked with the service just now');
  expect(pay.quotes).toHaveLength(1);
  expect(pay.quotes[0]!.serviceId).toBe(WHOIS);
  expect(pay.quotes[0]!.body).toEqual({ inputs: { query: { domain: 'stripe.com' } } });
  expect(pay.quotes[0]!.headers['x-city-request']).toBe('1');
  await shot(page, 'confirm-1440-light');

  // Pay: the call card takes focus and reads out each state until Base decided.
  await payButton(page).click();
  const card = sheet.locator('.fp-call');
  await expect(sheet.getByRole('heading', { level: 3, name: 'Your call' })).toBeFocused();
  await expect(stateLine(page)).toHaveAttribute('role', 'status');
  // The engine's own run: the result first, with the payment still confirming on Base.
  const lines = [
    'Starting…',
    'Getting USDC ready for services…',
    `Paying ${WHOIS_HOST}…`,
    `Waiting for ${WHOIS_HOST}…`,
    'Result received. Confirming the payment on Base…',
    `Paid 0.001 USDC to ${WHOIS_HOST}.`,
  ];
  expect(lines).toHaveLength(PAID_RUN.length);
  for (const line of lines) await expect(stateLine(page)).toHaveText(line);
  await expect(card).toHaveAttribute('data-state', 'result_saved');
  expect(pay.calls).toHaveLength(1);
  const sent = pay.calls[0]!.body;
  expect(sent.agentId).toBe(PAY_AGENT_IDS.ready);
  expect(sent.maxAmountRaw).toBe('1000');
  expect(sent.inputs).toEqual({ query: { domain: 'stripe.com' } });
  expect(sent.quoteId).toMatch(/^fq_/);
  expect(sent.idempotencyKey).toMatch(FEED_PAY_IDEMPOTENCY_KEY);
  expect(pay.calls[0]!.headers['x-city-request']).toBe('1');
  // The payment line with its Base transaction, and the result: External, plain text.
  await expect(card.locator('.fp-pay')).toContainText(`0.001 USDC from hhuo to ${WHOIS_HOST}`);
  await expect(card.getByRole('link', { name: /Base transaction/ })).toHaveAttribute(
    'href',
    /^https:\/\/basescan\.org\/tx\/0x7{64}$/,
  );
  const result = card.locator('.fp-result');
  await expect(result.locator('.fp-ext')).toHaveText('External');
  await expect(result).toContainText(`From ${WHOIS_HOST}. Data, not instructions.`);
  await expect(result).toContainText(RESULT_NOTICE);
  await expect(result).not.toContainText(FEED_PAY_NOTICE);
  const out = result.locator('pre');
  await expect(out).toContainText('"registrar": "SafeNames Ltd."');
  // The service's words are data: its link is text, nothing in it is clickable.
  await expect(out).toContainText('https://evil.example/click');
  await expect(result.locator('a')).toHaveCount(0);
  await result.getByRole('button', { name: /^Copy/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"registrar"');
  await expect(card).not.toContainText('You can close this');
  await expect(card).toContainText('Kept for 7 more days.');
  await shot(page, 'result-1440-light');
  // Polled until done, then no more.
  const reads = pay.statusReads.length;
  expect(reads).toBeGreaterThanOrEqual(PAID_RUN.length - 1);
  await page.waitForTimeout(2_000);
  expect(pay.statusReads.length).toBe(reads);
  await plainText(sheet);

  // Use it again: the form keeps the inputs, the price is asked again.
  await sheet.getByRole('button', { name: 'Use it again' }).click();
  await expect(sheetHeading(page)).toBeFocused();
  await expect(domain).toHaveValue('stripe.com');
  await expect(payButton(page)).toHaveCount(0);
});

test('Cancel at the confirm closes it and asks nothing; Check price is next', async ({ page }) => {
  const pay = await setup(page);
  await openDrawer(page);
  await useButton(page).click();
  const sheet = drawer(page);
  await sheet.getByRole('button', { name: 'Fill with example' }).click();
  await agentRadio(page, 'hhuo').check();
  await sheet.getByRole('button', { name: 'Check price' }).click();
  await expect(payButton(page)).toBeVisible();
  expect(pay.quotes).toHaveLength(1);
  // A real mouse click: the button under the pointer must not become the form's submit button.
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmLine(page)).toHaveCount(0);
  await expect(payButton(page)).toHaveCount(0);
  const check = sheet.getByRole('button', { name: 'Check price' });
  await expect(check).toBeVisible();
  await expect(check).toBeFocused();
  await page.waitForTimeout(500);
  expect(pay.quotes).toHaveLength(1);
  expect(pay.calls).toEqual([]);
});

test('every way a call ends says plainly whether money moved', async ({ page }) => {
  test.setTimeout(120_000);
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  type CallOptions = Omit<Parameters<typeof payCall>[1], 'service'>;
  const steps = (...states: Array<[FeedPayCallState, CallOptions?]>) => ({
    steps: states.map(([state, options]) => payCall(state, { service: whois, ...options })),
  });
  const runs: Array<{ script: PayCallScript; line: string; also?: string[]; none?: string[] }> = [
    {
      script: steps(['calling'], ['reconciling'], ['paid_no_result']),
      line: `Paid 0.001 USDC to ${WHOIS_HOST}, but it sent no result. We told our team.`,
      none: ['External'],
    },
    {
      script: steps(
        ['calling'],
        ['not_settled', { result: payResult('error') }],
        ['cancelled', { result: payResult('error') }],
      ),
      line: 'The service answered with an error. No money moved.',
      also: [`${WHOIS_HOST} answered 500.`, 'Internal error at upstream.', 'Not paid'],
    },
    {
      script: steps(['calling'], ['expired']),
      line: 'The service didn’t answer in time. No money moved.',
    },
    {
      script: steps(['float_topup'], ['refused']),
      line: 'The agent’s wallet doesn’t have enough USDC. Nothing was paid.',
    },
    {
      script: steps(['refused', { failure: 'paused' }]),
      line: 'Paying services was paused before this payment was signed. Nothing was paid.',
    },
    {
      script: steps(
        ['result_saved', { paymentState: 'sent' }],
        ['result_saved', { paymentState: 'settled' }],
      ),
      line: `Paid 0.001 USDC to ${WHOIS_HOST}.`,
      also: ['External'],
    },
    {
      script: steps(['result_saved', { paymentState: 'cancelled', result: payResult('text') }]),
      line: 'Result received. No money moved.',
      also: ['Domain stripe.com is registered.'],
    },
    {
      script: steps(['result_saved', { result: payResult('binary') }]),
      line: `Paid 0.001 USDC to ${WHOIS_HOST}.`,
      also: [`${WHOIS_HOST} sent a file (image/png, 47.1 KB). It isn’t shown here.`],
      none: ['Copy the result'],
    },
    {
      script: steps(['result_saved', { result: payResult('truncated') }]),
      line: `Paid 0.001 USDC to ${WHOIS_HOST}.`,
      also: ['Showing the first 1 MB.'],
    },
  ];
  const pay = await setup(page, {
    services,
    agents: [payAgent(), payAgents()[1]!],
    calls: runs.map((run) => run.script),
  });
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  // The only agent that can pay is picked already.
  await expect(agentRadio(page, 'hhuo')).toBeChecked();
  for (const [index, run] of runs.entries()) {
    await drawer(page)
      .getByRole('button', { name: /^Check price/ })
      .click();
    await payButton(page).click();
    // A result before Base decided: shown at once, the payment still confirming.
    if (index === 5) {
      await expect(stateLine(page)).toHaveText('Result received. Confirming the payment on Base…');
      await expect(drawer(page).locator('.fp-pay')).toContainText('Confirming on Base');
      await expect(drawer(page).locator('.fp-result')).toBeVisible();
    }
    await expect(stateLine(page)).toHaveText(run.line, { timeout: 15_000 });
    for (const text of run.also ?? []) await expect(drawer(page)).toContainText(text);
    for (const text of run.none ?? [])
      await expect(drawer(page).locator('.fp-call')).not.toContainText(text);
    await plainText(drawer(page));
    await drawer(page).getByRole('button', { name: 'Use it again' }).click();
  }
  // One call per confirm, each with its own key.
  expect(new Set(pay.calls.map((call) => call.body.idempotencyKey)).size).toBe(runs.length);
});

test('a price above the listing is said; a price that rose since needs a new confirm', async ({
  page,
}) => {
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  const rose = payQuote(whois, { amountRaw: '3000' });
  const pay = await setup(page, {
    services,
    agents: [payAgent()],
    quotes: [{ answer: (service) => payQuote(service, { amountRaw: '2000' }) }],
    calls: [
      {
        failure: {
          status: 409,
          code: 'price_above_max',
          quote: rose,
          neededRaw: '3000',
        },
      },
      { steps: [payCall('result_saved', { service: whois, amountRaw: '3000' })] },
    ],
  });
  await openDrawer(page);
  await toConfirm(page);
  await expect(drawer(page).locator('.fp-quote')).toContainText(
    'The service asks 0.002 USDC now. The listing says 0.001 USDC.',
  );
  await expect(confirmLine(page)).toHaveText(
    `Pay 0.002 USDC from hhuo to ${WHOIS_HOST}? You can’t undo it.`,
  );
  await payButton(page).click();
  // What was confirmed, what is asked now, and that nothing was paid.
  await expect(drawer(page).locator('.fp-quote')).toContainText(
    'The price went up from 0.002 to 0.003 USDC. Nothing was paid. Confirm the new price.',
  );
  await expect(confirmLine(page)).toHaveText(
    `Pay 0.003 USDC from hhuo to ${WHOIS_HOST}? You can’t undo it.`,
  );
  await expect(confirmLine(page)).toBeFocused();
  await payButton(page).click();
  await expect(stateLine(page)).toHaveText(`Paid 0.003 USDC to ${WHOIS_HOST}.`);
  expect(pay.calls.map((call) => [call.body.maxAmountRaw, call.body.quoteId])).toEqual([
    ['2000', pay.calls[0]!.body.quoteId],
    ['3000', rose.quoteId],
  ]);
  expect(pay.calls[0]!.body.idempotencyKey).not.toBe(pay.calls[1]!.body.idempotencyKey);
});

test('above the per-call maximum: Change maximum in place, then the confirm', async ({ page }) => {
  const most = BigInt(FEED_PAY_LIMITS.perCallMaxMaxRaw);
  const usdc = (raw: bigint) =>
    (Number(raw) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const pay = await setup(page, {
    agents: [payAgent({ perCallMaxRaw: '50000', perCallMaxIsDefault: false })],
    quotes: [{ answer: (service) => payQuote(service, { amountRaw: '80000' }) }],
  });
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  await drawer(page).getByRole('button', { name: 'Check price' }).click();
  const quote = drawer(page).locator('.fp-quote');
  await expect(quote).toContainText('0.08 USDC is above hhuo’s per-call maximum of 0.05 USDC.');
  await expect(payButton(page)).toHaveCount(0);
  const change = quote.getByRole('button', { name: 'Change maximum' });
  await change.click();
  const input = drawer(page).getByRole('textbox', { name: /Per-call maximum for hhuo/ });
  await expect(input).toBeFocused();
  // While editing, the footer offers nothing else to press.
  await expect(drawer(page).getByRole('button', { name: /^Check price/ })).toHaveCount(0);
  // Escape leaves the editor, not the drawer; focus goes back to Change maximum.
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(change).toBeFocused();
  // Cancel: the same.
  await change.click();
  await drawer(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(change).toBeFocused();
  await change.click();
  await input.fill(usdc(most + 1n));
  await drawer(page).getByRole('button', { name: 'Save' }).click();
  await expect(drawer(page).getByRole('alert')).toContainText(
    `Use an amount from 0.000001 to ${(Number(most) / 1e6).toFixed(2)} USDC.`,
  );
  expect(pay.puts).toEqual([]);
  // Saved, but still below the price: said, and focus back on Change maximum.
  await input.fill('0.06');
  await drawer(page).getByRole('button', { name: 'Save' }).click();
  await expect(quote).toContainText('Saved. hhuo now pays at most 0.06 USDC per call.');
  await expect(change).toBeFocused();
  await change.click();
  await input.fill('0.1');
  await drawer(page).getByRole('button', { name: 'Save' }).click();
  await expect(confirmLine(page)).toHaveText(
    `Pay 0.08 USDC from hhuo to ${WHOIS_HOST}? You can’t undo it.`,
  );
  await expect(confirmLine(page)).toBeFocused();
  await expect(quote).toContainText('Saved. hhuo now pays at most 0.10 USDC per call.');
  expect(pay.puts).toEqual([
    { agentId: PAY_AGENT_IDS.ready, body: { perCallMaxRaw: '60000' } },
    { agentId: PAY_AGENT_IDS.ready, body: { perCallMaxRaw: '100000' } },
  ]);
  await expect(drawer(page).getByRole('group', { name: 'Agent that pays' })).toContainText(
    'Per-call maximum: 0.10 USDC',
  );
});

test('above what the agent may still spend: said, and no confirm', async ({ page }) => {
  await setup(page, {
    agents: [payAgent({ limitLeftRaw: '500', limitPeriod: 'week' })],
  });
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  await drawer(page).getByRole('button', { name: 'Check price' }).click();
  await expect(drawer(page).locator('.fp-quote')).toContainText(
    '0.001 USDC is more than hhuo may still spend this week.',
  );
  await expect(payButton(page)).toHaveCount(0);
  await expect(drawer(page).getByRole('button', { name: 'Check price again' })).toBeVisible();
});

test('refusals: not payable, a service that didn’t answer, too little USDC; nothing was paid', async ({
  page,
}) => {
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  const pay = await setup(page, {
    services,
    agents: [payAgent()],
    quotes: [
      { answer: notPayable(whois, 'payee_mismatch') },
      { failure: { status: 502, code: 'service_unreachable' } },
      { failure: { status: 503, code: 'unavailable', error: 'chain_down {raw}' } },
      { answer: (service) => payQuote(service) },
    ],
    calls: [{ failure: { status: 409, code: 'insufficient_funds', neededRaw: '1000' } }],
  });
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  const check = () =>
    drawer(page)
      .getByRole('button', { name: /^Check price/ })
      .click();
  await check();
  const quote = drawer(page).locator('.fp-quote');
  // A payee that isn't the listing's is a stop, not a setup matter: no address to pay it with.
  await expect(quote).toContainText('We stopped before paying.');
  await expect(quote.locator('.fp-box')).toHaveAttribute('data-tone', 'bad');
  await expect(quote).toContainText(
    'This service asks to be paid at another address than its listing. Nothing was paid.',
  );
  await expect(quote).not.toContainText(/We stopped before paying\..*We stopped before paying\./);
  await expect(
    drawer(page).locator('.fp-foot').getByRole('button', { name: 'Copy service address' }),
  ).toHaveCount(0);
  // A change of input asks again.
  await drawer(page)
    .getByRole('textbox', { name: /domain/ })
    .fill('example.com');
  await check();
  await expect(quote.getByRole('alert')).toHaveText(
    'The service didn’t answer. Try again in a moment. Nothing was paid.',
  );
  await check();
  // Our own words, never the server's.
  await expect(quote.getByRole('alert')).toHaveText(
    'Payments on Base are not available right now. Try again in a moment. Nothing was paid.',
  );
  await check();
  await payButton(page).click();
  await expect(drawer(page).locator('.fp-foot [role="alert"]')).toHaveText(
    'This agent doesn’t have enough USDC. Nothing was paid.',
  );
  await expect(payButton(page)).toHaveCount(0);
  expect(pay.calls).toHaveLength(1);
  await plainText(drawer(page));
});

test('a spending limit that hasn’t started: said on its card; a call refused for it says so, never no answer', async ({
  page,
}) => {
  const STARTS = 'Spending limit starts at 00:00 (Berlin), 15 Oct.';
  const startsAt = '2026-10-14T22:00:00.000Z';
  const pay = await setup(page, {
    agents: [
      payAgent(),
      payAgent({
        agentId: PAY_AGENT_IDS.noLimit,
        name: 'Early Bird',
        wallet: `0x${'c'.repeat(40)}`,
        spender: `0x${'d'.repeat(40)}`,
        limitLeftRaw: null,
        limitStartsAt: startsAt,
        ready: false,
        notReady: 'limit_not_started',
      }),
    ],
    // Base hasn't reached the start yet when hhuo's call comes in: refused for sure.
    calls: [{ failure: { status: 409, code: 'limit_not_started', startsAt } }],
  });
  await openDrawer(page);
  await useButton(page).click();
  const agents = drawer(page).getByRole('group', { name: 'Agent that pays' });
  await expect(agents).toContainText(STARTS);
  await expect(agentRadio(page, 'Early Bird')).toBeDisabled();
  await expect(agentRadio(page, 'hhuo')).toBeEnabled();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  await expect(agentRadio(page, 'hhuo')).toBeChecked();
  await drawer(page)
    .getByRole('button', { name: /^Check price/ })
    .click();
  await payButton(page).click();
  await expect(drawer(page).locator('.fp-foot [role="alert"]')).toHaveText(
    `${STARTS} Nothing was paid.`,
  );
  await expect(drawer(page)).not.toContainText(/can’t tell|didn’t get an answer/);
  await expect(payButton(page)).toHaveCount(0);
  expect(pay.calls).toHaveLength(1);
  await plainText(drawer(page));
});

test('an expired price check is checked again by itself, then confirmed again', async ({
  page,
}) => {
  const pay = await setup(page, {
    agents: [payAgent()],
    calls: [{ failure: { status: 409, code: 'quote_expired' } }],
  });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  await expect(drawer(page).locator('.fp-quote')).toContainText(
    'The price check expired, so we checked again. Confirm to pay.',
  );
  await expect(payButton(page)).toBeVisible();
  expect(pay.quotes).toHaveLength(2);
  expect(pay.calls).toHaveLength(1);
});

test('a lost answer asks again with the same key: one call, never two', async ({ page }) => {
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  const pay = await setup(page, {
    services,
    agents: [payAgent()],
    calls: [{ steps: [payCall('result_saved', { service: whois })], lost: 1 }],
  });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  const foot = drawer(page).locator('.fp-foot');
  await expect(foot.getByRole('alert')).toHaveText(
    'We didn’t get an answer, so we can’t tell yet whether the payment started. Check again: it never pays twice.',
  );
  await expect(foot).not.toContainText('Nothing was paid');
  await foot.getByRole('button', { name: 'Check again' }).click();
  await expect(stateLine(page)).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`);
  expect(pay.calls).toHaveLength(2);
  expect(pay.calls[0]!.body).toEqual(pay.calls[1]!.body);
  expect(pay.live.size).toBe(1);
});

test('asked again, a refusal from before the key is looked up keeps it lost: the same key', async ({
  page,
}) => {
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  const pay = await setup(page, {
    services,
    agents: [payAgent()],
    calls: [{ steps: [payCall('result_saved', { service: whois })], lost: 1 }],
    // The second POST meets the rate limit, the third a busy database: neither looked up the key.
    beforeKey: { 1: { status: 429, code: 'rate_limited' }, 2: { code: 'busy' } },
  });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  const foot = drawer(page).locator('.fp-foot');
  await expect(foot.getByRole('alert')).toHaveText(LOST);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await foot.getByRole('button', { name: 'Check again' }).click();
    await expect(foot.getByRole('alert')).toHaveText(STILL_LOST);
    await expect(drawer(page)).not.toContainText('Nothing was paid');
    await expect(payButton(page)).toHaveCount(0);
  }
  await foot.getByRole('button', { name: 'Check again' }).click();
  await expect(stateLine(page)).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`);
  expect(pay.calls).toHaveLength(4);
  expect(new Set(pay.calls.map((call) => JSON.stringify(call.body))).size).toBe(1);
  expect(pay.live.size).toBe(1);
});

test('busy after the call started is a lost answer, never "Nothing was paid."', async ({
  page,
}) => {
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  const pay = await setup(page, {
    services,
    agents: [payAgent()],
    calls: [
      {
        steps: [payCall('result_saved', { service: whois })],
        failAfterStart: { times: 1, failure: { code: 'busy' } },
      },
    ],
  });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  const foot = drawer(page).locator('.fp-foot');
  await expect(foot.getByRole('alert')).toHaveText(LOST);
  await expect(drawer(page)).not.toContainText('Nothing was paid');
  await foot.getByRole('button', { name: 'Check again' }).click();
  await expect(stateLine(page)).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`);
  expect(pay.calls).toHaveLength(2);
  expect(pay.calls[0]!.body).toEqual(pay.calls[1]!.body);
  expect(pay.live.size).toBe(1);
});

test('leaving the sheet after a lost answer keeps that payment: opened again, the same key', async ({
  page,
}) => {
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
  const pay = await setup(page, {
    services,
    agents: [payAgent()],
    calls: [{ steps: [payCall('result_saved', { service: whois })], lost: 1 }],
  });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  const foot = drawer(page).locator('.fp-foot');
  await expect(foot.getByRole('alert')).toHaveText(LOST);
  // Back to the service, then Use with my agent again: the same payment, no new Pay.
  await drawer(page).getByRole('button', { name: 'Back to the service' }).click();
  await useButton(page).click();
  await expect(foot.getByRole('alert')).toHaveText(LOST);
  await expect(payButton(page)).toHaveCount(0);
  await expect(drawer(page).getByRole('textbox', { name: /domain/ })).toHaveValue('stripe.com');
  // The drawer closed and the service opened again: the sheet shows by itself.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await page.locator(`#fd-t-${WHOIS}`).click();
  await expect(sheetHeading(page)).toBeVisible();
  await expect(foot.getByRole('alert')).toHaveText(LOST);
  await foot.getByRole('button', { name: 'Check again' }).click();
  await expect(stateLine(page)).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`);
  expect(pay.calls).toHaveLength(2);
  expect(pay.calls[0]!.body).toEqual(pay.calls[1]!.body);
  expect(pay.live.size).toBe(1);
});

test('closing the drawer while paying: opened again, it follows that call; no second key', async ({
  page,
}) => {
  const pay = await setup(page, { agents: [payAgent()], callDelayMs: 1_500 });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).click();
  await expect(drawer(page).getByRole('button', { name: 'Paying…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await page.locator(`#fd-t-${WHOIS}`).click();
  await expect(sheetHeading(page).or(drawer(page).locator('.fp-call'))).toBeVisible();
  await expect(payButton(page)).toHaveCount(0);
  await expect(stateLine(page).last()).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`, {
    timeout: 15_000,
  });
  expect(pay.calls).toHaveLength(1);
});

test('paying switched off while the sheet is open: the sheet stays and says so', async ({
  page,
}) => {
  const pay = await setup(page, { agents: [payAgent()] });
  await openDrawer(page);
  await toConfirm(page);
  pay.setMode('off');
  await payButton(page).click();
  await expect(drawer(page).locator('.fp-foot [role="alert"]')).toHaveText(
    'Paying services is not available right now. Nothing was paid.',
  );
  await expect(sheetHeading(page)).toBeVisible();
  // Back: the details as they are now, without paying.
  await drawer(page).getByRole('button', { name: 'Back to the service' }).click();
  await expect(useButton(page)).toHaveCount(0);
  await expect(drawer(page).getByRole('button', { name: 'Copy service address' })).toHaveClass(
    /\bprimary\b/,
  );
});

test('the session lapsed in the sheet: said, with Sign in to use it', async ({ page }) => {
  const pay = await setup(page, { agents: [payAgent()] });
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  pay.setMode('signed_out');
  await drawer(page).getByRole('button', { name: 'Check price' }).click();
  await expect(drawer(page).locator('.fp-quote [role="alert"]')).toHaveText(
    'You’re signed out. Sign in again, then try once more. Nothing was paid.',
  );
  const signIn = drawer(page)
    .locator('.fp-foot')
    .getByRole('button', { name: 'Sign in to use it' });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveClass(/\bprimary\b/);
  await expect(sheetHeading(page)).toBeVisible();
});

test('too little USDC is said before the confirm, with Add funds', async ({ page }) => {
  const pay = await setup(page, { agents: [payAgent({ usdcRaw: '500', floatRaw: '0' })] });
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  await drawer(page).getByRole('button', { name: 'Check price' }).click();
  const quote = drawer(page).locator('.fp-quote');
  await expect(quote).toContainText('hhuo has 0.0005 USDC, less than this call costs.');
  await expect(quote.getByRole('link', { name: 'Add funds' })).toHaveAttribute(
    'href',
    `/agents#agent=${PAY_AGENT_IDS.ready}:wallet-add`,
  );
  await expect(payButton(page)).toHaveCount(0);
  expect(pay.calls).toEqual([]);
});

test('no agent with a wallet: where to make one, and nothing to check', async ({ page }) => {
  await setup(page, { agents: [] });
  await openDrawer(page);
  await useButton(page).click();
  const group = drawer(page).getByRole('group', { name: 'Agent that pays' });
  await expect(group).toContainText('You have no agent with a wallet on Base yet.');
  // The heading reads on one line (16 Oct: it was squeezed to one letter per line).
  const legend = await group.locator('legend').boundingBox();
  expect(legend!.width).toBeGreaterThan(60);
  expect(legend!.height).toBeLessThan(40);
  await expect(group.getByRole('link', { name: 'Go to My agents' })).toHaveAttribute(
    'href',
    '/agents',
  );
  await expect(drawer(page).getByRole('button', { name: /^Check price/ })).toHaveCount(0);
});

test('a double click on Pay sends one call', async ({ page }) => {
  const pay = await setup(page, { agents: [payAgent()], callDelayMs: 600 });
  await openDrawer(page);
  await toConfirm(page);
  await payButton(page).dblclick();
  await expect(drawer(page).getByRole('button', { name: 'Paying…' })).toBeVisible();
  await expect(drawer(page).locator('.fp-call')).toBeVisible();
  expect(pay.calls).toHaveLength(1);
});

test('keyboard: Escape cancels the confirm, then closes; Back returns focus to the button', async ({
  page,
}) => {
  const pay = await setup(page, { agents: [payAgent()] });
  await openDrawer(page);
  await toConfirm(page);
  // Enter in a field never pays: only the Pay button does.
  await drawer(page)
    .getByRole('textbox', { name: /domain/ })
    .press('Enter');
  await expect(payButton(page)).toBeVisible();
  expect(pay.calls).toEqual([]);
  await confirmLine(page).focus();
  await page.keyboard.press('Escape');
  await expect(payButton(page)).toHaveCount(0);
  await expect(drawer(page).getByRole('button', { name: 'Check price' })).toBeFocused();
  await drawer(page).getByRole('button', { name: 'Back to the service' }).click();
  await expect(useButton(page)).toBeFocused();
  await useButton(page).click();
  await expect(sheetHeading(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator(`#fd-t-${WHOIS}`)).toBeFocused();
});

test('Set a spending limit opens the agent’s own screen in My agents', async ({ page }) => {
  await setup(page);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const ledger: Agent = {
    id: PAY_AGENT_IDS.noLimit,
    name: 'Ledger Scout',
    description: 'Synthetic fixture',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: '2026-10-10T12:00:00.000Z',
    revokedAt: null,
  };
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...baseline, agents: [ledger] } }),
  );
  await openDrawer(page);
  await useButton(page).click();
  await drawer(page).getByRole('button', { name: 'Fill with example' }).click();
  await drawer(page).getByRole('link', { name: 'Set a spending limit' }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Ledger Scout details' })).toBeVisible();
  await expect(page).not.toHaveURL(/\/feed/);
  // Back: the sheet again, as it was left.
  await page.goBack();
  await expect(sheetHeading(page)).toBeVisible();
  await expect(drawer(page).getByRole('textbox', { name: /domain/ })).toHaveValue('stripe.com');
});

test('POST services: typed body inputs, and inputs the listing doesn’t name as JSON', async ({
  page,
}) => {
  const pay = await setup(page, { agents: [payAgent()] });
  await openDrawer(page, EXA, 'api.exa.ai');
  await useButton(page).click();
  const sheet = drawer(page);
  await sheet.getByRole('textbox', { name: /^query/ }).fill('pdf invoices');
  await sheet.getByRole('textbox', { name: /^numResults/ }).fill('three');
  await sheet.getByRole('button', { name: 'Check price' }).click();
  await expect(sheet.locator('.fd-errsum')).toContainText('numResults must be a number.');
  await sheet.getByRole('textbox', { name: /^numResults/ }).fill('3');
  await sheet.getByRole('textbox', { name: /^contents/ }).fill('{"text": true}');
  await sheet.getByRole('button', { name: 'Check price' }).click();
  await expect(payButton(page)).toHaveText('Pay 0.007 USDC');
  expect(pay.quotes[0]!.body).toEqual({
    inputs: { body: { query: 'pdf invoices', numResults: 3, contents: { text: true } } },
  });
});

// -------------------------------------------------------------------------------------------
// Phones, both themes

for (const theme of ['light', 'dark'] as const)
  test(`at 390 and 360 px (${theme}): one column, 44 px targets, no sideways scroll`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, { quoteDelayMs: 300 });
    await openDrawer(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await fits(page)).toBe(true);
    for (const control of [
      useButton(page),
      drawer(page).getByRole('button', { name: 'Copy service address' }),
    ])
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    if (theme === 'dark') await shot(page, 'drawer-button-390-dark');
    await useButton(page).click();
    const sheet = drawer(page);
    for (const control of [
      sheet.getByRole('button', { name: 'Back to the service' }),
      sheet.getByRole('button', { name: 'Fill with example' }),
      sheet.getByRole('textbox', { name: /domain/ }),
      sheet.locator('.fp-agent label').first(),
      sheet.getByRole('link', { name: 'Set a spending limit' }),
      sheet.getByRole('button', { name: 'Check price' }),
    ])
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    expect(await fits(page)).toBe(true);
    expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
    if (theme === 'dark') await shot(page, 'use-sheet-390-dark');
    await sheet.getByRole('button', { name: 'Fill with example' }).click();
    await agentRadio(page, 'hhuo').check();
    await sheet.getByRole('button', { name: 'Check price' }).click();
    await expect(payButton(page)).toBeVisible();
    expect((await payButton(page).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    // The confirm and its button stay in view at the bottom of the sheet.
    const box = await payButton(page).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    expect(await fits(page)).toBe(true);
    expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
    if (theme === 'dark') await shot(page, 'confirm-390-dark');
    await payButton(page).click();
    await expect(stateLine(page)).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`, {
      timeout: 15_000,
    });
    expect(await fits(page)).toBe(true);
    expect((await lowContrast(page, '.fd-drawer')).low).toEqual([]);
    expect(
      (await drawer(page).getByRole('button', { name: /^Copy/ }).first().boundingBox())!.height,
    ).toBeGreaterThanOrEqual(43.5);
    if (theme === 'dark') await shot(page, 'result-390-dark');
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await fits(page)).toBe(true);
    await plainText(drawer(page));
  });

// -------------------------------------------------------------------------------------------
// The agent's wallet and the call's page

const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;

/** The vault, the wallet and its reads as the wallet routes answer them (synthetic). */
async function walletOf(page: Page, agent: Agent) {
  const session = (await (await page.request.get('/api/session')).json()) as {
    operator: { id: string };
  };
  const envelope = await sealKey(OWNER_KEY, PASSWORD, { N: 2 ** 17 });
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

test('the wallet: Ready for services, the per-call maximum, the service calls; a result opens', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const services = payServices();
  const whois = services.find((service) => service.id === WHOIS)!;
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
  const history = payHistory(whois);
  const paid = history.calls[1]!;
  // Paid, and the service sent nothing back: listed as a problem, not like a call that worked.
  const noResult = payCall('paid_no_result', { service: whois, amountRaw: '3000' });
  history.calls.push({
    callId: noResult.callId,
    origin: 'feed',
    state: noResult.state,
    moneyMoved: noResult.moneyMoved,
    service: { id: whois.id, title: whois.title, host: WHOIS_HOST },
    payment: noResult.payment,
    protocolFee: noResult.protocolFee,
    resultAvailable: false,
    createdAt: noResult.createdAt - 3_600_000,
    updatedAt: noResult.updatedAt,
  });
  const refused = payCall('refused', { service: whois, failure: 'paused' });
  await signIn(page);
  await mockFeed(page, { services });
  const pay = await mockFeedPay(page, {
    services,
    agents: [payAgent()],
    history: { [agent.id]: history },
    known: [payCall('result_saved', { service: whois, callId: paid.callId }), refused],
  });
  await walletOf(page, agent);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('about:blank');
    await page.goto(`/agents?workspace=v2&theme=${theme}#agent=${agent.id}:wallet`);
    const panel = page.getByRole('complementary', { name: 'hhuo details' });
    const services_ = panel
      .getByRole('group', { name: 'Services: hhuo' })
      .or(panel.locator('[aria-label="Services: hhuo"]'));
    await expect(services_.locator('[data-k="ready-for-services"]')).toContainText(
      'Ready to spend',
    );
    await expect(services_.locator('[data-k="ready-for-services"]')).toContainText('0.98 USDC');
    await expect(services_).toContainText('Unused USDC goes back to the wallet');
    await expect(services_.locator('[data-k="per-call-max"]')).toContainText('Most per call');
    await expect(services_.locator('[data-k="per-call-max"]')).toContainText('0.10 USDC');
    await expect(services_).toContainText('Default 0.10 USDC');
    // What is left of its limit, in the Use sheet's words.
    await expect(services_.locator('[data-k="limit-left"]')).toContainText(
      '3.50 of 5.00 USDC left today',
    );
    const list = panel.locator('[aria-label="Service calls: hhuo"]');
    await expect(list.locator('[data-k="service-call"]')).toHaveCount(5);
    await expect(list.locator('[data-k="float-move"]')).toHaveCount(2);
    // One line each: the service, where it came from with the time, and the amount.
    await expect(list.locator('[data-state="paid_no_result"]')).toContainText(WHOIS_HOST);
    await expect(list.locator('[data-state="paid_no_result"]')).toContainText('No result');
    await expect(list.locator('[data-state="paid_no_result"] .w4-amt')).toHaveText('−0.003');
    await expect(list).toContainText('Paying');
    await expect(list).toContainText('Didn’t go through');
    await expect(list).toContainText('By your AI');
    await expect(list).toContainText('Feed ·');
    await expect(list).toContainText('To Ready to spend');
    await expect(list).toContainText('Back to the wallet');
    // Grouped by day: today's lines first, the move of two days ago under its date.
    await expect(list.locator('.w4-day-k').first()).toHaveText('Today');
    await expect(list.locator('.w4-day-k').last()).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
    // The details open in a sheet; Escape closes it and focus goes back to the line.
    const sheet = page.locator('[data-k="call-sheet"]');
    const lines: [Locator, string][] = [
      [list.locator('[data-state="paid_no_result"]'), `Paid ${WHOIS_HOST} 0.003 USDC, no result`],
      [list.locator('[data-k="service-call"]').nth(0), `Paying ${WHOIS_HOST}`],
      [list.locator('[data-k="service-call"]').nth(1), `Paid ${WHOIS_HOST} 0.001 USDC`],
      [list.locator('[data-k="service-call"]').nth(2), `Paid ${WHOIS_HOST} 0.002 USDC`],
      [list.locator('[data-k="service-call"]').nth(3), `Call to ${WHOIS_HOST} didn’t go through`],
      [list.locator('[data-k="float-move"]').nth(0), 'Moved 1.00 USDC to Ready for services'],
      [list.locator('[data-k="float-move"]').nth(1), 'Moved 0.98 USDC back to the wallet'],
    ];
    for (const [row, text] of lines) {
      await row.click();
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();
      await expect(sheet.locator('.w4-sheet-line')).toHaveText(text);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(row).toBeFocused();
    }
    await list.locator('[data-k="service-call"]').nth(2).click();
    await expect(page.getByRole('dialog', { name: WHOIS_HOST })).toBeVisible();
    await expect(sheet).toContainText('By your AI');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await list.locator('[data-k="service-call"]').nth(1).click();
    await expect(sheet).toContainText('Feed');
    await expect(sheet.getByRole('link', { name: 'Base transaction' })).toHaveAttribute(
      'href',
      /^https:\/\/basescan\.org\/tx\//,
    );
    await expect(sheet.getByRole('link', { name: 'Open result' })).toBeVisible();
    expect(ARROWS.exec(await sheet.innerText())?.[0] ?? null).toBeNull();
    expect((await lowContrast(page, '[data-k="call-sheet"]')).low).toEqual([]);
    await shot(page, `wallet-call-sheet-1440-${theme}`);
    // The scrim closes it too.
    await page.mouse.click(10, 10);
    await expect(sheet).toHaveCount(0);
    await list.locator('[data-k="float-move"]').first().click();
    await expect(sheet).toContainText('Wallet and Ready to spend');
    await expect(sheet.getByRole('link', { name: 'Base transaction' })).toHaveAttribute(
      'href',
      /^https:\/\/basescan\.org\/tx\//,
    );
    await page.keyboard.press('Escape');
    // The filter: payments only, transfers only, all.
    const filter = panel.getByRole('group', { name: 'Show' });
    await filter.getByRole('button', { name: 'Transfers' }).click();
    await expect(filter.getByRole('button', { name: 'Transfers' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(list.locator('[data-k="service-call"]')).toHaveCount(0);
    await expect(list.locator('[data-k="float-move"]')).toHaveCount(2);
    await filter.getByRole('button', { name: 'Payments' }).click();
    await expect(list.locator('[data-k="service-call"]')).toHaveCount(5);
    await expect(list.locator('[data-k="float-move"]')).toHaveCount(0);
    await filter.getByRole('button', { name: 'All' }).click();
    await expect(list.locator('[data-k="float-move"]')).toHaveCount(2);
    expect(ARROWS.exec(await panel.innerText())?.[0] ?? null).toBeNull();
    expect((await lowContrast(page, '[aria-label="Service calls: hhuo"]')).low).toEqual([]);
    await panel.locator('[data-k="per-call-max"]').scrollIntoViewIfNeeded();
    await shot(page, `wallet-services-1440-${theme}`);
  }
  // Change the per-call maximum.
  const panel = page.getByRole('complementary', { name: 'hhuo details' });
  const changeMax = panel.getByRole('button', { name: 'Change the per-call maximum of hhuo' });
  await changeMax.click();
  const field = panel.getByRole('textbox', { name: /Per-call maximum, in USDC/ });
  await expect(field).toBeFocused();
  // Escape leaves the editor; focus goes back to Change, never to the page.
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(changeMax).toBeFocused();
  await changeMax.click();
  await expect(field).toBeFocused();
  await field.fill('0.05');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText(
    'Saved. hhuo now pays at most 0.05 USDC per call.',
  );
  await expect(panel.locator('[data-k="per-call-max"]')).toContainText('0.05 USDC');
  expect(pay.puts).toEqual([{ agentId: agent.id, body: { perCallMaxRaw: '50000' } }]);
  // A call with its result kept opens its own page in the Feed.
  await panel.locator('[aria-label="Service calls: hhuo"] [data-k="service-call"]').nth(1).click();
  await page.locator('[data-k="call-sheet"]').getByRole('link', { name: 'Open result' }).click();
  await expect(page).toHaveURL(new RegExp(`/feed/calls/${paid.callId}$`));
  const sheet = page.locator('.fd-detail');
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(whois.title);
  await expect(sheet).toContainText('Service call');
  await expect(sheet.locator('.fp-state')).toHaveText(`Paid 0.001 USDC to ${WHOIS_HOST}.`);
  await expect(sheet.locator('.fp-ext')).toHaveText('External');
  await expect(sheet.getByRole('link', { name: 'Open the service in the Feed' })).toHaveAttribute(
    'href',
    `/feed/services/${WHOIS}`,
  );
  await expect(page).toHaveTitle(`Call to ${WHOIS_HOST} · Feed · Central City`);
  await expect(sheet).toContainText(`${WHOIS_HOST} · paid by hhuo · `);
  await plainText(page.locator('main'));
  // A refused call's page: "from" the agent, never "paid by", above "Nothing was paid."
  await page.goto(`/feed/calls/${refused.callId}`);
  await expect(page.locator('.fd-detail .fp-state')).toHaveText(
    'Paying services was paused before this payment was signed. Nothing was paid.',
  );
  await expect(page.locator('.fd-detail')).toContainText(`${WHOIS_HOST} · from hhuo · `);
  await expect(page.locator('.fd-detail')).not.toContainText('paid by');
});

test('the call page of a call that isn’t the person’s says so, and nothing more', async ({
  page,
  browser,
  baseURL,
}) => {
  await setup(page);
  // Loaded directly (the MCP detail_url, a reload, a shared link): the address is a client route.
  await page.goto('/feed/calls/fc_zzzzzzzzzzzzzzzzzzzz');
  await expect(page.locator('main')).toContainText('This call isn’t here');
  await expect(page.locator('main')).toContainText(
    'Only the owner of the agent that paid can see a call.',
  );
  // Signed out, sign-in comes first, and nothing about the call shows.
  const context = await browser.newContext({ baseURL });
  try {
    const signedOut = await context.newPage();
    await mockFeed(signedOut, { services: payServices() });
    await signedOut.goto('/feed/calls/fc_zzzzzzzzzzzzzzzzzzzz');
    await expect(signedOut.getByText('Sign in to see this call.')).toBeVisible();
    await expect(signedOut.locator('body')).not.toContainText('This call isn’t here');
  } finally {
    await context.close();
  }
});

test('service panel design: compact facts, closed details, copy controls and responsive themes', async ({
  page,
}) => {
  await setup(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await openDrawer(page, EXA, 'api.exa.ai');
    const panel = drawer(page);
    const technical = panel.locator('.fd-service-tech');
    await expect(technical).not.toHaveAttribute('open', /.*/);
    await expect(panel.getByRole('heading', { name: 'What it does' })).toBeVisible();
    await expect(panel.locator('.fd-service-stats > div')).toHaveCount(3);
    await expect(panel.locator('.fd-service-chip')).toHaveCount(2);
    await expect(useButton(page)).toBeVisible();
    await expect(panel.locator('.fd-service-foot .primary')).toHaveCount(1);
    expect(await fits(page)).toBe(true);
    const box = await panel.boundingBox();
    expect(box?.width).toBeCloseTo(width === 390 ? 390 : 486, 0);
    await shot(page, `service-f1-${width}-${theme}`);
    const copy = panel.getByRole('button', { name: 'Copy service address', exact: true });
    await copy.click();
    await expect(copy).toHaveAttribute('data-done', 'true');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'https://api.exa.ai/search',
    );
    await technical.locator('summary').first().click();
    await expect(panel.getByRole('heading', { name: 'Source and freshness' })).toBeVisible();
    await technical.locator('summary').first().click();
    await expect(panel.getByRole('heading', { name: 'Source and freshness' })).not.toBeVisible();
    await useButton(page).click();
    await expect(sheetHeading(page)).toBeFocused();
  }
});
