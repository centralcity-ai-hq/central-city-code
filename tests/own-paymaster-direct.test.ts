import test from 'node:test';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  recoverMessageAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Database } from '../server/database.js';
import { OWN_PAYMASTER_KEYS_SQL } from '../server/base/chain/own-paymaster-keys.js';
import {
  DIRECT_BUNDLER_FINALITY_SQL,
  DIRECT_BUNDLER_SQL,
  bundlerChoice,
  directBundler,
  exposureKey,
  lazyBundler,
  MAX_REPLACEMENTS,
  ownSendMarginS,
  NeverBroadcastError,
  registerOwnBundlerMaintainRoute,
  type OwnBundlerUpkeep,
  VALIDITY_MARGIN_S,
  SPONSOR_VALIDITY_S,
  OWNER_SPONSOR_VALIDITY_S,
  sponsorValidityS,
  STUCK_MS,
  SUBMITTER_RESERVE_WEI,
} from '../server/base/chain/direct-bundler.js';
import {
  EXPIRY_MARGIN_S,
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
  type BudgetLimits,
  BudgetError,
} from '../server/base/chain/own-paymaster-budget.js';
import { paymasterHash } from '../server/base/chain/own-paymaster.js';
import type { PolicyAddresses, SponsorFlow } from '../server/base/chain/own-paymaster-policy.js';
import {
  bundlerRateLimited,
  BundlerError,
  sponsorBudgetRefused,
  SponsorError,
} from '../server/base/chain/rpc-bundler.js';
import { createKeystore, parseKeks } from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL } from '../server/base/schema.js';
import { encodeAccountCalls } from '../server/base/chain/submit.js';
import { transientChainError } from '../server/base/chain/transient.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import { ARC_TESTNET } from '../shared/chains.js';
import { chainParams } from '../server/base/chain/chain-params.js';

// Operation Paymaster's own bundler + sponsoring service (server/base/chain/direct-bundler.ts):
// sponsor only the calls the flow intended, within policy and budget; store the signed handleOps
// together with the reservation move BEFORE broadcasting; never sign an operation twice.

const net = BASE_NETWORKS[BASE_MAINNET];
const ENTRY_POINT = net.contracts.entryPointV06;
const PAYMASTER = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ADDRESSES: PolicyAddresses = {
  usdc: net.tokens.USDC.address,
  spendPermissionManager: net.contracts.spendPermissionManager,
  identityRegistry: net.contracts.identityRegistry!,
  reputationRegistry: net.contracts.reputationRegistry,
  smartWalletFactory: net.contracts.smartWalletFactory,
  feeRouters: ['0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B'],
};
const SPENDER = '0x2222222222222222222222222222222222222222' as const;
const MILLI = 10n ** 15n;
const NOW = 1_792_800_000_000;
const S = Math.floor(NOW / 1000);

const signerKey = generatePrivateKey();
const submitterKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);
const submitter = privateKeyToAccount(submitterKey);

const identityAbi = parseAbi(['function register(string tokenURI)']);
const register = (uri = 'https://centralcity.ai/a/AbC123') => ({
  target: ADDRESSES.identityRegistry,
  value: 0n,
  data: encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [uri] }),
});
const eventAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
const failedOp = parseAbi(['error FailedOp(uint256 opIndex, string reason)']);

async function database(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
  await pg.exec(DIRECT_BUNDLER_SQL);
  await pg.exec(DIRECT_BUNDLER_FINALITY_SQL);
  // The provisioned submitter (own-paymaster-keys.ts), as production records it.
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  await pg.query(
    `INSERT INTO own_paymaster_keys (purpose, key_ref, address, created_at)
     VALUES ('paymaster_submitter_1', 'v1:submitter', $1, 0)`,
    [submitter.address],
  );
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  return db;
}

/** A Base the test drives: fees, simulation, nonces, the paymaster's views, a mempool and receipts. */
function fakeBase() {
  const state = {
    onChainSigner: signer.address as string,
    pendingSigner: ZERO as string,
    allowed: true,
    mined: 0,
    finalized: null as number | null,
    dropped: false,
    /** Runs once, at the next handleOps simulation (outside any transaction): race tests. */
    onSimulate: undefined as undefined | (() => Promise<void>),
    finalizedBlock: 1_000n,
    /** The canonical block hash at each mined height (a reorg replaces it). */
    blocks: new Map<bigint, Hex>(),
    paymasterSignatures: 0,
    balance: 3n * MILLI,
    simulate: 'ok' as 'ok' | 'revert' | 'aa25' | 'down',
    innerReverts: false,
    sendFails: false,
    /** What the node answers to a send, as a node's own throw (Arc's pool, below). */
    onSend: undefined as undefined | ((raw: Hex) => void),
    lastRefused: undefined as undefined | Hex,
    sent: [] as Hex[],
    receipts: new Map<string, unknown>(),
  };
  const base = createPublicClient({ transport: http('http://127.0.0.1:1') });
  const client = Object.assign(base, {
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 12_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    }),
    estimateMaxPriorityFeePerGas: async () => 1_000_000n,
    getBlock: async (args?: { blockTag?: string; blockNumber?: bigint }) =>
      args?.blockTag === 'finalized'
        ? { number: state.finalizedBlock }
        : args?.blockNumber !== undefined
          ? { number: args.blockNumber, hash: state.blocks.get(args.blockNumber) ?? null }
          : { baseFeePerGas: 5_000_000n, number: 100n },
    estimateGas: async (args: { to: string; account: unknown }) => {
      if (args.to.toLowerCase() !== ENTRY_POINT.toLowerCase()) {
        if (state.innerReverts)
          throw Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError' });
        return 90_000n;
      }
      if (state.onSimulate) {
        const hook = state.onSimulate;
        state.onSimulate = undefined;
        await hook();
      }
      if (state.simulate === 'down')
        throw Object.assign(new Error('fetch failed'), { status: 503 });
      if (state.simulate === 'revert' || state.simulate === 'aa25')
        throw Object.assign(new Error('execution reverted'), {
          name: 'ExecutionRevertedError',
          data: encodeErrorResult({
            abi: failedOp,
            errorName: 'FailedOp',
            args: [0n, state.simulate === 'aa25' ? 'AA25 invalid account nonce' : 'AA23 reverted'],
          }),
        });
      return 400_000n;
    },
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === 'verifyingSigner') return state.onChainSigner;
      if (args.functionName === 'pendingVerifyingSigner') return state.pendingSigner;
      if (args.functionName === 'isBundlerAllowed') return state.allowed;
      if (args.functionName === 'getL1Fee') return 1_000n;
      throw new Error(`unexpected read ${args.functionName}`);
    },
    getTransactionCount: async (args: { blockTag?: string }) =>
      args.blockTag === 'finalized' ? (state.finalized ?? state.mined) : state.mined,
    getBalance: async () => state.balance,
    getBlockNumber: async () => 101n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      if (state.sendFails) {
        state.lastRefused = serializedTransaction;
        throw Object.assign(new Error('fetch failed'), { status: 503 });
      }
      state.onSend?.(serializedTransaction);
      state.sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = state.receipts.get(hash.toLowerCase());
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      return receipt;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!state.dropped && state.sent.some((raw) => keccak256(raw) === hash.toLowerCase()))
        return { hash };
      throw new TransactionNotFoundError({ hash });
    },
  });
  /**
   * Mines a stored raw transaction with the operation's event (or reverted, without one).
   * 'inner-revert': the bundle succeeds, the operation's own execution reverted (success false).
   */
  const mine = (
    raw: Hex,
    userOpHash: Hex,
    outcome: 'success' | 'reverted' | 'no-event' | 'inner-revert',
    cost = 7_000_000_000n,
    block = { number: 101n, hash: `0x${'b'.repeat(64)}` as Hex },
  ) => {
    const hash = keccak256(raw);
    const logs =
      outcome === 'success' || outcome === 'inner-revert'
        ? [
            {
              address: ENTRY_POINT,
              topics: encodeEventTopics({
                abi: eventAbi,
                eventName: 'UserOperationEvent',
                args: { userOpHash, sender: SPENDER, paymaster: PAYMASTER },
              }),
              data: encodeAbiParameters(parseAbiParameters('uint256, bool, uint256, uint256'), [
                0n,
                outcome === 'success',
                cost,
                300_000n,
              ]),
              blockNumber: block.number,
              logIndex: 0,
              transactionHash: hash,
              transactionIndex: 0,
              blockHash: block.hash,
              removed: false,
            },
          ]
        : [];
    state.blocks.set(block.number, block.hash);
    state.receipts.set(hash, {
      status: outcome === 'reverted' ? 'reverted' : 'success',
      to: parseTransaction(raw).to,
      transactionHash: hash,
      blockNumber: block.number,
      blockHash: block.hash,
      gasUsed: 320_000n,
      effectiveGasPrice: 6_000_000n,
      l1Fee: 1_000n,
      logs,
    });
    state.mined += 1;
  };
  return { state, client: client as never, mine };
}

function keystoreFor(
  chain: ReturnType<typeof fakeBase>,
  failSubmitter: { next: boolean } = { next: false },
) {
  const inner = keystore(failSubmitter);
  return {
    async withSigner<T>(
      keyRef: string,
      use: (a: ReturnType<typeof privateKeyToAccount>) => Promise<T>,
    ) {
      return inner.withSigner(keyRef, (account) =>
        use(
          keyRef === 'v1:signer'
            ? ({
                ...account,
                signMessage: (args: Parameters<typeof account.signMessage>[0]) => {
                  chain.state.paymasterSignatures++;
                  return account.signMessage(args);
                },
              } as typeof account)
            : account,
        ),
      );
    },
  };
}

function keystore(failSubmitter: { next: boolean } = { next: false }) {
  return {
    async withSigner<T>(
      keyRef: string,
      use: (a: ReturnType<typeof privateKeyToAccount>) => Promise<T>,
    ) {
      if (keyRef === 'v1:submitter' && failSubmitter.next) {
        failSubmitter.next = false;
        throw new Error('crash while signing');
      }
      return use(privateKeyToAccount(keyRef === 'v1:signer' ? signerKey : submitterKey));
    },
  };
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: {
    mode?: 'on' | 'prepare';
    deposit?: bigint;
    limits?: Partial<BudgetLimits>;
    now?: { at: number };
    chainId?: number;
    fail?: { next: boolean };
    /** No log dep: the bundler's own default sink (the console). */
    noLog?: boolean;
  } = {},
) {
  const db = await database(t);
  const chain = fakeBase();
  const clock = options.now ?? { at: NOW };
  const budget = ownPaymasterBudget({
    db,
    deposit: async () => ({ wei: options.deposit ?? 100n * MILLI, block: 100n }),
    now: () => clock.at,
    ...(options.limits ? { limits: options.limits } : {}),
    // As createDirectBundler builds it: only our submitter can send our sponsorships.
    submitterBound: true,
  });
  /** Another instance on the same database, optionally with its budget wrapped (race tests). */
  const lines: string[] = [];
  const make = (wrap?: (b: typeof budget) => typeof budget) =>
    directBundler({
      db,
      client: chain.client,
      chainId: options.chainId ?? BASE_MAINNET,
      entryPoint: ENTRY_POINT,
      mode: options.mode ?? 'on',
      paymaster: PAYMASTER,
      keystore: keystoreFor(chain, options.fail),
      signer: { keyRef: 'v1:signer', address: signer.address },
      submitter: { keyRef: 'v1:submitter', address: submitter.address },
      budget: wrap ? wrap(budget) : budget,
      policy: { addresses: ADDRESSES },
      now: () => clock.at,
      autoMaintain: false,
      ...(options.noLog ? {} : { log: (line: string) => void lines.push(line) }),
    });
  return { db, chain, budget, bundler: make(), restart: make, clock, lines };
}

const unsigned = async (calls = [register()], extra: Partial<UserOperation<'0.6'>> = {}) =>
  ({
    sender: SPENDER,
    nonce: 5n,
    initCode: '0x',
    callData: await encodeAccountCalls(
      createPublicClient({ transport: http('http://127.0.0.1:1') }),
      calls,
    ),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    paymasterAndData: '0x',
    signature: '0x',
    ...extra,
  }) as UserOperation<'0.6'>;
const intentOf = (flow: SponsorFlow, calls = [register()], sender: `0x${string}` = SPENDER) => ({
  flow,
  calls,
  sender,
  initCode: '0x' as const,
  accountId: null,
});
const hashOf = (op: UserOperation<'0.6'>) =>
  getUserOperationHash({
    chainId: BASE_MAINNET,
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: '0.6',
    userOperation: op,
  }).toLowerCase() as Hex;
const signed = (op: UserOperation<'0.6'>) => ({ ...op, signature: `0x${'11'.repeat(65)}` as Hex });
const reservation = async (db: Database, hash: string) =>
  (
    await db.query<{ status: string; actual_cost_wei: string | null }>(
      'SELECT status, actual_cost_wei::text AS actual_cost_wei FROM own_paymaster_reservations WHERE user_op_hash = $1',
      [hash],
    )
  ).rows[0];
const sends = async (db: Database) =>
  (
    await db.query<{
      user_op_hash: string;
      nonce: string;
      tx_hashes: string[];
      status: string;
      raw_tx: string;
    }>(
      'SELECT user_op_hash, nonce::text AS nonce, tx_hashes, status, raw_tx FROM own_paymaster_sends ORDER BY nonce',
    )
  ).rows;
