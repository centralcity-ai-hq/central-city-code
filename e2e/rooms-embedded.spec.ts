import { readFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  test,
  expect as baseExpect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

/**
 * RoomsApp's `embedded` mode (src/rooms/RoomsApp.tsx): inside an app shell that draws its own
 * global navigation, RoomsApp drops its global chrome (brand, Workspace and Elric links, theme
 * toggle, account menu, collapse control) and keeps everything room-specific. The rooms harness
 * (src/rooms/harness.tsx) mounts RoomsApp with `embedded` when the address has `?embedded=1`;
 * /api is proxied to the Playwright web server.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };

let API = '';
let APP = '';
let harness: ViteDevServer;

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  API = String(test.info().project.use.baseURL);
  const port = await freePort();
  APP = `http://127.0.0.1:${port}`;
  const html = readFileSync(resolve('src/rooms/harness.html'), 'utf8');
  harness = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    appType: 'custom',
    plugins: [
      react(),
      {
        name: 'rooms-harness-routes',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const path = (request.url ?? '/').split('?')[0]!;
            if (!/^\/(?:r\/[A-Za-z0-9_-]+|rooms(?:\/[A-Za-z0-9_-]+)?|signin)$/.test(path))
              return next();
            void server.transformIndexHtml(request.url ?? '/', html).then((page) => {
              response.setHeader('content-type', 'text/html');
              response.end(page);
            }, next);
          });
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      // Same-origin for the server's CSRF check: the proxy presents the API's host and origin.
      proxy: {
        '/api': {
          target: API,
          changeOrigin: true,
          configure: (proxy) =>
            proxy.on('proxyReq', (request) => {
              if (request.getHeader('origin')) request.setHeader('origin', API);
            }),
        },
      },
    },
  });
  await harness.listen();
});
test.afterAll(async () => {
  await harness?.close();
});

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((done) => setTimeout(done, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

/** A signed-in account hosting one room, with a page on the harness. */
async function hostWithRoom(browser: Browser, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ baseURL: APP, viewport });
  opened.push(context);
  const request = context.request;
  const name = `Embedded-${crypto.randomUUID().slice(0, 8)}`;
  const created = await patient(() =>
    request.post(`${API}/api/auth/register`, { headers, data: { name, password: PASSWORD } }),
  );
  expect(created.status()).toBe(201);
  const agent = await patient(() =>
    request.post(`${API}/api/agents`, {
      headers,
      data: { name: 'Host agent', capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok()).toBeTruthy();
  const agentId = (await agent.json()).agent.id as string;
  const room = await patient(() =>
    request.post(`${API}/api/rooms`, {
      headers,
      data: { agent_id: agentId, name: 'Embedded room', idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status()).toBe(201);
  const roomId = ((await room.json()).room as { id: string }).id;
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, name, roomId, errors };
}

/** The global chrome RoomsApp draws for itself; none of it is shown when embedded. */
async function expectNoGlobalChrome(page: Page, name: string) {
  const sidebar = page.getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar.locator('.rm-sidebar-brand-wrap')).toHaveCount(0);
  await expect(sidebar.getByAltText('Central City')).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Workspace' })).toHaveCount(0);
  await expect(sidebar.locator('a[href="/elric"]')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: /^(Dark|Light) mode$/ })).toHaveCount(0);
  await expect(sidebar.locator('.rm-sidebar-footer')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Collapse sidebar' })).toHaveCount(0);
}

test('without embedded, the harness shows RoomsApp with its own global chrome', async ({
  browser,
}) => {
  const host = await hostWithRoom(browser);
  await host.page.goto(`/rooms/${host.roomId}`);
  const sidebar = host.page.getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar.getByRole('link', { name: 'Embedded room' })).toBeVisible();
  await expect(host.page.locator('.rm-app')).not.toHaveAttribute('data-embedded');
  await expect(sidebar.getByAltText('Central City')).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Workspace' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Dark mode' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  expect(host.errors).toEqual([]);
});

test('embedded on desktop: global chrome gone, rooms list, actions and room header kept', async ({
  browser,
}) => {
  const host = await hostWithRoom(browser);
  await host.page.goto(`/rooms/${host.roomId}?embedded=1`);
  await expect(host.page.locator('.rm-app')).toHaveAttribute('data-embedded', 'true');
  const sidebar = host.page.getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar.getByRole('link', { name: 'Embedded room' })).toBeVisible();
  await expectNoGlobalChrome(host.page, host.name);

  // Room-specific: the rooms list (Hosting), Room list, New room, Join a room.
  await expect(sidebar.locator('#groupHosting')).toContainText('Hosting (1)');
  await expect(sidebar.getByRole('link', { name: 'Room list' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'New room' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Join a room' })).toBeVisible();
  // The open room keeps its header and actions.
  await expect(host.page.getByRole('button', { name: 'Invite' }).first()).toBeVisible();
  // New room still opens its dialog.
  await sidebar.getByRole('button', { name: 'New room' }).click();
  await expect(host.page.getByRole('dialog', { name: 'New room' })).toBeVisible();
  await host.page.keyboard.press('Escape');
  await expect(host.page.getByRole('dialog', { name: 'New room' })).toBeHidden();

  // A stored collapsed rail and the Ctrl+\ shortcut do not collapse the embedded sidebar.
  await host.page.evaluate(() => localStorage.setItem('cc.rooms.sidebar.collapsed', '1'));
  await host.page.reload();
  await expect(sidebar.getByRole('link', { name: 'Embedded room' })).toBeVisible();
  await host.page.keyboard.press('Control+Backslash');
  await expect(sidebar).not.toHaveClass(/collapsed/);
  expect(host.errors).toEqual([]);
});

test('embedded on a phone: the menu button opens the rooms drawer, without global chrome', async ({
  browser,
}) => {
  const host = await hostWithRoom(browser, { width: 390, height: 844 });
  await host.page.goto(`/rooms?embedded=1`);
  await expect(host.page.locator('.rm-app')).toHaveAttribute('data-embedded', 'true');
  const menu = host.page.getByRole('button', { name: 'Open menu' });
  await expect(menu).toBeVisible();
  await menu.click();
  const sidebar = host.page.getByRole('navigation', { name: 'Rooms' });
  const close = sidebar.getByRole('button', { name: 'Close rooms' });
  await expect(close).toBeFocused();
  await expect(sidebar.getByRole('link', { name: 'Embedded room' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'New room' })).toBeVisible();
  await expectNoGlobalChrome(host.page, host.name);
  await close.click();
  await expect(menu).toBeFocused();

  // A room opened from the drawer keeps its own menu button.
  await menu.click();
  await sidebar.getByRole('link', { name: 'Embedded room' }).click();
  await expect(host.page).toHaveURL(new RegExp(`/rooms/${host.roomId}$`));
  await expect(host.page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expect(host.page.locator('.rm-app')).toHaveAttribute('data-embedded', 'true');
  expect(host.errors).toEqual([]);
});

test('embedded fills its container, not the viewport', async ({ browser }) => {
  const host = await hostWithRoom(browser);
  await host.page.goto(`/rooms/${host.roomId}?embedded=1`);
  const app = host.page.locator('.rm-app');
  await expect(app).toHaveAttribute('data-embedded', 'true');
  // A shell gives Rooms a smaller content area; Rooms must take exactly that.
  await app.evaluate((el) => {
    const frame = document.createElement('div');
    frame.style.width = '700px';
    frame.style.height = '500px';
    el.replaceWith(frame);
    frame.append(el);
  });
  const box = (await app.boundingBox())!;
  expect(Math.round(box.width)).toBe(700);
  expect(Math.round(box.height)).toBe(500);
});
