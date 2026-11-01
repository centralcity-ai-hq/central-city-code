import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {
  createPublicClient,
  createTestClient,
  http,
  keccak256,
  encodeAbiParameters,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  MAX_SIGNATURE_BYTES,
  SIMULATION_ACCOUNT,
  PUBLIC_FACILITATOR_PATH,
  parseExactPayment,
  registerPublicFacilitatorRoutes,
  revertReason,
  supportedAnswer,
  verifyExactPayment,
  type FacilitatorReader,
} from '../server/protocol/x402/public-facilitator.js';
import { reservedPayees } from '../shared/protocol.js';

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NOW = 1_792_900_000;
const PAY_TO: Address = '0x00000000000000000000000000000000000000aa';

/** A real EIP-3009 authorization signed by `key`, and the x402 v2 request around it. */
async function request(
  key: Hex,
  over: {
    value?: bigint;
    amount?: bigint;
    to?: Address;
    validAfter?: bigint;
    validBefore?: bigint;
    nonce?: Hex;
  } = {},
) {
  const account = privateKeyToAccount(key);
  const authorization = {
    from: account.address,
    to: over.to ?? PAY_TO,
    value: over.value ?? 10_000n,
    validAfter: over.validAfter ?? 0n,
    validBefore: over.validBefore ?? BigInt(NOW + 600),
    nonce: over.nonce ?? (`0x${'11'.repeat(32)}` as Hex),
  };
  const signature = await account.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  const requirements = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: String(over.amount ?? authorization.value),
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  };
  return {
    x402Version: 2,
    paymentRequirements: requirements,
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: {
        signature,
        authorization: {
          ...authorization,
          value: String(authorization.value),
          validAfter: String(authorization.validAfter),
          validBefore: String(authorization.validBefore),
        },
      },
    },
  };
}

const passes: FacilitatorReader = { call: async () => '0x' };
const reverts = (message: string): FacilitatorReader => ({
  call: async () => {
    throw new Error(message);
  },
});

test('/supported: x402 v2, exact, Base mainnet; signers only the sender that really settles', () => {
  const sender: Address = '0x00000000000000000000000000000000000000cc';
  assert.deepEqual(supportedAnswer([sender]), {
    kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
    extensions: [],
    signers: { 'eip155:*': [sender] },
  });
  // Settlement off: verification is offered, no signer is advertised (not even router 3's EOA).
  assert.deepEqual(supportedAnswer([]).signers, { 'eip155:*': [] });
  assert.ok(!JSON.stringify(supportedAnswer([])).includes(SIMULATION_ACCOUNT));
});

test('/verify refuses wrong shapes before any chain read, with the spec reasons', async () => {
  const key = generatePrivateKey();
  const good = await request(key);
  let reads = 0;
  const counting: FacilitatorReader = { call: async () => void reads++ };
  const cases: Array<[unknown, string]> = [
    [null, 'invalid_payload'],
    [{ ...good, x402Version: 1 }, 'invalid_x402_version'],
    [
      { ...good, paymentRequirements: { ...good.paymentRequirements, scheme: 'upto' } },
      'unsupported_scheme',
    ],
    [
      { ...good, paymentRequirements: { ...good.paymentRequirements, network: 'eip155:84532' } },
      'invalid_network',
    ],
    [
      {
        ...good,
        paymentRequirements: {
          ...good.paymentRequirements,
          asset: '0x4200000000000000000000000000000000000006',
        },
      },
      'invalid_payment_requirements',
    ],
    [
      {
        ...good,
        paymentRequirements: {
          ...good.paymentRequirements,
          extra: { assetTransferMethod: 'permit2' },
        },
      },
      'invalid_payment_requirements',
    ],
    [
      await request(key, { to: '0x00000000000000000000000000000000000000bb' }),
      'invalid_exact_evm_payload_recipient_mismatch',
    ],
    [await request(key, { amount: 20_000n }), 'invalid_exact_evm_payload_authorization_value'],
    [
      await request(key, { validAfter: BigInt(NOW + 60) }),
      'invalid_exact_evm_payload_authorization_valid_after',
    ],
    [
      await request(key, { validBefore: BigInt(NOW + 3) }),
      'invalid_exact_evm_payload_authorization_valid_before',
    ],
  ];
  for (const [body, reason] of cases) {
    const answer = await verifyExactPayment(body, { reader: counting, nowSeconds: NOW });
    assert.equal(answer.isValid, false, reason);
    assert.equal(!answer.isValid && answer.invalidReason, reason);
  }
  assert.equal(reads, 0, 'no chain read for a request refused on its shape');
  const ok = await verifyExactPayment(good, { reader: passes, nowSeconds: NOW });
  assert.deepEqual(ok, { isValid: true, payer: privateKeyToAccount(key).address });
});