const laneNonce = async (db: Database) =>
  (
    await db.query<{ next_nonce: string }>(
      'SELECT next_nonce::text AS next_nonce FROM own_paymaster_lanes',
    )
  ).rows[0]?.next_nonce ?? null;
const refusal = (rejection: 'busy' | 'other') => (e: unknown) =>
  e instanceof SponsorError && e.rejection === rejection;

test('sponsored prepare: our signer over getHash, the 194-byte layout, reserved before handout', async (t) => {
  const { db, bundler } = await setup(t);
  const intent = intentOf('registration');
  const op = await bundler.prepare(await unsigned(), { intent });
  assert.equal(op.signature, '0x');
  assert.equal((op.paymasterAndData!.length - 2) / 2, 194);
  assert.ok(op.paymasterAndData!.toLowerCase().startsWith(PAYMASTER.toLowerCase()));
  // The signature recovers to our verifying signer over the contract's getHash.
  const validUntil = Number(BigInt(`0x${op.paymasterAndData!.slice(42, 54)}`));
  assert.equal(validUntil, S + SPONSOR_VALIDITY_S);
  const hash = paymasterHash(op, {
    chainId: BASE_MAINNET,
    paymaster: PAYMASTER,
    fields: {
      validUntil,
      validAfter: 0,
      sponsorUUID: BigInt(`0x${op.paymasterAndData!.slice(66, 98)}`),
    },
  });
  const recovered = await recoverMessageAddress({
    message: { raw: hash },
    signature: `0x${op.paymasterAndData!.slice(-130)}`,
  });
  assert.equal(recovered, signer.address);
  // Gas: the inner call was estimated (90k x 1.5 + 50k), within every ceiling.
  assert.equal(op.callGasLimit, 185_000n);
  assert.equal(op.verificationGasLimit, 300_000n);
  assert.ok(op.preVerificationGas > 45_000n && op.preVerificationGas <= 200_000n);
  assert.equal((await reservation(db, hashOf(op)))?.status, 'reserved');
});

test('a sponsorship an owner signs in the browser is valid 5 minutes, a server-signed one 9', async (t) => {
  const { db, bundler } = await setup(t);
  const until = (op: UserOperation<'0.6'>) =>
    Number(BigInt(`0x${op.paymasterAndData!.slice(42, 54)}`));
  // An owner's cancel (a no-op to its own wallet): the exit flow, handed out to be signed.
  const cancel = [{ target: SPENDER, value: 0n, data: '0x' as const }];
  const exit = await bundler.prepare(await unsigned(cancel), { intent: intentOf('exit', cancel) });
  assert.equal(until(exit), S + OWNER_SPONSOR_VALIDITY_S);
  assert.equal(OWNER_SPONSOR_VALIDITY_S, 300);
  assert.equal((await reservation(db, hashOf(exit)))?.status, 'reserved');
  const registration = await bundler.prepare(await unsigned([register()], { nonce: 6n }), {
    intent: intentOf('registration'),
  });
  assert.equal(until(registration), S + SPONSOR_VALIDITY_S);
  assert.deepEqual(
    (['exit', 'ownerPay', 'rate', 'registration', 'agentPay', 'feedPay'] as const).map(
      sponsorValidityS,
    ),
    [300, 300, 300, 540, 540, 540],
  );
});

test("its send margin is told to callers (Bundler.sendMarginS): VALIDITY_MARGIN_S for our paymaster's sponsorships, 0 for anything else", async (t) => {
  const { db, bundler } = await setup(t);
  const cancel = [{ target: SPENDER, value: 0n, data: '0x' as const }];
  const exit = await bundler.prepare(await unsigned(cancel), { intent: intentOf('exit', cancel) });
  const coinbase = `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c${'00'.repeat(174)}` as const;
  assert.equal(bundler.sendMarginS!(exit.paymasterAndData!), VALIDITY_MARGIN_S);
  assert.equal(bundler.sendMarginS!(coinbase), 0);
  assert.equal(bundler.sendMarginS!('0x'), 0);
  // The same through the router, ours built or not, and through a CDP route.
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const lazy = lazyBundler({ make: async () => bundler, route });
  const cdp = fakeCdp().bundler;
  for (const b of [lazy, lazy.routes(cdp)]) {
    assert.equal(b.sendMarginS!(exit.paymasterAndData!), VALIDITY_MARGIN_S);
    assert.equal(b.sendMarginS!(coinbase), 0);
  }
  assert.equal(ownSendMarginS(null, exit.paymasterAndData!), 0);
});

test('fails closed: prepare mode, foreign signer, foreign pending signer, not allowlisted, no intent', async (t) => {
  const prepareMode = await setup(t, { mode: 'prepare' });
  const intent = intentOf('registration');
  await assert.rejects(prepareMode.bundler.prepare(await unsigned(), { intent }), refusal('other'));
  // ...but a self-paid operation is still prepared (and never carries paymaster data).
  const own = await prepareMode.bundler.prepare(await unsigned(), { sponsor: false });
  assert.equal(own.paymasterAndData, '0x');

  for (const change of [
    (s: ReturnType<typeof fakeBase>['state']) => (s.onChainSigner = SPENDER),
    (s: ReturnType<typeof fakeBase>['state']) => (s.pendingSigner = SPENDER),
    (s: ReturnType<typeof fakeBase>['state']) => (s.allowed = false),
  ]) {
    const { chain, bundler, db } = await setup(t);
    change(chain.state);
    await assert.rejects(bundler.prepare(await unsigned(), { intent }), refusal('other'));
    assert.equal((await db.query('SELECT 1 FROM own_paymaster_reservations')).rows.length, 0);
  }
  const { bundler } = await setup(t);
  await assert.rejects(bundler.prepare(await unsigned()), refusal('other'));
});

test('intent binding and policy: other calls than intended, a paused flow, a reverting call', async (t) => {
  const { bundler, chain, db } = await setup(t);
  // The flow says it registers one URI; the operation carries another: refused.
  await assert.rejects(
    bundler.prepare(await unsigned([register('https://evil.example/x')]), {
      intent: intentOf('registration'),
    }),
    refusal('other'),
  );
  // A rating intent whose calls are not a rating is refused.
  await assert.rejects(
    bundler.prepare(await unsigned(), { intent: intentOf('rate') }),
    refusal('other'),
  );
  // A call that reverts in simulation is never sponsored.
  chain.state.innerReverts = true;
  await assert.rejects(
    bundler.prepare(await unsigned(), { intent: intentOf('registration') }),
    refusal('other'),
  );
  assert.equal((await db.query('SELECT 1 FROM own_paymaster_reservations')).rows.length, 0);
});

test('budget: an hourly refusal is "busy" (retry later), never a permanent failure', async (t) => {
  const { bundler } = await setup(t, {
    limits: { ordinaryCeilingWei: 150n * MILLI, hourlyOrdinaryWei: 1n, protectedWei: 50n * MILLI },
  });
  const error = await bundler
    .prepare(await unsigned(), { intent: intentOf('registration') })
    .catch((e: unknown) => e);
  assert.ok(error instanceof SponsorError && error.rejection === 'busy');
  assert.ok(bundlerRateLimited(error));
  assert.ok(transientChainError(error));
  assert.ok(sponsorBudgetRefused(error), 'the route can tell the owner it was the budget');
  // A paymaster's other refusals are not the budget's.
  assert.ok(!sponsorBudgetRefused(new SponsorError(new Error('down'))));
});

test('budget: a refused deposit is no "not now": no retry-later answer', async (t) => {
  const { bundler, budget } = await setup(t);
  const reserve = budget.reserve;
  budget.reserve = async () => {
    throw new BudgetError('deposit');
  };
  t.after(() => {
    budget.reserve = reserve;
  });
  const error = await bundler
    .prepare(await unsigned(), { intent: intentOf('registration') })
    .catch((e: unknown) => e);
  assert.ok(error instanceof SponsorError && error.rejection === 'other');
  assert.ok(!sponsorBudgetRefused(error));
});

test('send: simulation revert sends nothing, takes no nonce and moves no reservation', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const op = signed(
    await bundler.prepare(await unsigned(), {
      intent: intentOf('registration'),
    }),
  );
  chain.state.simulate = 'revert';
  await assert.rejects(
    bundler.send(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'RPC_ERROR',
  );
  chain.state.simulate = 'aa25';
  await assert.rejects(
    bundler.send(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'NONCE_CONSUMED',
  );
  chain.state.simulate = 'down';
  await assert.rejects(
    bundler.send(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'RPC_UNAVAILABLE',
  );
  assert.equal(chain.state.sent.length, 0);
  assert.deepEqual(await sends(db), []);
  assert.equal(await laneNonce(db), null);
  assert.equal((await reservation(db, hashOf(op)))?.status, 'reserved');
});

test('reservation move + signed transaction commit together, before the broadcast', async (t) => {
  const fail = { next: false };
  const { db, chain, bundler, restart } = await setup(t, { fail });
  const op = signed(
    await bundler.prepare(await unsigned(), {
      intent: intentOf('registration'),
    }),
  );
  const hash = hashOf(op);

  // Crash BEFORE the commit (inside the transaction, while signing): nothing durable at all.
  fail.next = true;
  await assert.rejects(bundler.send(op));
  assert.deepEqual(await sends(db), []);
  assert.equal(await laneNonce(db), null);
  assert.equal((await reservation(db, hash))?.status, 'reserved');

  // The broadcast fails AFTER the commit: the row and the 'sent' reservation are already durable.
  chain.state.sendFails = true;
  await assert.rejects(
    bundler.send(op),
    (e: unknown) => e instanceof BundlerError && e.code === 'RPC_UNAVAILABLE',
  );
  const [stored] = await sends(db);
  assert.equal(stored?.nonce, '0');
  assert.equal(await laneNonce(db), '1');
  assert.equal((await reservation(db, hash))?.status, 'sent');
  assert.equal(chain.state.sent.length, 0);

  // A restarted instance sends the SAME bytes: never re-signed, never a second nonce.
  chain.state.sendFails = false;
  const again = restart();
  assert.equal(await again.send(op), hash);
  assert.deepEqual(chain.state.sent, [stored!.raw_tx]);
  assert.equal(parseTransaction(stored!.raw_tx as Hex).nonce, 0);
  assert.equal(await laneNonce(db), '1');
  assert.equal((await sends(db)).length, 1);
  // And again (the caller's rebroadcast loop): known to the node, nothing new is signed.
  await again.send(op);
  assert.equal((await sends(db))[0]!.tx_hashes.length, 1);
});

test('a lapsed reservation is never sent; prepare again instead', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const op = signed(
    await bundler.prepare(await unsigned(), {
      intent: intentOf('registration'),
    }),
  );
  clock.at = (S + SPONSOR_VALIDITY_S + EXPIRY_MARGIN_S + 1) * 1000;
  await assert.rejects(bundler.send(op), /lapsed/);
  assert.deepEqual(await sends(db), []);
  assert.equal(chain.state.sent.length, 0);
});

test('two operations take two nonces; the same operation twice at once is stored once', async (t) => {
  const { db, bundler, restart } = await setup(t);
  const intent = intentOf('registration');
  const a = signed(await bundler.prepare(await unsigned(), { intent }));
  const b = signed(await bundler.prepare(await unsigned([register()], { nonce: 6n }), { intent }));
  const other = restart();
  await Promise.all([bundler.send(a), other.send(a), other.send(b)]);
  const rows = await sends(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.nonce).sort(), ['0', '1']);
  assert.equal(await laneNonce(db), '2');
});

test('receipt: the event settles the reservation at actualGasCost; a reverted bundle settles at 0', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const intent = intentOf('registration');
  const a = signed(await bundler.prepare(await unsigned(), { intent }));
  const b = signed(await bundler.prepare(await unsigned([register()], { nonce: 6n }), { intent }));
  await bundler.send(a);
  await bundler.send(b);
  const [rowA, rowB] = await sends(db);
  assert.equal(await bundler.receipt(hashOf(a)), null); // not mined yet

  chain.mine(rowA!.raw_tx as Hex, hashOf(a), 'success', 7_000_000_000n);
  const got = await bundler.receipt(hashOf(a));
  assert.deepEqual(
    { success: got?.success, cost: got?.actualGasCost, block: got?.blockNumber },
    { success: true, cost: 7_000_000_000n, block: 101n },
  );
  assert.deepEqual(await reservation(db, hashOf(a)), {
    status: 'settled',
    actual_cost_wei: '7000000000',
  });
  // Measured overhead settles the submitter's exposure: it paid 320k gas x 6e6 + 1000 L1 and got
  // 7e9 back from the EntryPoint.
  const paid = 320_000n * 6_000_000n + 1_000n;
  assert.deepEqual(await reservation(db, exposureKey(hashOf(a))), {
    status: 'settled',
    actual_cost_wei: String(paid - 7_000_000_000n),
  });

  chain.mine(rowB!.raw_tx as Hex, hashOf(b), 'reverted');
  assert.equal(await bundler.receipt(hashOf(b)), null);
  assert.deepEqual(await reservation(db, hashOf(b)), { status: 'settled', actual_cost_wei: '0' });
  // A reverted bundle: the submitter's whole cost is overhead.
  assert.deepEqual(await reservation(db, exposureKey(hashOf(b))), {
    status: 'settled',
    actual_cost_wei: String(paid),
  });
  // A failed send is final: sending it again refuses (prepare a new sponsorship instead).
  await assert.rejects(bundler.send(b), /failed/);
  // Asking again settles nothing twice.
  await bundler.receipt(hashOf(b));
  await bundler.receipt(hashOf(a));
  const settled = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM own_paymaster_reservations WHERE status = 'settled'",
  );
  assert.equal(settled.rows[0]!.n, 4);
});

