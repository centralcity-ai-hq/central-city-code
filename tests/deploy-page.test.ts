import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { maskedRuntimeMatches } from '../scripts/protocol/deploy-fee-router.js';

/*
 * The fee routers' deploy page (contracts/deploy-kit/deploy.html), run against a stub DOM, a stub
 * wallet and a stub public Base endpoint: the real page script, keccak.js and guard.js, no browser
 * and no network.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('contracts/deploy-kit/deploy.html');
const pageScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const libraries = [...html.matchAll(/<script src="([\w.]+)"><\/script>/g)].map((m) =>
  read(`contracts/deploy-kit/${m[1]}`),
);
const TREASURY = '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9';
const ADDRESS = '0x00000000000000000000000000000000c0ffee01';
const TX = `0x${'ab'.repeat(32)}`;
const BASE = '0x2105';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string };

/** The router's runtime code as compiled, and as deployed with `usdc` and `treasury`. */
const compiledRuntimes = new Map<
  string,
  { object: string; immutableReferences: Record<string, { start: number; length: number }[]> }
>();
function runtimeOf(file: string, usdc: string, treasury: string) {
  const kit = JSON.parse(read(`contracts/deploy-kit/${file}`));
  const out = compiledRuntimes.has(file)
    ? null
    : JSON.parse(
        solc.compile(
          JSON.stringify({
            language: 'Solidity',
            sources: { [kit.sourceUnit]: { content: read(`contracts/${kit.sourceUnit}`) } },
            settings: {
              ...kit.settings,
              outputSelection: {
                '*': {
                  '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'],
                },
              },
            },
          }),
        ),
      );
  if (out)
    compiledRuntimes.set(file, out.contracts[kit.sourceUnit][kit.contract].evm.deployedBytecode);
  const compiled = compiledRuntimes.get(file)!;
  let hex: string = compiled.object;
  const word = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  for (const [name, ranges] of Object.entries(
    kit.immutables as Record<string, { start: number }[]>,
  ))
    for (const { start } of ranges)
      hex =
        hex.slice(0, start * 2) +
        word(name === 'token' ? usdc : treasury) +
        hex.slice(start * 2 + 64);
  const ranges = Object.values(
    compiled.immutableReferences as Record<string, { start: number; length: number }[]>,
  ).flat();
  return { kit, runtime: `0x${compiled.object}`, deployed: `0x${hex}`, ranges };
}

