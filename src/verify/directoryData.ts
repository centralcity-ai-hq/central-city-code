import {
  DIRECTORY_PATHS,
  type DirectoryCard,
  type DirectoryPage,
  type DirectorySort,
} from '../../shared/directory';
import { loadOnBase, type OnBaseRow } from './onBaseData';

/*
 * The Base Agents directory's data (Operation Directory D1, docs/design/directory.html): one read,
 * GET /api/public/directory, public and signed out too. The page and the header's finder use only
 * this module. A server without the route (404) answers null, so the screens show what they showed
 * before instead of an empty directory.
 */

export type DirectorySearch = {
  q?: string;
  minRating?: number;
  sort?: DirectorySort;
  before?: string | null;
};

/** The address of one search; empty and default parts are left out. */
export function directoryUrl(search: DirectorySearch = {}): string {
  const params = new URLSearchParams();
  const q = (search.q ?? '').trim();
  if (q) params.set('q', q);
  if (search.minRating) params.set('min_rating', String(search.minRating));
  if (search.sort && search.sort !== 'best_rated') params.set('sort', search.sort);
  if (search.before) params.set('before', search.before);
  const query = params.toString();
  return query ? `${DIRECTORY_PATHS.search}?${query}` : DIRECTORY_PATHS.search;
}

/** Keeps only well-formed cards, so one odd row never breaks the list. */
function readPage(body: unknown): DirectoryPage {
  const raw = (body ?? {}) as { agents?: unknown; next?: unknown };
  const agents = Array.isArray(raw.agents)
    ? (raw.agents as DirectoryCard[]).filter(
        (card) =>
          card &&
          typeof card.baseId === 'string' &&
          typeof card.short === 'string' &&
          typeof card.name === 'string',
      )
    : [];
  return {
    agents: agents.map((card) => ({
      ...card,
      description: typeof card.description === 'string' ? card.description : '',
      skills: Array.isArray(card.skills) ? card.skills.filter((s) => typeof s === 'string') : [],
      score:
        card.score && typeof card.score.average === 'string' && card.score.raters > 0
          ? card.score
          : null,
      paidTimes: typeof card.paidTimes === 'number' ? card.paidTimes : null,
      invitable: card.invitable === true,
      activeAt: typeof card.activeAt === 'number' ? card.activeAt : null,
    })),
    next: typeof raw.next === 'string' ? raw.next : null,
  };
}

/** One page of the directory; null when this server has no directory (404). Throws otherwise. */
export async function searchDirectory(
  search: DirectorySearch = {},
  signal?: AbortSignal,
): Promise<DirectoryPage | null> {
  const response = await fetch(directoryUrl(search), {
    headers: { accept: 'application/json' },
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`directory ${response.status}`);
  return readPage(await response.json());
}

/** A registry row as a card: no description, skills or payments, never invitable. */
function registryCard(row: OnBaseRow): DirectoryCard {
  return {
    baseId: row.baseId,
    short: row.short,
    name: row.name.trim(),
    description: '',
    skills: [],
    score: row.score ?? null,
    paidTimes: null,
    invitable: false,
    activeAt: null,
  };
}

/**
 * The header finder's search: the directory first; while it has no match (it is opt-in and starts
 * empty) or the server has none, the registry of every Central City agent on Base, which matches
 * name, Base ID and passport number. Rows without a public name are left out.
 */
export async function findAgents(
  q: string,
  signal?: AbortSignal,
): Promise<{ source: 'directory' | 'registry'; agents: DirectoryCard[] }> {
  let page: DirectoryPage | null = null;
  try {
    page = await searchDirectory({ q }, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  if (page && page.agents.length > 0) return { source: 'directory', agents: page.agents };
  const list = await loadOnBase({ q });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return {
    source: 'registry',
    agents: list.rows.filter((row) => row.name.trim()).map(registryCard),
  };
}

/** "★ 4.8 · Paid 41", "★ 4.6", "Paid 3" or "New": the card's one line of standing. */
export function standing(card: Pick<DirectoryCard, 'score' | 'paidTimes'>): {
  stars: string | null;
  paid: string | null;
} {
  return {
    stars: card.score ? card.score.average : null,
    paid: card.paidTimes ? `Paid ${card.paidTimes}` : null,
  };
}

export const SORT_LABELS: Record<DirectorySort, string> = {
  best_rated: 'Best rated',
  newest: 'Newest',
  most_paid: 'Most paid',
};
