import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_MAINNET, BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import {
  transferAuthorizationTypedData,
  type AuthorizationStore,
  type IssuedAuthorization,
} from '../server/base/chain/x402.js';
import { LEG_FEE, LEG_SELLER, router3Nonce } from '../server/feed/pay/router3.js';
import { createSponsorSigner } from '../server/feed/pay/sponsor-signer.js';

const network = BASE_NETWORKS[BASE_MAINNET];
const USDC = network.tokens.USDC!.address as Address;
const ROUTER = `0x${'9'.repeat(40)}` as Address;
const TREASURY = `0x${'7'.repeat(40)}` as Address;
const PAYEE = `0x${'5'.repeat(40)}` as Address;
const REF = `0x${'ab'.repeat(32)}` as Hex;
const NOW = 1_800_000_000_000;

function memoryStore(): AuthorizationStore & { rows: Map<string, IssuedAuthorization> } {
  const rows = new Map<string, IssuedAuthorization>();
  return {
    rows,
    get: async (id) => rows.get(id) ?? null,
    insert: async (row) => {
      if (!rows.has(row.paymentIntentId)) rows.set(row.paymentIntentId, row);
      return rows.get(row.paymentIntentId)!;
    },
  };
}

function setup(keyFor?: ReturnType<typeof privateKeyToAccount>) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signing = keyFor ?? account;
  const store = memoryStore();
  const clock = { now: NOW };
  let signs = 0;
  let treasuryReads = 0;
  const signer = createSponsorSigner({
    network,
    keystore: {
      withSigner: async (_ref, use) => {
        signs += 1;
        return use(signing);
      },
    },
    keyRef: 'v1:sponsor',
    sponsor: account.address as Address,
    token: USDC,
    store,
    now: () => clock.now,
    router: ROUTER,
    treasuryOf: async () => {
      treasuryReads += 1;
      return TREASURY;
    },
  });
  return {
    account,
    store,
    clock,
    signer,
    signs: () => signs,
    treasuryReads: () => treasuryReads,
  };
}

const purchase = { key: 'sfp:c1', payee: PAYEE, gross: 1_000_000n, ref: REF, validitySeconds: 600 };

test('sponsor legs: ECDSA by the sponsor EOA, router-3 nonces, exact 90/10 split, one window', async () => {
  const f = setup();
  const { seller, fee } = await f.signer.router3Legs(purchase);
  const validBefore = BigInt(NOW / 1000 + 600);
  for (const [leg, to, value, which] of [
    [seller, PAYEE, 900_000n, LEG_SELLER],
    [fee, TREASURY, 100_000n, LEG_FEE],
  ] as const) {
    assert.equal(leg.authorization.from, f.account.address);
    assert.equal(leg.authorization.to, getAddress(to));
    assert.equal(leg.authorization.value, value);
    assert.equal(leg.authorization.validAfter, 0n);
    assert.equal(leg.authorization.validBefore, validBefore);
    assert.equal(
      leg.authorization.nonce,
      router3Nonce({
        chainId: BASE_MAINNET,
        router: ROUTER,
        treasury: TREASURY,
        payer: f.account.address as Address,
        payee: PAYEE,
        gross: 1_000_000n,
        ref: REF,
        validAfter: 0n,
        validBefore,
        leg: which,
      }),
    );
    const recovered = await recoverTypedDataAddress({
      ...transferAuthorizationTypedData(network, USDC, leg.authorization),
      signature: leg.signature,
    });
    assert.equal(recovered, f.account.address, 'a plain EOA signature USDC verifies as ECDSA');
  }
});

test('sponsor legs: the fee is router 3 rounding (floor 10%), never a caller value', async () => {
  const f = setup();
  const { seller, fee } = await f.signer.router3Legs({ ...purchase, gross: 1_234_567n });
  assert.equal(fee.authorization.value, 123_456n);
  assert.equal(seller.authorization.value, 1_234_567n - 123_456n);
});

test('sponsor legs: hard cap in the signer, 0.05 to 2 USDC, nothing signed outside it', async () => {
  const f = setup();
  for (const gross of [2_000_001n, 100_000_000n, 49_999n, 0n])
    await assert.rejects(
      f.signer.router3Legs({ ...purchase, key: `sfp:g${gross}`, gross }),
      /0\.05 to 2 USDC/,
    );
  assert.equal(f.signs(), 0);
  assert.equal(f.store.rows.size, 0);
  const top = await f.signer.router3Legs({ ...purchase, key: 'sfp:max', gross: 2_000_000n });
  assert.equal(top.seller.authorization.value + top.fee.authorization.value, 2_000_000n);
});

test('sponsor legs: router and treasury come from configuration, the treasury read once', async () => {
  const f = setup();
  await f.signer.router3Legs(purchase);
  await f.signer.router3Legs({ ...purchase, key: 'sfp:c2' });
  assert.equal(f.treasuryReads(), 1);
  // Extra fields a caller might pass are not part of the input and cannot redirect a leg.
  const sneaky = { ...purchase, key: 'sfp:c3', treasury: PAYEE, router: PAYEE } as typeof purchase;
  const { fee } = await f.signer.router3Legs(sneaky);
  assert.equal(fee.authorization.to, getAddress(TREASURY));
});

test('sponsor legs: a retry returns the stored pair unchanged, even after time passed', async () => {
  const f = setup();
  const first = await f.signer.router3Legs(purchase);
  f.clock.now += 120_000;
  const again = await f.signer.router3Legs(purchase);
  assert.deepEqual(again, first);
  assert.equal(f.signs(), 2, 'signed once per leg, never again');
  await assert.rejects(
    f.signer.router3Legs({ ...purchase, gross: 2_000_000n }),
    /different authorization/,
  );
});

test('sponsor legs: a key that is not the sponsor never signs; empty window refused', async () => {
  const wrong = setup(privateKeyToAccount(generatePrivateKey()));
  await assert.rejects(wrong.signer.router3Legs(purchase), /does not match the sponsor/);
  assert.equal(wrong.store.rows.size, 0);
  const f = setup();
  await assert.rejects(
    f.signer.router3Legs({ ...purchase, key: 'sfp:c2', validitySeconds: 0 }),
    /window/,
  );
});
