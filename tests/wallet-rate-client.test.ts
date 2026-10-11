import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { BASE_MAINNET, BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import {
  decodeRateCall,
  encodeRateCall,
  giveFeedbackAbi,
  isStars,
  RATE_REGISTRY,
  RATE_STARS,
  RATE_TAG,
  rateCallLayers,
  starsOf,
  starsValue,
  type RateTarget,
  type Stars,
} from '../shared/base/rate.js';
import {
  decodeOwnerCall,
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
} from '../shared/base/withdraw.js';
import { laneNonce, REPLAYABLE_NONCE_KEY } from '../shared/base/lanes.js';
import { ApiError } from '../src/api.js';
import { expectedWallet } from '../src/base/wallet/derive.js';
import { PAY_BASE_RPC } from '../src/base/wallet/pay.js';
import {
  checkRateOperation,
  checkRateTarget,
  checkRatingWindow,
  confirmRateTargetOnBase,
  createRating,
  lookupRateTarget,
  NOT_A_BASE_ID,
  NOT_A_PASSPORT,
  NOT_ITSELF,
  NOT_ON_BASE,
  NOT_SAME_AGENT,
  passportUri,
  ratingDropped,
  RATING_WINDOW_CLOSED,
  RatingWindowError,
  ratingWindowClosed,
  rateLookup,
  RateTargetError,
  rateTo,
  TYPE_BOTH,
  RatingCheckError,
  tokenUriOnBase,
  type RateSigningRequest,
  type RateSummary,
} from '../src/base/wallet/rate.js';
import {
  checkOperation,
  SIGNATURE_REFUSALS,
  WALLET_SETTING_UP,
  walletAccountIndex,
  WithdrawalCheckError,
  WithdrawalWaitError,
} from '../src/base/wallet/withdraw.js';

/*
 * The browser's check before an owner rates another agent (src/base/wallet/rate.ts and
 * shared/base/rate.ts): real operations and hashes, then every way a prepared rating could differ
 * from the one on screen. The only call a rating may be is the rater wallet's execute of the pinned
 * ReputationRegistry's giveFeedback(Base ID, stars × 20, 0, 'starred', '', '', '', 0x0…0).
 */

const NOW = 1_760_000_000_000;
const OWNER = getAddress(`0x${'7e'.repeat(20)}`);
const AGENT = '11111111-1111-4111-8111-111111111111';
// The rater's wallet as production makes it: the owner key's wallet for this agent.
const WALLET = expectedWallet(OWNER, AGENT);
const OTHER_WALLET = getAddress(`0x${'6b'.repeat(20)}`);
const ELSEWHERE = getAddress(`0x${'4d'.repeat(20)}`);
const NETWORK = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID];
const USDC = NETWORK.tokens.USDC.address;
/** The registry, literal per network (verified on Base), not read back from chains.ts. */
const REGISTRIES: Record<number, string> = {
  [BASE_MAINNET]: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  [BASE_SEPOLIA]: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
};
const REGISTRY = getAddress(REGISTRIES[WITHDRAWAL_CHAIN_ID]!);
const RATED = '99515';
/** A sponsor these tests allow on the wallet network. */
const SPONSOR = getAddress(`0x${'99'.repeat(20)}`);
const SPONSORS = { [WITHDRAWAL_CHAIN_ID]: [SPONSOR] };
/** A verifying paymaster's data: 129 bytes of fields (token at [51:71]) + a 65-byte signature. */
function sponsorData(paymaster: string = SPONSOR, token = '00'.repeat(20)): Hex {
  return `0x${paymaster.slice(2)}${'00'.repeat(31)}${token}${'00'.repeat(58)}${'ab'.repeat(65)}`;
}

// The test's own encodings, independent of the module under test.
const walletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const reputationAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex)',
]);
const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const ZERO = `0x${'00'.repeat(32)}` as Hex;

function feedback(
  fields: Partial<{
    agentId: bigint;
    value: bigint;
    decimals: number;
    tag1: string;
    tag2: string;
    endpoint: string;
    uri: string;
    hash: Hex;
  }> = {},
): Hex {
  return encodeFunctionData({
    abi: reputationAbi,
    functionName: 'giveFeedback',
    args: [
      fields.agentId ?? BigInt(RATED),
      fields.value ?? 100n,
      fields.decimals ?? 0,
      fields.tag1 ?? 'starred',
      fields.tag2 ?? '',
      fields.endpoint ?? '',
      fields.uri ?? '',
      fields.hash ?? ZERO,
    ],
  });
}
const execute = (target: string, value: bigint, data: Hex) =>
  encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [getAddress(target), value, data],
  });

function operation(
  callData: Hex,
  changes: Partial<UserOperation<'0.6'>> = {},
): UserOperation<'0.6'> {
  return {
    sender: WALLET,
    nonce: 4n,
    initCode: '0x',
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: sponsorData(),
    signature: '0x',
    ...changes,
  };
}

const mainnet = WITHDRAWAL_CHAIN_ID === BASE_MAINNET;
const SUMMARY: RateSummary = {
  kind: 'rate',
  registry: REGISTRY,
  agentId: RATED,
  value: '100',
  tag1: 'starred',
  from: WALLET,
  network: mainnet ? 'Base' : 'Base Sepolia',
  testnet: !mainnet,
  sponsored: true,
  fee: { paidBy: 'sponsor', token: 'ETH', max: { raw: '0', decimals: 18, display: '0' } },
  deploysWallet: false,
};

function prepared(
  op: UserOperation<'0.6'>,
  changes: Partial<{
    summary: Partial<RateSummary>;
    hash: Hex;
    chainId: number;
    entryPoint: string;
  }> = {},
): RateSigningRequest {
  return {
    withdrawalId: '00000000-0000-4000-8000-000000000001',
    state: 'awaiting_signature',
    userOperation: userOperationToRpc(op),
    userOpHash: changes.hash ?? ownerOperationHash(op),
    entryPoint: changes.entryPoint ?? WITHDRAWAL_ENTRY_POINT,
    chainId: changes.chainId ?? WITHDRAWAL_CHAIN_ID,
    expiresAt: NOW + 600_000,
    summary: { ...SUMMARY, ...changes.summary },
  };
}

type CheckInput = Parameters<typeof checkRateOperation>[0];
const check = (request: RateSigningRequest, changes: Partial<CheckInput> = {}) =>
  checkRateOperation({
    request,
    wallet: WALLET,
    owner: OWNER,
    agentId: AGENT,
    expected: { baseId: RATED, stars: 5 },
    sponsors: SPONSORS,
    ...changes,
  });

/**
 * decodeRateCall is two independent layers (shared/base/rate.ts): the exact bytes and the fields.
 * Each must refuse a bad call on its own, so a check removed from either one fails a test.
 */
