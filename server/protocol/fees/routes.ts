/*
 * Public protocol fee metrics (docs/protocol/FEES.md, "Public metrics"): per UTC day, the number
 * of paid calls, their volume (service prices) and the 10% protocol fees, which are also the
 * protocol revenue. Finalized ledger rows only. Every paid call counts the same way; nothing about
 * payers, payees or workspaces is returned. Live by default on Base mainnet; 404 only while
 * CITY_PROTOCOL_FEES is '0' (the emergency off, read per request) or the configuration is
 * incomplete (docs/protocol/LIVE.md).
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database.js';
import { clientAddressKey } from '../../rate-limit.js';
import { dailyFees, historyComplete, scanProgress } from './ledger.js';

export const PROTOCOL_FEES_RATE = { max: 60, windowMs: 60_000 } as const;
export const PROTOCOL_FEES_CACHE_CONTROL = 'public, max-age=60';
export const PROTOCOL_FEES_EDGE_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';
const MAX_DAYS = 365;
const DAY = 86_400;

const units = (v: bigint) => {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
};

export function registerProtocolFeeRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    /** The fee chain, or null when fees are switched off or not configured (per request). */
    chainId: () => number | null;
    clock: () => number;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
  },
): void {
  app.get('/api/public/protocol/fees', async (request, reply) => {
    const chainId = deps.chainId();
    if (chainId === null) return reply.code(404).send({ error: 'not_found' });
    await deps.limit(
      `ip:protocolfees:${clientAddressKey(request.ip)}`,
      PROTOCOL_FEES_RATE.max,
      PROTOCOL_FEES_RATE.windowMs,
    );
    // Only `days`, in one spelling: every other URL would be a new edge cache key, and each miss
    // reads the ledger again.
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (Object.keys(query).some((key) => key !== 'days'))
      return reply.code(400).send({ error: 'invalid_query' });
    const raw = query.days ?? '30';
    if (
      typeof raw !== 'string' ||
      !/^[1-9]\d{0,2}$/.test(raw) ||
      Number(raw) < 1 ||
      Number(raw) > MAX_DAYS
    )
      return reply.code(400).send({ error: 'invalid_days', max: MAX_DAYS });
    const days = Number(raw);
    const nowSec = Math.floor(deps.clock() / 1000);
    const end = (Math.floor(nowSec / DAY) + 1) * DAY; // end of the current UTC day
    // One read-only snapshot for the totals, the scan progress and history_complete: a scan that
    // commits between separate reads would otherwise publish a finalized_through_block (or a
    // history_complete) newer than the totals it is served with.
    const { rows, progress, complete } = await deps.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return {
        rows: await dailyFees(tx, chainId, end - days * DAY, end, { finalizedOnly: true }),
        progress: await scanProgress(tx, chainId),
        complete: await historyComplete(tx, chainId),
      };
    });
    let volume = 0n;
    let fees = 0n;
    let payments = 0;
    let feeCount = 0;
    for (const row of rows) {
      volume += row.volume;
      fees += row.fees;
      payments += row.payments;
      feeCount += row.feeCount;
    }
    return reply
      .header('Cache-Control', PROTOCOL_FEES_CACHE_CONTROL)
      .header('Vercel-CDN-Cache-Control', PROTOCOL_FEES_EDGE_CACHE_CONTROL)
      .send({
        chain_id: chainId,
        token: 'USDC',
        fee_rate: '0.10',
        // False after a restore or while a backlog drains: the totals below are then partial.
        history_complete: complete,
        // How fresh the totals are: the last block read, the last final block, the last scan time.
        scanned_through_block: progress.scannedThroughBlock,
        finalized_through_block: progress.finalizedThroughBlock,
        last_scan_at:
          progress.lastScanAt === null ? null : new Date(progress.lastScanAt).toISOString(),
        days: rows.map((row) => ({
          day: row.day,
          payments: row.payments,
          fee_count: row.feeCount,
          volume_usdc: units(row.volume),
          fees_usdc: units(row.fees),
          revenue_usdc: units(row.fees),
        })),
        totals: {
          payments,
          fee_count: feeCount,
          volume_usdc: units(volume),
          fees_usdc: units(fees),
          revenue_usdc: units(fees),
        },
        updated_at: new Date(deps.clock()).toISOString(),
      });
  });
}