class Element {
  children: Element[] = [];
  className = '';
  disabled = false;
  checked = false;
  value = '';
  dataset: Record<string, string> = {};
  href = '';
  target = '';
  rel = '';
  listeners: Record<string, Array<() => unknown>> = {};
  private text = '';
  constructor(readonly tag: string) {}
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  set innerHTML(value: string) {
    this.textContent = value.replace(/<[^>]+>/g, '');
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  addEventListener(type: string, listener: () => unknown) {
    (this.listeners[type] ??= []).push(listener);
  }
}

class Storage {
  map = new Map<string, string>();
  broken = false;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.broken) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** navigator.locks for pages of one origin: one holder per name at a time. */
class Locks {
  private tails = new Map<string, Promise<unknown>>();
  request(name: string, run: () => Promise<unknown>) {
    const result = (this.tails.get(name) ?? Promise.resolve()).then(run, run);
    this.tails.set(
      name,
      result.catch(() => undefined),
    );
    return result;
  }
}

interface PageOptions {
  storage?: Storage;
  locks?: Locks;
  /** A browser without Web Locks (navigator.locks absent). */
  noLocks?: boolean;
  /** Resolves when the wallet should answer eth_sendTransaction (a person deciding). */
  walletDecides?: Promise<void>;
  walletChain?: string;
  publicChain?: string;
  treasury?: string;
  code?: string;
  sendError?: { code?: number; message: string };
  router?: 1 | 2 | 3;
}

function openPage(options: PageOptions = {}) {
  const storage = options.storage ?? new Storage();
  const router = options.router ?? 1;
  const kitFile = router === 1 ? 'router.json' : `router${router}.json`;
  const kit = JSON.parse(read(`contracts/deploy-kit/${kitFile}`));
  const elements = new Map<string, Element>();
  for (const [, id] of html.matchAll(/id="([\w-]+)"/g)) elements.set(id!, new Element(id!));
  const walletCalls: Array<{ method: string; params: unknown[] }> = [];
  const publicCalls: Array<{ method: string; params: unknown[] }> = [];
  const walletListeners: Record<string, Array<(value: unknown) => void>> = {};
  const state = { walletChain: options.walletChain ?? BASE };
  const code = () =>
    options.code ?? runtimeOf(kitFile, USDC, options.treasury ?? TREASURY).deployed;
  const getter = (selector: string) => {
    const words: Record<string, string> = {
      '0xfc0c546a': kit.usdc,
      '0x61d027b3': options.treasury ?? TREASURY,
      '0xcd60fe35': router === 1 ? '0x186a0' : '0x5f5e100',
      '0xa0dbd6f4': '0xc350',
      '0xbf333f2c': '0x3e8',
    };
    return `0x${BigInt(words[selector]!).toString(16).padStart(64, '0')}`;
  };
  const ethereum = {
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      walletCalls.push({ method, params });
      if (method === 'eth_requestAccounts') return [TREASURY];
      if (method === 'eth_chainId') return state.walletChain;
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        await options.walletDecides;
        if (options.sendError)
          throw Object.assign(new Error(options.sendError.message), options.sendError);
        return TX;
      }
      if (method === 'eth_getTransactionReceipt')
        return { status: '0x1', contractAddress: ADDRESS, blockNumber: '0x10' };
      if (method === 'eth_getCode') return code();
      if (method === 'eth_call') return getter((params[0] as { data: string }).data);
      throw new Error(`unexpected wallet call ${method}`);
    },
    on(type: string, listener: (value: unknown) => void) {
      (walletListeners[type] ??= []).push(listener);
    },
  };
  const publicRpc = (method: string, params: unknown[]) => {
    publicCalls.push({ method, params });
    if (method === 'eth_chainId') return options.publicChain ?? BASE;
    if (method === 'eth_getCode') return code();
    if (method === 'eth_call') return getter((params[0] as { data: string }).data);
    throw new Error(`unexpected public call ${method}`);
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url === kitFile) return { json: async () => kit };
    if (url === 'https://mainnet.base.org') {
      const { method, params } = JSON.parse(init!.body!);
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result: publicRpc(method, params) }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const window = {
    ethereum,
    localStorage: storage,
    location: { search: router === 1 ? '' : `?router=${router}` },
  } as Record<string, unknown>;
  const sandbox = {
    window,
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: (tag: string) => new Element(tag),
    },
    localStorage: storage,
    location: window.location,
    navigator: options.noLocks ? {} : { locks: options.locks ?? new Locks() },
    fetch,
    setTimeout: (fn: () => void) => setImmediate(fn),
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  for (const library of libraries) vm.runInContext(library, sandbox);
  vm.runInContext(pageScript, sandbox);
  const $ = (id: string) => elements.get(id)!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const click = async (id: string) => {
    for (const listener of $(id).listeners.click ?? []) await listener();
  };
  const rows = (id: string) => {
    const list = $(id).children;
    const out: Record<string, { text: string; className: string }> = {};
    for (let i = 0; i + 1 < list.length; i += 2)
      out[list[i]!.textContent] = {
        text: list[i + 1]!.textContent,
        className: list[i + 1]!.className,
      };
    return out;
  };
  async function connectAndConfirm() {
    // The kit loads and its bytecode hash is computed.
    for (let i = 0; i < 500 && !rows('kit')['Bytecode check']; i++) await settle();
    assert.equal(rows('kit')['Bytecode check']?.className, 'ok', 'the kit is approved');
    await click('connect');
    $('treasuryOk').checked = true;
    for (const listener of $('treasuryOk').listeners.change ?? []) await listener();
  }
  return {
    $,
    click,
    rows,
    settle,
    storage,
    state,
    walletCalls,
    publicCalls,
    walletListeners,
    connectAndConfirm,
  };
}

test('the deploy transaction names Base, and a network or account switch disconnects (CCA-130)', async () => {
  const page = openPage();
  await page.connectAndConfirm();
  assert.equal(page.$('deploy').disabled, false, 'ready to deploy');
  // The wallet switched network after connecting: connect again before anything is sent.
  for (const listener of page.walletListeners.chainChanged ?? []) listener('0x1');
  assert.equal(page.$('deploy').disabled, true, 'a chain change disables Deploy');
  assert.match(page.$('account').textContent, /connect again/);
  await page.connectAndConfirm();
  for (const listener of page.walletListeners.accountsChanged ?? []) listener([]);
  assert.equal(page.$('deploy').disabled, true, 'an account change disables Deploy');
  await page.connectAndConfirm();
  await page.click('deploy');
  const sent = page.walletCalls.find((call) => call.method === 'eth_sendTransaction')!;
  assert.equal((sent.params[0] as { chainId?: string }).chainId, BASE);
});

