import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  concat,
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  http,
  keccak256,
  multicall3Abi,
  numberToHex,
  parseAbi,
  toHex,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  basePermissionReader,
  permissionReaderFor,
} from '../server/base/chain/permission-reader.js';
import {
  createOwnerRevokePort,
  OWNER_NONCE_KEY,
  OwnerRevokeError,
} from '../server/base/chain/owner-revoke.js';
import { spendPermissionManagerAbi } from '../server/base/chain/permissions.js';
import {
  agentWalletRecipe,
  createAccountCall,
  deriveAddressLocal,
} from '../server/base/chain/derive.js';
import { toRpc } from '../server/base/chain/rpc-bundler.js';
import {
  nonceLaneFor,
  type Bundler,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA, MULTICALL3 } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID as CHAIN_ID } from '../shared/base/wallet-network.js';
import type { SpendPermission } from '../shared/base/types.js';
import {
  LIMIT_PERMISSION_END,
  checkRevokeOperation,
  revokeCall,
  spendPermissionHash,
} from '../shared/base/spend-limits.js';
import { OTHER_EXPECTED, WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';

/** The wallet network (shared/base/wallet-network.ts): Base Sepolia or Base. */
const NETWORK = WALLET_NET;
const SPM = NETWORK.contracts.spendPermissionManager;
const ENTRY_POINT = NETWORK.contracts.entryPointV06;
const START = 1_791_676_800; // Sun 11 Oct 2026, 00:00 Berlin
const PAYMASTER = getAddress(`0x${'7a'.repeat(20)}`);
/**
 * The synthetic allowlist the port gets here, on the wallet network, in place of the pinned one
 * (production pins one paymaster on Base and none on Base Sepolia).
 */
const SPONSORS = { [CHAIN_ID]: [PAYMASTER] };
/**
 * How far below the head a block is settled on the stand-in, on either network: Base Sepolia's
 * confirmations, and the block it answers for Base's 'finalized' tag.
 */
const SETTLE_DEPTH = 3;
/** The cost cap the revoke port gets unless a test sets one: Base never runs owner operations without. */
const FEE_BUDGET = 10n ** 18n;
type SponsorAnswer = 'pinned' | 'token' | 'foreign';
/** paymasterAndData in the pinned verifying paymaster's layout (shared/base/paymasters.ts). */
function sponsorData(answer: SponsorAnswer): Hex {
  return concat([
    answer === 'foreign' ? getAddress(`0x${'7b'.repeat(20)}`) : PAYMASTER,
    numberToHex(0, { size: 28 }),
    '0x000000',
    answer === 'token' ? NETWORK.tokens.USDC.address : zeroAddress,
    zeroAddress,
    numberToHex(0, { size: 38 }),
    `0x${'ab'.repeat(65)}`,
  ]);
}
const errors = parseAbi([
  'error BeforeSpendPermissionStart(uint48 currentTimestamp, uint48 start)',
  'error AfterSpendPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);
const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);
const factoryAbi = parseAbi([
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);

const permission = (overrides: Partial<SpendPermission> = {}): SpendPermission => ({
  account: getAddress(`0x${'1'.repeat(40)}`),
  spender: getAddress(`0x${'3'.repeat(40)}`),
  token: NETWORK.tokens.USDC.address,
  allowance: 10_000_000n,
  period: 86_400,
  start: START,
  end: LIMIT_PERMISSION_END,
  salt: 7n,
  extraData: '0x',
  ...overrides,
});

type Mode =
  'ok' | 'http500' | 'rpcError' | 'revertInside' | 'answerOutside' | 'short' | 'wrongChain';

/** A local JSON-RPC stand-in for the wallet network (no network): head, multicall, code, nonces. */
async function mockBase(t: { after: (fn: () => Promise<unknown>) => void }) {
  const state = {
    mode: 'ok' as Mode,
    head: 5_000,
    time: START + 3_600,
    code: '0x' as Hex,
    /** The sequence on a nonce lane; getNonce answers (key << 64) | seq, as the EntryPoint does. */
    seq: 0n,
    /** Assertions that failed inside the stand-in (answered with HTTP 500, checked by the tests). */
    broken: [] as unknown[],
    approved: new Set<string>(),
    revoked: new Set<string>(),
    spend: 4_000_000n,
    calls: [] as Array<{ method: string; params: unknown[] }>,
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      state.calls.push(call);
      const send = (body: unknown, status = 200) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      };
      try {
        answer(call, send);
      } catch (error) {
        state.broken.push(error);
        send({ error: 'stand-in assertion failed' }, 500);
      }
    });
  });
  const answer = (
    call: { id: number; method: string; params: unknown[] },
    send: (body: unknown, status?: number) => void,
  ) => {
    const result = (value: unknown) => send({ jsonrpc: '2.0', id: call.id, result: value });
    if (state.mode === 'http500') return send({ error: 'upstream down' }, 500);
    if (state.mode === 'rpcError')
      return send({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'internal' } });
    if (call.method === 'eth_chainId')
      return result(
        state.mode === 'wrongChain' ? OTHER_EXPECTED.chainHex : WALLET_EXPECTED.chainHex,
      );
    if (call.method === 'eth_blockNumber') return result(toHex(state.head));
    // Base's finalized block (Base Sepolia's settled block is head minus its confirmations).
    if (call.method === 'eth_getBlockByNumber' && call.params[0] === 'finalized') {
      const settled = state.head - SETTLE_DEPTH;
      return result({
        number: toHex(settled),
        hash: keccak256(toHex(`block-${settled}`)),
        parentHash: keccak256(toHex(`block-${settled - 1}`)),
        timestamp: toHex(state.time),
        transactions: [],
      });
    }
    if (call.method === 'eth_getCode') return result(state.code);
    if (call.method !== 'eth_call')
      return send({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'no' } });
    const [tx] = call.params as [{ to: string; data: Hex }];
    const to = getAddress(tx.to);
    if (to === ENTRY_POINT) {
      const { args } = decodeFunctionData({ abi: entryPointAbi, data: tx.data });
      assert.equal(args[1], OWNER_NONCE_KEY);
      return result(
        encodeFunctionResult({
          abi: entryPointAbi,
          functionName: 'getNonce',
          result: (args[1] << 64n) | state.seq,
        }),
      );
    }
    if (to === NETWORK.contracts.smartWalletFactory)
      return result(
        encodeFunctionResult({
          abi: factoryAbi,
          functionName: 'getAddress',
          result: getAddress(`0x${'e'.repeat(40)}`),
        }),
      );
    assert.equal(to, MULTICALL3);
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
    const inner = args[0] as ReadonlyArray<{
      target: string;
      allowFailure: boolean;
      callData: Hex;
    }>;
    const answers = inner.map((item) => {
      if (getAddress(item.target) === MULTICALL3) {
        assert.equal(item.allowFailure, false);
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'getCurrentBlockTimestamp',
            result: BigInt(state.time),
          }),
        };
      }
      assert.equal(getAddress(item.target), SPM);
      const decoded = decodeFunctionData({ abi: spendPermissionManagerAbi, data: item.callData });
      const p = decoded.args[0] as SpendPermission;
      const hash = spendPermissionHash(CHAIN_ID, p);
      if (decoded.functionName === 'isApproved' || decoded.functionName === 'isRevoked') {
        assert.equal(item.allowFailure, false);
        const set = decoded.functionName === 'isApproved' ? state.approved : state.revoked;
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: spendPermissionManagerAbi,
            functionName: decoded.functionName,
            result: set.has(hash),
          }),
        };
      }
      assert.equal(decoded.functionName, 'getCurrentPeriod');
      assert.equal(item.allowFailure, true);
      const inside = state.time >= p.start && state.time < p.end;
      if ((inside && state.mode !== 'revertInside') || state.mode === 'answerOutside') {
        const start = p.start + Math.floor((state.time - p.start) / p.period) * p.period;
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: spendPermissionManagerAbi,
            functionName: 'getCurrentPeriod',
            result: { start, end: start + p.period, spend: state.spend },
          }),
        };
      }
      return {
        success: false,
        returnData: encodeErrorResult({
          abi: errors,
          errorName:
            state.time < p.start ? 'BeforeSpendPermissionStart' : 'AfterSpendPermissionEnd',
          args: [state.time, state.time < p.start ? p.start : p.end],
        }),
      };
    });
    return result(
      encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: state.mode === 'short' ? answers.slice(1) : answers,
      }),
    );
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createPublicClient({
    chain: {
      id: CHAIN_ID,
      name: `${WALLET_EXPECTED.name} (local stand-in)`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    },
    transport: http(url, { retryCount: 0 }),
  }) as PublicClient;
  return { state, url, client };
}

