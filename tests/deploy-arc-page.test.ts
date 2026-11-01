import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { getContractAddress, hashDomain, keccak256, toFunctionSelector, type Hex } from 'viem';

/*
 * The Arc mainnet deploy page (contracts/deploy-kit/deploy-arc.html), run against a stub DOM, a stub
 * wallet and a stub Arc that holds state: the real page script, keccak.js, guard.js and arc-guard.js,
 * no browser and no network.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('contracts/deploy-kit/deploy-arc.html');
const pageScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const libraries = [...html.matchAll(/<script src="([\w.-]+)"><\/script>/g)].map((m) =>
  read(`contracts/deploy-kit/${m[1]}`),
);
const arcKitText = read('contracts/deploy-kit/arc-mainnet.json');
const routerKitText = read('contracts/deploy-kit/router3.json');
const arcKit = JSON.parse(arcKitText);
const routerKit = JSON.parse(routerKitText);

const ARC = '0x13b2';
const OWNER = '0x1111111111111111111111111111111111111111';
const SIGNER = '0x2222222222222222222222222222222222222222';
const SUBMITTER = '0x3333333333333333333333333333333333333333';
const FACILITATOR = '0x4444444444444444444444444444444444444444';
const TREASURY = '0xaf36084a4dc0ce760a6dcfa46cf129e140c92aa9';
const USDC = '0x3600000000000000000000000000000000000000';
const ENTRY_POINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const COIN = 10n ** 18n;
const GWEI = 10n ** 9n;
const word = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (signature: string) => toFunctionSelector(signature);

const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string };

/** The two plain scripts on their own, as the page loads them. */
function kitLibraries() {
  const window: Record<string, any> = {};
  const sandbox = vm.createContext({ window });
  vm.runInContext(read('contracts/deploy-kit/keccak.js'), sandbox);
  vm.runInContext(read('contracts/deploy-kit/arc-guard.js'), sandbox);
  return { K: window.kitKeccak, G: window.arcGuard };
}

/** Router 3's runtime as deployed with Arc USDC and this treasury. */
let routerRuntimeCache: string | null = null;
function routerRuntime(): string {
  if (routerRuntimeCache) return routerRuntimeCache;
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [routerKit.sourceUnit]: { content: read(`contracts/${routerKit.sourceUnit}`) } },
        settings: {
          ...routerKit.settings,
          outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
        },
      }),
    ),
  );
  let hex: string =
    out.contracts[routerKit.sourceUnit][routerKit.contract].evm.deployedBytecode.object;
  for (const [name, ranges] of Object.entries(
    routerKit.immutables as Record<string, { start: number }[]>,
  ))
    for (const { start } of ranges)
      hex =
        hex.slice(0, start * 2) +
        word(name === 'token' ? USDC : TREASURY) +
        hex.slice(start * 2 + 64);
  routerRuntimeCache = `0x${hex}`;
  return routerRuntimeCache;
}

interface Contract {
  code: string;
  block: bigint;
  kind?: 'router' | 'paymaster';
  owner?: string;
  signer?: string;
}

/** Arc as the stub knows it: survives page reloads, as a chain does. */
class Chain {
  block = 1000n;
  baseFee = 20n * GWEI;
  contracts = new Map<string, Contract>();
  balances = new Map<string, bigint>([[OWNER, 100n * COIN]]);
  nonces = new Map<string, bigint>();
  allowed = new Set<string>();
  deposits = new Map<string, bigint>();
  receipts = new Map<string, Record<string, unknown>>();
  transactions = new Map<string, Record<string, unknown>>();
  sent: Array<Record<string, string>> = [];
  /** The next mined transaction reverts. */
  revertNext = false;
  /** Sends are accepted and never mined. */
  neverMine = false;

  apply(tx: Record<string, string>): string {
    this.sent.push(tx);
    const from = tx.from!.toLowerCase();
    const nonce = this.nonces.get(from) ?? 0n;
    this.nonces.set(from, nonce + 1n);
    const hash = keccak256(`0x${(this.sent.length + 0x1000).toString(16).padStart(8, '0')}`);
    this.transactions.set(hash, { ...tx, hash });
    if (this.neverMine) return hash;
    this.block += 1n;
    const receipt: Record<string, unknown> = {
      status: '0x1',
      blockNumber: `0x${this.block.toString(16)}`,
      contractAddress: null,
    };
    this.receipts.set(hash, receipt);
    if (this.revertNext) {
      this.revertNext = false;
      receipt.status = '0x0';
      return hash;
    }
    const value = BigInt(tx.value ?? 0);
    this.balances.set(from, (this.balances.get(from) ?? 0n) - value);
    const data = tx.data ?? '0x';
    const to = tx.to?.toLowerCase();
    if (!to) {
      const address = getContractAddress({ from: tx.from as Hex, nonce }).toLowerCase();
      if (data.startsWith(routerKit.bytecode)) {
        this.contracts.set(address, { code: routerRuntime(), block: this.block, kind: 'router' });
      } else if (data.startsWith(arcKit.paymaster.initCode)) {
        const tail = data.slice(arcKit.paymaster.initCode.length);
        this.contracts.set(address, {
          code: arcKit.paymaster.runtime,
          block: this.block,
          kind: 'paymaster',
          signer: `0x${tail.slice(24, 64)}`,
          owner: `0x${tail.slice(88, 128)}`,
        });
      }
      receipt.contractAddress = address;
    } else if (to === DEPLOYER) {
      const replay = arcKit.replays.find((r: { input: string }) => r.input === data);
      this.contracts.set(replay.address.toLowerCase(), { code: replay.runtime, block: this.block });
    } else if (to === ENTRY_POINT) {
      const account = `0x${data.slice(-40)}`;
      this.deposits.set(account, (this.deposits.get(account) ?? 0n) + value);
    } else if (data.startsWith(sel('updateBundlerAllowlist(address,bool)'))) {
      this.allowed.add(`0x${data.slice(34, 74)}`);
    } else {
      this.balances.set(to, (this.balances.get(to) ?? 0n) + value);
    }
    return hash;
  }