test('CCA-752: a sponsored operation that reverts inside is settled from the deposit at its cost and logged as an ALERT, once', async (t) => {
  const { db, chain, bundler, lines } = await setup(t);
  const intent = intentOf('registration');
  const a = signed(await bundler.prepare(await unsigned(), { intent }));
  const b = signed(await bundler.prepare(await unsigned([register()], { nonce: 6n }), { intent }));
  await bundler.send(a);
  await bundler.send(b);
  const [rowA, rowB] = await sends(db);
  chain.mine(rowA!.raw_tx as Hex, hashOf(a), 'success', 7_000_000_000n);
  chain.mine(rowB!.raw_tx as Hex, hashOf(b), 'inner-revert', 6_000_000_000n);
  assert.equal((await bundler.receipt(hashOf(a)))?.success, true);
  assert.equal((await bundler.receipt(hashOf(b)))?.success, false);
  // The worst case was reserved; the deposit paid the reverted operation's actual cost.
  assert.deepEqual(await reservation(db, hashOf(b)), {
    status: 'settled',
    actual_cost_wei: '6000000000',
  });
  await bundler.receipt(hashOf(b));
  const alerts = lines.filter((l) => l.includes('ALERT sponsored operation'));
  assert.deepEqual(alerts, [
    `own paymaster: ALERT sponsored operation ${hashOf(b)} reverted, deposit paid 6000000000 wei`,
  ]);
});

test('CCA-752: without a log dep the reverted-operation ALERT reaches the console (the Fastify logger is off)', async (t) => {
  const seen: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
  t.after(() => {
    console.error = original;
  });
  const { db, chain, bundler, lines } = await setup(t, { noLog: true });
  const a = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(a);
  const [row] = await sends(db);
  chain.mine(row!.raw_tx as Hex, hashOf(a), 'inner-revert', 6_000_000_000n);
  assert.equal((await bundler.receipt(hashOf(a)))?.success, false);
  assert.equal(lines.length, 0);
  assert.deepEqual(
    seen.filter((l) => l.includes('ALERT sponsored operation')),
    [`own paymaster: ALERT sponsored operation ${hashOf(a)} reverted, deposit paid 6000000000 wei`],
  );
});

test('CCA-752: a settlement whose database write fails is retried on the next refresh and ALERTs then, once', async (t) => {
  const { db, chain, bundler, lines } = await setup(t);
  const a = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(a);
  const [row] = await sends(db);
  chain.mine(row!.raw_tx as Hex, hashOf(a), 'inner-revert', 6_000_000_000n);
  const transaction = db.transaction;
  let fail = true;
  db.transaction = ((action: never) => {
    if (fail) {
      fail = false;
      return Promise.reject(new Error('database unavailable'));
    }
    return transaction(action);
  }) as typeof db.transaction;
  t.after(() => void (db.transaction = transaction));
  await bundler.receipt(hashOf(a)).catch(() => null);
  const alerts = () => lines.filter((l) => l.includes('ALERT sponsored operation'));
  assert.equal(alerts().length, 0, 'nothing settled, nothing alerted yet');
  await bundler.receipt(hashOf(a));
  await bundler.receipt(hashOf(a));
  assert.equal(alerts().length, 1, JSON.stringify(lines));
  assert.deepEqual(await reservation(db, hashOf(a)), {
    status: 'settled',
    actual_cost_wei: '6000000000',
  });
});

test('the submitter exposure is reserved before signing; pending ones add up', async (t) => {
  const { db, bundler } = await setup(t);
  const intent = intentOf('registration');
  const a = signed(await bundler.prepare(await unsigned(), { intent }));
  const b = signed(await bundler.prepare(await unsigned([register()], { nonce: 6n }), { intent }));
  await Promise.all([bundler.send(a), bundler.send(b)]);
  // Each pending transaction holds gas limit x max fee + 2 x the oracle's L1 quote, as ordinary
  // (registration) work, open until its receipt.
  const rows = await db.query<{ max: string; status: string; protected: boolean }>(
    `SELECT max_cost_wei::text AS max, status, protected FROM own_paymaster_reservations
     WHERE user_op_hash = ANY($1::text[])`,
    [[exposureKey(hashOf(a)), exposureKey(hashOf(b))]],
  );
  assert.equal(rows.rows.length, 2);
  const [txA] = (await sends(db)).map((r) => parseTransaction(r.raw_tx as Hex));
  for (const row of rows.rows) {
    assert.equal(row.status, 'sent');
    assert.equal(row.protected, false);
    assert.equal(BigInt(row.max), txA!.gas! * txA!.maxFeePerGas! + 2_000n);
  }
});

test('at send only the deposit refuses: the first send, and the replacement premium; a spent ordinary budget never does', async (t) => {
  const clock = { at: NOW };
  const limits: Partial<BudgetLimits> = {
    ordinaryCeilingWei: 150n * MILLI,
    hourlyOrdinaryWei: 10n * MILLI,
    protectedWei: 50n * MILLI,
  };
  const options: { now: { at: number }; limits: Partial<BudgetLimits>; deposit: bigint } = {
    now: clock,
    limits,
    deposit: 150n * MILLI,
  };
  const { db, chain, bundler } = await setup(t, options);
  const intent = intentOf('registration');
  const open = async () =>
    BigInt(
      (
        await db.query<{ s: string }>(
          "SELECT COALESCE(SUM(max_cost_wei), 0)::text AS s FROM own_paymaster_reservations WHERE status IN ('reserved','sent')",
        )
      ).rows[0]!.s,
    );

  // 1. The deposit covers the sponsorship, not the submitter's exposure on top: nothing is signed.
  const a = signed(await bundler.prepare(await unsigned(), { intent }));
  options.deposit = await open();
  await assert.rejects(
    bundler.send(a),
    (e: unknown) => e instanceof BundlerError && /budget \(deposit\)/.test(e.message),
  );
  assert.deepEqual(await sends(db), []);
  assert.equal(chain.state.sent.length, 0);

  // 2. The ordinary ceiling and hour spent meanwhile: admitted at reserve, it is still sent.
  options.deposit = 150n * MILLI;
  limits.ordinaryCeilingWei = await open();
  limits.hourlyOrdinaryWei = 1n;
  await bundler.send(a);
  // The +30% premium does not fit the deposit: the replacement is never signed.
  options.deposit = await open();
  clock.at += STUCK_MS + 1;
  await bundler.maintain();
  const [row] = await sends(db);
  assert.equal(row!.tx_hashes.length, 1);
  assert.equal(chain.state.sent.length, 1);

  // 3. With room again, the premium is admitted and only the increase counts (max, not sum).
  options.deposit = 150n * MILLI;
  const before = await open();
  await bundler.maintain();
  assert.equal((await sends(db))[0]!.tx_hashes.length, 2);
  const second = parseTransaction(chain.state.sent[1]!);
  const exposure = await db.query<{ max: string }>(
    'SELECT max_cost_wei::text AS max FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [exposureKey(hashOf(a))],
  );
  assert.equal(BigInt(exposure.rows[0]!.max), second.gas! * second.maxFeePerGas! + 2_600n);
  assert.ok((await open()) - before < BigInt(exposure.rows[0]!.max));
});

test('a stuck transaction is replaced at the same nonce with +30% fees, bounded by the ceilings', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const op = signed(
    await bundler.prepare(await unsigned(), {
      intent: intentOf('registration'),
    }),
  );
  await bundler.send(op);
  clock.at += STUCK_MS + 1;
  await bundler.maintain();
  const [row] = await sends(db);
  assert.equal(row!.tx_hashes.length, 2);
  const first = parseTransaction(chain.state.sent[0]!);
  const second = parseTransaction(chain.state.sent[1]!);
  assert.equal(second.nonce, first.nonce);
  assert.equal(second.data, first.data);
  assert.ok(second.maxFeePerGas! >= (first.maxFeePerGas! * 13n) / 10n);
  // Mined under the replacement's hash: found, settled.
  chain.mine(chain.state.sent[1]!, hashOf(op), 'success');
  assert.equal((await bundler.receipt(hashOf(op)))?.success, true);
});

test(
  'the real key store on one connection: a send and its replacement complete under the lane lock',
  { timeout: 30_000 },
  async (t) => {
    // The key store reads on its own connection. PGlite has one, so a read while the lane lock is held
    // would wait forever: this test then hits its timeout.
    const clock = { at: NOW };
    const { db, chain, budget } = await setup(t, { now: clock });
    await db.exec(`CREATE TABLE IF NOT EXISTS operators (id text PRIMARY KEY);`);
    await db.exec(BASE_MIGRATION_SQL);
    await db.exec(BASE_PAYMENTS_MIGRATION_SQL);
    const keys = createKeystore({
      keks: parseKeks(`v1:${Buffer.alloc(32, 7).toString('base64')}`),
      store: pgSpenderKeyStore(db),
    });
    const created = await keys.createSpenderKey();
    const bundler = directBundler({
      db,
      client: chain.client,
      chainId: BASE_MAINNET,
      entryPoint: ENTRY_POINT,
      mode: 'on',
      paymaster: PAYMASTER,
      keystore: keys,
      signer: { keyRef: 'v1:signer', address: signer.address },
      submitter: { keyRef: created.keyRef, address: created.signer },
      budget,
      policy: { addresses: ADDRESSES },
      now: () => clock.at,
      autoMaintain: false,
      log: () => undefined,
    });
    const op = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
    await bundler.send(op);
    assert.equal(chain.state.sent.length, 1);
    const first = parseTransaction(chain.state.sent[0]!);
    // Sent again: never signed again.
    await bundler.send(op);
    assert.equal(chain.state.sent.length, 1);
    assert.equal(await laneNonce(db), '1');
    clock.at += STUCK_MS + 1;
    await bundler.maintain();
    assert.equal(chain.state.sent.length, 2);
    const second = parseTransaction(chain.state.sent[1]!);
    assert.equal(second.nonce, first.nonce);
    assert.equal(await laneNonce(db), '1');
    assert.equal((await sends(db))[0]!.tx_hashes.length, 2);
  },
);

test('a send mined during the simulation is not cancelled: the nonce is read again first', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  clock.at += STUCK_MS + 1;
  chain.state.simulate = 'revert';
  chain.state.onSimulate = async () => chain.mine(chain.state.sent[0]!, hashOf(op), 'success');
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 1);
  assert.equal((await sends(db))[0]!.tx_hashes.length, 1);
  // The next pass finds its receipt: included, not cancelled.
  await bundler.maintain();
  assert.equal((await sends(db))[0]!.status, 'included');
  assert.equal((await bundler.receipt(hashOf(op)))?.success, true);
});

test('a receipt seen with the nonce not moved yet (another node) also stops the cancel', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  clock.at += STUCK_MS + 1;
  chain.state.simulate = 'revert';
  chain.state.onSimulate = async () => {
    chain.mine(chain.state.sent[0]!, hashOf(op), 'success');
    chain.state.mined = 0;
  };
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 1);
  assert.equal((await sends(db))[0]!.tx_hashes.length, 1);
});

test('a failed read of the nonce cancels nothing; a send that really reverts is still cancelled', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  clock.at += STUCK_MS + 1;
  chain.state.simulate = 'revert';
  const client = chain.client as unknown as { getTransactionCount: () => Promise<number> };
  const read = client.getTransactionCount;
  chain.state.onSimulate = async () => {
    client.getTransactionCount = async () => {
      throw new Error('fetch failed');
    };
  };
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 1);
  client.getTransactionCount = read;
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 2);
  assert.equal((await sends(db))[0]!.tx_hashes.length, 2);
  assert.equal(
    parseTransaction(chain.state.sent[1]!).to?.toLowerCase(),
    submitter.address.toLowerCase(),
  );
});