const blockTagsOf = (calls: Array<{ method: string; params: unknown[] }>) =>
  calls.filter((call) => call.method === 'eth_call').map((call) => call.params[1] as string);

test('the reader: one aggregate3 at one pinned block, getCurrentPeriod reverts only outside', async (t) => {
  const { state, url } = await mockBase(t);
  const reader = basePermissionReader(url, NETWORK);
  const before = permission({ start: START + 86_400 });
  const active = permission();
  const ended = permission({ start: START - 10 * 86_400, end: START, salt: 9n });
  state.approved.add(spendPermissionHash(CHAIN_ID, active));
  state.revoked.add(spendPermissionHash(CHAIN_ID, ended));

  const read = await reader.read([before, active, ended]);
  assert.equal(read.blockNumber, 5_000n);
  assert.equal(read.blockTimestamp, START + 3_600);
  assert.deepEqual(read.permissions[0], {
    approved: false,
    revoked: false,
    phase: 'before_start',
    current: null,
  });
  assert.deepEqual(read.permissions[1], {
    approved: true,
    revoked: false,
    phase: 'active',
    current: { start: START, end: START + 86_400, spend: 4_000_000n },
  });
  assert.deepEqual(read.permissions[2], {
    approved: false,
    revoked: true,
    phase: 'ended',
    current: null,
  });
  // Exactly one eth_call, pinned to the head block number (never 'latest').
  assert.deepEqual(blockTagsOf(state.calls), [toHex(5_000)]);

  // Settled: 3 below head (Base Sepolia's confirmations; the stand-in's finalized block on Base).
  state.calls.length = 0;
  const settled = await reader.read([active], { settled: true });
  assert.equal(settled.blockNumber, 4_997n);
  assert.deepEqual(blockTagsOf(state.calls), [toHex(4_997)]);

  // Code at the wallet decides "deployed".
  assert.equal(await reader.deployed(active.account), false);
  state.code = '0x6080';
  assert.equal(await reader.deployed(active.account), true);
  assert.deepEqual(state.broken, []);
});

