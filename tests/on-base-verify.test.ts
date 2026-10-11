import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  pad,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { reputationReadAbi } from '../server/base/explorer/head.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import { passed, scoreClaim, ticks, type ScoreClaim } from '../src/verify/onBaseData';
import {
  BASE_RPC,
  ENTRYPOINT,
  IDENTITY_REGISTRY,
  REPUTATION_REGISTRY,
  decodeFeedback,
  feedbackCall,
  verify,
} from '../src/verify/onBaseVerify';

/*
 * Verify against a fake Base (JSON-RPC over a fake fetch) and a fake passport file. The fixture is
 * the real mint of Base ID 99268 and its live registration file; viem encodes the answers so the
 * hand-written decoding is checked independently.
 */

const ACCOUNT = '0x8c7af5c672fc8bc8658450161278126a5d2816ad';
const OTHER = '0x1111111111111111111111111111111111111111';
const OWNER = '0x69eA9b7512C8EF4F3A3eEe5Ec6bD6D812071BC78';
const MINT_TX = '0xde16037751e4f71bce4c6bd261b41a81ce4258543fbd8e109d38d60518cbc1a8';
const N = 52_425_223;
const HASH = '0x72a4e09316774ecd26d453216de49a48c38dda020017fdb1a84745d2c57ad923';
const ROW = {
  baseId: '99268',
  owner: OWNER,
  short: 'R6IsTd',
  mintTx: MINT_TX as string | undefined,
  status: 'final' as 'final' | 'finalizing',
};

const word = (address: string) => pad(address as Hex).toLowerCase();
const hex = (value: number) => `0x${value.toString(16)}`;

type Fake = {
  chainId: number;
  latest: number;
  finalized: number;
  owner: string | null;
  uri: string;
  transferTo: string;
  sender: string;
  success: boolean;
  receipt: boolean;
  canonicalHash: string;
  /** The registration file at the passport address: a body, a 404, or a failed read. */
  file: object | 'missing' | 'down';
  /** The Base ID the receipt's Transfer mints (another one: an unrelated mint transaction). */
  mintedId: number;
  /** Where the mint sits among the bundle's operations. */
  layout: 'own' | 'otherOp' | 'validation';
  /** The Reputation Registry's feedback for the Base ID (any client), per block or for all. */
  feedback: Feedback[] | ((block: number) => Feedback[] | 'pruned' | 'down');
};

/** One feedback entry as the registry stores it. */
type Feedback = {
  client: string;
  index: number | bigint;
  value: bigint;
  decimals?: number;
  tag1?: string;
  tag2?: string;
  revoked?: boolean;
};

const FILE = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Pinako',
  registrations: [
    { agentId: 99268, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
  ],
};

const BASE: Fake = {
  chainId: 8453,
  latest: 52_431_207,
  finalized: 52_427_503,
  owner: OWNER,
  uri: 'https://centralcity.ai/a/R6IsTd',
  transferTo: ACCOUNT,
  sender: ACCOUNT,
  success: true,
  receipt: true,
  canonicalHash: HASH,
  file: FILE,
  mintedId: 99268,
  layout: 'own',
  feedback: [],
};