test('only our own sponsorship or a self-paid operation is submitted; low submitter funds wait', async (t) => {
  const { chain, bundler } = await setup(t);
  const foreign = signed({
    ...(await unsigned()),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 12_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c${'00'.repeat(174)}`,
  });
  await assert.rejects(bundler.send(foreign), /not our sponsorship/);
  const own = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
  chain.state.balance = 1n;
  await assert.rejects(bundler.send(own), /low on gas funds/);
  chain.state.balance = 3n * MILLI;
  await bundler.send(own);
  assert.equal(chain.state.sent.length, 1);
});

test('the sender and the deployment come from the flow, not from the operation', async (t) => {
  const { bundler, db, chain } = await setup(t);
  const OTHER = '0x5555555555555555555555555555555555555555' as const;
  // The same calls, prepared for another sender than the flow's records name: refused.
  await assert.rejects(
    bundler.prepare(await unsigned([register()], { sender: OTHER }), {
      intent: intentOf('registration'),
    }),
    refusal('other'),
  );
  // A deployment the flow did not expect: refused.
  await assert.rejects(
    bundler.prepare(
      await unsigned([register()], { initCode: `${ADDRESSES.smartWalletFactory}00` as Hex }),
      { intent: intentOf('registration') },
    ),
    refusal('other'),
  );
  assert.equal(chain.state.paymasterSignatures, 0);
  assert.equal((await db.query('SELECT 1 FROM own_paymaster_reservations')).rows.length, 0);
});

test('the budget decides BEFORE the paymaster signs', async (t) => {
  const refusedGate = await setup(t, {
    limits: { ordinaryCeilingWei: 150n * MILLI, hourlyOrdinaryWei: 1n, protectedWei: 50n * MILLI },
  });
  await assert.rejects(
    refusedGate.bundler.prepare(await unsigned(), { intent: intentOf('registration') }),
    refusal('busy'),
  );
  assert.equal(refusedGate.chain.state.paymasterSignatures, 0);
  // Admitted: exactly one signature, and the reservation now carries the operation's own hash.
  const { bundler, db, chain } = await setup(t);
  const op = await bundler.prepare(await unsigned(), { intent: intentOf('registration') });
  assert.equal(chain.state.paymasterSignatures, 1);
  const rows = await db.query<{ user_op_hash: string }>(
    'SELECT user_op_hash FROM own_paymaster_reservations',
  );
  assert.deepEqual(
    rows.rows.map((r) => r.user_op_hash),
    [hashOf(op)],
  );
});

test('an expired sponsorship still pending is cancelled at its nonce, never sent to revert', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  clock.at = (S + SPONSOR_VALIDITY_S + 1) * 1000;
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 2);
  const original = parseTransaction(chain.state.sent[0]!);
  const cancel = parseTransaction(chain.state.sent[1]!);
  assert.equal(cancel.nonce, original.nonce);
  assert.equal(cancel.to?.toLowerCase(), submitter.address.toLowerCase());
  assert.equal(cancel.value ?? 0n, 0n);
  assert.equal(cancel.gas, 21_000n);
  assert.ok(cancel.maxFeePerGas! > original.maxFeePerGas!);
  // The cancel is mined: nothing from the deposit; the submitter's whole cost is its overhead.
  chain.mine(chain.state.sent[1]!, hashOf(op), 'no-event');
  await bundler.maintain();
  const row = (
    await db.query<{ status: string; error_code: string; settled: boolean }>(
      'SELECT status, error_code, settled FROM own_paymaster_sends',
    )
  ).rows[0];
  assert.deepEqual({ ...row }, { status: 'failed', error_code: 'CANCELLED', settled: true });
  assert.deepEqual(await reservation(db, hashOf(op)), { status: 'settled', actual_cost_wei: '0' });
  assert.deepEqual(await reservation(db, exposureKey(hashOf(op))), {
    status: 'settled',
    actual_cost_wei: String(320_000n * 6_000_000n + 1_000n),
  });
  await assert.rejects(bundler.send(op), /CANCELLED/);
});

test('past every replacement the lane head is still rebroadcast as stored', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  // Self-paid (no sponsorship expiry): only the replacement bound applies.
  const op = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
  await bundler.send(op);
  for (let i = 0; i < MAX_REPLACEMENTS; i++) {
    clock.at += STUCK_MS + 1;
    await bundler.maintain();
  }
  assert.equal((await sends(db))[0]!.tx_hashes.length, MAX_REPLACEMENTS + 1);
  const latest = chain.state.sent.at(-1)!;
  // The node dropped it: the next look sends the very same bytes again, nothing new is signed.
  chain.state.dropped = true;
  clock.at += 1_000;
  await bundler.maintain();
  assert.equal(chain.state.sent.at(-1), latest);
  assert.equal(chain.state.sent.filter((raw) => raw === latest).length, 2);
  assert.equal((await sends(db))[0]!.tx_hashes.length, MAX_REPLACEMENTS + 1);
});

test('a nonce consumed without our receipt settles at the worst case, and is final', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  chain.state.mined = 1; // something else used nonce 0...
  chain.state.finalized = 0;
  await bundler.maintain();
  assert.equal((await sends(db))[0]!.status, 'submitted'); // ...not final yet
  chain.state.finalized = 1;
  await bundler.maintain();
  assert.equal((await sends(db))[0]!.status, 'failed');
  const worst = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM own_paymaster_reservations
     WHERE status = 'settled' AND actual_cost_wei = max_cost_wei`,
  );
  assert.equal(worst.rows[0]!.n, 2);
  // Final rows never come back to maintain (no starvation).
  assert.equal(await bundler.maintain(), 0);
});

test('direct without what sponsoring needs keeps CDP', () => {
  const ok = {
    CITY_BASE_BUNDLER: 'direct',
    CITY_BASE_OWN_PAYMASTER: 'on',
    CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
  };
  assert.equal(bundlerChoice({}), 'cdp');
  assert.equal(bundlerChoice({ CITY_BASE_BUNDLER: 'cdp' }), 'cdp');
  assert.equal(bundlerChoice(ok), 'direct');
  assert.equal(bundlerChoice({ ...ok, CITY_BASE_OWN_PAYMASTER: 'prepare' }), 'invalid');
  assert.equal(bundlerChoice({ ...ok, CITY_BASE_OWN_PAYMASTER: undefined }), 'invalid');
  assert.equal(bundlerChoice({ ...ok, CITY_BASE_PAYMASTER_ADDRESS: 'not-an-address' }), 'invalid');
});

test('preVerificationGas carries the L1 data fee at the price the EntryPoint repays', async (t) => {
  const { bundler, chain } = await setup(t);
  const plain = await bundler.prepare(await unsigned(), { intent: intentOf('registration') });
  // The oracle now quotes 1e11 wei of L1 fee: 2 x 1e11 / (5e6 + 1e6) more gas, within the ceiling.
  const client = chain.client as unknown as {
    readContract: (a: { functionName: string }) => Promise<unknown>;
  };
  const before = client.readContract;
  client.readContract = async (args) =>
    args.functionName === 'getL1Fee' ? 100_000_000_000n : before(args);
  const withL1 = await bundler.prepare(await unsigned([register()], { nonce: 6n }), {
    intent: intentOf('registration'),
  });
  const expected = (2n * 100_000_000_000n + 5_999_999n) / 6_000_000n - 1n; // 2000/6e6 rounds to 1
  assert.equal(withL1.preVerificationGas - plain.preVerificationGas, expected);
});

test('a self-paid operation is its own class: no sponsored cap, never the protected reserve, only the submitter float', async (t) => {
  const limits: Partial<BudgetLimits> = {
    ordinaryCeilingWei: 1n,
    hourlyOrdinaryWei: 1n,
    senderHourlyOrdinaryWei: 1n,
    protectedWei: 50n * MILLI,
  };
  const { db, chain, bundler } = await setup(t, { limits, deposit: 0n });
  const own = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
  // Every sponsored cap spent, the deposit empty: the owner-funded payment is still sent.
  await bundler.send(own);
  const row = await db.query<{ flow: string; protected: boolean; max: string }>(
    'SELECT flow, protected, max_cost_wei::text AS max FROM own_paymaster_reservations WHERE user_op_hash = $1',
    [exposureKey(hashOf(own))],
  );
  assert.deepEqual(
    { flow: row.rows[0]!.flow, protected: row.rows[0]!.protected },
    { flow: 'selfPaid', protected: false },
  );
  // A second one while the first is pending: the submitter's float holds one and a half.
  const exposure = BigInt(row.rows[0]!.max);
  chain.state.balance = SUBMITTER_RESERVE_WEI + exposure + exposure / 2n;
  const next = signed(
    await bundler.prepare(await unsigned([register()], { nonce: 6n }), { sponsor: false }),
  );
  await assert.rejects(bundler.send(next), /budget \(submitter_float\)/);
  assert.equal(chain.state.sent.length, 1);
});

test('no accounting record, no signature (a replacement is never classified by default)', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const own = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
  await bundler.send(own);
  await db.query('DELETE FROM own_paymaster_reservations WHERE user_op_hash = $1', [
    exposureKey(hashOf(own)),
  ]);
  clock.at += STUCK_MS + 1;
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 1);
  assert.equal((await sends(db))[0]!.tx_hashes.length, 1);
});

const maxOf = async (db: Database, key: string) =>
  BigInt(
    (
      await db.query<{ max: string }>(
        'SELECT max_cost_wei::text AS max FROM own_paymaster_reservations WHERE user_op_hash = $1',
        [key],
      )
    ).rows[0]!.max,
  );
const openSum = async (db: Database) =>
  BigInt(
    (
      await db.query<{ s: string }>(
        "SELECT COALESCE(SUM(max_cost_wei), 0)::text AS s FROM own_paymaster_reservations WHERE status IN ('reserved','sent')",
      )
    ).rows[0]!.s,
  );

test('nothing settles before finality; a reorg never frees headroom twice', async (t) => {
  const limits: Partial<BudgetLimits> = {
    ordinaryCeilingWei: 150n * MILLI,
    hourlyOrdinaryWei: 10n * MILLI,
    protectedWei: 50n * MILLI,
  };
  const { db, chain, bundler } = await setup(t, { limits });
  chain.state.finalizedBlock = 100n;
  const a = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(a);
  const raw = chain.state.sent[0]!;
  const worstA = await maxOf(db, hashOf(a));

  // 1. A is included CHEAPLY, not final: its worst case stays reserved (nothing released).
  chain.mine(raw, hashOf(a), 'success', 1_000_000_000n);
  assert.equal((await bundler.receipt(hashOf(a)))?.actualGasCost, 1_000_000_000n);
  assert.deepEqual(await reservation(db, hashOf(a)), { status: 'sent', actual_cost_wei: null });
  assert.equal(await maxOf(db, hashOf(a)), worstA);

  // 2. An ordinary admission in between sees A at its WORST case: with the ceiling at exactly
  //    "everything open + B's worst case - 1", B is refused (it could only fit on released headroom).
  const open = await openSum(db);
  limits.ordinaryCeilingWei = open + worstA - 1n;
  await assert.rejects(
    bundler.prepare(await unsigned([register()], { nonce: 6n }), {
      intent: intentOf('registration'),
    }),
    refusal('busy'),
  );

  // 3. A's block is orphaned before finality: nothing to reopen, the row is followed again.
  chain.state.receipts.clear();
  chain.state.mined = 0;
  await bundler.maintain();
  assert.equal((await sends(db))[0]!.status, 'submitted');
  assert.deepEqual(await reservation(db, hashOf(a)), { status: 'sent', actual_cost_wei: null });

  // 4. Re-included at a HIGHER cost and final: settled once, by the canonical receipt.
  chain.mine(raw, hashOf(a), 'success', 9_000_000_000n, {
    number: 103n,
    hash: `0x${'c'.repeat(64)}`,
  });
  chain.state.finalizedBlock = 103n;
  await bundler.maintain();
  await bundler.maintain();
  assert.deepEqual(await reservation(db, hashOf(a)), {
    status: 'settled',
    actual_cost_wei: '9000000000',
  });
  const settled = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM own_paymaster_reservations WHERE status = 'settled'",
  );
  assert.equal(settled.rows[0]!.n, 2); // A and its exposure, once each
  // The envelope held at every step: settled + open never above the ceiling in force.
  assert.equal(await openSum(db), 0n);
});

test('an orphaned FAILURE receipt is followed until final; the final outcome is charged', async (t) => {
  const { db, chain, bundler } = await setup(t);
  chain.state.finalizedBlock = 100n;
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  const raw = chain.state.sent[0]!;
  chain.mine(raw, hashOf(op), 'reverted');
  await bundler.maintain();
  // Reverted, not final: no settlement at 0 yet, the worst case still held.
  const [pending] = await sends(db);
  assert.equal(pending!.status, 'included');
  assert.deepEqual(await reservation(db, hashOf(op)), { status: 'sent', actual_cost_wei: null });
  // Orphaned; then the same transaction lands successfully and is final: 8e9 is charged, not 0.
  chain.state.receipts.clear();
  chain.state.mined = 0;
  await bundler.maintain();
  chain.mine(raw, hashOf(op), 'success', 8_000_000_000n, {
    number: 104n,
    hash: `0x${'d'.repeat(64)}`,
  });
  chain.state.finalizedBlock = 104n;
  await bundler.maintain();
  await bundler.maintain();
  assert.equal((await sends(db))[0]!.status, 'included');
  assert.deepEqual(await reservation(db, hashOf(op)), {
    status: 'settled',
    actual_cost_wei: '8000000000',
  });
});

test('once its receipt is at or below the finalized block, a row is final and left alone', async (t) => {
  const { db, chain, bundler } = await setup(t);
  chain.state.finalizedBlock = 100n;
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  chain.mine(chain.state.sent[0]!, hashOf(op), 'success');
  await bundler.maintain();
  assert.equal(await bundler.maintain(), 1); // block 101 > finalized 100: still followed
  chain.state.finalizedBlock = 101n;
  await bundler.maintain();
  const row = await db.query<{ final: boolean; settled: boolean }>(
    'SELECT final, settled FROM own_paymaster_sends',
  );
  assert.deepEqual({ ...row.rows[0] }, { final: true, settled: true });
  assert.equal(await bundler.maintain(), 0);
});

