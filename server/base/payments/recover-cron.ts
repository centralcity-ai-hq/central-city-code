/*
 * Payment recovery cron (every minute): the schedule of the payment chain's recover()
 * (chain/payment-chain.ts), the durable owner of agent payments whose process died mid-submit.
 *
 * Each run has two parts, both past the same grace period:
 *
 *   1. Held payment reservations: recover()'s keyset pages from the oldest, until a page says
 *      there is no next one. It runs first and starts no new page after its own share of the
 *      budget (60 %), so the payments part can never starve it and always gets the rest.
 *   2. Payments left open by a dead process: agent transfers still settling or reconciling whose
 *      key holds no reservation (excluded in the query itself: a key still held belongs to part 1,
 *      so an unresolved held prefix can never fill this part's pages). Their key is fenced with
 *      the tombstone (insert-if-absent, chain.endUnsent):
 *        - the key provably never sent (cut off between store.begin() and chain.submit(), maybe
 *          read meanwhile, which moved it settling → reconciling): the row is ended by a
 *          compare-and-set settling/reconciling → failed;
 *        - a real operation won the key (sent, its worker died before recording the outcome): the
 *          row is brought up to date exactly as city_pay_status does (chain.status, then the
 *          store's observe from the canonical operation): paid or failed as the chain proves, or
 *          reconciling while it is still on its way;
 *        - the key belongs to another intent: left alone.
 *      A row a live worker moved on meanwhile is never undone: the compare-and-set and observe's
 *      locked update see its state, and a real operation is never fenced.
 *      Part 2 walks the oldest last change first and needs no stored cursor: every row it looks at
 *      leaves the stale list, resolved, observed (observe stamps it) or, when it could not be
 *      resolved (another intent, an error), stamped by a compare-and-set on its last change, so it
 *      goes to the back of the line for one grace period. The next page and the next run go on
 *      with rows not yet looked at, never the same unresolved prefix.
 *
 * Both stop starting new pages once their budget is spent. recover() orders by the reservation's
 * creation, which never changes, so part 1 keeps its place across runs (base_cron_cursors,
 * migration 98): the next run resumes after the last page this one looked at, and a walk that
 * reaches the end wraps to the oldest once, up to where the run began. A slow or unresolved first
 * page can never hide later held reservations from every run.
 *
 * It never signs and never builds an operation: recover() only fences a key that never got an
 * operation, expires one never authorized, releases what provably never went out, and reconciles
 * and settles what was sent (at most re-sending the stored operation, same hash), and part 2 does
 * the same through chain.status(). The payment chain is built with an authority check that refuses
 * everything, so even a first broadcast could never pass through it.
 *
 * The route exists whenever CRON_SECRET is set, independent of CITY_BASE_WALLET and
 * CITY_BASE_AGENT_PAY: turning agent payments off stops new payments, while payments started
 * earlier still settle or are released here. Without anything past the grace period no chain
 * runtime is built at all; with something and no payment chain configured the run answers 503.
 *
 * Two runs at once (a slow run overlapping the next firing) are harmless, so no lock is taken:
 * every write either part makes is a compare-and-set, an insert-if-absent or observe's locked
 * update (the tombstone, the → failed end, the queued → failed expiry, the operation's status
 * moves), and the reservation ledger locks the reservation row and treats a repeated release or
 * consume as done. Overlapping runs can only read the same rows twice, re-send the same stored
 * operation twice, and both count a row as checked; a payment is counted as ended only by the run
 * whose compare-and-set won.
 *
 * Fails closed: without the bearer secret the route answers 404, exactly like an unknown path.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import {
  RECOVERY_GRACE_MS,
  type PaymentChainPort,
  type RecoveryCursor,
} from '../chain/payment-chain.js';
import { readPaymentReceipt } from '../chain/payment-receipt.js';
import type { Address, BaseChainId } from '../../../shared/base/chains.js';
import type { Hex } from '../../../shared/base/types.js';
import { cronAuthorized } from '../../wake/cron.js';
import { intentFor, paymentOperationKey } from './service.js';
import { createPaymentIntentStore, type PaymentReceiptReader } from './store.js';

export const PAY_RECOVER_PATH = '/api/cron/base-pay-recover';
/** Rows per page: held reservations per recover() page, open payments per part-2 page. */
export const PAY_RECOVER_PAGE = 25;
/**
 * A run starts no new page after this long (as the identity finalize cron's deadline), well inside
 * the function's maxDuration of 300 s. A page is never cut short (rows are resolved one by one), so
 * a slow node can stretch a run by one page; a run stopped by the platform loses nothing, since
 * each row's writes are atomic and the next run starts again from the oldest.
 */