test("USDC's revert messages map to the spec reasons; unknown ones are never called invalid signature", () => {
  assert.equal(
    revertReason('execution reverted: FiatTokenV2: invalid signature'),
    'invalid_exact_evm_payload_signature',
  );
  assert.equal(
    revertReason('FiatTokenV2: authorization is used or canceled'),
    'invalid_transaction_state',
  );
  assert.equal(
    revertReason('FiatTokenV2: authorization is not yet valid'),
    'invalid_exact_evm_payload_authorization_valid_after',
  );
  assert.equal(
    revertReason('FiatTokenV2: authorization is expired'),
    'invalid_exact_evm_payload_authorization_valid_before',
  );
  assert.equal(revertReason('ERC20: transfer amount exceeds balance'), 'insufficient_funds');
  assert.equal(revertReason('Blacklistable: account is blacklisted'), 'invalid_transaction_state');
  assert.equal(revertReason('timeout'), 'unexpected_verify_error');
});

test('a Base that does not answer is an unexpected error, never a valid payment', async () => {
  const body = await request(generatePrivateKey());
  assert.equal((await verifyExactPayment(body, { reader: null, nowSeconds: NOW })).isValid, false);
  const answer = await verifyExactPayment(body, {
    reader: reverts('fetch failed'),
    nowSeconds: NOW,
  });
  assert.deepEqual(answer.isValid ? null : answer.invalidReason, 'unexpected_verify_error');
});

test('the routes: /supported cached and open to all origins, /verify no-store, /settle refuses honestly', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerPublicFacilitatorRoutes(app, {
    reader: async () => passes,
    limit: async () => {},
    now: () => NOW * 1000,
  });
  const supported = await app.inject(`${PUBLIC_FACILITATOR_PATH}/supported`);
  assert.equal(supported.statusCode, 200);
  assert.equal(supported.headers['access-control-allow-origin'], '*');
  assert.match(String(supported.headers['cache-control']), /max-age=300/);
  assert.deepEqual(supported.json(), supportedAnswer([]));

  const body = await request(generatePrivateKey());
  const verified = await app.inject({
    method: 'POST',
    url: `${PUBLIC_FACILITATOR_PATH}/verify`,
    payload: body,
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.headers['cache-control'], 'no-store');
  assert.equal(verified.json().isValid, true);

  const settled = await app.inject({
    method: 'POST',
    url: `${PUBLIC_FACILITATOR_PATH}/settle`,
    payload: body,
  });
  assert.equal(settled.statusCode, 503);
  assert.deepEqual(settled.json(), {
    success: false,
    errorReason: 'settlement_unavailable',
    transaction: '',
    network: 'eip155:8453',
    payer: body.paymentPayload.payload.authorization.from,
  });
});

test('/verify: one shared simulation budget for every client, taken only by a payment that passed every static check; refused, Base is never asked', async (t) => {
  const keys: string[] = [];
  let simulations = 0;
  let shared = 2;
  const app = Fastify();
  t.after(() => app.close());
  registerPublicFacilitatorRoutes(app, {
    reader: async () => ({ call: async () => (simulations++, '0x') }),
    limit: async (key) => {
      keys.push(key);
      if (key === 'x402-verify:simulations' && shared-- <= 0)
        throw Object.assign(new Error('Too many requests.'), { statusCode: 429 });
    },
    now: () => NOW * 1000,
  });
  const verify = (payload: object) =>
    app.inject({ method: 'POST', url: `${PUBLIC_FACILITATOR_PATH}/verify`, payload });
  // A malformed body never takes from the shared budget.
  assert.equal((await verify({ x402Version: 1 })).json().isValid, false);
  assert.deepEqual(
    keys.filter((k) => k === 'x402-verify:simulations'),
    [],
  );
  const body = await request(generatePrivateKey());
  assert.equal((await verify(body)).json().isValid, true);
  assert.equal((await verify(body)).json().isValid, true);
  assert.equal(simulations, 2);
  // Budget spent (or the shared limiter down: the prefix fails closed): 429, no simulation.
  assert.equal((await verify(body)).statusCode, 429);
  assert.equal(simulations, 2);
  assert.equal(keys.filter((k) => k === 'x402-verify:simulations').length, 3);
});