test('past the bump bound the lane head is cancelled, and only the head is bumped', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  // Two self-paid operations (no validUntil to end them): nonces 0 and 1, neither mined.
  const a = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
  const b = signed(
    await bundler.prepare(await unsigned([register()], { nonce: 6n }), { sponsor: false }),
  );
  await bundler.send(a);
  await bundler.send(b);
  for (let i = 0; i < MAX_REPLACEMENTS; i++) {
    clock.at += STUCK_MS + 1;
    await bundler.maintain();
  }
  const rows = await sends(db);
  assert.equal(rows.find((r) => r.nonce === '0')!.tx_hashes.length, MAX_REPLACEMENTS + 1);
  assert.equal(
    rows.find((r) => r.nonce === '1')!.tx_hashes.length,
    1,
    'not the head: never bumped',
  );
  // One more stuck round: the head is cancelled (a zero-value transfer to the submitter).
  clock.at += STUCK_MS + 1;
  await bundler.maintain();
  const cancel = parseTransaction(chain.state.sent.at(-1)!);
  assert.equal(cancel.nonce, 0);
  assert.equal(cancel.to?.toLowerCase(), submitter.address.toLowerCase());
  assert.equal(cancel.gas, 21_000n);
});

test('no send inside the validity margin; a pending one is cancelled before validUntil', async (t) => {
  const clock = { at: NOW };
  const late = await setup(t, { now: clock });
  const op = signed(
    await late.bundler.prepare(await unsigned(), { intent: intentOf('registration') }),
  );
  clock.at = (S + SPONSOR_VALIDITY_S - VALIDITY_MARGIN_S + 1) * 1000;
  // Not sent, but still reserved (another instance may yet send it): ambiguous, not never-sent.
  const open = await late.bundler.send(op).catch((e: unknown) => e);
  assert.ok(open instanceof BundlerError && !(open instanceof NeverBroadcastError));
  assert.match((open as Error).message, /still open/);
  // Once it can no longer execute, the sweep expires it under the lock: now provably never sent.
  clock.at = (S + SPONSOR_VALIDITY_S + EXPIRY_MARGIN_S + 1) * 1000;
  assert.ok((await late.bundler.send(op).catch((e: unknown) => e)) instanceof NeverBroadcastError);
  assert.equal(late.chain.state.sent.length, 0);

  const clock2 = { at: NOW };
  const { chain, bundler } = await setup(t, { now: clock2 });
  const op2 = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op2);
  // 59 s before validUntil, still pending: cancelled now, not left to revert after validUntil.
  clock2.at = (S + SPONSOR_VALIDITY_S - VALIDITY_MARGIN_S + 1) * 1000;
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 2);
  assert.equal(parseTransaction(chain.state.sent[1]!).gas, 21_000n);
});

test('no re-signature without the funds for it: a replacement waits while the submitter is short', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  const own = signed(await bundler.prepare(await unsigned(), { sponsor: false }));
  await bundler.send(own);
  chain.state.balance = 1n;
  clock.at += STUCK_MS + 1;
  await bundler.maintain();
  assert.equal(chain.state.sent.length, 1);
  assert.equal((await sends(db))[0]!.tx_hashes.length, 1);
});

test('two replicas reading the same final receipt settle it once', async (t) => {
  const { db, chain, bundler, restart } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  chain.mine(chain.state.sent[0]!, hashOf(op), 'success', 7_000_000_000n);
  const other = restart();
  await Promise.all([
    bundler.maintain(),
    other.maintain(),
    bundler.receipt(hashOf(op)),
    other.receipt(hashOf(op)),
  ]);
  const rows = await db.query<{ key: string; status: string; actual: string }>(
    `SELECT user_op_hash AS key, status, actual_cost_wei::text AS actual FROM own_paymaster_reservations`,
  );
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows.every((r) => r.status === 'settled'));
  assert.equal(rows.rows.find((r) => r.key === hashOf(op))!.actual, '7000000000');
  const row = await db.query<{ final: boolean; settled: boolean }>(
    'SELECT final, settled FROM own_paymaster_sends',
  );
  assert.deepEqual({ ...row.rows[0] }, { final: true, settled: true });
});

/** A CDP bundler stand-in that records what it was asked. */
const fakeCdp = () => {
  const calls: string[] = [];
  return {
    calls,
    bundler: {
      prepare: async (op: UserOperation<'0.6'>) => (calls.push('prepare'), op),
      send: async () => (calls.push('send'), `0x${'1'.repeat(64)}` as Hex),
      receipt: async () => (calls.push('receipt'), null),
    },
  };
};

test('while ours cannot be built, NEW operations use CDP unsponsored (logged, effective cdp_fallback)', async (t) => {
  const db = await database(t);
  const lines: string[] = [];
  const cdp = fakeCdp();
  const lazy = lazyBundler({
    make: async () => {
      throw new BundlerError('RPC_UNAVAILABLE', 'own bundler: keys are not provisioned.');
    },
    fallback: cdp.bundler,
    log: (line) => lines.push(line),
    route: { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER },
  });
  const op = await unsigned();
  // No sponsorship on that path: refused as busy, CDP is never asked.
  await assert.rejects(
    lazy.prepare(op),
    (e: unknown) => e instanceof SponsorError && /CDP is the fallback/.test(e.message),
  );
  await assert.rejects(lazy.prepare(op, { intent: intentOf('registration') }), SponsorError);
  assert.deepEqual(cdp.calls, []);
  // A self-paid one goes through.
  assert.equal(await lazy.prepare(op, { sponsor: false }), op);
  await lazy.send(op); // prepared by CDP: not ours, CDP sends it
  assert.deepEqual(cdp.calls, ['prepare', 'send']);
  assert.equal(lazy.effective(), 'cdp_fallback');
  assert.equal(await lazy.readiness(), 'unavailable');
  assert.equal(await lazy.maintain(), 0);
  assert.match(lines[0]!, /cdp_fallback/);
});

test('an operation ours prepared is never forwarded to CDP, even when ours cannot be built later', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const cdp = fakeCdp();
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const healthy = lazyBundler({ make: async () => bundler, fallback: cdp.bundler, route });
  // Prepared by ours (sponsored), and a self-paid one too.
  const sponsored = signed(
    await healthy.prepare(await unsigned(), { intent: intentOf('registration') }),
  );
  const selfPaid = signed(
    await healthy.prepare(await unsigned([register()], { nonce: 6n }), { sponsor: false }),
  );
  // A new instance whose own bundler cannot be built (keys gone, KEK rotated...).
  const broken = lazyBundler({
    make: async () => {
      throw new Error('cannot build');
    },
    fallback: cdp.bundler,
    route,
  });
  await assert.rejects(broken.send(sponsored), /only sent by it/);
  await assert.rejects(broken.send(selfPaid), /only sent by it/);
  assert.deepEqual(cdp.calls, [], 'nothing of ours reached CDP');
  // Sent through ours while healthy: its receipt stays with ours too (same nonce, same hash).
  await healthy.send(sponsored);
  assert.equal(chain.state.sent.length, 1);
  await assert.rejects(broken.receipt(hashOf(sponsored)), /only sent by it/);
  assert.deepEqual(cdp.calls, []);
});

