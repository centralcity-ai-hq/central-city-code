/*
 * Operation Base Wallet W3 (contract v1.1 gate 4, v1.3): the owner's spending limit for an agent's
 * wallet, one per token (USDC only), signed in the browser by the owner key.
 *
 *   prepare  the spend permission for the owner's cap and period: account = the agent wallet,
 *            spender = the agent's spender account, the fixed on-chain period starting at 00:00
 *            Berlin of the current day (so the first period is today's and the limit works at
 *            once), no end, a random salt; plus the typed data the owner signs
 *   store    the signed permission, rebuilt and compared field by field, the owner recovered from
 *            the signature, wrapped for the wallet (ERC-6492 while it has no code); 'signed'
 *   list     every limit with Base's view at ONE block (period, spent, left, approved, revoked)
 *            and the Berlin calendar counter; a failed read is `onchain: null` + `stale`, never 0
 *   revoke   two-phase: the DB blocks the agent at once ('revoke_pending'), the owner signs a
 *            UserOperation calling SpendPermissionManager.revoke(permission), and the limit is
 *            'revoked' only once a read of Base at a settled block shows it revoked
 *
 * The on-chain allowance per Base period follows the server's model (shared/base/spend-limits.ts):
 * 'half' (default) = floor(cap / 2), 'full' = cap. The calendar counter always uses the full cap.
 * Authorized by the wallet's owner account (base_wallets.owner_account_id), never by current agent
 * access (gate 3); anyone else gets 404. Audit events never carry a signature.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  formatUnits,
  getAddress,
  hexToBytes,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Hex,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { z } from 'zod';
import type { Database, Transaction } from '../../database.js';
import {
  BASE_MAINNET,
  BASE_NETWORKS,
  type Address,
  type BaseChainId,
} from '../../../shared/base/chains.js';
import type { SpendPermission, WalletDerivation } from '../../../shared/base/types.js';
import {
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  LIMIT_SIGNATURE_TTL_MS,
  LIMIT_TIME_ZONE,
  berlinDayStart,
  calendarPeriod,
  onchainAllowance,
  permissionFromJson,
  permissionToJson,
  revokeCall,
  spendPermissionHash,
  type LimitPeriod,
  type OnchainCapModel,
} from '../../../shared/base/spend-limits.js';
import { sponsorshipEnding } from '../../../shared/base/paymasters.js';
import { calendarSpent } from '../chain/calendar-limit.js';
import { DERIVATION_VERSION, type DerivationRecipe } from '../chain/derive.js';
import {
  OwnerRevokeError,
  rawSigner,
  type OwnerRevokePort,
  type PreparedOwnerOperation,
} from '../chain/owner-revoke.js';
import type { PermissionChainState, PermissionReader } from '../chain/permission-reader.js';
import { checkPermission, ownerTypedData, walletSignature } from '../chain/permissions.js';
import { toRpc } from '../chain/rpc-bundler.js';
import { fromJson, type StoredOperation } from '../chain/submit.js';

export class LimitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface LimitServiceDeps {
  db: Database;
  /** The wallet network (the wallet routes' one constant). */
  chainId: BaseChainId;
  /** The on-chain model for NEW limits; stored limits keep the model they were signed with. */
  model: OnchainCapModel;
  /** Base reads; absent when no endpoint is configured (views are then stale, never zeros). */
  permissions?: PermissionReader;
  /** The owner-operation port for revokes; throws when the chain is not configured. */
  operations?: () => Promise<OwnerRevokePort>;
  now?: () => number;
}

/** Listed per wallet, newest first. */
export const LIMITS_LISTED = 20;

const MAX_UINT160 = 2n ** 160n - 1n;
const CAP = /^[1-9][0-9]{0,48}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const periodSchema = z.enum(['day', 'week', 'month']);
const prepareBody = z.strictObject({ capRaw: z.string().regex(CAP), period: periodSchema });
const storeBody = z.strictObject({
  permission: z.unknown(),
  capRaw: z.string().regex(CAP),
  period: periodSchema,
  signature: z.string().regex(SIGNATURE),
});
const signatureBody = z.strictObject({ signature: z.string().regex(SIGNATURE) });
const emptyBody = z.strictObject({});

type DbState = 'signed' | 'onchain' | 'revoke_pending' | 'revoked';
export type LimitState = 'signed' | 'approved' | 'revoke_pending' | 'revoked';
const apiState = (state: DbState): LimitState => (state === 'onchain' ? 'approved' : state);

export type RevokeState =
  'awaiting_signature' | 'expired' | 'submitted' | 'included' | 'final' | 'failed';

interface WalletRow {
  wallet_id: string;
  agent_id: string;
  operator_id: string;
  address: string;
  owner_address: string;
  spender_address: string;
  derivation: WalletDerivation;
  state: string;
  backup_confirmed_at: string | number | null;
  vault_owner: string | null;
}

