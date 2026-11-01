import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  parseAbi,
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Database } from '../server/database.js';
import {
  OWN_PAYMASTER_KEYS_SQL,
  provisionedPaymasterKeys,
  provisionPaymasterKeysAtStart,
} from '../server/base/chain/own-paymaster-keys.js';
import {
  createDirectBundler,
  DIRECT_BUNDLER_FINALITY_SQL,
  DIRECT_BUNDLER_SQL,
  type DirectBundler,
} from '../server/base/chain/direct-bundler.js';
import {
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
} from '../server/base/chain/own-paymaster-budget.js';
import { paymasterHash, signPaymasterData } from '../server/base/chain/own-paymaster.js';
import { createKeystore, parseKeks } from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { SponsorError } from '../server/base/chain/rpc-bundler.js';
import { encodeAccountCalls } from '../server/base/chain/submit.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';

// CCA-749, app-side rehearsal of the "Signer rotation" runbook (docs/base/OWN_PAYMASTER_OPS.md):
// the real key records (own-paymaster-keys.ts), the real keystore and the real service
// (createDirectBundler -> readiness -> prepare), with throwaway keys made here, a synthetic KEK and
// a scripted paymaster contract. No network (every RPC the service makes is answered by the fake;
// anything else throws), no anvil, no transaction. The on-chain half is rehearsed on a fork
// (tests/own-paymaster-fork.test.ts); this one checks what OUR service does at each runbook step.

const net = BASE_NETWORKS[BASE_MAINNET];
const ENTRY_POINT = net.contracts.entryPointV06;
const PAYMASTER = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const MILLI = 10n ** 15n;
/** Synthetic, made per run: never a real setting value. */
const KEK = `v1:${randomBytes(32).toString('base64')}`;

const identityAbi = parseAbi(['function register(string tokenURI)']);
const register = {
  target: net.contracts.identityRegistry!,
  value: 0n,
  data: encodeFunctionData({
    abi: identityAbi,
    functionName: 'register',
    args: ['https://centralcity.ai/a/AbC123'],
  }),
};

/** A transport that refuses: any read the fake below does not answer would be a network call. */
const offline = () =>
  createPublicClient({
    transport: custom({
      request: async ({ method }: { method: string }) => {
        throw new Error(`no network in this test (${method})`);
      },
    }),
  });