test('an operation CDP prepared never moves to ours, even with ours healthy', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const cdp = fakeCdp();
  const lazy = lazyBundler({
    make: async () => bundler,
    fallback: cdp.bundler,
    route: { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER },
  });
  // Sponsored by Coinbase's paymaster, and a self-paid one ours never prepared.
  const coinbase = signed({
    ...(await unsigned()),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 12_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c${'00'.repeat(174)}`,
  });
  const foreignSelfPaid = signed({ ...coinbase, nonce: 7n, paymasterAndData: '0x' });
  await lazy.send(coinbase);
  await lazy.send(foreignSelfPaid);
  await lazy.receipt(hashOf(coinbase));
  assert.deepEqual(cdp.calls, ['send', 'send', 'receipt']);
  assert.equal(chain.state.sent.length, 0, 'ours sent nothing');
  // Nothing of ours was needed, so ours was not even built ('unknown'); once built: 'direct'.
  assert.equal(lazy.effective(), 'unknown');
  await lazy.readiness();
  assert.equal(lazy.effective(), 'direct');
});

test('the upkeep cron: 404 without its secret; off; on with a count; drain until nothing is open; 503', async (t) => {
  const SECRET = 'cron-secret-of-sixteen+';
  const serve = async (upkeep: () => Promise<OwnBundlerUpkeep | undefined>, auth?: string) => {
    const app = Fastify();
    registerOwnBundlerMaintainRoute(app, { cronSecret: SECRET, upkeep });
    t.after(() => app.close());
    return app.inject({
      method: 'GET',
      url: '/api/cron/own-paymaster-maintain',
      ...(auth ? { headers: { authorization: auth } } : {}),
    });
  };
  const auth = `Bearer ${SECRET}`;
  const direct = (looked = 3): OwnBundlerUpkeep => ({
    mode: 'direct',
    maintain: async () => looked,
    open: async () => 0,
  });
  assert.equal((await serve(async () => direct())).statusCode, 404);
  assert.equal((await serve(async () => direct(), 'Bearer wrong-secret-xxxxxxxx')).statusCode, 404);
  assert.deepEqual((await serve(async () => undefined, auth)).json(), { state: 'off' });
  assert.deepEqual(
    (
      await serve(async () => {
        throw new Error('runtime not configured');
      }, auth)
    ).json(),
    { state: 'off' },
  );
  let asked = 0;
  assert.deepEqual(
    (
      await serve(
        async () => ({ ...direct(), maintain: async (limit) => ((asked = limit ?? 0), 3) }),
        auth,
      )
    ).json(),
    { state: 'on', looked: 3 },
  );
  assert.equal(asked, 50);
  // Drain: works while sends of ours are open, reports what is left, then says off.
  let open = 2;
  const drain: OwnBundlerUpkeep = {
    mode: 'drain',
    maintain: async () => ((open -= 1), 1),
    open: async () => open,
  };
  assert.deepEqual((await serve(async () => drain, auth)).json(), {
    state: 'drain',
    open: 1,
    looked: 1,
  });
  assert.deepEqual((await serve(async () => drain, auth)).json(), {
    state: 'drain',
    open: 0,
    looked: 1,
  });
  assert.deepEqual((await serve(async () => drain, auth)).json(), { state: 'off' });
  const failed = await serve(
    async () => ({
      ...direct(),
      maintain: async () => {
        throw new Error('rpc down');
      },
    }),
    auth,
  );
  assert.equal(failed.statusCode, 503);
});

test('switched to CDP with sends of ours open: new work goes to CDP, ours still finish on our lane', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  // While direct: two operations of ours sent (one sponsored, one self-paid), not mined yet.
  const before = fakeCdp();
  const directLazy = lazyBundler({ make: async () => bundler, fallback: before.bundler, route });
  const a = signed(
    await directLazy.prepare(await unsigned(), { intent: intentOf('registration') }),
  );
  const b = signed(
    await directLazy.prepare(await unsigned([register()], { nonce: 6n }), { sponsor: false }),
  );
  await directLazy.send(a);
  await directLazy.send(b);
  assert.equal(chain.state.sent.length, 2);

  // The switch flips to CDP: a DRAIN instance (new work: cdp), CDP-routed for every flow.
  const cdp = fakeCdp();
  const drainer = lazyBundler({
    make: async () => bundler,
    fallback: cdp.bundler,
    route,
    newWork: 'cdp',
  });
  const flows = drainer.routes(cdp.bundler);
  assert.equal(await drainer.open(), 2);
  // New work goes to CDP at once; nothing is prepared, signed or sponsored by ours.
  const signaturesBefore = chain.state.paymasterSignatures;
  const fresh = await unsigned([register()], { nonce: 7n });
  await flows.prepare(fresh, { intent: intentOf('registration') });
  assert.deepEqual(cdp.calls, ['prepare']);
  assert.equal(chain.state.paymasterSignatures, signaturesBefore);
  assert.equal(await drainer.readiness(), 'prepare');
  // A resend and a receipt of ours stay on our lane (the same stored bytes), never CDP.
  await flows.send(a);
  await flows.receipt(hashOf(b));
  assert.deepEqual(cdp.calls, ['prepare']);
  assert.equal(chain.state.sent.length, 2, 'nothing re-signed');
  // The drain finishes them: mined and final, settled, nothing open, and the drain stops.
  chain.mine(chain.state.sent[0]!, hashOf(a), 'success');
  chain.mine(chain.state.sent[1]!, hashOf(b), 'success');
  await drainer.maintain();
  assert.equal(await drainer.open(), 0);
  const settled = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM own_paymaster_reservations WHERE status = 'settled'",
  );
  assert.equal(settled.rows[0]!.n, 3); // a's sponsorship + a's and b's exposures
  assert.equal(await drainer.maintain(), 0);
});

test('provenance never ages out; an old self-paid operation of ours is still ours', async (t) => {
  const clock = { at: NOW };
  const { db, bundler } = await setup(t, { now: clock });
  const cdp = fakeCdp();
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const healthy = lazyBundler({ make: async () => bundler, fallback: cdp.bundler, route });
  // Self-paid: no paymaster marker; only the provenance record says it is ours.
  const old = signed(await healthy.prepare(await unsigned(), { sponsor: false }));
  clock.at += 10 * 86_400_000;
  for (let i = 0; i < 3; i++) await bundler.maintain();
  const kept = await db.query('SELECT 1 FROM own_paymaster_prepared');
  assert.equal(kept.rows.length, 1);
  const broken = lazyBundler({
    make: async () => {
      throw new Error('cannot build');
    },
    fallback: cdp.bundler,
    route,
  });
  await assert.rejects(broken.send(old), /only sent by it/);
  await assert.rejects(broken.receipt(hashOf(old)), /only sent by it/);
  assert.deepEqual(cdp.calls, []);
});

test('rows waiting for finality never crowd out the stuck lane head', async (t) => {
  const clock = { at: NOW };
  const { db, chain, bundler } = await setup(t, { now: clock });
  chain.state.finalizedBlock = 100n; // nothing below is final yet
  const ops: UserOperation<'0.6'>[] = [];
  for (let i = 0; i < 4; i++)
    ops.push(
      signed(
        await bundler.prepare(await unsigned([register()], { nonce: BigInt(10 + i) }), {
          sponsor: false,
        }),
      ),
    );
  for (const op of ops) await bundler.send(op);
  // Nonces 0..2 are mined (included, not final); nonce 3 is the lane head, unmined and stuck.
  for (let i = 0; i < 3; i++) chain.mine(chain.state.sent[i]!, hashOf(ops[i]!), 'success');
  await bundler.maintain();
  const sentBefore = chain.state.sent.length;
  clock.at += STUCK_MS + 1;
  // With a limit far below the waiting rows, the head is still looked after first and bumped.
  await bundler.maintain(2);
  assert.equal(chain.state.sent.length, sentBefore + 1);
  assert.equal(parseTransaction(chain.state.sent.at(-1)!).nonce, 3);
  const head = (await sends(db)).find((r) => r.nonce === '3')!;
  assert.equal(head.tx_hashes.length, 2);
});

test('final only if the block at that height is the receipt block', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await bundler.send(op);
  chain.mine(chain.state.sent[0]!, hashOf(op), 'success');
  // Another node's finalized chain has a different block at height 101.
  chain.state.blocks.set(101n, `0x${'e'.repeat(64)}`);
  await bundler.maintain();
  assert.deepEqual(await reservation(db, hashOf(op)), { status: 'sent', actual_cost_wei: null });
  // Once that height holds the receipt's block, it settles.
  chain.state.blocks.set(101n, `0x${'b'.repeat(64)}`);
  await bundler.maintain();
  assert.equal((await reservation(db, hashOf(op)))!.status, 'settled');
});

test('settlement runs in parallel and beyond the lane limit (4 x per run)', async (t) => {
  const { db, chain, bundler } = await setup(t);
  chain.state.finalizedBlock = 100n;
  const ops: UserOperation<'0.6'>[] = [];
  for (let i = 0; i < 12; i++)
    ops.push(
      signed(
        await bundler.prepare(await unsigned([register()], { nonce: BigInt(20 + i) }), {
          sponsor: false,
        }),
      ),
    );
  for (const op of ops) await bundler.send(op);
  ops.forEach((op, i) => chain.mine(chain.state.sent[i]!, hashOf(op), 'success'));
  // Recorded (included), not final yet.
  for (let i = 0; i < 3; i++) await bundler.maintain();
  const included = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM own_paymaster_sends WHERE status = 'included' AND NOT final",
  );
  assert.equal(included.rows[0]!.n, 12);
  // All final now: one run with a lane limit of 5 settles all 12 (pass 2 takes up to 20).
  chain.state.finalizedBlock = 1_000n;
  await bundler.maintain(5);
  const left = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM own_paymaster_sends WHERE NOT final',
  );
  assert.equal(left.rows[0]!.n, 0);
  const settled = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM own_paymaster_reservations WHERE status = 'settled'",
  );
  assert.equal(settled.rows[0]!.n, 12);
});

test('draining never first-sends a draft ours prepared but never committed', async (t) => {
  const { db, chain, bundler, clock } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const directLazy = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  // Prepared by ours while direct (sponsored and self-paid), never sent.
  const sponsored = signed(
    await directLazy.prepare(await unsigned(), { intent: intentOf('registration') }),
  );
  const selfPaid = signed(
    await directLazy.prepare(await unsigned([register()], { nonce: 6n }), { sponsor: false }),
  );
  const cdp = fakeCdp();
  const drainer = lazyBundler({
    make: async () => bundler,
    fallback: cdp.bundler,
    route,
    newWork: 'cdp',
  });
  const flows = drainer.routes(cdp.bundler);
  const signaturesBefore = chain.state.paymasterSignatures;
  // Refused, but not as never broadcast: an older deployment may still send either meanwhile.
  for (const [op, reason] of [
    [sponsored, /still open/],
    [selfPaid, /older deployment may still send/],
  ] as const) {
    const error = await flows.send(op).catch((e: unknown) => e);
    assert.ok(error instanceof BundlerError && !(error instanceof NeverBroadcastError));
    assert.match((error as Error).message, reason);
  }
  // No nonce taken, nothing signed or broadcast, not handed to CDP either.
  assert.equal(await laneNonce(db), null);
  assert.equal(chain.state.sent.length, 0);
  assert.equal(chain.state.paymasterSignatures, signaturesBefore);
  assert.deepEqual(cdp.calls, []);
  assert.equal(await drainer.open(), 0);
  // The sponsored draft's reservation is untouched (it lapses by time, never 'sent').
  assert.equal((await reservation(db, hashOf(sponsored)))!.status, 'reserved');
  // Once it has expired nobody can send it: now never broadcast. The self-paid one never is.
  clock.at = (S + SPONSOR_VALIDITY_S + EXPIRY_MARGIN_S + 1) * 1000;
  assert.ok((await flows.send(sponsored).catch((e: unknown) => e)) instanceof NeverBroadcastError);
  assert.ok(
    !((await flows.send(selfPaid).catch((e: unknown) => e)) instanceof NeverBroadcastError),
  );
  assert.equal(chain.state.sent.length, 0);
});

test('a draft an older deployment sends during the switch is followed by the draining one', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const older = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  const draft = signed(await older.prepare(await unsigned(), { intent: intentOf('registration') }));
  const cdp = fakeCdp();
  const flows = lazyBundler({
    make: async () => bundler,
    fallback: cdp.bundler,
    route,
    newWork: 'cdp',
  }).routes(cdp.bundler);
  // The draining deployment refuses it (ambiguous); the older one, still direct, then sends it.
  const refused = await flows.send(draft).catch((e: unknown) => e);
  assert.ok(refused instanceof BundlerError && !(refused instanceof NeverBroadcastError));
  await older.send(draft);
  // Asked again, the draining deployment follows that send: no second transaction, no CDP.
  assert.equal(await flows.send(draft), hashOf(draft));
  assert.equal((await reservation(db, hashOf(draft)))!.status, 'sent');
  assert.equal(new Set(chain.state.sent.map((raw) => parseTransaction(raw).nonce)).size, 1);
  assert.deepEqual(cdp.calls, []);
});

test('draining still recovers a send committed before its broadcast (same bytes, same nonce)', async (t) => {
  const { db, chain, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const directLazy = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  const op = signed(
    await directLazy.prepare(await unsigned(), { intent: intentOf('registration') }),
  );
  chain.state.sendFails = true;
  await assert.rejects(directLazy.send(op)); // committed (row + nonce), broadcast failed
  const [stored] = await sends(db);
  assert.equal(await laneNonce(db), '1');
  chain.state.sendFails = false;
  const cdp = fakeCdp();
  const drainer = lazyBundler({
    make: async () => bundler,
    fallback: cdp.bundler,
    route,
    newWork: 'cdp',
  });
  await drainer.routes(cdp.bundler).send(op);
  assert.deepEqual(chain.state.sent, [stored!.raw_tx]);
  assert.equal(await laneNonce(db), '1');
  assert.deepEqual(cdp.calls, []);
});

test('unknown provenance (database error or timeout) goes nowhere; known CDP still flows', async (t) => {
  // Real ops of each kind first (healthy database), then the database fails.
  const { db, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const directLazy = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  const sponsoredOwn = signed(
    await directLazy.prepare(await unsigned(), { intent: intentOf('registration') }),
  );
  const selfPaidCommitted = signed(
    await directLazy.prepare(await unsigned([register()], { nonce: 6n }), { sponsor: false }),
  );
  await directLazy.send(selfPaidCommitted);
  const preparedOnly = signed(
    await directLazy.prepare(await unsigned([register()], { nonce: 7n }), { sponsor: false }),
  );
  const knownCdp = signed({
    ...(await unsigned([register()], { nonce: 8n })),
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 12_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c${'00'.repeat(174)}`,
  });

  const throwing = {
    query: async () => {
      throw new Error('database down');
    },
  } as unknown as Database;
  const silent = { query: () => new Promise(() => {}) } as unknown as Database;
  for (const failing of [throwing, silent])
    for (const newWork of ['cdp', 'direct'] as const) {
      const cdp = fakeCdp();
      const lines: string[] = [];
      const lazy = lazyBundler({
        make: async () => bundler,
        fallback: cdp.bundler,
        log: (line) => lines.push(line),
        route: { ...route, db: failing },
        newWork,
      });
      const flows = newWork === 'cdp' ? lazy.routes(cdp.bundler) : lazy;
      // Known CDP: established from its own data, no database needed.
      await flows.send(knownCdp);
      assert.deepEqual(cdp.calls, ['send'], `${newWork}: known CDP flows`);
      // Unknown provenance: refused, retriable, never forwarded to CDP.
      const unavailable = (e: unknown) => e instanceof BundlerError && e.code === 'RPC_UNAVAILABLE';
      await assert.rejects(flows.send(selfPaidCommitted), unavailable);
      await assert.rejects(flows.send(preparedOnly), unavailable);
      await assert.rejects(flows.receipt(hashOf(selfPaidCommitted)), unavailable);
      if (newWork === 'cdp') await assert.rejects(flows.send(sponsoredOwn), unavailable);
      assert.deepEqual(cdp.calls, ['send'], `${newWork}: nothing unknown reached CDP`);
      assert.ok(lines.some((line) => /provenance unknown/.test(line)));
    }
  // after every refusal the original lane is intact: one committed send, its
  // nonce, the same stored bytes, and every liability still held (nothing settled or released).
  const rows = await sends(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.user_op_hash, hashOf(selfPaidCommitted));
  assert.equal(rows[0]!.status, 'submitted');
  assert.equal(rows[0]!.tx_hashes.length, 1);
  assert.equal(await laneNonce(db), '1');
  assert.equal((await reservation(db, hashOf(sponsoredOwn)))!.status, 'reserved');
  assert.equal((await reservation(db, exposureKey(hashOf(selfPaidCommitted))))!.status, 'sent');
});

