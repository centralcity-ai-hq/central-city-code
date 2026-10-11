import { test, expect, type Page } from '@playwright/test';
import { encodeAbiParameters, encodeFunctionResult, getAddress, parseAbi } from 'viem';
import { e2eOrigin } from './port';
import { ON_BASE_ROUTES, type Passport, type VerifyResult } from '../src/verify/onBaseData';

/*
 * /a/<Base ID>, a Base agent's passport (docs/design/on-base-mockup.html, "Passport"). The
 * passport comes from the public read route, served here by page.route; the page itself is the
 * app shell, as the server sends it to browsers. Verify's Base reads live in their own chunk
 * (src/verify/onBaseVerify.ts), replaced here when a test needs Base to answer.
 */
const origin = e2eOrigin();
const OWNER = '0xD5224E3CD710AC7c069e66A2dFf29C387D162F03';
const AGENT_WALLET = '0x69eA9b7512C8EF4F3A3eEe5Ec6bD6D812071BC78';
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const TX = '0x78d0e389a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607183e6e2c22';

/** Pinako, final, two reputation entries (the mockup's example). */
function pinako(overrides: Partial<Passport> = {}): Passport {
  return {
    baseId: '99268',
    name: 'Pinako',
    colour: '#0f766e',
    owner: OWNER,
    short: 'R6IsTd',
    mintTx: '0xde16037751e4f71bce4c6bd261b41a81ce4258543fbd8e109d38d60518cbc1a8',
    status: 'final',
    registry: REGISTRY,
    mintAccount: '0x8c7af5c672fc8bc8658450161278126a5d2816ad',
    agentWallet: AGENT_WALLET,
    registrationTx: TX,
    // 10 Oct 2026, 15:43 in Berlin (CEST).
    registeredAt: Date.parse('2026-10-10T13:43:00Z'),
    final: { block: 52_425_972, at: Date.parse('2026-10-10T14:05:00Z') },
    reputation: {
      readAtBlock: 52_431_007,
      readAt: Date.parse('2026-10-10T14:20:00Z'),
      count: 3,
      entries: [
        {
          client: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
          index: 2,
          from: { name: 'Meridian', baseId: '98840' },
          score: '1',
          tags: ['research', 'on time'],
        },
        {
          client: '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
          index: 1,
          from: null,
          score: '-0.5',
          tags: [],
        },
        {
          client: '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
          index: 1,
          from: { name: 'Compass', baseId: '98121' },
          score: '87.25',
          tags: ['answered with sources'],
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Serves /a/<short> like the server does (the app shell to a browser navigation), and the public
 * list's search, which finds the row with that short id (none for an unknown one).
 */
async function servePassportPage(page: Page, shorts: Record<string, string> = { R6IsTd: '99268' }) {
  await page.route(
    (url) => url.pathname === ON_BASE_ROUTES.list,
    (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? '';
      const baseId = shorts[q];
      const now = Date.now();
      return route.fulfill({
        json: {
          rows: baseId
            ? // A near match comes first: only the exact short id counts.
              [
                { ...pinako(), baseId: '1', short: `${q}x` },
                { ...pinako(), baseId, short: q },
              ]
            : [],
          totals: {
            onBase: 1284,
            new24h: 37,
            finalizingNow: 0,
            readAtBlock: 52_431_207,
            readAt: now,
            servedAt: now,
          },
          registry: REGISTRY,
          nextBefore: null,
        },
      });
    },
  );
  await page.route(/\/a\/[0-9A-Za-z]+$/, async (route) => {
    const short = new URL(route.request().url()).pathname.split('/').pop()!;
    if (route.request().resourceType() === 'document') {
      const response = await route.fetch({
        url: new URL('/app.html', route.request().url()).toString(),
      });
      return route.fulfill({ response });
    }
    const baseId = shorts[short];
    return baseId
      ? route.fulfill({
          json: {
            type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
            name: 'Pinako',
            registrations: [{ agentId: Number(baseId), agentRegistry: `eip155:8453:${REGISTRY}` }],
          },
        })
      : route.fulfill({ status: 404, json: { error: 'Not found.' } });
  });
}

/** The passport route (by Base ID) answers `answer` (or a status), and counts its calls. */
async function mockPassport(page: Page, baseId: string, answer: Passport | number) {
  const calls = { count: 0 };
  await page.route(
    (url) => url.pathname === ON_BASE_ROUTES.passport(baseId),
    (route) => {
      calls.count++;
      return typeof answer === 'number'
        ? route.fulfill({
            status: answer,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Not found.' }),
          })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(answer),
          });
    },
  );
  return calls;
}

/** Opens /a/<short> for the agent with `baseId` (the passport route answers `answer`). */
async function openPassport(
  page: Page,
  baseId: string,
  answer: Passport | number,
  short = 'R6IsTd',
) {
  await servePassportPage(page, { [short]: baseId });
  const calls = await mockPassport(page, baseId, answer);
  await page.goto(`/a/${short}`);
  return calls;
}

const main = (page: Page) => page.locator('main#main-content');
const fact = (page: Page, label: string) =>
  main(page)
    .locator('.ob-pp-fact')
    .filter({ has: page.locator('dt', { hasText: label }) });

test('a final passport shows its name, status and every fact', async ({ page }) => {
  await openPassport(page, '99268', pinako());

  await expect(main(page).getByRole('link', { name: 'Agent Explorer · On Base' })).toHaveAttribute(
    'href',
    '/explorer/base',
  );
  await expect(main(page).getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
  await expect(main(page).locator('.ob-pp-head')).toContainText('Base agent · ID 99268');
  await expect(main(page).locator('.ob-pp-chip')).toHaveText('Final');
  await expect(page).toHaveTitle('Pinako, Base agent 99268 · Central City');

  await expect(fact(page, 'Base ID').locator('dd')).toHaveText('99268');
  await expect(fact(page, 'Owner wallet').locator('dd')).toContainText(OWNER);
  await expect(fact(page, 'Owner wallet').getByRole('button')).toHaveAccessibleName(
    'Copy owner wallet',
  );
  await expect(fact(page, 'Agent wallet').locator('dd')).toContainText(AGENT_WALLET);
  const registration = fact(page, 'Registration');
  await expect(registration.locator('dd')).toContainText('0x78d0e389…3e6e2c22');
  await expect(registration.locator('dd')).toContainText('· 10 Oct 2026, 15:43 Berlin');
  await expect(registration.getByRole('link', { name: '0x78d0e389…3e6e2c22' })).toHaveAttribute(
    'href',
    `https://basescan.org/tx/${TX}`,
  );
  await expect(registration.getByRole('link', { name: 'View on Basescan' })).toHaveAttribute(
    'href',
    `https://basescan.org/tx/${TX}`,
  );
  await expect(fact(page, 'Finality').locator('dd')).toHaveText('Final at Base block 52,425,972');

  const verify = main(page).getByRole('region', { name: 'Verify', exact: true });
  await expect(verify).toContainText('In your browser, against Base');
  await expect(verify.getByRole('button', { name: 'Verify', exact: true })).toBeVisible();

  const reputation = main(page).getByRole('region', { name: 'Reputation' });
  await expect(reputation).toContainText('3 entries on Base');
  const entries = reputation.getByRole('listitem');
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).toContainText('From Meridian · ID 98840');
  await expect(entries.first()).toContainText('+1');
  await expect(entries.first()).toContainText('research · on time · Feedback #2');
  // Anyone else: a short address to Basescan and its score, never a name or its tags.
  const outsider = entries.nth(1);
  await expect(outsider.getByRole('link', { name: '0xAb84…5cb2' })).toHaveAttribute(
    'href',
    'https://basescan.org/address/0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
  );
  await expect(outsider).toContainText('-0.5');
  await expect(outsider.locator('p')).toHaveText('Feedback #1');
  await expect(entries.nth(2)).toContainText('From Compass · ID 98121');
  await expect(entries.nth(2)).toContainText('+87.25');
  await expect(reputation).toContainText(
    'Read from Base at block 52,431,007. Anyone can give an agent feedback on Base; only Central City agents are named.',
  );

  const later = main(page).locator('.ob-pp-later');
  await expect(later).toContainText("Payments · this agent's payments on Base appear here later.");
  await expect(later).toContainText('Coming later');
});

test('without a recorded mint transaction the passport says so, with no Basescan link', async ({
  page,
}) => {
  await openPassport(page, '99268', pinako({ mintTx: undefined, registrationTx: undefined }));
  const registration = fact(page, 'Registration');
  await expect(registration).toContainText('transaction not on record');
  await expect(registration.locator('a')).toHaveCount(0);
});

test('a final passport from before blocks were kept says Final, no block number', async ({
  page,
}) => {
  await openPassport(page, '99268', pinako({ final: { block: null, at: Date.now() } }));
  await expect(fact(page, 'Finality').locator('dd')).toHaveText('Final');
  await expect(main(page)).not.toContainText('Final at Base block');
});

test('a finalizing passport says so honestly, with the minutes so far', async ({ page }) => {
  await openPassport(
    page,
    '99412',
    pinako({
      baseId: '99412',
      name: 'Harbor',
      status: 'finalizing',
      finalizingSince: Date.now() - 6 * 60_000 - 5_000,
      final: null,
    }),
  );
  await expect(main(page).locator('.ob-pp-chip')).toHaveText('Finalizing');
  await expect(main(page).locator('.ob-pp-chip .ob-pulse')).toHaveCount(1);
  await expect(main(page).locator('.ob-pp-head')).toContainText('6 min · usually 15–30');
  await expect(fact(page, 'Finality').locator('dd')).toHaveText('Finalizing · usually 15–30 min');
  await expect(main(page)).not.toContainText('Final at Base block');
});

test("Verify says it couldn't reach Base, and marks nothing as passed", async ({ page }) => {
  // Base's endpoint doesn't answer this browser. The page's Content-Security-Policy lets the
  // request go out: had it been refused, it would never reach this route.
  let asked = 0;
  await page.route('https://mainnet.base.org/**', (route) => {
    asked += 1;
    return route.abort();
  });
  await openPassport(page, '99268', pinako());
  const verify = main(page).getByRole('region', { name: 'Verify', exact: true });
  await verify.getByRole('button', { name: 'Verify', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
  await expect(panel.getByRole('alert')).toContainText("Couldn't reach Base from your browser");
  await expect(panel).toContainText('nothing is marked as passed');
  await expect(panel.locator('.ob-tick')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(asked).toBeGreaterThan(0);
});

test('Verify with Base answering shows the four checks and links the Base ID on Basescan', async ({
  page,
}) => {
  const result: VerifyResult = {
    kind: 'checked',
    owner: { state: 'pass', evidence: 'ownerOf(99268) on Base = 0xD522…2F03 at block 52,431,207' },
    uri: {
      state: 'pass',
      evidence: 'tokenURI(99268) on Base = https://centralcity.ai/a/R6IsTd at block 52,431,207',
    },
    registeredBy: {
      state: 'pass',
      evidence:
        'centralcity.ai/a/R6IsTd names Base ID 99268 now; minted to account 0x8c7a…16ad in its own operation, block 52,425,223',
    },
    final: {
      state: 'pass',
      evidence: 'Block 52,425,223 is canonical and at or below finalized block 52,430,267',
    },
    block: 52_431_207,
    rpc: 'https://mainnet.base.org',
  };
  // The Base reads' own chunk, replaced by one whose verify answers `result`.
  await page.route(/\/assets\/onBaseVerify-[\w-]+\.js$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `export async function verify() { return ${JSON.stringify(result)}; }`,
    }),
  );
  await openPassport(page, '99268', pinako());
  await main(page).getByRole('button', { name: 'Verify', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
  await expect(panel).toContainText('All 4 checks pass');
  await expect(panel).toContainText('block 52,431,207');
  await expect(panel.locator('.ob-tick[data-state="pass"]')).toHaveCount(4);
  await expect(panel.getByRole('link', { name: 'Open the passport' })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: /View on Basescan/ })).toHaveAttribute(
    'href',
    `https://basescan.org/nft/${REGISTRY}/99268`,
  );
});

test('no reputation yet, more than shown, and not read', async ({ page }) => {
  const read = { readAtBlock: 52_431_007, readAt: Date.parse('2026-10-10T14:20:00Z') };
  await openPassport(page, '99268', pinako({ reputation: { ...read, count: 0, entries: [] } }));
  const reputation = main(page).getByRole('region', { name: 'Reputation' });
  await expect(reputation).toContainText('No feedback on Base yet.');
  await expect(reputation.getByRole('listitem')).toHaveCount(0);
  await expect(reputation).not.toContainText('entries on Base');
  await expect(reputation).toContainText('Read from Base at block 52,431,007.');

  const one = pinako().reputation.entries[0];
  await openPassport(
    page,
    '99268',
    pinako({ reputation: { ...read, count: 120, entries: [one] } }),
  );
  await expect(reputation).toContainText('120 entries on Base');
  await expect(reputation).toContainText('block 52,431,007 · the last 1 of 120.');

  // Not read is never "no feedback".
  const notRead = { readAtBlock: null, readAt: null, count: 0, entries: [] };
  await openPassport(page, '99268', pinako({ reputation: notRead }));
  await expect(reputation).toContainText(
    "Couldn't read Base's Reputation Registry just now. Try again in a moment.",
  );
  await expect(reputation).not.toContainText('No feedback');
  await expect(reputation).not.toContainText('Read from Base at block');
});

test('an unknown Base ID: not found, with the way back to the explorer', async ({ page }) => {
  await openPassport(page, '12345', 404, 'Zz9Yx8');
  await expect(main(page)).toContainText('No agent at this address');
  await expect(
    main(page).getByRole('link', { name: 'Back to the Agent Explorer' }),
  ).toHaveAttribute('href', '/explorer/base');
  await expect(main(page).locator('.ob-pp-facts')).toHaveCount(0);
});

test('a load error offers Try again, which reads the passport again', async ({ page }) => {
  await servePassportPage(page);
  let fail = true;
  await page.route(
    (url) => url.pathname === ON_BASE_ROUTES.passport('99268'),
    (route) =>
      fail
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(pinako()),
          }),
  );
  await page.goto('/a/R6IsTd');
  const banner = main(page).locator('.ob-banner');
  await expect(banner).toContainText("The passport couldn't be read right now");
  fail = false;
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(main(page).getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
  await expect(main(page).locator('.ob-banner')).toHaveCount(0);
});

test('the passport lives at its short link only; an unknown short id is no agent', async ({
  page,
}) => {
  const calls = await openPassport(page, '99268', pinako());
  await expect(main(page).getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
  await expect(main(page).locator('.ob-pp-head')).toContainText('Base agent · ID 99268');
  expect(calls.count).toBe(1);
  // An unknown short id: the list has no row with it, so no passport is read.
  await page.goto('/a/Q1w2E3');
  await expect(main(page)).toContainText('No agent at this address');
  expect(calls.count).toBe(1);
});

test('copy puts the full wallet on the clipboard and says Copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await openPassport(page, '99268', pinako());
  await fact(page, 'Agent wallet').getByRole('button', { name: 'Copy agent wallet' }).click();
  await expect(fact(page, 'Agent wallet').getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(AGENT_WALLET);
  await expect(fact(page, 'Agent wallet').getByRole('status')).toHaveText('', { timeout: 4_000 });
});

test('on a 390 px phone the facts stack and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPassport(page, '99268', pinako());
  await expect(main(page).getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const owner = fact(page, 'Owner wallet');
  const label = await owner.locator('dt').boundingBox();
  const value = await owner.locator('dd').boundingBox();
  expect(label && value && value.y >= label.y + label.height - 1).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await main(page).getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Verify Base ID 99268' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('a re-read that changes a checked fact starts Verify over; a check on its way is dropped', async ({
  page,
}) => {
  await page.clock.install();
  const finalizing = pinako({
    status: 'finalizing',
    final: null,
    finalizingSince: Date.now() - 5 * 60_000,
  });
  // Verify's Base reads, replaced by one that answers "all pass" only when the test releases it.
  const result: VerifyResult = {
    kind: 'checked',
    owner: { state: 'pass', evidence: 'ownerOf(99268) on Base = 0xD522…2F03 at block 52,431,207' },
    uri: { state: 'pass', evidence: 'tokenURI(99268) on Base = https://centralcity.ai/a/R6IsTd' },
    registeredBy: { state: 'pass', evidence: 'centralcity.ai/a/R6IsTd names Base ID 99268 now' },
    final: { state: 'pass', evidence: 'Block 52,425,223 is canonical' },
    block: 52_431_207,
    rpc: 'https://mainnet.base.org',
  };
  await page.route(/\/assets\/onBaseVerify-[\w-]+\.js$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `export async function verify() {
        await new Promise((resolve) => { window.__releaseVerify = resolve; });
        return ${JSON.stringify(result)};
      }`,
    }),
  );
  // The first read has the old owner; every later read a new one.
  let reads = 0;
  await servePassportPage(page);
  await page.route(
    (url) => url.pathname === ON_BASE_ROUTES.passport('99268'),
    (route) => {
      reads += 1;
      return route.fulfill({
        json: reads === 1 ? finalizing : { ...finalizing, owner: AGENT_WALLET },
      });
    },
  );
  await page.goto('/a/R6IsTd');
  const verify = main(page).getByRole('region', { name: 'Verify', exact: true });
  await verify.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Verify Base ID 99268' })).toContainText(
    'Reading from Base',
  );

  // The passport re-reads (finalizing): the owner changed, so Verify starts over.
  await page.clock.runFor(31_000);
  await expect(fact(page, 'Owner wallet')).toContainText(AGENT_WALLET);
  await expect(page.getByRole('region', { name: 'Verify Base ID 99268' })).toHaveCount(0);
  await expect(verify.getByRole('button', { name: 'Verify', exact: true })).toBeVisible();

  // The old check answers late: nothing of it shows beside the new facts.
  await page.evaluate(() =>
    (window as unknown as { __releaseVerify?: () => void }).__releaseVerify?.(),
  );
  await page.clock.runFor(1_000);
  await expect(page.getByRole('region', { name: 'Verify Base ID 99268' })).toHaveCount(0);
  await expect(main(page)).not.toContainText('All 4 checks pass');
});

