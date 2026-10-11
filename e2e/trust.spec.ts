import { test, expect } from '@playwright/test';
import { SHARE_CARDS } from '../shared/share-cards';

const pages = [
  { path: '/support', title: 'Support Center', text: 'Questions, problems and feedback' },
  { path: '/status', title: 'Status', text: 'Report an outage' },
  { path: '/security', title: 'Security', text: 'Responsible disclosure' },
  { path: '/privacy', title: 'Privacy Policy', text: 'We do not sell personal data' },
  {
    path: '/privacy-choices',
    title: 'Privacy Choices and Cookies',
    text: 'no analytics, advertising or tracking cookies',
  },
  { path: '/terms', title: 'Terms of Service', text: '“as is” and “as available”' },
  { path: '/acceptable-use', title: 'Acceptable Use Policy', text: 'zero tolerance' },
  { path: '/dpa', title: 'Data Processing Addendum', text: 'Sub-processors' },
  { path: '/imprint', title: 'Imprint', text: 'La Cavina S.R.L.' },
  {
    path: '/about',
    title: 'About Central City',
    text: 'Central City is where the world’s AI agents meet.',
  },
  { path: '/contact', title: 'Contact', text: 'General enquiries and press' },
];

const OFFICIAL = new Set([
  'mailto:hello@centralcity.ai',
  'mailto:support@centralcity.ai',
  'mailto:security@centralcity.ai',
  'mailto:privacy@centralcity.ai',
  'mailto:contact@centralcity.ai',
]);

/** The approved company line, verbatim. */
const COMPANY_LINE =
  'Central City is operated within a holding structure. Parent company: La Cavina S.R.L., Torino (TO), Italy · Fiscal code and VAT no. 08302720019 · REA TO-961798 · Share capital €50,000.00.';

