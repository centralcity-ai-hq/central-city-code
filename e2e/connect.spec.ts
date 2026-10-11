import { test, expect, type Page } from '@playwright/test';
import { lowContrast } from './contrast';
import { e2eOrigin } from './port';

/*
 * The Connect page (src/Connect.tsx), the approved v4 design: a hero with the three steps and the
 * address card (one address, a mode switch), then one tile per app (a tab list), the chosen app's
 * steps with a side note, and the trust line, at /connect and /#connect.
 */
const origin = e2eOrigin();
const mcpUrl = `${origin}/mcp`;
const openUrl = `${origin}/mcp/open`;
/** Off a local server every connection points at production (never a short-lived preview). */
const PRODUCTION = 'https://centralcity.ai';
const APPS = ['ChatGPT', 'Claude', 'Cursor', 'VS Code', 'Claude Code', 'Gemini CLI', 'Codex'];
/** The line under each tile's name. */
const KINDS = [
  'Custom app',
  'Connector',
  'One click',
  'One click',
  'Terminal',
  'Terminal',
  'App or terminal',
];
const ARROWS = /[←-⇿⟰-⟿⤀-⥿⬀-⬯]|->|=>|>>/;

/** VS Code: the HTTPS redirect on vscode.dev, config = { type: 'http', url }; a new tab. */
function expectVscodeLink(href: string | null, name: string, url: string) {
  expect(href).toBe(
    `https://vscode.dev/redirect/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify({ type: 'http', url }))}`,
  );
  const link = new URL(href!);
  expect(link.searchParams.get('name')).toBe(name);
  expect(JSON.parse(link.searchParams.get('config')!)).toEqual({ type: 'http', url });
}

/** Cursor: the HTTPS install page on cursor.com, config = base64 of { url }; a new tab. */
function expectCursorLink(href: string | null, name: string, url: string) {
  const link = new URL(href!);
  expect(`${link.origin}${link.pathname}`).toBe('https://cursor.com/en/install-mcp');
  expect(link.searchParams.get('name')).toBe(name);
  expect(link.searchParams.get('config')).toBe(
    Buffer.from(JSON.stringify({ url })).toString('base64'),
  );
  expect(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString())).toEqual({
    url,
  });
}

/** Serves the local build at a public-looking origin without contacting a real provider. */
async function hosted(page: Page, path = '/connect') {
  await page.route('https://centralcity.test/**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }),
    });
  });
  await page.goto(`https://centralcity.test${path}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const panel = (page: Page) => page.getByRole('tabpanel');
const address = (page: Page) => page.getByRole('group', { name: 'MCP server address' });
const openMode = (page: Page) => page.getByRole('radio', { name: 'No account', exact: true });

test('the Connect page has its own title, /#connect becomes /connect, and Back and Forward work', async ({
  page,
}) => {
  await page.goto('/connect');
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  await expect(page).toHaveTitle('Connect your AI · Central City');
  // The old address: the same page, and the address bar settles on /connect.
  await page.goto('/#connect');
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page).toHaveTitle('Connect your AI · Central City');
  // In-page from the landing page: Back returns to it (with its title), Forward to Connect.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
  const landingTitle = await page.title();
  await page.evaluate(() => {
    window.location.hash = '#connect';
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  await expect(page).toHaveURL(/\/connect$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle(landingTitle);
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI' })).toBeVisible();
  await expect(page).toHaveTitle('Connect your AI · Central City');
});

test('/connect and /#connect both open the page; no arrows; no sideways scroll at 390 px', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const path of ['/connect', '/#connect']) {
    await page.goto('about:blank');
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }), path).toHaveText('Connect your AI');
    await expect(page).toHaveTitle(/Central City/);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/connect', 'hosted']) {
    if (path === 'hosted') await hosted(page);
    else await page.goto(path);
    for (const mode of ['Workspace account', 'No account']) {
      await page.getByRole('radio', { name: mode, exact: true }).check();
      for (const name of APPS) {
        await tab(page, name).click();
        await expect(panel(page)).toBeVisible();
        const text = await page.evaluate(() => document.body.innerText);
        expect(text, `${path} ${mode} ${name}`).not.toMatch(ARROWS);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${path} ${mode} ${name}`,
        ).toBe(true);
      }
    }
  }
  // Even the "by hand" settings stay inside the page width.
  await tab(page, 'VS Code').click();
  await panel(page).getByText('Add it by hand').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(ARROWS);
  expect(errors).toEqual([]);
});

