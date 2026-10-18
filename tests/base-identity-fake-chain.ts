/*
 * A scripted identity chain port for the provisional Base ID tests. Operations are stored per key;
 * register() and transfer() "sign" only for a key not yet stored, and every key is signed at most
 * once and only ever with one id. mintEvidence() and identityAt() never sign. Tests move operations
 * along with include / safe / finalize / lose / fail, the way the chain module reports them.
 */
import assert from 'node:assert/strict';
import type {
  Finality,
  IdentityChainPort,
  IdentityOp,
  IdentitySnapshot,
  MintObservation,
} from '../server/base/identity/service.js';

export interface FakeMint {
  tx: string;
  block: number;
  id: bigint;
  /** Defaults to a hash derived from the block and the tx. */
  blockHash?: string;
  /** Defaults to the spender. */
  owner?: string;
  /** Defaults to the URI the service asks about. */
  uri?: string;
  /** Defaults to the network's registry. */
  registry?: string;
  /** The key the evidence reports (defaults to the operation's own key). */
  opKey?: string;
}

/** Where an operation landed. */
export interface FakeLanding {
  tx: string;
  block: number;
  blockHash?: string;
  /** Included but its execution reverted (USEROP_REVERTED). */
  reverted?: boolean;
}

/** The default block hash of a landing (a different tx or block is a different hash). */
export const hashOf = (block: number, tx: string) => `0xblk${block}${tx.slice(2)}`;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const attemptKeys = (key: string): string[] => {
  const parts = key.split(':');
  const family = parts.slice(0, 4).join(':');
  const attempt = parts.length === 5 ? Number(parts[4]) : 0;
  return Array.from({ length: attempt + 1 }, (_, i) => {
    const n = attempt - i;
    return n === 0 ? family : `${family}:${n}`;
  });
};

export class FakeIdentityChain implements IdentityChainPort {
  readonly ops = new Map<string, IdentityOp>();
  readonly mints = new Map<
    string,
    FakeMint & { status: 'included' | 'final'; finality: Finality }
  >();
  readonly evidenceState = new Map<string, 'pending' | 'reverted' | 'failed'>();
  readonly signs = new Map<string, number>();
  readonly intents = new Map<string, bigint>();
  readonly destinations = new Map<string, string>();
  readonly calls = {
    register: [] as string[],
    transfer: [] as string[],
    evidence: [] as string[],
    identityAt: [] as Array<{ id: bigint; blockTag: string }>,
  };
  /** Every register() input, exactly as the service passed it. */
  readonly registerInputs: Array<Record<string, unknown>> = [];
  /** register(key) reports another attempt of its step (one that landed on the pinned nonce). */
  readonly reportAs = new Map<string, string>();
  /** Consumed first, one per mintEvidence call. */
  readonly evidenceQueue: Array<() => Promise<MintObservation> | MintObservation> = [];
  /** Consumed first, one per identityAt call. */
  readonly identityAtQueue: Array<() => Promise<IdentitySnapshot> | IdentitySnapshot> = [];
  /** Overrides what identityAt reports for an id at the finalized block. */
  readonly finalizedView = new Map<bigint, Partial<IdentitySnapshot>>();
  /** Awaited before a transfer call answers (one per call, consumed first). */
  readonly transferHolds: Array<Promise<void>> = [];
  /** Thrown once by the next register() call, before anything is stored or signed. */
  registerError: Error | null = null;
  /** Run once by the next register() call before anything else (another call can land meanwhile). */
  beforeRegister: (() => Promise<void>) | null = null;
  transferError: (Error & { code?: string }) | null = null;
  evidenceError: Error | null = null;
  identityAtError: Error | null = null;
  /** The port offers identityAt (D4); false models a port that does not have it yet. */
  withIdentityAt = true;
  /** The agent URI last asked about (register or evidence); identityAt reports it by default. */
  uri: string | null = null;

