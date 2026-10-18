import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import { BASE_SEPOLIA, baseNetwork, type BaseNetwork } from '../shared/base/chains.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { identityRegistryAbi } from '../server/base/chain/identity-chain.js';
import {
  createIdentityChainPort,
  IdentityPortError,
  registerIntentHash,
} from '../server/base/chain/identity-port.js';
import { createKeystore, parseKeks, parseKeyRef } from '../server/base/chain/keystore.js';
import { localBundler } from '../server/base/chain/local-bundler.js';
import { createWalletChainPort } from '../server/base/chain/port.js';
import { pgChainOperationStore, pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { createIdentityService, registerKey } from '../server/base/identity/service.js';
import { abandonBeforeBroadcast, fromJson } from '../server/base/chain/submit.js';
import { raiseBaseFee, startAtLowBaseFee } from './anvil-fees.js';

// The identity service driven through the chain port, against the real ERC-8004 registry on an
// Anvil fork of Base Sepolia (throwaway keys, fork-only test ETH):
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;

test(
  'identity service + chain port: advance() registers and hands over, retries never resend',
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
    const mine = async (n: number) => {
      for (let i = 0; i < n; i++)
        await client.request({ method: 'evm_mine' as never, params: [] as never });
    };

    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(baseShortIdsMigration.sql);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };

    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const walletPort = createWalletChainPort({ keystore });
    const { spender, keyRef } = await walletPort.createSpender(BASE_SEPOLIA);
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const agentWallet = deriveAddressLocal(agentWalletRecipe(network, owner, 7n));
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ('w-1','agent-1','ws-1',84532,$1,$2,$3,$4,'{}','derived',0,0)`,
      [agentWallet, owner, spender, keyRef],
    );
    await setBalance(spender, '1'); // no paymaster on the fork: the spender prefunds its own gas

    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const bundler = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    let sends = 0;
    const port = createIdentityChainPort({
      network,
      client,
      db,
      operations: pgChainOperationStore(db),
      bundler: { ...bundler, send: async (op) => (sends++, bundler.send(op)) },
      keystore,
      signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
    });
    const service = createIdentityService({ db, chain: port });

    // Step 1: register sent; the identity is submitted, no id yet.
    let v = await service.advance('agent-1', BASE_SEPOLIA);
    assert.equal(v.state, 'submitted');
    assert.equal(v.erc8004AgentId, null);
    assert.equal(sends, 1);
    // Calling again before finality only reconciles.
    v = await service.advance('agent-1', BASE_SEPOLIA);
    assert.equal(sends, 1);

    // Step 2: final registration → id read from the receipt → hand-over sent.
    await mine(3);
    v = await service.advance('agent-1', BASE_SEPOLIA);
    assert.ok(v.erc8004AgentId, 'id known');
    assert.equal(v.state, 'submitted');
    assert.equal(sends, 2);

    // Step 3: final hand-over → confirmed; the agent's undeployed wallet holds the identity.
    await mine(3);
    v = await service.advance('agent-1', BASE_SEPOLIA);
    assert.equal(v.state, 'confirmed');
    const holder = await client.readContract({
      address: network.contracts.identityRegistry!,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [BigInt(v.erc8004AgentId!)],
    });
    assert.equal(holder, agentWallet);
    assert.equal(await client.getCode({ address: agentWallet }), undefined);
    // Confirmed is terminal: nothing more is sent.
    await service.advance('agent-1', BASE_SEPOLIA);
    assert.equal(sends, 2);

    // The port never serves another network, and a changed request for a stored key is refused.
    await assert.rejects(
      port.register({
        operationKey: 'x',
        chainId: 8453,
        spenderKeyRef: keyRef,
        spender,
        uri: v.agentUri,
      }),
      (e: unknown) => e instanceof IdentityPortError && e.code === 'WRONG_NETWORK',
    );
    const stored = await port.register({
      operationKey: registerKey('agent-1', BASE_SEPOLIA),
      chainId: BASE_SEPOLIA,
      spenderKeyRef: keyRef,
      spender,
      uri: v.agentUri,
    });
    assert.equal(stored.status, 'final');
    assert.equal(sends, 2);
  },
);

test(
  'identity port: a frozen wallet is refused right before the first broadcast',
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
    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };
    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(
      BASE_SEPOLIA,
    );
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ('w-1','agent-1','ws-1',84532,$1,$1,$2,$3,'{}','frozen',0,0)`,
      [`0x${'4'.repeat(40)}`, spender, keyRef],
    );
    await client.request({
      method: 'anvil_setBalance' as never,
      params: [spender, `0x${parseEther('1').toString(16)}`] as never,
    });
    let sends = 0;
    const port = createIdentityChainPort({
      network,
      client,
      db,
      operations: pgChainOperationStore(db),
      bundler: {
        prepare: async (op) => op,
        send: async () => {
          sends++;
          throw new Error('must not send');
        },
        receipt: async () => null,
      },
      keystore,
      signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
    });
    const op = await port.register({
      operationKey: 'identity:register:frozen',
      chainId: BASE_SEPOLIA,
      spenderKeyRef: keyRef,
      spender,
      uri: 'https://centralcity.ai/a/frz001',
    });
    assert.equal(op.status, 'failed');
    assert.equal(sends, 0);
  },
);