function decodesToNothing(callData: Hex, name: string, wallet: string = WALLET) {
  assert.equal(decodeRateCall(callData, getAddress(wallet)), null, name);
  assert.equal(
    rateCallLayers.checkedRateCall(callData, getAddress(wallet)),
    null,
    `${name}: fields`,
  );
  // The bytes layer never sees the wallet: a wrong wallet is the fields layer's alone.
  if (wallet === WALLET)
    assert.equal(rateCallLayers.exactRateCall(callData), null, `${name}: bytes`);
}

/** Refused before signing: a RatingCheckError (so a WithdrawalCheckError: "Not signed: …"). */
const refused = (run: () => unknown, message: RegExp | string) =>
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RatingCheckError, `expected RatingCheckError, got ${String(error)}`);
    assert.ok(error instanceof WithdrawalCheckError);
    if (typeof message === 'string') assert.equal(error.message, message);
    else assert.match(error.message, message);
    return true;
  });

test('the giveFeedback fragment is the registry’s, and the registry is the pinned one', () => {
  // The selector the registry's implementation on Base has (0x16e0fa7f…).
  assert.equal(toFunctionSelector(giveFeedbackAbi[0]), '0x3c036a7e');
  assert.equal(toFunctionSelector(reputationAbi[0]), '0x3c036a7e');
  assert.equal(RATE_REGISTRY, REGISTRY);
  assert.equal(RATE_TAG, 'starred');
});

test('stars: 20 of 100 each, five steps, nothing in between or beyond', () => {
  assert.deepEqual([...RATE_STARS], [1, 2, 3, 4, 5]);
  for (const stars of RATE_STARS) {
    assert.equal(starsValue(stars), BigInt(stars * 20));
    assert.equal(starsOf(starsValue(stars)), stars);
  }
  for (const value of [0n, 1n, 10n, 30n, 110n, 120n, -20n, -100n, 2n ** 127n])
    assert.equal(starsOf(value), null, String(value));
  for (const stars of [0, 6, 2.5, -1, Number.NaN, '5', null, undefined]) {
    assert.equal(isStars(stars), false, String(stars));
    assert.throws(() => starsValue(stars as Stars), /1 to 5 whole stars/);
  }
});

test('every rating encodes exactly as built independently and decodes back to itself', () => {
  for (const stars of RATE_STARS) {
    const callData = encodeRateCall(BigInt(RATED), stars);
    assert.equal(callData, execute(REGISTRY, 0n, feedback({ value: BigInt(stars * 20) })));
    assert.deepEqual(decodeRateCall(callData, WALLET), { agentId: BigInt(RATED), stars });
    // Each layer reads the same rating.
    assert.deepEqual(rateCallLayers.exactRateCall(callData), { agentId: BigInt(RATED), stars });
    assert.deepEqual(rateCallLayers.checkedRateCall(callData, WALLET), {
      agentId: BigInt(RATED),
      stars,
    });
  }
  // Any Base ID a uint256 holds; never 0 or below.
  const large = 2n ** 200n + 7n;
  assert.deepEqual(decodeRateCall(encodeRateCall(large, 3), WALLET), { agentId: large, stars: 3 });
  assert.throws(() => encodeRateCall(0n, 5), /Base ID above 0/);
  assert.throws(() => encodeRateCall(-1n, 5), /Base ID above 0/);
  assert.throws(() => encodeRateCall(2n ** 256n, 5), /Base ID above 0/);
  // The case of the hex after the selector doesn't change the bytes it stands for.
  const callData = encodeRateCall(BigInt(RATED), 4);
  const shouted = `${callData.slice(0, 10)}${callData.slice(10).toUpperCase()}` as Hex;
  assert.deepEqual(decodeRateCall(shouted, WALLET), { agentId: BigInt(RATED), stars: 4 });
});

test('the rating on screen passes, and its hash is what gets signed', () => {
  for (const stars of RATE_STARS) {
    const op = operation(encodeRateCall(BigInt(RATED), stars));
    const request = prepared(op, { summary: { value: String(stars * 20) } });
    assert.equal(check(request, { expected: { baseId: RATED, stars } }), ownerOperationHash(op));
  }
  // The summary may write its whole numbers as numbers, and say the stars too.
  const op = operation(encodeRateCall(BigInt(RATED), 5));
  assert.equal(
    check(prepared(op, { summary: { agentId: Number(RATED), value: 100, stars: 5 } })),
    ownerOperationHash(op),
  );
});