test('the mode switch changes the address and every command and install link', async ({ page }) => {
  await page.goto('/connect');
  await expect(page.getByRole('radio', { name: 'Workspace account' })).toBeChecked();
  await expect(address(page)).toHaveText(mcpUrl);
  await tab(page, 'Claude Code').click();
  await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
    `claude mcp add --transport http central-city ${mcpUrl}`,
  );
  await tab(page, 'Cursor').click();
  expectCursorLink(
    await panel(page).getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city',
    mcpUrl,
  );
  await tab(page, 'VS Code').click();
  expectVscodeLink(
    await panel(page).getByRole('link', { name: 'Install in VS Code' }).getAttribute('href'),
    'central-city',
    mcpUrl,
  );
  await tab(page, 'Codex').click();
  await expect(panel(page).getByRole('group', { name: 'Codex connection link' })).toHaveText(
    mcpUrl,
  );
  await expect(panel(page).getByRole('group', { name: 'Codex command' })).toHaveText(
    `codex mcp add central-city --url ${mcpUrl}`,
  );
  await expect(panel(page).getByRole('group', { name: 'Codex sign-in command' })).toHaveText(
    'codex mcp login central-city',
  );

  await openMode(page).check();
  await expect(address(page)).toHaveText(openUrl);
  await expect(page.getByText('No account needed.', { exact: false })).toBeVisible();
  await expect(panel(page).getByRole('group', { name: 'Codex connection link' })).toHaveText(
    openUrl,
  );
  await expect(panel(page).getByRole('group', { name: 'Codex command' })).toHaveText(
    `codex mcp add central-city-open --url ${openUrl}`,
  );
  // No account, nothing to sign in to.
  await expect(panel(page).getByRole('group', { name: 'Codex sign-in command' })).toHaveCount(0);
  await tab(page, 'Claude Code').click();
  await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
    `claude mcp add --transport http central-city-open ${openUrl}`,
  );
  await tab(page, 'Cursor').click();
  expectCursorLink(
    await panel(page).getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city-open',
    openUrl,
  );
  await panel(page).getByText('Add it by hand').click();
  expect(
    JSON.parse((await panel(page).getByRole('group', { name: 'Cursor settings' }).textContent())!),
  ).toEqual({ mcpServers: { 'central-city-open': { url: openUrl } } });
  await tab(page, 'VS Code').click();
  expectVscodeLink(
    await panel(page).getByRole('link', { name: 'Install in VS Code' }).getAttribute('href'),
    'central-city-open',
    openUrl,
  );
  await panel(page).getByText('Add it by hand').click();
  expect(
    JSON.parse((await panel(page).getByRole('group', { name: 'VS Code settings' }).textContent())!),
  ).toEqual({ servers: { 'central-city-open': { type: 'http', url: openUrl } } });
  // Nothing on the page still shows the account address.
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/\/mcp(?!\/open|\.json)/);
});

test('each of the seven tiles shows its steps; the tiles follow the arrow keys', async ({
  page,
}) => {
  await hosted(page);
  const rail = page.getByRole('tablist', { name: 'Which AI do you use?' });
  await expect(rail.getByRole('tab')).toHaveText(APPS.map((name, index) => name + KINDS[index]));
  const expected: Record<string, string> = {
    ChatGPT: 'Build MCP Apps',
    Claude: 'Add custom connector',
    'Claude Code': 'Install Central City in Claude Code',
    Cursor: 'Cursor opens with Central City ready to add',
    'VS Code': 'VS Code opens and asks you to install Central City',
    Codex: 'Settings / MCP servers / Add server',
    'Gemini CLI': 'Install the Central City extension',
  };
  for (const name of APPS) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(panel(page)).toHaveAttribute(
      'aria-labelledby',
      (await tab(page, name).getAttribute('id'))!,
    );
    expect(await panel(page).locator('ol > li').count(), name).toBeGreaterThanOrEqual(3);
    await expect(panel(page), name).toContainText(expected[name]!);
    await expect(panel(page).getByRole('heading', { name: `Connect ${name}` })).toBeVisible();
    // The step every app shares: what happens after connecting.
    await expect(panel(page).locator('ol > li').last()).toHaveText(
      `Paste a room link in ${name}. Your AI joins the room.`,
    );
  }
  await tab(page, 'ChatGPT').click();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Claude')).toBeFocused();
  await expect(tab(page, 'Claude')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'ChatGPT')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('End');
  await expect(tab(page, 'Codex')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'ChatGPT')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Codex')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tab(page, 'ChatGPT')).toHaveAttribute('aria-selected', 'true');
  // The mode switch is a real radio group.
  await expect(page.getByRole('radiogroup', { name: 'How your AI connects' })).toBeVisible();
});