test(
  'identity retry: a new attempt reuses the stuck attempt nonce, so only one can ever land',
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
    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };
    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(
      BASE_SEPOLIA,
    );
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ('w-1','agent-r','ws-1',84532,$1,$1,$2,$3,'{}','derived',0,0)`,
      [`0x${'6'.repeat(40)}`, spender, keyRef],
    );
    const setBalance = (address: string, eth: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther(eth).toString(16)}`] as never,
      });
    await setBalance(spender, '1');
    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const real = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    const operations = pgChainOperationStore(db);
    const portWith = (bundler: typeof real) =>
      createIdentityChainPort({
        network,
        client,
        db,
        operations,
        bundler,
        keystore,
        signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
      });
    const uri = `https://centralcity.ai/a/${randomBytes(3).toString('hex').slice(0, 6)}`;
    const base = { chainId: BASE_SEPOLIA, spenderKeyRef: keyRef, spender, uri } as const;

    // Attempt 1 is signed and stored, but every send is refused: it stays unknown.
    const refusing = portWith({
      ...real,
      send: async () => {
        throw new Error('precheck failed: maxFeePerGas too low');
      },
    });
    const first = await refusing.register({ ...base, operationKey: 'identity:register:84532:r' });
    assert.equal(first.status, 'unknown');

    // Network fees move before the retry (as live), so attempt 2 is a different operation.
    await raiseBaseFee(t, client, 5_000_000_000n);
    // Attempt 2 (new key) is signed on the same nonce lane: the same nonce as attempt 1. The
    // bundler keeps refusing attempt 1's own rebroadcast (as live: its fees stay too low).
    const stuckOp = fromJson((await operations.get('identity:register:84532:r'))!.signedOperation);
    const retry = await portWith({
      ...real,
      send: async (op) => {
        if (op.signature === stuckOp.signature) throw new Error('precheck failed: maxFeePerGas');
        return real.send(op);
      },
    }).register({
      ...base,
      operationKey: 'identity:register:84532:r:1',
    });
    assert.equal(retry.status, 'submitted');
    const stuck = (await operations.get('identity:register:84532:r'))!;
    const landed = (await operations.get('identity:register:84532:r:1'))!;
    assert.equal(landed.nonce, stuck.nonce, 'one nonce for both attempts');
    assert.equal(landed.sender, stuck.sender);
    assert.notEqual(landed.userOpHash, stuck.userOpHash, 'a different operation');

    // Now attempt 1 can never land: its nonce is consumed (reconcile says so, never "included").
    const again = await portWith(real).register({
      ...base,
      operationKey: 'identity:register:84532:r',
    });
    assert.notEqual(again.status, 'included');
    assert.notEqual(again.status, 'final');
    assert.equal((await operations.get('identity:register:84532:r'))?.errorCode, 'NONCE_CONSUMED');
  },
);

