import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_WALLET_LIMITS_SQL,
} from '../server/base/schema.js';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork } from '../shared/base/chains.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { createKeystore, parseKeks, parseKeyRef } from '../server/base/chain/keystore.js';
import { localBundler } from '../server/base/chain/local-bundler.js';
import { createPaymentChain, PaymentChainError } from '../server/base/chain/payment-chain.js';
import {
  nonRenewing,
  ownerTypedData,
  permissionHash,
  walletSignature,
} from '../server/base/chain/permissions.js';
import { createWalletChainPort } from '../server/base/chain/port.js';
import { createReservationLedger } from '../server/base/chain/reservations.js';
import { pgChainOperationStore, pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { abandonBeforeBroadcast } from '../server/base/chain/submit.js';
import { startAtLowBaseFee } from './anvil-fees.js';

// End to end on PGlite + an Anvil fork of Base Sepolia (throwaway keys, fork-only test ETH):
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;

test(
  'agent transfer: one UserOp, reserved before signing, consumed when final, never paid twice',
  { skip: !ANVIL_URL },
  async (t) => {
    const network = baseNetwork(BASE_SEPOLIA)!;
    const chain = {
      id: BASE_SEPOLIA,
      name: 'anvil-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [ANVIL_URL!] } },
    } as const;
    const client = createPublicClient({ chain, transport: http(ANVIL_URL) });
    await startAtLowBaseFee(client);
    const setBalance = (address: string, eth: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther(eth).toString(16)}`] as never,
      });

    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    await pg.exec(BASE_WALLET_LIMITS_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };

    // Owner key (browser side in production), agent wallet [owner, SPM], spender from the keystore.
    const owner = privateKeyToAccount(generatePrivateKey());
    const recipe = agentWalletRecipe(network, owner.address, 1n);
    const agentWallet = deriveAddressLocal(recipe);
    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const port = createWalletChainPort({ keystore });
    const { spender, keyRef } = await port.createSpender(BASE_SEPOLIA);
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',84532,$1,$2,$3,$4,'{}','derived',0,0)`,
      [agentWallet, owner.address, spender, keyRef],
    );
    await pg.transaction((tx) => port.commitSpender(tx as never, keyRef));

    await setBalance(agentWallet, '1');
    await setBalance(spender, '1'); // no paymaster on the fork: the spender account prefunds its gas

    // The owner signs a weekly ETH limit for the spender, off-chain, before the wallet exists.
    const now = Number((await client.getBlock()).timestamp);
    const permission = nonRenewing({
      account: agentWallet,
      spender,
      token: NATIVE_ETH,
      allowance: parseEther('0.1'),
      start: now - 10,
      end: now + 7 * 86_400,
      salt: 1n,
      extraData: '0x',
    });
    const raw = await owner.signTypedData(
      ownerTypedData(BASE_SEPOLIA, agentWallet, await permissionHash(client, network, permission)),
    );
    const signature = walletSignature(raw, { ownerIndex: 0, undeployedRecipe: recipe });
    await pg.query(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature, state, created_at, updated_at)
     VALUES ('perm-1','w-1',84532,$1,$2,'signed',0,0)`,
      [
        JSON.stringify(permission, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        Buffer.from(signature.slice(2), 'hex'),
      ],
    );
    // A second, signed-but-unused limit for USDC: settling ETH payments must never mark it on-chain.
    const usdcPermission = { ...permission, token: network.tokens.USDC.address, salt: 2n };
    await pg.query(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature, state, created_at, updated_at)
     VALUES ('perm-usdc','w-1',84532,$1,$2,'signed',0,0)`,
      [
        JSON.stringify(usdcPermission, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        Buffer.from('00', 'hex'),
      ],
    );

    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const bundler = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    const paymentDeps = {
      network,
      client,
      db,
      operations: pgChainOperationStore(db),
      bundler,
      keystore,
      signerOf: async (ref: string) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
      ledger: createReservationLedger({
        chainId: BASE_SEPOLIA,
        balanceOf: async (address) => ({
          balance: await client.getBalance({ address }),
          blockNumber: await client.getBlockNumber({ cacheTime: 0 }),
        }),
      }),
    };
    const payments = createPaymentChain(paymentDeps);

    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const intent = (key: string, amount: string) => ({
      workspaceId: 'ws-1',
      chainId: BASE_SEPOLIA,
      source: { agentId: 'a-1' },
      to: recipient,
      token: NATIVE_ETH,
      amount,
      intentHash: keccak256(toHex(key)) as Hex,
      operationKey: `payment:${key}`,
    });

    // First payment: approve (deploys the wallet) + spend + transfer, one UserOp.
    const first = intent('one', parseEther('0.01').toString());
    const sent = await payments.submit(first);
    assert.equal(sent.status, 'submitted');
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.01'));
    assert.notEqual(
      await client.getCode({ address: agentWallet }),
      undefined,
      'deployed at first spend',
    );
    const held = await pg.query<{ state: string }>(
      "SELECT state FROM base_wallet_reservations WHERE holder_ref = 'payment:one'",
    );
    assert.equal(held.rows[0].state, 'held');

    // Retry before final: no second payment.
    await payments.submit(first);
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.01'));

    // Final after 3 blocks: reservation consumed, permission marked on-chain.
    for (let i = 0; i < 3; i++)
      await client.request({ method: 'evm_mine' as never, params: [] as never });
    assert.equal((await payments.status(first))?.status, 'final');
    assert.equal(
      (
        await pg.query<{ state: string }>(
          "SELECT state FROM base_wallet_reservations WHERE holder_ref = 'payment:one'",
        )
      ).rows[0].state,
      'consumed',
    );
    assert.equal(
      (
        await pg.query<{ state: string }>(
          "SELECT state FROM base_spend_permissions WHERE permission_id = 'perm-1'",
        )
      ).rows[0].state,
      'onchain',
    );

    // Retry after final: still one payment.
    await payments.submit(first);
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.01'));

    // Only the permission the chain reports as approved was marked; the USDC one is untouched.
    assert.equal(
      (
        await pg.query<{ state: string }>(
          "SELECT state FROM base_spend_permissions WHERE permission_id = 'perm-usdc'",
        )
      ).rows[0].state,
      'signed',
    );

    // Two payments at the same time with different keys: own nonce lanes, both land, no collision.
    const [p2, p3] = await Promise.all([
      payments.submit(intent('two', parseEther('0.02').toString())),
      payments.submit(intent('two-b', parseEther('0.005').toString())),
    ]);
    assert.notEqual(p2.status, 'unknown');
    assert.notEqual(p3.status, 'unknown');
    assert.equal(await client.getBalance({ address: recipient }), parseEther('0.035'));

    // Above the limit: refused before anything is reserved or signed.
    await assert.rejects(
      payments.submit(intent('three', parseEther('0.2').toString())),
      (e: unknown) => e instanceof PaymentChainError && e.code === 'OVER_ALLOWANCE',
    );
    // Another workspace cannot pay from this agent's wallet.
    await assert.rejects(
      payments.submit({ ...intent('four', '1'), workspaceId: 'ws-2' }),
      (e: unknown) => e instanceof PaymentChainError && e.code === 'WALLET_NOT_FOUND',
    );

    const reservationState = async (key: string) =>
      (
        await pg.query<{ state: string }>(
          'SELECT state FROM base_wallet_reservations WHERE holder_ref = $1',
          [`payment:${key}`],
        )
      ).rows[0]?.state;
    const paidBefore = await client.getBalance({ address: recipient });

    // Failure before anything is stored (here: the spender key cannot be found): the key is fenced
    // with a tombstone, the reservation released, nothing sent, and a retry sends nothing either.
    const broken = createPaymentChain({
      ...paymentDeps,
      signerOf: async () => {
        throw new Error('key store down');
      },
    });
    await assert.rejects(broken.submit(intent('five', '1000')), /key store down/);
    assert.equal(await reservationState('five'), 'released');
    assert.equal((await payments.submit(intent('five', '1000'))).status, 'failed');
    assert.equal(await client.getBalance({ address: recipient }), paidBefore);

    // Refused by the current-authority check right before the first broadcast: never sent,
    // the operation is failed with REFUSED_BEFORE_BROADCAST and the reservation released.
    const frozen = createPaymentChain({
      ...paymentDeps,
      authorize: async () => {
        throw new Error('run expired');
      },
    });
    const refused = await frozen.submit(intent('six', '1000'));
    assert.equal(refused.status, 'failed');
    assert.equal(refused.errorCode, 'REFUSED_BEFORE_BROADCAST');
    assert.equal(await reservationState('six'), 'released');
    assert.equal(await client.getBalance({ address: recipient }), paidBefore);

    // Process death, not thrown errors: each window is left exactly as a dead process leaves it,
    // then the recovery owner runs after the grace period.
    const later = () => Date.now() + 11 * 60 * 1000;
    const wallet = (await pg.query<{ wallet_id: string }>('SELECT wallet_id FROM base_wallets'))
      .rows[0].wallet_id;
    const reserveOnly = (key: string) =>
      db.transaction((tx) =>
        paymentDeps.ledger.reserve(tx, {
          walletId: wallet,
          chainId: BASE_SEPOLIA,
          token: NATIVE_ETH,
          amount: 1000n,
          holder: { kind: 'payment', ref: `payment:${key}` },
          intentHash: intent(key, '1000').intentHash,
        }),
      );

    // (a) Died after the reservation committed, before any operation or tombstone was stored.
    await reserveOnly('crash-a');
    // Inside the grace period nothing is touched (a live worker may still be signing).
    assert.equal((await payments.recover()).checked, 0);
    const a = await payments.recover({ now: later() });
    assert.ok(a.abandoned >= 1 && a.released >= 1);
    assert.equal(await reservationState('crash-a'), 'released');
    // A late retry of the same payment can only see the fenced outcome; it never sends.
    assert.equal((await payments.submit(intent('crash-a', '1000'))).status, 'failed');

    // (b) Died after the tombstone was written, before the release.
    await reserveOnly('crash-b');
    await abandonBeforeBroadcast(paymentDeps.operations, {
      idempotencyKey: 'payment:crash-b',
      intentHash: intent('crash-b', '1000').intentHash,
      chainId: BASE_SEPOLIA,
      kind: 'transfer',
    });
    assert.equal(await reservationState('crash-b'), 'held');
    // status() alone already releases it; recovery would too.
    assert.equal((await payments.status(intent('crash-b', '1000')))?.status, 'failed');
    assert.equal(await reservationState('crash-b'), 'released');

    // (c) Stored as queued, then the process stalls/dies inside the authority check. Recovery
    // expires it; when the stalled worker wakes up and passes the check, its claim finds no queued
    // row, so nothing is ever sent.
    let wake!: () => void;
    const stalled = createPaymentChain({
      ...paymentDeps,
      authorize: () => new Promise<void>((resolve) => (wake = resolve)),
    });
    const worker = stalled.submit(intent('crash-c', '1000'));
    while (!(await paymentDeps.operations.get('payment:crash-c')))
      await new Promise((r) => setTimeout(r, 10));
    assert.equal((await payments.status(intent('crash-c', '1000')))?.status, 'queued');
    const c = await payments.recover({ now: later() });
    assert.ok(c.expired >= 1);
    assert.equal(await reservationState('crash-c'), 'released');
    wake();
    const woke = await worker;
    assert.equal(woke.status, 'failed');
    assert.equal(woke.errorCode, 'EXPIRED_BEFORE_BROADCAST');
    assert.equal(await client.getBalance({ address: recipient }), paidBefore, 'nothing was sent');

    // Recovery also settles sent payments a dead process never came back for: 'two' is final.
    for (let i = 0; i < 3; i++)
      await client.request({ method: 'evm_mine' as never, params: [] as never });
    await payments.recover({ now: later() });
    assert.equal(await reservationState('two'), 'consumed');
    // Nothing is left held.
    const { rows: stillHeld } = await pg.query<{ holder_ref: string }>(
      "SELECT holder_ref FROM base_wallet_reservations WHERE state = 'held'",
    );
    assert.deepEqual(stillHeld, []);
  },
);

test('mainnet payments are refused without a fee budget', async () => {
  const mainnet = baseNetwork(8453, { CITY_BASE_MAINNET: '1' })!;
  const chain = createPaymentChain({ network: mainnet } as never);
  await assert.rejects(
    chain.submit({
      workspaceId: 'ws-1',
      chainId: 8453,
      source: { agentId: 'a' },
      to: '0x1111111111111111111111111111111111111111',
      token: NATIVE_ETH,
      amount: '1',
      intentHash: '0x01',
      operationKey: 'k',
    }),
    (e: unknown) => e instanceof PaymentChainError && e.code === 'FEE_BUDGET_REQUIRED',
  );
});
