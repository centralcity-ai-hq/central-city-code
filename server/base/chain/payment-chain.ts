/*
 * The chain side of payments (the payment service's `PaymentChain` port). An agent transfer is ONE
 * UserOperation from the agent's spender account, so it either happens completely or not at all:
 *
 *   [approveWithSignature (first spend only: deploys the agent wallet, activates the permission)]
 *   SpendPermissionManager.spend(permission, amount)   agent wallet → spender account
 *   transfer(recipient, amount)                         spender account → recipient
 *
 * The amount is reserved on the agent wallet (holder = the payment's operation key) before
 * anything is signed; the reservation is consumed only when the operation is final. Keys, the
 * owner's signed permission and the signed operation never leave the chain module.
 *
 * Two limits apply to an owner's spending limit (W3): the on-chain allowance for the current Base
 * period (the security bound), and the owner's cap within the current Berlin calendar day, week or
 * month (calendar-limit.ts), checked in the reservation's transaction. Either one refuses.
 */
import { encodeFunctionData, getAddress, parseAbi, type Hex, type PublicClient } from 'viem';
import type { Database, Transaction } from '../../database.js';
import {
  BASE_MAINNET,
  NATIVE_ETH,
  allowedToken,
  type Address,
  type BaseNetwork,
} from '../../../shared/base/chains.js';
import type { ChainOpReceipt, PaymentSource, SpendPermission } from '../../../shared/base/types.js';
import { spenderAccountRecipe } from './derive.js';
import { limitPeriodOf } from '../../../shared/base/spend-limits.js';
import {
  assertWithinCalendarLimit,
  assertWithinPeriodAllowance,
  basePeriodWindow,
  CalendarLimitError,
  PeriodAllowanceError,
} from './calendar-limit.js';
import {
  SPONSOR_PAYMASTERS,
  sponsoredWithoutCharge,
  type SponsorAllowlist,
} from '../../../shared/base/paymasters.js';
import { checkPermission, spendPermissionManagerAbi } from './permissions.js';
import { ReservationError, type createReservationLedger } from './reservations.js';
import {
  abandonBeforeBroadcast,
  keystoreSigner,
  NEVER_BROADCAST,
  refreshFinality,
  submitOperation,
  type Bundler,
  type Call,
  type ChainOperationStore,
  type StoredOperation,
} from './submit.js';

/** The fields of the payment service's transfer intent this port needs (structurally typed). */
export interface PaymentIntent {
  workspaceId: string;
  chainId: number;
  source: PaymentSource;
  to: Address;
  token: Address;
  /** Integer base units as a decimal string. */
  amount: string;
  intentHash: Hex;
  operationKey: string;
}

export class PaymentChainError extends Error {
  constructor(
    readonly code:
      | 'WRONG_NETWORK'
      | 'UNSUPPORTED_SOURCE'
      | 'WALLET_NOT_FOUND'
      | 'WALLET_NOT_USABLE'
      | 'NO_PERMISSION'
      | 'OVER_ALLOWANCE'
      /** Within the on-chain allowance, but past the owner's cap for the Berlin day/week/month. */
      | 'OVER_CALENDAR_LIMIT'
      | 'TOKEN_NOT_ALLOWED'
      | 'INTENT_MISMATCH'
      | 'FEE_BUDGET_REQUIRED'
      /** On Base, a payment needs the sponsor allowlist: fees covered by a pinned sponsor or nothing. */
      | 'SPONSOR_REQUIRED',
    message: string,
  ) {
    super(message);
  }
}

const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

