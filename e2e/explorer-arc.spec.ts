import { expect, test, type Page } from '@playwright/test';
import { gotoMounted } from './mounted';

/*
 * The Agent Explorer's On Arc view (/explorer/arc): the Arc routes are mocked in the shapes of
 * src/verify/onBaseData.ts. The chain tabs show On Arc only when /api/public/arc/rated answers 200.
 */
const now = Date.now();
const emptyList = {
  rows: [],
  totals: {
    onBase: 0,
    new24h: 0,
    finalizingNow: 0,
    ratedAgents: 0,
    readAtBlock: null,
    readAt: null,
    servedAt: now,
  },
  registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  nextBefore: null,
};

async function mockCommon(page: Page) {
  await page.route('**/api/public/stats', (route) =>
    route.fulfill({ json: { ai_agents_total: 805272, updated_at: new Date().toISOString() } }),
  );
  await page.route('**/api/public/directory*', (route) =>
    route.fulfill({ status: 404, json: { code: 'not_found' } }),
  );
  await page.route('https://mainnet.base.org/**', (route) => route.abort());
}

test('On Arc: the same view as On Base, in the one Explorer switch', async ({ page }) => {
  await mockCommon(page);
  await page.route('**/api/public/arc/agents*', (route) => route.fulfill({ json: emptyList }));
  await page.route('**/api/public/arc/rated', (route) =>
    route.fulfill({ json: { baseIds: [], asOf: now } }),
  );
  await gotoMounted(page, '/explorer/arc');
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Explorer' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Chains' })).toHaveCount(0);
  const views = page.getByRole('navigation', { name: 'Explorer views' });
  await expect(views.getByRole('link', { name: /All agents/ })).toHaveAttribute(
    'href',
    '/explorer',
  );
  await expect(views.getByRole('link', { name: /On Base/ })).toHaveAttribute(
    'href',
    '/explorer/base',
  );
  await expect(views.getByRole('link', { name: /On Arc/ })).toHaveAttribute('aria-current', 'page');
  await expect(views.getByRole('link', { name: /Service calls/ })).toBeVisible();
  await expect(page.getByPlaceholder('Arc ID, wallet or agent name')).toBeVisible();
  await expect(page.getByText('On Arc now')).toBeVisible();
  await expect(page.getByText('Read from Arc block')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Registered on Arc' })).toBeVisible();
  await expect(page.getByText('No agents on Arc yet')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'See the registry on the Arc explorer' }),
  ).toHaveAttribute(
    'href',
    'https://explorer.arc.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  );
  await expect(page.locator('a[href^="/explorer/proof"]')).toHaveCount(0);
});

test('On Arc: rows open the Arc agent page, with a black icon', async ({ page }) => {
  await mockCommon(page);
  const row = {
    baseId: '7',
    name: 'Vemino',
    owner: '0x1111111111111111111111111111111111111111',
    colour: '#2457f5',
    status: 'final',
    finalizingSince: null,
    score: null,
  };
  await page.route('**/api/public/arc/agents*', (route) =>
    route.fulfill({
      json: { ...emptyList, rows: [row], totals: { ...emptyList.totals, onBase: 1 } },
    }),
  );
  await page.route('**/api/public/arc/rated', (route) =>
    route.fulfill({ json: { baseIds: [], asOf: now } }),
  );
  await gotoMounted(page, '/explorer/arc');
  await expect(page.getByRole('link', { name: 'Open Arc ID 7' })).toHaveAttribute(
    'href',
    '/explorer/arc/agents/7',
  );
  await expect(page.getByRole('button', { name: /Verify/ })).toHaveCount(0);
  await expect(page.locator('.ob-agent .ob-av').first()).toHaveCSS(
    'background-color',
    'rgb(11, 11, 15)',
  );
});

test('On Base shows no Arc tab when the server has Arc off', async ({ page }) => {
  await mockCommon(page);
  let probed = 0;
  await page.route('**/api/public/arc/rated', (route) => {
    probed += 1;
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
  await page.route('**/api/public/base/agents*', (route) =>
    route.fulfill({ json: { ...emptyList, totals: { ...emptyList.totals, readAt: now } } }),
  );
  await gotoMounted(page, '/explorer/base');
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Explorer' })).toBeVisible();
  await expect.poll(() => probed).toBe(1);
  await expect(page.getByRole('navigation', { name: 'Chains' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'On Arc' })).toHaveCount(0);
});
