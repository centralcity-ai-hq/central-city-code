import {
  SERVICE_CALLS_PATH,
  SERVICE_CALLS_QUERY_MAX,
  type ServiceCall,
  type ServiceCallsPage,
} from '../../shared/explorer-calls';
import { json } from './countLogClient';
import { BASESCAN } from './onBaseData';

/*
 * The Agent Explorer's "Service calls" data (shared/explorer-calls.ts; the approved mockup
 * explorer-service-calls.html): every paid service call as the Base transaction that paid for it,
 * from the public route. The screen uses only this module.
 */

export type { ServiceCall, ServiceCallsPage };

/** The first page is read again this often while the tab is visible; other pages stay as read. */
export const SERVICE_CALLS_POLL_MS = 5_000;

export const basescanBlock = (block: number) => `${BASESCAN}/block/${block}`;

/** "0x3f1c9a…77e2": a hash or address shortened for the table; the full one is in the title. */
export const shortHex = (hex: string, head = 6, tail = 4) =>
  hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;

/** "12 sec ago", "4 min ago", "3 h ago", "2 days ago" (never negative). */
export function agoText(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** "14:02:31 UTC" of a time (ms). */
export const utcTime = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

/** A row's identity in the table (one call, one transaction; its time keeps rare batches apart). */
export const callKey = (call: Pick<ServiceCall, 'tx_hash' | 'time'>) =>
  `${call.time}_${call.tx_hash}`;

/** The search as sent: trimmed and never longer than the server accepts (it refuses longer). */
export const searchText = (q: string) => q.trim().slice(0, SERVICE_CALLS_QUERY_MAX).trim();

/** Thrown for a search the server refused (400): the text is not one it can search by. */
export class SearchRefused extends Error {}

export async function loadServiceCalls(
  query: { q?: string; cursor?: string | null } = {},
): Promise<ServiceCallsPage> {
  const params = new URLSearchParams();
  const q = searchText(query.q ?? '');
  if (q) params.set('q', q);
  if (query.cursor) params.set('cursor', query.cursor);
  const search = params.toString();
  const path = `${SERVICE_CALLS_PATH}${search ? `?${search}` : ''}`;
  if (q) {
    const response = await fetch(path, { headers: { accept: 'application/json' } });
    if (response.status === 400) throw new SearchRefused(q);
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return (await response.json()) as ServiceCallsPage;
  }
  return json<ServiceCallsPage>(path);
}