test('a call that isn’t exactly that rating decodes to nothing and signs nothing', () => {
  const identity = NETWORK.contracts.identityRegistry!;
  const transfer = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [ELSEWHERE, 1_000_000n],
  });
  const usdc = withdrawalCall('USDC', ELSEWHERE, 1_000_000n);
  const cases: Record<string, Hex> = {
    // Another contract than the pinned registry, or the wallet itself.
    'the identity registry': execute(identity, 0n, feedback()),
    USDC: execute(USDC, 0n, feedback()),
    'another address': execute(ELSEWHERE, 0n, feedback()),
    'the wallet itself': execute(WALLET, 0n, feedback()),
    // Another function on the registry, a transfer, or no rating at all.
    revokeFeedback: execute(
      REGISTRY,
      0n,
      encodeFunctionData({
        abi: reputationAbi,
        functionName: 'revokeFeedback',
        args: [BigInt(RATED), 1n],
      }),
    ),
    'a transfer to the registry': execute(REGISTRY, 0n, transfer),
    'a USDC withdrawal': execute(usdc.target, usdc.value, usdc.data),
    'an ETH send to the registry': execute(REGISTRY, 1n, '0x'),
    'the no-op': execute(WALLET, 0n, '0x'),
    'no call data': '0x',
    // A value that isn't a whole number of stars, or decimals that change what it means.
    'value 0': execute(REGISTRY, 0n, feedback({ value: 0n })),
    'value 10': execute(REGISTRY, 0n, feedback({ value: 10n })),
    'value 120': execute(REGISTRY, 0n, feedback({ value: 120n })),
    'value -20': execute(REGISTRY, 0n, feedback({ value: -20n })),
    // Decimals alone: still 100, so 5 stars as expected, but 10.0 in the registry's eyes.
    'decimals 1': execute(REGISTRY, 0n, feedback({ decimals: 1 })),
    'decimals 2': execute(REGISTRY, 0n, feedback({ decimals: 2 })),
    'value 60, decimals 1': execute(REGISTRY, 0n, feedback({ value: 60n, decimals: 1 })),
    // Any tag but 'starred', anything in the fields that stay empty, a hash that isn't zero.
    'tag1 other': execute(REGISTRY, 0n, feedback({ tag1: 'other' })),
    'tag1 empty': execute(REGISTRY, 0n, feedback({ tag1: '' })),
    'tag1 Starred': execute(REGISTRY, 0n, feedback({ tag1: 'Starred' })),
    tag2: execute(REGISTRY, 0n, feedback({ tag2: 'x' })),
    endpoint: execute(REGISTRY, 0n, feedback({ endpoint: 'https://example.test/a' })),
    feedbackURI: execute(REGISTRY, 0n, feedback({ uri: 'ipfs://example' })),
    feedbackHash: execute(REGISTRY, 0n, feedback({ hash: `0x${'11'.repeat(32)}` })),
    'Base ID 0': execute(REGISTRY, 0n, feedback({ agentId: 0n })),
    // Value sent along with the rating.
    'ETH on execute': execute(REGISTRY, 1n, feedback()),
    // A batch, even of the one rating, and a rating batched with a transfer.
    'executeBatch of the rating': encodeFunctionData({
      abi: walletAbi,
      functionName: 'executeBatch',
      args: [[{ target: REGISTRY, value: 0n, data: feedback() }]],
    }),
    'executeBatch with a transfer': encodeFunctionData({
      abi: walletAbi,
      functionName: 'executeBatch',
      args: [
        [
          { target: REGISTRY, value: 0n, data: feedback() },
          { target: USDC, value: 0n, data: transfer },
        ],
      ],
    }),
    // Bytes riding along: on the inner call (the outer encoding is then canonical), or the outer.
    'a trailing byte on the inner call': execute(REGISTRY, 0n, `${feedback()}00`),
    'a trailing word on the inner call': execute(REGISTRY, 0n, `${feedback()}${'00'.repeat(32)}`),
    'a trailing word on the outer call': `${execute(REGISTRY, 0n, feedback())}${'00'.repeat(32)}`,
    // A selector viem only matches in lower case: fails closed.
    'an upper-case selector': `0x${execute(REGISTRY, 0n, feedback()).slice(2).toUpperCase()}`,
  };
  for (const [name, callData] of Object.entries(cases)) {
    decodesToNothing(callData, name);
    refused(
      () => check(prepared(operation(callData))),
      'The operation does something other than this rating.',
    );
  }
  // A perfect rating, but checked for the registry as if it were the wallet: never a rating.
  const perfect = encodeRateCall(BigInt(RATED), 5);
  decodesToNothing(perfect, 'the wallet is the registry', REGISTRY);
  assert.deepEqual(rateCallLayers.exactRateCall(perfect), { agentId: BigInt(RATED), stars: 5 });
});

/** The ABI words of encoded call data, after its selector. */
const words = (data: Hex) => data.slice(10).match(/.{64}/g)!;
const word = (n: number) => n.toString(16).padStart(64, '0');

test('hand-made encodings viem still reads as the rating are refused: only canonical bytes sign', () => {
  const inner = feedback();
  const head = words(inner);
  // giveFeedback's head: agentId, value, decimals, then the four string offsets, then the hash.
  assert.deepEqual(head.slice(3, 7), [word(0x100), word(0x140), word(0x160), word(0x180)]);
  // tag2 pointing at feedbackURI's empty string: the same values, other bytes.
  const aliased = `${inner.slice(0, 10)}${[...head.slice(0, 4), word(0x180), ...head.slice(5)].join('')}`;
  // A hidden word before tag1, every offset moved past it.
  const hidden = `${inner.slice(0, 10)}${[
    ...head.slice(0, 3),
    word(0x120),
    word(0x160),
    word(0x180),
    word(0x1a0),
    head[7],
    'ff'.repeat(32),
    ...head.slice(8),
  ].join('')}`;
  // Dirty padding: tag1's data word is 'starred' then zeros; here the zeros are 0xff.
  assert.equal(head[8], word(7));
  assert.equal(head[9], `${Buffer.from('starred').toString('hex')}${'00'.repeat(25)}`);
  const dirty = `${inner.slice(0, 10)}${[
    ...head.slice(0, 9),
    `${Buffer.from('starred').toString('hex')}${'ff'.repeat(25)}`,
    ...head.slice(10),
  ].join('')}`;
  const canonical = decodeFunctionData({ abi: reputationAbi, data: inner }).args;
  for (const [name, data] of Object.entries({ aliased, hidden, dirty }) as [string, Hex][]) {
    // viem reads exactly the rating from these bytes; only the re-encoding tells them apart.
    assert.deepEqual(decodeFunctionData({ abi: reputationAbi, data }).args, canonical, name);
    const callData = execute(REGISTRY, 0n, data);
    decodesToNothing(callData, name);
    refused(() => check(prepared(operation(callData))), /something other than this rating/);
  }
  // The outer call: its data offset moved past a hidden word.
  const outer = execute(REGISTRY, 0n, inner);
  const top = words(outer);
  assert.equal(top[2], word(0x60));
  const shifted =
    `${outer.slice(0, 10)}${[...top.slice(0, 2), word(0x80), 'ff'.repeat(32), ...top.slice(3)].join('')}` as Hex;
  // Dirty padding on the outer call: the zeros after the inner bytes in its last word are 0xff.
  const tail = top[top.length - 1]!;
  const used = ((inner.length - 2) / 2) % 32;
  assert.equal(used, 4);
  assert.equal(tail.slice(used * 2), '00'.repeat(32 - used));
  const padded =
    `${outer.slice(0, 10)}${[...top.slice(0, -1), `${tail.slice(0, used * 2)}${'ff'.repeat(32 - used)}`].join('')}` as Hex;
  for (const [name, callData] of Object.entries({ shifted, padded }) as [string, Hex][]) {
    assert.deepEqual(
      decodeFunctionData({ abi: walletAbi, data: callData }).args,
      decodeFunctionData({ abi: walletAbi, data: outer }).args,
      name,
    );
    decodesToNothing(callData, name);
    refused(() => check(prepared(operation(callData))), /something other than this rating/);
  }
});

test('another agent, or other stars, than the rating on screen signs nothing', () => {
  refused(
    () => check(prepared(operation(execute(REGISTRY, 0n, feedback({ agentId: 77n }))))),
    'The operation rates a different agent.',
  );
  refused(
    () =>
      check(prepared(operation(encodeRateCall(BigInt(RATED), 4)), { summary: { value: '80' } })),
    'The operation gives a different number of stars.',
  );
  // What the screen passes must itself be a rating.
  const good = prepared(operation(encodeRateCall(BigInt(RATED), 5)));
  for (const stars of [0, 6, 2.5, undefined])
    refused(
      () => check(good, { expected: { baseId: RATED, stars: stars as Stars } }),
      /1 to 5 whole stars/,
    );
  for (const baseId of ['0', '', '099515', ' 99515', '0x184bb'])
    refused(() => check(good, { expected: { baseId, stars: 5 } }), /has no Base ID/);
});