test('the read-back re-checks Base on the public endpoint; Next only when every row passes (CCA-130)', async () => {
  const good = openPage();
  await good.connectAndConfirm();
  await good.click('deploy');
  await good.settle();
  const rows = good.rows('checks');
  assert.equal(rows['Public Base endpoint']?.className, 'ok');
  assert.equal(rows['Wallet network']?.className, 'ok');
  assert.ok(rows.Next, 'all rows passed');
  // The code and the getters come from the public endpoint, not only from the wallet's node.
  assert.ok(good.publicCalls.some((call) => call.method === 'eth_getCode'));
  assert.ok(good.publicCalls.some((call) => call.method === 'eth_call'));

  const wrongChain = openPage({ publicChain: '0x1' });
  await wrongChain.connectAndConfirm();
  await wrongChain.click('deploy');
  await wrongChain.settle();
  const failed = wrongChain.rows('checks');
  assert.equal(failed['Public Base endpoint']?.className, 'bad');
  assert.equal(failed.Next, undefined, 'no Next when a row failed');
  assert.equal(failed.Result?.className, 'bad');

  const wrongTreasury = openPage({ treasury: `0x${'1'.repeat(40)}` });
  await wrongTreasury.connectAndConfirm();
  await wrongTreasury.click('deploy');
  await wrongTreasury.settle();
  assert.equal(wrongTreasury.rows('checks').Next, undefined);
});

const sends = (page: ReturnType<typeof openPage>) =>
  page.walletCalls.filter((call) => call.method === 'eth_sendTransaction').length;

test('one deploy per router and browser, across tabs and reloads (CCA-131)', async () => {
  const storage = new Storage();
  const locks = new Locks();
  // Two tabs, both connected and ready, before either deploys.
  let decide!: () => void;
  const walletDecides = new Promise<void>((resolve) => (decide = resolve));
  const first = openPage({ storage, locks, walletDecides });
  const second = openPage({ storage, locks });
  await first.connectAndConfirm();
  await second.connectAndConfirm();
  assert.equal(second.$('deploy').disabled, false);
  // The first tab asks MetaMask; while it waits, the second tab's click must not send.
  const firstDeploy = first.click('deploy');
  await first.settle();
  assert.match(
    storage.getItem('cc-fee-router-deploy-tx') ?? '',
    /^pending:\d+$/,
    'pending before the wallet answers',
  );
  const secondDeploy = second.click('deploy');
  decide();
  await Promise.all([firstDeploy, secondDeploy]);
  assert.equal(sends(first), 1);
  assert.equal(sends(second), 0, 'the latch is read again right before sending');
  assert.equal(storage.getItem('cc-fee-router-deploy-tx'), TX);
  // A reload (a new page on the same storage) stays blocked and says why.
  const reloaded = openPage({ storage, locks });
  await reloaded.connectAndConfirm();
  assert.equal(reloaded.$('deploy').disabled, true);
  assert.match(reloaded.$('tx').textContent, /already sent/);
  // Router 2 has its own latch.
  const router2 = openPage({ storage, locks, router: 2 });
  await router2.connectAndConfirm();
  assert.equal(router2.$('deploy').disabled, false);
});

test('an unknown wallet outcome stays blocked after a reload; only a rejection unblocks (CCA-131)', async () => {
  const unknown = new Storage();
  const failed = openPage({ storage: unknown, sendError: { message: 'request timed out' } });
  await failed.connectAndConfirm();
  await failed.click('deploy');
  assert.match(unknown.getItem('cc-fee-router-deploy-tx') ?? '', /^pending:/);
  const reloaded = openPage({ storage: unknown });
  await reloaded.connectAndConfirm();
  assert.equal(reloaded.$('deploy').disabled, true);
  assert.match(reloaded.$('tx').textContent, /outcome is unknown/);
  await reloaded.click('deploy');
  assert.equal(sends(reloaded), 0);

  const rejected = new Storage();
  const declined = openPage({
    storage: rejected,
    sendError: { code: 4001, message: 'User rejected' },
  });
  await declined.connectAndConfirm();
  await declined.click('deploy');
  assert.equal(rejected.getItem('cc-fee-router-deploy-tx'), null, 'nothing was sent');
  assert.equal(declined.$('deploy').disabled, false, 'a new attempt is allowed');
});

test('without working storage the page sends nothing (CCA-131)', async () => {
  const storage = new Storage();
  const page = openPage({ storage });
  await page.connectAndConfirm();
  storage.broken = true;
  await page.click('deploy');
  assert.equal(sends(page), 0);
  assert.match(page.$('tx').textContent, /cannot record the deploy/);
});