test('the reader fails whole and loud: never zeros for a broken read', async (t) => {
  const { state, url } = await mockBase(t);
  const reader = basePermissionReader(url, NETWORK);
  const active = permission();
  const before = permission({ start: START + 86_400 });
  // A revert inside start..end is not explained by the window.
  state.mode = 'revertInside';
  await assert.rejects(reader.read([active]));
  // An answer outside the window contradicts the block's own time.
  state.mode = 'answerOutside';
  await assert.rejects(reader.read([before]));
  state.mode = 'short';
  await assert.rejects(reader.read([active]));
  for (const mode of ['http500', 'rpcError'] as const) {
    state.mode = mode;
    await assert.rejects(reader.read([active]));
    await assert.rejects(reader.deployed(active.account));
  }
  // A URL for another network never answers for this one.
  state.mode = 'wrongChain';
  await assert.rejects(basePermissionReader(url, NETWORK).read([active]), /expected network/);
  state.mode = 'ok';
  assert.equal((await reader.read([active])).permissions[0].phase, 'active');
});

function memoryStore(): ChainOperationStore & { rows: Map<string, StoredOperation> } {
  const rows = new Map<string, StoredOperation>();
  return {
    rows,
    async get(key) {
      return rows.has(key) ? { ...rows.get(key)! } : null;
    },
    async insert(row) {
      if (!rows.has(row.idempotencyKey)) rows.set(row.idempotencyKey, { ...row });
      return { ...rows.get(row.idempotencyKey)! };
    },
    async update(key, patch) {
      rows.set(key, { ...rows.get(key)!, ...patch });
      return { ...rows.get(key)! };
    },
    async transition(key, from, patch) {
      const row = rows.get(key);
      if (!row || !from.includes(row.status)) return null;
      return this.update(key, patch);
    },
  };
}

