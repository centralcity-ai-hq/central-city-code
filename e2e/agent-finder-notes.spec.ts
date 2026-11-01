import { test, expect } from '@playwright/test';
import { gotoMounted } from './mounted';
import { ON_BASE_TX_SEARCH_UNAVAILABLE_MESSAGE } from '../shared/base/on-base';
import { refusedSearchNote } from '../src/verify/onBaseData';

// The header finder never reports "no agent matches" for a text the registry did not search, or
// for a search over a name index that is still building: it shows the reason instead.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/public/directory*', (route) =>
    route.fulfill({ status: 404, json: { error: 'x' } }),
  );
  await page.route('**/api/public/base/agents*', (route) =>
    route.fulfill({
      json: {
        rows: [],
        totals: null,
        registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        nextBefore: null,
        incomplete: true,
      },
    }),
  );
});

async function find(page: import('@playwright/test').Page, text: string) {
  const box = page.getByLabel('Find an agent by name, skill or Base ID');
  await box.fill(text);
}

test('the finder shows why a search was not run or may be incomplete, never a false "no match"', async ({
  page,
}) => {
  await gotoMounted(page, '/');
  await page.getByRole('button', { name: 'Search Base agents' }).click();
  await find(page, 'ab');
  await expect(page.getByRole('status')).toHaveText(refusedSearchNote('ab'));
  expect(refusedSearchNote('ab')).not.toBe('');
  await expect(page.getByText(/No agent on Base matches/)).toHaveCount(0);
  await find(page, `0x${'ab'.repeat(32)}`);
  await expect(page.getByRole('status')).toHaveText(ON_BASE_TX_SEARCH_UNAVAILABLE_MESSAGE);
  await find(page, 'zzz');
  await expect(page.getByRole('status')).toHaveText(
    'Name index still building; some names may be missing',
  );
  await expect(page.getByText(/No agent on Base matches/)).toHaveCount(0);
});
