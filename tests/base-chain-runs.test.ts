import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork } from '../shared/base/chains.js';
import { agentWalletRecipe, deriveAddress } from '../server/base/chain/derive.js';
import { ownerTypedData, walletSignature } from '../server/base/chain/permissions.js';
import {
  runIntentHash,
  verifyRunAuthorization,
  type RunIntent,
} from '../server/base/chain/runs.js';
import { startAtLowBaseFee } from './anvil-fees.js';

const network = baseNetwork(BASE_SEPOLIA)!;
const NOW = 1_800_000_000;

function intentFor(treasury: `0x${string}`, overrides: Partial<RunIntent> = {}): RunIntent {
  return {
    workspaceId: 'ws-1',
    chainId: BASE_SEPOLIA,
    treasury,
    manifestHash: `0x${'ab'.repeat(32)}`,
    principal: [
      { token: network.tokens.USDC.address, amount: 1_000_000n },
      { token: NATIVE_ETH, amount: 10n ** 15n },
    ],
    feeCeilingWei: 10n ** 15n,
    nonce: 1n,
    notBefore: NOW - 60,
    expiry: NOW + 3600,
    ...overrides,
  };
}

const neverVerify = {
  verifyHash: async () => {
    throw new Error('signature must not be checked');
  },
} as unknown as PublicClient;
const deps = (client: PublicClient, used = false) => ({
  client,
  network,
  nonceUsed: async () => used,
  now: () => NOW,
});

test('refused before any signature check: network, tokens, amounts, window, replay', async () => {
  const t = '0x1111111111111111111111111111111111111111';
  const cases: [Partial<RunIntent>, string][] = [
    [{ chainId: 8453 }, 'WRONG_NETWORK'],
    [
      { principal: [{ token: '0x2222222222222222222222222222222222222222', amount: 1n }] },
      'TOKEN_NOT_ALLOWED',
    ],
    [
      {
        principal: [
          { token: NATIVE_ETH, amount: 1n },
          { token: NATIVE_ETH, amount: 2n },
        ],
      },
      'DUPLICATE_TOKEN',
    ],
    [{ principal: [{ token: NATIVE_ETH, amount: 0n }] }, 'INVALID_AMOUNT'],
    [{ principal: [] }, 'INVALID_AMOUNT'],
    [{ feeCeilingWei: 0n }, 'INVALID_AMOUNT'],
    [{ expiry: NOW - 100 }, 'INVALID_WINDOW'],
    [{ notBefore: NOW - 10, expiry: NOW + 8 * 24 * 3600 }, 'INVALID_WINDOW'],
    [{ notBefore: NOW + 10, expiry: NOW + 100 }, 'NOT_YET_VALID'],
    [{ notBefore: NOW - 100, expiry: NOW }, 'EXPIRED'],
  ];
  for (const [overrides, reason] of cases)
    assert.deepEqual(
      await verifyRunAuthorization(deps(neverVerify), intentFor(t, overrides), '0x'),
      { ok: false, reason },
      reason,
    );
  assert.deepEqual(await verifyRunAuthorization(deps(neverVerify, true), intentFor(t), '0x'), {
    ok: false,
    reason: 'NONCE_USED',
  });
});