function receipt(fake: Fake) {
  const log = (address: string, topics: string[], data: string) => ({
    address: address.toLowerCase(),
    topics,
    data,
    blockNumber: hex(N),
    blockHash: HASH,
  });
  const beforeExecution = log(ENTRYPOINT, [toEventSelector('BeforeExecution()')], '0x');
  const transfer = log(
    IDENTITY_REGISTRY,
    [
      toEventSelector('Transfer(address,address,uint256)'),
      pad('0x0'),
      word(fake.transferTo),
      pad(hex(fake.mintedId) as Hex),
    ],
    '0x',
  );
  const operation = (sender: string) =>
    log(
      ENTRYPOINT,
      [
        toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'),
        pad('0x714b'),
        word(sender),
        word('0x2faeb0760d4230ef2ac21496bb4f0b47d634fd4c'),
      ],
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
        [5n, fake.success, 10n, 20n],
      ),
    );
  const logs =
    fake.layout === 'own'
      ? [beforeExecution, transfer, operation(fake.sender)]
      : fake.layout === 'otherOp'
        ? // The mint ran in another account's operation; the account's own op came later.
          [beforeExecution, transfer, operation(OTHER), operation(fake.sender)]
        : // The mint happened during validation (e.g. a deploy), before any operation ran.
          [transfer, beforeExecution, operation(fake.sender)];
  return {
    status: '0x1',
    blockNumber: hex(N),
    blockHash: HASH,
    // Base answers logs in order; reversed here so the order must come from logIndex.
    logs: logs.map((entry, i) => ({ ...entry, logIndex: hex(i) })).reverse(),
  };
}

/** A fake fetch answering JSON-RPC from `fake`; it records what was asked. */
function fakeBase(changes: Partial<Fake> = {}) {
  const fake = { ...BASE, ...changes };
  const asked: { url: string; method: string; params: unknown[] }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://centralcity.ai/')) {
      asked.push({ url, method: 'GET', params: [] });
      assert.equal(url, fake.uri);
      assert.equal(init.method ?? 'GET', 'GET');
      // Never this browser's cached copy from before the confirmation.
      assert.equal(init.cache, 'no-store');
      if (fake.file === 'down') throw new TypeError('Failed to fetch');
      if (fake.file === 'missing') return new Response('{"error":"not found"}', { status: 404 });
      return new Response(JSON.stringify(fake.file), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const { method, params, id } = JSON.parse(String(init.body)) as {
      method: string;
      params: unknown[];
      id: number;
    };
    asked.push({ url, method, params });
    const answer = (body: object) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), {
        headers: { 'content-type': 'application/json' },
      });
    const result = (value: unknown) => answer({ result: value });
    switch (method) {
      case 'eth_chainId':
        return result(hex(fake.chainId));
      case 'eth_blockNumber':
        return result(hex(fake.latest));
      case 'eth_getTransactionReceipt':
        return result(fake.receipt && params[0] === MINT_TX ? receipt(fake) : null);
      case 'eth_getBlockByNumber':
        if (params[0] === 'finalized')
          return result({ number: hex(fake.finalized), hash: pad('0xf1') });
        if (params[0] === hex(N)) return result({ number: hex(N), hash: fake.canonicalHash });
        return result(null);
      case 'eth_call': {
        const [{ to, data }, block] = params as [{ to: string; data: string }, string];
        const selector = data.slice(0, 10);
        if (to === IDENTITY_REGISTRY && selector === toFunctionSelector('ownerOf(uint256)')) {
          assert.equal(block, hex(fake.latest));
          if (!fake.owner)
            return answer({
              error: { code: 3, message: 'execution reverted', data: '0x7e273289' },
            });
          return result(encodeAbiParameters([{ type: 'address' }], [fake.owner as Hex]));
        }
        if (to === IDENTITY_REGISTRY && selector === toFunctionSelector('tokenURI(uint256)')) {
          assert.equal(block, hex(fake.latest));
          return result(encodeAbiParameters([{ type: 'string' }], [fake.uri]));
        }
        if (to === REPUTATION_REGISTRY && selector === toFunctionSelector(readAllFeedback)) {
          const { args } = decodeFunctionData({ abi: reputationReadAbi, data: data as Hex });
          const [agentId, clients, tag1, tag2, includeRevoked] = args;
          assert.equal(agentId, 99268n);
          assert.deepEqual([tag1, tag2, includeRevoked], ['', '', false]);
          const found =
            typeof fake.feedback === 'function' ? fake.feedback(Number(block)) : fake.feedback;
          if (found === 'pruned')
            return answer({ error: { code: -32000, message: 'missing trie node' } });
          if (found === 'down') throw new TypeError('Failed to fetch');
          // The registry's filter: these clients only (none named: all), revoked ones left out.
          const wanted = new Set(clients.map((c) => c.toLowerCase()));
          const rows = found.filter(
            (f) => !f.revoked && (wanted.size === 0 || wanted.has(f.client.toLowerCase())),
          );
          return result(feedbackAnswer(rows));
        }
        return answer({ error: { code: -32601, message: `unexpected call ${to} ${data}` } });
      }
      default:
        return answer({ error: { code: -32601, message: `unexpected ${method}` } });
    }
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const readAllFeedback = 'readAllFeedback(uint256,address[],string,string,bool)';