  rpc(method: string, params: unknown[]): unknown {
    if (method === 'eth_blockNumber') return `0x${this.block.toString(16)}`;
    if (method === 'eth_getBlockByNumber')
      return { baseFeePerGas: `0x${this.baseFee.toString(16)}` };
    if (method === 'eth_getCode') {
      const contract = this.contracts.get(String(params[0]).toLowerCase());
      if (!contract) return '0x';
      if (params[1] !== 'latest' && BigInt(params[1] as string) < contract.block) return '0x';
      return contract.code;
    }
    if (method === 'eth_getBalance')
      return `0x${(this.balances.get(String(params[0]).toLowerCase()) ?? 0n).toString(16)}`;
    if (method === 'eth_getTransactionCount')
      return `0x${(this.nonces.get(String(params[0]).toLowerCase()) ?? 0n).toString(16)}`;
    if (method === 'eth_getTransactionReceipt')
      return this.receipts.get(params[0] as string) ?? null;
    if (method === 'eth_getTransactionByHash')
      return this.transactions.get(params[0] as string) ?? null;
    if (method === 'eth_estimateGas') return '0x10000';
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      return this.call(to.toLowerCase(), data);
    }
    throw new Error(`unexpected rpc ${method}`);
  }

  private call(to: string, data: string): string {
    const num = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
    const address = (a: string) => `0x${word(a)}`;
    if (to === ENTRY_POINT) return num(this.deposits.get(`0x${data.slice(-40)}`) ?? 0n);
    const contract = this.contracts.get(to);
    if (contract?.kind === 'paymaster') {
      if (data === sel('entryPoint()')) return address(ENTRY_POINT);
      if (data === sel('owner()')) return address(contract.owner!);
      if (data === sel('verifyingSigner()')) return address(contract.signer!);
      if (data === sel('pendingVerifyingSigner()')) return num(0n);
      if (data.startsWith(sel('isBundlerAllowed(address)')))
        return num(this.allowed.has(`0x${data.slice(-40)}`) ? 1n : 0n);
    }
    if (contract?.kind === 'router') {
      if (data === sel('token()')) return address(USDC);
      if (data === sel('treasury()')) return address(TREASURY);
      if (data === sel('MAX_TOTAL()')) return num(100_000_000n);
      if (data === sel('MIN_INCLUDED()')) return num(50_000n);
      if (data === sel('FEE_BPS()')) return num(1000n);
    }
    throw new Error(`unexpected call ${to} ${data}`);
  }
}

class Element {
  children: Element[] = [];
  className = '';
  disabled = false;
  readOnly = false;
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
  chain?: Chain;
  storage?: Storage;
  locks?: Locks;
  noLocks?: boolean;
  account?: string;
  walletChain?: string;
  /** What wallet_switchEthereumChain does; default: the wallet moves to the chain asked for. */
  onSwitch?: (state: { walletChain: string }, chainId: string) => void;
  publicChain?: string;
  sendError?: { code?: number; message: string };
  walletDecides?: Promise<void>;
  arcKit?: unknown;
  routerKit?: unknown;
  search?: string;
}