test(
  'identity retry: when the stuck attempt lands before the retry signs, nothing new is signed',
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
    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };
    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(
      BASE_SEPOLIA,
    );
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ('w-1','agent-l','ws-1',84532,$1,$1,$2,$3,'{}','derived',0,0)`,
      [`0x${'7'.repeat(40)}`, spender, keyRef],
    );
    const setBalance = (address: string, eth: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther(eth).toString(16)}`] as never,
      });
    await setBalance(spender, '1');
    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const real = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    let retrySends = 0;
    const operations = pgChainOperationStore(db);
    const portWith = (send: typeof real.send) =>
      createIdentityChainPort({
        network,
        client,
        db,
        operations,
        bundler: { ...real, send },
        keystore,
        signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
      });
    const uri = `https://centralcity.ai/a/${randomBytes(3).toString('hex').slice(0, 6)}`;
    const base = { chainId: BASE_SEPOLIA, spenderKeyRef: keyRef, spender, uri } as const;
    const firstKey = 'identity:register:84532:l';

    // Attempt 1 is stored but its send fails here...
    await portWith(async () => {
      throw new Error('timeout');
    }).register({ ...base, operationKey: firstKey });
    // ...and it lands anyway, before anyone retries (the bundler had it after all).
    const stored = (await operations.get(firstKey))!;
    await real.send(fromJson(stored.signedOperation));

    // The retry finds the first attempt's nonce used: it signs nothing and reports attempt 1.
    const outcome = await portWith(async (op) => (retrySends++, real.send(op))).register({
      ...base,
      operationKey: `${firstKey}:1`,
    });
    assert.equal(retrySends, 0, 'no new operation sent');
    assert.equal(await operations.get(`${firstKey}:1`), null, 'no new operation stored');
    assert.equal(outcome.idempotencyKey, firstKey);
    assert.ok(['included', 'final'].includes(outcome.status), outcome.status);
  },
);

test(
  'identity retry: an unsigned first attempt hands the nonce to the first signed one',
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
    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };
    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(
      BASE_SEPOLIA,
    );
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ('w-1','agent-u','ws-1',84532,$1,$1,$2,$3,'{}','derived',0,0)`,
      [`0x${'8'.repeat(40)}`, spender, keyRef],
    );
    const setBalance = (address: string, eth: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther(eth).toString(16)}`] as never,
      });
    await setBalance(spender, '1');
    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const real = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    let laterSends = 0;
    const operations = pgChainOperationStore(db);
    const portWith = (send: typeof real.send) =>
      createIdentityChainPort({
        network,
        client,
        db,
        operations,
        bundler: { ...real, send },
        keystore,
        signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
      });
    const uri = `https://centralcity.ai/a/${randomBytes(3).toString('hex').slice(0, 6)}`;
    const base = { chainId: BASE_SEPOLIA, spenderKeyRef: keyRef, spender, uri } as const;
    const firstKey = 'identity:register:84532:u';
    const intentHash = registerIntentHash(BASE_SEPOLIA, spender, uri);

    // Attempt 1 never signed (abandoned before broadcast); attempt 2 signs, its send "fails"...
    await abandonBeforeBroadcast(operations, {
      idempotencyKey: firstKey,
      intentHash,
      chainId: BASE_SEPOLIA,
      kind: 'register',
    });
    await portWith(async () => {
      throw new Error('timeout');
    }).register({ ...base, operationKey: `${firstKey}:1` });
    // ...and lands anyway.
    const second = (await operations.get(`${firstKey}:1`))!;
    await real.send(fromJson(second.signedOperation));

    // Attempt 3 pins attempt 2's nonce, finds it used, and reports attempt 2: no second mint.
    const outcome = await portWith(async (op) => (laterSends++, real.send(op))).register({
      ...base,
      operationKey: `${firstKey}:2`,
    });
    assert.equal(laterSends, 0, 'no new operation sent');
    assert.equal(await operations.get(`${firstKey}:2`), null, 'no new operation stored');
    assert.equal(outcome.idempotencyKey, `${firstKey}:1`);
    assert.ok(['included', 'final'].includes(outcome.status), outcome.status);

    // An earlier attempt bound to another intent refuses the replacement before anything is signed.
    const otherKey = 'identity:register:84532:x';
    await abandonBeforeBroadcast(operations, {
      idempotencyKey: otherKey,
      intentHash: `0x${'22'.repeat(32)}`,
      chainId: BASE_SEPOLIA,
      kind: 'register',
    });
    await assert.rejects(
      portWith(async (op) => (laterSends++, real.send(op))).register({
        ...base,
        operationKey: `${otherKey}:1`,
      }),
      (e: unknown) => e instanceof IdentityPortError && e.code === 'ATTEMPT_CONFLICT',
    );
    assert.equal(laterSends, 0);
    assert.equal(await operations.get(`${otherKey}:1`), null);
  },
);

