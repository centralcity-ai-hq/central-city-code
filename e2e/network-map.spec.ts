import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Agent, Capability, Connection, Snapshot } from '../shared/types';
import { openAdvancedGroup } from './settings-nav';
import { workspaceScale } from './workspace-density';

/*
 * Network map (Workspace v2 → Advanced workspace → Network map): a compact card (448 px at
 * full size, so about 403 px in the 90% desktop workspace; 376 px on phones) with the busiest agent in the middle and the others on three rings,
 * a name pill under each. Hover or click highlights an agent's routes (the others fade, particles
 * flow along them) and shows a small popover beside it with its routes and two actions. Agents
 * drift gently and online ones have a heartbeat; reduced motion keeps the map still. The snapshot
 * is mocked with neutral agent names. Screenshots go to NETMAP_SHOTS when set (local review only).
 */

const headers = { 'X-City-Request': '1' };
const at = '2026-10-04T12:00:00.000Z';
const capabilities: Capability[] = ['research', 'extract', 'verify'];
const NAMES = [
  'Summary writer',
  'Source reader',
  'Fact checker',
  'Citation finder',
  'Draft editor',
  'Table extractor',
  'Claim reviewer',
  'Outline planner',
  'Quote collector',
  'Style checker',
  'Quarterly report consolidation assistant',
  'Glossary builder',
  'Data cleaner',
  'Link verifier',
  'Topic scout',
  'Figure reader',
  'Tone reviewer',
  'Index maker',
  'Note taker',
  'Final proofreader',
];

