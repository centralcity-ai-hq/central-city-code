import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { e2eOrigin } from './port';
import { lowContrast } from './contrast';
import { workspaceSwitcher } from './settings-nav';

/*
 * "Connect AI" inside the signed-in workspace (src/ConnectApp.tsx), the approved v4 design: the
 * server address with its Account / No account switch, the AI apps as rows with the chosen app's
 * steps beside them (below on a phone), the apps already connected, at 1440 and 390 px.
 */
const origin = e2eOrigin();
const PRODUCTION = 'https://centralcity.ai';
const headers = { 'X-City-Request': '1' };
/** The rows in order, with the line under each name. */
const APPS = [
  ['ChatGPT', 'Custom app'],
  ['Claude', 'Custom connector'],
  ['Cursor', 'One-click install'],
  ['VS Code', 'One-click install'],
  ['Claude Code', 'Terminal'],
  ['Gemini CLI', 'Extension or terminal'],
  ['Codex', 'App or terminal'],
] as const;
/** Screenshots for review (uncommitted): CONNECT_APP_SHOTS_DIR=shots. */
const shots = process.env.CONNECT_APP_SHOTS_DIR;

async function register(page: Page, at = origin) {
  const response = await page.request.post(`${at}/api/auth/register`, {
    headers,
    data: {
      name: `Connect-app-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

/** Opens Connect AI; on a phone the page itself is the view. */
async function openConnect(page: Page, host = '') {
  await page.goto(`${host}/#connect`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Connect AI', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Add Central City to your AI app once. After that, you only paste room links.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose your AI' })).toBeVisible();
}

/**
 * Serves the local build at a public-looking origin (production links), signed in: the session
 * cookie from the local server is copied to that origin and forwarded with every request.
 */
async function hostedSignedIn(page: Page) {
  await register(page);
  const cookies = await page.context().cookies(origin);
  await page
    .context()
    .addCookies(
      cookies.map(({ name, value }) => ({ name, value, url: 'https://centralcity.test' })),
    );
  await page.route('https://centralcity.test/**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }),
    });
  });
  await openConnect(page, 'https://centralcity.test');
}

const row = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const panel = (page: Page) => page.getByRole('tabpanel');
const address = (page: Page) => page.getByRole('group', { name: 'MCP server address' });
const account = (page: Page) => page.getByRole('radio', { name: 'Account', exact: true });
const noAccount = (page: Page) => page.getByRole('radio', { name: 'No account', exact: true });

async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

/** On a phone every visible control in the view is at least 44 px tall. */
async function phoneTargets(page: Page) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.cx4 button, .cx4 a, .cx4 summary, .cx4-seg label')]
      .filter((element) => element.checkVisibility())
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 44)
      .map(({ element, box }) => `${element.textContent?.trim()} ${box.width}x${box.height}`),
  );
  expect(small).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