// Signature checks against the real Coinbase Smart Wallet on a local fork of Base Sepolia
// (read-only eth_calls; the treasury is not deployed, so ERC-6492 is exercised):
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;
test(
  'signature: the treasury owner approves exactly this intent',
  { skip: !ANVIL_URL },
  async () => {
    const client = createPublicClient({ transport: http(ANVIL_URL) });
    await startAtLowBaseFee(client);
    const owner = privateKeyToAccount(generatePrivateKey());
    const recipe = agentWalletRecipe(network, owner.address, 7n);
    const treasury = await deriveAddress(client, recipe);
    const intent = intentFor(treasury);

    const sign = async (signer = owner, signed: RunIntent = intent): Promise<Hex> =>
      walletSignature(
        await signer.signTypedData(ownerTypedData(BASE_SEPOLIA, treasury, runIntentHash(signed))),
        {
          ownerIndex: 0,
          undeployedRecipe: recipe,
        },
      );

    const good = await verifyRunAuthorization(deps(client), intent, await sign());
    assert.equal(good.ok, true);
    assert.equal(good.ok && good.intentHash, runIntentHash(intent));

    // Any change to the signed intent breaks the signature.
    for (const tampered of [
      { ...intent, feeCeilingWei: intent.feeCeilingWei + 1n },
      { ...intent, principal: [{ token: NATIVE_ETH, amount: 10n ** 18n }] },
      { ...intent, manifestHash: `0x${'cd'.repeat(32)}` as Hex },
      { ...intent, nonce: 2n },
    ])
      assert.deepEqual(await verifyRunAuthorization(deps(client), tampered, await sign()), {
        ok: false,
        reason: 'BAD_SIGNATURE',
      });

    // A different key cannot authorize for this treasury.
    const stranger = privateKeyToAccount(generatePrivateKey());
    assert.deepEqual(await verifyRunAuthorization(deps(client), intent, await sign(stranger)), {
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  },
);

test('malformed intents and unavailable dependencies never throw, they fail closed', async () => {
  const t = '0x1111111111111111111111111111111111111111';
  const ok = intentFor(t);
  const malformed: Partial<RunIntent>[] = [
    { notBefore: 1.5 },
    { expiry: Number.POSITIVE_INFINITY },
    { notBefore: -1 },
    { nonce: 2n ** 256n },
    { nonce: -1n },
    { feeCeilingWei: 2n ** 256n },
    { treasury: '0xnot-an-address' as never },
    { manifestHash: '0x1234' as never },
    { workspaceId: '' },
    { principal: [{ token: NATIVE_ETH, amount: 5 as never }] },
    { principal: 'x' as never },
  ];
  for (const overrides of malformed)
    assert.deepEqual(
      await verifyRunAuthorization(deps(neverVerify), { ...ok, ...overrides }, '0x'),
      { ok: false, reason: 'MALFORMED_INTENT' },
      JSON.stringify(overrides, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  assert.deepEqual(await verifyRunAuthorization(deps(neverVerify), ok, 'nothex' as never), {
    ok: false,
    reason: 'MALFORMED_INTENT',
  });

  // Nonce store down: refused, not thrown.
  const storeDown = {
    client: neverVerify,
    network,
    nonceUsed: async () => {
      throw new Error('db down');
    },
    now: () => NOW,
  };
  assert.deepEqual(await verifyRunAuthorization(storeDown, ok, '0x'), {
    ok: false,
    reason: 'UNAVAILABLE',
  });

  // The verification RPC must be on the run's network; a failing RPC is UNAVAILABLE.
  const otherChain = {
    getChainId: async () => 8453,
    verifyHash: async () => true,
  } as unknown as PublicClient;
  assert.deepEqual(await verifyRunAuthorization(deps(otherChain), ok, '0x'), {
    ok: false,
    reason: 'WRONG_NETWORK',
  });
  const rpcDown = {
    getChainId: async () => {
      throw new Error('rpc down');
    },
    verifyHash: async () => true,
  } as unknown as PublicClient;
  assert.deepEqual(await verifyRunAuthorization(deps(rpcDown), ok, '0x'), {
    ok: false,
    reason: 'UNAVAILABLE',
  });
});

test('the intent is copied before the first await: a caller that mutates it later changes nothing', async () => {
  const t = '0x1111111111111111111111111111111111111111' as const;
  const input = intentFor(t);
  const original = structuredClone(input);
  const hashes: Hex[] = [];
  const client = {
    getChainId: async () => BASE_SEPOLIA,
    verifyHash: async ({ hash }: { hash: Hex }) => (hashes.push(hash), true),
  } as unknown as PublicClient;
  const result = await verifyRunAuthorization(
    {
      client,
      network,
      // While the verifier awaits the nonce lookup, the caller swaps in a disallowed token and a
      // larger fee ceiling.
      nonceUsed: async () => {
        input.principal[0]!.token = '0x2222222222222222222222222222222222222222';
        input.feeCeilingWei = 10n ** 30n;
        return false;
      },
      now: () => NOW,
    },
    input,
    '0x',
  );
  assert.equal(result.ok, true);
  // The hash that was signature-checked is the hash of the intent that was validated.
  assert.deepEqual(hashes, [runIntentHash(original)]);
  assert.equal(result.ok && result.intentHash, runIntentHash(original));
  // The verified snapshot is what the caller must persist, untouched by the later mutation.
  assert.deepEqual(result.ok && result.intent, original);
});

test('an intent whose fields change on every read is checked and hashed from one reading', async () => {
  const t = '0x1111111111111111111111111111111111111111' as const;
  const base = intentFor(t);
  let reads = 0;
  // The first read is a valid principal; any later read is a disallowed token.
  const tricky = {
    ...base,
    get principal() {
      reads++;
      return reads === 1
        ? base.principal
        : [{ token: '0x2222222222222222222222222222222222222222' as const, amount: 1n }];
    },
  } as RunIntent;
  const hashes: Hex[] = [];
  const client = {
    getChainId: async () => BASE_SEPOLIA,
    verifyHash: async ({ hash }: { hash: Hex }) => (hashes.push(hash), true),
  } as unknown as PublicClient;
  const result = await verifyRunAuthorization(
    { client, network, nonceUsed: async () => false, now: () => NOW },
    tricky,
    '0x',
  );
  assert.equal(reads, 1, 'principal read exactly once');
  assert.equal(result.ok, true);
  assert.deepEqual(hashes, [runIntentHash(base)]);
});

test('a principal list or addresses that try to lie to the copy are refused or copied truthfully', async () => {
  const t = '0x1111111111111111111111111111111111111111' as const;
  const evil = '0x2222222222222222222222222222222222222222';
  const hashes: Hex[] = [];
  const client = {
    getChainId: async () => BASE_SEPOLIA,
    verifyHash: async ({ hash }: { hash: Hex }) => (hashes.push(hash), true),
  } as unknown as PublicClient;
  const verify = (intent: RunIntent) =>
    verifyRunAuthorization(
      { client, network, nonceUsed: async () => false, now: () => NOW },
      intent,
      '0x',
    );

  // An own `map` that returns a different list: the copy never calls it.
  const base = intentFor(t);
  const ownMap = Object.assign([...base.principal], {
    map: () => [{ token: evil, amount: 2n ** 200n }],
  });
  hashes.length = 0;
  const viaMap = await verify({ ...base, principal: ownMap });
  assert.equal(viaMap.ok, true);
  assert.deepEqual(hashes, [runIntentHash(base)], 'hashed what was checked');

  // An array subclass whose species constructor would swap the copied list.
  const sneaky = [...base.principal];
  Object.defineProperty(sneaky, 'constructor', {
    value: {
      [Symbol.species]: function () {
        return [{ token: evil, amount: 2n ** 200n }];
      },
    },
  });
  hashes.length = 0;
  const viaSpecies = await verify({ ...base, principal: sneaky });
  assert.equal(viaSpecies.ok, true);
  assert.deepEqual(hashes, [runIntentHash(base)]);

  // Addresses that are objects with their own toString are not addresses.
  let flips = 0;
  const shifty = {
    toString: () => (flips++ === 0 ? network.tokens.USDC.address : evil),
    toLowerCase: () => network.tokens.USDC.address.toLowerCase(),
  };
  assert.deepEqual(await verify({ ...base, principal: [{ token: shifty as never, amount: 1n }] }), {
    ok: false,
    reason: 'MALFORMED_INTENT',
  });
  assert.deepEqual(await verify({ ...base, treasury: { toString: () => t } as never }), {
    ok: false,
    reason: 'MALFORMED_INTENT',
  });

  // A sparse list never throws; it is malformed.
  const sparse = [base.principal[0]!, ,] as unknown as RunIntent['principal'];
  assert.deepEqual(await verify({ ...base, principal: sparse }), {
    ok: false,
    reason: 'MALFORMED_INTENT',
  });

  // A huge declared length is refused before anything walks the list.
  const huge = [] as unknown as RunIntent['principal'];
  huge.length = 2 ** 32 - 1;
  const started = performance.now();
  assert.deepEqual(await verify({ ...base, principal: huge }), {
    ok: false,
    reason: 'MALFORMED_INTENT',
  });
  assert.ok(performance.now() - started < 1000, 'refused at once');

  // The verified snapshot handed back cannot be changed before it is persisted.
  const good = await verify(intentFor(t));
  assert.equal(good.ok, true);
  assert.equal(good.ok && Object.isFrozen(good.intent), true);
  assert.equal(good.ok && Object.isFrozen(good.intent.principal), true);
});
