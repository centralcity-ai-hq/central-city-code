import assert from 'node:assert/strict';
import test from 'node:test';
import { concat, createPublicClient, custom, getAddress, pad, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { BASE_MAINNET, BASE_SEPOLIA, baseNetwork, NATIVE_ETH } from '../shared/base/chains.js';
import { SPONSOR_DATA_BYTES, sponsoredWithoutCharge } from '../shared/base/paymasters.js';
import { spenderAccountRecipe } from '../server/base/chain/derive.js';
import {
  encodeAccountCalls,
  nonceLaneFor,
  SubmitError,
  submitOperation,
  type ChainOperationStore,
  type SubmitDeps,
} from '../server/base/chain/submit.js';
import { createPaymentChain, PaymentChainError } from '../server/base/chain/payment-chain.js';

/*
 * Fees covered by a pinned sponsor or nothing, for operations that are not the owner's (agent
 * payments, server/base/chain/payment-chain.ts): the caller's sponsor rule is checked on the
 * prepared operation before anything is reserved, signed or stored, and on Base a payment adapter
 * without the allowlist refuses. No network: a client that answers nothing, fakes for the rest.
 */

const network = baseNetwork(BASE_SEPOLIA)!;
const SIGNER = getAddress(`0x${'5'.repeat(40)}`);
const PINNED = getAddress(`0x${'2f'.repeat(20)}`);
const SPONSORS = { [BASE_SEPOLIA]: [PINNED] };
const KEY = 'test:sponsor:1';
const calls = [{ target: getAddress(`0x${'7'.repeat(40)}`), value: 1n, data: '0x' as Hex }];

/** paymasterAndData in the pinned layout: paymaster, zero bytes, `token` at [51:71]. */
const sponsorData = (paymaster: Hex, token: Hex = `0x${'00'.repeat(20)}`): Hex =>
  concat([
    paymaster,
    pad('0x', { size: 31 }),
    token,
    pad('0x', { size: SPONSOR_DATA_BYTES - 20 - 31 - 20 }),
  ]);

async function setup() {
  const client = createPublicClient({
    transport: custom({
      request: async ({ method }) => {
        throw new Error(`no network in this test (${method})`);
      },
    }),
  });
  const recipe = spenderAccountRecipe(network, SIGNER);
  const sender = getAddress(`0x${'9'.repeat(40)}`);
  const operation = async (paymasterAndData: Hex): Promise<UserOperation<'0.6'>> => ({
    sender,
    nonce: nonceLaneFor(KEY) << 64n,
    initCode: '0x',
    callData: await encodeAccountCalls(client, calls),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
    paymasterAndData,
    signature: '0x',
  });
  const stored: string[] = [];
  let signed = 0;
  const store = {
    get: async () => null,
    insert: async (row: { idempotencyKey: string }) => {
      stored.push(row.idempotencyKey);
      throw new Error('stop after store');
    },
  } as unknown as ChainOperationStore;
  const deps = {
    network,
    client,
    store,
    bundler: {} as SubmitDeps['bundler'],
    signer: {
      address: SIGNER,
      signUserOperation: async () => {
        signed++;
        throw new Error('stop at signing');
      },
    },
  } as unknown as SubmitDeps;
  const submit = async (paymasterAndData: Hex, check?: (data: Hex) => boolean) =>
    submitOperation(deps, {
      idempotencyKey: KEY,
      intentHash: `0x${'11'.repeat(32)}`,
      kind: 'transfer',
      account: { address: sender, recipe },
      calls,
      prepared: await operation(paymasterAndData),
      ...(check ? { sponsorCheck: check } : {}),
    });
  return { submit, stored, signed: () => signed, operation, client, recipe, sender };
}

const pinned = (data: Hex) => sponsoredWithoutCharge(BASE_SEPOLIA, data, SPONSORS);

test('an operation without the pinned sponsor is refused before it is reserved, signed or stored', async () => {
  const s = await setup();
  for (const data of [
    '0x' as Hex,
    sponsorData(getAddress(`0x${'3e'.repeat(20)}`)),
    sponsorData(PINNED, getAddress(`0x${'44'.repeat(20)}`)),
    sponsorData(PINNED).slice(0, -2) as Hex,
  ]) {
    await assert.rejects(
      s.submit(data, pinned),
      (e: unknown) => e instanceof SubmitError && e.code === 'NOT_SPONSORED',
      data,
    );
  }
  assert.equal(s.signed(), 0, 'nothing signed');
  assert.deepEqual(s.stored, [], 'nothing stored');
});

test('the pinned sponsor in its exact layout goes on to signing; without a rule nothing changes', async () => {
  const s = await setup();
  await assert.rejects(s.submit(sponsorData(PINNED), pinned), /stop at signing/);
  assert.equal(s.signed(), 1);
  // Without a sponsor rule the operation is used as prepared (the local test network's prefund).
  await assert.rejects(s.submit('0x'), /stop at signing/);
  assert.equal(s.signed(), 2);
});

test('on Base, a payment adapter without the sponsor allowlist or outside its tokens refuses', async () => {
  const mainnet = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
  const intent = (token: Hex) => ({
    workspaceId: 'ws-1',
    chainId: BASE_MAINNET,
    source: { agentId: 'a' },
    to: getAddress(`0x${'1'.repeat(40)}`),
    token,
    amount: '1',
    intentHash: '0x01' as Hex,
    operationKey: 'k',
  });
  const usdc = mainnet.tokens.USDC.address;
  const noSponsors = createPaymentChain({ network: mainnet, maxCostWeiCap: 10n ** 15n } as never);
  await assert.rejects(
    noSponsors.submit(intent(usdc)),
    (e: unknown) => e instanceof PaymentChainError && e.code === 'SPONSOR_REQUIRED',
  );
  const usdcOnly = createPaymentChain({
    network: mainnet,
    maxCostWeiCap: 10n ** 15n,
    sponsors: { [BASE_MAINNET]: [PINNED] },
    tokens: [usdc],
  } as never);
  await assert.rejects(
    usdcOnly.submit(intent(NATIVE_ETH)),
    (e: unknown) => e instanceof PaymentChainError && e.code === 'TOKEN_NOT_ALLOWED',
  );
});

test('a queued operation stored under a looser rule meets the current sponsor rule at its first send', async () => {
  const s = await setup();
  const seed = async (paymasterAndData: Hex) => {
    const op = { ...(await s.operation(paymasterAndData)), signature: '0x01' as Hex };
    const row = {
      idempotencyKey: KEY,
      intentHash: `0x${'11'.repeat(32)}` as Hex,
      chainId: BASE_SEPOLIA,
      kind: 'transfer',
      sender: s.sender,
      signer: SIGNER,
      nonce: op.nonce.toString(10),
      userOpHash: `0x${'ab'.repeat(32)}` as Hex,
      signedOperation: JSON.stringify(op, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
      status: 'queued',
      txHash: null,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      maxCostWei: '1',
      submittedBlock: '1',
      errorCode: null,
    };
    const rows = new Map<string, Record<string, unknown>>([[KEY, row]]);
    let sends = 0;
    const deps = {
      network,
      client: s.client,
      store: {
        get: async (key: string) => rows.get(key) ?? null,
        transition: async (key: string, from: string[], patch: Record<string, unknown>) => {
          const current = rows.get(key);
          if (!current || !from.includes(current.status as string)) return null;
          const next = { ...current, ...patch };
          rows.set(key, next);
          return next;
        },
      },
      bundler: { send: async () => void sends++ },
      signer: { address: SIGNER, signUserOperation: async () => assert.fail('nothing is signed') },
    } as unknown as SubmitDeps;
    const result = await submitOperation(deps, {
      idempotencyKey: KEY,
      intentHash: `0x${'11'.repeat(32)}`,
      kind: 'transfer',
      account: { address: s.sender, recipe: s.recipe },
      calls,
      sponsorCheck: pinned,
      beforeBroadcast: async () => {},
    });
    return { result, sends: () => sends };
  };
  // Seeded unsponsored (or foreign-sponsored): refused before the claim, never sent.
  for (const data of ['0x' as Hex, sponsorData(getAddress(`0x${'3e'.repeat(20)}`))]) {
    const refused = await seed(data);
    assert.equal(refused.sends(), 0, 'zero bundler sends');
    assert.equal(refused.result.status, 'failed');
    assert.equal(refused.result.errorCode, 'REFUSED_BEFORE_BROADCAST');
  }
  // Seeded with the pinned sponsor: its first send goes out once.
  const sent = await seed(sponsorData(PINNED));
  assert.equal(sent.sends(), 1);
  assert.equal(sent.result.status, 'submitted');
});

test("a sponsorship prepared here and never stored or sent is given back; one stored for a resend, or the caller's own, is not", async () => {
  const s = await setup();
  // A Base that knows the account (deployed) and its next nonce, nothing else.
  const client = createPublicClient({
    transport: custom({
      request: async ({ method }) => {
        if (method === 'eth_getCode') return '0x01';
        if (method === 'eth_call') return pad('0x', { size: 32 });
        if (method === 'eth_blockNumber') return '0x10';
        throw new Error(`no network in this test (${method})`);
      },
    }),
  });
  const released: string[] = [];
  let sends = 0;
  const bundler = {
    prepare: async (op: UserOperation<'0.6'>) => ({
      ...op,
      callGasLimit: 100_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 1_000_000n,
      maxPriorityFeePerGas: 1_000n,
      paymasterAndData: sponsorData(PINNED),
    }),
    release: async (hash: Hex) => void released.push(hash.toLowerCase()),
    send: async () => {
      sends++;
      throw new Error('Base RPC down');
    },
    receipt: async () => null,
  };
  const rows = new Map<string, Record<string, unknown>>();
  /** Keys another worker stores first, between our read and our insert. */
  const raced = new Map<string, Record<string, unknown>>();
  const store = {
    get: async (key: string) => rows.get(key) ?? null,
    insert: async (row: Record<string, unknown>) => {
      const key = row.idempotencyKey as string;
      if (raced.has(key)) rows.set(key, raced.get(key)!);
      if (!rows.has(key)) rows.set(key, { ...row });
      return rows.get(key)!;
    },
    transition: async (key: string, from: string[], patch: Record<string, unknown>) => {
      const current = rows.get(key);
      if (!current || !from.includes(current.status as string)) return null;
      rows.set(key, { ...current, ...patch });
      return rows.get(key)!;
    },
    update: async (key: string, patch: Record<string, unknown>) => {
      rows.set(key, { ...rows.get(key)!, ...patch });
      return rows.get(key)!;
    },
  };
  const deps = {
    network,
    client,
    store,
    bundler,
    signer: { address: SIGNER, signUserOperation: async () => '0x01' as Hex },
  } as unknown as SubmitDeps;
  let n = 0;
  const submit = (extra: Record<string, unknown> = {}) =>
    submitOperation(deps, {
      idempotencyKey: `test:release:${++n}`,
      intentHash: `0x${'11'.repeat(32)}`,
      kind: 'transfer',
      account: { address: s.sender, recipe: s.recipe },
      calls,
      sponsorFlow: 'agentPay',
      ...extra,
    });
  const count = () => released.length;

  // Over the caller's cost cap, its own fee hold refused, or its authority check refused.
  await assert.rejects(submit({ maxCostWeiCap: 1n }), /could cost more/);
  assert.equal(count(), 1);
  await assert.rejects(
    submit({
      reserveCost: async () => {
        throw new Error('no fee budget');
      },
    }),
    /no fee budget/,
  );
  assert.equal(count(), 2);
  const refused = await submit({
    beforeBroadcast: async () => {
      throw new Error('frozen');
    },
  });
  assert.equal(refused.status, 'failed');
  assert.equal(count(), 3);
  assert.equal(released[2], (refused.userOpHash as string).toLowerCase());
  // Another worker stored its operation for the key first: ours is never stored.
  raced.set(`test:release:${n + 1}`, {
    idempotencyKey: `test:release:${n + 1}`,
    userOpHash: `0x${'cd'.repeat(32)}`,
    intentHash: `0x${'22'.repeat(32)}`,
    chainId: BASE_SEPOLIA,
    status: 'queued',
  });
  await assert.rejects(submit(), /different intent/);
  assert.equal(count(), 4);

  // Stored, and the send failed on a Base outage: it stays for its resend, nothing given back.
  const stored = await submit();
  assert.equal(stored.status, 'unknown');
  assert.equal(sends, 1);
  assert.equal(count(), 4);
  // The caller's own prepared operation (an owner's handout) is never released here.
  await assert.rejects(
    submitOperation(deps, {
      idempotencyKey: KEY,
      intentHash: `0x${'11'.repeat(32)}`,
      kind: 'transfer',
      account: { address: s.sender, recipe: s.recipe },
      calls,
      prepared: await s.operation(sponsorData(PINNED)),
      reserveCost: async () => {
        throw new Error('no fee budget');
      },
    }),
    /no fee budget/,
  );
  assert.equal(count(), 4);
});

test('registrations and hand-overs with the pinned sponsors refuse any other sponsorship, whichever bundler prepared it (CCA-138)', async () => {
  const { registerIdentities, transferIdentities } =
    await import('../server/base/chain/identity-chain.js');
  const seen: string[] = [];
  const client = createPublicClient({
    transport: custom({
      request: async ({ method, params }) => {
        seen.push(method);
        if (method === 'eth_chainId') return `0x${network.chainId.toString(16)}`;
        if (method === 'eth_getCode') return '0x6080';
        if (method === 'eth_call') {
          const data = String((params as [{ data?: string }])[0]?.data ?? '');
          // ownerOf(id) of a hand-over: the spender holds it; anything else (getNonce) is 0.
          if (data.startsWith('0x6352211e')) return pad(SENDER, { size: 32 });
          return pad('0x0', { size: 32 });
        }
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getBlockByNumber')
          return {
            number: '0x10',
            hash: `0x${'ab'.repeat(32)}`,
            timestamp: '0x1',
            baseFeePerGas: '0x1',
          };
        throw new Error(`not answered here (${method})`);
      },
    }),
  });
  const SENDER = getAddress(`0x${'9'.repeat(40)}`);
  let answer: Hex = '0x';
  let signed = 0;
  const deps = {
    network,
    client,
    store: {
      get: async () => null,
      insert: async () => {
        throw new Error('stop after store');
      },
    } as unknown as ChainOperationStore,
    bundler: {
      prepare: async (op: UserOperation<'0.6'>) => ({
        ...op,
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 1_000_000n,
        maxPriorityFeePerGas: 1_000n,
        paymasterAndData: answer,
      }),
      send: async () => {
        throw new Error('never sent here');
      },
      receipt: async () => null,
    } as unknown as SubmitDeps['bundler'],
    signer: {
      address: SIGNER,
      signUserOperation: async () => {
        signed++;
        throw new Error('stop at signing');
      },
    },
  } as unknown as SubmitDeps;
  const base = {
    intentHash: `0x${'11'.repeat(32)}` as Hex,
    spender: { address: SENDER, recipe: spenderAccountRecipe(network, SIGNER) },
    sponsors: SPONSORS,
  };
  const register = () =>
    registerIdentities(deps, { ...base, operationKey: 'reg:1', uris: ['https://x.test/a/abc'] });
  const handOver = () =>
    transferIdentities(deps, {
      ...base,
      operationKey: 'tr:1',
      transfers: [{ id: 5n, to: getAddress(`0x${'6'.repeat(40)}`) }],
    });
  for (const data of [
    '0x' as Hex,
    sponsorData(getAddress(`0x${'3e'.repeat(20)}`)),
    sponsorData(PINNED, getAddress(`0x${'44'.repeat(20)}`)),
  ]) {
    answer = data;
    for (const run of [register, handOver])
      await assert.rejects(
        run(),
        (e: unknown) => e instanceof SubmitError && e.code === 'NOT_SPONSORED',
        `${data.slice(0, 12)} ${seen.slice(-3).join(',')}`,
      );
  }
  assert.equal(signed, 0, 'nothing signed');
  answer = sponsorData(PINNED);
  for (const run of [register, handOver]) await assert.rejects(run(), /stop at signing/);
  assert.equal(signed, 2);
});