async function database(t: { after: (fn: () => Promise<unknown>) => void }): Promise<Database> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE base_spender_keys (
    key_id text PRIMARY KEY, kek_version integer NOT NULL, wrapped_dek bytea NOT NULL,
    ciphertext bytea NOT NULL, signer_address text NOT NULL, committed_at bigint,
    created_at bigint NOT NULL)`);
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(OWN_PAYMASTER_ATTRIBUTION_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_CHAIN_SQL);
  await pg.exec(OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL);
  await pg.exec(DIRECT_BUNDLER_SQL);
  await pg.exec(DIRECT_BUNDLER_FINALITY_SQL);
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
}

/**
 * The paymaster as the owner drives it (Coinbase VerifyingPaymaster v1.0.0): verifyingSigner,
 * pendingVerifyingSigner, our submitter allowlisted, a funded deposit. `accepts` is the contract's
 * signature rule: a sponsorship validates when it recovers to the verifyingSigner OR to the pending
 * signer (the pending one is honoured as soon as it is set).
 */
function fakePaymaster() {
  const chain = { verifyingSigner: ZERO as Address, pending: ZERO as Address };
  const client = Object.assign(offline(), {
    estimateMaxPriorityFeePerGas: async () => 1_000_000n,
    getBlock: async () => ({ baseFeePerGas: 5_000_000n, number: 100n }),
    getBlockNumber: async () => 100n,
    // Only the account's inner calls are simulated in prepare.
    estimateGas: async () => 90_000n,
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === 'verifyingSigner') return chain.verifyingSigner;
      if (args.functionName === 'pendingVerifyingSigner') return chain.pending;
      if (args.functionName === 'isBundlerAllowed') return true;
      if (args.functionName === 'getL1Fee') return 1_000n;
      if (args.functionName === 'balanceOf') return 100n * MILLI;
      throw new Error(`unexpected read ${args.functionName}`);
    },
  });
  const signerOf = async (op: UserOperation<'0.6'>) => {
    const data = op.paymasterAndData!;
    const hash = paymasterHash(op, {
      chainId: BASE_MAINNET,
      paymaster: PAYMASTER,
      fields: {
        validUntil: Number(BigInt(`0x${data.slice(42, 54)}`)),
        validAfter: Number(BigInt(`0x${data.slice(54, 66)}`)),
        sponsorUUID: BigInt(`0x${data.slice(66, 98)}`),
      },
    });
    return recoverMessageAddress({ message: { raw: hash }, signature: `0x${data.slice(-130)}` });
  };
  const accepts = async (op: UserOperation<'0.6'>) => {
    const recovered = (await signerOf(op)).toLowerCase();
    return (
      recovered === chain.verifyingSigner.toLowerCase() ||
      (chain.pending !== ZERO && recovered === chain.pending.toLowerCase())
    );
  };
  return { chain, client: client as never, signerOf, accepts };
}

async function rehearsal(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await database(t);
  const keystore = createKeystore({ store: pgSpenderKeyStore(db), keks: parseKeks(KEK) });
  /** Every paymaster signature the service makes, by the address that signed. */
  const signatures: Address[] = [];
  const counting = {
    withSigner: <T>(
      keyRef: string,
      use: Parameters<typeof keystore.withSigner<T>>[1],
    ): Promise<T> =>
      keystore.withSigner(keyRef, (account) =>
        use({
          ...account,
          signMessage: (args: Parameters<typeof account.signMessage>[0]) => {
            signatures.push(account.address);
            return account.signMessage(args);
          },
        } as typeof account),
      ),
  };
  const paymaster = fakePaymaster();
  const lines: string[] = [];
  const base = {
    CITY_BASE_OWN_PAYMASTER: 'on',
    CITY_BASE_BUNDLER: 'direct',
    CITY_BASE_PAYMASTER_ADDRESS: PAYMASTER,
    CITY_BASE_SPENDER_KEK: KEK,
  };
  /** One deployment of the service with these settings (a redeploy builds a new one). */
  const deploy = (env: Record<string, string>) =>
    createDirectBundler({
      db,
      env,
      client: paymaster.client,
      chainId: BASE_MAINNET,
      network: net as never,
      keystore: counting,
      log: (line) => void lines.push(line),
    });
  let nonce = 0n;
  /** One registration sponsorship, each for its own sender (no per-account budget interplay). */
  const sponsor = async (service: DirectBundler) => {
    nonce += 1n;
    const sender = `0x${nonce.toString(16).padStart(40, '3')}` as Address;
    const op = {
      sender,
      nonce,
      initCode: '0x',
      callData: await encodeAccountCalls(offline() as never, [register]),
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      paymasterAndData: '0x',
      signature: '0x',
    } as UserOperation<'0.6'>;
    return service.prepare(op, {
      intent: { flow: 'registration', calls: [register], sender, initCode: '0x', accountId: null },
    });
  };
  const refusedFor = (state: string) => (error: unknown) =>
    error instanceof SponsorError && error.message.includes(`not sponsoring (${state})`);
  return { db, keystore, signatures, paymaster, lines, base, deploy, sponsor, refusedFor };
}

const ALERT = 'own paymaster: ALERT signer mismatch, sponsoring refused';

test('signer rotation, app side: the runbook order against the real service, keys and readiness', async (t) => {
  const r = await rehearsal(t);
  const { chain } = r.paymaster;

  // Provisioned at start (prepare/on): signer A and the submitters, recorded in own_paymaster_keys.
  assert.equal(await provisionPaymasterKeysAtStart({ db: r.db, env: r.base }), 'ready');
  const a = (await provisionedPaymasterKeys(r.db)).get('paymaster_signer')!;
  const envA = { ...r.base, CITY_BASE_PAYMASTER_SIGNER_KEY_REF: a.keyRef };
  chain.verifyingSigner = a.address as Address;

  // (1) Steady state: on chain A, no pending; the service on A sponsors, signed by A.
  const serviceA = await r.deploy(envA);
  assert.equal(await serviceA.readiness(), 'ready');
  const steady = await r.sponsor(serviceA);
  assert.equal(await r.paymaster.signerOf(steady), a.address);
  assert.ok(await r.paymaster.accepts(steady));
  assert.deepEqual(r.signatures, [a.address]);
  assert.deepEqual(r.lines, []);

  // Runbook step 1: the new key B is made in the keystore (a separate, reviewed step), not recorded.
  const b = await r.keystore.createSpenderKey();
  assert.notEqual(b.signer, a.address);

  // (2) The owner sets pending = B; the service still runs on A.
  chain.pending = b.signer;
  // A deployment checking now refuses, with the ALERT line, and signs nothing.
  const fresh = await r.deploy(envA);
  assert.equal(await fresh.readiness(), 'signer_mismatch');
  await assert.rejects(r.sponsor(fresh), r.refusedFor('signer_mismatch'));
  assert.deepEqual(r.signatures, [a.address], 'no signature while refusing');
  assert.ok(r.lines.length >= 1 && r.lines.every((line) => line === ALERT));
  // The instance that checked within the last 60 s still holds its cached 'ready' (documented): what
  // it signs is by A, which the contract still accepts (A is still the verifyingSigner).
  assert.equal(await serviceA.readiness(), 'ready');

  // (3) Runbook step 2: B recorded as paymaster_signer and the deployment switched to B's keyRef,
  // while on chain A is still the verifyingSigner and B is pending.
  await r.db.query(
    `UPDATE own_paymaster_keys SET key_ref = $1, address = $2 WHERE purpose = 'paymaster_signer'`,
    [b.keyRef, b.signer],
  );
  await pgSpenderKeyStore(r.db).commit(b.keyRef);
  // The old setting no longer matches the record: a deployment still on A is not built (CDP serves).
  assert.equal(
    await provisionPaymasterKeysAtStart({ db: r.db, env: envA, log: () => {} }),
    'settings_mismatch',
  );
  await assert.rejects(r.deploy(envA), /CITY_BASE_PAYMASTER_SIGNER_KEY_REF does not match/);
  const envB = { ...r.base, CITY_BASE_PAYMASTER_SIGNER_KEY_REF: b.keyRef };
  assert.equal(await provisionPaymasterKeysAtStart({ db: r.db, env: envB }), 'ready');
  const serviceB = await r.deploy(envB);
  // Designed behaviour: readiness needs verifyingSigner == the configured signer. A pending signer
  // equal to the configured one passes the pending check, but the service still refuses until the
  // rotation, although the contract would already accept a signature by B.
  const before = r.lines.length;
  assert.equal(await serviceB.readiness(), 'signer_mismatch');
  await assert.rejects(r.sponsor(serviceB), r.refusedFor('signer_mismatch'));
  assert.deepEqual(r.signatures, [a.address], 'nothing signed by B before the rotation');
  assert.ok(r.lines.length > before && r.lines.slice(before).every((line) => line === ALERT));

  // (4) Runbook step 3: the owner rotates. On chain B, no pending: the same deployment sponsors now
  // (it never cached a 'ready'), signed by B; A's signatures stop validating.
  chain.verifyingSigner = b.signer;
  chain.pending = ZERO;
  assert.equal(await serviceB.readiness(), 'ready');
  const rotated = await r.sponsor(serviceB);
  assert.equal(await r.paymaster.signerOf(rotated), b.signer);
  assert.ok(await r.paymaster.accepts(rotated));
  assert.equal(await r.paymaster.accepts(steady), false, "A's sponsorship no longer validates");
  assert.deepEqual(r.signatures, [a.address, b.signer]);
  // Runbook step 4 also allows pending left at the new address: still ready.
  chain.pending = b.signer;
  assert.equal(await (await r.deploy(envB)).readiness(), 'ready');
  chain.pending = ZERO;
  // A deployment still running on A (built before the switch) refuses once its cache is gone.
  assert.equal(await fresh.readiness(), 'signer_mismatch');
});

test('signer rotation, negative: the service on B while the chain is still on A (no pending) refuses', async (t) => {
  const r = await rehearsal(t);
  const { chain } = r.paymaster;
  assert.equal(await provisionPaymasterKeysAtStart({ db: r.db, env: r.base }), 'ready');
  const a = (await provisionedPaymasterKeys(r.db)).get('paymaster_signer')!;
  chain.verifyingSigner = a.address as Address;

  // (5) Switched to B (recorded and configured) but the owner never set B pending nor rotated.
  const b = await r.keystore.createSpenderKey();
  await r.db.query(
    `UPDATE own_paymaster_keys SET key_ref = $1, address = $2 WHERE purpose = 'paymaster_signer'`,
    [b.keyRef, b.signer],
  );
  const service = await r.deploy({ ...r.base, CITY_BASE_PAYMASTER_SIGNER_KEY_REF: b.keyRef });
  assert.equal(await service.readiness(), 'signer_mismatch');
  await assert.rejects(r.sponsor(service), r.refusedFor('signer_mismatch'));
  assert.deepEqual(r.signatures, [], 'no sponsorship signature at all');
  assert.ok(r.lines.length >= 1 && r.lines.every((line) => line === ALERT));
  // Had it signed (the production layout and signing, outside the service), the contract would
  // refuse it: B is neither the verifyingSigner nor pending.
  const draft = {
    sender: `0x${'44'.repeat(20)}` as Address,
    nonce: 1n,
    initCode: '0x',
    callData: '0x',
    callGasLimit: 1n,
    verificationGasLimit: 1n,
    preVerificationGas: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymasterAndData: '0x',
    signature: '0x',
  } as UserOperation<'0.6'>;
  const forged = {
    ...draft,
    paymasterAndData: await signPaymasterData(draft, {
      chainId: BASE_MAINNET,
      paymaster: PAYMASTER,
      fields: { validUntil: 2_000_000_000, validAfter: 0, sponsorUUID: 7n },
      sign: (hash: Hex) =>
        r.keystore.withSigner(b.keyRef, (account) =>
          account.signMessage({ message: { raw: hash } }),
        ),
    }),
  };
  assert.equal(await r.paymaster.signerOf(forged), b.signer);
  assert.equal(await r.paymaster.accepts(forged), false);
});