test('/verify: two instances share one simulation budget, and a limiter outage refuses with zero simulations', async (t) => {
  let simulations = 0;
  let shared = 3;
  let outage = false;
  // The shared limiter as every instance sees it (one store), failing closed when down.
  const limit = async (key: string) => {
    if (key !== 'x402-verify:simulations') return;
    if (outage || shared-- <= 0)
      throw Object.assign(new Error('Too many requests.'), { statusCode: 429 });
  };
  const instance = () => {
    const app = Fastify();
    t.after(() => app.close());
    registerPublicFacilitatorRoutes(app, {
      reader: async () => ({ call: async () => (simulations++, '0x') }),
      limit,
      now: () => NOW * 1000,
    });
    return (payload: object) =>
      app.inject({ method: 'POST', url: `${PUBLIC_FACILITATOR_PATH}/verify`, payload });
  };
  const [a, b] = [instance(), instance()];
  const body = await request(generatePrivateKey());
  const codes = [];
  for (const verify of [a, b, a, b, a]) codes.push((await verify(body)).statusCode);
  assert.deepEqual(
    codes,
    [200, 200, 200, 429, 429],
    'three simulations in all, not three per instance',
  );
  assert.equal(simulations, 3);
  shared = 100;
  outage = true;
  assert.equal((await a(body)).statusCode, 429);
  assert.equal((await b(body)).statusCode, 429);
  assert.equal(simulations, 3, 'no simulation while the shared limiter is down');
});

test('/verify: the simulation is pinned to the head block; a head that cannot be read leaves it unpinned; settle stays unpinned', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const pins: Array<bigint | undefined> = [];
  let head: () => Promise<bigint> = async () => 41_000_000n;
  const pinned: FacilitatorReader = {
    call: async (args) => void pins.push(args.blockNumber),
    getBlockNumber: () => head(),
  };
  registerPublicFacilitatorRoutes(app, {
    reader: async () => pinned,
    limit: async () => {},
    now: () => NOW * 1000,
  });
  const verify = async () =>
    app.inject({
      method: 'POST',
      url: `${PUBLIC_FACILITATOR_PATH}/verify`,
      payload: await request(generatePrivateKey()),
    });
  assert.equal((await verify()).json().isValid, true);
  // At a block number the read may be answered by the keyless endpoint when the keyed one is busy.
  assert.deepEqual(pins, [41_000_000n]);
  // The head read failing is not a refusal of the payment: the simulation runs at 'latest'.
  head = async () => {
    throw new Error('429 Too Many Requests');
  };
  assert.equal((await verify()).json().isValid, true);
  assert.deepEqual(pins, [41_000_000n, undefined]);
  // Without pinToHead (the settle path's pre-send check) the simulation is never pinned.
  head = async () => 41_000_001n;
  assert.equal(
    (
      await verifyExactPayment(await request(generatePrivateKey()), {
        reader: pinned,
        nowSeconds: NOW,
      })
    ).isValid,
    true,
  );
  assert.deepEqual(pins, [41_000_000n, undefined, undefined]);
});

test('CCA-704: a payer paying itself is refused by /verify before any chain read', async () => {
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  const body = await request(key, { to: payer });
  body.paymentRequirements.payTo = payer;
  let reads = 0;
  const counting: FacilitatorReader = { call: async () => void reads++ };
  const answer = await verifyExactPayment(body, { reader: counting, nowSeconds: NOW });
  assert.deepEqual(answer, {
    isValid: false,
    invalidReason: 'invalid_payment_requirements',
    payer,
  });
  assert.equal(reads, 0);
});

test('CCA-704: a signature longer than 2 KB is refused before any chain read; a smart-wallet sized one is not', async () => {
  const body = await request(generatePrivateKey());
  let reads = 0;
  const counting: FacilitatorReader = { call: async () => void reads++ };
  body.paymentPayload.payload.signature = `0x${'ab'.repeat(MAX_SIGNATURE_BYTES + 1)}`;
  const long = await verifyExactPayment(body, { reader: counting, nowSeconds: NOW });
  assert.equal(long.isValid ? null : long.invalidReason, 'invalid_exact_evm_payload_signature');
  assert.equal(reads, 0);
  // An ERC-6492 wrapped passkey signature of a counterfactual smart wallet is about 1.5 KB.
  body.paymentPayload.payload.signature = `0x${'ab'.repeat(1_600)}`;
  assert.equal(parseExactPayment(body).ok, true);
  body.paymentPayload.payload.signature = `0x${'ab'.repeat(MAX_SIGNATURE_BYTES)}`;
  assert.equal(parseExactPayment(body).ok, true);
});