/** A bundler that sponsors and estimates; it records what it was asked to send. */
function fakeBundler(options: { sponsored?: boolean; answer?: SponsorAnswer } = {}) {
  const sent: UserOperation<'0.6'>[] = [];
  const bundler: Bundler = {
    async prepare(op) {
      return {
        ...op,
        callGasLimit: 120_000n,
        verificationGasLimit: 400_000n,
        preVerificationGas: 60_000n,
        maxFeePerGas: 3_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
        paymasterAndData:
          options.sponsored === false ? '0x' : sponsorData(options.answer ?? 'pinned'),
        signature: '0x',
      };
    },
    async send(op) {
      sent.push(op);
      return getUserOperationHash({
        chainId: CHAIN_ID,
        entryPointAddress: ENTRY_POINT,
        entryPointVersion: '0.6',
        userOperation: op,
      });
    },
    async receipt() {
      return null;
    },
  };
  return { bundler, sent };
}

test('owner revoke: prepared from the wallet, signed over the raw hash, sent exactly as signed', async (t) => {
  const { state, client } = await mockBase(t);
  const owner = privateKeyToAccount(generatePrivateKey());
  const recipe = agentWalletRecipe(NETWORK, owner.address, 42n);
  const wallet = deriveAddressLocal(recipe);
  const limit = permission({ account: wallet });
  const store = memoryStore();
  const { bundler, sent } = fakeBundler();
  const port = createOwnerRevokePort({
    network: NETWORK,
    client,
    store,
    bundler,
    maxCostWeiCap: FEE_BUDGET,
    sponsors: SPONSORS,
  });
  const calls = [revokeCall(CHAIN_ID, limit)];
  state.seq = 5n;

  const prepared = await port.prepare({ wallet, recipe, calls });
  // The same owner nonce lane as every owner operation of the wallet.
  assert.equal(OWNER_NONCE_KEY, nonceLaneFor('cc.base.wallet.owner-ops.v1'));
  assert.equal(prepared.operation.nonce, (OWNER_NONCE_KEY << 64n) | 5n);
  assert.equal(prepared.deployed, false);
  // Undeployed: the operation deploys the wallet from its own recipe.
  assert.equal(
    prepared.operation.initCode,
    `${recipe.factory}${encodeFunctionData(createAccountCall(recipe)).slice(2)}`,
  );
  assert.equal(prepared.operation.signature, '0x');
  assert.equal(prepared.operation.paymasterAndData, sponsorData('pinned'));
  // The browser's check of the operation it is shown gives the same hash.
  assert.equal(
    checkRevokeOperation(CHAIN_ID, toRpc(prepared.operation), { wallet, permission: limit }),
    prepared.userOpHash,
  );

  const submit = (signature: Hex, key = 'base-wallet:limit-revoke:p-1:1') =>
    port.submit({
      idempotencyKey: key,
      intentHash: `0x${'ab'.repeat(32)}`,
      wallet,
      recipe,
      calls,
      operation: prepared.operation,
      userOpHash: prepared.userOpHash,
      owner: owner.address,
      signature,
    });
  // Another key, or the owner's key over something else: refused, nothing stored or sent.
  const stranger = privateKeyToAccount(generatePrivateKey());
  for (const signature of [
    await stranger.sign({ hash: prepared.userOpHash }),
    await owner.signMessage({ message: { raw: prepared.userOpHash } }),
  ])
    await assert.rejects(submit(signature), (error: unknown) => {
      assert.ok(error instanceof OwnerRevokeError);
      assert.equal(error.code, 'SIGNATURE_MISMATCH');
      return true;
    });
  assert.equal(store.rows.size, 0);
  assert.equal(sent.length, 0);

  const signature = await owner.sign({ hash: prepared.userOpHash });
  const stored = await submit(signature);
  assert.equal(stored.status, 'submitted');
  assert.equal(stored.userOpHash, prepared.userOpHash);
  assert.equal(stored.signer, owner.address);
  assert.equal(stored.kind, 'userop');
  assert.equal(sent.length, 1);
  // Sent exactly as prepared, with the owner's signature in the wallet's SignatureWrapper.
  const wrapped = sent[0].signature;
  for (const key of Object.keys(prepared.operation) as (keyof UserOperation<'0.6'>)[])
    if (key !== 'signature') assert.deepEqual(sent[0][key], prepared.operation[key], key);
  const [wrapper] = decodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'ownerIndex', type: 'uint8' },
          { name: 'signatureData', type: 'bytes' },
        ],
      },
    ],
    wrapped,
  );
  assert.equal(wrapper.ownerIndex, 0);
  assert.equal(wrapper.signatureData, signature);

  // The same key again reconciles the stored operation; nothing new is signed or built.
  const again = await submit(signature);
  assert.equal(again.userOpHash, prepared.userOpHash);
  assert.equal(store.rows.size, 1);
  const refreshed = await port.refresh('base-wallet:limit-revoke:p-1:1');
  assert.equal(refreshed?.userOpHash, prepared.userOpHash);
  assert.equal(await port.refresh('unknown-key'), null);
  assert.deepEqual(state.broken, []);
});