/** readAllFeedback's answer for these entries, encoded by viem. */
function feedbackAnswer(rows: Feedback[]) {
  return encodeFunctionResult({
    abi: reputationReadAbi,
    functionName: 'readAllFeedback',
    result: [
      rows.map((f) => getAddress(f.client)),
      rows.map((f) => BigInt(f.index)),
      rows.map((f) => f.value),
      rows.map((f) => f.decimals ?? 0),
      rows.map((f) => f.tag1 ?? 'starred'),
      rows.map((f) => f.tag2 ?? ''),
      rows.map((f) => f.revoked ?? false),
    ],
  });
}

async function checked(changes: Partial<Fake> = {}, row = ROW, score: ScoreClaim | null = null) {
  const base = fakeBase(changes);
  const result = await verify(row, { fetch: base.fetch, score });
  assert.equal(result.kind, 'checked');
  return { ...(result as Extract<typeof result, { kind: 'checked' }>), asked: base.asked };
}

test('all four pass: ownerOf, tokenURI, confirmed by Central City, final', async () => {
  const result = await checked();
  assert.equal(result.owner.state, 'pass');
  assert.equal(result.owner.evidence, 'ownerOf(99268) on Base = 0x69eA…BC78 at block 52,431,207');
  assert.equal(result.uri.state, 'pass');
  assert.match(result.uri.evidence, /= https:\/\/centralcity\.ai\/a\/R6IsTd at block 52,431,207$/);
  assert.equal(result.registeredBy.state, 'pass');
  assert.equal(
    result.registeredBy.evidence,
    'centralcity.ai/a/R6IsTd names Base ID 99268 now; minted to account 0x8c7a…16ad in its own operation, block 52,425,223',
  );
  assert.equal(result.final.state, 'pass');
  assert.equal(
    result.final.evidence,
    'Block 52,425,223 is canonical and at or below finalized block 52,427,503',
  );
  assert.equal(result.block, 52_431_207);
  assert.equal(result.rpc, BASE_RPC);
  // Base's public endpoint, plus one read of the passport at the address Base holds; nothing writes.
  const off = result.asked.filter((call) => call.url !== 'https://mainnet.base.org');
  assert.deepEqual(off, [{ url: 'https://centralcity.ai/a/R6IsTd', method: 'GET', params: [] }]);
  assert.ok(result.asked.every((call) => !/send|sign/i.test(call.method)));
});

test('an owner Base does not hold fails the owner check, with what Base holds', async () => {
  const result = await checked({ owner: OTHER });
  assert.equal(result.owner.state, 'fail');
  assert.match(result.owner.evidence, /= 0x1111…1111 at block/);
  assert.equal(result.uri.state, 'pass');
  assert.equal(result.registeredBy.state, 'pass');
});

test('a Base ID that does not exist (ownerOf reverts) is a fail, not an outage', async () => {
  const result = await checked({ owner: null });
  assert.equal(result.owner.state, 'fail');
  assert.match(result.owner.evidence, /reverted on Base at block 52,431,207: no such Base ID/);
});