test('CCA-704: a reserved payee (treasury, routers, our own senders) is refused by /verify before any chain read', async (t) => {
  const body = await request(generatePrivateKey());
  let reads = 0;
  const counting: FacilitatorReader = { call: async () => void reads++ };
  const reserved = new Set([PAY_TO.toLowerCase()]);
  const answer = await verifyExactPayment(body, { reader: counting, nowSeconds: NOW, reserved });
  assert.equal(answer.isValid ? null : answer.invalidReason, 'invalid_payment_requirements');
  assert.equal(reads, 0);
  // The route reads the reserved set per request; when it cannot, /verify fails closed.
  let failing = false;
  const app = Fastify();
  t.after(() => app.close());
  registerPublicFacilitatorRoutes(app, {
    reader: async () => counting,
    limit: async () => {},
    now: () => NOW * 1000,
    reserved: async () => {
      if (failing) throw new Error('keystore unavailable');
      return reserved;
    },
  });
  const verify = async () =>
    (
      await app.inject({ method: 'POST', url: `${PUBLIC_FACILITATOR_PATH}/verify`, payload: body })
    ).json().invalidReason;
  assert.equal(await verify(), 'invalid_payment_requirements');
  failing = true;
  assert.equal(await verify(), 'unexpected_verify_error');
  assert.equal(reads, 0);
});

test('CCA-123: /verify refuses our paymaster, the EntryPoint, the ERC-8004 registries and the sponsor as payee', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let reads = 0;
  registerPublicFacilitatorRoutes(app, {
    reader: async () => ({ call: async () => void reads++ }),
    limit: async () => {},
    now: () => NOW * 1000,
    // The protocol's reserved payees, as the app's set starts from.
    reserved: async () => reservedPayees(),
  });
  const key = generatePrivateKey();
  for (const payee of [
    '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
    '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    '0x64e8FFB436a236da487d1c20fF2548A70cf82C13',
  ] as const) {
    const body = await request(key, { to: payee });
    body.paymentRequirements.payTo = payee;
    const answer = await app.inject({
      method: 'POST',
      url: `${PUBLIC_FACILITATOR_PATH}/verify`,
      payload: body,
    });
    assert.equal(answer.json().invalidReason, 'invalid_payment_requirements', payee);
  }
  assert.equal(reads, 0);
});

test('parse keeps the exact signed values (no rounding through Number)', async () => {
  const body = await request(generatePrivateKey(), { value: 123_456_789_012_345_678n });
  const parsed = parseExactPayment(body);
  assert.ok(parsed.ok);
  assert.equal(parsed.ok && parsed.payment.authorization.value, 123_456_789_012_345_678n);
});

/*
 * Against a Base fork (anvil --fork-url https://mainnet.base.org --port 8547): USDC itself judges
 * the payment. X402_FORK_RPC turns it on; skipped otherwise.
 */
const FORK = process.env.X402_FORK_RPC;
test(
  'on a Base fork: USDC accepts a funded signed payment, refuses no funds and a bad signature',
  { skip: !FORK },
  async () => {
    const reader = createPublicClient({ chain: base, transport: http(FORK) });
    const anvil = createTestClient({ chain: base, mode: 'anvil', transport: http(FORK) });
    const block = await reader.getBlock();
    const now = Number(block.timestamp);
    const key = generatePrivateKey();
    const payer = privateKeyToAccount(key).address;

    // No USDC yet: the signature is fine, the balance is not.
    const unfunded = await request(key, { validBefore: BigInt(now + 600) });
    const poor = await verifyExactPayment(unfunded, { reader, nowSeconds: now });
    assert.deepEqual(poor, { isValid: false, invalidReason: 'insufficient_funds', payer });

    // A signature by another key for the same payer: USDC says invalid signature.
    const forged = await request(generatePrivateKey(), { validBefore: BigInt(now + 600) });
    forged.paymentPayload.payload.authorization.from = payer;
    const bad = await verifyExactPayment(forged, { reader, nowSeconds: now });
    assert.equal(bad.isValid ? null : bad.invalidReason, 'invalid_exact_evm_payload_signature');

    // Fund the payer on the fork (FiatToken v2.2 keeps balances at storage slot 9) and verify.
    const slot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [payer, 9n]),
    );
    await anvil.setStorageAt({
      address: USDC,
      index: slot,
      value: numberToHex(1_000_000n, { size: 32 }),
    });
    const funded = await verifyExactPayment(unfunded, { reader, nowSeconds: now });
    assert.deepEqual(funded, { isValid: true, payer });
  },
);

