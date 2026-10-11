import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  createReceiveStore,
  RECEIVE_RECONCILE_SQL,
  RECEIVE_SQL,
  receiveReconcileMigration,
} from '../server/base/payments/receive-store.js';
import { createReceiveRuntime } from '../server/base/payments/receive-runtime.js';
import { readReceiveEvidence } from '../server/base/payments/receive-evidence.js';
import {
  createReceiveReconciler,
  RECEIVE_SEARCH_LOOKBACK_BLOCKS,
  type ReceiveReconcileClient,
} from '../server/base/payments/receive-reconcile.js';
import { registerBaseMigration } from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';

const events = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce)',
]);
const transferWithAuthorization = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
]);
const base = {
  workspaceId: 'one',
  resource: 'resource',
  chainId: 84532,
  token: `0x${'1'.repeat(40)}`,
  payer: `0x${'2'.repeat(40)}`,
  recipient: `0x${'3'.repeat(40)}`,
  amount: '10',
  validBefore: '2000',
};
type Binding = typeof base & { nonce: string };
const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const blockHash = (n: bigint) => word(Number(n) + 0xb0000);

interface ChainLog {
  eventName: 'AuthorizationUsed' | 'AuthorizationCanceled';
  nonce: string;
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

/** A trusted-RPC stand-in: only reads; nothing here signs or broadcasts. */
function fakeChain() {
  const chain = {
    head: 1000n,
    finalized: 900n,
    finalizedTimestamp: 1000n,
    used: new Set<string>(),
    logs: [] as ChainLog[],
    receipts: new Map<Hex, { receipt: TransactionReceipt; call: unknown }>(),
    fail: false,
    reads: 0,
    logReads: 0,
    /** A provider's per-call block range cap (null: none). */
    maxRange: null as bigint | null,
  };
  const guard = () => {
    chain.reads++;
    if (chain.fail) throw new Error('private RPC detail');
  };
  const client = {
    getChainId: async () => (guard(), 84532),
    getBlockNumber: async () => (guard(), chain.head),
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
      guard();
      if (args.blockTag === 'finalized')
        return {
          number: chain.finalized,
          timestamp: chain.finalizedTimestamp,
          hash: blockHash(chain.finalized),
        };
      return { number: args.blockNumber, hash: blockHash(args.blockNumber!) };
    },
    getLogs: async (args: {
      event: { name: string };
      args: { authorizer: string; nonce: string };
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      guard();
      chain.logReads++;
      assert.ok(args.toBlock - args.fromBlock < 10_000n, 'log pages stay bounded');
      if (chain.maxRange !== null && args.toBlock - args.fromBlock + 1n > chain.maxRange)
        throw new Error('block range too large');
      return chain.logs
        .filter(
          (log) =>
            log.eventName === args.event.name &&
            log.nonce === args.args.nonce.toLowerCase() &&
            args.args.authorizer.toLowerCase() === base.payer &&
            log.blockNumber >= args.fromBlock &&
            log.blockNumber <= args.toBlock,
        )
        .map((log) => ({ ...log, removed: false }));
    },
    readContract: async (args: { blockNumber: bigint; args: [string, string] }) => {
      guard();
      assert.equal(args.blockNumber, chain.finalized, 'nonce state is read at the finalized block');
      return chain.used.has(args.args[1].toLowerCase());
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      guard();
      const found = chain.receipts.get(hash);
      if (!found) throw new Error('not found');
      return found.receipt;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => (guard(), chain.receipts.get(hash)!.call),
  };
  /** A direct transferWithAuthorization to the token, included at `block`. */
  const include = (b: Binding, hash: Hex, block: bigint) => {
    chain.used.add(b.nonce);
    chain.logs.push({
      eventName: 'AuthorizationUsed',
      nonce: b.nonce,
      transactionHash: hash,
      blockNumber: block,
      blockHash: blockHash(block),
    });
    const common = {
      address: b.token,
      transactionHash: hash,
      blockHash: blockHash(block),
      blockNumber: block,
      removed: false,
    };
    const logs = [
      {
        ...common,
        topics: encodeEventTopics({
          abi: events,
          eventName: 'Transfer',
          args: { from: b.payer as Hex, to: b.recipient as Hex },
        }),
        data: encodeAbiParameters([{ type: 'uint256' }], [10n]),
      },
      {
        ...common,
        topics: encodeEventTopics({
          abi: events,
          eventName: 'AuthorizationUsed',
          args: { authorizer: b.payer as Hex, nonce: b.nonce as Hex },
        }),
        data: '0x',
      },
    ];
    chain.receipts.set(hash, {
      receipt: {
        to: b.token,
        transactionHash: hash,
        blockHash: blockHash(block),
        blockNumber: block,
        status: 'success',
        logs,
      } as unknown as TransactionReceipt,
      call: {
        hash,
        to: b.token,
        value: 0n,
        blockHash: blockHash(block),
        blockNumber: block,
        input: encodeFunctionData({
          abi: transferWithAuthorization,
          functionName: 'transferWithAuthorization',
          args: [b.payer as Hex, b.recipient as Hex, 10n, 0n, 2000n, b.nonce as Hex, '0x1234'],
        }),
      },
    });
  };
  return { chain, client, include };
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('one');",
  );
  await pg.exec(RECEIVE_SQL);
  await pg.exec(RECEIVE_RECONCILE_SQL);
  const db = {
    query: (sql: string, params: unknown[]) => pg.query(sql, params),
    transaction: (action: (tx: unknown) => unknown) => pg.transaction(action as never),
  } as unknown as Database;
  const store = createReceiveStore(db);
  const { chain, client, include } = fakeChain();
  let clock = 1_500_000; // ms; validBefore is 2000 s
  const reconciler = createReceiveReconciler({
    store,
    client: client as unknown as ReceiveReconcileClient,
    now: () => clock,
  });
  const delivered: string[] = [];
  let settlements = 0;
  const run = createReceiveRuntime({
    store,
    reconciler,
    evidence: (_chainId, transaction) =>
      readReceiveEvidence(
        client as unknown as Parameters<typeof readReceiveEvidence>[0],
        transaction,
      ),
    deliver: async (claim) => {
      delivered.push(claim.receiptId);
      return 'resource';
    },
  });
  const settleThrows = async () => {
    settlements++;
    throw new Error('private provider detail');
  };
  /** A claim whose settle threw after it was marked 'reconciling': no transaction is recorded. */
  const strand = async (b: Binding) => {
    assert.equal((await run(b, settleThrows)).kind, 'pending');
    const row = await store.load('one', (await store.find(b))!.receiptId);
    assert.equal(row!.state, 'reconciling');
    assert.equal(row!.transaction, null);
    assert.equal(row!.searchFromBlock, chain.head - RECEIVE_SEARCH_LOOKBACK_BLOCKS);
    assert.equal(row!.validBefore, '2000');
    return row!.receiptId;
  };
  const rowOf = async (receiptId: string) =>
    (
      await pg.query<{ state: string; transaction_hash: string | null }>(
        'SELECT * FROM base_x402_receipts WHERE receipt_id=$1',
        [receiptId],
      )
    ).rows[0];
  return {
    store,
    client,
    chain,
    include,
    reconciler,
    run,
    delivered,
    strand,
    rowOf,
    settlements: () => settlements,
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

const nonce = (n: number) => word(0xa000 + n);
const after = { finalizedTimestamp: 2000n, clock: 2_001_000 };

test('expired unused authorization stays pending when finalized block hash changes', async (t) => {
  const s = await setup(t);
  const receiptId = await s.strand({ ...base, nonce: nonce(99) });
  const client = {
    ...s.client,
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) =>
      args.blockTag === 'finalized'
        ? { number: 900n, timestamp: 2000n, hash: word(1) }
        : { number: args.blockNumber, timestamp: 1999n, hash: word(2) },
  };
  const reconcile = createReceiveReconciler({
    store: s.store,
    client: client as unknown as ReceiveReconcileClient,
    now: () => after.clock,
  });
  assert.equal((await reconcile.reconcile('one', receiptId)).kind, 'pending');
  assert.equal((await s.rowOf(receiptId)).state, 'reconciling');
});

test('migration 86 is registered after 85 and only adds reconcile columns', () => {
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.equal(versions.indexOf(86), versions.indexOf(85) + 1);
  assert.equal(receiveReconcileMigration.name, 'base_x402_receive_reconcile');
  assert.doesNotMatch(RECEIVE_RECONCILE_SQL, /DROP (TABLE|COLUMN)|DELETE|TRUNCATE/i);
});

test('(a) settle threw after reconciling; a final direct call on chain is recorded and delivered once', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(1) };
  const receiptId = await s.strand(b);
  const hash = word(0xc1);
  s.include(b, hash, 1005n);
  s.chain.head = 1020n;
  s.chain.finalized = 1010n;
  const recovered = await s.run(b, async () => assert.fail('never settles again'), true);
  assert.equal(recovered.kind, 'paid');
  assert.equal(recovered.kind === 'paid' && recovered.transaction, hash);
  assert.equal((await s.rowOf(receiptId)).transaction_hash, hash);
  assert.equal((await s.rowOf(receiptId)).state, 'paid');
  assert.deepEqual(s.delivered, [receiptId]);
  assert.equal(s.settlements(), 1);
  const reads = s.chain.logReads;
  assert.equal((await s.run(b, async () => assert.fail('never settles'), true)).kind, 'paid');
  assert.equal(s.chain.logReads, reads, 'a recorded transaction is never searched again');
  assert.deepEqual(new Set(s.delivered), new Set([receiptId]), 'one receipt, idempotent delivery');
});