test(
  'identity retry: an older attempt paused before storing loses to the retry fence and never sends',
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
    const pg = await PGlite.create('memory://');
    t.after(() => pg.close());
    await pg.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
    const db: Database = {
      query: (sql, params) => pg.query(sql, params) as never,
      exec: (sql) => pg.exec(sql),
      transaction: (action) => pg.transaction((tx) => action(tx as never)),
      close: () => pg.close(),
    };
    const keyStore = pgSpenderKeyStore(db);
    const keystore = createKeystore({
      store: keyStore,
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(
      BASE_SEPOLIA,
    );
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ('w-1','agent-p','ws-1',84532,$1,$1,$2,$3,'{}','derived',0,0)`,
      [`0x${'9'.repeat(40)}`, spender, keyRef],
    );
    const setBalance = (address: string, eth: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther(eth).toString(16)}`] as never,
      });
    await setBalance(spender, '1');
    const bundlerKey = privateKeyToAccount(generatePrivateKey());
    await setBalance(bundlerKey.address, '1');
    const real = localBundler({
      client,
      wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
      entryPoint: network.contracts.entryPointV06,
    });
    const operations = pgChainOperationStore(db);
    const portWith = (ops: typeof operations, onSend: () => void) =>
      createIdentityChainPort({
        network,
        client,
        db,
        operations: ops,
        bundler: { ...real, send: async (op) => (onSend(), real.send(op)) },
        keystore,
        signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
      });
    const uri = `https://centralcity.ai/a/${randomBytes(3).toString('hex').slice(0, 6)}`;
    const base = { chainId: BASE_SEPOLIA, spenderKeyRef: keyRef, spender, uri } as const;
    const firstKey = 'identity:register:84532:p';

    // The older worker signs attempt 1 and pauses right before storing it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    const pausing: typeof operations = {
      ...operations,
      insert: async (row) => {
        if (row.signedOperation !== '') {
          paused = true;
          await gate;
        }
        return operations.insert(row);
      },
    };
    let olderSends = 0;
    let retrySends = 0;
    const older = portWith(pausing, () => olderSends++).register({
      ...base,
      operationKey: firstKey,
    });
    while (!paused) await new Promise((r) => setTimeout(r, 10));

    // The retry finds no attempt 1 row: it fences the key, then signs and sends on a fresh nonce.
    const retry = await portWith(operations, () => retrySends++).register({
      ...base,
      operationKey: `${firstKey}:1`,
    });
    assert.equal(retry.status, 'submitted');
    assert.equal(retrySends, 1);

    // The older worker resumes: its insert loses to the tombstone, so it never sends.
    release();
    const outcome = await older;
    assert.equal(olderSends, 0, 'the paused older attempt is never broadcast');
    assert.equal(outcome.status, 'failed');
    assert.equal((await operations.get(firstKey))?.errorCode, 'ABANDONED_BEFORE_BROADCAST');
  },
);

/**
 * Blocks needed on top of an operation before it is final, in the fork tests built on forkSetup.
 * Far more than other users of the shared fork mine while one step of these tests runs (they mine
 * a few blocks at a time), so only the test's own `settle()` crosses it: blocks mined elsewhere
 * never turn an operation the test still expects included (or reverted) into a final one. Kept
 * small enough for one anvil_mine call to answer well within the client's request timeout.
 */
const SETTLE_DEPTH = 100;