test('owner revoke: outdated nonce, no sponsorship, fee cap and a wrong recipe are refused', async (t) => {
  const { state, client } = await mockBase(t);
  const owner = privateKeyToAccount(generatePrivateKey());
  const recipe = agentWalletRecipe(NETWORK, owner.address, 43n);
  const wallet = deriveAddressLocal(recipe);
  const calls = [revokeCall(CHAIN_ID, permission({ account: wallet }))];
  const store = memoryStore();
  const { bundler, sent } = fakeBundler();
  const port = createOwnerRevokePort({
    network: NETWORK,
    client,
    store,
    bundler,
    maxCostWeiCap: FEE_BUDGET,
    sponsors: SPONSORS,
  });
  const prepared = await port.prepare({ wallet, recipe, calls });

  // Another owner operation used the nonce first: nothing is signed or sent.
  state.seq = 1n;
  await assert.rejects(
    port.submit({
      idempotencyKey: 'k-outdated',
      intentHash: `0x${'cd'.repeat(32)}`,
      wallet,
      recipe,
      calls,
      operation: prepared.operation,
      userOpHash: prepared.userOpHash,
      owner: owner.address,
      signature: await owner.sign({ hash: prepared.userOpHash }),
    }),
    (error: unknown) => error instanceof OwnerRevokeError && error.code === 'OUTDATED',
  );
  // Deployed meanwhile: the stored initCode no longer matches.
  state.seq = 0n;
  state.code = '0x6080';
  await assert.rejects(
    port.submit({
      idempotencyKey: 'k-deployed',
      intentHash: `0x${'cd'.repeat(32)}`,
      wallet,
      recipe,
      calls,
      operation: prepared.operation,
      userOpHash: prepared.userOpHash,
      owner: owner.address,
      signature: await owner.sign({ hash: prepared.userOpHash }),
    }),
    (error: unknown) => error instanceof OwnerRevokeError && error.code === 'OUTDATED',
  );
  assert.equal(sent.length, 0);

  // No sponsor, a paymaster not on the list, one set to charge the wallet in a token, or the
  // pinned list itself (the synthetic paymaster is not on it, on either network): never prepared.
  for (const [name, options, sponsors] of [
    ['unsponsored', { sponsored: false }, SPONSORS],
    ['foreign', { answer: 'foreign' }, SPONSORS],
    ['token', { answer: 'token' }, SPONSORS],
    ['the pinned list', {}, undefined],
  ] as const) {
    const refused = createOwnerRevokePort({
      network: NETWORK,
      client,
      store,
      bundler: fakeBundler(options).bundler,
      maxCostWeiCap: FEE_BUDGET,
      sponsors,
    });
    await assert.rejects(
      refused.prepare({ wallet, recipe, calls }),
      (error: unknown) => error instanceof OwnerRevokeError && error.code === 'NOT_SPONSORED',
      name,
    );
  }
  // Nor stored or sent, whatever the operation handed back says.
  for (const answer of ['foreign', 'token'] as const)
    await assert.rejects(
      port.submit({
        idempotencyKey: `k-${answer}`,
        intentHash: `0x${'ce'.repeat(32)}`,
        wallet,
        recipe,
        calls,
        operation: { ...prepared.operation, paymasterAndData: sponsorData(answer) },
        userOpHash: prepared.userOpHash,
        owner: owner.address,
        signature: await owner.sign({ hash: prepared.userOpHash }),
      }),
      (error: unknown) => error instanceof OwnerRevokeError && error.code === 'NOT_SPONSORED',
      answer,
    );
  assert.equal(sent.length, 0);
  const capped = createOwnerRevokePort({
    network: NETWORK,
    client,
    store,
    bundler,
    maxCostWeiCap: 1n,
    sponsors: SPONSORS,
  });
  await assert.rejects(
    capped.prepare({ wallet, recipe, calls }),
    (error: unknown) => error instanceof OwnerRevokeError && error.code === 'FEE_CAP',
  );
  await assert.rejects(
    port.prepare({ wallet: getAddress(`0x${'1'.repeat(40)}`), recipe, calls }),
    (error: unknown) => error instanceof OwnerRevokeError && error.code === 'WALLET_MISMATCH',
  );
  // A dead endpoint is "unavailable", with nothing from the provider in the message.
  state.mode = 'http500';
  await assert.rejects(
    port.prepare({ wallet, recipe, calls }),
    (error: unknown) =>
      error instanceof OwnerRevokeError &&
      error.code === 'UNAVAILABLE' &&
      !/127\.0\.0\.1|upstream/.test(error.message),
  );
  assert.deepEqual(state.broken, []);
});

