import { createHash } from 'node:crypto';
import {
  allowedToken,
  baseNetwork,
  type Address,
  type BaseChainId,
} from '../../../shared/base/chains.js';
import type {
  ChainOpReceipt,
  Hex,
  PaymentSource,
  PaymentState,
} from '../../../shared/base/types.js';

export interface PaymentActor {
  workspaceId: string;
  actorId: string;
}

export interface TransferInput {
  chainId: BaseChainId;
  source: PaymentSource;
  to: Address;
  token: Address;
  amount: bigint;
  idempotencyKey: string;
}

export interface TransferIntent extends PaymentActor {
  chainId: BaseChainId;
  source: PaymentSource;
  to: Address;
  token: Address;
  amount: string;
  idempotencyKey: string;
  intentHash: Hex;
  operationKey: string;
}

export interface TransferRecord {
  intent: TransferIntent;
  state: PaymentState;
  receipt: ChainOpReceipt | null;
}

export interface PaymentStore {
  /** Atomically insert or return by workspace/chain/key; reject a different intent hash. */
  reserve(intent: TransferIntent): Promise<TransferRecord>;
  /** Atomic durable mark-before-call; only the worker that changes created may acquire. */
  begin(intent: TransferIntent): Promise<{ acquired: boolean; record: TransferRecord }>;
  /** Append a reconciliation observation, never overwrite newer canonical chain evidence. */
  observe(intent: TransferIntent, receipt: ChainOpReceipt | null): Promise<TransferRecord>;
}

export interface PaymentAuthority {
  /** Recheck caller grants, source ownership/freeze, recipient policy and approved fleet allocation. */
  assertCanTransfer(intent: TransferIntent): Promise<void>;
}

export interface PaymentChain {
  status(intent: TransferIntent): Promise<ChainOpReceipt | null>;
  /**
   * Atomically reserve balances/nonces and persist a fenced, signed operation before broadcast.
   * Repeated calls must reconcile/rebroadcast the same operation, never allocate a fresh nonce.
   * Recheck current authority immediately before a new broadcast. Fleet sources consume their
   * parent allocation rather than reserving the same principal twice. No keys cross this port.
   */
  submit(intent: TransferIntent): Promise<ChainOpReceipt>;
}

export class PaymentError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PaymentError';
  }
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new PaymentError('INVALID_IDENTIFIER');
}

function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value))
    throw new PaymentError('INVALID_ADDRESS');
  return value.toLowerCase() as Address;
}

const hash = (value: unknown): Hex =>
  `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/**
 * The chain operation key of a payment: what its reservation and its operation are held under.
 * Payment recovery computes it from a stored row (operator, chain, idempotency key).
 */
export const paymentOperationKey = (workspaceId: string, chainId: number, idempotencyKey: string) =>
  `payment:${hash([workspaceId, chainId, idempotencyKey])}`;

export function intentFor(
  actor: PaymentActor,
  input: TransferInput,
  /** The deployment's settings: Base itself is a network only with its own gate open (chains.ts). */
  env?: Record<string, string | undefined>,
): TransferIntent {
  identifier(actor.workspaceId);
  identifier(actor.actorId);
  identifier(input.idempotencyKey);
  // Without the deployment's settings only the test network exists.
  const network = baseNetwork(input.chainId, env);
  if (!network) throw new PaymentError('NETWORK_DISABLED');
  const token = address(input.token);
  if (!allowedToken(network, token)) throw new PaymentError('TOKEN_NOT_ALLOWED');
  const to = address(input.to);
  if (typeof input.amount !== 'bigint' || input.amount <= 0n || input.amount >= 2n ** 256n)
    throw new PaymentError('INVALID_AMOUNT');
  const keys = Object.keys(input.source ?? {});
  if (keys.length !== 1 || !['agentId', 'fleetJobId'].includes(keys[0]))
    throw new PaymentError('INVALID_SOURCE');
  const sourceId = 'agentId' in input.source ? input.source.agentId : input.source.fleetJobId;
  identifier(sourceId);
  const source: PaymentSource =
    keys[0] === 'agentId' ? { agentId: sourceId } : { fleetJobId: sourceId };
  // Protocol v1 field order is part of the hash contract; do not replace with input spreads.
  const fields = {
    workspaceId: actor.workspaceId,
    actorId: actor.actorId,
    chainId: input.chainId,
    source,
    to,
    token,
    amount: input.amount.toString(),
    idempotencyKey: input.idempotencyKey,
  };
  return Object.freeze({
    ...fields,
    source: Object.freeze(source),
    intentHash: hash(['cc.transfer.v1', fields]),
    operationKey: paymentOperationKey(actor.workspaceId, input.chainId, input.idempotencyKey),
  });
}

/** Transfer orchestration only. Production persistence/chain wiring and x402 are separate slices. */
export function createPaymentService(ports: {
  store: PaymentStore;
  authority: PaymentAuthority;
  chain: PaymentChain;
  env?: Record<string, string | undefined>;
}) {
  return {
    async transfer(actor: PaymentActor, input: TransferInput): Promise<TransferRecord> {
      const intent = intentFor(actor, input, ports.env);
      await ports.authority.assertCanTransfer(intent);
      const record = await ports.store.reserve(intent);
      if (record.intent.intentHash !== intent.intentHash)
        throw new PaymentError('IDEMPOTENCY_CONFLICT');

      let receipt: ChainOpReceipt | null;
      try {
        receipt = await ports.chain.status(intent);
      } catch {
        if (record.state === 'created') return record;
        return ports.store.observe(intent, null);
      }
      if (receipt) {
        if (receipt.idempotencyKey !== intent.operationKey)
          throw new PaymentError('RECEIPT_MISMATCH');
        return ports.store.observe(intent, receipt);
      }
      // A missing status is not proof that a previously attempted transfer was never broadcast.
      if (record.state !== 'created') return ports.store.observe(intent, null);
      await ports.authority.assertCanTransfer(intent);
      const begun = await ports.store.begin(intent);
      if (begun.record.intent.intentHash !== intent.intentHash)
        throw new PaymentError('IDEMPOTENCY_CONFLICT');
      if (!begun.acquired) return begun.record;
      try {
        receipt = await ports.chain.submit(intent);
      } catch {
        return ports.store.observe(intent, null);
      }
      if (receipt.idempotencyKey !== intent.operationKey)
        throw new PaymentError('RECEIPT_MISMATCH');
      return ports.store.observe(intent, receipt);
    },
  };
}
