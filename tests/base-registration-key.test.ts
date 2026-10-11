import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BaseRegistrationController,
  type ControllerDeps,
  type OwnerMode,
} from '../src/base/baseRegistrationController';

/*
 * Registering with the person's wallet key (decision A, one wallet): the request carries only the
 * wallet this browser derived from the key it held, never an owner; an answer naming any other
 * wallet or owner is refused; a registration in progress continues only with that key; nothing
 * resumes before the screen knows whether wallets are on.
 */

const KEY = `0x${'aa'.repeat(20)}`;
const OTHER = `0x${'bb'.repeat(20)}`;
const DERIVED = `0x${'cd'.repeat(20)}`;
const ELSEWHERE = `0x${'ef'.repeat(20)}`;
let ids = 0;
const agent = () => `key-${++ids}-0000-4000-8000-000000000000`;
const held = { kind: 'key' as const, key: { owner: KEY, expectedWallet: DERIVED } };

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  reply: (status: number, json: unknown) => Promise<void>;
  settled: boolean;
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function harness() {
  const calls: Call[] = [];
  const deps: ControllerDeps = {
    fetch: ((url: string, init: RequestInit) =>
      new Promise((resolve) => {
        const call: Call = {
          url,
          method: init.method ?? 'GET',
          body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
          settled: false,
          reply: async (status, json) => {
            call.settled = true;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => json,
              headers: { get: () => null },
            } as unknown as Response);
            await settle();
          },
        };
        calls.push(call);
      })) as unknown as typeof fetch,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => 1_000_000,
  };
  const open = (method?: string) =>
    calls.filter((call) => !call.settled && (!method || call.method === method));
  return { calls, deps, open };
}

const registering = { state: 'submitted', stage: 'registering', erc8004AgentId: null };

async function started(
  h: ReturnType<typeof harness>,
  id: string,
  mode: OwnerMode | undefined,
  identities: unknown[] = [],
) {
  const c = new BaseRegistrationController(id, null, { deps: h.deps, ownerMode: mode });
  c.start();
  await h.open('GET')[0]!.reply(200, { identities });
  return c;
}

test('with the wallet key, the request carries only the derived wallet, never an owner address', async () => {
  const h = harness();
  const c = await started(h, agent(), held);
  c.submit();
  await settle();
  const post = h.open('POST')[0]!;
  assert.deepEqual(post.body, { expectedWallet: DERIVED });
  await post.reply(200, {
    wallet: { address: DERIVED, ownerAddress: KEY, state: 'derived' },
    identity: registering,
  });
  assert.equal(c.getSnapshot().error, '');
  assert.equal(c.getSnapshot().wallet?.address, DERIVED);
  c.stop();
});

test('no key held yet: nothing is sent, and the screen is told to unlock first', async () => {
  const h = harness();
  const c = await started(h, agent(), { kind: 'key', key: null });
  c.setAddress(OTHER); // a typed address never counts with the wallet key
  c.submit();
  c.askMakePublic();
  c.retryNow();
  await settle();
  assert.equal(h.open('POST').length, 0);
  assert.equal(c.getSnapshot().error, 'Unlock your wallet key first.');
  c.stop();
});

test('an answer naming another wallet or another owner than the derived one is refused', async () => {
  for (const wallet of [
    { address: ELSEWHERE, ownerAddress: KEY },
    { address: DERIVED, ownerAddress: OTHER },
    null,
  ]) {
    const h = harness();
    const c = await started(h, agent(), held);
    c.submit();
    await settle();
    await h.open('POST')[0]!.reply(200, { wallet, identity: registering });
    assert.match(c.getSnapshot().error, /isn’t the one your key makes/);
    assert.equal(c.getSnapshot().identity, null, 'nothing of it is shown as registered');
    c.stop();
  }
});

test('the key flow’s refusals read plainly, and another owner is never taken over', async () => {
  const cases: Array<[string, RegExp]> = [
    ['wallet_key_required', /Set up your wallet key first/],
    ['backup_required', /Confirm your backup key first/],
    ['wallet_mismatch', /isn’t the wallet your key makes.*Nothing was registered/],
    ['wallets_off', /isn’t available right now/],
    ['wallet_conflict', /another key controls/],
  ];
  for (const [code, text] of cases) {
    const h = harness();
    const c = await started(h, agent(), held);
    c.submit();
    await settle();
    await h.open('POST')[0]!.reply(409, {
      error: 'Refused.',
      code,
      ownerAddress: OTHER,
      details: { ownerAddress: OTHER },
    });
    assert.match(c.getSnapshot().error, text, code);
    assert.equal(c.getSnapshot().conflict, null, `${code}: no "use that wallet" offer`);
    c.continueWithBound(OTHER, false);
    await settle();
    assert.equal(h.open('POST').length, 0, `${code}: never continues with another owner`);
    c.stop();
  }
});

test('a registration in progress continues only with the held key, never with another bound owner', async () => {
  // Bound to the key: it continues, with the derived wallet only.
  let h = harness();
  let c = await started(h, agent(), held, [
    { chainId: 8453, ...registering, wallet: { address: DERIVED, ownerAddress: KEY } },
  ]);
  assert.deepEqual(h.open('POST')[0]?.body, { expectedWallet: DERIVED });
  c.stop();
  // Bound to another owner (an address registration from before): nothing is sent.
  h = harness();
  c = await started(h, agent(), held, [
    { chainId: 8453, ...registering, wallet: { address: ELSEWHERE, ownerAddress: OTHER } },
  ]);
  c.checkAgain();
  await settle();
  assert.equal(h.open('POST').length, 0);
  c.stop();
});

test('nothing resumes before the mode is known; then it resumes with the mode’s owner', async () => {
  const row = { chainId: 8453, ...registering, wallet: { address: DERIVED, ownerAddress: KEY } };
  // The status answers before the screen knows whether wallets are on: nothing is sent yet.
  const h = harness();
  const c = await started(h, agent(), { kind: 'pending' }, [row]);
  assert.equal(h.open('POST').length, 0);
  c.submit();
  c.retryNow();
  c.checkAgain();
  c.continueWithBound(OTHER, false);
  await settle();
  assert.equal(h.open('POST').length, 0, 'no action while pending');
  // Wallets are on and the key is held: it continues with the derived wallet.
  c.setMode(held);
  await settle();
  assert.deepEqual(h.open('POST')[0]?.body, { expectedWallet: DERIVED });
  c.stop();

  // Wallets are off: it continues exactly as before, with the bound owner address.
  const h2 = harness();
  const c2 = await started(h2, agent(), { kind: 'pending' }, [
    { ...row, wallet: { address: ELSEWHERE, ownerAddress: OTHER } },
  ]);
  c2.setMode({ kind: 'address' });
  await settle();
  assert.deepEqual(h2.open('POST')[0]?.body, { ownerAddress: OTHER });
  c2.stop();
});

test('without the wallet key (wallets off), the typed address goes as before', async () => {
  const h = harness();
  const c = await started(h, agent(), undefined);
  c.setAddress(OTHER);
  c.submit();
  await settle();
  assert.deepEqual(h.open('POST')[0]?.body, { ownerAddress: OTHER });
  c.stop();
});
