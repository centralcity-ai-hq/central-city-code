import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  type Hex,
  type PublicClient,
} from 'viem';
import { BASE_MAINNET, BASE_SEPOLIA, baseNetwork, type Address } from '../shared/base/chains.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
import {
  createIdentityChainPort,
  IdentityPortError,
  type IdentitySnapshot,
} from '../server/base/chain/identity-port.js';
import type { Bundler, ChainOperationStore } from '../server/base/chain/submit.js';

// identityAt of the identity port against a simulated chain (no network): the finalized block,
// the block read again by number and the registry reads are scripted per test.

const mainnet = baseNetwork(BASE_MAINNET, { CITY_BASE_MAINNET: '1' })!;
const registry = mainnet.contracts.identityRegistry!;
const OWNER = '0x4444444444444444444444444444444444444444' as Address;
const URI = 'https://centralcity.ai/a/abc123';
const FINALIZED = 2000n;
const HASH = `0x${'bb'.repeat(32)}` as Hex;
const OTHER_HASH = `0x${'bc'.repeat(32)}` as Hex;
const SECRET_URL = 'https://rpc.example/v2/SECRETKEY123';

/** What ownerOf throws through viem for a token that does not exist at the block. */
const noToken = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      message: 'ERC721NonexistentToken(9)',
    }),
    { abi: identityRegistryAbi, functionName: 'ownerOf', args: [9n], contractAddress: registry },
  );
/** A transport failure whose message, like viem's, names the RPC URL (and with it the key). */
const transportDown = () =>
  new HttpRequestError({ url: SECRET_URL, details: `connect ECONNREFUSED ${SECRET_URL}` });

interface Scripted {
  /** The finalized block; an Error makes that read fail. */
  finalized?: { number: bigint | null; hash: Hex | null } | Error;
  /** The hash the block at FINALIZED has when it is read again by number. */
  again?: Hex | null | Error;
  owner?: Address | Error;
  tokenUri?: string | Error;
}

function scriptedChain(s: Scripted) {
  const calls: { method: string; blockTag?: string; blockNumber?: bigint }[] = [];
  const client = {
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
      calls.push({ method: 'getBlock', ...args });
      if (args.blockTag === 'finalized') {
        const block = s.finalized ?? { number: FINALIZED, hash: HASH };
        if (block instanceof Error) throw block;
        return block;
      }
      if (args.blockNumber !== undefined) {
        const hash = s.again === undefined ? HASH : s.again;
        if (hash instanceof Error) throw hash;
        return { number: args.blockNumber, hash };
      }
      throw new Error('only the finalized block or a block by number is read');
    },
    readContract: async (args: {
      address: Address;
      functionName: string;
      args: [bigint];
      blockNumber?: bigint;
    }) => {
      assert.equal(args.address, registry);
      calls.push({ method: args.functionName, blockNumber: args.blockNumber });
      const value =
        args.functionName === 'ownerOf'
          ? (s.owner ?? OWNER)
          : args.functionName === 'tokenURI'
            ? (s.tokenUri ?? URI)
            : new Error(`unexpected read ${args.functionName}`);
      if (value instanceof Error) throw value;
      return value;
    },
  } as unknown as PublicClient;
  return { client, calls };
}

/** Every store and bundler call fails the test: identityAt only reads the chain. */
const untouchable = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      throw new Error(`identityAt touched ${String(name)}`);
    },
  },
);

function portOn(client: PublicClient, network = mainnet) {
  return createIdentityChainPort({
    network,
    client,
    db: untouchable as never,
    operations: untouchable as ChainOperationStore,
    bundler: untouchable as Bundler,
    keystore: untouchable as never,
    signerOf: async () => {
      throw new Error('identityAt never needs a signer');
    },
  });
}
const ask = { chainId: BASE_MAINNET, id: 9n, blockTag: 'finalized' } as const;
const failsWith = (code: string) => (error: unknown) =>
  error instanceof IdentityPortError && error.code === code;