export interface PaymentChainDeps {
  network: BaseNetwork;
  client: PublicClient;
  db: Database;
  operations: ChainOperationStore;
  bundler: Bundler;
  keystore: {
    withSigner<T>(
      ref: string,
      use: (account: import('viem/accounts').PrivateKeyAccount) => Promise<T>,
    ): Promise<T>;
  };
  /** The signer address behind a spender key ref (public data from the keystore table). */
  signerOf(keyRef: string): Promise<Address>;
  ledger: ReturnType<typeof createReservationLedger>;
  /**
   * The payment service's current-authority check (grants, run, policy), run immediately before
   * the first broadcast; throwing refuses the send. It is told the spending limit signed into the
   * operation, so a check bound to one limit (an owner's consent) names exactly that one.
   */
  authorize?: (intent: PaymentIntent, limit: PaymentLimitRef) => Promise<void>;
  /** Fee budget per payment operation (wei); above it nothing is signed. */
  maxCostWeiCap?: bigint;
  /**
   * The sponsors that may pay a payment's network fee (shared/base/paymasters.ts). Given, every
   * operation must carry one of them in its exact layout with no token to charge, or nothing is
   * signed (NOT_SPONSORED); never an unsponsored fallback. Required on Base (SPONSOR_REQUIRED);
   * only a local test network may leave it out, where the account prefunds its own gas.
   */
  sponsors?: SponsorAllowlist;
  /** The tokens this adapter may move; others are refused (TOKEN_NOT_ALLOWED). Default: all allowed. */
  tokens?: readonly Address[];
  /** The clock (ms) for the permission window and the calendar counter; Date.now by default. */
  now?: () => number;
}

interface WalletRow {
  wallet_id: string;
  operator_id: string;
  state: string;
  address: string;
  spender_address: string;
  spender_key_ref: string;
}

interface PermissionRow {
  permission_id: string;
  permission: Record<string, string | number>;
  signature: Uint8Array;
  state: 'signed' | 'onchain' | 'revoke_pending' | 'revoked';
  /** The owner's cap for the calendar counter (migration 90); null for older rows. */
  cap_raw?: string | null;
  /** SpendPermissionManager.getHash of the limit (migration 90); null for older rows. */
  permission_hash?: string | null;
  /** When the limit was stored (ms, decimal). */
  created_at?: string | null;
}

/** The spending limit a payment spends under: the wallet and the limit's id and hash. */
export interface PaymentLimitRef {
  walletId: string;
  permissionId: string;
  /** Null for a limit stored before hashes were (no consent can name it). */
  permissionHash: string | null;
}

const toPermission = (raw: Record<string, string | number>): SpendPermission => ({
  account: getAddress(String(raw.account)),
  spender: getAddress(String(raw.spender)),
  token: getAddress(String(raw.token)),
  allowance: BigInt(raw.allowance),
  period: Number(raw.period),
  start: Number(raw.start),
  end: Number(raw.end),
  salt: BigInt(raw.salt),
  extraData: String(raw.extraData ?? '0x') as Hex,
});

/**
 * The newest active limit (signed, or approved on Base) of a wallet for the token and the wallet's
 * spender; null when there is none. A limit whose revoke was requested (revoke_pending) is never
 * used again.
 */
async function selectPermission(
  q: Pick<Transaction, 'query'>,
  input: { chainId: number; walletId: string; token: Address; spender: Address },
): Promise<PermissionRow | null> {
  const { rows } = await q.query<PermissionRow>(
    `SELECT permission_id, permission, signature, state, cap_raw::text AS cap_raw, permission_hash,
            created_at::text AS created_at
     FROM base_spend_permissions
     WHERE wallet_id = $1 AND chain_id = $2 AND state IN ('signed','onchain')
     ORDER BY created_at DESC`,
    [input.walletId, input.chainId],
  );
  return (
    rows.find((row) => {
      const p = toPermission(row.permission);
      return (
        p.token.toLowerCase() === input.token.toLowerCase() &&
        p.spender === getAddress(input.spender)
      );
    }) ?? null
  );
}

/**
 * The spending limit a payment from this wallet would spend under: exactly the one `submit` signs
 * into its operation (and names to `authorize`), so a check bound to one limit can name it before
 * anything is reserved. Null when there is none.
 */