test('/settle hands the sender the payment and the exact /verify check; a retry gets the stored settlement', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const sender: Address = '0x00000000000000000000000000000000000000cc';
  // USDC on Base, simplified: the first simulation passes, after the transfer the nonce is used.
  let used = false;
  const chain: FacilitatorReader = {
    call: async (args) => {
      assert.equal(args.account, sender, 'simulated from the public sender');
      if (used) throw new Error('FiatTokenV2: authorization is used or canceled');
    },
  };
  // A sender as PublicSettle requires: its stored settlement (bound to the whole signed intent)
  // first, `verify` only for a new payment.
  const stored = new Map<string, string>();
  let verifies = 0;
  registerPublicFacilitatorRoutes(app, {
    reader: async () => chain,
    limit: async () => {},
    now: () => NOW * 1000,
    settle: {
      address: sender,
      async settle(payment, verify) {
        const intent = JSON.stringify(payment, (_, v) => (typeof v === 'bigint' ? String(v) : v));
        const known = stored.get(intent);
        if (known)
          return {
            success: true,
            transaction: known,
            network: 'eip155:8453',
            payer: payment.authorization.from,
          };
        verifies++;
        const checked = await verify();
        if (!checked.isValid)
          return {
            success: false,
            errorReason: checked.invalidReason,
            transaction: '',
            network: 'eip155:8453',
          };
        const transaction = `0x${'ab'.repeat(32)}`;
        stored.set(intent, transaction);
        used = true;
        return {
          success: true,
          transaction,
          network: 'eip155:8453',
          payer: payment.authorization.from,
        };
      },
    },
  });
  // /supported now names the sender.
  const supported = await app.inject(`${PUBLIC_FACILITATOR_PATH}/supported`);
  assert.deepEqual(supported.json().signers, { 'eip155:*': [sender] });

  const key = generatePrivateKey();
  const post = (payload: object) =>
    app.inject({ method: 'POST', url: `${PUBLIC_FACILITATOR_PATH}/settle`, payload });
  // Malformed: refused before the sender.
  const malformed = await post({ x402Version: 2 });
  assert.equal(malformed.json().success, false);
  assert.equal(malformed.json().errorReason, 'invalid_payment_requirements');
  assert.equal(verifies, 0);
  // A wrong amount reaches the sender, whose verify refuses it: nothing stored.
  const wrong = await post(await request(key, { amount: 20_000n }));
  assert.equal(wrong.json().errorReason, 'invalid_exact_evm_payload_authorization_value');
  assert.equal(stored.size, 0);
  // Settled once …
  const body = await request(key);
  const first = await post(body);
  assert.equal(first.json().success, true);
  // … and the retry (the nonce now used on chain) gets the same settlement, not a refusal.
  const retry = await post(body);
  assert.equal(retry.json().success, true);
  assert.equal(retry.json().transaction, first.json().transaction);
  assert.equal(verifies, 2, 'the retry never re-verified');
  // /verify itself now says the authorization is used: settle's retry answer is the stored one.
  const verified = await app.inject({
    method: 'POST',
    url: `${PUBLIC_FACILITATOR_PATH}/verify`,
    payload: body,
  });
  assert.equal(verified.json().invalidReason, 'invalid_transaction_state');
});

test('CCA-766: /settle hands the sender the calling client, for its per-client gas budget', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const contexts: unknown[] = [];
  registerPublicFacilitatorRoutes(app, {
    reader: async () => null,
    limit: async () => {},
    now: () => NOW * 1000,
    settle: {
      address: '0x00000000000000000000000000000000000000cc',
      async settle(payment, _verify, context) {
        contexts.push(context);
        return {
          success: false,
          errorReason: 'settlement_unavailable',
          transaction: '',
          network: 'eip155:8453',
          payer: payment.authorization.from,
        };
      },
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: `${PUBLIC_FACILITATOR_PATH}/settle`,
    payload: await request(generatePrivateKey()),
    remoteAddress: '::ffff:198.51.100.7',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(contexts, [{ client: '198.51.100.7' }]);
});