test('a provider that caps the log block range still finds the settlement (smaller pages)', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(9) };
  const receiptId = await s.strand(b);
  const hash = word(0xc9);
  s.include(b, hash, 1005n);
  s.chain.head = 1020n;
  s.chain.finalized = 1010n;
  s.chain.maxRange = 1000n;
  const recovered = await s.run(b, async () => assert.fail('never settles again'), true);
  assert.equal(recovered.kind, 'paid');
  assert.equal((await s.rowOf(receiptId)).transaction_hash, hash);
  // Below the minimum page size every call fails: nothing is concluded or written.
  const c = { ...base, nonce: nonce(10) };
  const stuck = await s.strand(c);
  s.include(c, word(0xca), 1006n);
  s.chain.maxRange = 100n;
  assert.equal(
    (await s.run(c, async () => assert.fail('never settles again'), true)).kind,
    'pending',
  );
  assert.equal((await s.rowOf(stuck)).transaction_hash, null);
});

test('(b) event found but not finalized: pending, no delivery, nothing pinned', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(2) };
  const receiptId = await s.strand(b);
  s.include(b, word(0xc2), 1015n);
  s.chain.head = 1020n;
  s.chain.finalized = 1010n;
  assert.equal((await s.run(b, async () => assert.fail('never settles'), true)).kind, 'pending');
  assert.equal((await s.rowOf(receiptId)).transaction_hash, null);
  assert.equal((await s.rowOf(receiptId)).state, 'reconciling');
  assert.deepEqual(s.delivered, []);
  // Router/batch inclusion: the event is final but the direct-call proof fails, so never paid.
  const routed = { ...base, nonce: nonce(12) };
  const routedId = await s.strand(routed);
  s.include(routed, word(0xd2), 1005n);
  const { call } = (s.chain.receipts.get(word(0xd2)) as { call: { to: string } })!;
  call.to = `0x${'9'.repeat(40)}`;
  assert.equal((await s.run(routed, async () => assert.fail(), true)).kind, 'pending');
  assert.equal((await s.rowOf(routedId)).transaction_hash, word(0xd2));
  assert.equal((await s.rowOf(routedId)).state, 'reconciling');
  assert.deepEqual(s.delivered, []);
});