test('the server’s summary must say exactly what is signed; any difference signs nothing', () => {
  const op = operation(encodeRateCall(BigInt(RATED), 5));
  for (const summary of [
    { kind: 'withdraw' },
    { registry: NETWORK.contracts.identityRegistry! },
    { registry: ELSEWHERE },
    { agentId: '77' },
    { agentId: 77 },
    { agentId: '099515' },
    { value: '80' },
    { value: 80 },
    { value: '100.0' },
    { tag1: 'other' },
    { tag1: '' },
    { stars: 4 },
    { from: OTHER_WALLET },
    { network: mainnet ? 'Base Sepolia' : 'Base' },
    { testnet: mainnet },
    { sponsored: false },
    { fee: { ...SUMMARY.fee, paidBy: 'wallet' } },
    { deploysWallet: true },
  ] as Partial<RateSummary>[])
    refused(
      () => check(prepared(op, { summary })),
      'The server’s summary doesn’t match the operation.',
    );
  const missing = prepared(op);
  (missing as { summary?: unknown }).summary = undefined;
  refused(() => check(missing), /summary doesn’t match/);
});

test('the same checks as any owner operation: wallet, sponsor, hash, network, EntryPoint, form', () => {
  const callData = encodeRateCall(BigInt(RATED), 5);
  // Not from this wallet.
  refused(
    () => check(prepared(operation(callData, { sender: OTHER_WALLET }))),
    /isn’t from this agent’s wallet/,
  );
  // A perfect rating of its own from a wallet the server substituted, or another agent's wallet.
  for (const [wallet, agentId] of [
    [ELSEWHERE, AGENT],
    [expectedWallet(OWNER, '22222222-2222-4222-8222-222222222222'), AGENT],
  ] as const)
    refused(
      () =>
        check(prepared(operation(callData, { sender: wallet }), { summary: { from: wallet } }), {
          wallet,
          agentId,
        }),
      'This isn’t the wallet your wallet key makes for this agent.',
    );
  refused(() => check(prepared(operation(callData)), { owner: '' }), /wallet your wallet key/);
  refused(() => check(prepared(operation(callData)), { agentId: '' }), /wallet your wallet key/);
  refused(() => check(prepared(operation(callData)), { wallet: 'nope' }), /this agent’s wallet/);
  // No sponsor, one that would charge the wallet in a token, one not allowed, or (no list
  // passed) only the pinned sponsor counts.
  for (const paymasterAndData of [
    '0x',
    sponsorData(SPONSOR, `${'00'.repeat(19)}01`),
    sponsorData(ELSEWHERE),
    `${sponsorData()}00`,
  ] as Hex[])
    refused(
      () => check(prepared(operation(callData, { paymasterAndData }))),
      /approved sponsor; the wallet could be charged/,
    );
  refused(() => check(prepared(operation(callData)), { sponsors: undefined }), /approved sponsor/);
  // A hash that isn't the operation's.
  refused(
    () => check(prepared(operation(callData), { hash: `0x${'11'.repeat(32)}` })),
    'The operation doesn’t match its hash.',
  );
  refused(
    () => check(prepared(operation(callData), { hash: 7 as unknown as Hex })),
    /match its hash/,
  );
  // Another network, or another EntryPoint (v0.7, or not an address at all).
  refused(
    () => check(prepared(operation(callData), { chainId: mainnet ? BASE_SEPOLIA : BASE_MAINNET })),
    'This operation is for another network.',
  );
  for (const entryPoint of [NETWORK.contracts.entryPointV07, 'nope', 7 as unknown as string])
    refused(
      () => check(prepared(operation(callData), { entryPoint })),
      'This operation names another EntryPoint.',
    );
  // Not well formed: a non-canonical quantity, or a field too many.
  const sloppy = prepared(operation(callData));
  sloppy.userOperation = { ...sloppy.userOperation, nonce: '0x04' };
  refused(() => check(sloppy), 'The operation from the server isn’t well formed.');
  const extra = prepared(operation(callData));
  extra.userOperation = {
    ...extra.userOperation,
    factory: ELSEWHERE,
  } as typeof extra.userOperation;
  refused(() => check(extra), /isn’t well formed/);
  refused(() => check(undefined as unknown as RateSigningRequest), /isn’t well formed/);
});

test('a first rating may also deploy the wallet: the pinned factory, our exact owners and index', () => {
  const ATTACKER = getAddress(`0x${'12'.repeat(20)}`);
  const { smartWalletFactory: factory, spendPermissionManager: SPM } = NETWORK.contracts;
  const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
  const owner = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex;
  const initCode = (by: string, owners: string[], index = walletAccountIndex(AGENT)) =>
    `${by}${encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owners.map(owner), index] }).slice(2)}` as Hex;
  const deploying = (code: Hex) =>
    prepared(operation(encodeRateCall(BigInt(RATED), 5), { initCode: code }), {
      summary: { deploysWallet: true },
    });
  // Exactly how our wallets are made, and the summary says it deploys.
  const good = deploying(initCode(factory, [OWNER, SPM]));
  assert.equal(check(good), good.userOpHash);
  refused(
    () =>
      check(
        prepared(
          operation(encodeRateCall(BigInt(RATED), 5), { initCode: good.userOperation.initCode }),
        ),
      ),
    /summary doesn’t match/,
  );
  // Another factory; an owner added, swapped in, left out or reordered; another index.
  for (const code of [
    initCode(getAddress(`0x${'ee'.repeat(20)}`), [OWNER, SPM]),
    initCode(factory, [OWNER, SPM, ATTACKER]),
    initCode(factory, [OWNER, ATTACKER]),
    initCode(factory, [ATTACKER, SPM]),
    initCode(factory, [OWNER]),
    initCode(factory, [SPM, OWNER]),
    initCode(factory, [OWNER, SPM], walletAccountIndex('another-agent')),
    initCode(factory, [OWNER, SPM], 0n),
    `${factory}deadbeef` as Hex,
  ])
    refused(
      () => check(deploying(code)),
      'The operation would set up the wallet with other owners.',
    );
});

test('withdrawal checks keep refusing a rating, so a rating never passes as a transfer', () => {
  const callData = encodeRateCall(BigInt(RATED), 5);
  assert.equal(decodeOwnerCall(callData, WALLET), null);
  const op = operation(callData);
  const request = prepared(op);
  for (const expected of [
    { kind: 'withdraw' as const, token: 'USDC' as const, amount: 'max', to: REGISTRY },
    { kind: 'withdraw' as const, token: 'ETH' as const, amount: '0', to: REGISTRY },
  ])
    assert.throws(
      () =>
        checkOperation({
          userOperation: request.userOperation,
          userOpHash: request.userOpHash,
          entryPoint: request.entryPoint,
          chainId: request.chainId,
          wallet: WALLET,
          owner: OWNER,
          agentId: AGENT,
          sponsors: SPONSORS,
          expected,
        }),
      /does something other than a transfer/,
    );
  // Nor does a rating decode from a withdrawal.
  const usdc = withdrawalCall('USDC', REGISTRY, 100n);
  assert.equal(decodeRateCall(execute(usdc.target, usdc.value, usdc.data), WALLET), null);
});