export async function activePaymentLimit(
  q: Pick<Transaction, 'query'>,
  input: { chainId: number; walletId: string; token: Address; spender: Address },
): Promise<PaymentLimitRef | null> {
  const row = await selectPermission(q, input);
  return row
    ? {
        walletId: input.walletId,
        permissionId: row.permission_id,
        permissionHash: row.permission_hash ?? null,
      }
    : null;
}

function receipt(row: StoredOperation): ChainOpReceipt {
  return {
    opId: row.idempotencyKey,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    userOpHash: row.userOpHash,
    txHash: row.txHash,
    blockNumber: row.blockNumber === null ? null : BigInt(row.blockNumber),
    gasUsed: row.gasUsed === null ? null : BigInt(row.gasUsed),
    feeWei: row.feeWei === null ? null : BigInt(row.feeWei),
    errorCode: row.errorCode,
  };
}

export function createPaymentChain(deps: PaymentChainDeps) {
  const clock = deps.now ?? Date.now;
  const submitDeps = (
    signer: Parameters<typeof submitOperation>[0]['signer'],
    beforeRebroadcast?: (row: StoredOperation) => Promise<void>,
  ) => ({
    network: deps.network,
    client: deps.client,
    store: deps.operations,
    bundler: deps.bundler,
    signer,
    ...(beforeRebroadcast ? { beforeRebroadcast } : {}),
  });

  /**
   * The current authority of a payment, as its first send checks it (submit's beforeBroadcast):
   * wallet still usable, permission not revoked, and whatever the payment service checks (consent,
   * grants, policy). Run before an ambiguous first send is sent again.
   */
  async function authorityNow(intent: PaymentIntent, stored: StoredOperation) {
    const token = allowedToken(deps.network, intent.token);
    if (!token) throw new PaymentChainError('TOKEN_NOT_ALLOWED', 'This token is not allowed.');
    const now = await loadWallet(intent);
    const permission = await loadPermission(
      now.wallet_id,
      token.address,
      getAddress(stored.sender),
    );
    await deps.authorize?.(intent, {
      walletId: now.wallet_id,
      permissionId: permission.permission_id,
      permissionHash: permission.permission_hash ?? null,
    });
  }

  /** Recovery has no payment intent to check authority against: it never sends one again. */
  const neverResend = async (): Promise<void> => {
    throw new Error('Recovery never sends an ambiguous first send again.');
  };

  async function loadWallet(intent: PaymentIntent): Promise<WalletRow> {
    if (!('agentId' in intent.source))
      throw new PaymentChainError(
        'UNSUPPORTED_SOURCE',
        'Only agent sources are wired here; fleet sources use their batch allocation.',
      );
    const { rows } = await deps.db.query<WalletRow>(
      `SELECT wallet_id, operator_id, state, address, spender_address, spender_key_ref
       FROM base_wallets WHERE agent_id = $1 AND chain_id = $2`,
      [intent.source.agentId, intent.chainId],
    );
    const wallet = rows[0];
    if (!wallet || wallet.operator_id !== intent.workspaceId)
      throw new PaymentChainError(
        'WALLET_NOT_FOUND',
        'No wallet for this agent in this workspace and network.',
      );
    if (wallet.state !== 'derived' && wallet.state !== 'deployed')
      throw new PaymentChainError('WALLET_NOT_USABLE', `The wallet is ${wallet.state}.`);
    return wallet;
  }

  async function loadPermission(
    walletId: string,
    token: Address,
    spender: Address,
  ): Promise<PermissionRow> {
    const match = await selectPermission(deps.db, {
      chainId: deps.network.chainId,
      walletId,
      token,
      spender,
    });
    if (!match)
      throw new PaymentChainError(
        'NO_PERMISSION',
        'The owner has not granted a spending limit for this token.',
      );
    return match;
  }

  /**
   * Settles the payment's reservation once its operation is definitive: final → consumed, failed
   * (reverted and deep, or its nonce consumed by another operation) → released. A permission is
   * marked on-chain only when SpendPermissionManager itself reports it approved.
   */
  async function settle(operationKey: string, row: StoredOperation, walletId: string) {
    if (row.status !== 'final' && row.status !== 'failed') return;
    const permissions =
      row.status === 'final'
        ? await deps.db.query<PermissionRow>(
            `SELECT permission_id, permission, signature, state FROM base_spend_permissions
             WHERE wallet_id = $1 AND chain_id = $2 AND state = 'signed'`,
            [walletId, deps.network.chainId],
          )
        : { rows: [] };
    const approved: string[] = [];
    for (const candidate of permissions.rows) {
      const isApproved = await deps.client
        .readContract({
          address: deps.network.contracts.spendPermissionManager,
          abi: spendPermissionManagerAbi,
          functionName: 'isApproved',
          args: [toPermission(candidate.permission)],
        })
        .catch(() => false);
      if (isApproved) approved.push(candidate.permission_id);
    }
    await deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ reservation_id: string; state: string }>(
        `SELECT reservation_id, state FROM base_wallet_reservations
         WHERE holder_kind = 'payment' AND holder_ref = $1 AND wallet_id = $2`,
        [operationKey, walletId],
      );
      const reservation = rows[0];
      if (reservation?.state === 'held') {
        if (row.status === 'final')
          await deps.ledger.consume(tx, reservation.reservation_id, operationKey);
        else await deps.ledger.release(tx, reservation.reservation_id);
      }
      if (approved.length)
        await tx.query(
          `UPDATE base_spend_permissions SET state = 'onchain', updated_at = $2
           WHERE permission_id = ANY($1::text[]) AND state = 'signed'`,
          [approved, Date.now()],
        );
    });
  }

  /**
   * Releases the payment's held reservation. Only for operations that provably never went out: a
   * tombstone, or an operation refused or expired before its first broadcast. Idempotent.
   */
  async function releaseFor(operationKey: string) {
    await deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ reservation_id: string; state: string }>(
        `SELECT reservation_id, state FROM base_wallet_reservations
         WHERE holder_kind = 'payment' AND holder_ref = $1 AND chain_id = $2`,
        [operationKey, deps.network.chainId],
      );
      for (const row of rows)
        if (row.state === 'held') await deps.ledger.release(tx, row.reservation_id);
    });
  }

  const neverSent = (row: StoredOperation) =>
    row.status === 'failed' && (NEVER_BROADCAST as readonly string[]).includes(row.errorCode ?? '');

  /** Reconciling and finality only read and rebroadcast the stored operation; nothing is signed. */
  const readOnly = (stored: StoredOperation) => ({
    address: getAddress(stored.signer),
    signUserOperation: async (): Promise<Hex> => {
      throw new Error('Reconciliation never signs.');
    },
  });

  /** The wallet that sent a stored operation, checked against the intent's agent and workspace. */
  async function walletOfOperation(intent: PaymentIntent, stored: StoredOperation) {
    const { rows } = await deps.db.query<{
      wallet_id: string;
      agent_id: string;
      operator_id: string;
    }>(
      'SELECT wallet_id, agent_id, operator_id FROM base_wallets WHERE spender_address = $1 AND chain_id = $2',
      [stored.sender, deps.network.chainId],
    );
    const wallet = rows.find((w) => w.operator_id === intent.workspaceId);
    if (!wallet || !('agentId' in intent.source) || wallet.agent_id !== intent.source.agentId)
      throw new PaymentChainError('INTENT_MISMATCH', 'This operation was not sent for this agent.');
    return wallet;
  }

  return {
    async status(intent: PaymentIntent): Promise<ChainOpReceipt | null> {
      const stored = await deps.operations.get(intent.operationKey);
      if (!stored) return null;
      if (stored.intentHash !== intent.intentHash)
        throw new PaymentChainError(
          'INTENT_MISMATCH',
          'This operation key belongs to another intent.',
        );
      // Never sent (tombstone, refused or expired): release again, in case a process died between
      // writing that outcome and releasing.
      if (neverSent(stored)) {
        await releaseFor(intent.operationKey);
        return receipt(stored);
      }
      const wallet = await walletOfOperation(intent, stored);
      const row =
        (await refreshFinality(
          submitDeps(readOnly(stored), () => authorityNow(intent, stored)),
          intent.operationKey,
          {
            retireLapsed: true,
            ownLane: true,
          },
        )) ?? stored;
      await settle(intent.operationKey, row, wallet.wallet_id);
      return receipt(row);
    },

    async submit(intent: PaymentIntent): Promise<ChainOpReceipt> {
      if (intent.chainId !== deps.network.chainId)
        throw new PaymentChainError('WRONG_NETWORK', 'This chain adapter serves another network.');
      // Real money is never sent without a fee budget: on the real network a cap is mandatory.
      if (deps.network.chainId === BASE_MAINNET && deps.maxCostWeiCap === undefined)
        throw new PaymentChainError('FEE_BUDGET_REQUIRED', 'Mainnet payments need a fee budget.');
      // Fees covered by a pinned sponsor or nothing: on the real network the allowlist is mandatory.
      if (deps.network.chainId === BASE_MAINNET && deps.sponsors === undefined)
        throw new PaymentChainError('SPONSOR_REQUIRED', 'Mainnet payments need a pinned sponsor.');
      const token = allowedToken(deps.network, intent.token);
      if (
        !token ||
        (deps.tokens && !deps.tokens.some((t) => getAddress(t) === getAddress(token.address)))
      )
        throw new PaymentChainError('TOKEN_NOT_ALLOWED', 'Token is not allowlisted.');
      if (typeof intent.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(intent.amount))
        throw new PaymentChainError(
          'OVER_ALLOWANCE',
          'Amount must be a positive integer in base units.',
        );
      const amount = BigInt(intent.amount);
      const wallet = await loadWallet(intent);
      const spender = getAddress(wallet.spender_address);
      const permissionRow = await loadPermission(wallet.wallet_id, token.address, spender);
      const permission = toPermission(permissionRow.permission);
      checkPermission(permission);
      if (amount > permission.allowance)
        throw new PaymentChainError('OVER_ALLOWANCE', 'The amount exceeds the spending limit.');
      // Refuse what the chain would revert anyway, before anything is reserved or signed.
      if (permission.account !== getAddress(wallet.address))
        throw new PaymentChainError(
          'NO_PERMISSION',
          'The spending limit belongs to another wallet.',
        );
      const nowMs = clock();
      const nowSeconds = Math.floor(nowMs / 1000);
      if (nowSeconds < permission.start || nowSeconds >= permission.end)
        throw new PaymentChainError('NO_PERMISSION', 'The spending limit is not active now.');
      // A limit not approved on Base yet has spent nothing there.
      let onchainSpend = 0n;
      // Taken before the read: a payment settled after this moment may be missing from it.
      let chainReadAtMs: number | null = null;
      if (permissionRow.state === 'onchain') {
        chainReadAtMs = clock();
        const period = await deps.client.readContract({
          address: deps.network.contracts.spendPermissionManager,
          abi: spendPermissionManagerAbi,
          functionName: 'getCurrentPeriod',
          args: [permission],
        });
        onchainSpend = BigInt(period.spend);
        if (onchainSpend + amount > permission.allowance)
          throw new PaymentChainError(
            'OVER_ALLOWANCE',
            'The spending limit for this period is used up.',
          );
      }

      // Reserve before signing; a retry of the same payment finds its own reservation. A limit
      // with a calendar period (day/week/month) is also counted on the Berlin calendar first.
      const calendar = limitPeriodOf(permission.period);
      try {
        await deps.db.transaction(async (tx) => {
          // Payments sent but not on Base yet count against the period's allowance too: without
          // this, two at once each fit what Base reports and the second reverts on Base.
          await assertWithinPeriodAllowance(tx, {
            walletId: wallet.wallet_id,
            chainId: intent.chainId,
            token: token.address,
            amount,
            allowance: permission.allowance,
            onchainSpend,
            window: basePeriodWindow(permission, nowSeconds),
            limitCreatedAtMs: Number(permissionRow.created_at ?? 0),
            chainReadAtMs,
            holderRef: intent.operationKey,
          });
          if (calendar)
            await assertWithinCalendarLimit(tx, {
              walletId: wallet.wallet_id,
              chainId: intent.chainId,
              token: token.address,
              amount,
              cap: permissionRow.cap_raw ? BigInt(permissionRow.cap_raw) : permission.allowance,
              period: calendar,
              holderRef: intent.operationKey,
              nowMs,
            });
          return deps.ledger.reserve(tx, {
            walletId: wallet.wallet_id,
            chainId: intent.chainId,
            token: token.address,
            amount,
            holder: { kind: 'payment', ref: intent.operationKey },
            intentHash: intent.intentHash,
          });
        });
      } catch (error) {
        if (error instanceof CalendarLimitError)
          throw new PaymentChainError('OVER_CALENDAR_LIMIT', error.message);
        if (error instanceof PeriodAllowanceError)
          throw new PaymentChainError('OVER_ALLOWANCE', error.message);
        // Already consumed: the payment happened; report its operation instead of sending again.
        if (!(error instanceof ReservationError && error.code === 'RESERVATION_CLOSED'))
          throw error;
        const stored = await deps.operations.get(intent.operationKey);
        if (stored) return receipt(stored);
        throw error;
      }

      const spm = deps.network.contracts.spendPermissionManager;
      const calls: Call[] = [];
      if (permissionRow.state === 'signed')
        calls.push({
          target: spm,
          value: 0n,
          data: encodeFunctionData({
            abi: spendPermissionManagerAbi,
            functionName: 'approveWithSignature',
            args: [permission, `0x${Buffer.from(permissionRow.signature).toString('hex')}` as Hex],
          }),
        });
      calls.push({
        target: spm,
        value: 0n,
        data: encodeFunctionData({
          abi: spendPermissionManagerAbi,
          functionName: 'spend',
          args: [permission, amount],
        }),
      });
      calls.push(
        token.address === NATIVE_ETH
          ? { target: getAddress(intent.to), value: amount, data: '0x' }
          : {
              target: token.address,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [getAddress(intent.to), amount],
              }),
            },
      );

      // Everything from here to the stored operation can fail (missing key, fee cap, bundler). If it
      // does and nothing was stored, the key is fenced with a tombstone before anything is released.
      let row: StoredOperation;
      try {
        const signerAddress = await deps.signerOf(wallet.spender_key_ref);
        const signer = keystoreSigner(
          deps.client,
          deps.keystore,
          wallet.spender_key_ref,
          signerAddress,
          deps.network.chainId,
        );
        row = await submitOperation(submitDeps(signer), {
          idempotencyKey: intent.operationKey,
          intentHash: intent.intentHash,
          kind: 'transfer',
          account: { address: spender, recipe: spenderAccountRecipe(deps.network, signerAddress) },
          calls,
          maxCostWeiCap: deps.maxCostWeiCap,
          ...(deps.sponsors
            ? {
                sponsorCheck: (data: Hex) =>
                  sponsoredWithoutCharge(deps.network.chainId, data, deps.sponsors),
              }
            : {}),
          // Current authority right before the first broadcast: wallet still usable, permission
          // not revoked, and whatever the payment service checks (run, grants, policy), told the
          // limit this operation spends under.
          beforeBroadcast: async () => {
            const now = await loadWallet(intent);
            const current = await loadPermission(now.wallet_id, token.address, spender);
            await deps.authorize?.(intent, {
              walletId: wallet.wallet_id,
              permissionId: permissionRow.permission_id,
              permissionHash: permissionRow.permission_hash ?? null,
            });
            // Still the limit this operation was built with: one revoked meanwhile (and a new one
            // set after it) is never approved or spent from here (the owner's consent, checked
            // just above, is bound to that limit too).
            if (current.permission_id !== permissionRow.permission_id)
              throw new PaymentChainError('NO_PERMISSION', 'The spending limit changed.');
          },
        });
      } catch (error) {
        if (await deps.operations.get(intent.operationKey)) throw error;
        const { abandoned } = await abandonBeforeBroadcast(deps.operations, {
          idempotencyKey: intent.operationKey,
          intentHash: intent.intentHash,
          chainId: deps.network.chainId,
          kind: 'transfer',
        });
        if (abandoned) await releaseFor(intent.operationKey);
        throw error;
      }
      // Refused at the last check: never sent, so the reservation is released right away.
      if (neverSent(row)) await releaseFor(intent.operationKey);
      return receipt(row);
    },

    /**
     * For a submit that threw: when nothing was stored for the payment (refused before its
     * operation existed: over the limit, no balance, no sponsor, ...), its key is fenced with a
     * tombstone (insert-if-absent) and anything it still holds released, so the payment records a
     * final failure instead of waiting on an operation that never existed. An operation stored
     * meanwhile wins the key and is reconciled as usual: false, nothing is changed.
     */
    async fence(intent: PaymentIntent): Promise<boolean> {
      if (intent.chainId !== deps.network.chainId)
        throw new PaymentChainError('WRONG_NETWORK', 'This chain adapter serves another network.');
      const { abandoned } = await abandonBeforeBroadcast(deps.operations, {
        idempotencyKey: intent.operationKey,
        intentHash: intent.intentHash,
        chainId: deps.network.chainId,
        kind: 'transfer',
      });
      if (abandoned) await releaseFor(intent.operationKey);
      return abandoned;
    },

    /**
     * For recovery of a payment cut off between its start and its submit (the process died after
     * the payment row moved to settling, before or while the chain reserved and signed): the key is
     * fenced with a tombstone (insert-if-absent), so a late worker finds it and never sends, and
     * anything the key still holds is released. Answers what the key holds now:
     *
     *   'unsent'  → a tombstone or a refused/expired operation: provably never sent
     *   'stored'  → a real operation won the key first (queued or sent): left alone, it settles
     *               through its reservation as usual
     *   'other'   → the key belongs to another intent: left alone
     *
     * Never signs, never builds an operation, never re-sends.
     */
    async endUnsent(ref: { operationKey: string; intentHash: Hex }) {
      const { row } = await abandonBeforeBroadcast(deps.operations, {
        idempotencyKey: ref.operationKey,
        intentHash: ref.intentHash,
        chainId: deps.network.chainId,
        kind: 'transfer',
      });
      if (row.intentHash.toLowerCase() !== ref.intentHash.toLowerCase()) return 'other' as const;
      if (!neverSent(row)) return 'stored' as const;
      await releaseFor(ref.operationKey);
      return 'unsent' as const;
    },

    /**
     * The durable recovery owner for payments whose process died mid-submit. Run on a schedule; it
     * looks only at payment reservations still held after the grace period:
     *
     *   no operation stored  → fenced with a tombstone (insert-if-absent), then released
     *   tombstone / refused  → released
     *   queued (stored, never authorized) → expired by compare-and-set queued→failed, then
     *                          released; a live worker's queued→submitted claim then finds no
     *                          queued row and never sends, so the two can never both win
     *   anything sent        → reconciled and settled exactly like status()
     *
     * It never signs and never builds a new operation; at most it re-sends a stored operation that
     * was already submitted (same hash, same nonce lane).
     */
    async recover(
      options: { graceMs?: number; limit?: number; now?: number; after?: RecoveryCursor } = {},
    ) {
      const graceMs = Math.max(options.graceMs ?? RECOVERY_GRACE_MS, MIN_RECOVERY_GRACE_MS);
      const now = options.now ?? Date.now();
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
      // Keyset pages over (created_at, reservation_id): rows that stay unresolved never hold back
      // newer ones; a run walks pages until `next` is null and then starts over from the oldest.
      const after = options.after ?? { createdAt: '-1', reservationId: '' };
      const { rows } = await deps.db.query<{
        reservation_id: string;
        created_at: string;
        holder_ref: string;
        intent_hash: string;
        wallet_id: string;
      }>(
        `SELECT reservation_id, created_at::text AS created_at, holder_ref, intent_hash, wallet_id
         FROM base_wallet_reservations
         WHERE holder_kind = 'payment' AND state = 'held' AND chain_id = $1 AND created_at < $2
           AND (created_at, reservation_id) > ($4::bigint, $5::text)
         ORDER BY created_at, reservation_id LIMIT $3`,
        [deps.network.chainId, now - graceMs, limit, after.createdAt, after.reservationId],
      );
      const last = rows.at(-1);
      const result = {
        checked: 0,
        abandoned: 0,
        expired: 0,
        released: 0,
        settled: 0,
        errors: 0,
        next:
          rows.length === limit && last
            ? ({ createdAt: last.created_at, reservationId: last.reservation_id } as RecoveryCursor)
            : null,
      };
      for (const held of rows) {
        result.checked++;
        // One broken row (RPC, store) never stops the rest of the page.
        try {
          await recoverOne(held, result);
        } catch {
          result.errors++;
        }
      }
      return result;
    },
  };

  async function recoverOne(
    held: { holder_ref: string; intent_hash: string; wallet_id: string },
    result: { abandoned: number; expired: number; released: number; settled: number },
  ) {
    let stored = await deps.operations.get(held.holder_ref);
    if (!stored) {
      const fenced = await abandonBeforeBroadcast(deps.operations, {
        idempotencyKey: held.holder_ref,
        intentHash: held.intent_hash as Hex,
        chainId: deps.network.chainId,
        kind: 'transfer',
      });
      // A real operation was stored meanwhile: it is handled on the next run.
      if (!fenced.abandoned) return;
      result.abandoned++;
      stored = fenced.row;
    }
    // A reservation and an operation for different intents are never reconciled together.
    if (stored.intentHash.toLowerCase() !== held.intent_hash.toLowerCase()) return;
    if (stored.status === 'queued') {
      const expired = await deps.operations.transition(held.holder_ref, ['queued'], {
        status: 'failed',
        errorCode: 'EXPIRED_BEFORE_BROADCAST',
      });
      if (!expired) return;
      result.expired++;
      stored = expired;
    }
    if (neverSent(stored)) {
      await releaseFor(held.holder_ref);
      result.released++;
      return;
    }
    const row =
      (await refreshFinality(submitDeps(readOnly(stored), neverResend), held.holder_ref, {
        retireLapsed: true,
        ownLane: true,
      })) ?? stored;
    await settle(held.holder_ref, row, held.wallet_id);
    if (row.status === 'final' || row.status === 'failed') result.settled++;
  }
}

/** Where a recovery run continues: the last reservation of the previous page. */
export interface RecoveryCursor {
  createdAt: string;
  reservationId: string;
}

/** How long a payment reservation may stay held without a finished submit before recovery acts. */
export const RECOVERY_GRACE_MS = 10 * 60 * 1000;
/** Recovery never acts sooner: a live worker's authority check must have had time to finish. */
export const MIN_RECOVERY_GRACE_MS = 60 * 1000;

export type PaymentChainPort = ReturnType<typeof createPaymentChain>;

/**
 * The payment chain of an agent's own payments (Base Pay P2c), as the chain runtime builds it:
 * fees covered by a pinned sponsor (shared/base/paymasters.ts) or nothing is signed, USDC only,
 * within the wallet operations' fee budget. There is no owner-funded fallback and no ETH.
 */
export function agentPaymentChain(
  deps: Omit<PaymentChainDeps, 'sponsors' | 'tokens'>,
): PaymentChainPort {
  return createPaymentChain({
    ...deps,
    sponsors: SPONSOR_PAYMASTERS,
    tokens: [deps.network.tokens.USDC.address],
  });
}
