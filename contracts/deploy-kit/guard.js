// The deploy page's checks, apart from the page so they can be tested (tests/deploy-page.test.ts).
// Plain script, no dependencies; runtimeCheck takes keccak.js (window.kitKeccak) as an argument.
(function (root) {
  // Base mainnet: every deploy transaction names it, and every read-back requires it.
  const BASE = '0x2105';
  // Read-backs never trust the wallet's node alone: the code and the getters are read from this
  // fixed public Base endpoint too.
  const PUBLIC_RPC = 'https://mainnet.base.org';

  /** The eth_sendTransaction parameters: bound to Base, so a wallet on another chain refuses it. */
  const deployTx = (from, data) => ({ from, data, chainId: BASE });

  /*
   * Deploy-once latch, per router, in localStorage (shared by every tab of this origin). It holds
   * 'pending:<ms>' from just before the wallet is asked until the wallet answers, then the
   * transaction hash. Only a rejection in the wallet (code 4001) clears a pending marker: any
   * other outcome may have sent a transaction, so the page stays blocked until a person checks.
   */
  const latchRead = (storage, key) => {
    let value = null;
    try {
      value = storage.getItem(key);
    } catch {
      value = 'unreadable';
    }
    if (!value) return { blocked: false, pending: false, hash: null };
    const pending = value.startsWith('pending:') || value === 'unreadable';
    return { blocked: true, pending, hash: pending ? null : value };
  };
  /** Writes the pending marker; false when storage cannot hold it (then the page must not send). */
  const latchPending = (storage, key, now) => {
    try {
      storage.setItem(key, 'pending:' + now);
      return storage.getItem(key) === 'pending:' + now;
    } catch {
      return false;
    }
  };
  const latchSent = (storage, key, hash) => {
    try {
      storage.setItem(key, hash);
    } catch {
      /* the pending marker stays: still blocked */
    }
  };
  /** Only for a rejection in the wallet (code 4001): nothing was sent. */
  const latchRejected = (storage, key) => {
    try {
      if (String(storage.getItem(key)).startsWith('pending:')) storage.removeItem(key);
    } catch {
      /* stays blocked */
    }
  };

  const strip = (hex) => String(hex).toLowerCase().replace(/^0x/, '');
  const word = (address) => strip(address).padStart(64, '0');

  /**
   * Whether deployed runtime `code` is exactly the kit's contract with `usdc` and `treasury` as its
   * immutables: every immutable range must hold its expected word, and the code with those ranges
   * zeroed must hash to the kit's runtimeMaskedSha. Returns { ok, reason }.
   */
  function runtimeCheck(code, kit, usdc, treasury, keccak) {
    const hex = strip(code);
    if (!kit || !kit.runtimeMaskedSha || !kit.immutables)
      return { ok: false, reason: 'the kit has no runtime hash' };
    if (hex.length !== kit.runtimeSize * 2)
      return { ok: false, reason: 'code size ' + hex.length / 2 + ' is not ' + kit.runtimeSize };
    const expected = { token: word(usdc), treasury: word(treasury) };
    const names = Object.keys(kit.immutables).sort();
    if (names.join() !== 'token,treasury')
      return { ok: false, reason: 'unexpected immutables ' + names.join() };
    let masked = hex;
    for (const name of names)
      for (const range of kit.immutables[name]) {
        const at = range.start * 2;
        const value = hex.slice(at, at + range.length * 2);
        if (range.length !== 32 || value !== expected[name])
          return {
            ok: false,
            reason: name + ' at byte ' + range.start + ' is not the expected value',
          };
        masked = masked.slice(0, at) + '0'.repeat(64) + masked.slice(at + 64);
      }
    const hash = keccak.keccak256(keccak.hexToBytes(masked));
    if (hash !== String(kit.runtimeMaskedSha).toLowerCase())
      return { ok: false, reason: 'runtime code hash ' + hash + ' is not the kit hash' };
    return { ok: true, reason: 'matches the kit' };
  }

  /** The "Next" step is shown only when every read-back row passed. */
  const allPassed = (rows) => rows.length > 0 && rows.every((row) => row.ok === true);

  const api = {
    BASE,
    PUBLIC_RPC,
    deployTx,
    latchRead,
    latchPending,
    latchSent,
    latchRejected,
    runtimeCheck,
    allPassed,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.kitGuard = api;
})(typeof window !== 'undefined' ? window : globalThis);
