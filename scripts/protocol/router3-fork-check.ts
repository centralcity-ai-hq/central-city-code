/*
 * Operation x402: CentralCityFeeRouter3 against the REAL Base USDC (FiatToken v2.2, EIP-3009) on a
 * local fork of Base mainnet (no real funds: Anvil dev keys, balances set locally). Checks the
 * fee-included settlement from two buyer authorizations, for an EOA buyer and for a contract wallet
 * buyer (ERC-1271), the bindings, replay, a leg used outside the router, the batch path, the caps,
 * and measures gas.
 *   anvil --fork-url https://mainnet.base.org --port 8549
 *   pnpm tsx scripts/protocol/router3-fork-check.ts [rpcUrl]
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  hashTypedData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const require = createRequire(import.meta.url);
const solc = require('solc');
const RPC = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8549';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
// Fresh keys each run: Anvil's well-known dev accounts carry EIP-7702 delegations on Base mainnet,
// so on a fork USDC would treat them as contract wallets.
const BUYER_KEY = generatePrivateKey();
const WALLET_OWNER_KEY = generatePrivateKey();
const TREASURY_KEY = generatePrivateKey();
const CSW_OWNER_KEY = generatePrivateKey();
// Coinbase Smart Wallet factory on Base (the agents' spender accounts are Coinbase Smart Wallets).
const CSW_FACTORY = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a' as const;
const cswAbi = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
  'function replaySafeHash(bytes32 hash) view returns (bytes32)',
]);

function compile() {
  const read = (p: string) =>
    readFileSync(new URL(`../../contracts/${p}`, import.meta.url), 'utf8');
  const sources = {
    'fees/CentralCityFeeRouter3.sol': { content: read('fees/CentralCityFeeRouter3.sol') },
    'test/Test1271Wallet.sol': { content: read('test/Test1271Wallet.sol') },
  };
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources,
        settings: {
          optimizer: { enabled: true, runs: 10_000 },
          evmVersion: 'cancun',
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      }),
    ),
  );
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length)
    throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const pick = (file: string, name: string) => ({
    abi: out.contracts[file][name].abi as Abi,
    bytecode: `0x${out.contracts[file][name].evm.bytecode.object}` as Hex,
  });
  return {
    router: pick('fees/CentralCityFeeRouter3.sol', 'CentralCityFeeRouter3'),
    wallet1271: pick('test/Test1271Wallet.sol', 'Test1271Wallet'),
  };
}

async function main() {
  const { router: R, wallet1271: W } = compile();
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  assert.equal(await pub.getChainId(), 8453, 'a fork of Base mainnet');
  const test = createTestClient({ chain: base, transport: http(RPC), mode: 'anvil' });
  const treasuryKey = privateKeyToAccount(TREASURY_KEY);
  const treasury = treasuryKey.address;
  const [deployer, , seller, , facilitator] = (await pub.request({
    method: 'eth_accounts',
  })) as Address[];
  const wallet = (account: Address) =>
    createWalletClient({ chain: base, transport: http(RPC), account });
  const buyerKey = privateKeyToAccount(BUYER_KEY);
  const ownerKey = privateKeyToAccount(WALLET_OWNER_KEY);

  const fund = async (who: Address, amount: bigint) => {
    // FiatToken v2.2 balances live in mapping slot 9.
    const slot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 9n]),
    );
    await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(amount)) });
  };
  const bal = (a: Address) =>
    pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] });
  const deploy = async (c: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
    const hash = await wallet(deployer).deployContract({ abi: c.abi, bytecode: c.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    assert.equal(r.status, 'success');
    return r.contractAddress as Address;
  };

  const router = await deploy(R, [USDC, treasury]);
  const contractBuyer = await deploy(W, [ownerKey.address]);
  const eoaBuyer = buyerKey.address;
  await fund(eoaBuyer, 500_000_000n);
  await fund(contractBuyer, 500_000_000n);

  const now = BigInt((await pub.getBlock()).timestamp);
  const validAfter = 0n;
  const validBefore = now + 3600n;
  const ref = (s: string) => keccak256(toHex(s));

  const nonceFor = (
    payer: Address,
    payee: Address,
    gross: bigint,
    r: Hex,
    before: bigint,
    leg: number,
  ) =>
    pub.readContract({
      address: router,
      abi: R.abi,
      functionName: 'nonceFor',
      args: [payer, payee, gross, r, validAfter, before, leg],
    }) as Promise<Hex>;

  const digest = (from: Address, to: Address, value: bigint, before: bigint, nonce: Hex) =>
    hashTypedData({
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
      message: { from, to, value, validAfter, validBefore: before, nonce },
    });

  /** The buyer's two off-chain signatures for one purchase (what the agent's account signs). */
  const authorize = async (
    payer: Address,
    signer: typeof buyerKey,
    payee: Address,
    gross: bigint,
    r: Hex,
    before = validBefore,
  ) => {
    const fee = gross / 10n;
    const sellerNonce = await nonceFor(payer, payee, gross, r, before, 0);
    const feeNonce = await nonceFor(payer, payee, gross, r, before, 1);
    const sellerSignature = await signer.sign({
      hash: digest(payer, payee, gross - fee, before, sellerNonce),
    });
    const feeSignature = await signer.sign({
      hash: digest(payer, treasury, fee, before, feeNonce),
    });
    return {
      settlement: {
        payer,
        payee,
        gross,
        ref: r,
        validAfter,
        validBefore: before,
        sellerSignature,
        feeSignature,
      },
      sellerNonce,
      feeNonce,
    };
  };

  const submit = async (fn: 'settle' | 'settleBatch', arg: unknown) => {
    // Simulate first, so a refusal reports its reason instead of a bare reverted receipt.
    await pub.simulateContract({
      address: router,
      abi: R.abi,
      functionName: fn,
      args: [arg],
      account: facilitator,
    });
    return pub.waitForTransactionReceipt({
      hash: await wallet(facilitator).writeContract({
        address: router,
        abi: R.abi,
        functionName: fn,
        args: [arg],
        gas: 2_000_000n,
      }),
    });
  };
  /**
   * An expected refusal, proven on chain: the call is SENT to the local fork with explicit gas (no
   * estimate, no simulation) and must be MINED with status reverted. State reads after it then
   * show what the failed transaction left behind. A transport error throws (never a false pass).
   */
  const reverts = async (fn: 'settle' | 'settleBatch', arg: unknown) => {
    const hash = await wallet(facilitator).writeContract({
      address: router,
      abi: R.abi,
      functionName: fn,
      args: [arg],
      gas: 2_000_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return receipt.status === 'reverted';
  };
  const results: Record<string, unknown> = {};

  // 1. EOA buyer, 1 USDC: 0.9 to the seller, 0.1 to the treasury, one FeeCharged, router holds 0.
  {
    const { settlement } = await authorize(eoaBuyer, buyerKey, seller, 1_000_000n, ref('a'));
    const [b0, s0, t0] = [await bal(eoaBuyer), await bal(seller), await bal(treasury)];
    const r = await submit('settle', settlement);
    const events = r.logs
      .filter((l) => l.address.toLowerCase() === router.toLowerCase())
      .map((l) =>
        decodeEventLog({ abi: R.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }),
      );
    assert.equal(r.status, 'success');
    assert.equal(b0 - (await bal(eoaBuyer)), 1_000_000n);
    assert.equal((await bal(seller)) - s0, 900_000n);
    assert.equal((await bal(treasury)) - t0, 100_000n);
    assert.equal(await bal(router), 0n);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventName, 'FeeCharged');
    const usdcTransfers = r.logs.filter(
      (l) =>
        l.address.toLowerCase() === USDC.toLowerCase() &&
        l.topics[0] === keccak256(toHex('Transfer(address,address,uint256)')),
    ).length;
    assert.equal(usdcTransfers, 2, 'exactly two transfers, both from the buyer');
    results.eoaSettle = { gas: String(r.gasUsed), transfers: usdcTransfers, txFrom: facilitator };

    // Replay of the same settlement: refused.
    results.replayRefused = await reverts('settle', settlement);
    assert.equal(results.replayRefused, true);
  }

  // 2. Contract wallet buyer (ERC-1271), 100 USDC: the cap, fee included.
  {
    const { settlement } = await authorize(contractBuyer, ownerKey, seller, 100_000_000n, ref('b'));
    const s0 = await bal(seller);
    const r = await submit('settle', settlement);
    assert.equal(r.status, 'success');
    assert.equal((await bal(seller)) - s0, 90_000_000n);
    results.erc1271Settle = { gas: String(r.gasUsed) };
  }

  // 3. Bindings: swapped legs, another amount, another payee, another ref: all refused.
  {
    const { settlement } = await authorize(eoaBuyer, buyerKey, seller, 2_000_000n, ref('c'));
    results.swappedLegsRefused = await reverts('settle', {
      ...settlement,
      sellerSignature: settlement.feeSignature,
      feeSignature: settlement.sellerSignature,
    });
    results.otherAmountRefused = await reverts('settle', { ...settlement, gross: 3_000_000n });
    results.otherPayeeRefused = await reverts('settle', { ...settlement, payee: deployer });
    results.otherRefRefused = await reverts('settle', { ...settlement, ref: ref('c2') });
    for (const k of [
      'swappedLegsRefused',
      'otherAmountRefused',
      'otherPayeeRefused',
      'otherRefRefused',
    ])
      assert.equal(results[k], true, k);
  }

  // 4. A leg used directly on USDC (outside the router): settle is refused, nothing more moves.
  {
    const gross = 1_000_000n;
    const { settlement, sellerNonce } = await authorize(
      eoaBuyer,
      buyerKey,
      seller,
      gross,
      ref('d'),
    );
    await pub.waitForTransactionReceipt({
      hash: await wallet(facilitator).writeContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'transferWithAuthorization',
        args: [
          eoaBuyer,
          seller,
          gross - gross / 10n,
          validAfter,
          validBefore,
          sellerNonce,
          settlement.sellerSignature,
        ],
      }),
    });
    results.legUsedOutsideRefused = await reverts('settle', settlement);
    assert.equal(results.legUsedOutsideRefused, true);
  }

  // 5. Batch: three sales in one transaction, gas per sale.
  {
    const batch = [];
    for (const k of ['e1', 'e2', 'e3'])
      batch.push((await authorize(eoaBuyer, buyerKey, seller, 500_000n, ref(k))).settlement);
    const r = await submit('settleBatch', batch);
    assert.equal(r.status, 'success');
    results.batchOf3 = { gas: String(r.gasUsed), perSale: String(r.gasUsed / 3n) };
  }

  const nonceUsed = (who: Address, n: Hex) =>
    pub.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'authorizationState',
      args: [who, n],
    });
  const chargedOf = (who: Address, r: Hex) =>
    pub.readContract({
      address: router,
      abi: R.abi,
      functionName: 'charged',
      args: [who, r],
    }) as Promise<Hex>;
  const ZERO = ('0x' + '0'.repeat(64)) as Hex;

  // 4b. The FEE leg used directly on USDC first: settle refused, the seller gets nothing extra.
  {
    const gross = 1_000_000n;
    const a = await authorize(eoaBuyer, buyerKey, seller, gross, ref('d2'));
    await pub.waitForTransactionReceipt({
      hash: await wallet(facilitator).writeContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'transferWithAuthorization',
        args: [
          eoaBuyer,
          treasury,
          gross / 10n,
          validAfter,
          validBefore,
          a.feeNonce,
          a.settlement.feeSignature,
        ],
      }),
    });
    results.feeLegUsedOutsideRefused = await reverts('settle', a.settlement);
    assert.equal(results.feeLegUsedOutsideRefused, true);
    assert.equal(await nonceUsed(eoaBuyer, a.sellerNonce), false, 'seller leg still unused');
  }

  // 4c. Full rollback: a bad fee signature, or a balance that covers the seller leg but not the
  // total: nothing moves, both nonces stay unused, no settlement is recorded.
  {
    const poor = privateKeyToAccount(generatePrivateKey());
    await fund(poor.address, 950_000n);
    const a = await authorize(poor.address, poor, seller, 1_000_000n, ref('j'));
    const s0 = await bal(seller);
    results.insufficientForTotalRefused = await reverts('settle', a.settlement);
    assert.equal(results.insufficientForTotalRefused, true);
    const b = await authorize(eoaBuyer, buyerKey, seller, 1_000_000n, ref('k'));
    const bad = { ...b.settlement, feeSignature: b.settlement.sellerSignature };
    results.badSecondSignatureRefused = await reverts('settle', bad);
    assert.equal(results.badSecondSignatureRefused, true);
    for (const [who, x] of [
      [poor.address, a],
      [eoaBuyer, b],
    ] as const) {
      assert.equal(await nonceUsed(who, x.sellerNonce), false);
      assert.equal(await nonceUsed(who, x.feeNonce), false);
      assert.equal(await chargedOf(who, x.settlement.ref), ZERO);
    }
    assert.equal(await bal(seller), s0, 'no seller transfer survived');
    results.rollbackVerified = true;
  }

  // 5b. A batch with one bad sale rolls back the earlier good ones.
  {
    const good = (await authorize(eoaBuyer, buyerKey, seller, 500_000n, ref('m1'))).settlement;
    const badSale = (await authorize(eoaBuyer, buyerKey, seller, 500_000n, ref('m2'))).settlement;
    const mixed = [good, { ...badSale, feeSignature: badSale.sellerSignature }];
    results.mixedBatchRefused = await reverts('settleBatch', mixed);
    assert.equal(results.mixedBatchRefused, true);
    assert.equal(await chargedOf(eoaBuyer, good.ref), ZERO, 'the good sale was not recorded');
  }

  // 5c. The payer may not be the treasury.
  {
    await fund(treasury, 10_000_000n);
    results.payerTreasuryRefused = await reverts(
      'settle',
      (await authorize(treasury, treasuryKey, seller, 1_000_000n, ref('n'))).settlement,
    );
    assert.equal(results.payerTreasuryRefused, true);
  }

  // 5d. A real Coinbase Smart Wallet buyer (ERC-1271 over its replay-safe hash), as the agents'
  // spender accounts sign today.
  {
    const owner = privateKeyToAccount(CSW_OWNER_KEY);
    const owners = [encodeAbiParameters([{ type: 'address' }], [owner.address])];
    const csw = (await pub.readContract({
      address: CSW_FACTORY,
      abi: cswAbi,
      functionName: 'getAddress',
      args: [owners, 0n],
    })) as Address;
    await pub.waitForTransactionReceipt({
      hash: await wallet(deployer).writeContract({
        address: CSW_FACTORY,
        abi: cswAbi,
        functionName: 'createAccount',
        args: [owners, 0n],
      }),
    });
    await fund(csw, 10_000_000n);
    const cswSigner = {
      sign: async ({ hash }: { hash: Hex }) => {
        const safe = (await pub.readContract({
          address: csw,
          abi: cswAbi,
          functionName: 'replaySafeHash',
          args: [hash],
        })) as Hex;
        const sig = await owner.sign({ hash: safe });
        return encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, sig]);
      },
    } as unknown as typeof buyerKey;
    const a = await authorize(csw, cswSigner, seller, 1_000_000n, ref('o'));
    const s0 = await bal(seller);
    const rcpt = await submit('settle', a.settlement);
    assert.equal(rcpt.status, 'success');
    assert.equal((await bal(seller)) - s0, 900_000n);
    results.coinbaseSmartWalletSettle = { gas: String(rcpt.gasUsed) };
  }

  // 6. Caps and window: over 100 USDC, below 0.05 USDC, expired window: refused.
  {
    results.overCapRefused = await reverts(
      'settle',
      (await authorize(eoaBuyer, buyerKey, seller, 100_000_001n, ref('f'))).settlement,
    );
    results.belowMinRefused = await reverts(
      'settle',
      (await authorize(eoaBuyer, buyerKey, seller, 49_999n, ref('g'))).settlement,
    );
    results.expiredRefused = await reverts(
      'settle',
      (await authorize(eoaBuyer, buyerKey, seller, 1_000_000n, ref('h'), now - 1n)).settlement,
    );
    results.payeeTreasuryRefused = await reverts(
      'settle',
      (await authorize(eoaBuyer, buyerKey, treasury, 1_000_000n, ref('i'))).settlement,
    );
    for (const k of ['overCapRefused', 'belowMinRefused', 'expiredRefused', 'payeeTreasuryRefused'])
      assert.equal(results[k], true, k);
  }

  assert.equal(await bal(router), 0n, 'the router never holds a balance');
  console.log(JSON.stringify({ router, ...results }, null, 2));
  console.log('ROUTER 3 FORK CHECK: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