function openPage(options: PageOptions = {}) {
  const chain = options.chain ?? new Chain();
  const storage = options.storage ?? new Storage();
  const elements = new Map<string, Element>();
  for (const [, id] of html.matchAll(/id="([\w-]+)"/g)) elements.set(id!, new Element(id!));
  for (const match of html.matchAll(/<input id="([\w-]+)" value="([^"]*)"/g))
    elements.get(match[1]!)!.value = match[2]!;
  const walletCalls: Array<{ method: string; params: unknown[] }> = [];
  const walletListeners: Record<string, Array<(value: unknown) => void>> = {};
  const state = { walletChain: options.walletChain ?? ARC };
  const ethereum = {
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      walletCalls.push({ method, params });
      if (method === 'eth_requestAccounts') return [options.account ?? OWNER];
      if (method === 'eth_chainId') return state.walletChain;
      if (method === 'wallet_switchEthereumChain') {
        const chainId = (params[0] as { chainId: string }).chainId;
        if (options.onSwitch) options.onSwitch(state, chainId);
        else state.walletChain = chainId;
        return null;
      }
      if (method === 'wallet_addEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        await options.walletDecides;
        if (options.sendError)
          throw Object.assign(new Error(options.sendError.message), options.sendError);
        return chain.apply(params[0] as Record<string, string>);
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
    on(type: string, listener: (value: unknown) => void) {
      (walletListeners[type] ??= []).push(listener);
    },
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url === 'arc-mainnet.json') return { json: async () => options.arcKit ?? arcKit };
    if (url === 'router3.json') return { json: async () => options.routerKit ?? routerKit };
    if (url === 'https://rpc.mainnet.arc.io') {
      const { method, params } = JSON.parse(init!.body!);
      const result =
        method === 'eth_chainId' ? (options.publicChain ?? ARC) : chain.rpc(method, params);
      return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const location = { search: options.search ?? '' };
  const window = { ethereum, localStorage: storage, location } as Record<string, unknown>;
  const sandbox = {
    window,
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: (tag: string) => new Element(tag),
    },
    localStorage: storage,
    location,
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
  const kitRows = () => {
    const list = $('kit').children;
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < list.length; i += 2) out[list[i]!.textContent] = list[i + 1]!.className;
    return out;
  };
  const kitLoaded = async () => {
    for (
      let i = 0;
      i < 500 && !kitRows()['Fee router 3 bytecode'] && !/missing/.test($('kit').textContent);
      i++
    )
      await settle();
  };
  const connect = async () => {
    await kitLoaded();
    await click('connect');
  };
  const type = (id: string, value: string) => {
    $(id).value = value;
    for (const listener of $(id).listeners.input ?? []) listener();
  };
  const go = (step: string) => click(`go-${step}`);
  const sends = () => walletCalls.filter((call) => call.method === 'eth_sendTransaction');
  return {
    $,
    chain,
    storage,
    state,
    click,
    connect,
    kitLoaded,
    kitRows,
    type,
    go,
    sends,
    settle,
    walletCalls,
    walletListeners,
  };
}

const STEPS = [
  'validator',
  'manager',
  'router',
  'paymaster',
  'allowlist',
  'deposit',
  'submitter',
  'facilitator',
];
const buttons = (page: ReturnType<typeof openPage>) =>
  STEPS.filter((step) => !page.$(`go-${step}`).disabled);

async function runUpTo(page: ReturnType<typeof openPage>, last: string) {
  await page.connect();
  page.type('signer', SIGNER);
  page.type('submitter', SUBMITTER);
  page.type('facilitator', FACILITATOR);
  for (const step of STEPS) {
    assert.deepEqual(buttons(page), [step], `${step} is the one step open`);
    await page.go(step);
    assert.match(
      page.$(`tx-${step}`).textContent,
      /^0x[0-9a-f]{64}$/,
      `${step}: ${page.$(`st-${step}`).textContent}`,
    );
    if (step === last) return;
  }
}

test('any chain but 5042 is refused, with no override', async () => {
  for (const other of ['0x2105', '0x4cef52' /* Arc testnet */, '0x1']) {
    const stuck = openPage({ walletChain: other, onSwitch: () => undefined, search: '?testnet=1' });
    await stuck.connect();
    assert.match(stuck.$('network').textContent, /Wrong network/);
    assert.deepEqual(buttons(stuck), []);
    await stuck.go('validator');
    assert.equal(stuck.sends().length, 0);
    const moved = openPage({ walletChain: other, onSwitch: (s) => (s.walletChain = other) });
    await moved.connect();
    assert.deepEqual(buttons(moved), [], 'a wallet that says it switched and did not');
  }
  // The page takes nothing from the address bar or the kit that could name another chain.
  assert.doesNotMatch(pageScript, /location|URLSearchParams|testnet/i);
  const otherKit = openPage({ arcKit: { ...arcKit, chainId: 5042002 } });
  await otherKit.connect();
  assert.equal(otherKit.kitRows()['Kit network'], 'bad');
  assert.deepEqual(buttons(otherKit), []);

  // The public endpoint answering another chain stops everything.
  const wrongPublic = openPage({ publicChain: '0x4cef52' });
  await wrongPublic.connect();
  assert.deepEqual(buttons(wrongPublic), []);

  // A wallet that moves after connecting is out, and at send time the chain is read again.
  const page = openPage();
  await page.connect();
  assert.deepEqual(buttons(page), ['validator']);
  for (const listener of page.walletListeners.chainChanged ?? []) listener('0x2105');
  assert.deepEqual(buttons(page), []);
  await page.go('validator');
  assert.equal(page.sends().length, 0);
  const late = openPage();
  await late.connect();
  late.state.walletChain = '0x2105';
  await late.go('validator');
  assert.equal(late.sends().length, 0);
  assert.match(late.$('st-validator').textContent, /not on Arc mainnet/);
});

test('an unknown network is added to the wallet with USDC gas at 18 decimals', async () => {
  let switches = 0;
  const page = openPage({
    walletChain: '0x2105',
    onSwitch: (state, chainId) => {
      if (switches++ === 0) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
      state.walletChain = chainId;
    },
  });
  await page.connect();
  const added = page.walletCalls.find((call) => call.method === 'wallet_addEthereumChain')!;
  assert.deepEqual(JSON.parse(JSON.stringify(added.params[0])), {
    chainId: ARC,
    chainName: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.arc.io'],
    blockExplorerUrls: ['https://explorer.arc.io'],
  });
  assert.deepEqual(buttons(page), ['validator']);
});

test('the replay inputs land where they claim, and are sent exactly', async () => {
  for (const replay of arcKit.replays) {
    assert.equal(
      getContractAddress({
        opcode: 'CREATE2',
        from: DEPLOYER as Hex,
        salt: `0x${replay.input.slice(2, 66)}`,
        bytecode: `0x${replay.input.slice(66)}`,
      }).toLowerCase(),
      replay.address.toLowerCase(),
    );
    assert.equal(keccak256(replay.input), replay.inputSha);
    assert.equal(keccak256(replay.runtime), replay.runtimeSha);
  }
  const page = openPage();
  await page.connect();
  await page.go('validator');
  await page.go('manager');
  const [validator, manager] = page.sends().map((c) => c.params[0] as Record<string, string>);
  assert.equal(validator!.to!.toLowerCase(), DEPLOYER);
  assert.equal(validator!.data, arcKit.replays[0].input);
  assert.equal(manager!.to!.toLowerCase(), DEPLOYER);
  assert.equal(manager!.data, arcKit.replays[1].input);
  assert.match(page.$('addr-manager').textContent, new RegExp(arcKit.replays[1].address));
  const link = page.$('tx-manager').children[0]!;
  assert.match(link.href, /^https:\/\/explorer\.arc\.io\/tx\/0x/);
  assert.equal(
    page.$('addr-manager').children[0]!.href.split('/address/')[0],
    'https://explorer.arc.io',
  );
});

test("the manager's expected code holds Arc mainnet's chain id and domain separator", () => {
  // Its constructor binds both, so a byte-for-byte compare with Base's code would refuse a good deploy.
  const manager = arcKit.replays[1];
  const { domainSeparatorAt, chainIdAt, domain } = manager.chainWords;
  const hex: string = manager.runtime.slice(2);
  assert.equal(BigInt(`0x${hex.slice(chainIdAt * 2, chainIdAt * 2 + 64)}`), 5042n);
  assert.equal(
    `0x${hex.slice(domainSeparatorAt * 2, domainSeparatorAt * 2 + 64)}`,
    hashDomain({
      domain: { ...domain, chainId: 5042, verifyingContract: manager.address },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      },
    }),
  );
});

