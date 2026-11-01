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
import { createSponsorSigner, type SponsorReservation } from '../server/feed/pay/sponsor-signer.js';
import { PROTOCOL_BASE_MAINNET, X402_FACILITATOR_BASE_MAINNET } from '../shared/protocol.js';

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
  // The stored reservations the signer reads itself (by key); a real user's credit by default.
  const held = new Map<string, SponsorReservation>();
  const hold = (key: string, gross: bigint, o: Partial<SponsorReservation> = {}) => {
    held.set(key, {
      grossRaw: gross,
      payTo: PAYEE,
      callFleet: false,
      creditFleet: false,
      creditAmountRaw: gross,
      creditState: 'reserved',
      callAgentId: 'agent-1',
      creditAgentId: 'agent-1',
      creditChainId: BASE_MAINNET,
      ...o,
    });
  };
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
    reservationOf: async (key) => held.get(key) ?? null,
  });
  return {
    account,
    store,
    clock,
    signer,
    hold,
    signs: () => signs,
    treasuryReads: () => treasuryReads,
  };
}

const purchase = { key: 'sfp:c1', payee: PAYEE, gross: 1_000_000n, ref: REF, validitySeconds: 600 };

test('sponsor legs: ECDSA by the sponsor EOA, router-3 nonces, exact 90/10 split, one window', async () => {
  const f = setup();
  f.hold(purchase.key, purchase.gross);
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
  f.hold(purchase.key, 1_234_567n);
  const { seller, fee } = await f.signer.router3Legs({ ...purchase, gross: 1_234_567n });
  assert.equal(fee.authorization.value, 123_456n);
  assert.equal(seller.authorization.value, 1_234_567n - 123_456n);
});

test('sponsor legs: hard caps by the STORED kind: a real user 0.05 to 2 USDC, a fleet credit to 40', async () => {
  const f = setup();
  const fleet = { callFleet: true, creditFleet: true };
  // A real user's reservation: nothing above 2 USDC is signed, even if the row says so.
  for (const gross of [2_000_001n, 40_000_000n, 49_999n]) {
    f.hold(`sfp:u${gross}`, gross);
    await assert.rejects(
      f.signer.router3Legs({ ...purchase, key: `sfp:u${gross}`, gross }),
      /0\.05 to 2 USDC/,
    );
  }
  // A fleet reservation: up to 40 USDC, never more.
  for (const gross of [40_000_001n, 100_000_000n, 49_999n]) {
    f.hold(`sfp:f${gross}`, gross, fleet);
    await assert.rejects(
      f.signer.router3Legs({ ...purchase, key: `sfp:f${gross}`, gross }),
      /fleet price is 0\.05 to 40 USDC/,
    );
  }
  assert.equal(f.signs(), 0);
  assert.equal(f.store.rows.size, 0);
  f.hold('sfp:umax', 2_000_000n);
  const user = await f.signer.router3Legs({ ...purchase, key: 'sfp:umax', gross: 2_000_000n });
  assert.equal(user.seller.authorization.value + user.fee.authorization.value, 2_000_000n);
  f.hold('sfp:fmax', 40_000_000n, fleet);
  const top = await f.signer.router3Legs({ ...purchase, key: 'sfp:fmax', gross: 40_000_000n });
  assert.equal(top.seller.authorization.value + top.fee.authorization.value, 40_000_000n);
  assert.equal(top.fee.authorization.value, 4_000_000n, 'router 3 rounding: 10 % of 40 USDC');
});

