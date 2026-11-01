import { timeoutSignal } from '../shell/timeoutSignal';
import { ON_BASE_PATHS } from '../../shared/base/on-base';
import { loadOnBase, type OnBaseList } from '../verify/onBaseData';

/*
 * The On Base list for the proof pages that read it once per visit. A cold server instance can
 * take longer than one read's deadline, so a failed read is tried again twice, a few seconds
 * apart, before the page says it could not load.
 *
 * Cancellation, precisely: `live` is checked before every new request, so leaving the page stops
 * any further retry. A request already in flight is not aborted; it ends by its own 15 s deadline
 * and its answer is then ignored by the page (the page's own live guard).
 */
export async function readListWithRetry(
  live: () => boolean,
  waits: readonly number[] = [2_000, 5_000],
  load: () => Promise<OnBaseList> = () => loadOnBase({ timeoutMs: 15_000 }),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<OnBaseList> {
  let lastError: unknown = null;
  for (let tryNo = 0; tryNo <= waits.length; tryNo += 1) {
    if (tryNo > 0) await sleep(waits[tryNo - 1]);
    if (!live()) throw new Error('left');
    try {
      return await load();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** How long the rated Base IDs may take before the page says they could not be read. */
export const RATED_IDS_TIMEOUT_MS = 15_000;

/**
 * The highest Base IDs with a final Central City rating (GET /api/public/base/rated) and the time
 * the server read them. An answer that is not exactly { baseIds: [decimal strings], asOf: number }
 * is an error, never an empty list: only a well-formed [] means no agent is rated yet.
 */
export async function loadRatedIds(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  /** Another chain's (onChainPaths(slug).rated); Base's by default. */
  path: string = ON_BASE_PATHS.rated,
): Promise<{ ids: string[]; asOf: number }> {
  const response = await fetcher(path, {
    headers: { accept: 'application/json' },
    signal: signal
      ? timeoutSignal(signal, RATED_IDS_TIMEOUT_MS)
      : AbortSignal.timeout(RATED_IDS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  const body = (await response.json()) as { baseIds?: unknown; asOf?: unknown };
  const ids = body?.baseIds;
  if (
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(id)) ||
    typeof body.asOf !== 'number' ||
    !Number.isFinite(body.asOf)
  )
    throw new Error(`${path}: malformed answer`);
  return { ids: ids as string[], asOf: body.asOf };
}