test('identityAt: owner and tokenURI read at the finalized block, with its number and hash', async () => {
  const { client, calls } = scriptedChain({});
  const at: IdentitySnapshot = await portOn(client).identityAt(ask);
  assert.deepEqual(at, { owner: OWNER, tokenUri: URI, blockNumber: '2000', blockHash: HASH });
  // Both reads are pinned to the finalized block's number, and the block is read again after them.
  assert.deepEqual(calls, [
    { method: 'getBlock', blockTag: 'finalized' },
    { method: 'ownerOf', blockNumber: FINALIZED },
    { method: 'tokenURI', blockNumber: FINALIZED },
    { method: 'getBlock', blockNumber: FINALIZED },
  ]);
});

test('identityAt: another network is refused before anything is read', async () => {
  const { client, calls } = scriptedChain({});
  await assert.rejects(
    portOn(client).identityAt({ ...ask, chainId: BASE_SEPOLIA }),
    failsWith('WRONG_NETWORK'),
  );
  assert.deepEqual(calls, []);
});

test('identityAt: only the finalized block tag is accepted', async () => {
  const { client, calls } = scriptedChain({});
  const port = portOn(client);
  const latest = { ...ask, blockTag: 'latest' as const };
  // @ts-expect-error the type allows only 'finalized'
  const refused = port.identityAt(latest);
  await assert.rejects(refused, failsWith('INVALID_BLOCK_TAG'));
  // Untyped callers too (JSON, a cast): every other tag is refused at runtime.
  for (const blockTag of ['safe', 'latest', 'pending', 'FINALIZED', undefined])
    await assert.rejects(
      port.identityAt({ ...ask, blockTag } as unknown as typeof ask),
      failsWith('INVALID_BLOCK_TAG'),
    );
  assert.deepEqual(calls, []);
});

test('identityAt: a finalized block without a hash or number is refused', async () => {
  for (const finalized of [
    { number: FINALIZED, hash: null },
    { number: null, hash: HASH },
  ]) {
    const { client, calls } = scriptedChain({ finalized });
    await assert.rejects(portOn(client).identityAt(ask), failsWith('BLOCK_UNKNOWN'));
    assert.equal(calls.length, 1, 'nothing is read at an unknown block');
  }
});

test('identityAt: a block whose hash changed between the reads is refused', async () => {
  for (const again of [OTHER_HASH, null]) {
    const { client } = scriptedChain({ again });
    await assert.rejects(portOn(client).identityAt(ask), failsWith('BLOCK_CHANGED'));
  }
  // The same hash in another case is the same block.
  const { client } = scriptedChain({ again: HASH.toUpperCase().replace('0X', '0x') as Hex });
  assert.equal((await portOn(client).identityAt(ask)).blockHash, HASH);
});

test('identityAt: an id that does not exist at the finalized block is NOT_FOUND', async () => {
  const { client, calls } = scriptedChain({ owner: noToken() });
  await assert.rejects(portOn(client).identityAt(ask), failsWith('NOT_FOUND'));
  // The block is still checked: a revert read from another block is not taken as "no token".
  assert.deepEqual(calls.at(-1), { method: 'getBlock', blockNumber: FINALIZED });
  const moved = scriptedChain({ owner: noToken(), again: OTHER_HASH });
  await assert.rejects(portOn(moved.client).identityAt(ask), failsWith('BLOCK_CHANGED'));
});

test('identityAt: a failed read is UNAVAILABLE and never carries the RPC URL or its key', async () => {
  for (const s of [
    { finalized: transportDown() },
    { owner: transportDown() },
    { tokenUri: transportDown() },
    { again: transportDown() },
  ] satisfies Scripted[]) {
    const { client } = scriptedChain(s);
    const error = await portOn(client)
      .identityAt(ask)
      .then(
        () => assert.fail('expected a refusal'),
        (e: unknown) => e,
      );
    assert.ok(
      failsWith('UNAVAILABLE')(error),
      JSON.stringify(s, (_k, v) => String(v)),
    );
    const e = error as Error & { cause?: unknown };
    assert.equal(e.cause, undefined, 'the RPC error is not attached');
    for (const leak of ['SECRETKEY123', 'rpc.example'])
      for (const text of [String(e.message), String(e.stack), JSON.stringify(e)])
        assert.equal(text.includes(leak), false, `${leak} leaked`);
  }
});