export const PAY_RECOVER_BUDGET_MS = 45_000;
/**
 * Part 1's share (60 % of the budget): it starts no new page after this long, so part 2 always
 * gets the rest of the budget, and at least one page however long part 1 took.
 */
export const PAY_RECOVER_HELD_SHARE_MS = 27_000;

export interface PaymentRecoveryRun {
  checked: number;
  /** Payments whose key provably never sent, ended as failed. */
  ended: number;
  /** Payments whose operation was sent, recorded as paid or failed as the chain proves. */
  finished: number;
  abandoned: number;
  expired: number;
  released: number;
  settled: number;
  errors: number;
  /** recover() pages walked (held reservations). */
  pages: number;
  /** Both parts were walked to their end within the budget. */
  complete: boolean;
}

/** Where a part-2 page continues within a run: the last payment of the previous page. */
interface PaymentCursor {
  updatedAt: string;
  paymentId: string;
}

interface OpenPayment {
  payment_id: string;
  operator_id: string;
  actor_id: string;
  source_ref: string;
  idempotency_key: string;
  intent_hash: string;
  token_address: string;
  recipient_address: string;
  amount: string;
  state: string;
  updated_at: string;
}

/** The states a dead process can leave an agent payment in. */
const OPEN = `('settling','reconciling')`;
/**
 * A payment's operation key in SQL, exactly as payments/service.ts paymentOperationKey computes it:
 * 'payment:' + sha256 of the JSON array [operator, chain, idempotency key]. Operator ids and keys
 * are restricted identifiers ([A-Za-z0-9_.:-], checked by intentFor before any row is stored), so
 * the JSON needs no escaping.
 */
const OPERATION_KEY_SQL = `'payment:0x' || encode(sha256(convert_to('["' || p.operator_id || '",'
  || p.chain_id::text || ',"' || p.idempotency_key || '"]', 'UTF8')), 'hex')`;
/**
 * Agent transfers still open, untouched since before the cutoff, whose key holds no reservation
 * (those belong to part 1).
 */
const STALE_OPEN = `p.chain_id = $1 AND p.state IN ${OPEN} AND p.kind = 'transfer'
  AND p.source_kind = 'agent' AND p.updated_at < $2
  AND NOT EXISTS (SELECT 1 FROM base_wallet_reservations r WHERE r.holder_kind = 'payment'
    AND r.state = 'held' AND r.chain_id = $1 AND r.holder_ref = ${OPERATION_KEY_SQL})`;