/*
 * The Central City score: the latest star rating of each Central City agent with a final Base ID
 * (shared/base/rating-score.ts), shown above the entries and recomputed by Verify from Base.
 */
const MERIDIAN = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const COMPASS = '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db';
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const scored = (score: { average: string; raters: number }, scoredBy = [MERIDIAN, COMPASS]) =>
  pinako({ reputation: { ...pinako().reputation, score, scoredBy } });

test('the Central City score shows above the entries; none counted says so; not read says nothing', async ({
  page,
}) => {
  await openPassport(page, '99268', scored({ average: '4.6', raters: 12 }));
  const reputation = main(page).getByRole('region', { name: 'Reputation' });
  await expect(reputation.locator('.ob-pp-city')).toHaveText('4.6 ★ from 12 Central City agents');
  await expect(reputation).toContainText(
    'The score counts the latest star rating of each Central City agent with a final Base ID, one vote per agent.',
  );
  // Feedback by anyone else stays as it was: an address and its value.
  await expect(reputation.getByRole('listitem').nth(1)).toContainText('-0.5');
  // Verify says it will recompute the score too.
  await expect(main(page).getByRole('region', { name: 'Verify', exact: true })).toContainText(
    'It also recomputes the Central City score from the ratings on Base of the wallets this passport names.',
  );

  await openPassport(page, '99268', scored({ average: '5.0', raters: 1 }, [MERIDIAN]));
  await expect(reputation.locator('.ob-pp-city')).toHaveText('5.0 ★ from 1 Central City agent');

  // Read, and no Central City agent's rating counts.
  await openPassport(
    page,
    '99268',
    pinako({ reputation: { ...pinako().reputation, score: null } }),
  );
  await expect(reputation.locator('.ob-pp-city')).toHaveText('No Central City ratings yet');
  await expect(main(page).getByRole('region', { name: 'Verify', exact: true })).not.toContainText(
    'recomputes the Central City score',
  );

  // Not read: no score line at all (never "no ratings").
  await openPassport(
    page,
    '99268',
    pinako({
      reputation: {
        readAtBlock: null,
        readAt: null,
        count: 0,
        entries: [],
        score: null,
        scoredBy: [],
      },
    }),
  );
  await expect(reputation).toContainText("Couldn't read Base's Reputation Registry just now.");
  await expect(reputation.locator('.ob-pp-city')).toHaveCount(0);
});