interface LimitRow {
  permission_id: string;
  wallet_id: string;
  permission: Record<string, unknown>;
  state: DbState;
  token: string;
  permission_hash: string;
  period_kind: LimitPeriod;
  cap_raw: string;
  onchain_model: OnchainCapModel;
  created_at: string | number;
  revoke_requested_at: string | number | null;
  revoke_attempt: number;
  revoke_operation: Record<string, unknown> | null;
  revoke_user_op_hash: string | null;
  revoke_expires_at: string | number | null;
  revoke_op_key: string | null;
  revoke_submitted_at: string | number | null;
  revoked_at: string | number | null;
  revoked_block: string | number | null;
}

// The owner's signature columns are never selected into a view.
const COLUMNS = `permission_id, wallet_id, permission, state, token, permission_hash, period_kind,
  cap_raw::text AS cap_raw, onchain_model, created_at, revoke_requested_at, revoke_attempt,
  revoke_operation, revoke_user_op_hash, revoke_expires_at, revoke_op_key, revoke_submitted_at,
  revoked_at, revoked_block`;

const stored = (row: LimitRow): SpendPermission => {
  const permission = permissionFromJson(row.permission);
  if (!permission) throw new Error('Stored permission is malformed.');
  return permission;
};

const opJson = (op: UserOperation<'0.6'>) =>
  JSON.parse(
    JSON.stringify(op, (_key, value) => (typeof value === 'bigint' ? value.toString(10) : value)),
  ) as Record<string, unknown>;

const revokeStateOf = (op: StoredOperation | null): RevokeState => {
  if (!op) return 'submitted';
  if (op.status === 'final' || op.status === 'failed' || op.status === 'included') return op.status;
  return 'submitted';
};

/** The durable key of a revoke attempt; one attempt is one signed operation at most. */
const revokeKey = (row: LimitRow) =>
  `base-wallet:limit-revoke:${row.permission_id}:${row.revoke_attempt}`;

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';