export function registerPaymentRecoveryCron(
  app: FastifyInstance,
  deps: {
    db: Database;
    /** The wallet network: the one network agent payments reserve on. */
    chainId: number;
    /**
     * The wallet network's agent payment chain (chain/runtime.ts agentPayments); throws when it is
     * not configured.
     */
    chain(): Promise<PaymentChainPort>;
    /** Enables the cron (Vercel Cron's bearer secret); without it the route is absent. */
    cronSecret?: string;
    /** The deployment's settings, for Base's own gate when a payment's intent is rebuilt. */
    env?: Record<string, string | undefined>;
    /** The canonical receipt reader (chain/payment-receipt.ts by default). */
    readPaymentReceipt?: PaymentReceiptReader;
    now?: () => number;
  },
) {
  const cronSecret = deps.cronSecret;
  if (cronSecret === undefined) return;
  const clock = deps.now ?? Date.now;
  const store = createPaymentIntentStore({
    db: deps.db,
    readPaymentReceipt: deps.readPaymentReceipt ?? readPaymentReceipt,
    env: deps.env,
    now: clock,
  });

  /**
   * Part 2 for one payment: what this run did with it. 'observed': brought up to date and stamped
   * by observe, still on its way; null: left as it was (another intent, or a compare-and-set lost).
   */
  async function resolveOpen(
    chain: PaymentChainPort,
    row: OpenPayment,
  ): Promise<'ended' | 'finished' | 'observed' | null> {
    const operationKey = paymentOperationKey(row.operator_id, deps.chainId, row.idempotency_key);
    const outcome = await chain.endUnsent({ operationKey, intentHash: row.intent_hash as Hex });
    if (outcome === 'unsent') {
      // Compare-and-set: a live worker that moved the payment on meanwhile is never undone.
      const { rows: ended } = await deps.db.query(
        `UPDATE base_payments SET state = 'failed', settle_op_id = COALESCE(settle_op_id, $2),
           version = version + 1, updated_at = $3
         WHERE payment_id = $1 AND state IN ${OPEN} RETURNING payment_id`,
        [row.payment_id, operationKey, clock()],
      );
      return ended.length ? 'ended' : null;
    }
    if (outcome !== 'stored') return null;
    // Sent: rebuilt from the row (any change refuses as an idempotency conflict) and brought up to
    // date as city_pay_status does; reconciling only reads and re-sends the stored operation.
    const intent = intentFor(
      { workspaceId: row.operator_id, actorId: row.actor_id },
      {
        chainId: deps.chainId as BaseChainId,
        source: { agentId: row.source_ref },
        to: row.recipient_address as Address,
        token: row.token_address as Address,
        amount: BigInt(row.amount),
        idempotencyKey: row.idempotency_key,
      },
      deps.env,
    );
    if (intent.intentHash !== row.intent_hash || intent.operationKey !== operationKey) return null;
    const record = await store.observe(intent, await chain.status(intent));
    return record.state === 'paid' || record.state === 'failed' ? 'finished' : 'observed';
  }

  /**
   * A row part 2 could not resolve goes to the back of the line for one grace period: its last
   * change is stamped by a compare-and-set on the value read, so a row anyone changed meanwhile is
   * not touched. Nothing else about the payment changes.
   */
  async function sendToBack(row: OpenPayment) {
    await deps.db.query(
      `UPDATE base_payments SET updated_at = $3
       WHERE payment_id = $1 AND updated_at = $2::bigint AND state IN ${OPEN}`,
      [row.payment_id, row.updated_at, clock()],
    );
  }

  /** Part 1's continuation for this network (migration 98), shared by every run. */
  const cursorName = `base-pay-recover:${deps.chainId}`;
  async function loadCursor(): Promise<RecoveryCursor | null> {
    const { rows } = await deps.db.query<{ cursor: unknown }>(
      'SELECT cursor FROM base_cron_cursors WHERE name = $1',
      [cursorName],
    );
    const raw = rows[0]?.cursor;
    const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<RecoveryCursor>;
    // Anything unexpected restarts the walk at the oldest; it never stops the run.
    return value &&
      typeof value.createdAt === 'string' &&
      /^-?[0-9]{1,19}$/.test(value.createdAt) &&
      typeof value.reservationId === 'string' &&
      value.reservationId.length <= 200
      ? { createdAt: value.createdAt, reservationId: value.reservationId }
      : null;
  }
  /** Overlapping runs may both write; the last one wins, and either cursor is a valid place. */
  async function saveCursor(cursor: RecoveryCursor | null) {
    if (!cursor) {
      await deps.db.query('DELETE FROM base_cron_cursors WHERE name = $1', [cursorName]);
      return;
    }
    await deps.db.query(
      `INSERT INTO base_cron_cursors (name, cursor, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
      [cursorName, JSON.stringify(cursor), clock()],
    );
  }
  /** recover()'s keyset order: (created_at, reservation_id). */
  const before = (a: RecoveryCursor, b: RecoveryCursor) =>
    BigInt(a.createdAt) < BigInt(b.createdAt) ||
    (a.createdAt === b.createdAt && a.reservationId < b.reservationId);

  app.get(PAY_RECOVER_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const started = clock();
    // One grace cutoff for the whole run: the same `now` on every page of both parts.
    const cutoff = started - RECOVERY_GRACE_MS;
    const run: PaymentRecoveryRun = {
      checked: 0,
      ended: 0,
      finished: 0,
      abandoned: 0,
      expired: 0,
      released: 0,
      settled: 0,
      errors: 0,
      pages: 0,
      complete: false,
    };
    // Nothing past the grace period: no chain runtime is built (most runs end here).
    const { rows: work } = await deps.db.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM base_wallet_reservations
           WHERE holder_kind = 'payment' AND state = 'held' AND chain_id = $1 AND created_at < $2)
         OR EXISTS (SELECT 1 FROM base_payments p WHERE ${STALE_OPEN})`,
      [deps.chainId, cutoff],
    );
    if (!work.length) return { ...run, complete: true };
    let chain: PaymentChainPort;
    try {
      chain = await deps.chain();
    } catch {
      return reply.code(503).send({ error: 'Payment recovery is not available.' });
    }

    // Part 1: held payment reservations (recover()), within its own share, resumed where the
    // previous run stopped. Reaching the end wraps to the oldest once, up to where this run began.
    const start = await loadCursor().catch(() => null);
    let after: RecoveryCursor | undefined = start ?? undefined;
    let wrapped = start === null;
    let heldDone = false;
    do {
      const page = await chain.recover({
        limit: PAY_RECOVER_PAGE,
        now: started,
        ...(after ? { after } : {}),
      });
      run.pages++;
      run.checked += page.checked;
      run.abandoned += page.abandoned;
      run.expired += page.expired;
      run.released += page.released;
      run.settled += page.settled;
      run.errors += page.errors;
      if (page.next === null) {
        if (wrapped) {
          heldDone = true;
          after = undefined;
          break;
        }
        wrapped = true;
        after = undefined;
        continue;
      }
      after = page.next;
      // Wrapped around to where this run began: every held row was looked at once.
      if (wrapped && start && !before(page.next, start)) {
        heldDone = true;
        after = undefined;
        break;
      }
    } while (clock() - started < PAY_RECOVER_HELD_SHARE_MS);
    await saveCursor(after ?? null).catch(() => undefined);

    // Part 2: payments left open by a dead process, within the rest of the budget (one page at
    // least, however long part 1 took).
    let openDone = false;
    let afterPayment: PaymentCursor = { updatedAt: '-1', paymentId: '' };
    do {
      const { rows } = await deps.db.query<OpenPayment>(
        `SELECT p.payment_id, p.operator_id, p.actor_id, p.source_ref, p.idempotency_key,
           p.intent_hash, p.token_address, p.recipient_address, p.amount::text AS amount, p.state,
           p.updated_at::text AS updated_at
         FROM base_payments p
         WHERE ${STALE_OPEN} AND (p.updated_at, p.payment_id) > ($4::bigint, $5::text)
         ORDER BY p.updated_at, p.payment_id LIMIT $3`,
        [deps.chainId, cutoff, PAY_RECOVER_PAGE, afterPayment.updatedAt, afterPayment.paymentId],
      );
      for (const row of rows) {
        run.checked++;
        // One broken row (store, chain, RPC) never stops the rest of the page, and goes to the
        // back of the line like any row left unresolved.
        let done: Awaited<ReturnType<typeof resolveOpen>> = null;
        try {
          done = await resolveOpen(chain, row);
          if (done === 'ended' || done === 'finished') run[done]++;
        } catch {
          run.errors++;
        }
        if (done === null) await sendToBack(row).catch(() => undefined);
      }
      const last = rows.at(-1);
      if (rows.length < PAY_RECOVER_PAGE || !last) {
        openDone = true;
        break;
      }
      afterPayment = { updatedAt: last.updated_at, paymentId: last.payment_id };
    } while (clock() - started < PAY_RECOVER_BUDGET_MS);

    run.complete = heldDone && openDone;
    if (run.errors || !run.complete)
      console.info(JSON.stringify({ event: 'payment.recover_run', ...run }));
    return run;
  });
}