test("the guard's address functions agree with viem", () => {
  const { G, K } = kitLibraries();
  for (const nonce of [0, 1, 0x7f, 0x80, 0xff, 0x100, 0xffff, 70000])
    assert.equal(
      G.createAddress(OWNER, nonce, K),
      getContractAddress({ from: OWNER as Hex, nonce: BigInt(nonce) }).toLowerCase(),
      `nonce ${nonce}`,
    );
  for (const replay of arcKit.replays)
    assert.equal(G.create2Address(DEPLOYER, replay.input, K), replay.address.toLowerCase());
  assert.equal(G.isAddress('0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9', K), true);
  assert.equal(G.isAddress('0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aA9', K), false, 'checksum');
  assert.equal(G.parseUsdc('15.5'), 15_500_000_000_000_000_000n);
  for (const bad of ['', '-1', '1e3', '0x10', '1.2.3', 'abc'])
    assert.equal(G.parseUsdc(bad), null, bad);
  // The fee: over the floor always, refusing rather than lowering.
  const fee = G.fees(20n * GWEI);
  assert.equal(fee.maxFeePerGas, 30n * GWEI);
  assert.equal(fee.maxPriorityFeePerGas, 5n * GWEI);
  assert.ok(fee.maxFeePerGas > G.FEE_FLOOR);
  assert.equal(G.fees(30n * GWEI), null);
});

test('the function selectors in the page are the signatures they name', () => {
  for (const [name, signature] of [
    ['entryPoint', 'entryPoint()'],
    ['owner', 'owner()'],
    ['verifyingSigner', 'verifyingSigner()'],
    ['pendingVerifyingSigner', 'pendingVerifyingSigner()'],
    ['isBundlerAllowed', 'isBundlerAllowed(address)'],
    ['updateBundlerAllowlist', 'updateBundlerAllowlist(address,bool)'],
    ['depositTo', 'depositTo(address)'],
    ['balanceOf', 'balanceOf(address)'],
    ['token', 'token()'],
    ['treasury', 'treasury()'],
    ['MAX_TOTAL', 'MAX_TOTAL()'],
    ['MIN_INCLUDED', 'MIN_INCLUDED()'],
    ['FEE_BPS', 'FEE_BPS()'],
  ] as const)
    assert.ok(pageScript.includes(`${name}: '${toFunctionSelector(signature)}'`), signature);
});

test('every transaction names 5042 and pays over the 20 gwei floor, or nothing is sent', async () => {
  const page = openPage();
  await runUpTo(page, 'facilitator');
  assert.equal(page.sends().length, 8);
  for (const call of page.sends()) {
    const tx = call.params[0] as Record<string, string>;
    assert.equal(tx.chainId, ARC);
    assert.equal(tx.from, OWNER);
    assert.equal(BigInt(tx.maxFeePerGas!), 30n * GWEI);
    assert.equal(BigInt(tx.maxPriorityFeePerGas!), 5n * GWEI);
    assert.ok(BigInt(tx.gas!) > 0n);
  }
  const high = new Chain();
  high.baseFee = 30n * GWEI;
  const refused = openPage({ chain: high });
  await refused.connect();
  await refused.go('validator');
  assert.equal(refused.sends().length, 0);
  assert.match(refused.$('st-validator').textContent, /too close/);
  assert.equal(refused.storage.getItem('cc-arc-5042-validator'), null, 'nothing is latched');
  // Too little money, and a dry run that wants too much gas, refuse before the wallet.
  const poor = new Chain();
  poor.balances.set(OWNER, 1000n);
  const noMoney = openPage({ chain: poor });
  await noMoney.connect();
  await noMoney.go('validator');
  assert.equal(noMoney.sends().length, 0);
  assert.match(noMoney.$('st-validator').textContent, /needs .* USDC/);
  const heavy = new Chain();
  const rpc = heavy.rpc.bind(heavy);
  heavy.rpc = (method, params) => (method === 'eth_estimateGas' ? '0x4c4b40' : rpc(method, params));
  const noGas = openPage({ chain: heavy });
  await noGas.connect();
  await noGas.go('validator');
  assert.equal(noGas.sends().length, 0);
});