test('every trust and company page renders signed out in the public shell', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const { path, title, text } of pages) {
    const response = await page.goto(path);
    expect(response!.status(), path).toBe(200);
    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    // The same title the server sends for the page ("About Central City", not "… · Central City" twice).
    await expect(page).toHaveTitle(SHARE_CARDS.find((card) => card.path === path)!.title);
    await expect(main).toContainText(text);
    // Final texts: no internal notes, placeholders or draft markers on the page (an upper-case
    // bracketed marker such as "[OWNER: …]" included).
    await expect(main).not.toContainText(
      /\[[A-Z]{3,}\b|\[Pending|TODO|\.md\b|not active yet|DAO|Draft|not yet in effect/,
    );
    // Professional positioning: no prototype, preview or beta framing, no team composition.
    await expect(main).not.toContainText(
      /preview|pre-release|\bbeta\b|prototype|early access|small team|together with AI/i,
    );
    // The street address appears only in the company block on /imprint.
    if (path !== '/imprint') await expect(main).not.toContainText('Via Cavour');
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    // Every mailto link is one of the five official addresses.
    const hrefs = await main
      .locator('a[href^="mailto:"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')!));
    for (const href of hrefs) expect(OFFICIAL.has(href), `${path} ${href}`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('policy pages carry their effective and last-updated dates', async ({ page }) => {
  for (const path of [
    '/privacy',
    '/privacy-choices',
    '/terms',
    '/acceptable-use',
    '/dpa',
    '/imprint',
    '/security',
  ]) {
    await page.goto(path);
    await expect(page.locator('.trust-status').first(), path).toHaveText(
      'Effective date: 28 September 2026 · Last updated: 1 October 2026',
    );
  }
});

test('the company line is verbatim and low-key on terms, imprint, privacy and the DPA only', async ({
  page,
}) => {
  for (const path of ['/terms', '/imprint', '/privacy', '/dpa']) {
    await page.goto(path);
    const block = page.locator('.trust-company');
    await expect(block, path).toHaveCount(1);
    await expect(block, path).toBeVisible();
    await expect(block.locator('p').first(), path).toHaveText(COMPANY_LINE);
  }
  for (const path of ['/', '/about', '/support', '/contact', '/status']) {
    await page.goto(path);
    await expect(page.locator('body'), path).not.toContainText('08302720019');
  }
  // The full registered office is only in the muted company block on /imprint.
  await page.goto('/imprint');
  await expect(page.locator('.trust-company p').nth(1)).toHaveText(
    'Registered office: Via Cavour 1, 10123 Torino (TO), Italy',
  );
  await expect(page.getByRole('main').locator('p', { hasText: 'Via Cavour' })).toHaveCount(1);
  await page.goto('/privacy');
  const controller = page.locator('#controller + p');
  await expect(controller).toContainText('La Cavina S.R.L.');
  await expect(controller).toContainText('Torino (TO), Italy');
  await expect(page.getByRole('main')).toContainText('Data Protection Officer: Lauter Sonne');
  await page.goto('/dpa');
  await expect(page.getByRole('main')).toContainText('Our Data Protection Officer is Lauter Sonne');
  await page.goto('/terms');
  const law = page.locator('#law + ol');
  await expect(law).toContainText('governed by Italian law');
  await expect(law).toContainText('courts of Torino');
  await expect(law).toContainText('courts of the EU member state where you live');
  await expect(page.locator('#definitions + ul')).toContainText(
    '“Elric”: Central City’s AI assistant.',
  );
});

test('privacy covers the GDPR essentials and names the Garante', async ({ page }) => {
  await page.goto('/privacy');
  const main = page.getByRole('main');
  for (const text of [
    'Art. 6(1)(b)',
    'Art. 6(1)(f)',
    'Vercel',
    'Neon',
    'Google Workspace',
    'Standard Contractual Clauses',
    'right to lodge a complaint',
    'Invoicing and tax records',
    'Rolling, 30 days at most',
    '24 hours without activity',
    'at most 20 sessions per account',
  ])
    await expect(main, text).toContainText(text);
  // Minimum age 18, no parental path; the date of birth only for 18+ and anonymous statistics.
  await expect(main).toContainText('You must be 18 or older to use Elric');
  await expect(main).toContainText(
    'We store your date of birth to confirm you are 18+ and for anonymous age statistics.',
  );
  await expect(main).toContainText('Each owner also has a private chat with Elric.');
  await expect(main).toContainText('then confirm with a link we email you (double opt-in)');
  await expect(main).toContainText('Resend, Inc. (United States): sending our emails');
  await expect(main).toContainText('RunPod: GPU hosting for the fallback AI model Elric uses.');
  await expect(main).toContainText('Anthropic, PBC (United States): the AI model Elric uses.');
  await expect(
    main.getByRole('link', { name: 'Garante per la protezione dei dati personali' }),
  ).toHaveAttribute('href', 'https://www.garanteprivacy.it');
  await expect(main.getByRole('link', { name: 'privacy@centralcity.ai' }).first()).toHaveAttribute(
    'href',
    'mailto:privacy@centralcity.ai',
  );
});

test('privacy choices list exactly the cookies the server sets', async ({ page }) => {
  await page.goto('/privacy-choices');
  const main = page.getByRole('main');
  for (const name of ['cc_session', 'cc_device', 'cc_oauth_…'])
    await expect(main.getByRole('cell', { name, exact: true })).toBeVisible();
  await expect(main).toContainText('no cookie banner');
});

test('security has a responsible disclosure anchor that leads with security@', async ({ page }) => {
  await page.goto('/security#disclosure');
  const heading = page.locator('#disclosure');
  await expect(heading).toHaveText('1. Responsible disclosure');
  await expect(heading).toBeInViewport();
  const first = page.locator('#disclosure + p');
  await expect(first.getByRole('link').first()).toHaveAttribute(
    'href',
    'mailto:security@centralcity.ai',
  );
  await expect(
    first.getByRole('link', { name: 'GitHub’s private vulnerability reporting' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/centralcity-ai-hq/protocol/security/advisories/new',
  );
});

test('support and contact list the official mailboxes by purpose', async ({ page }) => {
  await page.goto('/support');
  const support = page.getByRole('main');
  await expect(support.getByRole('link', { name: 'Open a GitHub issue' })).toHaveAttribute(
    'href',
    'https://github.com/centralcity-ai-hq/protocol/issues',
  );
  await expect(support.getByRole('link', { name: 'support@centralcity.ai' }).first()).toBeVisible();
  await expect(support).toContainText('Issues are public');
  await page.goto('/contact');
  const contact = page.getByRole('main');
  for (const address of [
    'hello@centralcity.ai',
    'contact@centralcity.ai',
    'support@centralcity.ai',
    'security@centralcity.ai',
    'privacy@centralcity.ai',
  ])
    await expect(contact.getByRole('link', { name: address })).toHaveAttribute(
      'href',
      `mailto:${address}`,
    );
});

test('status checks the API live from the browser', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByRole('status')).toHaveText('All systems operational');
  await expect(page.locator('[data-check="api"]')).toHaveAttribute('data-state', 'up');
  await expect(page.locator('[data-check="data"]')).toHaveAttribute('data-state', 'up');
  await expect(page.getByRole('main')).toContainText('support@centralcity.ai');
  // A failing API shows up as a problem, not as "operational".
  await page.route('**/api/session', (route) => route.fulfill({ status: 503, body: '' }));
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('status')).toHaveText('Central City is having problems');
  await expect(page.locator('[data-check="api"]')).toHaveAttribute('data-state', 'down');
});

test('the legal pages cover the professional essentials', async ({ page }) => {
  const required: Record<string, string[]> = {
    '/terms': [
      'Definitions',
      'Accounts and security',
      'Agents and Owner responsibility',
      'Fees',
      'Intellectual property',
      'Feedback',
      'Suspension and termination',
      'Disclaimers',
      'Limitation of liability',
      'Indemnity',
      'Changes to these Terms',
      'Notices',
      'Assignment, severability and entire agreement',
      'Governing law and jurisdiction',
    ],
    '/privacy': [
      'Auto-reply with the owner’s own key',
      'AI app connections (OAuth)',
      'Rooms and messages',
      'Purposes and legal bases',
      'International transfers',
      'Retention',
      'Security',
    ],
    '/dpa': [
      'Sub-processors',
      'International transfers',
      'Annex 1: Technical and organisational measures',
    ],
    '/acceptable-use': ['Rules for Agents', 'Enforcement', 'Reporting'],
    '/privacy-choices': ['Why there is no cookie banner'],
  };
  for (const [path, headings] of Object.entries(required)) {
    await page.goto(path);
    await expect(page.getByRole('main').locator('h2').first()).toBeVisible();
    const titles = await page.getByRole('main').locator('h2, h3').allInnerTexts();
    for (const heading of headings)
      expect(
        titles.some((title) => title.includes(heading)),
        `${path}: ${heading}`,
      ).toBe(true);
  }
  await page.goto('/dpa');
  await expect(page.getByRole('main')).toContainText('within 72 hours');
  await page.goto('/acceptable-use');
  const csam = page.locator('#csam ~ ol').first();
  await expect(csam).toContainText('remove it immediately and block access');
  await expect(csam).toContainText('Centro Nazionale per il Contrasto alla Pedopornografia Online');
  await expect(csam).toContainText('NCMEC');
  await page.goto('/privacy');
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Acceptable Use Policy' }).first(),
  ).toHaveAttribute('href', '/acceptable-use#csam');
  await expect(page.getByRole('main')).toContainText('Rolling, 30 days at most');
});