test('sponsor legs: only for a matching stored reservation; a caller cannot pick amount, payee or kind', async () => {
  const f = setup();
  const sign = (key: string, gross: bigint, payee: Address = PAYEE) =>
    f.signer.router3Legs({ ...purchase, key, gross, payee });
  const none = /No matching sponsored reservation/;
  // No reservation behind the key: a direct call signs nothing.
  await assert.rejects(sign('sfp:unknown', 1_000_000n), none);
  // A real user's 1 USDC reservation: asking 20 USDC under its key is refused.
  f.hold('sfp:r1', 1_000_000n);
  await assert.rejects(sign('sfp:r1', 20_000_000n), none);
  // Another payee than the stored one.
  await assert.rejects(sign('sfp:r1', 1_000_000n, `0x${'4'.repeat(40)}` as Address), none);
  // A forged kind: the call row says fleet and the credit does not, or the other way round.
  f.hold('sfp:forged1', 20_000_000n, { callFleet: true, creditFleet: false });
  await assert.rejects(sign('sfp:forged1', 20_000_000n), none);
  f.hold('sfp:forged2', 20_000_000n, { callFleet: false, creditFleet: true });
  await assert.rejects(sign('sfp:forged2', 20_000_000n), none);
  // The credit's amount differs from the call's.
  f.hold('sfp:amount', 20_000_000n, {
    callFleet: true,
    creditFleet: true,
    creditAmountRaw: 2_000_000n,
  });
  await assert.rejects(sign('sfp:amount', 20_000_000n), none);
  // Another agent's credit joined to this call, or a credit of another chain.
  f.hold('sfp:agent', 1_000_000n, { creditAgentId: 'agent-2' });
  await assert.rejects(sign('sfp:agent', 1_000_000n), none);
  f.hold('sfp:chain', 1_000_000n, { creditChainId: 84532 });
  await assert.rejects(sign('sfp:chain', 1_000_000n), none);
  // A used credit with no stored legs: never a fresh authorization.
  f.hold('sfp:usednew', 1_000_000n, { creditState: 'used' });
  await assert.rejects(sign('sfp:usednew', 1_000_000n), none);
  // A released credit (the call was never paid) is not signed for.
  f.hold('sfp:released', 1_000_000n, { creditState: 'released' });
  await assert.rejects(sign('sfp:released', 1_000_000n), none);
  assert.equal(f.signs(), 0, 'nothing signed for any of these');
  assert.equal(f.store.rows.size, 0);
  // A used credit (paid; the call is handed over again) still gets its stored legs.
  f.hold('sfp:used', 1_000_000n);
  const first = await sign('sfp:used', 1_000_000n);
  f.hold('sfp:used', 1_000_000n, { creditState: 'used' });
  assert.deepEqual(await sign('sfp:used', 1_000_000n), first);
});

test('sponsor legs: never for a reserved payee (a fee router, the treasury, USDC, the facilitator, this router, the sponsor)', async () => {
  const f = setup();
  const d = PROTOCOL_BASE_MAINNET;
  const payees = [
    d.feeRouter,
    d.feeRouter2,
    d.feeRouter3,
    d.treasury,
    d.usdc,
    X402_FACILITATOR_BASE_MAINNET,
    ROUTER,
    TREASURY,
    f.account.address as Address,
    `0x${'0'.repeat(40)}` as Address,
  ];
  for (const [i, payee] of payees.entries()) {
    const key = `sfp:reserved${i}`;
    f.hold(key, purchase.gross, { payTo: payee });
    await assert.rejects(
      f.signer.router3Legs({ ...purchase, key, payee }),
      /cannot be paid/,
      payee,
    );
  }
  assert.equal(f.signs(), 0, 'nothing signed');
  assert.equal(f.store.rows.size, 0);
});

test('sponsor legs: router and treasury come from configuration, the treasury read once', async () => {
  const f = setup();
  for (const key of ['sfp:c1', 'sfp:c2', 'sfp:c3']) f.hold(key, purchase.gross);
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
  f.hold(purchase.key, purchase.gross);
  const first = await f.signer.router3Legs(purchase);
  f.clock.now += 120_000;
  const again = await f.signer.router3Legs(purchase);
  assert.deepEqual(again, first);
  assert.equal(f.signs(), 2, 'signed once per leg, never again');
  // Another amount under the same key: the stored reservation says 1 USDC, so nothing is signed.
  await assert.rejects(
    f.signer.router3Legs({ ...purchase, gross: 2_000_000n }),
    /No matching sponsored reservation/,
  );
  // Should the stored row itself change, the stored legs still never get a second pair.
  f.hold(purchase.key, 2_000_000n);
  await assert.rejects(
    f.signer.router3Legs({ ...purchase, gross: 2_000_000n }),
    /different authorization/,
  );
});

test('sponsor legs: a key that is not the sponsor never signs; empty window refused', async () => {
  const wrong = setup(privateKeyToAccount(generatePrivateKey()));
  wrong.hold(purchase.key, purchase.gross);
  await assert.rejects(wrong.signer.router3Legs(purchase), /does not match the sponsor/);
  assert.equal(wrong.store.rows.size, 0);
  const f = setup();
  f.hold('sfp:c2', purchase.gross);
  await assert.rejects(
    f.signer.router3Legs({ ...purchase, key: 'sfp:c2', validitySeconds: 0 }),
    /window/,
  );
});
