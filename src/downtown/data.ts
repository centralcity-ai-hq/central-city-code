/*
 * The shape of /downtown.json (schema centralcity.downtown/v2) as the Downtown page reads it, and
 * the small derivations the page shows. Everything on the page comes from this file or from
 * GET /api/public/code; no count is written into the page.
 */

export type Status = 'released' | 'review' | 'planned';
export type Repository = {
  name: string;
  title: string;
  url: string;
  summary: string;
  license?: string;
  version: string | null;
  last_synced: string | null;
  changelog: string;
};
export type Category = { id: string; name: string; summary: string; count: number };
export type District = {
  id: string;
  name: string;
  category: string;
  status: Status;
  purpose: string;
  license: string;
  repository: string | null;
  source: string | null;
  version: string | null;
  last_synced: string | null;
  changelog: string | null;
  includes?: string[];
  note?: string;
  /** The conformance kit only: how many public protocol test cases it runs. */
  cases?: number;
};
export type Phase = { phase: string; scope: string; status: 'done' | 'in_progress' | 'planned' };
export type DowntownData = {
  schema: string;
  sync: { last_synced: string | null };
  public_repositories: Repository[];
  categories: Category[];
  districts: District[];
  start: {
    mcp_url: string;
    clients: { claude_code: string; codex: string };
    steps?: string[];
    other_clients?: string;
  };
  contribute: { guide: string; repository?: string; state?: string; process: string[] };
  ai_builders?: { how_to_discover_tasks?: string; coordination?: string; testing?: string };
  roadmap: Phase[];
};

export const ORG_URL = 'https://github.com/centralcity-ai-hq';

export const STATUS_LABEL: Record<Status, string> = {
  released: 'Released',
  review: 'In development',
  planned: 'Planned',
};

/** The districts in category order, each category's districts in data order. */
export function orderedDistricts(data: DowntownData): District[] {
  const rank = new Map(data.categories.map((c, i) => [c.id, i]));
  const byCategory = (d: District) => rank.get(d.category) ?? data.categories.length;
  return data.districts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => byCategory(a.d) - byCategory(b.d) || a.i - b.i)
    .map(({ d }) => d);
}

/**
 * Where a district lives, as breadcrumb segments: the organisation, the repository, then the
 * path inside it, from `source` (a github.com URL, `/tree/<branch>/<path>` or `/blob/...`).
 */
export function sourcePath(district: District): string[] {
  const url = district.source ?? district.repository;
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.hostname !== 'github.com') return [];
  const parts = parsed.pathname.split('/').filter(Boolean);
  const [owner, repo, kind, , ...rest] = parts;
  if (!owner || !repo) return [];
  return kind === 'tree' || kind === 'blob' ? [owner, repo, ...rest] : [owner, repo];
}

/** The repository name of a district (the second breadcrumb segment), or null. */
export function repositoryName(district: District): string | null {
  return sourcePath(district)[1] ?? null;
}

/**
 * The number of public protocol test cases: the conformance district's `cases` field, or, for
 * data without it, the number its purpose states. Null when neither says.
 */
export function conformanceCases(data: DowntownData): number | null {
  for (const d of data.districts) if (typeof d.cases === 'number') return d.cases;
  for (const d of data.districts) {
    const match = /\b(\d[\d,]*) (?:public )?protocol(?: conformance)? cases\b/.exec(d.purpose);
    if (match) return Number(match[1].replace(/,/g, ''));
  }
  return null;
}

/** A roadmap phase in the page's short form: version, title, date (each may be missing). */
export function phaseSummary(phase: Phase): {
  version: string | null;
  title: string;
  date: string | null;
} {
  const version = /\b(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)\b/.exec(phase.scope)?.[1] ?? null;
  const date = /\b(\d{1,2} [A-Z][a-z]{2} \d{4})\b/.exec(phase.scope)?.[1] ?? null;
  const title = phase.scope
    .split(/ \(|: |\. /)[0]
    .replace(/\.$/, '')
    .trim();
  return { version, title, date };
}