test('a tampered kit is refused: every step stays shut', async () => {
  const flip = (hex: string, at = 200) =>
    hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
  const withReplay = (at: number, patch: Record<string, unknown>) => ({
    ...arcKit,
    replays: arcKit.replays.map((r: object, i: number) => (i === at ? { ...r, ...patch } : r)),
  });
  const tampered: Array<[string, Partial<PageOptions>, string]> = [
    [
      'validator input',
      { arcKit: withReplay(0, { input: flip(arcKit.replays[0].input) }) },
      'PublicERC6492Validator input',
    ],
    [
      'manager input',
      { arcKit: withReplay(1, { input: flip(arcKit.replays[1].input) }) },
      'SpendPermissionManager input',
    ],
    [
      'manager salt',
      { arcKit: withReplay(1, { input: flip(arcKit.replays[1].input, 10) }) },
      'SpendPermissionManager address',
    ],
    [
      'claimed address',
      { arcKit: withReplay(0, { address: SIGNER }) },
      'PublicERC6492Validator address',
    ],
    [
      'recorded hash alongside the input',
      {
        arcKit: withReplay(0, {
          input: flip(arcKit.replays[0].input),
          inputSha: keccak256(flip(arcKit.replays[0].input) as Hex),
        }),
      },
      'PublicERC6492Validator input',
    ],
    [
      'expected code',
      { arcKit: withReplay(1, { runtime: flip(arcKit.replays[1].runtime) }) },
      'SpendPermissionManager code',
    ],
    [
      'paymaster init code',
      {
        arcKit: {
          ...arcKit,
          paymaster: { ...arcKit.paymaster, initCode: flip(arcKit.paymaster.initCode) },
        },
      },
      'VerifyingPaymaster init code',
    ],
    [
      'paymaster code',
      {
        arcKit: {
          ...arcKit,
          paymaster: { ...arcKit.paymaster, runtime: flip(arcKit.paymaster.runtime) },
        },
      },
      'VerifyingPaymaster code',
    ],
    [
      'router bytecode',
      { routerKit: { ...routerKit, bytecode: flip(routerKit.bytecode) } },
      'Fee router 3 bytecode',
    ],
    [
      'router hash',
      {
        routerKit: {
          ...routerKit,
          bytecode: flip(routerKit.bytecode),
          bytecodeSha: keccak256(flip(routerKit.bytecode) as Hex),
        },
      },
      'Fee router 3 bytecode',
    ],
  ];
  for (const [what, options, row] of tampered) {
    const page = openPage(options);
    await page.connect();
    assert.equal(page.kitRows()[row], 'bad', what);
    assert.deepEqual(buttons(page), [], what);
    for (const step of STEPS) await page.go(step);
    assert.equal(page.sends().length, 0, what);
  }
  // The real kit passes every check.
  const good = openPage();
  await good.connect();
  assert.ok(Object.values(good.kitRows()).every((cls) => cls === 'ok'));
});

test("the page's approved hashes are the kits' own", () => {
  const { G } = kitLibraries();
  assert.equal(G.APPROVED.router.bytecodeSha, routerKit.bytecodeSha);
  assert.equal(G.APPROVED.router.runtimeMaskedSha, routerKit.runtimeMaskedSha);
  assert.equal(G.APPROVED.validator.inputSha, arcKit.replays[0].inputSha);
  assert.equal(G.APPROVED.manager.runtimeSha, arcKit.replays[1].runtimeSha);
  assert.equal(G.APPROVED.paymaster.initSha, arcKit.paymaster.initSha);
  assert.equal(G.APPROVED.paymaster.runtimeSha, arcKit.paymaster.runtimeSha);
  // Base's constructor words: only the signer and owner are ours (docs/arc/TESTNET.md).
  assert.ok(arcKit.paymaster.initCode.endsWith(word(ENTRY_POINT)));
});

test('treasury and token cannot be changed: no field, no parameter, no kit value', async () => {
  // The only inputs on the page are the named ones.
  assert.deepEqual([...html.matchAll(/<input id="([\w-]+)"/g)].map((m) => m[1]).sort(), [
    'depositAmount',
    'facilitator',
    'facilitatorAmount',
    'signer',
    'submitter',
    'submitterAmount',
  ]);
  const page = openPage({
    routerKit: { ...routerKit, usdc: SIGNER, treasury: SIGNER },
    arcKit: { ...arcKit, treasury: SIGNER, usdc: SIGNER },
    search: `?treasury=${SIGNER}&token=${SIGNER}`,
  });
  await page.connect();
  await page.go('validator');
  await page.go('manager');
  await page.go('router');
  const tx = page.sends()[2]!.params[0] as Record<string, string>;
  assert.equal(tx.to, undefined, 'a contract creation');
  assert.equal(tx.data, routerKit.bytecode + word(USDC) + word(TREASURY));
  assert.equal(page.$('st-router').className, 'ok');
  assert.match(page.$('addr-router').textContent, /^0x[0-9a-f]{40}$/);
  assert.match(html, /0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9/);
});