  constructor(private readonly defaults: { spender: string; registry: string }) {
    // A port without identityAt (D4 not shipped yet) is modelled by hiding the method.
    const at = this.identityAtImpl.bind(this);
    Object.defineProperty(this, 'identityAt', {
      get: () => (this.withIdentityAt ? at : undefined),
    });
  }

  declare identityAt?: IdentityChainPort['identityAt'];

  private sign(key: string) {
    const n = (this.signs.get(key) ?? 0) + 1;
    this.signs.set(key, n);
    assert.ok(n <= 1, `key ${key} signed twice`);
  }

  async register(input: Parameters<IdentityChainPort['register']>[0]): Promise<IdentityOp> {
    const key = input.operationKey;
    this.calls.register.push(key);
    this.registerInputs.push({ ...input });
    const before = this.beforeRegister;
    this.beforeRegister = null;
    if (before) await before();
    if (this.registerError) {
      const error = this.registerError;
      this.registerError = null;
      throw error;
    }
    this.uri = input.uri;
    const sibling = this.reportAs.get(key);
    if (sibling && this.ops.has(sibling)) return { ...this.ops.get(sibling)! };
    if (!this.ops.has(key)) {
      this.sign(key);
      this.ops.set(key, { idempotencyKey: key, status: 'submitted', txHash: null });
    }
    return { ...this.ops.get(key)! };
  }

  async registeredId(): Promise<bigint> {
    throw new Error('The fast path never reads ids through registeredId.');
  }

  async transfer(input: Parameters<IdentityChainPort['transfer']>[0]): Promise<IdentityOp> {
    const key = input.operationKey;
    this.calls.transfer.push(key);
    if (this.transferError) throw this.transferError;
    if (!this.ops.has(key)) {
      this.sign(key);
      this.intents.set(key, input.id);
      this.destinations.set(key, input.to);
      this.ops.set(key, { idempotencyKey: key, status: 'submitted', txHash: null });
    }
    assert.equal(this.intents.get(key), input.id, `key ${key} is only ever sent with one id`);
    const hold = this.transferHolds.shift();
    if (hold) await hold;
    return { ...this.ops.get(key)! };
  }

  /** Look-back: the newest attempt of the step at or before `operationKey` that minted. */
  async mintEvidence(input: {
    operationKey: string;
    chainId: number;
    uri: string;
  }): Promise<MintObservation> {
    const key = input.operationKey;
    this.calls.evidence.push(key);
    this.uri = input.uri;
    const scripted = this.evidenceQueue.shift();
    if (scripted) return scripted();
    if (this.evidenceError) throw this.evidenceError;
    for (const candidate of attemptKeys(key)) {
      const mint = this.mints.get(candidate);
      if (mint)
        return {
          kind: 'minted',
          opKey: mint.opKey ?? candidate,
          status: mint.status,
          finality: mint.finality,
          txHash: mint.tx,
          blockNumber: String(mint.block),
          blockHash: mint.blockHash ?? hashOf(mint.block, mint.tx),
          id: mint.id.toString(10),
          registry: mint.registry ?? this.defaults.registry,
          tokenUri: mint.uri ?? input.uri,
          owner: mint.owner ?? this.defaults.spender,
        };
    }
    const state = this.evidenceState.get(key);
    if (state) return { kind: state };
    return attemptKeys(key).some((k) => this.ops.has(k)) ? { kind: 'pending' } : { kind: 'none' };
  }

  /**
   * Default: the id is held by the destination of a final, executed hand-over of it (else by the
   * spender), with the last URI asked about, at the highest final block.
   */
  private async identityAtImpl(input: {
    chainId: number;
    id: bigint;
    blockTag: 'finalized';
  }): Promise<IdentitySnapshot> {
    this.calls.identityAt.push({ id: input.id, blockTag: input.blockTag });
    const scripted = this.identityAtQueue.shift();
    if (scripted) return scripted();
    if (this.identityAtError) throw this.identityAtError;
    let owner = this.defaults.spender;
    for (const [key, id] of this.intents) {
      const op = this.ops.get(key);
      if (id === input.id && op?.status === 'final' && !op.reverted)
        owner = this.destinations.get(key)!;
    }
    const block = Math.max(
      0,
      ...[...this.ops.values()]
        .filter((op) => op.status === 'final' || op.status === 'failed')
        .map((op) => Number(op.blockNumber ?? 0)),
    );
    return {
      owner,
      tokenUri: this.uri ?? '',
      blockNumber: String(block),
      blockHash: `0xfin${block}`,
      ...this.finalizedView.get(input.id),
    };
  }