test('(c) no event before validBefore: pending', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(3) };
  const receiptId = await s.strand(b);
  s.chain.finalizedTimestamp = 1999n;
  s.setClock(after.clock); // the wall clock alone is not enough: the final chain must agree
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'pending');
  s.chain.finalizedTimestamp = after.finalizedTimestamp;
  s.setClock(1_999_000);
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'pending');
  assert.equal((await s.rowOf(receiptId)).state, 'reconciling');
});

test('(d) no event, past validBefore, nonce unused at finalized: failed, and a fresh nonce works', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(4) };
  const receiptId = await s.strand(b);
  s.chain.finalizedTimestamp = after.finalizedTimestamp;
  s.setClock(after.clock);
  assert.deepEqual(await s.run(b, async () => assert.fail(), true), {
    kind: 'failed',
    receiptId,
  });
  const row = await s.rowOf(receiptId);
  assert.equal(row.state, 'failed');
  assert.equal(row.transaction_hash, null);
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'failed', 'stays failed');
  assert.equal(await s.store.reconcile('one', receiptId, word(0xc4)), false, 'failed never pins');
  const fresh = { ...b, nonce: nonce(40) };
  s.setClock(1_500_000);
  const hash = word(0xe4);
  const result = await s.run(fresh, async () => {
    s.include(fresh, hash, 1005n);
    return { kind: 'settled', transaction: hash };
  });
  assert.equal(result.kind, 'pending', 'not final yet');
  s.chain.finalized = 1010n;
  const paid = await s.run(fresh, async () => assert.fail(), true);
  assert.equal(paid.kind, 'paid');
  assert.notEqual(paid.receiptId, receiptId);
  assert.deepEqual(s.delivered, [paid.receiptId]);
});