function agent(index: number, overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${String(index + 1).padStart(2, '0')}`,
    name: NAMES[index],
    description: '',
    capability: capabilities[index % 3],
    mode: index % 5 === 4 ? 'external' : 'hosted',
    isDemo: false,
    status: index % 7 === 6 ? 'offline' : 'online',
    lastSeenAt: at,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

function route(from: number, to: number): Connection {
  const id = (i: number) => `agent-${String(i + 1).padStart(2, '0')}`;
  return { id: `route-${from}-${to}`, fromAgentId: id(from), toAgentId: id(to), createdAt: at };
}

/** 3 agents: Source reader → Summary writer → Fact checker. */
const THREE = { agents: [0, 1, 2].map((i) => agent(i)), connections: [route(1, 0), route(0, 2)] };
/** 20 agents: a ring of routes plus a few cross links; Summary writer sends to 3, receives from 2. */
const TWENTY = {
  agents: NAMES.map((_, i) => agent(i)),
  connections: [
    ...Array.from({ length: 19 }, (_, i) => route(i + 1, (i + 2) % 20)),
    route(1, 0),
    route(0, 2),
    route(0, 7),
    route(0, 13),
    route(5, 15),
    route(9, 3),
  ],
};

async function register(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Network-map-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

type Cross = {
  incoming: { from: string; owner: string; toAgentId: string }[];
  outgoing: { fromAgentId: string; to: string }[];
};

function crossRequest(
  id: string,
  direction: 'incoming' | 'outgoing',
  status: string,
  fields: Record<string, string | null>,
) {
  return {
    id,
    direction,
    status,
    from_agent_id: 'remote',
    from_agent_name: null,
    from_owner_label: 'Partner workspace',
    to_agent_id: 'remote',
    to_agent_name: null,
    note: '',
    requested_at: at,
    expires_at: at,
    decided_at: at,
    revoked_at: null,
    ...fields,
  };
}

/**
 * Serves the signed-in workspace's real snapshot with the given agents and routes, and the
 * cross-owner requests paged like the server: the first incoming page is full of pending
 * requests, the approved ones come on the next page.
 */
async function mockWorkspace(
  page: Page,
  data: { agents: Agent[]; connections: Connection[] },
  cross: Cross = { incoming: [], outgoing: [] },
) {
  const real = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const reachable = data.agents.filter((item) => item.status !== 'offline').length;
  const snapshot: Snapshot = {
    ...real,
    agents: data.agents,
    connections: data.connections,
    stats: { ...real.stats, registered: data.agents.length, reachable, working: 0 },
  };
  await page.route('**/api/events*', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/api/v2/connections/requests*', (r) => {
    const params = new URL(r.request().url()).searchParams;
    if (params.get('direction') === 'outgoing')
      return r.fulfill({
        json: {
          incoming: [],
          outgoing: cross.outgoing.map((item, index) =>
            crossRequest(`out-${index}`, 'outgoing', 'approved', {
              from_agent_id: item.fromAgentId,
              to_agent_name: item.to,
            }),
          ),
          next_before: null,
        },
      });
    if (!params.get('before'))
      return r.fulfill({
        json: {
          incoming: Array.from({ length: 100 }, (_, index) =>
            crossRequest(`pending-${index}`, 'incoming', 'pending', {
              from_agent_name: 'Waiting agent',
              to_agent_id: data.agents[0]?.id ?? 'none',
            }),
          ),
          outgoing: [],
          next_before: 'page-2',
        },
      });
    return r.fulfill({
      json: {
        incoming: cross.incoming.map((item, index) =>
          crossRequest(`in-${index}`, 'incoming', 'approved', {
            from_agent_name: item.from,
            from_owner_label: item.owner,
            to_agent_id: item.toAgentId,
          }),
        ),
        outgoing: [],
        next_before: null,
      },
    });
  });
}

async function openMap(page: Page, theme: 'light' | 'dark') {
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    await expect(page.locator('.sidebar.open')).toBeVisible();
  }
  const advanced = await openAdvancedGroup(page);
  await advanced.getByRole('button', { name: 'Network map', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Network map', exact: true }),
  ).toBeVisible();
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function shot(page: Page, name: string) {
  const dir = process.env.NETMAP_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

const node = (page: Page, name: string) => page.locator(`.nm-node[title="${name}"]`);

/**
 * The share of pixels that differ visibly between two screenshots (decoded in the page). The
 * rasteriser may vary a stray row of anti-aliased pixels by a level or two; those do not count.
 */
async function frameDifference(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([one, two]) => {
      const pixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = await Promise.all([pixels(one), pixels(two)]);
      if (x.length !== y.length) return 1;
      let changed = 0;
      for (let i = 0; i < x.length; i += 4) {
        const delta =
          Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
        if (delta > 12) changed++;
      }
      return changed / (x.length / 4);
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/** Card height: 448 px at the workspace scale (about 403 px on desktop) and 376 px on phones. */
const cardBounds = (width: number) => {
  const height = 448 * workspaceScale(width);
  return width > 720 ? [height - 8, height + 8] : [368, 384];
};

/** Visible name pills must not overlap each other, and must sit inside the stage. */
async function expectNoLabelOverlap(page: Page) {
  const result = await page.evaluate(() => {
    const stage = document.querySelector('.nm-stage')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.nm-node:not(.is-unnamed) .nm-label')].map(
      (element) => element.getBoundingClientRect(),
    );
    const clashes: string[] = [];
    boxes.forEach((a, i) => {
      if (a.left < stage.left - 1 || a.right > stage.right + 1) clashes.push(`label ${i} out`);
      if (a.top < stage.top - 1 || a.bottom > stage.bottom + 1) clashes.push(`label ${i} out`);
      boxes.slice(i + 1).forEach((b, k) => {
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 0.5 && y > 0.5) clashes.push(`labels ${i} and ${i + k + 1}`);
      });
    });
    return { shown: boxes.length, clashes };
  });
  expect(result.clashes).toEqual([]);
  return result.shown;
}

/** Names of the agents (other than the selected one) whose avatar is under the popover. */
const agentsUnderPopover = (page: Page) =>
  page.evaluate(() => {
    const pop = document.querySelector('.nm-pop')?.getBoundingClientRect();
    if (!pop) return ['no popover'];
    return [...document.querySelectorAll<HTMLElement>('.nm-node')]
      .filter((item) => item.getAttribute('aria-pressed') !== 'true')
      .filter((item) => {
        const box = item.querySelector('.nm-avatar')!.getBoundingClientRect();
        return (
          Math.min(box.right, pop.right) - Math.max(box.left, pop.left) > 0.5 &&
          Math.min(box.bottom, pop.bottom) - Math.max(box.top, pop.top) > 0.5
        );
      })
      .map((item) => item.title);
  });

/** The node transforms right now (they change every frame while the map is alive). */
const transforms = (page: Page) =>
  page
    .locator('.nm-node')
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).style.transform));

for (const width of [1440, 390])
  for (const theme of ['light', 'dark'] as const)
    for (const count of [3, 20]) {
      test(`network map: ${count} agents at ${width} px, ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
        await register(page);
        const data = count === 3 ? THREE : TWENTY;
        // Approved cross-owner connections arrive after a first page full of pending requests.
        const cross: Cross =
          count === 3
            ? {
                incoming: [
                  { from: 'Remote reviewer', owner: 'Partner workspace', toAgentId: 'agent-01' },
                ],
                outgoing: [{ fromAgentId: 'agent-01', to: 'Remote summarizer' }],
              }
            : { incoming: [], outgoing: [] };
        await mockWorkspace(page, data, cross);
        await openMap(page, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(
          page
            .locator('main.adv2 .page-heading')
            .getByText('Your agents and who can send work to whom.', { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/work waiting for your decision/)).toHaveCount(0);

        const routes = data.connections.length + cross.incoming.length + cross.outgoing.length;
        const map = page.getByRole('group', {
          name: `Agent map: ${count} agents, ${routes} routes`,
        });
        await expect(map).toBeVisible();
        await expect(page.locator('.nm-node')).toHaveCount(count);
        await expect(page.locator('.nm-route')).toHaveCount(data.connections.length);
        // No giant centre number: the counts are a small label in the card header.
        await expect(page.locator('.nm-hub-count')).toHaveCount(0);
        const online = data.agents.filter((item) => item.status === 'online').length;
        await expect(page.locator('.nm-meta')).toContainText(
          `${count} agents · ${routes} routes · ${online} online`,
        );
        await expect(page.locator('.nm-online')).toContainText(`${online} online`);
        // A compact card: about 403 px on desktop (448 px at 90%) and about 376 px on phones.
        const card = await page.locator('.nm').boundingBox();
        const [low, high] = cardBounds(width);
        expect(card!.height).toBeGreaterThanOrEqual(low);
        expect(card!.height).toBeLessThanOrEqual(high);
        // The text alternative lists every agent with its routes.
        const textList = page.getByRole('list', { name: 'Agents and routes', exact: true });
        await expect(textList.getByRole('listitem')).toHaveCount(count);
        await expect(textList.getByRole('listitem').first()).toContainText(
          count === 3
            ? 'Summary writer, Online, Research. Can send work to: Fact checker, Remote summarizer (Another workspace). Can receive work from: Source reader, Remote reviewer (Partner workspace).'
            : 'Summary writer, Online, Research. Can send work to: Fact checker, Outline planner, Link verifier.',
        );
        await expectNoPageOverflow(page);

        // Alive: the agents float (their transforms change), and names never overlap.
        await expect(page.locator('.nm')).toHaveAttribute('data-motion', 'on');
        const before = await transforms(page);
        await page.waitForTimeout(600);
        expect(await transforms(page)).not.toEqual(before);
        const shown = await expectNoLabelOverlap(page);
        expect(shown).toBeGreaterThanOrEqual(width > 720 || count === 3 ? count : 1);
        await shot(page, `network-map-${width}-${theme}-${count}agents-map`);

        // Hover: the agent's routes light up, every unrelated agent fades and a preview shows.
        const writer = node(page, 'Summary writer');
        await writer.hover({ force: true });
        const own = data.connections.filter(
          (item) => item.fromAgentId === 'agent-01' || item.toAgentId === 'agent-01',
        ).length;
        await expect(page.locator('.nm-route-hot')).toHaveCount(own);
        await expect(page.locator('.nm-route-dim')).toHaveCount(data.connections.length - own);
        await expect(writer).toHaveClass(/is-hover/);
        if (count === 20) await expect(page.locator('.nm-node.is-dim')).toHaveCount(count - 6);
        const sends = count === 3 ? 2 : 3;
        const receives = 2;
        const preview = page.locator('.nm-pop');
        await expect(preview).toBeVisible();
        await expect(preview).toContainText(`sends to ${sends} · receives from ${receives}`);
        await page.mouse.move(1, 1);
        await expect(page.locator('.nm-route-dim')).toHaveCount(0);
        await expect(page.locator('.nm-node.is-dim')).toHaveCount(0);
        await expect(preview).toHaveCount(0);

        // Click: a small popover beside the agent with its routes and two actions.
        await writer.click({ force: true });
        const pop = page.getByRole('dialog', { name: 'Summary writer', exact: true });
        await expect(pop).toBeVisible();
        await expect(pop.getByRole('heading', { name: 'Summary writer' })).toBeFocused();
        await expect(pop).toContainText('Online');
        await expect(pop).toContainText(`sends to ${sends} · receives from ${receives}`);
        await expect(writer).toHaveAttribute('aria-pressed', 'true');
        await expect(pop.getByRole('button', { name: 'Open agent', exact: true })).toBeVisible();
        await expect(pop.getByRole('button', { name: 'Permissions', exact: true })).toBeVisible();
        await page.mouse.move(1, 1);
        await expect(page.locator('.nm-route-hot')).toHaveCount(own);
        // The popover covers no agent at all: on desktop it finds a free spot beside its agent,
        // on a phone the map makes room above it (the agents glide there first).
        await expect.poll(() => agentsUnderPopover(page), { timeout: 5000 }).toEqual([]);
        // The selected agent's name and the names of the agents it works with show in full.
        for (const name of ['Summary writer', 'Fact checker', 'Source reader']) {
          const label = node(page, name).locator('.nm-name');
          await expect(label).toHaveText(name);
          expect(
            await label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          ).toBe(true);
        }
        // No side panel: the map keeps the full card width, and the popover stays inside it.
        const [stageBox, popBox, cardBox] = await Promise.all([
          page.locator('.nm-stage').boundingBox(),
          pop.boundingBox(),
          page.locator('.nm').boundingBox(),
        ]);
        expect(Math.abs(stageBox!.width - (cardBox!.width - 2))).toBeLessThanOrEqual(1);
        expect(popBox!.x).toBeGreaterThanOrEqual(stageBox!.x);
        expect(popBox!.x + popBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width);
        expect(popBox!.y).toBeGreaterThanOrEqual(stageBox!.y);
        expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(stageBox!.y + stageBox!.height);
        // The popover does not cover the agent it belongs to.
        const writerBox = (await writer.boundingBox())!;
        const covers =
          Math.min(popBox!.x + popBox!.width, writerBox.x + writerBox.width) -
            Math.max(popBox!.x, writerBox.x) >
            4 &&
          Math.min(popBox!.y + popBox!.height, writerBox.y + writerBox.height) -
            Math.max(popBox!.y, writerBox.y) >
            4;
        expect(covers).toBe(false);
        // On desktop it is anchored next to its agent; on a phone it runs along the bottom.
        const gapX = Math.max(
          0,
          popBox!.x - (writerBox.x + writerBox.width),
          writerBox.x - (popBox!.x + popBox!.width),
        );
        const gapY = Math.max(
          0,
          popBox!.y - (writerBox.y + writerBox.height),
          writerBox.y - (popBox!.y + popBox!.height),
        );
        if (width > 720) expect(Math.hypot(gapX, gapY)).toBeLessThan(60);
        else expect(stageBox!.y + stageBox!.height - (popBox!.y + popBox!.height)).toBeLessThan(14);
        // Any name the popover still covers is dimmed under it; none reads at full strength (agents
        // moved aside glide there first).
        const clashes = () =>
          page.evaluate(() => {
            const pop = document.querySelector('.nm-pop')!.getBoundingClientRect();
            return [...document.querySelectorAll('.nm-node:not(.is-unnamed)')]
              .filter((item) => !item.classList.contains('is-under-pop'))
              .filter((item) => item.getAttribute('aria-pressed') !== 'true')
              .map((item) => item.querySelector('.nm-label')!.getBoundingClientRect())
              .filter(
                (box) =>
                  Math.min(box.right, pop.right) - Math.max(box.left, pop.left) > 1 &&
                  Math.min(box.bottom, pop.bottom) - Math.max(box.top, pop.top) > 1,
              ).length;
          });
        await expect.poll(clashes, { timeout: 5000 }).toBe(0);
        if (count === 20) {
          // A long name is truncated on the map with the full name as its tooltip.
          const long = node(page, 'Quarterly report consolidation assistant');
          await expect(long.locator('.nm-name')).toHaveText(/…$/);
        }
        await expectNoPageOverflow(page);
        await shot(page, `network-map-${width}-${theme}-${count}agents-selected`);

        // Esc closes the popover and returns focus to the agent.
        await page.keyboard.press('Escape');
        await expect(pop).toHaveCount(0);
        await expect(writer).toBeFocused();
        await expectNoPageOverflow(page);
      });
    }