test('a rating can’t be cancelled yet: the browser signs no cancel for it', () => {
  // The cancel the server would prepare: the wallet's own no-op at the rating's nonce. Binding a
  // cancel to a rating needs its own safety decision, so until then it fails closed.
  const rating = operation(encodeRateCall(BigInt(RATED), 5));
  const noop = operation(execute(WALLET, 0n, '0x'));
  assert.throws(
    () =>
      checkOperation({
        userOperation: userOperationToRpc(noop),
        userOpHash: ownerOperationHash(noop),
        entryPoint: WITHDRAWAL_ENTRY_POINT,
        chainId: WITHDRAWAL_CHAIN_ID,
        wallet: WALLET,
        owner: OWNER,
        agentId: AGENT,
        sponsors: SPONSORS,
        expected: {
          kind: 'noop',
          original: {
            userOperation: userOperationToRpc(rating),
            userOpHash: ownerOperationHash(rating),
          },
        },
      }),
    (error: unknown) =>
      error instanceof WithdrawalCheckError &&
      error.message === 'There is no withdrawal to cancel.',
  );
});

/*
 * Lanes (pay without waiting): with the server's `lanes: true` a rating is checked exactly as a
 * withdrawal is (withdraw.ts checkNonceLane): its nonce is laneNonce of its own withdrawalId, the
 * lane derived here; never the shared lane 0, never the replayable key 8453; no lane, no signature.
 */
const RATING_ID = '00000000-0000-4000-8000-000000000001';
const laned = (nonce: bigint, changes: { initCode?: Hex; deploys?: boolean } = {}) => ({
  ...prepared(
    operation(encodeRateCall(BigInt(RATED), 5), {
      nonce,
      ...(changes.initCode ? { initCode: changes.initCode } : {}),
    }),
    changes.deploys ? { summary: { deploysWallet: true } } : {},
  ),
  lanes: true as const,
});
const OWN_LANE = { withdrawalId: RATING_ID };

test('lanes on: a rating in exactly its own lane signs', () => {
  const request = laned(laneNonce(RATING_ID));
  assert.equal(request.withdrawalId, RATING_ID);
  assert.equal(check(request, { lane: OWN_LANE }), request.userOpHash);
});

test('lanes on: another lane, the shared lane 0, key 8453 or no lane signs nothing', () => {
  const NOT_OWN = 'This operation isn’t in its own lane.';
  const REPLAYABLE =
    'This operation uses the wallet’s replayable nonce, so it could be replayed on other networks.';
  // Another operation's lane, or its own key at a later sequence.
  refused(() => check(laned(laneNonce('another-id')), { lane: OWN_LANE }), NOT_OWN);
  refused(() => check(laned(laneNonce(RATING_ID, 1n)), { lane: OWN_LANE }), NOT_OWN);
  // The shared, sequential lane (key 0), as before lanes.
  refused(() => check(laned(4n), { lane: OWN_LANE }), NOT_OWN);
  refused(() => check(laned(0n), { lane: OWN_LANE }), NOT_OWN);
  // The replayable key, at any sequence.
  refused(() => check(laned(REPLAYABLE_NONCE_KEY << 64n), { lane: OWN_LANE }), REPLAYABLE);
  refused(() => check(laned((REPLAYABLE_NONCE_KEY << 64n) | 3n), { lane: OWN_LANE }), REPLAYABLE);
  // Lanes on but no lane to check against: nothing is signed, whatever the nonce.
  const NO_LANE = 'This operation’s lane couldn’t be checked, so nothing was signed.';
  refused(() => check(laned(laneNonce(RATING_ID))), NO_LANE);
  refused(() => check(laned(laneNonce(RATING_ID)), { lane: undefined }), NO_LANE);
  // A lane for another operation's id isn't this rating's: never taken as its lane.
  refused(
    () => check(laned(laneNonce('another-id')), { lane: { withdrawalId: 'another-id' } }),
    NO_LANE,
  );
  // An empty id has no lane at all.
  refused(
    () =>
      check({ ...laned(laneNonce(RATING_ID)), withdrawalId: '' }, { lane: { withdrawalId: '' } }),
    /lane/,
  );
});

test('lanes on: a rating that would also set the wallet up waits for another that does', () => {
  const { smartWalletFactory: factory, spendPermissionManager: SPM } = NETWORK.contracts;
  const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
  const owner = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex;
  const initCode = `${factory}${encodeFunctionData({
    abi: factoryAbi,
    functionName: 'createAccount',
    args: [[OWNER, SPM].map(owner), walletAccountIndex(AGENT)],
  }).slice(2)}` as Hex;
  const request = laned(laneNonce(RATING_ID), { initCode, deploys: true });
  assert.equal(check(request, { lane: { ...OWN_LANE, deploying: [] } }), request.userOpHash);
  assert.equal(
    check(request, { lane: { ...OWN_LANE, deploying: [RATING_ID] } }),
    request.userOpHash,
  );
  assert.throws(
    () => check(request, { lane: { ...OWN_LANE, deploying: ['another-id'] } }),
    (error: unknown) => error instanceof WithdrawalWaitError && error.message === WALLET_SETTING_UP,
  );
});

test('lanes off: the rating checks as before; only key 8453 is never signed, laned or not', () => {
  // No `lanes`, or `lanes: false`: the sequential nonce signs, and a lane given changes nothing.
  const before = prepared(operation(encodeRateCall(BigInt(RATED), 5)));
  assert.equal(before.lanes, undefined);
  assert.equal(check(before), before.userOpHash);
  assert.equal(check(before, { lane: OWN_LANE }), before.userOpHash);
  assert.equal(check({ ...before, lanes: false }), before.userOpHash);
  // A nonce in some lane passes as before too: without lanes the server's nonce is its own.
  const elsewhere = prepared(
    operation(encodeRateCall(BigInt(RATED), 5), { nonce: laneNonce('x') }),
  );
  assert.equal(check(elsewhere), elsewhere.userOpHash);
  // Without lanes no other operation's setup holds a rating up.
  assert.equal(
    check(before, { lane: { ...OWN_LANE, deploying: ['another-id'] } }),
    before.userOpHash,
  );
  // The replayable key is refused either way (as for every withdrawal).
  refused(
    () =>
      check(
        prepared(
          operation(encodeRateCall(BigInt(RATED), 5), { nonce: REPLAYABLE_NONCE_KEY << 64n }),
        ),
      ),
    /replayable nonce/,
  );
});