test('(d2) a crash right after insert ("claimed", no start block known) never fails', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(5) };
  const claimed = await s.store.claim(b, { validBefore: '2000', searchFromBlock: null });
  s.chain.finalizedTimestamp = after.finalizedTimestamp;
  s.setClock(after.clock);
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'pending');
  assert.equal((await s.rowOf(claimed.receiptId)).state, 'claimed');
  // With a start block, the same 'claimed' row does fail once the chain proves it unusable.
  const known = { ...base, nonce: nonce(50) };
  const c = await s.store.claim(known, { validBefore: '2000', searchFromBlock: 400n });
  assert.equal((await s.run(known, async () => assert.fail(), true)).kind, 'failed');
  assert.equal((await s.rowOf(c.receiptId)).state, 'failed');
  // A final cancellation consumes the nonce even before validBefore.
  const canceled = { ...base, nonce: nonce(51) };
  const k = await s.store.claim(canceled, { validBefore: '9999', searchFromBlock: 400n });
  s.chain.used.add(canceled.nonce);
  s.chain.logs.push({
    eventName: 'AuthorizationCanceled',
    nonce: canceled.nonce,
    transactionHash: word(0xf5),
    blockNumber: 800n,
    blockHash: blockHash(800n),
  });
  assert.equal((await s.run(canceled, async () => assert.fail(), true)).kind, 'failed');
  assert.equal((await s.rowOf(k.receiptId)).state, 'failed');
});

test('(e) past validBefore but the nonce is used (event outside the window): never failed', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(6) };
  const receiptId = await s.strand(b);
  s.chain.used.add(b.nonce); // used at a block the search does not cover
  s.chain.finalizedTimestamp = after.finalizedTimestamp;
  s.setClock(after.clock);
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'pending');
  assert.equal((await s.rowOf(receiptId)).state, 'reconciling');
  assert.deepEqual(await s.reconciler.reconcile('one', receiptId), { kind: 'pending' });
});

test('(f) an RPC error leaves the claim exactly as it was', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(7) };
  const receiptId = await s.strand(b);
  s.include(b, word(0xc7), 905n);
  s.chain.finalized = 1010n;
  s.chain.finalizedTimestamp = after.finalizedTimestamp;
  s.setClock(after.clock);
  const before = await s.rowOf(receiptId);
  s.chain.fail = true;
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'pending');
  assert.deepEqual(await s.reconciler.reconcile('one', receiptId), { kind: 'pending' });
  assert.deepEqual(await s.rowOf(receiptId), before);
  assert.equal(await s.reconciler.startBlock(), null, 'unknown head: never conclude absence');
  s.chain.fail = false;
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'paid');
});

test('(g) a claim that already has a transaction is untouched by the reconciler', async (t) => {
  const s = await setup(t);
  const b = { ...base, nonce: nonce(8) };
  const hash = word(0xc8);
  const pending = await s.run(b, async () => ({ kind: 'settled', transaction: hash }));
  assert.equal(pending.kind, 'pending', 'no receipt on chain yet');
  const before = await s.rowOf(pending.receiptId);
  const reads = s.chain.reads;
  s.chain.finalizedTimestamp = after.finalizedTimestamp;
  s.setClock(after.clock);
  assert.deepEqual(await s.reconciler.reconcile('one', pending.receiptId), { kind: 'untouched' });
  assert.equal(s.chain.reads, reads, 'no chain reads for a recorded transaction');
  assert.equal((await s.run(b, async () => assert.fail(), true)).kind, 'pending');
  assert.equal(s.chain.logReads, 0);
  assert.deepEqual(await s.rowOf(pending.receiptId), before);
  assert.deepEqual(await s.reconciler.reconcile('two', pending.receiptId), { kind: 'untouched' });
  assert.deepEqual(await s.reconciler.reconcile('one', 'missing'), { kind: 'untouched' });
});
