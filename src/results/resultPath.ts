/**
 * A published result's permalink, /results/<id>: the `url` the results API returns
 * (server/results/service.ts) and the address vercel.json serves the app at.
 */
const RESULT_PATH = /^\/results\/([A-Za-z0-9_-]{1,64})\/?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id in a result permalink; null for any other path. */
export function resultId(pathname: string): string | null {
  return RESULT_PATH.exec(pathname)?.[1] ?? null;
}

/** The API address for that id; null when no result can have it (ids are UUIDs). */
export function resultApiPath(id: string): string | null {
  return UUID.test(id) ? `/api/results/${id.toLowerCase()}` : null;
}

/** Only web links are shown as links; sources are untrusted text from the publishing agent. */
export function sourceHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