test('a tokenURI pointing elsewhere fails the address check and registration', async () => {
  const result = await checked({ uri: 'https://example.com/a/R6IsTd' });
  assert.equal(result.uri.state, 'fail');
  assert.match(result.uri.evidence, /= https:\/\/example\.com\/a\/R6IsTd at block/);
  // The other site is never fetched.
  assert.equal(result.registeredBy.state, 'fail');
  assert.equal(result.registeredBy.evidence, "Its address on Base isn't a centralcity.ai passport");
  assert.ok(result.asked.every((call) => call.url === 'https://mainnet.base.org'));
  const other = await checked({}, { ...ROW, short: 'Other1' });
  assert.equal(other.uri.state, 'fail');
});

test('no receipt for the mint transaction fails registration and finality', async () => {
  const result = await checked({ receipt: false });
  assert.deepEqual(result.registeredBy, {
    state: 'fail',
    evidence: 'No such mint transaction on Base',
  });
  assert.equal(result.final.state, 'fail');
  assert.equal(result.owner.state, 'pass');
  const malformed = await checked({}, { ...ROW, mintTx: 'not-a-hash' });
  assert.equal(malformed.registeredBy.evidence, 'No such mint transaction on Base');
  const none = await checked({}, { ...ROW, mintTx: undefined });
  assert.equal(none.registeredBy.evidence, "Central City didn't give its mint transaction");
  assert.equal(none.final.state, 'fail');
  assert.ok(none.asked.every((call) => call.method !== 'eth_getTransactionReceipt'));
});

test('a mint to another account than the UserOperation sender fails registration', async () => {
  const result = await checked({ transferTo: OTHER });
  assert.equal(result.registeredBy.state, 'fail');
  assert.match(
    result.registeredBy.evidence,
    /Minted to 0x1111…1111, but not in its own successful/,
  );
  const failedOp = await checked({ success: false });
  assert.equal(failedOp.registeredBy.state, 'fail');
});

test('a copycat Base ID pointing at a real passport fails: the file names another id', async () => {
  // The passport Base points to names another Base ID: this one isn't the agent's.
  const result = await checked({
    file: {
      registrations: [{ agentId: 77777, agentRegistry: 'eip155:8453:' + IDENTITY_REGISTRY }],
    },
  });
  assert.equal(result.registeredBy.state, 'fail');
  // The right id in another chain's registry doesn't count either.
  const copy = await checked({
    file: { registrations: [{ agentId: 99268, agentRegistry: 'eip155:1:' + IDENTITY_REGISTRY }] },
  });
  assert.equal(copy.registeredBy.state, 'fail');
  assert.equal(copy.registeredBy.evidence, "centralcity.ai/a/R6IsTd doesn't name Base ID 99268");
});

test('while finalizing, a file that does not list the Base ID yet is not yet, never a fail', async () => {
  const notYet = { registrations: [] };
  // Base hasn't finalized the mint block.
  const onBase = await checked({ file: notYet, finalized: N - 1 });
  assert.deepEqual(onBase.registeredBy, {
    state: 'pending',
    evidence:
      'Minted to account 0x8c7a…16ad in its own operation, block 52,425,223; centralcity.ai/a/R6IsTd lists it once final',
  });
  // Base has, but Central City hasn't confirmed it yet (the list still says finalizing).
  const listed = await checked({ file: notYet }, { ...ROW, status: 'finalizing' });
  assert.equal(listed.registeredBy.state, 'pending');
  // Final everywhere and still not listed: a fail.
  const final = await checked({ file: notYet });
  assert.equal(final.registeredBy.state, 'fail');
});

test('a passport that is gone fails; one that cannot be read is not yet, never a pass', async () => {
  const gone = await checked({ file: 'missing' });
  assert.deepEqual(gone.registeredBy, {
    state: 'fail',
    evidence: "centralcity.ai/a/R6IsTd isn't there",
  });
  const down = await checked({ file: 'down' });
  assert.deepEqual(down.registeredBy, {
    state: 'pending',
    evidence:
      "Minted to account 0x8c7a…16ad in its own operation; couldn't read centralcity.ai/a/R6IsTd from your browser",
  });
  // Base itself was read: the other three still stand.
  assert.equal(down.owner.state, 'pass');
  assert.equal(down.final.state, 'pass');
  const odd = await checked({ file: { registrations: 'none' } });
  assert.equal(odd.registeredBy.state, 'fail');
});