export function createLimitService(deps: LimitServiceDeps) {
  const now = deps.now ?? Date.now;
  const network = BASE_NETWORKS[deps.chainId];
  const usdc = network.tokens.USDC;
  const display = (raw: bigint) => formatUnits(raw, usdc.decimals);

  async function walletOf(accountId: string, agentId: string): Promise<WalletRow> {
    const { rows } = await deps.db.query<WalletRow>(
      `SELECT w.wallet_id, w.agent_id, w.operator_id, w.address, w.owner_address,
         w.spender_address, w.derivation, w.state, v.backup_confirmed_at,
         v.owner_address AS vault_owner
       FROM base_wallets w
       LEFT JOIN base_owner_vaults v ON v.operator_id = w.owner_account_id
       WHERE w.agent_id = $1 AND w.chain_id = $2 AND w.owner_account_id = $3`,
      [agentId, deps.chainId, accountId],
    );
    // Not the owner of this agent's wallet (or no wallet): not disclosed.
    if (!rows[0]) throw new LimitError(404, 'not_found', 'Not found.');
    return rows[0];
  }

  /** New limits need the owner's key backed up, like funding (contract v1.2). */
  function requireBackup(wallet: WalletRow) {
    if (
      wallet.backup_confirmed_at === null ||
      !wallet.vault_owner ||
      wallet.vault_owner.toLowerCase() !== wallet.owner_address.toLowerCase()
    )
      throw new LimitError(409, 'backup_required', 'Confirm your backup key first.');
    if (wallet.state !== 'derived' && wallet.state !== 'deployed')
      throw new LimitError(409, 'wallet_not_usable', `The wallet is ${wallet.state}.`);
  }

  const recipeOf = (wallet: WalletRow): DerivationRecipe => ({
    version: DERIVATION_VERSION,
    factory: getAddress(wallet.derivation.factory),
    owners: wallet.derivation.owners.map((owner) => getAddress(owner)),
    index: BigInt(wallet.derivation.accountIndex),
  });

  async function audit(
    q: Pick<Transaction, 'query'>,
    wallet: WalletRow,
    actor: string,
    kind: string,
    detail: Record<string, unknown>,
  ) {
    await q.query(
      `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        now(),
        actor,
        wallet.operator_id,
        wallet.agent_id,
        kind,
        JSON.stringify({ chainId: deps.chainId, walletId: wallet.wallet_id, ...detail }),
      ],
    );
  }

  async function limitsOf(wallet: WalletRow): Promise<LimitRow[]> {
    const { rows } = await deps.db.query<LimitRow>(
      `SELECT ${COLUMNS} FROM base_spend_permissions
       WHERE wallet_id = $1 AND chain_id = $2 AND permission_hash IS NOT NULL
       ORDER BY created_at DESC, permission_id LIMIT ${LIMITS_LISTED}`,
      [wallet.wallet_id, deps.chainId],
    );
    return rows;
  }

  async function limitOf(wallet: WalletRow, permissionId: string): Promise<LimitRow> {
    const { rows } = await deps.db.query<LimitRow>(
      `SELECT ${COLUMNS} FROM base_spend_permissions
       WHERE permission_id = $1 AND wallet_id = $2 AND chain_id = $3
         AND permission_hash IS NOT NULL`,
      [permissionId, wallet.wallet_id, deps.chainId],
    );
    if (!rows[0]) throw new LimitError(404, 'not_found', 'Not found.');
    return rows[0];
  }

  /**
   * Gate 4: a limit counts as revoked only when Base says so at a settled block (isRevoked, so
   * isValid is false too). Proven rows become 'revoked'; a failed read proves nothing.
   */
  async function proveRevoked(wallet: WalletRow, candidates: LimitRow[], actor: string) {
    const proven = new Set<string>();
    if (!deps.permissions || candidates.length === 0) return proven;
    let read;
    try {
      read = await deps.permissions.read(candidates.map(stored), { settled: true });
    } catch {
      return proven;
    }
    for (const [index, row] of candidates.entries()) {
      if (!read.permissions[index]?.revoked) continue;
      proven.add(row.permission_id);
      await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<{ permission_id: string }>(
          `UPDATE base_spend_permissions SET state = 'revoked', revoked_at = $2, revoked_block = $3,
             updated_at = $2
           WHERE permission_id = $1 AND state <> 'revoked' RETURNING permission_id`,
          [row.permission_id, now(), read.blockNumber.toString(10)],
        );
        if (rows[0])
          await audit(tx, wallet, actor, 'limit_revoked', {
            permissionId: row.permission_id,
            permissionHash: row.permission_hash,
            block: Number(read.blockNumber),
          });
      });
    }
    return proven;
  }

  /** One limit per token: anything not revoked blocks a new one, unless Base proves it revoked. */
  async function requireNoActiveLimit(wallet: WalletRow, actor: string) {
    const { rows } = await deps.db.query<LimitRow>(
      `SELECT ${COLUMNS} FROM base_spend_permissions
       WHERE wallet_id = $1 AND token = $2 AND state <> 'revoked'`,
      [wallet.wallet_id, usdc.address.toLowerCase()],
    );
    if (!rows.length) return;
    const proven = await proveRevoked(wallet, rows, actor);
    const open = rows.find((row) => !proven.has(row.permission_id));
    if (open)
      throw new LimitError(
        409,
        'limit_exists',
        'This wallet already has a USDC limit. Revoke it first; a new one can be set once Base shows it revoked.',
        { permissionId: open.permission_id, state: apiState(open.state) },
      );
  }

  /** The permission the server would build for these settings (start and salt from the request). */
  function build(
    wallet: WalletRow,
    cap: bigint,
    period: LimitPeriod,
    start: number,
    salt: bigint,
  ): SpendPermission {
    return {
      account: getAddress(wallet.address),
      spender: getAddress(wallet.spender_address),
      token: getAddress(usdc.address),
      allowance: onchainAllowance(cap, deps.model),
      period: LIMIT_PERIOD_SECONDS[period],
      start,
      end: LIMIT_PERMISSION_END,
      salt,
      extraData: '0x',
    };
  }

  function capFrom(capRaw: string): bigint {
    const cap = BigInt(capRaw);
    if (cap > MAX_UINT160) throw new LimitError(400, 'invalid_cap', 'The cap is too large.');
    if (onchainAllowance(cap, deps.model) < 1n)
      throw new LimitError(
        400,
        'invalid_cap',
        'The cap is too small: Base needs an allowance of at least one unit per period.',
      );
    return cap;
  }

  const limitSummary = (row: LimitRow) => {
    const permission = stored(row);
    return {
      permissionId: row.permission_id,
      token: 'USDC' as const,
      capRaw: row.cap_raw,
      capDisplay: display(BigInt(row.cap_raw)),
      onchainModel: row.onchain_model,
      allowanceRaw: permission.allowance.toString(10),
      allowanceDisplay: display(permission.allowance),
      // Around a reset Base allows one period's allowance just before it and one just after.
      boundaryBurstRaw: (permission.allowance * 2n).toString(10),
      period: row.period_kind,
      periodSeconds: permission.period,
      permissionHash: row.permission_hash,
      state: apiState(row.state),
      createdAt: Number(row.created_at),
    };
  };

  function revokeView(row: LimitRow, op: StoredOperation | null | undefined) {
    if (row.state !== 'revoke_pending' && row.state !== 'revoked') return null;
    if (row.state === 'revoked')
      return {
        state: 'final' as RevokeState,
        revokedAt: Number(row.revoked_at),
        revokedAtBlock: Number(row.revoked_block),
        userOpHash: row.revoke_user_op_hash,
        txHash: op?.txHash ?? null,
      };
    if (row.revoke_op_key)
      return {
        state: revokeStateOf(op ?? null),
        userOpHash: row.revoke_user_op_hash,
        txHash: op?.txHash ?? null,
        expiresAt: null,
      };
    const expiresAt = row.revoke_expires_at === null ? null : Number(row.revoke_expires_at);
    return {
      state: (row.revoke_operation && expiresAt !== null && expiresAt > now()
        ? 'awaiting_signature'
        : 'expired') as RevokeState,
      userOpHash: row.revoke_user_op_hash,
      txHash: null,
      expiresAt,
    };
  }

  function signingRequest(wallet: WalletRow, row: LimitRow) {
    const op = fromJson(JSON.stringify(row.revoke_operation));
    const permission = stored(row);
    return {
      permissionId: row.permission_id,
      state: apiState(row.state),
      revokeState: 'awaiting_signature' as const,
      chainId: deps.chainId,
      entryPoint: network.contracts.entryPointV06,
      userOperation: toRpc(op),
      userOpHash: row.revoke_user_op_hash,
      expiresAt: Number(row.revoke_expires_at),
      summary: {
        action: 'revoke_limit' as const,
        wallet: getAddress(wallet.address),
        contract: network.contracts.spendPermissionManager,
        permissionHash: row.permission_hash,
        token: 'USDC' as const,
        capRaw: row.cap_raw,
        allowanceRaw: permission.allowance.toString(10),
        period: row.period_kind,
        // An undeployed wallet is deployed by this operation (the signature is usable either way).
        deploysWallet: (op.initCode ?? '0x') !== '0x',
      },
    };
  }

  async function operations(): Promise<OwnerRevokePort> {
    try {
      if (!deps.operations) throw new Error('unconfigured');
      return await deps.operations();
    } catch {
      throw new LimitError(503, 'network_unavailable', 'Base is not available right now.');
    }
  }

  function chainFailure(error: unknown): never {
    if (error instanceof OwnerRevokeError) {
      if (error.code === 'FEE_CAP')
        throw new LimitError(503, 'fee_cap', 'Network fees are too high right now. Try later.');
      if (error.code === 'NOT_SPONSORED')
        throw new LimitError(503, 'not_sponsored', 'The network fee is not covered right now.');
      if (error.code === 'SIGNATURE_MISMATCH')
        throw new LimitError(
          422,
          'signature_mismatch',
          'Not signed by the owner key of this wallet.',
        );
      if (error.code === 'OUTDATED')
        throw new LimitError(409, 'operation_outdated', 'The wallet changed. Revoke again.');
      if (error.code === 'WALLET_MISMATCH')
        throw new LimitError(409, 'wallet_mismatch', 'This wallet cannot be operated here.');
    }
    throw new LimitError(503, 'network_unavailable', 'Base is not available right now.');
  }

  async function refreshOp(key: string): Promise<StoredOperation | null> {
    try {
      return await (await operations()).refresh(key);
    } catch {
      return null;
    }
  }

  /** The stored revoke operation's paymasterAndData, when it has one. */
  function revokeSponsorData(row: LimitRow): string | undefined {
    const data = row.revoke_operation?.paymasterAndData;
    return typeof data === 'string' ? data : undefined;
  }

  /** What is sent for a signed revoke: the stored operation with the owner's stored signature. */
  function submission(wallet: WalletRow, row: LimitRow, signature: Hex) {
    const userOpHash = row.revoke_user_op_hash as Hex;
    return {
      idempotencyKey: revokeKey(row),
      intentHash: keccak256(
        stringToHex(
          `cc.base.wallet.limit-revoke.v1:${deps.chainId}:${getAddress(wallet.address)}:${row.permission_hash}:${userOpHash.toLowerCase()}`,
        ),
      ),
      wallet: getAddress(wallet.address),
      recipe: recipeOf(wallet),
      calls: [revokeCall(deps.chainId, stored(row))],
      operation: fromJson(JSON.stringify(row.revoke_operation)),
      userOpHash,
      owner: getAddress(wallet.owner_address),
      signature,
    };
  }

  /** The owner's signature stored for this attempt (never part of a view), or null. */
  async function signatureOf(row: LimitRow): Promise<Hex | null> {
    const { rows } = await deps.db.query<{ revoke_signature: Uint8Array | null }>(
      `SELECT revoke_signature FROM base_spend_permissions
       WHERE permission_id = $1 AND revoke_attempt = $2 AND revoke_op_key = $3`,
      [row.permission_id, row.revoke_attempt, row.revoke_op_key],
    );
    const bytes = rows[0]?.revoke_signature;
    return bytes ? (`0x${Buffer.from(bytes).toString('hex')}` as Hex) : null;
  }

  /** Marks, once, that the signed revoke was handed to the chain module, with its audit event. */
  async function markSubmitted(
    wallet: WalletRow,
    accountId: string,
    row: LimitRow,
    op: StoredOperation,
  ) {
    if (row.revoke_submitted_at !== null) return;
    await deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ permission_id: string }>(
        `UPDATE base_spend_permissions SET revoke_submitted_at = $2
         WHERE permission_id = $1 AND revoke_attempt = $3 AND revoke_op_key = $4
           AND revoke_submitted_at IS NULL
         RETURNING permission_id`,
        [row.permission_id, now(), row.revoke_attempt, row.revoke_op_key],
      );
      if (rows[0])
        await audit(tx, wallet, accountId, 'limit_revoke_submitted', {
          permissionId: row.permission_id,
          userOpHash: row.revoke_user_op_hash,
          attempt: row.revoke_attempt,
          status: op.status,
        });
    });
  }

  /**
   * A signed attempt that can never land (the wallet moved past it, or it is not this wallet's):
   * its link is cleared so the next revoke prepares a fresh operation.
   */
  async function clearLink(row: LimitRow) {
    await deps.db.query(
      `UPDATE base_spend_permissions SET revoke_op_key = NULL, revoke_signature = NULL,
         revoke_expires_at = $2, updated_at = $2
       WHERE permission_id = $1 AND revoke_attempt = $3 AND revoke_submitted_at IS NULL`,
      [row.permission_id, now(), row.revoke_attempt],
    );
  }

  /**
   * The chain operation of a signed revoke, brought up to date. Signed and linked here but never
   * stored by the chain module (a stop in between, or Base unreachable when it was signed): sent
   * now, exactly as signed. Stored there but never claimed for its first send (a stop or a
   * database error between that store and the claim): resumed the same way, since refresh never
   * sends a queued operation; submit's compare-and-set claim lets exactly one worker send it.
   * Null when the chain cannot be reached; the next read tries again.
   */
  async function follow(
    wallet: WalletRow,
    accountId: string,
    row: LimitRow,
  ): Promise<StoredOperation | null> {
    if (!row.revoke_op_key) return null;
    let op = await refreshOp(row.revoke_op_key);
    if (!op || op.status === 'queued') {
      const signature = await signatureOf(row);
      if (!signature) return op;
      try {
        op = await (await operations()).submit(submission(wallet, row, signature));
      } catch (error) {
        if (
          error instanceof OwnerRevokeError &&
          (error.code === 'OUTDATED' || error.code === 'WALLET_MISMATCH')
        )
          await clearLink(row);
        return op;
      }
    }
    await markSubmitted(wallet, accountId, row, op);
    return op;
  }

  return {
    async list(accountId: string, agentId: string) {
      const wallet = await walletOf(accountId, agentId);
      let rows = await limitsOf(wallet);
      // Revokes on their way: their operations are reconciled, and a signed one the chain module
      // never stored is sent now, exactly as signed.
      const ops = new Map<string, StoredOperation | null>();
      for (const row of rows)
        if (row.state === 'revoke_pending' && row.revoke_op_key)
          ops.set(row.permission_id, await follow(wallet, accountId, row));
      // Following may have marked one handed over, or cleared one that can never land.
      if (ops.size) rows = await limitsOf(wallet);

      // Base's view of every listed limit, at one block.
      let read: Awaited<ReturnType<PermissionReader['read']>> | null = null;
      if (deps.permissions && rows.length)
        try {
          read = await deps.permissions.read(rows.map(stored));
        } catch {
          read = null;
        }
      const readAt = read ? now() : null;
      const chainState = new Map<string, PermissionChainState>();
      if (read)
        for (const [i, row] of rows.entries())
          chainState.set(row.permission_id, read.permissions[i]);

      // A revocation is concluded only from a settled read.
      const candidates = rows.filter(
        (row) =>
          row.state === 'revoke_pending' ||
          (row.state !== 'revoked' && chainState.get(row.permission_id)?.revoked === true),
      );
      if ((await proveRevoked(wallet, candidates, accountId)).size) rows = await limitsOf(wallet);

      const nowMs = now();
      const limits = [];
      for (const row of rows) {
        const permission = stored(row);
        const cap = BigInt(row.cap_raw);
        const usable = row.state === 'signed' || row.state === 'onchain';
        const window = calendarPeriod(row.period_kind, nowMs);
        const spent = await calendarSpent(deps.db, {
          walletId: wallet.wallet_id,
          token: usdc.address,
          window,
        });
        const state = chainState.get(row.permission_id);
        const spend = state?.current?.spend ?? 0n;
        const left =
          state?.current && !state.revoked && permission.allowance > spend
            ? permission.allowance - spend
            : 0n;
        limits.push({
          ...limitSummary(row),
          onchain:
            state && read
              ? {
                  start: permission.start,
                  end: permission.end,
                  currentPeriodStart: state.current?.start ?? null,
                  currentPeriodEnd: state.current?.end ?? null,
                  spentRaw: spend.toString(10),
                  leftRaw: left.toString(10),
                  readAtBlock: Number(read.blockNumber),
                  blockTime: read.blockTimestamp,
                  phase: state.phase,
                  approved: state.approved,
                  revoked: state.revoked,
                }
              : null,
          calendar: {
            periodStart: window.start,
            periodEnd: window.end,
            spentRaw: spent.toString(10),
            leftRaw: (usable && cap > spent ? cap - spent : 0n).toString(10),
            timeZone: LIMIT_TIME_ZONE,
          },
          revoke: revokeView(row, ops.get(row.permission_id)),
        });
      }
      return {
        chainId: deps.chainId,
        network: network.name,
        testnet: deps.chainId !== BASE_MAINNET,
        // The model a new limit gets now; each limit carries the one it was signed with.
        onchainModel: deps.model,
        stale: rows.length > 0 && read === null,
        readAtBlock: read ? Number(read.blockNumber) : null,
        readAt,
        limits,
      };
    },

    async prepare(accountId: string, agentId: string, body: unknown) {
      const parsed = prepareBody.safeParse(body ?? {});
      if (!parsed.success)
        throw new LimitError(400, 'invalid_limit', 'Send capRaw (USDC base units) and a period.');
      const wallet = await walletOf(accountId, agentId);
      requireBackup(wallet);
      const cap = capFrom(parsed.data.capRaw);
      await requireNoActiveLimit(wallet, accountId);
      // The start of today in Berlin: the first on-chain period is the current one, so the limit
      // can be used as soon as it is stored. Later periods keep their fixed lengths.
      const permission = build(
        wallet,
        cap,
        parsed.data.period,
        berlinDayStart(now()),
        BigInt(`0x${randomBytes(32).toString('hex')}`),
      );
      checkPermission(permission);
      const hash = spendPermissionHash(deps.chainId, permission);
      return {
        chainId: deps.chainId,
        token: 'USDC' as const,
        capRaw: cap.toString(10),
        capDisplay: display(cap),
        onchainModel: deps.model,
        allowanceRaw: permission.allowance.toString(10),
        allowanceDisplay: display(permission.allowance),
        boundaryBurstRaw: (permission.allowance * 2n).toString(10),
        period: parsed.data.period,
        periodSeconds: permission.period,
        permission: permissionToJson(permission),
        permissionHash: hash,
        typedData: ownerTypedData(deps.chainId, permission.account, hash),
        expiresAt: now() + LIMIT_SIGNATURE_TTL_MS,
      };
    },

    async store(accountId: string, agentId: string, body: unknown) {
      const parsed = storeBody.safeParse(body ?? {});
      if (!parsed.success)
        throw new LimitError(
          400,
          'invalid_limit',
          'Send the prepared permission, capRaw, period and the signature.',
        );
      const permission = permissionFromJson(parsed.data.permission);
      if (!permission)
        throw new LimitError(400, 'invalid_limit', 'The permission is not well formed.');
      const wallet = await walletOf(accountId, agentId);
      requireBackup(wallet);
      const cap = capFrom(parsed.data.capRaw);
      const period = parsed.data.period;

      // Rebuild what prepare would have built and compare every field: only the start (the start
      // of the Berlin day it was prepared on, within the signing window: prepared just before
      // midnight and stored just after, it is the previous day's) and the salt come from the
      // request.
      const at = now();
      const starts = [berlinDayStart(at), berlinDayStart(at - LIMIT_SIGNATURE_TTL_MS)];
      const expected = build(wallet, cap, period, permission.start, permission.salt);
      const same =
        starts.includes(permission.start) &&
        (Object.keys(expected) as (keyof SpendPermission)[]).every(
          (key) => String(expected[key]).toLowerCase() === String(permission[key]).toLowerCase(),
        );
      if (!same)
        throw new LimitError(
          422,
          'permission_mismatch',
          'This is not the limit Central City prepared. Prepare it again.',
        );
      checkPermission(permission);

      const hash = spendPermissionHash(deps.chainId, permission);
      let signer: Address | null = null;
      try {
        signer = getAddress(
          await recoverTypedDataAddress({
            ...ownerTypedData(deps.chainId, permission.account, hash),
            signature: parsed.data.signature as Hex,
          }),
        );
      } catch {
        signer = null;
      }
      if (signer !== getAddress(wallet.owner_address))
        throw new LimitError(
          422,
          'signature_mismatch',
          'Not signed by the owner key of this wallet.',
        );

      // The same signed limit sent again (a retry): answered with the stored one.
      const replayed = await deps.db.query<LimitRow>(
        `SELECT ${COLUMNS} FROM base_spend_permissions
         WHERE chain_id = $1 AND permission_hash = $2 AND wallet_id = $3`,
        [deps.chainId, hash.toLowerCase(), wallet.wallet_id],
      );
      if (replayed.rows[0])
        return { ...limitSummary(replayed.rows[0]), start: permission.start, end: permission.end };

      await requireNoActiveLimit(wallet, accountId);

      // ERC-6492 while the wallet has no code, so SpendPermissionManager can deploy it while
      // approving; when Base cannot tell right now, wrapping is the choice that works either way.
      let deployed = wallet.state === 'deployed';
      if (!deployed && deps.permissions)
        deployed = await deps.permissions.deployed(getAddress(wallet.address)).catch(() => false);
      const signature = walletSignature(parsed.data.signature as Hex, {
        ownerIndex: 0,
        undeployedRecipe: deployed ? undefined : recipeOf(wallet),
      });

      const permissionId = randomUUID();
      const row = await deps.db
        .transaction(async (tx) => {
          await tx.query('SELECT 1 FROM base_wallets WHERE wallet_id = $1 FOR UPDATE', [
            wallet.wallet_id,
          ]);
          const replay = await tx.query<LimitRow>(
            `SELECT ${COLUMNS} FROM base_spend_permissions
             WHERE chain_id = $1 AND permission_hash = $2`,
            [deps.chainId, hash.toLowerCase()],
          );
          // The same signed limit sent again: answered with the stored one.
          if (replay.rows[0]) {
            if (replay.rows[0].wallet_id !== wallet.wallet_id)
              throw new LimitError(409, 'limit_exists', 'This limit is stored elsewhere.');
            return replay.rows[0];
          }
          const open = await tx.query<{ permission_id: string; state: DbState }>(
            `SELECT permission_id, state FROM base_spend_permissions
             WHERE wallet_id = $1 AND token = $2 AND state <> 'revoked'`,
            [wallet.wallet_id, usdc.address.toLowerCase()],
          );
          if (open.rows[0])
            throw new LimitError(409, 'limit_exists', 'This wallet already has a USDC limit.', {
              permissionId: open.rows[0].permission_id,
              state: apiState(open.rows[0].state),
            });
          const { rows } = await tx.query<LimitRow>(
            `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission,
               signature, state, token, permission_hash, period_kind, cap_raw, onchain_model,
               owner_account_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'signed',$6,$7,$8,$9,$10,$11,$12,$12)
             RETURNING ${COLUMNS}`,
            [
              permissionId,
              wallet.wallet_id,
              deps.chainId,
              JSON.stringify(permissionToJson(permission)),
              Buffer.from(signature.slice(2), 'hex'),
              usdc.address.toLowerCase(),
              hash.toLowerCase(),
              period,
              cap.toString(10),
              deps.model,
              accountId,
              at,
            ],
          );
          await audit(tx, wallet, accountId, 'limit_signed', {
            permissionId,
            permissionHash: hash,
            token: 'USDC',
            capRaw: cap.toString(10),
            allowanceRaw: permission.allowance.toString(10),
            period,
            onchainModel: deps.model,
            start: permission.start,
            erc6492: !deployed,
          });
          return rows[0];
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error))
            throw new LimitError(409, 'limit_exists', 'This wallet already has a USDC limit.');
          throw error;
        });
      return {
        ...limitSummary(row),
        start: permission.start,
        end: permission.end,
      };
    },

    async revoke(accountId: string, agentId: string, permissionId: string, body: unknown) {
      if (!emptyBody.safeParse(body ?? {}).success)
        throw new LimitError(400, 'invalid_body', 'A revoke takes no settings.');
      const wallet = await walletOf(accountId, agentId);
      let row = await limitOf(wallet, permissionId);
      if (row.state === 'revoked')
        throw new LimitError(409, 'already_revoked', 'This limit is already revoked.');

      // 1. The agent can no longer spend with it, from now on (payments read only signed/onchain).
      if (row.state === 'signed' || row.state === 'onchain')
        row = await deps.db.transaction(async (tx) => {
          const { rows } = await tx.query<LimitRow>(
            `UPDATE base_spend_permissions SET state = 'revoke_pending', revoke_requested_at = $2,
               updated_at = $2
             WHERE permission_id = $1 AND state IN ('signed','onchain') RETURNING ${COLUMNS}`,
            [row.permission_id, now()],
          );
          if (rows[0])
            await audit(tx, wallet, accountId, 'limit_revoke_requested', {
              permissionId: row.permission_id,
              permissionHash: row.permission_hash,
            });
          return rows[0] ?? (await limitOf(wallet, permissionId));
        });

      // 2. Already revoked on Base (an earlier operation, or elsewhere): nothing to sign.
      if ((await proveRevoked(wallet, [row], accountId)).has(row.permission_id))
        return { ...limitSummary(await limitOf(wallet, permissionId)), revokeState: 'final' };

      // 3. A signed revoke still on its way (sent again if it never reached the chain module), or
      // an unsigned one still valid: no new operation.
      if (row.revoke_op_key) {
        const op = await follow(wallet, accountId, row);
        row = await limitOf(wallet, permissionId);
        if (row.revoke_op_key && op?.status !== 'failed')
          throw new LimitError(409, 'revoke_in_progress', 'The revoke is on its way to Base.', {
            revoke: revokeView(row, op),
          });
      }
      // (A linked one that failed on Base, its nonce used by another owner operation: a new attempt.)
      // An unsigned one whose sponsorship is ending is not handed out again: a new one is prepared.
      if (
        !row.revoke_op_key &&
        row.revoke_operation &&
        row.revoke_expires_at !== null &&
        Number(row.revoke_expires_at) > now() &&
        !sponsorshipEnding(revokeSponsorData(row), now())
      )
        return signingRequest(wallet, row);

      // 4. A new revoke operation for the owner to sign.
      const ops = await operations();
      let prepared: PreparedOwnerOperation;
      try {
        prepared = await ops.prepare({
          wallet: getAddress(wallet.address),
          recipe: recipeOf(wallet),
          calls: [revokeCall(deps.chainId, stored(row))],
        });
      } catch (error) {
        chainFailure(error);
      }
      const updated = await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<LimitRow>(
          `UPDATE base_spend_permissions SET revoke_operation = $2, revoke_user_op_hash = $3,
             revoke_expires_at = $4, revoke_attempt = revoke_attempt + 1, revoke_op_key = NULL,
             revoke_signature = NULL, revoke_submitted_at = NULL, updated_at = $5
           WHERE permission_id = $1 AND state = 'revoke_pending' AND revoke_attempt = $6
           RETURNING ${COLUMNS}`,
          [
            row.permission_id,
            JSON.stringify(opJson(prepared.operation)),
            prepared.userOpHash.toLowerCase(),
            now() + LIMIT_SIGNATURE_TTL_MS,
            now(),
            row.revoke_attempt,
          ],
        );
        if (rows[0])
          await audit(tx, wallet, accountId, 'limit_revoke_prepared', {
            permissionId: row.permission_id,
            userOpHash: prepared.userOpHash,
            attempt: rows[0].revoke_attempt,
          });
        return rows[0] ?? null;
      });
      // Another request prepared or signed one meanwhile.
      if (!updated)
        throw new LimitError(409, 'revoke_in_progress', 'A revoke was just prepared. Reload.');
      return signingRequest(wallet, updated);
    },

    async signRevoke(accountId: string, agentId: string, permissionId: string, body: unknown) {
      const parsed = signatureBody.safeParse(body ?? {});
      if (!parsed.success)
        throw new LimitError(400, 'invalid_signature', 'Send the 65-byte signature.');
      const wallet = await walletOf(accountId, agentId);
      const row = await limitOf(wallet, permissionId);
      if (row.state === 'revoked')
        throw new LimitError(409, 'already_revoked', 'This limit is already revoked.');
      if (row.state !== 'revoke_pending' || !row.revoke_operation || !row.revoke_user_op_hash)
        throw new LimitError(409, 'nothing_to_sign', 'Revoke the limit first.');
      const key = revokeKey(row);
      const signature = parsed.data.signature as Hex;
      const owner = getAddress(wallet.owner_address);
      const userOpHash = row.revoke_user_op_hash as Hex;
      if (
        row.revoke_op_key !== key &&
        (Number(row.revoke_expires_at) <= now() || sponsorshipEnding(revokeSponsorData(row), now()))
      )
        throw new LimitError(
          410,
          'expired',
          'This revoke expired before it was signed. Revoke again.',
        );
      if ((await rawSigner(userOpHash, signature)) !== owner)
        throw new LimitError(
          422,
          'signature_mismatch',
          'Not signed by the owner key of this wallet.',
        );

      // 1. Durably linked BEFORE anything is sent: the owner's signature and the chain operation's
      // key. A stop after this point resumes this same signed operation (follow); it is never
      // re-prepared and never needs a new signature. The same signature sent again is a no-op.
      const linked = await deps.db.transaction(async (tx) => {
        const { rows } = await tx.query<LimitRow>(
          `UPDATE base_spend_permissions SET revoke_op_key = $2, revoke_signature = $3,
             updated_at = $4
           WHERE permission_id = $1 AND state = 'revoke_pending' AND revoke_attempt = $5
             AND revoke_op_key IS NULL
           RETURNING ${COLUMNS}`,
          [row.permission_id, key, hexToBytes(signature), now(), row.revoke_attempt],
        );
        if (rows[0])
          await audit(tx, wallet, accountId, 'limit_revoke_signed', {
            permissionId: row.permission_id,
            userOpHash,
            attempt: row.revoke_attempt,
          });
        return rows[0] ?? null;
      });
      const current = linked ?? (await limitOf(wallet, permissionId));
      if (current.revoke_attempt !== row.revoke_attempt || current.revoke_op_key !== key)
        throw new LimitError(409, 'revoke_in_progress', 'A revoke was just prepared. Reload.');

      // 2. Sent, with the signature stored first (a repeated request sends the stored one).
      const stamped = (await signatureOf(current)) ?? signature;
      let op: StoredOperation;
      try {
        op = await (await operations()).submit(submission(wallet, current, stamped));
      } catch (error) {
        // An operation that can never land is unlinked, so the next revoke prepares a fresh one;
        // anything else keeps the link and the next read sends it again, exactly as signed.
        if (
          error instanceof OwnerRevokeError &&
          (error.code === 'OUTDATED' || error.code === 'WALLET_MISMATCH')
        )
          await clearLink(current);
        chainFailure(error);
      }
      await markSubmitted(wallet, accountId, current, op);
      return {
        permissionId: row.permission_id,
        state: 'revoke_pending' as LimitState,
        revoke: { state: revokeStateOf(op), userOpHash, txHash: op.txHash },
      };
    },
  };
}

export type LimitService = ReturnType<typeof createLimitService>;
