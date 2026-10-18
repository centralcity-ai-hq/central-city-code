import { expect, test, type Page } from '@playwright/test';

/*
 * Product › Base Agents with the directory, and the header's finder (Operation Directory D1,
 * docs/design/directory.html). GET /api/public/directory is mocked (its shape is
 * shared/directory.ts), and so are the registry and the stats the page reads beside it.
 */

const now = Date.now();
const cards = [
  {
    baseId: '101382',
    short: 'Lnt82a',
    name: 'Linet',
    description: 'Research and source checks',
    skills: ['research', 'fact checking'],
    score: { average: '4.8', raters: 12 },
    paidTimes: 41,
    invitable: true,
    activeAt: now,
  },
  {
    baseId: '101375',
    short: 'Alu75b',
    name: 'Aluntetel',
    description: '',
    skills: ['translation', 'German'],
    score: null,
    paidTimes: null,
    invitable: false,
    activeAt: null,
  },
];

async function mock(page: Page, agents: unknown[], seen: URL[] = []) {
  await page.route('**/api/public/directory*', (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const rows = (agents as typeof cards).filter(
      (card) =>
        !q ||
        card.name.toLowerCase().includes(q) ||
        card.description.toLowerCase().includes(q) ||
        card.baseId === q,
    );
    return route.fulfill({ json: { agents: rows, next: null } });
  });
  await page.route('**/api/public/base/agents*', (route) =>
    route.fulfill({
      json: {
        rows: [],
        totals: {
          onBase: 1394,
          new24h: 3,
          finalizingNow: 0,
          readAtBlock: 1,
          readAt: now,
          servedAt: now,
        },
        registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        nextBefore: null,
      },
    }),
  );
  await page.route('**/api/public/stats', (route) =>
    route.fulfill({ json: { ai_agents_total: 805272 } }),
  );
}

test('header finder: Ctrl+K, type, arrows, Enter opens the passport', async ({ page }) => {
  await mock(page, cards);
  await page.route(/\/a\/Alu75b$/, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Aluntetel passport</h1>' }),
  );
  await page.goto('/about');
  const find = page.getByRole('button', { name: 'Search Base agents' });
  await expect(find).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Find an agent' });
  // The page may be its prerendered copy for a moment: the shortcut works once the app runs.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass();
  const box = dialog.getByRole('combobox');
  await expect(box).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await box.fill('Alun');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/a\/Alu75b$/);
});

test('header finder: Escape closes it and gives focus back; an empty directory searches all on Base', async ({
  page,
}) => {
  await mock(page, []);
  await page.route('**/api/public/base/agents*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const rows = [
      {
        baseId: '1532',
        name: 'Harbor',
        owner: '0x' + '1'.repeat(40),
        short: 'k3P9xQ',
        status: 'final',
        score: { average: '4.6', raters: 12 },
      },
      { baseId: '1530', name: '', owner: '0x' + '2'.repeat(40), short: 'Zz1111', status: 'final' },
    ].filter((row) => !q || row.name.toLowerCase().includes(q.toLowerCase()) || row.baseId === q);
    return route.fulfill({
      json: {
        rows,
        totals: {
          onBase: 2,
          new24h: 0,
          finalizingNow: 0,
          readAtBlock: 1,
          readAt: now,
          servedAt: now,
        },
        registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        nextBefore: null,
      },
    });
  });
  await page.goto('/about');
  const find = page.getByRole('button', { name: 'Search Base agents' });
  const dialog = page.getByRole('dialog', { name: 'Find an agent' });
  // A press on the prerendered copy does nothing: press again once the app runs.
  await expect(async () => {
    await find.click();
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass();
  // Nobody listed: every agent on Base with a public name, marked as such.
  await expect(dialog.getByText('All agents on Base')).toBeVisible();
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option').first()).toContainText('Harbor');
  await expect(dialog.getByRole('option').first()).toContainText('Base ID 1532');
  await expect(dialog.getByRole('option').first()).toContainText('4.6');
  await dialog.getByRole('combobox').fill('nobody');
  await expect(dialog.getByText('No agent on Base matches “nobody”.')).toBeVisible();
  await expect(dialog.getByRole('link', { name: /All Base Agents/ })).toHaveAttribute(
    'href',
    '/explorer/base',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(find).toBeFocused();
});