  /** The operation is in a block (a register operation also minted `mint.id`). */
  include(key: string, landing: FakeMint | FakeLanding, finality: Finality = 'included') {
    const blockHash = landing.blockHash ?? hashOf(landing.block, landing.tx);
    this.ops.set(key, {
      idempotencyKey: key,
      status: 'included',
      txHash: landing.tx,
      blockNumber: String(landing.block),
      blockHash,
      finality,
      ...('reverted' in landing && landing.reverted ? { reverted: true } : {}),
    });
    if ('id' in landing) {
      this.mints.set(key, { ...landing, blockHash, status: 'included', finality });
      this.evidenceState.delete(key);
    }
  }

  /** The included operation's depth changes (e.g. 'safe', or back to 'included'). */
  depth(key: string, finality: 'included' | 'safe') {
    const op = this.ops.get(key);
    assert.equal(op?.status, 'included', `depth ${key}: not included`);
    this.ops.set(key, { ...op, finality });
    const mint = this.mints.get(key);
    if (mint) this.mints.set(key, { ...mint, finality });
  }

  /** The operation's block is final (owner override: a promotion needs no new owner read). */
  finalize(key: string, patch: Partial<FakeMint> = {}) {
    const op = this.ops.get(key);
    assert.ok(op?.txHash, `finalize ${key}: not included`);
    this.ops.set(key, { ...op, status: 'final', finality: 'final' });
    const mint = this.mints.get(key);
    if (mint) this.mints.set(key, { ...mint, ...patch, status: 'final', finality: 'final' });
  }

  /** The receipt is gone (reorg): the stored operation is reconciling, the port rebroadcasts it. */
  lose(key: string) {
    this.ops.set(key, { idempotencyKey: key, status: 'reconciling', txHash: null });
    if (this.mints.delete(key)) this.evidenceState.set(key, 'pending');
  }

  /**
   * Final failure. With `block` it executed there and reverted (unless `reverted: false`); without
   * it, it never executed (e.g. its nonce was consumed by another operation).
   */
  fail(
    key: string,
    block?: number,
    options: { blockHash?: string | null; reverted?: boolean } = {},
  ) {
    const op = this.ops.get(key);
    const tx = op?.txHash ?? null;
    this.ops.set(key, {
      idempotencyKey: key,
      status: 'failed',
      txHash: tx,
      blockNumber: block === undefined ? null : String(block),
      blockHash:
        block === undefined
          ? null
          : options.blockHash === null
            ? null
            : (options.blockHash ?? hashOf(block, tx ?? `0xf${key.length}`)),
      ...(block !== undefined && options.reverted !== false ? { reverted: true } : {}),
    });
    if (this.mints.delete(key) || key.startsWith('identity:register:'))
      this.evidenceState.set(key, 'failed');
  }

  /** Holds the next transfer answer until the returned function is called. */
  holdNextTransfer(): () => void {
    const gate = deferred<void>();
    this.transferHolds.push(gate.promise);
    return () => gate.resolve();
  }

  /** Holds the next evidence answer; resolves `reached` when the call arrives. */
  holdNextEvidence(answer: () => MintObservation | Promise<MintObservation>) {
    const gate = deferred<void>();
    const reached = deferred<void>();
    this.evidenceQueue.push(async () => {
      reached.resolve();
      await gate.promise;
      return answer();
    });
    return { reached: reached.promise, release: () => gate.resolve() };
  }

  signedKeys(): Record<string, number> {
    return Object.fromEntries(this.signs);
  }
}