/** A fresh database, spender and local bundler on the fork, for the retry and evidence tests. */
async function forkSetup(t: { after(fn: () => unknown): void }, agentId: string, fill: string) {
  const network: BaseNetwork = { ...baseNetwork(BASE_SEPOLIA)!, confirmations: SETTLE_DEPTH };
  const chain = {
    id: BASE_SEPOLIA,
    name: 'anvil-fork',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_URL!] } },
  } as const;
  const client = createPublicClient({ chain, transport: http(ANVIL_URL) });
  await startAtLowBaseFee(client);
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const keyStore = pgSpenderKeyStore(db);
  const keystore = createKeystore({
    store: keyStore,
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
  });
  const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(BASE_SEPOLIA);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1',$4,'ws-1',84532,$1,$1,$2,$3,'{}','derived',0,0)`,
    [`0x${fill.repeat(40)}`, spender, keyRef, agentId],
  );
  const setBalance = (address: string, eth: string) =>
    client.request({
      method: 'anvil_setBalance' as never,
      params: [address, `0x${parseEther(eth).toString(16)}`] as never,
    });
  await setBalance(spender, '1');
  const bundlerKey = privateKeyToAccount(generatePrivateKey());
  await setBalance(bundlerKey.address, '1');
  const real = localBundler({
    client,
    wallet: createWalletClient({ account: bundlerKey, chain, transport: http(ANVIL_URL) }),
    entryPoint: network.contracts.entryPointV06,
  });
  const operations = pgChainOperationStore(db);
  const portWith = (
    send: typeof real.send,
    reader: typeof client = client,
    on: BaseNetwork = network,
  ) =>
    createIdentityChainPort({
      network: on,
      client: reader,
      db,
      operations,
      bundler: { ...real, send },
      keystore,
      signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
    });
  const mine = async (blocks: number) => {
    for (let i = 0; i < blocks; i++)
      await client.request({ method: 'evm_mine' as never, params: [] as never });
  };
  /**
   * Mines SETTLE_DEPTH blocks in one call: everything included so far becomes final. Never
   * retried, since a retry after a slow answer would mine the blocks twice.
   */
  const settle = () =>
    client.request(
      { method: 'anvil_mine' as never, params: [`0x${SETTLE_DEPTH.toString(16)}`] as never },
      { retryCount: 0 },
    );
  /**
   * The network with a registry that reverts every call: a fresh address holding only REVERT, so a
   * registration really lands and reverts on-chain while the shared registry, which other users
   * of the fork call, is never modified.
   */
  const revertingNetwork = async (): Promise<BaseNetwork> => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    await client.request({
      method: 'anvil_setCode' as never,
      params: [address, '0x60006000fd'] as never, // PUSH1 0 PUSH1 0 REVERT
    });
    return { ...network, contracts: { ...network.contracts, identityRegistry: address } };
  };
  return {
    client,
    real,
    operations,
    portWith,
    mine,
    settle,
    revertingNetwork,
    registry: network.contracts.identityRegistry!,
    spender,
    base: { chainId: BASE_SEPOLIA, spenderKeyRef: keyRef, spender } as const,
    uri: () => `https://centralcity.ai/a/${randomBytes(3).toString('hex').slice(0, 6)}`,
  };
}

test(
  'identity retry: a reverted earlier attempt never pins; a consumed attempt reports the one that landed',
  { skip: !ANVIL_URL },
  async (t) => {
    const f = await forkSetup(t, 'agent-d', 'a');
    const { client, real, operations, mine, base, registry, spender } = f;
    const portWith = (send: typeof real.send) => f.portWith(send);

    // (1) Attempt 1 is really included and reverted on-chain (its nonce is used, nothing minted):
    // it is sent to a registry address that reverts every call. Later attempts use the real one.
    const mints = async (fromBlock: bigint) =>
      (
        await client.getContractEvents({
          address: registry,
          abi: identityRegistryAbi,
          eventName: 'Transfer',
          args: { from: zeroAddress, to: spender },
          fromBlock,
        })
      ).length;
    const startBlock = await client.getBlockNumber();
    const revKey = 'identity:register:84532:d';
    const revUri = f.uri();
    await f
      .portWith(real.send, client, await f.revertingNetwork())
      .register({ ...base, uri: revUri, operationKey: revKey });
    // Reconciling attempt 1 records its receipt: included, reverted.
    await portWith(real.send).register({ ...base, uri: revUri, operationKey: revKey });
    const reverted = (await operations.get(revKey))!;
    assert.equal(reverted.status, 'included');
    assert.equal(reverted.errorCode, 'USEROP_REVERTED', 'a real canonical revert');
    assert.notEqual(reverted.txHash, null);
    assert.equal(await mints(startBlock), 0, 'nothing minted');

    // Included but not final yet: the retry reports the reverted attempt and signs nothing.
    const early = await portWith(real.send).register({
      ...base,
      uri: revUri,
      operationKey: `${revKey}:1`,
    });
    assert.equal(early.idempotencyKey, revKey);
    assert.equal(await operations.get(`${revKey}:1`), null, 'nothing signed before finality');

    // Once the revert is final, the retry signs on the next nonce and mints exactly once.
    await f.settle();
    const fresh = await portWith(real.send).register({
      ...base,
      uri: revUri,
      operationKey: `${revKey}:1`,
    });
    assert.equal((await operations.get(revKey))!.status, 'failed');
    assert.equal(fresh.idempotencyKey, `${revKey}:1`);
    assert.equal(fresh.status, 'submitted');
    assert.equal(
      BigInt((await operations.get(`${revKey}:1`))!.nonce),
      BigInt(reverted.nonce) + 1n,
      'next nonce, not the reverted one',
    );
    await mine(3);
    assert.equal(await mints(startBlock), 1, 'exactly one mint');

    // (2) Attempt 1 is stuck, attempt 2 pins its nonce but its send is refused; then attempt 1
    // lands. Attempt 2 becomes NONCE_CONSUMED, and the step reports attempt 1, not a failure.
    const conKey = 'identity:register:84532:e';
    const conUri = f.uri();
    const refuse = async () => {
      throw new Error('precheck failed');
    };
    await portWith(refuse).register({ ...base, uri: conUri, operationKey: conKey });
    // Fees move before the retry (as live), so attempt 2 is a different operation.
    await raiseBaseFee(t, client, 7_000_000_000n);
    await portWith(refuse).register({ ...base, uri: conUri, operationKey: `${conKey}:1` });
    await real.send(fromJson((await operations.get(conKey))!.signedOperation));
    let outcome = await portWith(refuse).register({
      ...base,
      uri: conUri,
      operationKey: `${conKey}:1`,
    });
    for (let i = 0; i < 6 && outcome.idempotencyKey !== conKey; i++) {
      await mine(3);
      outcome = await portWith(refuse).register({
        ...base,
        uri: conUri,
        operationKey: `${conKey}:1`,
      });
    }
    assert.equal(outcome.idempotencyKey, conKey, 'the attempt that landed');
    assert.ok(['included', 'final'].includes(outcome.status), outcome.status);
  },
);