/*
 * The sponsorship window (with lanes on): the paymaster's validUntil must be after now and no later
 * than the server's fixed signing deadline (expiresAt), rechecked right before signing and right
 * before sending, so a rating whose sponsorship ran out is never signed, and is never sent again.
 */
const windowed = (validUntilMs: number, expiresAt = NOW + 600_000) => {
  const until = Math.floor(validUntilMs / 1000)
    .toString(16)
    .padStart(12, '0');
  const data = sponsorData();
  const paymasterAndData = `${data.slice(0, 42)}${until}${'0'.repeat(12)}${data.slice(66)}` as Hex;
  return {
    ...laned(laneNonce(RATING_ID)),
    expiresAt,
    userOperation: { ...laned(laneNonce(RATING_ID)).userOperation, paymasterAndData },
  };
};

test('lanes on: a rating whose sponsorship window closed refuses to sign', () => {
  const request = windowed(NOW + 60_000);
  // Within the window: nothing to refuse.
  assert.doesNotThrow(() => checkRatingWindow(request, NOW, SPONSORS));
  // Past the paymaster's validUntil (the rating itself not expired yet): refused, never signed.
  for (const at of [NOW + 60_000, NOW + 61_000, NOW + 600_000])
    assert.throws(
      () => checkRatingWindow(request, at, SPONSORS),
      (error: unknown) =>
        error instanceof RatingWindowError &&
        error instanceof WithdrawalCheckError &&
        error.message === RATING_WINDOW_CLOSED,
    );
  // A sponsorship past the deadline, unbounded, or with no deadline at all: refused too.
  refused(() => checkRatingWindow(windowed(NOW + 601_000), NOW, SPONSORS), RATING_WINDOW_CLOSED);
  refused(() => checkRatingWindow(windowed(0), NOW, SPONSORS), RATING_WINDOW_CLOSED);
  refused(
    () => checkRatingWindow({ ...request, expiresAt: null as unknown as number }, NOW, SPONSORS),
    RATING_WINDOW_CLOSED,
  );
  // Lanes off: no window to check (as Pay and Withdraw), whatever the clock says.
  assert.doesNotThrow(() =>
    checkRatingWindow({ ...request, lanes: false }, NOW + 61_000, SPONSORS),
  );
});

test('a closed window is definitive: refused here or 409 sponsorship_expired, nothing else', () => {
  assert.equal(ratingWindowClosed(new RatingWindowError(RATING_WINDOW_CLOSED)), true);
  assert.equal(ratingWindowClosed(new ApiError('Expired.', 409, 'sponsorship_expired')), true);
  // Other refusals (and other errors) keep their own handling.
  assert.equal(ratingWindowClosed(new RatingCheckError('Other.')), false);
  assert.equal(ratingWindowClosed(new ApiError('Busy.', 409, 'sponsor_busy')), false);
  assert.equal(ratingWindowClosed(new ApiError('Expired.', 409, 'expired')), false);
  assert.equal(ratingWindowClosed(new ApiError('Lost.', 503, 'sponsorship_expired')), false);
  assert.equal(ratingWindowClosed(new Error('sponsorship_expired')), false);
});

test('a rating refused before the server took its signature is dropped; anything unclear is kept', () => {
  assert.equal(ratingDropped(new RatingWindowError(RATING_WINDOW_CLOSED)), 'window');
  assert.equal(ratingDropped(new ApiError('Expired.', 409, 'sponsorship_expired')), 'window');
  // Its own time is up (a rating left unsigned past expires_at): never replayed under its key.
  assert.equal(ratingDropped(new ApiError('Gone.', 410, 'expired')), 'expired');
  // Every other refusal the server makes before it takes a signature: the same list as Pay's.
  for (const code of SIGNATURE_REFUSALS) {
    if (code === 'expired' || code === 'sponsorship_expired') continue;
    assert.equal(ratingDropped(new ApiError('Refused.', 409, code)), 'refused', code);
  }
  // Unclear (a 5xx, an unknown code, a lost answer) or refused here before signing: kept.
  assert.equal(ratingDropped(new ApiError('Down.', 503, 'chain_unavailable')), null);
  assert.equal(ratingDropped(new ApiError('Odd.', 409, 'something_else')), null);
  assert.equal(ratingDropped(new ApiError('Expired.', 503, 'expired')), null);
  assert.equal(ratingDropped(new TypeError('Failed to fetch')), null);
  assert.equal(ratingDropped(new RatingCheckError('Other.')), null);
});

test('the rater’s own Base ID, when known, is never rated', () => {
  const op = operation(encodeRateCall(BigInt(RATED), 5));
  refused(() => check(prepared(op), { raterBaseId: RATED }), NOT_ITSELF);
  assert.equal(check(prepared(op), { raterBaseId: '12345' }), ownerOperationHash(op));
  for (const raterBaseId of ['', '0x1', ' 1', 7 as unknown as string])
    refused(() => check(prepared(op), { raterBaseId }), /own Base ID isn’t readable/);
});

/* ---------- the agent to rate ---------- */

const TARGET: RateTarget = {
  lookupId: 'rl_test-lookup-0001',
  agent: {
    agentId: '22222222-2222-4222-8222-222222222222',
    name: 'Harbor',
    baseId: RATED,
    short: 'Ab3dE9',
  },
  checkedAtBlock: 52_441_231,
  expiresAt: NOW + 300_000,
};

/** What the owner types for TARGET: its Base ID and its passport number, both required. */
const TYPED = { baseId: RATED, passport: 'Ab3dE9' };

const refusedTarget = (typed: unknown, message: string) =>
  assert.throws(
    () => rateLookup(typed as { baseId: string; passport: string }),
    (error: unknown) => error instanceof RateTargetError && error.message === message,
    JSON.stringify(typed),
  );

test('what must be typed: both a Base ID and a passport number, trimmed', () => {
  assert.deepEqual(rateLookup(TYPED), TYPED);
  assert.deepEqual(rateLookup({ baseId: ' 99515 ', passport: '\tAb3dE9 ' }), TYPED);
  // A passport of six digits is a passport here: the two fields are never read for each other.
  assert.deepEqual(rateLookup({ baseId: '77', passport: '123456' }), {
    baseId: '77',
    passport: '123456',
  });
  // Either one missing (or only spaces, or not text): nothing is asked.
  for (const typed of [
    { baseId: '', passport: 'Ab3dE9' },
    { baseId: RATED, passport: '' },
    { baseId: '   ', passport: 'Ab3dE9' },
    { baseId: RATED, passport: ' \n ' },
    { baseId: '', passport: '' },
    { baseId: RATED },
    { passport: 'Ab3dE9' },
    { baseId: 99515, passport: 'Ab3dE9' },
    {},
    null,
  ])
    refusedTarget(typed, TYPE_BOTH);
});