for (const [label, viewport] of [
  ['1440', { width: 1440, height: 1000 }],
  ['390', { width: 390, height: 844 }],
] as const) {
  test.describe(`at ${label} px`, () => {
    test.use({ viewport });

    test('each AI row shows its own steps beside the rows (below on a phone); arrows move between rows', async ({
      page,
    }) => {
      await register(page);
      await openConnect(page);
      const mcp = `${origin}/mcp`;
      await expect(address(page)).toHaveText(mcp);
      await expect(account(page)).toBeChecked();
      await expect(page.getByText('Signs in to your account', { exact: true })).toBeVisible();
      // Seven rows in the mockup's order, VS Code chosen; each says how it connects.
      const list = page.getByRole('tablist', { name: 'Choose your AI' });
      await expect(list).toHaveAttribute('aria-orientation', 'vertical');
      await expect(list.getByRole('tab')).toHaveText(APPS.map(([name, kind]) => name + kind));
      await expect(row(page, 'VS Code')).toHaveAttribute('aria-selected', 'true');
      for (const [name, kind] of APPS) {
        await row(page, name).click();
        await expect(row(page, name)).toHaveAttribute('aria-selected', 'true');
        await expect(row(page, name)).toHaveAccessibleDescription(kind);
        await expect(panel(page)).toHaveCount(1);
        await expect(panel(page).getByRole('heading', { name: `Connect ${name}` })).toBeVisible();
        await expect(panel(page).getByText(kind, { exact: true })).toBeVisible();
      }
      // Wide: the steps sit to the right of the rows; on a phone, below them.
      const rows = (await list.boundingBox())!;
      const steps = (await panel(page).boundingBox())!;
      if (label === '1440') {
        expect(steps.x).toBeGreaterThanOrEqual(rows.x + rows.width);
        expect(steps.y).toBeLessThan(rows.y + rows.height);
      } else {
        expect(steps.y).toBeGreaterThanOrEqual(rows.y + rows.height);
      }
      // Every app's last step is the room link (ChatGPT and Claude need the live site here).
      for (const name of ['Cursor', 'VS Code', 'Claude Code', 'Gemini CLI', 'Codex']) {
        await row(page, name).click();
        await expect(panel(page).locator('ol > li').last()).toHaveText(
          `Paste a room link in ${name}. Your AI joins the room.`,
        );
      }
      // VS Code: one-click install, the download, and the settings file by hand.
      await row(page, 'VS Code').click();
      await expect(panel(page).getByRole('link', { name: 'Install in VS Code' })).toHaveAttribute(
        'href',
        `https://vscode.dev/redirect/mcp/install?name=central-city&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: mcp }))}`,
      );
      await expect(panel(page).getByRole('link', { name: 'Get VS Code' })).toHaveAttribute(
        'href',
        'https://code.visualstudio.com/download',
      );
      await panel(page).getByText('Add it by hand').click();
      await expect(panel(page).getByRole('group', { name: 'VS Code settings' })).toContainText(
        '"type": "http"',
      );
      await expect(panel(page).getByText('.vscode/mcp.json')).toBeVisible();
      // ChatGPT and Claude need a public address: a local server points to the live site.
      for (const name of ['ChatGPT', 'Claude']) {
        await row(page, name).click();
        await expect(panel(page)).toContainText(`${name} needs a public address`);
        await expect(
          panel(page).getByRole('link', { name: 'Open live Central City' }),
        ).toHaveAttribute('href', 'https://centralcity.ai/#connect');
      }
      // Cursor: one-click install link with the base64 config (the near-black primary), plus the
      // file by hand.
      await row(page, 'Cursor').click();
      const addToCursor = panel(page).getByRole('link', { name: 'Add to Cursor' });
      const cursor = new URL((await addToCursor.getAttribute('href'))!);
      expect(`${cursor.origin}${cursor.pathname}`).toBe('https://cursor.com/en/install-mcp');
      expect(cursor.searchParams.get('config')).toBe(
        Buffer.from(JSON.stringify({ url: mcp })).toString('base64'),
      );
      expect(await addToCursor.evaluate((link) => getComputedStyle(link).backgroundColor)).toBe(
        'rgb(15, 23, 42)',
      );
      await panel(page).getByText('Add it by hand').click();
      await expect(panel(page).getByText('~/.cursor/mcp.json')).toBeVisible();
      // Claude Code: one command, then /mcp and Authenticate.
      await row(page, 'Claude Code').click();
      await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
        `claude mcp add --transport http central-city ${mcp}`,
      );
      await expect(panel(page).getByText('Authenticate', { exact: true })).toBeVisible();
      // Codex: the app's settings, or two terminal commands.
      await row(page, 'Codex').click();
      await expect(panel(page).getByText('Streamable HTTP', { exact: true })).toBeVisible();
      await expect(panel(page).getByRole('group', { name: 'Codex command' })).toHaveText(
        `codex mcp add central-city --url ${mcp}`,
      );
      await expect(panel(page).getByRole('group', { name: 'Codex sign-in command' })).toHaveText(
        'codex mcp login central-city',
      );
      // Keyboard: arrows move between rows (wrapping) and choose, Home and End jump.
      await row(page, 'Codex').focus();
      await page.keyboard.press('ArrowDown');
      await expect(row(page, 'ChatGPT')).toBeFocused();
      await expect(row(page, 'ChatGPT')).toHaveAttribute('aria-selected', 'true');
      await expect(panel(page).getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible();
      await page.keyboard.press('ArrowUp');
      await expect(row(page, 'Codex')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(row(page, 'ChatGPT')).toBeFocused();
      await page.keyboard.press('End');
      await expect(row(page, 'Codex')).toBeFocused();
      await page.keyboard.press('Home');
      await expect(row(page, 'ChatGPT')).toBeFocused();
      // Only the chosen row is in the tab order.
      await expect(row(page, 'Codex')).toHaveAttribute('tabindex', '-1');
      if (label === '390') await phoneTargets(page);
      await noSidewaysScroll(page);
    });

    test('hosted: the mode switch changes the address, the account row and every app’s steps', async ({
      page,
    }) => {
      await hostedSignedIn(page);
      const accountUrl = `${PRODUCTION}/mcp`;
      const open = `${PRODUCTION}/mcp/open`;
      await expect(address(page)).toHaveText(accountUrl);
      await shot(page, `connect-app-${label}-vscode-light`);
      await row(page, 'ChatGPT').click();
      await expect(panel(page).getByText('Build MCP Apps', { exact: true })).toBeVisible();
      await expect(panel(page).getByText('OAuth', { exact: true })).toBeVisible();
      await expect(panel(page).getByRole('group', { name: 'ChatGPT connection link' })).toHaveText(
        accountUrl,
      );
      await expect(panel(page).getByRole('link', { name: 'Open ChatGPT Plugins' })).toHaveAttribute(
        'href',
        'https://chatgpt.com/plugins',
      );
      await expect(panel(page).locator('ol > li').last()).toHaveText(
        'Paste a room link in ChatGPT. Your AI joins the room.',
      );
      await row(page, 'Claude').click();
      const claude = new URL(
        (await panel(page)
          .getByRole('link', { name: 'Open Claude to connect' })
          .getAttribute('href'))!,
      );
      expect(`${claude.origin}${claude.pathname}`).toBe('https://claude.ai/customize/connectors');
      expect(claude.searchParams.get('modal')).toBe('add-custom-connector');
      expect(claude.searchParams.get('connectorName')).toBe('Central City');
      expect(claude.searchParams.get('connectorUrl')).toBe(accountUrl);
      await expect(panel(page).getByText('Add custom connector', { exact: true })).toBeVisible();
      await shot(page, `connect-app-${label}-claude-light`);

      // No account: the open address, no sign-in steps, its own server name.
      await noAccount(page).check();
      await expect(address(page)).toHaveText(open);
      await expect(page.getByText('Never signs in', { exact: true })).toBeVisible();
      await expect(page.getByText('Signs in to your account', { exact: true })).toHaveCount(0);
      const claudeOpen = new URL(
        (await panel(page)
          .getByRole('link', { name: 'Open Claude to connect' })
          .getAttribute('href'))!,
      );
      expect(claudeOpen.searchParams.get('connectorUrl')).toBe(open);
      await expect(panel(page)).toContainText('No sign-in is needed.');
      await row(page, 'ChatGPT').click();
      await expect(panel(page).getByText('No authentication', { exact: true })).toBeVisible();
      await row(page, 'Claude Code').click();
      await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
        `claude mcp add --transport http central-city-open ${open}`,
      );
      await row(page, 'Codex').click();
      await expect(panel(page).getByRole('group', { name: 'Codex command' })).toHaveText(
        `codex mcp add central-city-open --url ${open}`,
      );
      await expect(panel(page).getByRole('group', { name: 'Codex sign-in command' })).toHaveCount(
        0,
      );
      await row(page, 'VS Code').click();
      const vscode = new URL(
        (await panel(page).getByRole('link', { name: 'Install in VS Code' }).getAttribute('href'))!,
      );
      expect(vscode.searchParams.get('name')).toBe('central-city-open');
      expect(JSON.parse(vscode.searchParams.get('config')!)).toEqual({ type: 'http', url: open });
      await shot(page, `connect-app-${label}-no-account-light`);
      // And back: the account address again.
      await account(page).check();
      await expect(address(page)).toHaveText(accountUrl);
      await expect(page.getByText('Signs in to your account', { exact: true })).toBeVisible();
      if (label === '390') await phoneTargets(page);
      await noSidewaysScroll(page);
      // The event stream stays open through the route; drop it with the test.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    test('copy buttons say Copied, and a blocked clipboard is an alert', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await register(page);
      await openConnect(page);
      await page.getByRole('button', { name: 'Copy MCP server address' }).click();
      await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/mcp`);
      await row(page, 'Claude Code').click();
      await panel(page).getByRole('button', { name: 'Copy Claude Code command' }).click();
      await expect(panel(page).getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `claude mcp add --transport http central-city ${origin}/mcp`,
      );
      // A clipboard the browser refuses: say so, as an alert, and keep "Copy".
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(new Error('blocked'));
      });
      await row(page, 'Codex').click();
      await panel(page).getByRole('button', { name: 'Copy Codex command' }).click();
      await expect(panel(page).getByRole('alert')).toHaveText(
        'Clipboard unavailable. Select the text and copy it.',
      );
      await expect(panel(page).getByRole('button', { name: 'Copy Codex command' })).toBeVisible();
    });
  });
}

test('Connected lists the AI apps that signed in, with Manage; none until one has', async ({
  page,
}) => {
  await register(page);
  await openConnect(page);
  // No app has signed in yet: no Connected group, but the way to Connected apps is still there.
  await expect(page.getByRole('heading', { name: 'Choose your AI' })).toBeVisible();
  await expect(
    page.getByText('Apps you connect are listed here once they finish signing in.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage connected apps', exact: true }).click();
  await expect(
    page.locator('.assistant-preview').getByRole('heading', { name: 'Connected apps' }),
  ).toBeVisible();
  await expect(page.locator('.assistant-preview')).toContainText('No apps connected yet.');
  await openConnect(page);
  // Two apps get access (the same grants an OAuth sign-in creates); one is removed again.
  for (const label of ['Codex', 'Claude', 'Old desktop app']) {
    const created = await page.request.post('/api/assistant-access', {
      headers,
      data: { label, scopes: ['workspace:read'], expiresInDays: 7 },
    });
    expect(created.status()).toBe(201);
    if (label === 'Old desktop app') {
      const { grant } = (await created.json()) as { grant: { id: string } };
      const removed = await page.request.delete(`/api/assistant-access/${grant.id}`, {
        headers,
        data: {},
      });
      expect(removed.ok()).toBe(true);
    }
  }
  // The list loads with the view (the same address, so reload rather than navigate).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Choose your AI' })).toBeVisible();
  const connected = page.getByRole('region', { name: 'Connected', exact: true });
  await expect(connected.getByRole('listitem')).toHaveCount(2);
  await expect(connected.getByRole('listitem')).toHaveText([
    /^Claude\s*Connected today\s*Manage$/,
    /^Codex\s*Connected today\s*Manage$/,
  ]);
  await expect(connected).not.toContainText('Old desktop app');
  // With apps listed, each row is the way there; the empty-state line is gone.
  await expect(page.getByRole('button', { name: 'Manage connected apps' })).toHaveCount(0);
  // Each row has the green dot and opens where access is managed today.
  const dot = connected.locator('.cx4-dot').first();
  expect(await dot.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(22, 163, 74)',
  );
  await connected
    .getByRole('button', {
      name: 'Manage Claude, connected today, in Settings → Connected apps',
    })
    .click();
  await expect(
    page.locator('.assistant-preview').getByRole('heading', { name: 'Connected apps' }),
  ).toBeVisible();
  // After connecting: the room invite, the claim box and the docs stay one tap away.
  await openConnect(page);
  const more = page.getByRole('region', { name: 'After connecting' });
  await expect(more.getByRole('link', { name: /^Invite your AI/ })).toHaveAttribute(
    'href',
    /invite/,
  );
  await expect(more.getByRole('link', { name: /^API and SDK docs/ })).toHaveAttribute(
    'href',
    '/docs/api',
  );
  // Which apps work with room links, and the ChatGPT admin note, as before.
  await expect(more).toContainText(
    'Works with ChatGPT, Claude, Cursor, VS Code, Codex and other AI apps that support connectors.',
  );
  await expect(more).toContainText(
    'ChatGPT Business, Team or Enterprise: your workspace admin must allow custom apps first.',
  );
  await more.getByRole('button', { name: /^Claim agents/ }).click();
  await expect(page.getByLabel('Claim agents your AI created')).toBeVisible();
});

test('Connected follows the workspace: switching shows the other workspace’s apps', async ({
  page,
}) => {
  await register(page);
  const own = await page.request.post('/api/assistant-access', {
    headers,
    data: { label: 'Personal app', scopes: ['workspace:read'], expiresInDays: 7 },
  });
  expect(own.status()).toBe(201);
  // An AI workspace the person claims and so co-owns, with its own connected app.
  const created = await page.request.post('/api/public/workspaces', {
    headers: { 'content-type': 'application/json' },
    data: { name: 'Switch Lab', idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const lab = (await created.json()) as { workspace_id: string; claim_token: string };
  const claimed = await page.request.post('/api/workspaces/claim', {
    headers,
    data: { claim_token: lab.claim_token },
  });
  expect(claimed.ok()).toBe(true);
  const labGrant = await page.request.post('/api/assistant-access', {
    headers: { ...headers, 'x-city-workspace': lab.workspace_id },
    data: { label: 'Lab app', scopes: ['workspace:read'], expiresInDays: 7 },
  });
  expect(labGrant.status()).toBe(201);
  await openConnect(page);
  const connected = page.getByRole('region', { name: 'Connected', exact: true });
  await expect(connected.getByRole('listitem')).toHaveText([/^Personal app/]);
  await (await workspaceSwitcher(page)).selectOption({ label: 'Switch Lab (AI workspace)' });
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Connect AI', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Connect AI', exact: true }),
  ).toBeVisible();
  await expect(connected.getByRole('listitem')).toHaveText([/^Lab app/]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`phone layouts at 360 and 390 px in ${scheme}: no sideways scroll, readable, 44 px targets`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await register(page);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await openConnect(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      await phoneTargets(page);
      await noSidewaysScroll(page);
      await noAccount(page).check();
      await noSidewaysScroll(page);
      await row(page, 'VS Code').click();
      await panel(page).getByText('Add it by hand').click();
      await noSidewaysScroll(page);
      await shot(page, `connect-app-${width}-${scheme}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openConnect(page);
    await shot(page, `connect-app-1440-${scheme}`);
  });

  test(`every row and panel meets text contrast in ${scheme}`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await register(page);
    await page.request.post('/api/assistant-access', {
      headers,
      data: { label: 'Claude', scopes: ['workspace:read'], expiresInDays: 7 },
    });
    await openConnect(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const [name] of APPS) {
      await row(page, name).click();
      await page.getByRole('heading', { level: 1 }).hover();
      // Polled: the rows fade their hover background out.
      await expect
        .poll(async () => (await lowContrast(page, '.cx4')).low, { message: name })
        .toEqual([]);
      expect((await lowContrast(page, '.cx4')).count, name).toBeGreaterThan(20);
    }
    await noAccount(page).check();
    await page.getByRole('heading', { level: 1 }).hover();
    await expect.poll(async () => (await lowContrast(page, '.cx4')).low).toEqual([]);
  });

  test(`app icons in ${scheme}: white glyphs and marks on the app colour, named logos`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await register(page);
    await openConnect(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    // Real marks (Simple Icons, CC0) where a permissive one exists; a letter or symbol otherwise.
    for (const name of ['Claude', 'Cursor', 'Claude Code'])
      await expect(row(page, name).getByRole('img', { name: `${name} logo` })).toBeVisible();
    for (const name of ['ChatGPT', 'VS Code', 'Gemini CLI', 'Codex'])
      await expect(row(page, name).getByRole('img')).toHaveCount(0);
    const icons = await page.locator('.cx4-row .cx-app-icon').evaluateAll((tiles) =>
      tiles.map((tile) => {
        const svg = tile.querySelector('svg');
        return {
          glyph: getComputedStyle(tile, '::before').color,
          mark: svg ? getComputedStyle(svg).fill : 'rgb(255, 255, 255)',
          background: getComputedStyle(tile).backgroundColor,
          width: Math.round(tile.getBoundingClientRect().width),
        };
      }),
    );
    expect(icons).toHaveLength(7);
    for (const icon of icons) {
      expect(icon.glyph).toBe('rgb(255, 255, 255)');
      expect(icon.mark).toBe('rgb(255, 255, 255)');
      expect(icon.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(icon.width).toBe(30);
    }
  });
}