test('an unrelated final transaction (another Base ID minted) fails registration AND finality', async () => {
  // mintTx is only a hint: a canonical, finalized receipt that mints another id proves nothing.
  const result = await checked({ mintedId: 12345 });
  const evidence = "Transaction 0xde16…c1a8 didn't mint Base ID 99268 on Base";
  assert.deepEqual(result.registeredBy, { state: 'fail', evidence });
  assert.deepEqual(result.final, { state: 'fail', evidence });
});

test("a mint that ran in another account's operation, or during validation, isn't its own", async () => {
  for (const layout of ['otherOp', 'validation'] as const) {
    const result = await checked({ layout });
    assert.equal(result.registeredBy.state, 'fail', layout);
    assert.match(result.registeredBy.evidence, /but not in its own successful operation/);
    // The mint of this id is still in that canonical, finalized block.
    assert.equal(result.final.state, 'pass', layout);
  }
});

test('a block not yet finalized is pending', async () => {
  const result = await checked({ finalized: N - 1 });
  assert.deepEqual(result.final, {
    state: 'pending',
    evidence: 'Included in block 52,425,223; Base finalizes it in about 15–30 min',
  });
});

test('a block hash Base no longer has (reorg) fails finality', async () => {
  const result = await checked({ canonicalHash: pad('0xbad') });
  assert.equal(result.final.state, 'fail');
});

test('another chain is unreachable: nothing is claimed', async () => {
  const base = fakeBase({ chainId: 1 });
  assert.deepEqual(await verify(ROW, { fetch: base.fetch }), { kind: 'unreachable' });
});

test('network errors, timeouts, non-JSON answers and RPC errors are unreachable', async () => {
  const down = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  assert.deepEqual(await verify(ROW, { fetch: down }), { kind: 'unreachable' });

  const hangs = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) =>
      init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    )) as unknown as typeof fetch;
  assert.deepEqual(await verify(ROW, { fetch: hangs, timeoutMs: 20 }), { kind: 'unreachable' });

  const html = (async () => new Response('<html>busy</html>')) as unknown as typeof fetch;
  assert.deepEqual(await verify(ROW, { fetch: html }), { kind: 'unreachable' });

  const limited = (async () =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32011, message: 'limit' } }),
    )) as unknown as typeof fetch;
  assert.deepEqual(await verify(ROW, { fetch: limited }), { kind: 'unreachable' });

  // A failure partway through (the receipt read) still claims nothing.
  const base = fakeBase();
  const partway = (async (url: string, init: RequestInit) => {
    if (String(init.body).includes('eth_getTransactionReceipt')) throw new TypeError('reset');
    return base.fetch(url, init);
  }) as unknown as typeof fetch;
  assert.deepEqual(await verify(ROW, { fetch: partway }), { kind: 'unreachable' });
});

/*
 * The passport's Central City score, recomputed in the browser from the rater wallets' feedback
 * on Base with the shared function (shared/base/rating-score.ts).
 */
const rater = (n: number) => `0x${'7'.repeat(38)}${n.toString(16).padStart(2, '0')}`;
const PASSPORT_BLOCK = 52_431_000;
const RATINGS: Feedback[] = [
  { client: rater(1), index: 1, value: 100n },
  { client: rater(1), index: 2, value: 60n }, // the latest of rater 1: 3 stars
  { client: rater(2), index: 1, value: 80n },
  { client: rater(2), index: 2, value: 20n, tag1: 'quality' }, // no rating
  { client: rater(3), index: 1, value: 100n },
  { client: rater(3), index: 2, value: 20n, revoked: true }, // revoked: 5 stars stand
  { client: OTHER, index: 1, value: 20n }, // anyone else
];
/** The rated agent's own wallet (Central City's record on the passport). */
const AGENT_WALLET = getAddress(`0x${'6'.repeat(40)}`);
const CLAIM: ScoreClaim = {
  score: { average: '4.0', raters: 3 },
  scoredBy: [rater(1), rater(2), rater(3)].map((r) => getAddress(r)),
  agentWallet: AGENT_WALLET,
  readAtBlock: PASSPORT_BLOCK,
};