test('open sends are counted per chain; a drain that cannot build ours alerts', async (t) => {
  const { db, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const directLazy = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  await directLazy.send(signed(await directLazy.prepare(await unsigned(), { sponsor: false })));
  const otherChain = lazyBundler({
    make: async () => bundler,
    fallback: fakeCdp().bundler,
    route: { ...route, chainId: 84532 },
    newWork: 'cdp',
  });
  assert.equal(await otherChain.open(), 0);
  const lines: string[] = [];
  const cannotBuild = lazyBundler({
    make: async () => {
      throw new Error('keys gone');
    },
    fallback: fakeCdp().bundler,
    log: (line) => lines.push(line),
    route,
    newWork: 'cdp',
  });
  assert.equal(await cannotBuild.open(), 1);
  assert.equal(await cannotBuild.maintain(), 0);
  assert.ok(lines.some((line) => /ALERT drain cannot build ours, 1 sends open/.test(line)));
});

test('only our provisioned submitters count as open; a stray row never holds the drain', async (t) => {
  const { db, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const lazy = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  await lazy.send(signed(await lazy.prepare(await unsigned(), { sponsor: false })));
  assert.equal(await lazy.open(), 1);
  await db.query('UPDATE own_paymaster_sends SET submitter = $1', [
    '0x9999999999999999999999999999999999999999',
  ]);
  assert.equal(await lazy.open(), 0);
});

test('a self-paid draft refused while draining is ambiguous, never never-broadcast', async (t) => {
  const { db, bundler } = await setup(t);
  const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
  const directLazy = lazyBundler({ make: async () => bundler, fallback: fakeCdp().bundler, route });
  const draft = signed(await directLazy.prepare(await unsigned(), { sponsor: false }));
  const drainer = lazyBundler({
    make: async () => bundler,
    fallback: fakeCdp().bundler,
    route,
    newWork: 'cdp',
  });
  const error = await drainer
    .routes(fakeCdp().bundler)
    .send(draft)
    .catch((e: unknown) => e);
  // A self-paid draft has no expiry to prove it never left: ambiguous, never the marker.
  assert.ok(error instanceof BundlerError);
  assert.ok(!(error instanceof NeverBroadcastError));
  assert.notEqual((error as { neverBroadcast?: unknown }).neverBroadcast, true);
});

test('a reservation another instance sent and settled in our window is never declared never-sent', async (t) => {
  const { db, chain, bundler, restart } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  // Instance Y reads nothing stored; then, while Y simulates (outside its transaction), instance X
  // sends the same operation, it is mined and final, and X settles it.
  const y = restart();
  chain.state.onSimulate = async () => {
    await bundler.send(op);
    chain.mine(chain.state.sent[0]!, hashOf(op), 'success');
    await bundler.maintain();
  };
  const result = await y.send(op).catch((e: unknown) => e);
  assert.ok(!(result instanceof NeverBroadcastError), 'never declared never-broadcast');
  assert.equal(result, hashOf(op)); // Y follows the stored row instead
  assert.equal((await reservation(db, hashOf(op)))!.status, 'settled');
  assert.equal(chain.state.sent.length, 1, 'nothing sent twice');
});

test('a reservation used elsewhere without a visible stored send is ambiguous, never never-sent', async (t) => {
  const { db, bundler, restart } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await db.query(
    "UPDATE own_paymaster_reservations SET status = 'settled', actual_cost_wei = 1, settled_block = 1 WHERE user_op_hash = $1",
    [hashOf(op)],
  );
  const error = await restart()
    .send(op)
    .catch((e: unknown) => e);
  assert.ok(error instanceof BundlerError);
  assert.ok(!(error instanceof NeverBroadcastError));
  assert.match((error as Error).message, /used elsewhere/);
});

test('a competing send committed after the margin refusal is followed, never declared never-sent', async (t) => {
  const { db, chain, bundler, restart, clock } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  const inMargin = (S + SPONSOR_VALIDITY_S - VALIDITY_MARGIN_S + 1) * 1000;
  const y = restart();
  clock.at = inMargin;
  const first = await y.send(op).catch((e: unknown) => e);
  assert.ok(first instanceof BundlerError && !(first instanceof NeverBroadcastError));
  // Instance X, its clock behind Y's, commits and broadcasts the same operation afterwards.
  clock.at = NOW;
  await bundler.send(op);
  assert.equal(chain.state.sent.length, 1);
  // Y asks again, in the margin and past expiry alike: it follows the stored send.
  clock.at = inMargin;
  assert.equal(await y.send(op), hashOf(op));
  clock.at = (S + SPONSOR_VALIDITY_S + EXPIRY_MARGIN_S + 1) * 1000;
  assert.equal(await y.send(op), hashOf(op));
  assert.equal((await reservation(db, hashOf(op)))!.status, 'sent');
  // Only X's transaction, rebroadcast or cancelled at its own nonce: never a second payment.
  const txs = chain.state.sent.map((raw) => parseTransaction(raw));
  assert.deepEqual([...new Set(txs.map((tx) => tx.nonce))], [0]);
  assert.equal(
    new Set(txs.filter((tx) => tx.data && tx.data !== '0x').map((tx) => tx.data)).size,
    1,
  );
});

test('once never-sent is answered, no instance can still commit a send of it', async (t) => {
  const { db, chain, bundler, restart, clock } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  clock.at = (S + SPONSOR_VALIDITY_S + EXPIRY_MARGIN_S + 1) * 1000;
  assert.ok(
    (await restart()
      .send(op)
      .catch((e: unknown) => e)) instanceof NeverBroadcastError,
  );
  // Instance X, its clock still inside the validity window, tries to send it after that answer.
  clock.at = NOW;
  assert.ok((await bundler.send(op).catch((e: unknown) => e)) instanceof NeverBroadcastError);
  assert.equal(chain.state.sent.length, 0);
  assert.equal((await reservation(db, hashOf(op)))!.status, 'expired');
  assert.equal((await db.query('SELECT 1 FROM own_paymaster_sends')).rows.length, 0);
});

test('a sponsorship without any reservation is ambiguous, never never-sent', async (t) => {
  const { db, chain, bundler, restart } = await setup(t);
  const op = signed(await bundler.prepare(await unsigned(), { intent: intentOf('registration') }));
  await db.query('DELETE FROM own_paymaster_reservations WHERE user_op_hash = $1', [hashOf(op)]);
  const error = await restart()
    .send(op)
    .catch((e: unknown) => e);
  assert.ok(error instanceof BundlerError);
  assert.ok(!(error instanceof NeverBroadcastError));
  assert.match((error as Error).message, /no reservation/);
  assert.equal(chain.state.sent.length, 0);
});

test('a sponsorship records whom it is for, its submitter exposure too; release gives back a never-sent one', async (t) => {
  const { db, bundler } = await setup(t);
  const intent = { ...intentOf('registration'), accountId: 'ws-1' };
  const a = signed(await bundler.prepare(await unsigned(), { intent }));
  const b = signed(await bundler.prepare(await unsigned([register()], { nonce: 6n }), { intent }));
  await bundler.send(a);
  const who = async (hash: string) =>
    (
      await db.query<{ sender: string; account_id: string; status: string; released: boolean }>(
        `SELECT sender, account_id, status, released_at IS NOT NULL AS released
         FROM own_paymaster_reservations WHERE user_op_hash = $1`,
        [hash],
      )
    ).rows[0];
  const spender = SPENDER.toLowerCase();
  assert.deepEqual(await who(hashOf(a)), {
    sender: spender,
    account_id: 'ws-1',
    status: 'sent',
    released: false,
  });
  assert.deepEqual(await who(exposureKey(hashOf(a))), {
    sender: spender,
    account_id: 'ws-1',
    status: 'sent',
    released: false,
  });
  // Never sent: given back at once, and then never sent.
  await bundler.release!(hashOf(b));
  await bundler.release!(hashOf(b));
  assert.deepEqual(await who(hashOf(b)), {
    sender: spender,
    account_id: 'ws-1',
    status: 'expired',
    released: true,
  });
  await assert.rejects(bundler.send(b));
  assert.equal((await sends(db)).length, 1);
  // Sent: never touched.
  await bundler.release!(hashOf(a));
  assert.equal((await who(hashOf(a)))?.status, 'sent');
});

test('budget: the per-account refusals are "busy" too', async (t) => {
  const { bundler } = await setup(t, { limits: { accountHourlyOrdinaryWei: 1n } });
  const error = await bundler
    .prepare(await unsigned(), { intent: { ...intentOf('registration'), accountId: 'ws-1' } })
    .catch((e: unknown) => e);
  assert.ok(error instanceof SponsorError && error.rejection === 'busy');
  assert.match(error.message, /account_hourly/);
  // Without an account the same operation is sponsored.
  await bundler.prepare(await unsigned(), { intent: intentOf('registration') });
});

const tipsAfterBumps = async (
  t: { after: (fn: () => Promise<unknown>) => void },
  chainId: number,
  firstTip: bigint,
  bumps: number,
) => {
  const clock = { at: NOW };
  const { chain, bundler } = await setup(t, { now: clock, chainId });
  chain.state.balance = 100n * 10n ** 18n;
  const client = chain.client as unknown as { estimateMaxPriorityFeePerGas: () => Promise<bigint> };
  client.estimateMaxPriorityFeePerGas = async () => firstTip;
  await bundler.send(signed(await bundler.prepare(await unsigned(), { sponsor: false })));
  for (let i = 0; i < bumps; i++) {
    clock.at += STUCK_MS + 1;
    await bundler.maintain();
  }
  return chain.state.sent.map((raw) => parseTransaction(raw).maxPriorityFeePerGas ?? 0n);
};

test('a tip of 0 can be replaced: by the chain minimum, on Base and on Arc', async (t) => {
  assert.deepEqual(await tipsAfterBumps(t, BASE_MAINNET, 0n, 2), [0n, 1_000_000n, 2_000_000n]);
  const GWEI = 1_000_000_000n;
  assert.deepEqual(await tipsAfterBumps(t, ARC_TESTNET, 0n, 2), [0n, GWEI, 2n * GWEI]);
});

test('the tip bump is the larger of +30% and the minimum, within the ceiling', async (t) => {
  // Above 3.34 x the minimum, Base's +30% stands as before; under it the minimum raises more.
  assert.deepEqual(await tipsAfterBumps(t, BASE_MAINNET, 10_000_000n, 1), [
    10_000_000n,
    13_000_000n,
  ]);
  assert.deepEqual(await tipsAfterBumps(t, BASE_MAINNET, 1_000_000n, 1), [1_000_000n, 2_000_000n]);
  // Just under the 0.05 gwei ceiling: capped, never above it.
  assert.deepEqual(await tipsAfterBumps(t, BASE_MAINNET, 49_000_000n, 1), [
    49_000_000n,
    50_000_000n,
  ]);
});

test('every bump and cancel a send may take stays under the tip ceiling, on each chain', () => {
  for (const chainId of [BASE_MAINNET, ARC_TESTNET]) {
    const params = chainParams(chainId);
    assert.ok(
      params.minBumpWei * BigInt(MAX_REPLACEMENTS + 3) < params.gasCeilings.maxPriorityFeePerGas,
    );
  }
});

// Arc's node holds only about 16 nonces ahead of the mined head (measured on testnet, 1 Nov), and
// answers "txpool is full" past that. A stuck lane must drain in one maintain run.
const arcLane = async (t: Parameters<typeof setup>[0], count: number) => {
  const clock = { at: NOW };
  const ctx = await setup(t, { chainId: ARC_TESTNET, now: clock });
  ctx.chain.state.balance = 10n ** 19n;
  ctx.chain.state.finalized = 0;
  ctx.chain.state.sendFails = true;
  for (let i = 0; i < count; i++) {
    const op = await ctx.bundler.prepare(await unsigned([register()], { nonce: BigInt(i) }), {
      sponsor: false,
    });
    await ctx.bundler.send(signed(op)).catch(() => undefined);
    // A backlog from before the cap: hidden from it while it is built.
    await ctx.db.query("UPDATE own_paymaster_sends SET status = 'included'");
  }
  ctx.chain.state.sendFails = false;
  await ctx.db.query("UPDATE own_paymaster_sends SET status = 'submitted'");
  return { ...ctx, clock };
};
/** A node as measured: refuses past the window, mines every contiguous nonce it holds. */
const arcNode = (chain: ReturnType<typeof fakeBase>, seen: number[] = []) => {
  const held = new Set<number>();
  chain.state.onSend = (raw) => {
    const nonce = parseTransaction(raw).nonce ?? 0;
    if (nonce >= chain.state.mined + 16) throw new Error('txpool is full');
    seen.push(nonce);
    held.add(nonce);
    while (held.has(chain.state.mined)) chain.state.mined += 1;
  };
};

test('Arc: a backlog past the pool window drains in one maintain run', async (t) => {
  const { bundler, chain } = await arcLane(t, 40);
  const seen: number[] = [];
  arcNode(chain, seen);
  await bundler.maintain(50);
  assert.equal(chain.state.mined, 40);
  // Nothing was offered past the window: no refused sends wasting the node's rate limit.
  assert.equal(new Set(seen).size, 40);
});

test('Arc: nothing past the pool window is signed or sent, even when it can no longer succeed', async (t) => {
  const { bundler, chain, clock, db } = await arcLane(t, 20);
  const before = chain.state.sent.length;
  await db.query('UPDATE own_paymaster_sends SET valid_until = $1', [S]);
  clock.at += 60_000;
  // The head never lands here: the window stays where it is.
  chain.state.simulate = 'revert';
  chain.state.onSend = () => undefined;
  await bundler.maintain(5);
  await bundler.maintain(50);
  const nonces = chain.state.sent.slice(before).map((raw) => parseTransaction(raw).nonce ?? 0);
  assert.ok(nonces.length > 0);
  assert.ok(Math.max(...nonces) < 16);
});

test('Arc: expired neighbours are cancelled before the head can release them', async (t) => {
  const { bundler, chain, clock, db } = await arcLane(t, 3);
  await db.query('UPDATE own_paymaster_sends SET valid_until = $1', [S]);
  clock.at += 60_000;
  chain.state.simulate = 'revert';
  const seen: number[] = [];
  chain.state.onSend = (raw) => void seen.push(parseTransaction(raw).nonce ?? 0);
  await bundler.maintain(5);
  assert.deepEqual(seen, [2, 1, 0]);
});

test('Arc: a head the node knows but does not mine is replaced after 30 s, not 3 minutes', async (t) => {
  const { bundler, chain, clock } = await arcLane(t, 1);
  chain.state.sent.push(chain.state.lastRefused!);
  const before = chain.state.sent.length;
  clock.at += 31_000;
  await bundler.maintain(5);
  assert.ok(chain.state.sent.length > before);
  const last = parseTransaction(chain.state.sent.at(-1)!);
  const first = parseTransaction(chain.state.lastRefused!);
  assert.ok(last.maxFeePerGas! > first.maxFeePerGas!);
});

test('Arc: a head refused as underpriced is replaced at once, without waiting to be stuck', async (t) => {
  const { bundler, chain } = await arcLane(t, 1);
  let answers = 0;
  chain.state.onSend = () => {
    if (answers++ === 0) throw new Error('replacement transaction underpriced');
  };
  await bundler.maintain(5);
  assert.equal(answers, 2);
  assert.equal(chain.state.sent.length, 1);
  const raw = chain.state.sent[0]!;
  assert.ok(
    parseTransaction(raw).maxFeePerGas! > parseTransaction(chain.state.lastRefused!).maxFeePerGas!,
  );
});

test('Base keeps its lane upkeep: no window, one pass, a known head waits for STUCK_MS', async (t) => {
  const clock = { at: NOW };
  const { bundler, chain } = await setup(t, { now: clock });
  chain.state.finalized = 0;
  chain.state.sendFails = true;
  for (let i = 0; i < 20; i++) {
    const op = await bundler.prepare(await unsigned([register()], { nonce: BigInt(i) }), {
      sponsor: false,
    });
    await bundler.send(signed(op)).catch(() => undefined);
  }
  chain.state.sendFails = false;
  const seen: number[] = [];
  chain.state.onSend = (raw) => void seen.push(parseTransaction(raw).nonce ?? 0);
  await bundler.maintain(50);
  // Every unknown send rebroadcast once, past any window.
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i),
  );
  seen.length = 0;
  clock.at += 31_000;
  await bundler.maintain(50);
  assert.deepEqual(seen, [], 'known to the node, not stuck: nothing is sent again');
});