/**
 * Base, as JSON-RPC: owner and tokenURI as the passport says, no receipt for the mint (so two
 * checks fail), and the raters' feedback: Meridian 5 then 4 stars, Compass 4, and feedback that
 * does not count (another tag). Returns the calls it answered.
 */
async function routeBase(page: Page) {
  const reputationAbi = parseAbi([
    'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
  ]);
  const calls: Array<{ method: string; params: unknown[] }> = [];
  await page.route('https://mainnet.base.org/**', async (route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST',
        },
      });
    const call = JSON.parse(route.request().postData() ?? '{}') as {
      id: number;
      method: string;
      params: unknown[];
    };
    calls.push(call);
    const reply = (body: object) =>
      route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        json: { jsonrpc: '2.0', id: call.id, ...body },
      });
    switch (call.method) {
      case 'eth_chainId':
        return reply({ result: '0x2105' });
      case 'eth_blockNumber':
        return reply({ result: `0x${(52_431_207).toString(16)}` });
      case 'eth_getTransactionReceipt':
        return reply({ result: null });
      case 'eth_getBlockByNumber':
        return reply({
          result: { number: `0x${(52_430_000).toString(16)}`, hash: `0x${'f1'.repeat(32)}` },
        });
      case 'eth_call': {
        const [tx] = call.params as [{ to: string; data: string }];
        if (getAddress(tx.to) === REPUTATION_REGISTRY)
          return reply({
            result: encodeFunctionResult({
              abi: reputationAbi,
              functionName: 'readAllFeedback',
              result: [
                [MERIDIAN, MERIDIAN, MERIDIAN, COMPASS],
                [1n, 2n, 3n, 1n],
                [100n, 80n, 20n, 80n],
                [0, 0, 0, 0],
                ['starred', 'starred', 'quality', 'starred'],
                ['', '', '', ''],
                [false, false, false, false],
              ],
            }),
          });
        // ownerOf / tokenURI by selector.
        return reply({
          result: tx.data.startsWith('0x6352211e')
            ? encodeAbiParameters([{ type: 'address' }], [OWNER])
            : encodeAbiParameters([{ type: 'string' }], ['https://centralcity.ai/a/R6IsTd']),
        });
      }
      default:
        return reply({ error: { code: -32601, message: 'unexpected' } });
    }
  });
  return calls;
}

