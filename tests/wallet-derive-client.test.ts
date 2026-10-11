import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { setSignedInPerson } from '../src/base/signedInPerson.js';
import { heldOwnerKeys, pinOwnerKey } from '../src/base/vault/keyPin.js';
import { checkOwnWallet, NOT_OWN_WALLET } from '../src/base/wallet/api.js';
import { expectedWallet } from '../src/base/wallet/derive.js';

/*
 * Before a wallet's address is shown (Wallet, Add funds): the vault is the signed-in person's own,
 * the wallet's owner is their key as reported and as this browser held it, and the address is
 * exactly the wallet that key makes for the agent (src/base/wallet/derive.ts). Without a key held
 * here, a consistent report waits for one unlock ('unlock'): a funding address needs 'key'.
 */

const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const OTHER_KEY = `0x${'5d'.repeat(32)}` as Hex;
const OTHER = privateKeyToAccount(OTHER_KEY).address;
const AGENT = '11111111-1111-4111-8111-111111111111';
const WALLET = expectedWallet(OWNER, AGENT);
const refused = { problem: NOT_OWN_WALLET };

/** Each test its own person, so a key held for this page in one test isn't another's. */
let people = 0;
function signIn() {
  const person = `person-${++people}`;
  setSignedInPerson(person);
  return { person, vault: { accountId: person, ownerAddress: OWNER as string | null } };
}

type Storage = Record<string, string> | 'refuses';
function withStorage(entries: Storage, run: () => void) {
  const globals = globalThis as { localStorage?: unknown };
  const before = globals.localStorage;
  const store = new Map(entries === 'refuses' ? [] : Object.entries(entries));
  const refuse = () => {
    throw new Error('SecurityError');
  };
  globals.localStorage =
    entries === 'refuses'
      ? { getItem: refuse, setItem: refuse, removeItem: refuse }
      : {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
          removeItem: (key: string) => void store.delete(key),
        };
  try {
    run();
  } finally {
    globals.localStorage = before;
  }
}

test('the wallet the key makes: shown against a key held here, else it waits for an unlock', () => {
  const { person, vault } = signIn();
  withStorage({}, () =>
    assert.deepEqual(checkOwnWallet({ address: WALLET, ownerAddress: OWNER }, vault, AGENT), {
      problem: null,
      against: 'unlock',
    }),
  );
  withStorage({ [`cc-wallet-key:${person}`]: OWNER }, () =>
    assert.deepEqual(checkOwnWallet({ address: WALLET, ownerAddress: OWNER }, vault, AGENT), {
      problem: null,
      against: 'key',
    }),
  );
});

test('a substituted owner with its own correctly derived wallet is never offered for funds', () => {
  // Every report agrees on OTHER (wallet and vault). No key held here: it waits for an unlock,
  // which opens the person's real envelope and pins OWNER, after which it is refused.
  const { person } = signIn();
  const substituted = { address: expectedWallet(OTHER, AGENT), ownerAddress: OTHER };
  const reported = { accountId: person, ownerAddress: OTHER };
  withStorage({}, () =>
    assert.deepEqual(checkOwnWallet(substituted, reported, AGENT), {
      problem: null,
      against: 'unlock',
    }),
  );
  withStorage({ [`cc-wallet-key:${person}`]: OWNER }, () =>
    assert.deepEqual(checkOwnWallet(substituted, reported, AGENT), refused),
  );
});

test('a substituted address, another owner, or no key reported: not shown', () => {
  const { vault } = signIn();
  withStorage({}, () => {
    // Another address than the key makes for this agent (or for another agent).
    assert.deepEqual(
      checkOwnWallet({ address: expectedWallet(OTHER, AGENT), ownerAddress: OWNER }, vault, AGENT),
      refused,
    );
    assert.deepEqual(
      checkOwnWallet({ address: WALLET, ownerAddress: OWNER }, vault, 'another-agent'),
      refused,
    );
    // The wallet's owner isn't the account's key, or there's no key reported.
    assert.deepEqual(
      checkOwnWallet({ address: expectedWallet(OTHER, AGENT), ownerAddress: OTHER }, vault, AGENT),
      refused,
    );
    assert.deepEqual(
      checkOwnWallet(
        { address: WALLET, ownerAddress: OWNER },
        { ...vault, ownerAddress: null },
        AGENT,
      ),
      refused,
    );
  });
});

test('the key is held per signed-in person, never per the accountId a vault names', () => {
  const { person } = signIn();
  withStorage({ [`cc-wallet-key:${person}`]: OWNER, 'cc-wallet-key:acct-2': OTHER }, () => {
    // A vault for another account than the session's, with its own consistent owner and wallet,
    // even one whose namespace holds a matching key: refused.
    assert.deepEqual(
      checkOwnWallet(
        { address: expectedWallet(OTHER, AGENT), ownerAddress: OTHER },
        { accountId: 'acct-2', ownerAddress: OTHER },
        AGENT,
      ),
      refused,
    );
    // Unlocking that vault pins nothing.
    assert.equal(pinOwnerKey('acct-2', OTHER_KEY), false);
    assert.deepEqual(heldOwnerKeys(), [OWNER]);
  });
  // Nobody signed in: nothing is held and nothing is shown.
  setSignedInPerson(null);
  withStorage({ [`cc-wallet-key:${person}`]: OWNER }, () => {
    assert.deepEqual(heldOwnerKeys(), []);
    assert.deepEqual(
      checkOwnWallet(
        { address: WALLET, ownerAddress: OWNER },
        { accountId: person, ownerAddress: OWNER },
        AGENT,
      ),
      refused,
    );
  });
});

test('storage that refuses the key: held for this page only, never a weaker check', () => {
  const { vault } = signIn();
  withStorage('refuses', () => {
    assert.deepEqual(checkOwnWallet({ address: WALLET, ownerAddress: OWNER }, vault, AGENT), {
      problem: null,
      against: 'unlock',
    });
    // Unlocked here: this page holds it even though storage refused it.
    assert.equal(pinOwnerKey(vault.accountId, OWNER_KEY), true);
    assert.deepEqual(heldOwnerKeys(), [OWNER]);
    assert.deepEqual(checkOwnWallet({ address: WALLET, ownerAddress: OWNER }, vault, AGENT), {
      problem: null,
      against: 'key',
    });
  });
});

test('a key held here that differs from the stored one: both must be the owner', () => {
  const { person, vault } = signIn();
  withStorage({ [`cc-wallet-key:${person}`]: OTHER }, () => {
    pinOwnerKey(person, OWNER_KEY);
    // The page holds OWNER now and storage was overwritten; a stale other value can't come back.
    assert.deepEqual(heldOwnerKeys(), [OWNER]);
  });
  withStorage({ [`cc-wallet-key:${person}`]: getAddress(OTHER) }, () => {
    // This page held OWNER, storage says OTHER (rewritten elsewhere): neither report passes.
    assert.deepEqual(heldOwnerKeys().sort(), [OWNER, OTHER].sort());
    assert.deepEqual(
      checkOwnWallet({ address: WALLET, ownerAddress: OWNER }, vault, AGENT),
      refused,
    );
  });
});

test("a wallet whose address isn't shown yet has nothing to check", () => {
  const { vault } = signIn();
  withStorage({}, () =>
    assert.deepEqual(checkOwnWallet({ address: null, ownerAddress: OWNER }, vault, AGENT), {
      problem: null,
      against: 'unlock',
    }),
  );
});
