// The Arc mainnet deploy page's fixed values and checks, apart from the page so they can be tested
// (tests/deploy-arc-page.test.ts). Plain script, no dependencies; functions that hash take keccak.js
// (window.kitKeccak) as an argument. guard.js stays Base's: only its latch and runtimeCheck are used.
(function (root) {
  const GWEI = 10n ** 9n;
  const USDC = 10n ** 18n; // Arc's native balance: 18 decimals

  // Arc mainnet, and only Arc mainnet: there is no setting, parameter or kit field that changes these.
  const CHAIN = '0x13b2'; // 5042
  const PUBLIC_RPC = 'https://rpc.mainnet.arc.io';
  const EXPLORER = 'https://explorer.arc.io';
  const NETWORK = {
    chainId: CHAIN,
    chainName: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: [PUBLIC_RPC],
    blockExplorerUrls: [EXPLORER],
  };
  const ARC_USDC = '0x3600000000000000000000000000000000000000';
  const TREASURY = '0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9';
  const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
  const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

  // The hashes the page accepts; a kit that differs in one byte blocks every step.
  const APPROVED = {
    validator: {
      address: '0xcfCE48B757601F3f351CB6f434CB0517aEEE293D',
      inputSha: '0xa549ec593e1c2c33716cdfae9a7baf5ad53fdecf57dd61c33b30253909c1f64f',
      runtimeSha: '0x94a000eab18fdda0465241bd0e82487463fb2e539854a3645542e57ed8dde484',
    },
    manager: {
      address: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
      inputSha: '0xffc7d550cab0084a086164a14a7415b7a0bcce28c135793e852b478d4b261dbf',
      // Base's code with chain id 5042 and its domain separator: the two words its constructor binds.
      runtimeSha: '0xde2f9a1d84ec864182d0c6e114e246d57d03c2d27d39a2fd2cd5ca33ff830c65',
    },
    paymaster: {
      initSha: '0x002bcea12d929f798854493cc9b2ba43edc0790f90eaa8d16c8ccf43ae5d50bc',
      runtimeSha: '0x4cf2309390afafca14fdedb734f3adee5abe21e0d27f27a36fa5b4f46712b97c',
    },
    router: {
      bytecodeSha: '0xb6487fd6d04c12fe42b1ba4d1d67fa4577f3c274afc0bc7acdc8c6ad21d97935',
      runtimeMaskedSha: '0x8ade802a7b12a6342e62e43d9e1dd047f14934554b43ad11edf7da78fc389a9c',
    },
  };

  /*
   * Fees are fixed. Under 20 gwei a transaction is not dropped: it sits in the node and blocks the
   * nonce until replaced at a higher fee (docs/arc/TESTNET.md). The 5 gwei tip on the 20 gwei base
   * fee pays 25 gwei; the cap is 30. A base fee too close to the cap refuses, and never lowers it.
   */
  const FEE_FLOOR = 20n * GWEI;
  const MAX_FEE = 30n * GWEI;
  const TIP = 5n * GWEI;
  const fees = (baseFee) =>
    baseFee + GWEI > MAX_FEE ? null : { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP };

  // Ceilings on each step's gas: the dry run's estimate plus 20% must fit under them.
  const GAS_CAP = {
    validator: 400000n,
    manager: 4000000n,
    router: 1500000n,
    paymaster: 2600000n,
    allowlist: 200000n,
    deposit: 200000n,
    submitter: 200000n,
    facilitator: 200000n,
  };
  const gasFor = (step, estimate) => {
    const gas = (estimate * 12n) / 10n;
    return gas > GAS_CAP[step] ? null : gas;
  };

  // Amounts, from server/base/chain/chain-params.ts (Arc's).
  const RESERVE = 10n * USDC; // budget.protectedWei
  const LIMITS = {
    // hotWallets.paymaster_submitter ceiling, submitterReserveWei
    submitter: { above: USDC / 20n, atMost: 100n * USDC },
    // hotWallets.router3_facilitator ceiling, facilitator.minBalanceWei
    facilitator: { above: USDC, atMost: 50n * USDC },
  };

  /** Exact decimal USDC to native wei, or null: never through a float. */
  const parseUsdc = (text) => {
    const m = /^(\d{1,9})(?:\.(\d{1,18}))?$/.exec(String(text).trim());
    if (!m) return null;
    return BigInt(m[1]) * USDC + BigInt((m[2] || '').padEnd(18, '0') || '0');
  };
  const showUsdc = (wei) => {
    const rest = (wei % USDC).toString().padStart(18, '0').replace(/0+$/, '');
    return (wei / USDC).toString() + (rest ? '.' + rest : '');
  };

  /** The deposit: why it can't be sent, or null. It must be above the protected reserve. */
  const depositRefusal = (text) => {
    const wei = parseUsdc(text);
    if (wei === null) return 'The deposit is not an amount in USDC.';
    if (wei <= RESERVE)
      return (
        'The deposit must be above ' +
        showUsdc(RESERVE) +
        " USDC, Arc's protected reserve: at or under it, every ordinary flow is refused."
      );
    return null;
  };
  const fundRefusal = (who, text) => {
    const wei = parseUsdc(text);
    const limit = LIMITS[who];
    if (wei === null) return 'The ' + who + ' amount is not an amount in USDC.';
    if (wei <= limit.above)
      return (
        'The ' +
        who +
        ' amount must be above ' +
        showUsdc(limit.above) +
        ' USDC: at or under it, the server refuses to send.'
      );
    if (wei > limit.atMost)
      return (
        'The ' +
        who +
        ' amount must be at most ' +
        showUsdc(limit.atMost) +
        " USDC, this role's limit on the server."
      );
    return null;
  };

  const strip = (hex) => String(hex).toLowerCase().replace(/^0x/, '');
  const word = (hex) => strip(hex).padStart(64, '0');
  const same = (a, b) => strip(a) === strip(b);

  /** Whether text is a usable address: 20 bytes, not zero, and its checksum right if it has one. */
  function isAddress(text, keccak) {
    const value = String(text).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) return false;
    const hex = value.slice(2);
    if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
    return checksummed(hex, keccak) === hex;
  }
  function checksummed(hex, keccak) {
    const lower = hex.toLowerCase();
    const hash = strip(keccak.keccak256(Uint8Array.from(lower, (c) => c.charCodeAt(0))));
    return Array.from(lower, (c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
  }

  const addressFrom = (hashHex) => '0x' + strip(hashHex).slice(-40);

  /** Where a deployer call lands: a 32-byte salt, then the init code, no selector. */
  function create2Address(deployer, input, keccak) {
    const hex = strip(input);
    const initHash = strip(keccak.keccak256(keccak.hexToBytes(hex.slice(64))));
    return addressFrom(
      keccak.keccak256(keccak.hexToBytes('ff' + strip(deployer) + hex.slice(0, 64) + initHash)),
    );
  }

  /** Where this account's contract creation at this nonce landed (RLP of address and nonce). */
  function createAddress(from, nonce, keccak) {
    let tail;
    if (nonce === 0) tail = '80';
    else if (nonce < 0x80) tail = nonce.toString(16).padStart(2, '0');
    else {
      let hex = nonce.toString(16);
      if (hex.length % 2) hex = '0' + hex;
      tail = (0x80 + hex.length / 2).toString(16) + hex;
    }
    const body = '94' + strip(from) + tail;
    const list = (0xc0 + body.length / 2).toString(16) + body;
    return addressFrom(keccak.keccak256(keccak.hexToBytes(list)));
  }

  /** Every check on the two kit files, as rows: nothing is sent unless all pass. */
  function checkKits(arc, router, keccak) {
    const rows = [];
    const add = (key, ok, good, bad) => rows.push({ key, ok, text: ok ? good : bad });
    const hash = (hex) => {
      try {
        return keccak.keccak256(keccak.hexToBytes(hex));
      } catch {
        return '';
      }
    };
    const replays = (arc && arc.replays) || [];
    add(
      'Kit network',
      Boolean(arc) && arc.chainId === 5042 && same(arc.create2Deployer, DEPLOYER),
      'Arc mainnet, the standard CREATE2 deployer',
      'Not for Arc mainnet: everything blocked',
    );
    [
      ['PublicERC6492Validator', 0, APPROVED.validator],
      ['SpendPermissionManager', 1, APPROVED.manager],
    ].forEach(([name, at, approved]) => {
      const replay = replays[at] || {};
      add(
        name + ' input',
        replay.name === name && hash(replay.input) === approved.inputSha,
        'Computed hash matches the approved hash',
        'MISMATCH: everything blocked',
      );
      let lands = '';
      try {
        lands = create2Address(DEPLOYER, replay.input, keccak);
      } catch {
        lands = '';
      }
      add(
        name + ' address',
        same(lands, approved.address) && same(String(replay.address), approved.address),
        approved.address + ', recomputed from the input',
        'The input lands on ' + (lands || 'nothing') + ': everything blocked',
      );
      add(
        name + ' code',
        hash(replay.runtime) === approved.runtimeSha,
        'The expected code for Arc, hash approved',
        'MISMATCH: everything blocked',
      );
    });
    const paymaster = (arc && arc.paymaster) || {};
    add(
      'VerifyingPaymaster init code',
      hash(paymaster.initCode) === APPROVED.paymaster.initSha &&
        strip(paymaster.initCode).endsWith(word(ENTRY_POINT)),
      'Computed hash matches the approved hash; entryPoint word in place',
      'MISMATCH: everything blocked',
    );
    add(
      'VerifyingPaymaster code',
      hash(paymaster.runtime) === APPROVED.paymaster.runtimeSha,
      "Base's code, hash approved",
      'MISMATCH: everything blocked',
    );
    const computed = hash(router && router.bytecode);
    add(
      'Fee router 3 bytecode',
      computed === APPROVED.router.bytecodeSha &&
        Boolean(router) &&
        String(router.bytecodeSha).toLowerCase() === computed &&
        String(router.runtimeMaskedSha).toLowerCase() === APPROVED.router.runtimeMaskedSha,
      'Computed hash matches the approved hash',
      'MISMATCH: everything blocked',
    );
    return rows;
  }

  const api = {
    CHAIN,
    PUBLIC_RPC,
    EXPLORER,
    NETWORK,
    ARC_USDC,
    TREASURY,
    ENTRY_POINT,
    DEPLOYER,
    APPROVED,
    FEE_FLOOR,
    MAX_FEE,
    TIP,
    fees,
    gasFor,
    RESERVE,
    LIMITS,
    parseUsdc,
    showUsdc,
    depositRefusal,
    fundRefusal,
    word,
    same,
    isAddress,
    create2Address,
    createAddress,
    checkKits,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.arcGuard = api;
})(typeof window !== 'undefined' ? window : globalThis);