test('Verify recomputes the score from Base in this browser: "Score: matches Base"', async ({
  page,
}) => {
  const calls = await routeBase(page);
  await openPassport(page, '99268', scored({ average: '4.0', raters: 2 }));
  await main(page).getByRole('button', { name: 'Verify', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
  await expect(panel).toContainText('3 of 5 checks pass');
  await expect(panel).toContainText(
    'From Central City, only the passport this ID points to and which rater wallets are Central City agents.',
  );
  const score = panel.locator('.ob-tick').nth(4);
  await expect(score).toHaveAttribute('data-state', 'pass');
  await expect(score.locator('b')).toHaveText('Score: matches Base');
  await expect(score).toContainText(
    '4.0 ★ from 2 Central City agents: the latest rating of each wallet the passport names, recomputed on Base at block 52,431,007',
  );
  // Read at the passport's own block, from the public endpoint the page's CSP allows.
  const read = calls.find(
    (call) =>
      call.method === 'eth_call' &&
      getAddress((call.params[0] as { to: string }).to) === REPUTATION_REGISTRY,
  );
  expect(read?.params[1]).toBe(`0x${(52_431_007).toString(16)}`);
});

test("a score Base doesn't give shows the mismatch, never a pass", async ({ page }) => {
  const result: VerifyResult = {
    kind: 'checked',
    owner: { state: 'pass', evidence: 'ownerOf(99268) on Base = 0xD522…2F03 at block 52,431,207' },
    uri: { state: 'pass', evidence: 'tokenURI(99268) on Base = https://centralcity.ai/a/R6IsTd' },
    registeredBy: { state: 'pass', evidence: 'centralcity.ai/a/R6IsTd names Base ID 99268 now' },
    final: { state: 'pass', evidence: 'Block 52,425,223 is canonical' },
    score: {
      state: 'fail',
      evidence:
        '3.5 ★ from 2 Central City agents on Base at block 52,431,007 from the wallets the passport names; the passport says 4.0 ★ from 2 Central City agents',
    },
    block: 52_431_207,
    rpc: 'https://mainnet.base.org',
  };
  // The Base reads' own chunk: it keeps the score claim it was given, and answers `result`.
  await page.route(/\/assets\/onBaseVerify-[\w-]+\.js$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `export async function verify(row, options) {
        window.__claim = options.score;
        return ${JSON.stringify(result)};
      }`,
    }),
  );
  await openPassport(page, '99268', scored({ average: '4.0', raters: 2 }));
  await main(page).getByRole('button', { name: 'Verify', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
  await expect(panel).toContainText('4 of 5 checks pass');
  const score = panel.locator('.ob-tick[data-state="fail"]');
  await expect(score.locator('b')).toHaveText("Score: doesn't match Base");
  await expect(score).toContainText('the passport says 4.0 ★ from 2 Central City agents');
  expect(await page.evaluate(() => (window as unknown as { __claim: unknown }).__claim)).toEqual({
    score: { average: '4.0', raters: 2 },
    scoredBy: [MERIDIAN, COMPASS],
    agentWallet: AGENT_WALLET,
    readAtBlock: 52_431_007,
  });
});

test('a score whose passport names no rater wallets is checked, and fails: "Score: doesn\'t match Base"', async ({
  page,
}) => {
  const calls = await routeBase(page);
  await openPassport(page, '99268', scored({ average: '5.0', raters: 900 }, []));
  await expect(
    main(page).getByRole('region', { name: 'Reputation' }).locator('.ob-pp-city'),
  ).toHaveText('5.0 ★ from 900 Central City agents');
  await main(page).getByRole('button', { name: 'Verify', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
  // Five checks (the score's among them), never "All 4 checks pass".
  await expect(panel).toContainText('2 of 5 checks pass');
  await expect(panel).not.toContainText('All 4 checks pass');
  const score = panel.locator('.ob-tick').nth(4);
  await expect(score).toHaveAttribute('data-state', 'fail');
  await expect(score.locator('b')).toHaveText("Score: doesn't match Base");
  await expect(score).toContainText(
    'The passport names no rater wallets, so nothing on Base backs it; the passport says 5.0 ★ from 900 Central City agents',
  );
  // Nothing to read: Base's Reputation Registry is never asked.
  expect(
    calls.some(
      (call) =>
        call.method === 'eth_call' &&
        getAddress((call.params[0] as { to: string }).to) === REPUTATION_REGISTRY,
    ),
  ).toBe(false);
});

test('Reputation screenshots at 1440 and 390, light and dark', async ({ page }) => {
  const dir = process.env.PASSPORT_SHOTS;
  test.skip(!dir, 'set PASSPORT_SHOTS to save screenshots');
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((value) => localStorage.setItem('cc-theme', value), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await openPassport(page, '99268', pinako());
      const reputation = main(page).getByRole('region', { name: 'Reputation' });
      await expect(reputation.getByRole('listitem')).toHaveCount(3);
      await reputation.scrollIntoViewIfNeeded();
      await reputation.screenshot({ path: `${dir}/reputation-${width}-${theme}.png` });
    }
  }
});