test('the readAllFeedback call and its answer, by hand, agree with viem', () => {
  const clients = [rater(1), getAddress(rater(2))];
  assert.equal(
    feedbackCall('99268', clients),
    encodeFunctionData({
      abi: reputationReadAbi,
      functionName: 'readAllFeedback',
      args: [99268n, clients as Hex[], '', '', false],
    }),
  );
  assert.equal(
    feedbackCall('5', []),
    encodeFunctionData({
      abi: reputationReadAbi,
      functionName: 'readAllFeedback',
      args: [5n, [], '', '', false],
    }),
  );
  assert.throws(() => feedbackCall('5', ['not an address']));

  const rows: Feedback[] = [
    { client: rater(1), index: 7, value: -15n, decimals: 1, tag1: 'starred', tag2: 'x' },
    { client: rater(2), index: 1, value: 2n ** 127n - 1n, decimals: 18, tag1: 'ünïcode ★' },
    { client: rater(3), index: 2, value: 100n, tag1: '', revoked: true },
    { client: rater(4), index: 3, value: 80n, tag1: 't'.repeat(70) },
    // The largest uint64 index: exact, never rounded to a JS number.
    { client: rater(5), index: 2n ** 64n - 1n, value: 40n },
  ];
  assert.deepEqual(decodeFeedback(feedbackAnswer(rows)), [
    { client: rater(1), index: 7n, value: -15n, decimals: 1, tag1: 'starred', revoked: false },
    {
      client: rater(2),
      index: 1n,
      value: 2n ** 127n - 1n,
      decimals: 18,
      tag1: 'ünïcode ★',
      revoked: false,
    },
    { client: rater(3), index: 2n, value: 100n, decimals: 0, tag1: '', revoked: true },
    { client: rater(4), index: 3n, value: 80n, decimals: 0, tag1: 't'.repeat(70), revoked: false },
    {
      client: rater(5),
      index: 2n ** 64n - 1n,
      value: 40n,
      decimals: 0,
      tag1: 'starred',
      revoked: false,
    },
  ]);
  assert.deepEqual(decodeFeedback(feedbackAnswer([])), []);

  // Lists of different lengths, a cut answer or no ABI words: never half read.
  const uneven = encodeFunctionResult({
    abi: reputationReadAbi,
    functionName: 'readAllFeedback',
    result: [[getAddress(rater(1))], [1n, 2n], [1n], [0], [''], [''], [false]],
  });
  assert.throws(() => decodeFeedback(uneven), /Malformed feedback answer/);
  const whole = feedbackAnswer(rows);
  assert.throws(() => decodeFeedback(whole.slice(0, whole.length - 64)));
  assert.throws(() => decodeFeedback('0x1234'));
});

test('a passport score that matches Base passes, read at the block the passport was read at', async () => {
  const result = await checked({ feedback: RATINGS }, ROW, CLAIM);
  assert.deepEqual(result.score, {
    state: 'pass',
    evidence:
      '4.0 ★ from 3 Central City agents: the latest rating of each wallet the passport names, recomputed on Base at block 52,431,000',
  });
  // The other four checks are untouched.
  assert.equal(result.owner.state, 'pass');
  assert.equal(result.final.state, 'pass');
  const reads = result.asked.filter((call) => {
    const [tx] = call.params as [{ to?: string }];
    return call.method === 'eth_call' && tx?.to === REPUTATION_REGISTRY;
  });
  assert.equal(reads.length, 1);
  assert.equal((reads[0]!.params as unknown[])[1], hex(PASSPORT_BLOCK));
  // Only the named wallets are asked for, on the pinned registry.
  const [tx] = reads[0]!.params as [{ data: Hex }];
  const { args } = decodeFunctionData({ abi: reputationReadAbi, data: tx.data });
  assert.deepEqual(args[1], CLAIM.scoredBy);
  assert.equal(REPUTATION_REGISTRY, BASE_NETWORKS[BASE_MAINNET].contracts.reputationRegistry);
});