test('owner revoke on Base needs a fee budget: without one nothing is prepared or sent', async (t) => {
  const { client } = await mockBase(t);
  const owner = privateKeyToAccount(generatePrivateKey());
  const store = memoryStore();
  const portOn = (chainId: typeof BASE_MAINNET | typeof BASE_SEPOLIA, maxCostWeiCap?: bigint) => {
    const { bundler, sent } = fakeBundler();
    const network = BASE_NETWORKS[chainId];
    const recipe = agentWalletRecipe(network, owner.address, 44n);
    const wallet = deriveAddressLocal(recipe);
    const calls = [revokeCall(chainId, permission({ account: wallet }))];
    const port = createOwnerRevokePort({
      network,
      client,
      store,
      bundler,
      maxCostWeiCap,
      sponsors: { [chainId]: [PAYMASTER] },
    });
    return { port, sent, wallet, recipe, calls };
  };
  const budgetRequired = (error: unknown) =>
    error instanceof OwnerRevokeError && error.code === 'FEE_BUDGET_REQUIRED';
  const base = portOn(BASE_MAINNET);
  await assert.rejects(
    base.port.prepare({ wallet: base.wallet, recipe: base.recipe, calls: base.calls }),
    budgetRequired,
  );
  await assert.rejects(
    base.port.submit({
      idempotencyKey: 'k-unbounded',
      intentHash: `0x${'cf'.repeat(32)}`,
      wallet: base.wallet,
      recipe: base.recipe,
      calls: base.calls,
      operation: {
        sender: base.wallet,
        nonce: 0n,
        initCode: '0x',
        callData: '0x',
        callGasLimit: 0n,
        verificationGasLimit: 0n,
        preVerificationGas: 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        paymasterAndData: sponsorData('pinned'),
        signature: '0x',
      },
      userOpHash: `0x${'00'.repeat(32)}`,
      owner: owner.address,
      signature: `0x${'00'.repeat(65)}`,
    }),
    budgetRequired,
  );
  assert.equal(base.sent.length, 0);
  // Base Sepolia may run without one.
  const sepolia = portOn(BASE_SEPOLIA);
  const prepared = await sepolia.port.prepare({
    wallet: sepolia.wallet,
    recipe: sepolia.recipe,
    calls: sepolia.calls,
  });
  assert.equal(prepared.operation.sender, sepolia.wallet);
});

// On an Anvil fork of Base Sepolia (throwaway, never in CI without the URL): the local hash is the
// contract's getHash, and the reader decodes the real contract.
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;
test(
  'fork: the local hash equals SpendPermissionManager.getHash',
  { skip: !ANVIL_URL },
  async () => {
    const client = createPublicClient({ transport: http(ANVIL_URL) });
    const p = permission();
    const onChain = await client.readContract({
      address: SPM,
      abi: spendPermissionManagerAbi,
      functionName: 'getHash',
      args: [p],
    });
    assert.equal(onChain, spendPermissionHash(BASE_SEPOLIA, p));
    const read = await permissionReaderFor(
      client as PublicClient,
      BASE_NETWORKS[BASE_SEPOLIA],
    ).read([permission({ start: 2 ** 40 })]);
    assert.equal(read.permissions[0].phase, 'before_start');
    assert.equal(read.permissions[0].revoked, false);
  },
);