test(
  'mint evidence: a real registration is minted, included then final; a wrong uri or a replaced block is not',
  { skip: !ANVIL_URL },
  async (t) => {
    const f = await forkSetup(t, 'agent-m', 'b');
    let sends = 0;
    const port = f.portWith(async (op) => (sends++, f.real.send(op)));
    const uri = f.uri();
    const key = 'identity:register:84532:m';
    const ask = { operationKey: key, chainId: BASE_SEPOLIA, uri } as const;

    const sent = await port.register({ ...f.base, uri, operationKey: key });
    assert.equal(sent.status, 'submitted');
    assert.equal(sent.blockNumber, null);
    assert.equal(sent.finality, null);

    // Included, not settled yet.
    const included = await port.mintEvidence(ask);
    assert.equal(included.kind, 'minted');
    if (included.kind !== 'minted') return;
    assert.equal(included.opKey, key);
    assert.equal(included.status, 'included');
    assert.equal(included.finality, 'included');
    assert.equal(included.registry, f.registry);
    assert.equal(included.tokenUri, uri);
    assert.equal(included.owner, f.spender);
    assert.equal(included.txHash, (await f.operations.get(key))!.txHash);
    const block = await f.client.getBlock({ blockNumber: BigInt(included.blockNumber) });
    assert.equal(included.blockHash, block.hash);
    const holder = await f.client.readContract({
      address: f.registry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [BigInt(included.id)],
    });
    assert.equal(holder, f.spender);
    // The port's view of the same operation carries its block and finality.
    const op = await port.register({ ...f.base, uri, operationKey: key });
    assert.deepEqual(
      { status: op.status, blockNumber: op.blockNumber, finality: op.finality },
      { status: 'included', blockNumber: included.blockNumber, finality: 'included' },
    );

    // The same mint asked for another URI is not a mint of that URI.
    assert.deepEqual(await port.mintEvidence({ ...ask, uri: f.uri() }), {
      kind: 'pending',
      reason: 'URI_MISMATCH',
    });
    // A node that has another block at that height: the receipt's block is not canonical there.
    const replaced = new Proxy(f.client, {
      get(target, prop, receiver) {
        if (prop !== 'getBlock') return Reflect.get(target, prop, receiver);
        return async (args: Parameters<typeof target.getBlock>[0]) => {
          const actual = await target.getBlock(args);
          return args && 'blockNumber' in args && args.blockNumber !== undefined
            ? { ...actual, hash: `0x${'ee'.repeat(32)}` }
            : actual;
        };
      },
    });
    assert.deepEqual(await f.portWith(f.real.send, replaced).mintEvidence(ask), {
      kind: 'pending',
      reason: 'NOT_CANONICAL',
    });

    await f.settle();
    const final = await port.mintEvidence(ask);
    assert.equal(final.kind === 'minted' && final.status, 'final');
    assert.equal(final.kind === 'minted' && final.finality, 'final');
    assert.equal(final.kind === 'minted' && final.id, included.id);

    // Nothing stored under a key: none, and the key is not fenced.
    const absent = 'identity:register:84532:m-none';
    assert.deepEqual(await port.mintEvidence({ ...ask, operationKey: absent }), { kind: 'none' });
    assert.equal(await f.operations.get(absent), null);
    assert.equal(sends, 1, 'evidence never sends anything new');
  },
);