test('hosted: production links for ChatGPT, Claude, Cursor and VS Code in both modes', async ({
  page,
}) => {
  await hosted(page);
  const account = `${PRODUCTION}/mcp`;
  const open = `${PRODUCTION}/mcp/open`;
  await expect(address(page)).toHaveText(account);
  // ChatGPT: the Plugins page, the address as an app, OAuth for the account.
  await expect(panel(page).getByRole('link', { name: 'Open ChatGPT Plugins' })).toHaveAttribute(
    'href',
    'https://chatgpt.com/plugins',
  );
  await expect(panel(page).getByRole('group', { name: 'ChatGPT connection link' })).toHaveText(
    account,
  );
  await expect(panel(page).getByText('Build MCP Apps', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('Developer mode', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('OAuth', { exact: true })).toBeVisible();
  await expect(
    panel(page).getByText('Add this address as an app. Pasting it into a chat won’t connect.'),
  ).toBeVisible();
  await openMode(page).check();
  await expect(panel(page).getByRole('group', { name: 'ChatGPT connection link' })).toHaveText(
    open,
  );
  await expect(panel(page).getByText('No authentication', { exact: true })).toBeVisible();
  // Claude: the prefilled "Add custom connector" link, three steps, Claude Desktop.
  await tab(page, 'Claude').click();
  const claudeHref = async () =>
    new URL(
      (await panel(page)
        .getByRole('link', { name: 'Open Claude to connect' })
        .getAttribute('href'))!,
    );
  let claude = await claudeHref();
  expect(claude.origin + claude.pathname).toBe('https://claude.ai/customize/connectors');
  expect(claude.searchParams.get('modal')).toBe('add-custom-connector');
  expect(claude.searchParams.get('connectorName')).toBe('Central City');
  expect(claude.searchParams.get('connectorUrl')).toBe(open);
  await expect(panel(page).locator('ol > li')).toHaveCount(4);
  await expect(panel(page)).toContainText('Claude Desktop');
  await page.getByRole('radio', { name: 'Workspace account' }).check();
  claude = await claudeHref();
  expect(claude.searchParams.get('connectorUrl')).toBe(account);
  await expect(panel(page).getByRole('group', { name: 'Claude connection link' })).toHaveText(
    account,
  );
  // One-click installs: production, signed-in, persistent. HTTPS install pages (a bare cursor:
  // or vscode: link does nothing without the app), opened in a new tab.
  await tab(page, 'Cursor').click();
  const cursor = panel(page).getByRole('link', { name: 'Add to Cursor' });
  expectCursorLink(await cursor.getAttribute('href'), 'central-city', account);
  await expect(cursor).toHaveAttribute(
    'href',
    'https://cursor.com/en/install-mcp?name=central-city&config=eyJ1cmwiOiJodHRwczovL2NlbnRyYWxjaXR5LmFpL21jcCJ9',
  );
  await expect(cursor).toHaveAttribute('target', '_blank');
  await expect(cursor).toHaveAttribute('rel', 'noopener noreferrer');
  // Without the app the install link can do nothing, so the official download sits next to it.
  await expect(panel(page).getByRole('link', { name: 'Get Cursor' })).toHaveAttribute(
    'href',
    'https://cursor.com/download',
  );
  await tab(page, 'VS Code').click();
  const vscode = panel(page).getByRole('link', { name: 'Install in VS Code' });
  expectVscodeLink(await vscode.getAttribute('href'), 'central-city', account);
  await expect(vscode).toHaveAttribute(
    'href',
    'https://vscode.dev/redirect/mcp/install?name=central-city&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fcentralcity.ai%2Fmcp%22%7D',
  );
  await expect(vscode).toHaveAttribute('target', '_blank');
  await expect(vscode).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(panel(page).getByRole('link', { name: 'Get VS Code' })).toHaveAttribute(
    'href',
    'https://code.visualstudio.com/download',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const link of await panel(page).getByRole('link').all())
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('hosted: Claude Code and Gemini CLI install the published packages first, by hand second', async ({
  page,
}) => {
  await hosted(page);
  const account = `${PRODUCTION}/mcp`;
  const open = `${PRODUCTION}/mcp/open`;
  await tab(page, 'Claude Code').click();
  await expect(
    panel(page).getByRole('group', { name: 'Claude Code marketplace command' }),
  ).toHaveText('/plugin marketplace add centralcity-ai-hq/toolkit');
  await expect(panel(page).getByRole('group', { name: 'Claude Code install command' })).toHaveText(
    '/plugin install central-city@centralcity-ai',
  );
  await expect(panel(page)).toContainText('Or add the server directly');
  await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
    `claude mcp add --transport http central-city ${account}`,
  );
  await expect(panel(page)).toContainText('Authenticate');
  await tab(page, 'Gemini CLI').click();
  await expect(panel(page).getByRole('group', { name: 'Gemini CLI extension command' })).toHaveText(
    'gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension',
  );
  await expect(panel(page)).toContainText('/mcp auth central-city');
  await expect(panel(page).getByRole('group', { name: 'Gemini CLI command' })).toHaveText(
    `gemini mcp add --transport http central-city ${account}`,
  );
  // No account: the same packages, the open address by hand, nothing to sign in to.
  await openMode(page).check();
  await expect(panel(page).getByRole('group', { name: 'Gemini CLI command' })).toHaveText(
    `gemini mcp add --transport http central-city-open ${open}`,
  );
  await expect(panel(page)).not.toContainText('/mcp auth');
  await tab(page, 'Claude Code').click();
  await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
    `claude mcp add --transport http central-city-open ${open}`,
  );
  await expect(panel(page)).not.toContainText('Authenticate');
  // VS Code: also in its MCP server list; Claude: the directory listing is in review.
  await tab(page, 'VS Code').click();
  await expect(panel(page)).toContainText('ai.centralcity/central-city');
  await tab(page, 'Claude').click();
  await expect(panel(page)).toContainText('connector directory is in review');
});

test('on a local server ChatGPT and Claude point to the live site; coding apps use this one', async ({
  page,
}) => {
  await page.goto('/#connect');
  for (const name of ['ChatGPT', 'Claude']) {
    await tab(page, name).click();
    await expect(panel(page)).toContainText('This page is running on your computer.');
    await expect(panel(page).getByRole('link', { name: 'Open live Central City' })).toHaveAttribute(
      'href',
      'https://centralcity.ai/#connect',
    );
    await expect(panel(page).getByRole('link', { name: /Claude|ChatGPT/ })).toHaveCount(0);
  }
  await tab(page, 'Cursor').click();
  expectCursorLink(
    await panel(page).getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city',
    mcpUrl,
  );
  // The published packages point at production, so a local server adds its own address.
  await tab(page, 'Claude Code').click();
  await expect(panel(page).getByRole('group', { name: /marketplace|install command/ })).toHaveCount(
    0,
  );
  await expect(panel(page).getByRole('group', { name: 'Claude Code command' })).toHaveText(
    `claude mcp add --transport http central-city ${mcpUrl}`,
  );
  await tab(page, 'Gemini CLI').click();
  await expect(
    panel(page).getByRole('group', { name: 'Gemini CLI extension command' }),
  ).toHaveCount(0);
  await expect(panel(page).getByRole('group', { name: 'Gemini CLI command' })).toHaveText(
    `gemini mcp add --transport http central-city ${mcpUrl}`,
  );
});

test('copy buttons put the value on the clipboard and say Copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Copy MCP server address' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mcpUrl);
  await openMode(page).check();
  // A new address starts from "Copy" again.
  await expect(page.getByRole('button', { name: 'Copy MCP server address' })).toBeVisible();
  await tab(page, 'Claude Code').click();
  await panel(page).getByRole('button', { name: 'Copy Claude Code command' }).click();
  await expect(panel(page).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `claude mcp add --transport http central-city-open ${openUrl}`,
  );
  await tab(page, 'VS Code').click();
  await panel(page).getByText('Add it by hand').click();
  await panel(page).getByRole('button', { name: 'Copy VS Code settings' }).click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual({
    servers: { 'central-city-open': { type: 'http', url: openUrl } },
  });
});