test('the router read-back refuses other code at the address the receipt names', async () => {
  const chain = new Chain();
  const page = openPage({ chain });
  await page.connect();
  await page.go('validator');
  await page.go('manager');
  const apply = chain.apply.bind(chain);
  chain.apply = (tx) => {
    const hash = apply(tx);
    const address = chain.receipts.get(hash)!.contractAddress as string;
    const contract = chain.contracts.get(address)!;
    contract.code = `${contract.code.slice(0, -2)}${contract.code.endsWith('00') ? '01' : '00'}`;
    return hash;
  };
  await page.go('router');
  assert.equal(page.$('st-router').className, 'bad');
  assert.match(page.$('st-router').textContent, /Do not use this contract/);
  assert.deepEqual(buttons(page), []);
});

test('the paymaster takes named addresses only, checked, and the connected account as owner', async () => {
  const page = openPage();
  await page.connect();
  await page.go('validator');
  await page.go('manager');
  await page.go('router');
  for (const [signer, submitter, why] of [
    ['', SUBMITTER, /verifying signer is not an address/],
    ['hello', SUBMITTER, /verifying signer is not an address/],
    [SIGNER, '0x1234', /submitter is not an address/],
    [SIGNER, `0x${'0'.repeat(40)}`, /submitter is not an address/],
    [`0x${'2'.repeat(41)}`, SUBMITTER, /verifying signer is not an address/],
    ['0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aA9', SUBMITTER, /verifying signer is not an address/],
    [SIGNER, SIGNER, /must not be the verifying signer/],
    [OWNER, SUBMITTER, /must not be the connected account/],
    [SIGNER, TREASURY, /must not be the treasury/],
  ] as const) {
    page.type('signer', signer);
    page.type('submitter', submitter);
    assert.equal(page.$('go-paymaster').disabled, true, `${signer} ${submitter}`);
    assert.match(page.$('st-paymaster').textContent, why);
    await page.go('paymaster');
    assert.equal(page.sends().length, 3, 'a forced click sends nothing either');
  }
  page.type('signer', SIGNER);
  page.type('submitter', SUBMITTER);
  assert.equal(page.$('go-paymaster').disabled, false);
  await page.go('paymaster');
  const tx = page.sends()[3]!.params[0] as Record<string, string>;
  assert.equal(tx.data, arcKit.paymaster.initCode + word(SIGNER) + word(OWNER));
  assert.equal(page.$('st-paymaster').className, 'ok');
  // Used inputs can't change any more.
  assert.equal(page.$('signer').readOnly, true);
  // Another account can't go on: the paymaster's owner must send the allowlist.
  const other = openPage({
    chain: page.chain,
    storage: page.storage,
    account: '0x5555555555555555555555555555555555555555',
  });
  await other.connect();
  assert.equal(other.$('st-paymaster').className, 'bad');
  assert.match(other.$('st-paymaster').textContent, /connect that account/);
  assert.deepEqual(buttons(other), []);
});