test('Arc: the node\'s pool and rate limits are "not now": no failure line, the next pass offers again', async (t) => {
  const { bundler, chain, lines } = await arcLane(t, 3);
  lines.length = 0;
  let answers = 0;
  chain.state.onSend = (raw) => {
    answers++;
    if (answers === 1) throw Object.assign(new Error('txpool is full'), { code: -32003 });
    if (answers === 2) throw Object.assign(new Error('rate limit exceeded'), { code: -32005 });
    if ((parseTransaction(raw).nonce ?? 0) === chain.state.mined) chain.state.mined += 1;
  };
  await bundler.maintain(50);
  assert.equal(chain.state.mined, 3);
  assert.deepEqual(
    lines.filter(
      (line) => /rebroadcast failed|broadcast refused/.test(line) && !/stored/.test(line),
    ),
    [],
  );
});

// Arc's lanes: a second submitter, each op on its row's lane, gated on chain, capped.
const secondKey = generatePrivateKey();
const second = privateKeyToAccount(secondKey);
const lanesOn = async (t: Parameters<typeof setup>[0], clock = { at: NOW }) => {
  const ctx = await setup(t, { chainId: ARC_TESTNET, now: clock });
  const { state } = ctx.chain;
  state.balance = 10n ** 19n;
  state.finalized = 0;
  const allowed = new Map<string, boolean>([
    [submitter.address.toLowerCase(), true],
    [second.address.toLowerCase(), true],
  ]);
  const balances = new Map<string, bigint>();
  const client = ctx.chain.client as unknown as Record<string, (args: never) => unknown>;
  const read = client.readContract!;
  client.readContract = ((args: { functionName: string; args?: string[] }) =>
    args.functionName === 'isBundlerAllowed'
      ? Promise.resolve(allowed.get(args.args![0]!.toLowerCase()) ?? false)
      : read(args as never)) as never;
  client.getBalance = (async (args: { address: string }) =>
    balances.get(args.address.toLowerCase()) ?? state.balance) as never;
  const nonces = new Map<string, number>();
  client.getTransactionCount = (async (args: { address: string }) =>
    nonces.get(args.address.toLowerCase()) ?? 0) as never;
  const budget = ownPaymasterBudget({
    db: ctx.db,
    chainId: ARC_TESTNET,
    deposit: async () => ({ wei: 10n ** 20n, block: 100n }),
    now: () => clock.at,
    limits: chainParams(ARC_TESTNET).budget,
    submitterBound: true,
  });
  const keys = {
    withSigner: async <T>(
      keyRef: string,
      use: (a: ReturnType<typeof privateKeyToAccount>) => Promise<T>,
    ) =>
      use(
        privateKeyToAccount(
          keyRef === 'v1:signer' ? signerKey : keyRef === 'v1:second' ? secondKey : submitterKey,
        ),
      ),
  };
  const make = () =>
    directBundler({
      db: ctx.db,
      client: ctx.chain.client,
      chainId: ARC_TESTNET,
      entryPoint: ENTRY_POINT,
      mode: 'on',
      paymaster: PAYMASTER,
      keystore: keys,
      signer: { keyRef: 'v1:signer', address: signer.address },
      submitter: { keyRef: 'v1:submitter', address: submitter.address },
      moreSubmitters: [{ keyRef: 'v1:second', address: second.address }],
      budget,
      policy: { addresses: ADDRESSES },
      now: () => clock.at,
      autoMaintain: false,
      log: (line: string) => void ctx.lines.push(line),
    });
  const selfPaid = async (bundler: ReturnType<typeof make>, nonce: number) =>
    bundler.send(
      signed(
        await bundler.prepare(await unsigned([register()], { nonce: BigInt(nonce) }), {
          sponsor: false,
        }),
      ),
    );
  const rows = async () =>
    (
      await ctx.db.query<{ submitter: string; nonce: string; hash: string }>(
        `SELECT submitter, nonce::text AS nonce, user_op_hash AS hash FROM own_paymaster_sends
         ORDER BY own_paymaster_sends.nonce, submitter`,
      )
    ).rows;
  return { ...ctx, clock, allowed, balances, nonces, make, selfPaid, rows, bundler: make() };
};
const from = async (raw: Hex) =>
  (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();

test('Arc lanes: fewest open first, each lane its own nonces, key and beneficiary', async (t) => {
  const { bundler, selfPaid, rows, chain } = await lanesOn(t);
  for (let i = 0; i < 4; i++) await selfPaid(bundler, i);
  const a = submitter.address.toLowerCase();
  const b = second.address.toLowerCase();
  assert.deepEqual(
    (await rows()).map((r) => [r.submitter, r.nonce]).sort(),
    [
      [a, '0'],
      [a, '1'],
      [b, '0'],
      [b, '1'],
    ].sort(),
  );
  for (const raw of chain.state.sent) {
    const signerOf = await from(raw);
    const data = parseTransaction(raw).data!;
    // handleOps(ops, beneficiary): the beneficiary word is the lane that signed.
    assert.equal(`0x${data.slice(10 + 64 + 24, 10 + 128)}`, signerOf);
  }
});

test('Arc lanes: a lane not allowed or not funded gets nothing', async (t) => {
  const { bundler, selfPaid, rows, allowed, balances, clock } = await lanesOn(t);
  const a = submitter.address.toLowerCase();
  const b = second.address.toLowerCase();
  allowed.set(b, false);
  await selfPaid(bundler, 0);
  await selfPaid(bundler, 1);
  assert.deepEqual(
    (await rows()).map((r) => r.submitter),
    [a, a],
  );
  // Allowed now but with only the reserve: still skipped once the cache has passed.
  clock.at += 31_000;
  allowed.set(b, true);
  balances.set(b, chainParams(ARC_TESTNET).submitterReserveWei);
  await selfPaid(bundler, 2);
  assert.deepEqual(
    (await rows()).map((r) => r.submitter),
    [a, a, a],
  );
  // Allowed and funded: it takes the next one, as the emptier lane.
  clock.at += 31_000;
  balances.delete(b);
  await selfPaid(bundler, 3);
  assert.ok((await rows()).some((r) => r.submitter === b));
});

test('Arc lanes: with no lane ready the send falls back to submitter 1', async (t) => {
  const { bundler, selfPaid, rows, allowed } = await lanesOn(t);
  allowed.set(submitter.address.toLowerCase(), false);
  allowed.set(second.address.toLowerCase(), false);
  await selfPaid(bundler, 0);
  assert.deepEqual(
    (await rows()).map((r) => r.submitter),
    [submitter.address.toLowerCase()],
  );
});

test("Arc lanes: follow-ups use the row's lane: its key, its nonce, its own head", async (t) => {
  const { bundler, selfPaid, rows, chain, clock, nonces } = await lanesOn(t);
  await selfPaid(bundler, 0);
  await selfPaid(bundler, 1);
  const b = second.address.toLowerCase();
  const row = (await rows()).find((r) => r.submitter === b)!;
  chain.state.simulate = 'revert';
  // The other lane's head moved on: it must not count for this row.
  nonces.set(submitter.address.toLowerCase(), 1);
  clock.at += 31_000;
  const before = chain.state.sent.length;
  await bundler.maintain(5);
  const cancels = chain.state.sent
    .slice(before)
    .filter((raw) => (parseTransaction(raw).data ?? '0x') === '0x');
  assert.equal(cancels.length, 1);
  assert.equal(await from(cancels[0]!), b, "the row's own key");
  assert.equal(parseTransaction(cancels[0]!).to!.toLowerCase(), b, 'a transfer to itself');
  assert.equal(String(parseTransaction(cancels[0]!).nonce ?? 0), row.nonce);
});

test('Arc lanes: past the cap a send is busy, nothing moves and nothing is signed', async (t) => {
  const { bundler, selfPaid, chain, rows, db } = await lanesOn(t);
  const cap = chainParams(ARC_TESTNET).lanePool!.capPerLane;
  for (let i = 0; i < 2 * cap; i++) await selfPaid(bundler, i);
  const sentBefore = chain.state.sent.length;
  const error = await selfPaid(bundler, 999).catch((e: unknown) => e);
  assert.ok(error instanceof BundlerError && bundlerRateLimited(error), 'retryable busy');
  assert.equal(chain.state.sent.length, sentBefore);
  assert.equal((await rows()).length, 2 * cap);
  const open = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM own_paymaster_reservations WHERE status = 'sent'`,
  );
  assert.equal(Number(open.rows[0]!.n), 2 * cap, 'one exposure per stored send, none for the busy');
});

test('Arc lanes: mined sends free their lane before their receipts are read', async (t) => {
  const { bundler, selfPaid, nonces, rows } = await lanesOn(t);
  const cap = chainParams(ARC_TESTNET).lanePool!.capPerLane;
  for (let i = 0; i < 2 * cap; i++) await selfPaid(bundler, i);
  nonces.set(submitter.address.toLowerCase(), 5);
  await selfPaid(bundler, 500);
  assert.equal((await rows()).length, 2 * cap + 1);
});

test('Arc lanes: with the lanes full no sponsorship is reserved or signed', async (t) => {
  const { bundler, selfPaid, chain, db } = await lanesOn(t);
  const cap = chainParams(ARC_TESTNET).lanePool!.capPerLane;
  for (let i = 0; i < 2 * cap; i++) await selfPaid(bundler, i);
  const signatures = chain.state.paymasterSignatures;
  const error = await bundler
    .prepare(await unsigned(), { intent: intentOf('registration') })
    .catch((e: unknown) => e);
  assert.ok(error instanceof SponsorError && error.rejection === 'busy');
  assert.ok(transientChainError(error), 'the register route answers it as busy');
  assert.equal(chain.state.paymasterSignatures, signatures);
  const held = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM own_paymaster_reservations WHERE status = 'reserved'`,
  );
  assert.equal(held.rows[0]!.n, '0');
});

test('Arc lanes: sponsorships just handed out hold their place', async (t) => {
  const { bundler, selfPaid } = await lanesOn(t);
  const cap = chainParams(ARC_TESTNET).lanePool!.capPerLane;
  for (let i = 0; i < 2 * cap - 1; i++) await selfPaid(bundler, i);
  // One place left: the first sponsorship takes it, the second hears busy.
  await bundler.prepare(await unsigned([register()], { nonce: 900n }), {
    intent: intentOf('registration'),
  });
  const error = await bundler
    .prepare(await unsigned([register()], { nonce: 901n }), { intent: intentOf('registration') })
    .catch((e: unknown) => e);
  assert.ok(error instanceof SponsorError && error.rejection === 'busy');
});

test('Arc lanes: two instances racing one operation store and sign it once', async (t) => {
  const { make, chain, rows, bundler: first } = await lanesOn(t);
  const other = make();
  const op = signed(await first.prepare(await unsigned(), { sponsor: false }));
  await Promise.allSettled([first.send(op), other.send(op)]);
  assert.equal((await rows()).length, 1);
  assert.equal(new Set(chain.state.sent).size, 1);
});

test('Arc lanes: a lane going unallowed: its op is cancelled by its key, no new work on it', async (t) => {
  const { bundler, selfPaid, chain, allowed, clock, rows } = await lanesOn(t);
  await selfPaid(bundler, 0);
  await selfPaid(bundler, 1);
  const b = second.address.toLowerCase();
  allowed.set(b, false);
  // The chain now refuses that origin only.
  const client = chain.client as unknown as { estimateGas: (a: never) => Promise<bigint> };
  const estimate = client.estimateGas;
  client.estimateGas = ((args: { account: unknown; to: string }) =>
    String(args.account).toLowerCase() === b && args.to.toLowerCase() === ENTRY_POINT.toLowerCase()
      ? Promise.reject(
          Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError' }),
        )
      : estimate(args as never)) as never;
  clock.at += 31_000;
  const before = chain.state.sent.length;
  await bundler.maintain(5);
  const cancels = chain.state.sent
    .slice(before)
    .filter((raw) => (parseTransaction(raw).data ?? '0x') === '0x');
  assert.equal(cancels.length, 1);
  assert.equal(await from(cancels[0]!), b);
  await selfPaid(bundler, 2);
  assert.equal((await rows()).filter((r) => r.submitter === b).length, 1, 'no new work on it');
});

test('Base: one lane, no cap, no lane reads: 30 open sends all go out', async (t) => {
  const { bundler, chain, db } = await setup(t);
  chain.state.balance = 10n ** 18n;
  const client = chain.client as unknown as { readContract: (a: never) => Promise<unknown> };
  const read = client.readContract;
  let laneReads = 0;
  client.readContract = ((args: { functionName: string }) => {
    if (args.functionName === 'isBundlerAllowed') laneReads++;
    return read(args as never);
  }) as never;
  for (let i = 0; i < 30; i++)
    await bundler.send(
      signed(
        await bundler.prepare(await unsigned([register()], { nonce: BigInt(i) }), {
          sponsor: false,
        }),
      ),
    );
  const stored = await db.query<{ submitter: string }>('SELECT submitter FROM own_paymaster_sends');
  assert.equal(stored.rows.length, 30);
  assert.deepEqual(
    [...new Set(stored.rows.map((r) => r.submitter))],
    [submitter.address.toLowerCase()],
  );
  assert.equal(laneReads, 0, 'a self-paid send reads no allowlist on Base');
});
