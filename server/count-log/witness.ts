import type { PublicCheckpoint } from '../../shared/count-log/index.js';

/*
 * The public witness copy of each daily checkpoint: committed to a public GitHub repository, by
 * default centralcity-ai-hq/transparency, by a scheduled job. This module only decides where and what; it holds no token and makes no request.
 *
 * CITY_COUNT_WITNESS:
 *   unset                          → repo centralcity-ai-hq/transparency, folder agent-count/
 *   repo:<owner>/<name>            → that repository, folder agent-count/
 *   folder:<owner>/<name>/<path>   → that repository, under <path>/
 */
export const DEFAULT_WITNESS = { repo: 'centralcity-ai-hq/transparency', folder: 'agent-count' };

export interface WitnessTarget {
  repo: string;
  folder: string;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const FOLDER = /^[A-Za-z0-9._-]{1,64}(?:\/[A-Za-z0-9._-]{1,64}){0,4}$/;

export function parseWitnessTarget(value: string | undefined): WitnessTarget {
  if (!value?.trim()) return { ...DEFAULT_WITNESS };
  const [kind, rest = ''] = value.trim().split(/:(.*)/s, 2) as [string, string?];
  if (kind === 'repo' && REPO.test(rest)) return { repo: rest, folder: DEFAULT_WITNESS.folder };
  if (kind === 'folder') {
    const parts = rest.split('/');
    const repo = parts.slice(0, 2).join('/');
    const folder = parts.slice(2).join('/');
    if (REPO.test(repo) && FOLDER.test(folder) && !folder.split('/').includes('..'))
      return { repo, folder };
  }
  throw new Error(
    'CITY_COUNT_WITNESS must be repo:<owner>/<name> or folder:<owner>/<name>/<path>.',
  );
}

/**
 * The file the witness job commits for one checkpoint: stable path, stable bytes. Always the
 * public form (v2, or v1 with its signed fields withheld): the split is never pushed.
 */
export function witnessFile(target: WitnessTarget, checkpoint: PublicCheckpoint) {
  const [year] = checkpoint.date.split('-');
  return {
    repo: target.repo,
    path: `${target.folder}/${year}/${checkpoint.date}.json`,
    content: `${JSON.stringify(checkpoint, null, 2)}\n`,
    message: `Agent count checkpoint ${checkpoint.date}: ${checkpoint.tree_size - checkpoint.withdrawn} agents, root ${checkpoint.root.slice(0, 16)}…`,
  };
}