test("a score Base doesn't give is a fail, with what Base gives", async () => {
  // Rater 1's latest is 1 star on Base: 3.3 from 3.
  const changed = [...RATINGS, { client: rater(1), index: 3, value: 20n }];
  const result = await checked({ feedback: changed }, ROW, CLAIM);
  assert.deepEqual(result.score, {
    state: 'fail',
    evidence:
      '3.3 ★ from 3 Central City agents on Base at block 52,431,000 from the wallets the passport names; the passport says 4.0 ★ from 3 Central City agents',
  });
  // A wallet the passport names that never rated: the count differs.
  const extra = await checked({ feedback: RATINGS }, ROW, {
    ...CLAIM,
    score: { average: '4.0', raters: 4 },
    scoredBy: [...CLAIM.scoredBy, getAddress(rater(9))],
  });
  assert.equal(extra.score?.state, 'fail');
  assert.match(extra.score!.evidence, /^4\.0 ★ from 3 Central City agents on Base/);
  // No rating at all on Base.
  const none = await checked({ feedback: [] }, ROW, CLAIM);
  assert.deepEqual(none.score, {
    state: 'fail',
    evidence:
      'no rating on Base at block 52,431,000 from the wallets the passport names; the passport says 4.0 ★ from 3 Central City agents',
  });
  // The four identity checks still pass on their own.
  assert.equal(none.owner.state, 'pass');
});

test('when Base no longer keeps the passport block, Verify reads the latest block and says so', async () => {
  const result = await checked(
    { feedback: (block) => (block === PASSPORT_BLOCK ? 'pruned' : RATINGS) },
    ROW,
    CLAIM,
  );
  assert.deepEqual(result.score, {
    state: 'pass',
    evidence:
      '4.0 ★ from 3 Central City agents: the latest rating of each wallet the passport names, recomputed on Base at block 52,431,207',
  });
  // A rating given since the passport was read: a fail that names both blocks.
  const later = await checked(
    {
      feedback: (block) =>
        block === PASSPORT_BLOCK
          ? 'pruned'
          : [...RATINGS, { client: rater(2), index: 3, value: 20n }],
    },
    ROW,
    CLAIM,
  );
  assert.deepEqual(later.score, {
    state: 'fail',
    evidence:
      '3.0 ★ from 3 Central City agents on Base at block 52,431,207 from the wallets the passport names; the passport says 4.0 ★ from 3 Central City agents (the passport read block 52,431,000)',
  });
  // Without a passport block, the latest block only.
  const latest = await checked({ feedback: RATINGS }, ROW, { ...CLAIM, readAtBlock: null });
  assert.equal(latest.score?.state, 'pass');
  assert.match(latest.score!.evidence, /at block 52,431,207$/);
});

test('ratings Base does not give back leave the score not read; the other checks stand', async () => {
  for (const feedback of [() => 'down' as const, () => 'pruned' as const]) {
    const result = await checked({ feedback }, ROW, CLAIM);
    assert.deepEqual(result.score, {
      state: 'pending',
      evidence: "Couldn't read the ratings from Base just now",
    });
    assert.equal(result.owner.state, 'pass');
    assert.equal(result.registeredBy.state, 'pass');
  }
  // A wallet list that isn't addresses is never sent to Base.
  const odd = await checked({ feedback: RATINGS }, ROW, { ...CLAIM, scoredBy: ['nope'] });
  assert.equal(odd.score?.state, 'fail');
});