test('a deposit at or under the 10 USDC reserve is refused, and the page says why', async () => {
  const page = openPage();
  await runUpTo(page, 'allowlist');
  assert.equal(page.$('depositAmount').value, '15', 'the default');
  assert.match(html, /above 10 USDC: that is Arc's protected reserve/);
  assert.deepEqual(buttons(page), ['deposit']);
  assert.match(page.$('go-deposit').textContent, /Deposit 15 USDC/);
  for (const amount of ['2', '10', '10.0', '0', '', 'lots', '-20']) {
    page.type('depositAmount', amount);
    assert.equal(page.$('go-deposit').disabled, true, amount);
    assert.match(page.$('st-deposit').textContent, /deposit/i);
    await page.go('deposit');
    assert.equal(page.sends().length, 5, `forced click at ${amount}`);
  }
  page.type('depositAmount', '10');
  assert.match(page.$('st-deposit').textContent, /protected reserve/);
  page.type('depositAmount', '10.5');
  assert.equal(page.$('go-deposit').disabled, false, 'just above the reserve');
  page.type('depositAmount', '15');
  await page.go('deposit');
  const tx = page.sends()[5]!.params[0] as Record<string, string>;
  assert.equal(tx.to!.toLowerCase(), ENTRY_POINT);
  assert.equal(BigInt(tx.value!), 15n * COIN);
  assert.equal(tx.data!.slice(0, 10), sel('depositTo(address)'));
  assert.match(page.$('st-deposit').textContent, /holds 15 USDC/);
  assert.equal(page.$('st-deposit').className, 'ok');
});

test('funding amounts respect what the server needs and allows', async () => {
  const page = openPage();
  await runUpTo(page, 'deposit');
  page.type('submitterAmount', '0.05');
  assert.equal(page.$('go-submitter').disabled, true);
  page.type('submitterAmount', '101');
  assert.equal(page.$('go-submitter').disabled, true);
  page.type('submitterAmount', '2');
  await page.go('submitter');
  assert.equal(page.chain.balances.get(SUBMITTER), 2n * COIN);
  page.type('facilitator', 'nope');
  assert.equal(page.$('go-facilitator').disabled, true);
  page.type('facilitator', SUBMITTER);
  assert.match(page.$('st-facilitator').textContent, /must not be the submitter/);
  page.type('facilitator', FACILITATOR);
  page.type('facilitatorAmount', '1');
  assert.equal(page.$('go-facilitator').disabled, true);
  page.type('facilitatorAmount', '51');
  assert.equal(page.$('go-facilitator').disabled, true);
  page.type('facilitatorAmount', '5');
  await page.go('facilitator');
  assert.equal(page.chain.balances.get(FACILITATOR), 5n * COIN);
});

test('a full run ends with the exact settings, and never a key', async () => {
  const page = openPage();
  await runUpTo(page, 'facilitator');
  const created = page.chain.sent.findIndex((tx) => tx.data?.startsWith(routerKit.bytecode));
  const router = getContractAddress({ from: OWNER, nonce: BigInt(created) }).toLowerCase();
  const paymaster = getContractAddress({ from: OWNER, nonce: BigInt(created + 1) }).toLowerCase();
  const block = page.chain.contracts.get(router)!.block;
  assert.equal(
    page.$('settings').textContent,
    [
      `CITY_ARC_FEE_ROUTER3=${router}`,
      `CITY_ARC_FEE_ROUTER3_FROM_BLOCK=${block}`,
      `CITY_ARC_PAYMASTER=${paymaster}`,
      'CITY_ARC_RPC_URL=https://rpc.mainnet.arc.io',
    ].join('\n'),
  );
  assert.match(page.$('afterNote').textContent, /shared\/chains\.ts is a code change/);
  assert.match(page.$('afterNote').textContent, new RegExp(arcKit.replays[1].address));
  assert.doesNotMatch(page.$('settings').textContent, /KEY|SECRET|KEK/);
  // Nothing but addresses and amounts is kept.
  assert.deepEqual(Object.keys(JSON.parse(page.storage.getItem('cc-arc-5042-config')!)).sort(), [
    'depositAmount',
    'facilitator',
    'facilitatorAmount',
    'signer',
    'submitter',
    'submitterAmount',
  ]);
  assert.equal(page.chain.deposits.get(paymaster), 15n * COIN);
  assert.equal(page.chain.allowed.has(SUBMITTER), true);
});

test('no double send after a reload, at any step', async () => {
  const page = openPage();
  await runUpTo(page, 'facilitator');
  const reloaded = openPage({ chain: page.chain, storage: page.storage });
  await reloaded.connect();
  assert.deepEqual(buttons(reloaded), [], 'nothing left to send');
  for (const step of STEPS) {
    assert.equal(reloaded.$(`st-${step}`).className, 'ok', step);
    await reloaded.go(step);
  }
  assert.equal(reloaded.sends().length, 0);
  assert.match(reloaded.$('settings').textContent, /CITY_ARC_PAYMASTER=0x/);
  assert.equal(reloaded.$('signer').value, SIGNER, 'kept from the chain');

  // A send that is out and not mined stays blocked after a reload, whatever the step.
  const chain = new Chain();
  const storage = new Storage();
  const first = openPage({ chain, storage });
  await first.connect();
  await first.go('validator');
  chain.neverMine = true;
  await first.go('manager');
  assert.equal(chain.sent.length, 2);
  const again = openPage({ chain, storage });
  await again.connect();
  assert.deepEqual(buttons(again), []);
  assert.match(again.$('st-manager').textContent, /not confirmed/);
  await again.go('manager');
  assert.equal(chain.sent.length, 2);

  // Sent under the floor by a person in MetaMask: said plainly, and not offered again.
  const low = new Chain();
  low.neverMine = true;
  const lowStorage = new Storage();
  const apply = low.apply.bind(low);
  low.apply = (tx) => apply({ ...tx, maxFeePerGas: `0x${(19n * GWEI).toString(16)}` });
  const edited = openPage({ chain: low, storage: lowStorage });
  await edited.connect();
  await edited.go('validator');
  assert.match(edited.$('st-validator').textContent, /under the 20 gwei floor/);
  assert.deepEqual(buttons(edited), []);
});

test('an unknown outcome stays blocked after a reload; a rejection or a revert unblocks', async () => {
  const unknown = new Storage();
  const chain = new Chain();
  const failed = openPage({ chain, storage: unknown, sendError: { message: 'request timed out' } });
  await failed.connect();
  await failed.go('validator');
  assert.match(unknown.getItem('cc-arc-5042-validator') ?? '', /^pending:/);
  assert.match(failed.$('st-validator').textContent, /Outcome unknown/);
  const reloaded = openPage({ chain, storage: unknown });
  await reloaded.connect();
  assert.deepEqual(buttons(reloaded), []);
  assert.match(reloaded.$('st-validator').textContent, /outcome is unknown/);
  await reloaded.go('validator');
  assert.equal(reloaded.sends().length, 0);
  // It turns out it was sent: the chain settles it, with no second send.
  const replay = arcKit.replays[0];
  chain.contracts.set(replay.address.toLowerCase(), { code: replay.runtime, block: 5n });
  const settled = openPage({ chain, storage: unknown });
  await settled.connect();
  assert.equal(settled.$('st-validator').className, 'ok');
  assert.deepEqual(buttons(settled), ['manager']);

  const rejected = new Storage();
  const declined = openPage({
    storage: rejected,
    sendError: { code: 4001, message: 'User rejected' },
  });
  await declined.connect();
  await declined.go('validator');
  assert.equal(rejected.getItem('cc-arc-5042-validator'), null);
  assert.match(declined.$('st-validator').textContent, /rejected in MetaMask/);
  assert.deepEqual(buttons(declined), ['validator'], 'a new attempt is allowed');

  const reverting = new Chain();
  reverting.revertNext = true;
  const reverted = openPage({ chain: reverting });
  await reverted.connect();
  await reverted.go('validator');
  assert.equal(reverting.sent.length, 1);
  assert.match(reverted.$('st-validator').textContent, /reverted/);
  assert.deepEqual(buttons(reverted), ['validator'], 'a mined revert changed nothing');
});

test('two tabs: only one send; without storage or Web Locks, none', async () => {
  const storage = new Storage();
  const locks = new Locks();
  const chain = new Chain();
  let decide!: () => void;
  const walletDecides = new Promise<void>((resolve) => (decide = resolve));
  const first = openPage({ chain, storage, locks, walletDecides });
  const second = openPage({ chain, storage, locks });
  await first.connect();
  await second.connect();
  assert.deepEqual(buttons(second), ['validator']);
  const firstSend = first.go('validator');
  await first.settle();
  assert.match(storage.getItem('cc-arc-5042-validator') ?? '', /^pending:\d+$/);
  const secondSend = second.go('validator');
  decide();
  await Promise.all([firstSend, secondSend]);
  assert.equal(first.sends().length, 1);
  assert.equal(second.sends().length, 0);

  const noStorage = new Storage();
  const page = openPage({ storage: noStorage });
  await page.connect();
  noStorage.broken = true;
  await page.go('validator');
  assert.equal(page.sends().length, 0);
  assert.match(page.$('st-validator').textContent, /cannot record the send/);

  const noLocks = openPage({ noLocks: true });
  await noLocks.connect();
  assert.deepEqual(buttons(noLocks), []);
  assert.match(noLocks.$('notice').textContent, /does not support Web Locks/);
  await noLocks.go('validator');
  assert.equal(noLocks.sends().length, 0);
});

test("what's already deployed is skipped, read from the public endpoint, with the browser's memory gone", async () => {
  const page = openPage();
  await runUpTo(page, 'facilitator');
  // A new browser, no latches. The chain alone tells it everything is done, and where.
  const fresh = openPage({ chain: page.chain });
  await fresh.connect();
  fresh.type('submitter', SUBMITTER);
  fresh.type('facilitator', FACILITATOR);
  await fresh.click('connect');
  assert.deepEqual(buttons(fresh), []);
  assert.equal(fresh.sends().length, 0);
  assert.equal(fresh.$('signer').value, SIGNER, "the paymaster's signer, read from the chain");
  const router = /CITY_ARC_FEE_ROUTER3=(0x\w+)/.exec(fresh.$('settings').textContent)![1]!;
  assert.equal(router, /CITY_ARC_FEE_ROUTER3=(0x\w+)/.exec(page.$('settings').textContent)![1]);
  assert.match(
    fresh.$('settings').textContent,
    new RegExp(`FROM_BLOCK=${page.chain.contracts.get(router)!.block}\\n`),
    'the creation block found on the chain',
  );

  // Other code at a fixed address is a stop, not a skip.
  const foreign = new Chain();
  foreign.contracts.set(arcKit.replays[0].address.toLowerCase(), { code: '0x6080', block: 1n });
  const stopped = openPage({ chain: foreign });
  await stopped.connect();
  assert.equal(stopped.$('st-validator').className, 'bad');
  assert.match(stopped.$('st-validator').textContent, /Other code/);
  assert.deepEqual(buttons(stopped), []);

  // A failed read never counts as "not deployed".
  const broken = new Chain();
  const rpc = broken.rpc.bind(broken);
  broken.rpc = (method, params) => {
    if (method === 'eth_getCode') throw new Error('node down');
    return rpc(method, params);
  };
  const down = openPage({ chain: broken });
  await assert.rejects(async () => {
    await down.connect();
    if (down.$('st-validator').className === 'bad') throw new Error('refused');
  }, /refused/);
  assert.deepEqual(buttons(down), []);
});

test('Base stays as it was: deploy.html names nothing of Arc, and the server serves both pages', () => {
  const base = read('contracts/deploy-kit/deploy.html');
  assert.doesNotMatch(base, /arc-guard|arc-mainnet|5042|arc\.io/i);
  assert.deepEqual(
    [...base.matchAll(/<script src="([\w.-]+)"><\/script>/g)].map((m) => m[1]),
    ['keccak.js', 'guard.js'],
  );
  const guard = read('contracts/deploy-kit/guard.js');
  assert.match(guard, /const BASE = '0x2105';/);
  assert.match(guard, /const PUBLIC_RPC = 'https:\/\/mainnet\.base\.org';/);
  assert.doesNotMatch(guard, /5042|arc\.io/i);
  const server = read('scripts/protocol/serve-deploy-kit.mjs');
  assert.match(server, /const HOST = '127\.0\.0\.1:8790';/);
  assert.match(server, /'\/': \['deploy\.html'/);
  for (const file of ['deploy-arc.html', 'arc-guard.js', 'arc-mainnet.json', 'router3.json'])
    assert.ok(server.includes(`['${file}'`), file);
  // The two pages never share a latch.
  assert.doesNotMatch(html, /cc-fee-router/);
});

test("the owner's list names every setting and amount, and no person", () => {
  const doc = read('docs/arc/MAINNET_DEPLOY.md');
  for (const needed of [
    'CITY_ARC_FEE_ROUTER3',
    'CITY_ARC_FEE_ROUTER3_FROM_BLOCK',
    'CITY_ARC_PAYMASTER',
    'CITY_ARC_RPC_URL',
    'SPONSOR_PAYMASTERS',
    'CITY_ARC=1',
    'shared/chains.ts',
    '15 USDC',
    'To decide',
  ])
    assert.ok(doc.includes(needed), needed);
  assert.match(doc, /estimate/i);
});