test('a Base ID is a positive decimal integer within uint256: nothing else is asked', () => {
  const max = (2n ** 256n - 1n).toString();
  assert.equal(rateLookup({ baseId: '1', passport: 'Ab3dE9' }).baseId, '1');
  assert.equal(rateLookup({ baseId: max, passport: 'Ab3dE9' }).baseId, max);
  for (const baseId of [
    '0',
    '00',
    '099515',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '0x1f',
    '99 515',
    '99,515',
    '９９５１５',
    (2n ** 256n).toString(),
    '1'.repeat(79),
    'Ab3dE9',
    'CC-99515',
    OTHER_WALLET,
  ])
    refusedTarget({ baseId, passport: 'Ab3dE9' }, NOT_A_BASE_ID);
});

test('a passport number is exactly 6 letters and digits: no link, no CC- form, no free text', () => {
  for (const passport of [
    'https://centralcity.ai/a/Ab3dE9',
    'centralcity.ai/a/Ab3dE9',
    '/a/Ab3dE9',
    'CC-Ab3dE9',
    'cc-Ab3dE9',
    'Ab3dE',
    'Ab3dE9x',
    'Ab3 E9',
    'Ab3-E9',
    'Ab3dÉ9',
    'Meridian',
    OTHER_WALLET,
  ])
    refusedTarget({ baseId: RATED, passport }, NOT_A_PASSPORT);
});

test('the lookup answer must be the agent with BOTH values typed, readable, and not expired', () => {
  assert.deepEqual(checkRateTarget(TARGET, TYPED, NOW, AGENT), TARGET);
  // Only the fields the screen uses come back; a missing name is ''.
  const loose = { ...TARGET, agent: { ...TARGET.agent, name: undefined }, proof: 'x' };
  assert.deepEqual(checkRateTarget(loose as unknown as RateTarget, TYPED, NOW, AGENT), {
    ...TARGET,
    agent: { ...TARGET.agent, name: '' },
  });
  const wrong = (answer: unknown, typed = TYPED, message: RegExp | string = /couldn’t be read/) =>
    assert.throws(
      () => checkRateTarget(answer as RateTarget, typed, NOW, AGENT),
      (error: unknown) =>
        error instanceof RateTargetError &&
        (typeof message === 'string' ? error.message === message : message.test(error.message)),
    );
  // The answer must match both typed values: another Base ID, another passport, or the passport in
  // another case (passport numbers are case-sensitive) is not the agent typed.
  wrong({ ...TARGET, agent: { ...TARGET.agent, baseId: '77' } }, TYPED, NOT_SAME_AGENT);
  wrong({ ...TARGET, agent: { ...TARGET.agent, short: 'Zz9yX8' } }, TYPED, NOT_SAME_AGENT);
  wrong({ ...TARGET, agent: { ...TARGET.agent, short: 'ab3de9' } }, TYPED, NOT_SAME_AGENT);
  wrong(TARGET, { baseId: '77', passport: 'Ab3dE9' }, NOT_SAME_AGENT);
  wrong(TARGET, { baseId: RATED, passport: 'AB3DE9' }, NOT_SAME_AGENT);
  wrong(TARGET, { baseId: RATED, passport: 'Zz9yX8' }, NOT_SAME_AGENT);
  // Both values right, but of two agents: the Base ID of one and the passport of another.
  wrong(
    { ...TARGET, agent: { ...TARGET.agent, baseId: '77', short: '123456' } },
    { baseId: '77', passport: 'Ab3dE9' },
    NOT_SAME_AGENT,
  );
  wrong(TARGET, {} as typeof TYPED, NOT_SAME_AGENT);
  // The rater itself.
  wrong({ ...TARGET, agent: { ...TARGET.agent, agentId: AGENT } }, TYPED, NOT_ITSELF);
  assert.throws(
    () => checkRateTarget(TARGET, TYPED, NOW, ''),
    (error: unknown) => error instanceof RateTargetError && error.message === NOT_ITSELF,
  );
  // Too old.
  wrong({ ...TARGET, expiresAt: NOW }, TYPED, /too old/);
  // Not readable.
  for (const answer of [
    null,
    {},
    { ...TARGET, lookupId: '' },
    { ...TARGET, lookupId: 'x'.repeat(257) },
    { ...TARGET, checkedAtBlock: 0 },
    { ...TARGET, checkedAtBlock: 1.5 },
    { ...TARGET, expiresAt: Number.NaN },
    { ...TARGET, agent: { ...TARGET.agent, agentId: '' } },
    { ...TARGET, agent: { ...TARGET.agent, baseId: '0' } },
    { ...TARGET, agent: { ...TARGET.agent, baseId: '099515' } },
    { ...TARGET, agent: { ...TARGET.agent, baseId: 99515 } },
    { ...TARGET, agent: { ...TARGET.agent, short: 'Ab3dE' } },
  ])
    wrong(answer);
});

/* ---------- this browser's read of Base ---------- */

const IDENTITY = getAddress(NETWORK.contracts.identityRegistry!);
const HEAD = '0x3203a4f';
type RpcCall = { method: string; params: unknown[] };
const uriResult = (uri: string) => encodeAbiParameters([{ type: 'string' }], [uri]);
/** Base's public endpoint, answering tokenURI(Base ID) from `uris` (absent: the call reverts). */
function baseRpc(uris: Record<string, string>, calls: RpcCall[] = []) {
  return (async (url: string, init: RequestInit = {}) => {
    assert.equal(url, PAY_BASE_RPC);
    const call = JSON.parse(String(init.body)) as RpcCall;
    calls.push(call);
    if (call.method === 'eth_blockNumber')
      return Response.json({ jsonrpc: '2.0', id: 1, result: HEAD });
    const { to, data } = call.params[0] as { to: string; data: Hex };
    assert.equal(getAddress(to), IDENTITY);
    const { args } = decodeFunctionData({ abi: tokenUriAbi, data });
    const uri = uris[String(args[0])];
    return Response.json(
      uri === undefined
        ? { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }
        : { jsonrpc: '2.0', id: 1, result: uriResult(uri) },
    );
  }) as unknown as typeof fetch;
}
const tokenUriAbi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);