for (const [width, theme] of [
  [1440, 'light'],
  [390, 'dark'],
  [390, 'light'],
] as const)
  for (const count of [3, 20])
    test(`network map: reduced motion keeps ${count} agents still at ${width} px, ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
      await register(page);
      await mockWorkspace(page, count === 3 ? THREE : TWENTY);
      await openMap(page, theme);
      await expect(page.locator('.nm-node')).toHaveCount(count);
      await expect(page.locator('.nm')).toHaveAttribute('data-motion', 'off');
      await expectNoLabelOverlap(page);
      const stage = page.locator('.nm-stage');
      // On a phone "Network map" is clicked in the drawer, which then closes and leaves the
      // pointer over the map. Chromium reports that as a hover whenever it next updates the
      // hover state, which can fall between the two frames below and highlight an agent there.
      // A hover is not motion: park the pointer off the map so the frames show the map at rest.
      await page.mouse.move(1, 1);
      await expect(stage).not.toHaveClass(/has-focus/);
      // No drift, no particles, no breathing: the frame is the same 500 ms later.
      const state = () =>
        page.evaluate(() => ({
          focused: document.querySelector('.nm-stage')!.classList.contains('has-focus'),
          nodes: [...document.querySelectorAll<HTMLElement>('.nm-node')].map(
            (item) => item.style.transform,
          ),
          routes: [...document.querySelectorAll('.nm-route')].map((item) => item.getAttribute('d')),
          animations: document
            .getAnimations()
            .filter((item) => (item.effect as KeyframeEffect | null)?.target?.closest?.('.nm'))
            .filter((item) => item.playState === 'running').length,
        }));
      await page.waitForTimeout(300);
      const [first, before] = [await stage.screenshot({ animations: 'allow' }), await state()];
      await page.waitForTimeout(500);
      const [second, after] = [await stage.screenshot({ animations: 'allow' }), await state()];
      expect(after).toEqual(before);
      expect(before.animations).toBe(0);
      expect(await frameDifference(page, first, second)).toBeLessThan(0.0002);
      // Hover and click still work.
      await node(page, 'Summary writer').hover();
      await expect(page.locator('.nm-route-hot')).toHaveCount(count === 3 ? 2 : 5);
      await node(page, 'Summary writer').click();
      await expect(page.getByRole('dialog', { name: 'Summary writer' })).toBeVisible();
      // (On a phone the agents move to make room, so the pointer leaves before Esc.)
      await page.mouse.move(1, 1);
      await page.keyboard.press('Escape');
      await expect(page.locator('.nm-pop')).toHaveCount(0);
      await expectNoPageOverflow(page);
    });

test('network map: a dragged agent moves and settles back softly', async ({ page }) => {
  await register(page);
  await mockWorkspace(page, THREE);
  await openMap(page, 'light');
  const writer = node(page, 'Summary writer');
  const centre = async () => {
    const box = (await writer.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const home = await centre();
  await page.mouse.move(home.x, home.y);
  await page.mouse.down();
  await page.mouse.move(home.x + 40, home.y + 30, { steps: 5 });
  await page.mouse.move(home.x + 90, home.y + 50, { steps: 5 });
  const held = await centre();
  expect(Math.hypot(held.x - home.x - 90, held.y - home.y - 50)).toBeLessThan(6);
  await page.mouse.up();
  // A drag is not a click: no popover opens for it.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // It glides back home (within its float radius).
  await expect
    .poll(
      async () => {
        const now = await centre();
        return Math.hypot(now.x - home.x, now.y - home.y);
      },
      { timeout: 5000 },
    )
    .toBeLessThan(10);
});

test('network map: Tab and arrow keys move between agents, Enter opens the popover', async ({
  page,
}) => {
  await register(page);
  await mockWorkspace(page, THREE);
  await openMap(page, 'light');
  const nodes = page.locator('.nm-node');
  // Every agent is a tab stop.
  await expect(page.locator('.nm-node[tabindex="-1"]')).toHaveCount(0);
  await nodes.first().focus();
  await page.keyboard.press('Tab');
  await expect(nodes.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(nodes.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(nodes.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Fact checker', exact: true });
  await expect(panel).toBeVisible();
  // Focus moves into the popover; Tab goes on to its close button, then its actions.
  await expect(panel.getByRole('heading', { name: 'Fact checker' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    panel.getByRole('button', { name: 'Close Fact checker', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Open agent', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(nodes.nth(2)).toBeFocused();
  // Space opens it too; the close button closes it and gives focus back to the agent.
  await page.keyboard.press('Space');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close Fact checker', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(nodes.nth(2)).toBeFocused();
  await expect(nodes.nth(2)).toHaveAttribute('aria-pressed', 'false');
});

test('network map: a failed cross-workspace load shows a note with Retry', async ({ page }) => {
  await register(page);
  await mockWorkspace(page, THREE, {
    incoming: [{ from: 'Remote reviewer', owner: 'Partner workspace', toAgentId: 'agent-01' }],
    outgoing: [],
  });
  // The first load fails; Retry asks again and succeeds (served by the mock underneath).
  let failing = true;
  await page.route('**/api/v2/connections/requests*', (r) =>
    failing ? r.fulfill({ status: 500, json: { error: 'Server error' } }) : r.fallback(),
  );
  await openMap(page, 'light');
  const note = page.locator('.nm-note');
  await expect(note).toHaveText(/Couldn't load connections with other workspaces\s*·\s*Retry/);
  await expect(page.getByRole('group', { name: 'Agent map: 3 agents, 2 routes' })).toBeVisible();
  // The note sits inside the map card without changing its height.
  const card = (await page.locator('.nm').boundingBox())!;
  const [low, high] = cardBounds(1440);
  expect(card.height).toBeGreaterThanOrEqual(low);
  expect(card.height).toBeLessThanOrEqual(high);
  failing = false;
  await note.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(note).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Agent map: 3 agents, 3 routes' })).toBeVisible();
});

/** A short strip of frames (6 over 2 s) to show the motion; local review only. */
test('network map: motion strip', async ({ page }) => {
  test.skip(!process.env.NETMAP_SHOTS, 'Only when recording screenshots');
  await register(page);
  await mockWorkspace(page, TWENTY);
  await openMap(page, 'light');
  await page.waitForTimeout(800);
  // One agent selected: its routes glow with particles, the others fade; all breathe gently.
  await node(page, 'Summary writer').click({ force: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  const stage = page.locator('.nm');
  for (let frame = 0; frame < 6; frame++) {
    await stage.screenshot({
      path: join(process.env.NETMAP_SHOTS!, `network-map-motion-${frame + 1}.png`),
    });
    await page.waitForTimeout(400);
  }
});

test('network map: the popover opens My agents and Agent permissions', async ({ page }) => {
  await register(page);
  await mockWorkspace(page, THREE);
  await openMap(page, 'light');
  await node(page, 'Source reader').click({ force: true });
  await page
    .getByRole('dialog', { name: 'Source reader' })
    .getByRole('button', { name: 'Permissions', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agent permissions', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Network map', exact: true }),
  ).toBeVisible();
  await node(page, 'Source reader').click({ force: true });
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'My agents', exact: true }),
  ).toBeVisible();
  // The agent opens in My agents' detail (not a dialog), focused on its name.
  const detail = page.getByRole('complementary', { name: 'Source reader details' });
  await expect(detail.getByRole('heading', { level: 2, name: 'Source reader' })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('network map: the list view runs no animation frames', async ({ page }) => {
  // Count every animation frame the page asks for.
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    (window as unknown as { rafCalls: number }).rafCalls = 0;
    window.requestAnimationFrame = (callback) => {
      (window as unknown as { rafCalls: number }).rafCalls++;
      return original(callback);
    };
  });
  const frames = () => page.evaluate(() => (window as unknown as { rafCalls: number }).rafCalls);
  await register(page);
  // 31 agents open as a list first; the Map/List toggle switches between them.
  const agents = Array.from({ length: 31 }, (_, i) =>
    agent(i, { name: NAMES[i] ?? `Helper ${i + 1}` }),
  );
  await mockWorkspace(page, { agents, connections: TWENTY.connections });
  await openMap(page, 'light');
  const toggle = page.getByRole('group', { name: 'Show agents as' });
  await expect(toggle.getByRole('button', { name: 'List' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.waitForTimeout(300);
  let before = await frames();
  await page.waitForTimeout(600);
  expect(await frames()).toBe(before);

  // The map animates...
  await toggle.getByRole('button', { name: 'Map' }).click();
  await expect(page.locator('.nm-node')).toHaveCount(31);
  before = await frames();
  await page.waitForTimeout(600);
  expect(await frames()).toBeGreaterThan(before + 10);

  // ...and back in the list the loop stops and its frame is cancelled.
  await toggle.getByRole('button', { name: 'List' }).click();
  await expect(page.locator('.nm-node')).toHaveCount(0);
  await expect(page.locator('.nm')).toHaveClass(/is-paused/);
  await page.waitForTimeout(200);
  before = await frames();
  await page.waitForTimeout(600);
  expect(await frames()).toBe(before);

  // Back on the map it runs again, with its routes drawn.
  await toggle.getByRole('button', { name: 'Map' }).click();
  before = await frames();
  await page.waitForTimeout(600);
  expect(await frames()).toBeGreaterThan(before + 10);
  await expect(page.locator('.nm-route').first()).toHaveAttribute('d', /^M/);
});

test('network map: empty workspace shows an empty state', async ({ page }) => {
  await register(page);
  await mockWorkspace(page, { agents: [], connections: [] });
  await openMap(page, 'light');
  await expect(page.getByRole('status').filter({ hasText: 'No agents yet.' })).toBeVisible();
  await expect(page.locator('.nm-node')).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to My agents', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'My agents', exact: true }),
  ).toBeVisible();
});

test('network map: the system dark mode gives the map its dark blue', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await register(page);
  await mockWorkspace(page, THREE);
  await openMap(page, 'light');
  const accent = () =>
    page
      .locator('.nm')
      .evaluate((element) => getComputedStyle(element).getPropertyValue('--accent').trim());
  // The light theme chosen explicitly keeps the light blue, even in system dark mode.
  await expect.poll(accent).toBe('#0071e3');
  // With no theme chosen, the system's dark mode applies.
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await expect.poll(accent).toBe('#0a84ff');
});