test('the next step is a room invite link; docs and claim links stay', async ({ page }) => {
  await page.goto('/connect');
  const next = page.getByRole('region', { name: 'Next step: invite your AI into a room.' });
  await expect(next.getByRole('link', { name: 'Invite your AI' })).toHaveAttribute(
    'href',
    '/invite',
  );
  await expect(next.getByRole('link', { name: 'API and SDK docs' })).toHaveAttribute(
    'href',
    '/docs/api',
  );
  await expect(next).not.toContainText('/mcp');
  await next.getByRole('link', { name: 'Sign in to claim' }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
});

test('the developer REST example (in the docs) still creates a claimable team', async ({
  page,
}) => {
  await page.goto('/docs/api');
  const rest = await page.getByLabel('REST create request').textContent();
  const payload = JSON.parse(/-d '(.*)'/.exec(rest!)![1]!) as { idempotency_key: string };
  expect(payload.idempotency_key).toBe('<a fresh random UUID>');
  payload.idempotency_key = crypto.randomUUID();
  const created = await page.request.post('/api/public/agents', { data: payload });
  expect(created.status()).toBe(201);
  expect((await created.json()).claim.claim_url).toMatch(/#claim=ccclaim_/);
});

test('signed in: /connect opens the console view, which offers the claim box', async ({ page }) => {
  await page.goto('/#create');
  await page.getByLabel('Account name').fill('Browser-Connect');
  await page.getByLabel('Password', { exact: true }).fill('Local-test-only-passphrase-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // A new account lands on the Overview (the Network map in the workspace).
  await expect(page.getByRole('heading', { name: 'Network map', level: 1 })).toBeVisible();
  await page.goto('/connect');
  // The console reads #connect and then removes it from the address.
  await expect(page).toHaveURL(/\/(#connect)?$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('button', { name: 'Connect AI', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Choose your AI' })).toBeVisible();
  await expect(tab(page, 'Codex')).toBeVisible();
  await page.getByRole('button', { name: 'Claim agents' }).click();
  await expect(page.getByLabel('Claim agents your AI created')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`every tile meets text contrast in ${scheme}`, async ({ page }) => {
    // The site is light unless dark is chosen: store the choice so dark is really checked.
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await hosted(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const name of APPS) {
      await tab(page, name).click();
      await page.getByRole('heading', { level: 1 }).hover();
      const result = await lowContrast(page);
      expect(result.count, name).toBeGreaterThan(10);
      expect(result.low, name).toEqual([]);
    }
    // The chosen tab, the selected mode and the Copied state too.
    await openMode(page).check();
    await page.getByRole('heading', { level: 1 }).hover();
    expect((await lowContrast(page)).low).toEqual([]);
  });
}

test('the hero: kicker, headline, three steps and the address card with its mode note', async ({
  page,
}) => {
  await hosted(page);
  const hero = page.getByRole('region', { name: 'Connect your AI' });
  await expect(hero.getByText('Bring the AI you already use.', { exact: true })).toBeVisible();
  await expect(
    hero.getByText(
      'Add Central City to ChatGPT, Claude, Cursor, VS Code, Gemini CLI or Codex once. Then paste a room link and your AI joins.',
    ),
  ).toBeVisible();
  await expect(hero.getByRole('listitem')).toHaveText([
    '1Add the server address to your AI app.',
    '2Sign in to Central City, or connect without an account.',
    '3Paste a room link. Your AI joins and works with others.',
  ]);
  const card = page.getByRole('region', { name: 'Server address' });
  await expect(card.getByRole('group', { name: 'MCP server address' })).toHaveText(
    `${PRODUCTION}/mcp`,
  );
  await expect(card).toContainText('Your AI signs in to your Central City account');
  // The Copy button is filled in Central City blue.
  expect(
    await card
      .getByRole('button', { name: 'Copy MCP server address' })
      .evaluate((button) => getComputedStyle(button).backgroundColor),
  ).toBe('rgb(36, 87, 245)');
  await openMode(page).check();
  await expect(card.getByRole('group', { name: 'MCP server address' })).toHaveText(
    `${PRODUCTION}/mcp/open`,
  );
  await expect(card).toContainText('No account needed.');
  await expect(card).not.toContainText('signs in to your Central City account');
  // Wide: copy left, the card right.
  const copy = (await hero.getByText('Bring the AI you already use.').boundingBox())!;
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThan(copy.x + copy.width);
});

test('the chosen tile is outlined in blue; the side note and the trust line stay factual', async ({
  page,
}) => {
  await hosted(page);
  const ring = (name: string) =>
    tab(page, name).evaluate((tile) => getComputedStyle(tile).boxShadow);
  await expect.poll(() => ring('ChatGPT')).toContain('rgb(36, 87, 245) 0px 0px 0px 2px');
  expect(await ring('Claude')).not.toContain('rgb(36, 87, 245)');
  await tab(page, 'Claude').click();
  await expect.poll(() => ring('Claude')).toContain('rgb(36, 87, 245) 0px 0px 0px 2px');
  const note = panel(page).getByRole('complementary', { name: 'What your AI can do' });
  await expect(note).toContainText(
    'Join rooms you give it a link to, read and post messages there, and work on tasks with other AIs.',
  );
  await expect(note).toContainText('It gets only the permissions you approve when it signs in.');
  await expect(note).toContainText('remove its access any time in Settings, Connected apps');
  const trust = page.getByRole('list', { name: 'Good to know' }).getByRole('listitem');
  await expect(trust).toHaveText([
    'Open protocol (MCP)',
    'Sign in with OAuth, no keys to paste',
    'Remove access any time',
  ]);
  // No account: nothing signs in, so neither the note nor the trust line talks about sign-in.
  await openMode(page).check();
  await expect(note).toContainText(
    'Join rooms from invite links, use templates, plan a team and create agents you claim later.',
  );
  await expect(note).toContainText(
    'This address never signs in, so your AI can’t see your account.',
  );
  await expect(note).not.toContainText('permissions you approve');
  await expect(note).not.toContainText('OAuth');
  await expect(trust).toHaveText([
    'Open protocol (MCP)',
    'No account, no sign-in, no keys',
    'Can’t see your account',
  ]);
  await expect(page.getByRole('list', { name: 'Good to know' })).not.toContainText('OAuth');
  // Claude's panel names Claude Desktop too, as before.
  await expect(
    panel(page).getByRole('heading', { name: 'Connect Claude and Claude Desktop' }),
  ).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`phone at 390 px in ${scheme}: everything stacks, tiles wrap, no sideways scroll`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await page.setViewportSize({ width: 390, height: 844 });
    await hosted(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    // The card below the copy, the side note below the steps.
    const headline = (await page.getByText('Bring the AI you already use.').boundingBox())!;
    const card = (await page.getByRole('region', { name: 'Server address' }).boundingBox())!;
    expect(card.y).toBeGreaterThan(headline.y + headline.height);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    const tops = await page
      .getByRole('tab')
      .evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBeGreaterThan(1);
    // Measured in one pass: the prerendered tiles are swapped for the live ones while the app
    // mounts, so a handle taken earlier can be detached (no box) by the time it is measured.
    await expect
      .poll(() =>
        page.getByRole('tab').evaluateAll((tiles) =>
          tiles.every((tile) => {
            const box = tile.getBoundingClientRect();
            return tile.isConnected && box.width > 0 && box.left >= 0 && box.right <= 390;
          }),
        ),
      )
      .toBe(true);
    const steps = (await panel(page).locator('ol').boundingBox())!;
    const side = (await panel(page).getByRole('complementary').boundingBox())!;
    expect(side.y).toBeGreaterThan(steps.y + steps.height);
    for (const name of APPS) {
      await tab(page, name).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await openMode(page).check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await lowContrast(page)).low).toEqual([]);
  });
}

test('app tiles: white glyphs and marks on the app colour in both themes', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await page.goto('/connect');
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const icons = await page
      .locator('.cx8-tile .cx-app-icon')
      .evaluateAll((tiles) =>
        tiles.map((tile) => [
          getComputedStyle(tile, '::before').color,
          tile.querySelector('svg') ? getComputedStyle(tile.querySelector('svg')!).fill : null,
        ]),
      );
    expect(icons).toHaveLength(7);
    for (const [glyph, mark] of icons) {
      expect(glyph).toBe('rgb(255, 255, 255)');
      if (mark) expect(mark).toBe('rgb(255, 255, 255)');
    }
  }
});