test('Base, read here: the Base ID’s tokenURI must be exactly the passport named', async () => {
  assert.equal(passportUri('Ab3dE9'), 'https://centralcity.ai/a/Ab3dE9');
  const calls: RpcCall[] = [];
  const block = await confirmRateTargetOnBase(TARGET, {
    fetch: baseRpc({ [RATED]: passportUri('Ab3dE9') }, calls),
  });
  assert.equal(block, Number(HEAD));
  assert.deepEqual(calls[1], {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      { to: IDENTITY, data: `0xc87b56dd${BigInt(RATED).toString(16).padStart(64, '0')}` },
      HEAD,
    ],
  } as unknown as RpcCall);
  // Another agent's passport, a data: URI (not a Central City agent), a near miss, or no such id.
  for (const uris of [
    { [RATED]: passportUri('Zz9yX8') },
    { [RATED]: 'data:application/json;base64,e30=' },
    { [RATED]: 'http://centralcity.ai/a/Ab3dE9' },
    { [RATED]: 'https://centralcity.ai/a/ab3de9' },
    { [RATED]: `${passportUri('Ab3dE9')}/` },
    {},
  ] as Record<string, string>[])
    await assert.rejects(
      confirmRateTargetOnBase(TARGET, { fetch: baseRpc(uris) }),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_ON_BASE,
    );
});

test('when Base can’t be read here, nothing is confirmed', async () => {
  const unreachable = (error: unknown) =>
    error instanceof RateTargetError && /Couldn’t check on Base/.test(error.message);
  const answering = (body: unknown) =>
    (async (_url: string, init: RequestInit = {}) => {
      const { method } = JSON.parse(String(init.body)) as RpcCall;
      return Response.json(
        method === 'eth_blockNumber' ? { jsonrpc: '2.0', id: 1, result: HEAD } : body,
      );
    }) as unknown as typeof fetch;
  for (const reader of [
    (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch,
    answering({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'busy' } }),
    answering({ jsonrpc: '2.0', id: 1, result: '0x1234' }),
    answering({ jsonrpc: '2.0', id: 1, result: 7 }),
    answering({ jsonrpc: '2.0', id: 1, result: `0x${'ff'.repeat(64)}` }),
  ])
    await assert.rejects(tokenUriOnBase(RATED, { fetch: reader }), unreachable);
  await assert.rejects(
    tokenUriOnBase('0', { fetch: baseRpc({}) }),
    (error: unknown) => error instanceof RateTargetError && /has no Base ID/.test(error.message),
  );
});

test('lookup and create send exactly the routes’ shape: both typed values, then the lookup id only', async () => {
  const calls: Array<{ method: string; url: string; body: unknown; headers: unknown }> = [];
  const original = globalThis.fetch;
  let answer: RateTarget = TARGET;
  let lookupError: { status: number; body: unknown } | null = null;
  const onBase = baseRpc({ [RATED]: passportUri('Ab3dE9'), '1': 'data:application/json,{}' });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (url === PAY_BASE_RPC) return onBase(url, init);
    calls.push({
      method: init.method ?? 'GET',
      url: String(url),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: init.headers,
    });
    if (String(url).endsWith('/ratings/lookup'))
      return lookupError
        ? Response.json(lookupError.body, { status: lookupError.status })
        : Response.json({ ...answer, expiresAt: Date.now() + 300_000 });
    return Response.json({ withdrawalId: 'w-1' }, { status: 201 });
  }) as typeof fetch;
  try {
    const found = await lookupRateTarget(AGENT, { baseId: ' 99515 ', passport: ' Ab3dE9 ' });
    assert.equal(found.agent.baseId, RATED);
    assert.equal(found.agent.short, 'Ab3dE9');
    assert.deepEqual(calls[0], {
      method: 'POST',
      url: `/api/base/agents/${AGENT}/wallet/ratings/lookup`,
      body: { baseId: RATED, passport: 'Ab3dE9' },
      headers: { 'Content-Type': 'application/json', 'X-City-Request': '1' },
    });
    // The whole lookup handed in as `to`: only its id goes out.
    await createRating(AGENT, {
      to: found,
      stars: 4,
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    });
    assert.equal(calls[1]!.method, 'POST');
    assert.equal(calls[1]!.url, `/api/base/agents/${AGENT}/wallet/ratings`);
    assert.deepEqual(calls[1]!.body, {
      to: { lookupId: TARGET.lookupId },
      stars: 4,
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    });
    assert.deepEqual(rateTo(found), { lookupId: TARGET.lookupId });
    // The server answers with an agent that has the typed passport but another Base ID: refused
    // by the answer itself, before Base is read.
    answer = { ...TARGET, agent: { ...TARGET.agent, baseId: '1' } };
    await assert.rejects(
      lookupRateTarget(AGENT, TYPED),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_SAME_AGENT,
    );
    // The answer matches both typed values, but Base shows no Central City agent there: refused.
    await assert.rejects(
      lookupRateTarget(AGENT, { baseId: '1', passport: 'Ab3dE9' }),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_ON_BASE,
    );
    // The server answers with the rater itself: refused.
    answer = { ...TARGET, agent: { ...TARGET.agent, agentId: AGENT } };
    await assert.rejects(
      lookupRateTarget(AGENT, TYPED),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_ITSELF,
    );
    // The server says the two values belong to different agents: the same sentence.
    lookupError = {
      status: 409,
      body: { error: 'Base ID and passport differ.', code: 'lookup_mismatch' },
    };
    await assert.rejects(
      lookupRateTarget(AGENT, TYPED),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_SAME_AGENT,
    );
    // Any other refusal from the server stays the server's.
    lookupError = { status: 403, body: { error: 'Not allowed.', code: 'not_rateable' } };
    await assert.rejects(
      lookupRateTarget(AGENT, TYPED),
      (error: unknown) =>
        !(error instanceof RateTargetError) && (error as { code?: string }).code === 'not_rateable',
    );
    lookupError = null;
    // Missing or malformed values are refused here: nothing is asked.
    calls.length = 0;
    await assert.rejects(
      lookupRateTarget(AGENT, { baseId: RATED, passport: '' }),
      (error: unknown) => error instanceof RateTargetError && error.message === TYPE_BOTH,
    );
    await assert.rejects(
      lookupRateTarget(AGENT, { baseId: '', passport: 'Ab3dE9' }),
      (error: unknown) => error instanceof RateTargetError && error.message === TYPE_BOTH,
    );
    await assert.rejects(
      lookupRateTarget(AGENT, { baseId: '0', passport: 'Ab3dE9' }),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_A_BASE_ID,
    );
    await assert.rejects(
      lookupRateTarget(AGENT, { baseId: OTHER_WALLET, passport: 'Ab3dE9' }),
      (error: unknown) => error instanceof RateTargetError && error.message === NOT_A_BASE_ID,
    );
    for (const passport of [
      'CC-Ab3dE9',
      'https://centralcity.ai/a/Ab3dE9',
      'centralcity.ai/a/Ab3dE9',
    ])
      await assert.rejects(
        lookupRateTarget(AGENT, { baseId: RATED, passport }),
        (error: unknown) => error instanceof RateTargetError && error.message === NOT_A_PASSPORT,
      );
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