test('without a score to check, Verify reads no feedback and shows no score', async () => {
  const result = await checked({ feedback: RATINGS });
  assert.equal(result.score, undefined);
  assert.ok(
    result.asked.every((call) => {
      const [tx] = call.params as [{ to?: string } | undefined];
      return tx?.to !== REPUTATION_REGISTRY;
    }),
  );
});

test('a passport score that names no rater wallets is still checked, and fails', async () => {
  // The claim exists whenever the passport shows a score: an empty or missing scoredBy can't hide it.
  const score = { average: '5.0', raters: 900 };
  const passport = (scoredBy?: string[]) => ({
    agentWallet: AGENT_WALLET,
    reputation: {
      readAtBlock: PASSPORT_BLOCK,
      readAt: 0,
      count: 0,
      entries: [],
      score,
      ...(scoredBy ? { scoredBy } : {}),
    },
  });
  const empty = scoreClaim(passport([]));
  assert.deepEqual(empty, {
    score,
    scoredBy: [],
    agentWallet: AGENT_WALLET,
    readAtBlock: PASSPORT_BLOCK,
  });
  assert.deepEqual(scoreClaim(passport()), empty);
  assert.equal(
    scoreClaim({ ...passport([]), reputation: { ...passport([]).reputation, score: null } }),
    null,
  );

  // Base has five-star ratings, but from no wallet the passport names: nothing backs the score.
  const result = await checked({ feedback: RATINGS }, ROW, empty);
  assert.deepEqual(result.score, {
    state: 'fail',
    evidence:
      'The passport names no rater wallets, so nothing on Base backs it; the passport says 5.0 ★ from 900 Central City agents',
  });
  // Five checks, four pass: never "All 4 checks pass".
  assert.equal(ticks(result).length, 5);
  assert.equal(passed(result), 4);
  // No feedback read at all (an empty list would ask Base for everyone's feedback).
  assert.ok(
    result.asked.every((call) => {
      const [tx] = call.params as [{ to?: string } | undefined];
      return tx?.to !== REPUTATION_REGISTRY;
    }),
  );
});

test("the rated agent's own wallet never counts toward its score in Verify", async () => {
  // The passport names the agent's own wallet as a rater: its 1-star rating of itself is left out.
  const self = await checked(
    { feedback: [...RATINGS, { client: AGENT_WALLET, index: 1, value: 20n }] },
    ROW,
    { ...CLAIM, scoredBy: [...CLAIM.scoredBy, AGENT_WALLET] },
  );
  assert.equal(self.score?.state, 'pass');
  assert.match(self.score!.evidence, /^4\.0 ★ from 3 Central City agents:/);
  // A passport that counts it (3.3 from 4) doesn't match what Base backs.
  const counted = await checked(
    { feedback: [...RATINGS, { client: AGENT_WALLET, index: 1, value: 20n }] },
    ROW,
    { ...CLAIM, score: { average: '3.3', raters: 4 }, scoredBy: [...CLAIM.scoredBy, AGENT_WALLET] },
  );
  assert.equal(counted.score?.state, 'fail');
  assert.match(counted.score!.evidence, /^4\.0 ★ from 3 Central City agents on Base/);
});

test('feedback indexes above 2^53 decide the latest rating exactly in Verify', async () => {
  // As JS numbers 2^53 and 2^53 + 1 are equal; the later rating (3 stars) is the latest.
  const top = 2n ** 53n;
  const result = await checked(
    {
      feedback: [
        { client: rater(1), index: top + 1n, value: 60n },
        { client: rater(1), index: top, value: 100n },
      ],
    },
    ROW,
    { ...CLAIM, score: { average: '3.0', raters: 1 }, scoredBy: [getAddress(rater(1))] },
  );
  assert.equal(result.score?.state, 'pass');
});