test(
  'mint evidence: an operation that never got out is pending; a real revert is reverted, then failed',
  { skip: !ANVIL_URL },
  async (t) => {
    const f = await forkSetup(t, 'agent-v', 'c');
    // Every send is refused: the stored operation stays unknown, so nothing is proven yet.
    const refusing = f.portWith(async () => {
      throw new Error('precheck failed');
    });
    const stuckKey = 'identity:register:84532:s';
    const stuckUri = f.uri();
    await refusing.register({ ...f.base, uri: stuckUri, operationKey: stuckKey });
    assert.deepEqual(
      await refusing.mintEvidence({ operationKey: stuckKey, chainId: BASE_SEPOLIA, uri: stuckUri }),
      { kind: 'pending' },
    );

    // A real on-chain revert: the registration is sent to a registry address that reverts every
    // call, and lands. The evidence is read through the port on the real network.
    const port = f.portWith(f.real.send);
    const revKey = 'identity:register:84532:v';
    const revUri = f.uri();
    const ask = { operationKey: revKey, chainId: BASE_SEPOLIA, uri: revUri } as const;
    await f
      .portWith(f.real.send, f.client, await f.revertingNetwork())
      .register({ ...f.base, uri: revUri, operationKey: revKey });
    assert.deepEqual(await port.mintEvidence(ask), { kind: 'reverted' });
    const reverted = (await f.operations.get(revKey))!;
    assert.equal(reverted.status, 'included');
    assert.equal(reverted.errorCode, 'USEROP_REVERTED', 'a real canonical revert');

    await f.settle();
    assert.deepEqual(await port.mintEvidence(ask), { kind: 'failed' });
    const op = await port.register({ ...f.base, uri: revUri, operationKey: revKey });
    assert.deepEqual(
      { status: op.status, blockNumber: op.blockNumber, finality: op.finality },
      { status: 'failed', blockNumber: reverted.blockNumber, finality: 'final' },
    );
    // Evidence never starts a replacement: no later attempt was fenced or signed.
    assert.equal(await f.operations.get(`${revKey}:1`), null);
    assert.equal(await f.operations.get(`${stuckKey}:1`), null);
  },
);

test(
  'identityAt: a freshly minted id is held by its minter at the finalized block',
  { skip: !ANVIL_URL },
  async (t) => {
    const f = await forkSetup(t, 'agent-i', 'e');
    const port = f.portWith(f.real.send);
    const key = 'identity:register:84532:i';
    const uri = f.uri();
    const step = { ...f.base, uri, operationKey: key };
    await port.register(step);
    // Past the fork's finalized lag, so the finalized block holds the mint; calling register
    // again only reconciles the stored operation.
    await f.settle();
    const op = await port.register(step);
    assert.equal(op.status, 'final');
    const id = await port.registeredId(op, BASE_SEPOLIA, uri);
    const at = await port.identityAt({ chainId: BASE_SEPOLIA, id, blockTag: 'finalized' });
    assert.equal(at.owner.toLowerCase(), f.spender.toLowerCase());
    assert.equal(at.tokenUri, uri);
    const minted = (await f.operations.get(key))!.blockNumber!;
    assert.ok(BigInt(at.blockNumber) >= BigInt(minted), 'read at or after the mint');
    const block = await f.client.getBlock({ blockNumber: BigInt(at.blockNumber) });
    assert.equal(at.blockHash, block.hash);
  },
);