test('without Web Locks the page fails closed: zero wallet sends, from one tab or two (CCA-131)', async () => {
  // Two tabs on one origin in a browser without navigator.locks, both connected and ready.
  const storage = new Storage();
  const first = openPage({ storage, noLocks: true });
  const second = openPage({ storage, noLocks: true });
  await first.connectAndConfirm();
  await second.connectAndConfirm();
  for (const page of [first, second]) {
    assert.equal(page.$('deploy').disabled, true, 'Deploy stays disabled without Web Locks');
    assert.match(page.$('tx').textContent, /does not support Web Locks/);
  }
  // Clicks (also a forced click on the disabled button, concurrently in both tabs) send nothing.
  await Promise.all([first.click('deploy'), second.click('deploy')]);
  await first.click('deploy');
  await first.settle();
  assert.equal(sends(first), 0);
  assert.equal(sends(second), 0);
  assert.equal(storage.getItem('cc-fee-router-deploy-tx'), null, 'no pending marker either');
  assert.match(first.$('tx').textContent, /nothing will be sent/);
  // Every router alike.
  for (const router of [2, 3] as const) {
    const page = openPage({ router, noLocks: true });
    await page.connectAndConfirm();
    await page.click('deploy');
    assert.equal(sends(page), 0, `router ${router}`);
  }
});

test('the kit server answers under one host name only (CCA-131)', () => {
  const server = read('scripts/protocol/serve-deploy-kit.mjs');
  assert.match(server, /const HOST = '127\.0\.0\.1:8790';/);
  assert.match(server, /if \(req\.headers\.host !== HOST\)/);
  assert.doesNotMatch(server, /localhost:8790/);
  assert.match(server, /'\/guard\.js': \['guard\.js'/);
});

test("the read-back requires the kit's runtime code with USDC and this treasury (CCA-132)", async () => {
  const { deployed } = runtimeOf('router.json', USDC, TREASURY);
  const good = openPage({ code: deployed });
  await good.connectAndConfirm();
  await good.click('deploy');
  const rows = good.rows('checks');
  assert.equal(rows['Runtime code']?.className, 'ok', rows['Runtime code']?.text);
  assert.ok(rows.Next);
  // Any other code with the same five getters is refused: one changed byte, another treasury in
  // the immutables, another contract's code.
  const flipped =
    deployed.slice(0, 200) + (deployed[200] === '0' ? '1' : '0') + deployed.slice(201);
  const other = runtimeOf('router.json', USDC, `0x${'2'.repeat(40)}`).deployed;
  for (const code of [
    flipped,
    other,
    runtimeOf('router2.json', USDC, TREASURY).deployed,
    '0x6080',
  ]) {
    const page = openPage({ code });
    await page.connectAndConfirm();
    await page.click('deploy');
    const checks = page.rows('checks');
    assert.equal(checks['Runtime code']?.className, 'bad');
    assert.equal(checks.Next, undefined);
  }
  // Routers 2 and 3 likewise.
  for (const [router, file] of [
    [2, 'router2.json'],
    [3, 'router3.json'],
  ] as const) {
    const page = openPage({ router, code: runtimeOf(file, USDC, TREASURY).deployed });
    await page.connectAndConfirm();
    await page.click('deploy');
    assert.equal(page.rows('checks')['Runtime code']?.className, 'ok', file);
  }
});

test('the Sepolia deploy script compares the runtime code instead of only printing its hash (CCA-132)', () => {
  const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const { runtime, deployed, ranges } = runtimeOf('router.json', SEPOLIA_USDC, TREASURY);
  assert.deepEqual(
    maskedRuntimeMatches(deployed as `0x${string}`, runtime as `0x${string}`, ranges, [
      SEPOLIA_USDC,
      TREASURY,
    ]).ok,
    true,
  );
  const tampered = `${deployed.slice(0, -2)}00` as `0x${string}`;
  assert.equal(
    maskedRuntimeMatches(tampered, runtime as `0x${string}`, ranges, [SEPOLIA_USDC, TREASURY]).ok,
    deployed.endsWith('00'),
  );
  assert.equal(
    maskedRuntimeMatches(deployed as `0x${string}`, runtime as `0x${string}`, ranges, [
      SEPOLIA_USDC,
    ]).ok,
    false,
    'another treasury in the immutables',
  );
  assert.match(read('scripts/protocol/deploy-fee-router.ts'), /if \(!runtimeCheck\.ok\)\s+throw/);
});
