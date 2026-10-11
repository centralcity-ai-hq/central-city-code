import type { AgentActivityItem, AgentActivityPage, Job } from '../shared/types.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { iso, type Workspace } from './model.js';

/**
 * One agent's Activity feed (GET /api/agents/:id/activity): its events and the runs it asked for
 * or did, from the workspace document, plus a "registered on Base" line per confirmed ERC-8004
 * registration (base_identities, read by the route). Newest first, paged with an opaque cursor.
 *
 * The document keeps the latest 1000 events (model.ts event()) and at most 1000 jobs (new jobs are
 * refused at the cap, never trimmed), so this reaches further back than the snapshot (latest 100
 * events / 50 jobs, workspace-wide) but not past those caps.
 */
export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 100;

/** A confirmed base_identities row: a confirmed row is never written again, so updated_at is when it confirmed. */
export interface ConfirmedIdentity {
  chainId: number;
  erc8004AgentId: string;
  confirmedAt: number;
}

export function runStatus(status: Job['status']): 'done' | 'running' | 'failed' {
  if (status === 'completed') return 'done';
  if (status === 'queued' || status === 'running') return 'running';
  return 'failed';
}

interface Keyed {
  time: number;
  key: string;
  item: AgentActivityItem;
}
const encode = (entry: Pick<Keyed, 'time' | 'key'>) =>
  Buffer.from(JSON.stringify([entry.time, entry.key])).toString('base64url');
/** The cursor is ours (time and key of the last item shown); anything else is null. */
export function decodeCursor(cursor: string): Pick<Keyed, 'time' | 'key'> | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    )
      return { time: value[0] as number, key: value[1] as string };
  } catch {
    // fall through
  }
  return null;
}
/** Newest first; equal times by key, descending, so the order is total and stable. */
const newerFirst = (a: Pick<Keyed, 'time' | 'key'>, b: Pick<Keyed, 'time' | 'key'>) =>
  b.time - a.time || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

export function agentActivity(
  workspace: Workspace,
  agentId: string,
  identities: ConfirmedIdentity[],
  page: { before?: string | null; limit?: number },
): AgentActivityPage {
  const names = new Map(workspace.agents.map((agent) => [agent.id, agent.name]));
  const all: Keyed[] = [];
  for (const item of workspace.events)
    if (item.agentId === agentId)
      all.push({
        time: Date.parse(item.createdAt),
        key: `event:${item.id}`,
        item: {
          kind: 'event',
          id: item.id,
          at: item.createdAt,
          type: item.type,
          text: item.message,
          jobId: item.jobId,
        },
      });
  for (const job of workspace.jobs) {
    if (job.providerId !== agentId && job.requesterId !== agentId) continue;
    const role = job.providerId === agentId ? 'provider' : 'requester';
    const other = role === 'provider' ? job.requesterId : job.providerId;
    all.push({
      time: Date.parse(job.createdAt),
      key: `run:${job.id}`,
      item: {
        kind: 'run',
        id: job.id,
        at: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
        status: runStatus(job.status),
        capability: job.capability,
        role,
        // A requester in another workspace (accepted cross-workspace connection) is not named here.
        counterpart: { id: other, name: names.get(other) ?? null },
        error: job.error,
      },
    });
  }
  for (const identity of identities) {
    const network =
      (BASE_NETWORKS as Record<number, { name: string } | undefined>)[identity.chainId]?.name ??
      'Base';
    const id = `base.registered:${identity.chainId}`;
    all.push({
      time: identity.confirmedAt,
      key: `event:${id}`,
      item: {
        kind: 'event',
        id,
        at: iso(identity.confirmedAt),
        type: 'base.registered',
        text: `Registered on ${network} as agent #${identity.erc8004AgentId}.`,
        jobId: null,
      },
    });
  }
  all.sort(newerFirst);
  const cursor = page.before ? decodeCursor(page.before) : null;
  const from = cursor ? all.findIndex((entry) => newerFirst(cursor, entry) < 0) : 0;
  const limit = Math.min(Math.max(page.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT);
  const rest = from < 0 ? [] : all.slice(from);
  const items = rest.slice(0, limit);
  return {
    items: items.map((entry) => entry.item),
    nextBefore: rest.length > limit ? encode(items[items.length - 1]!) : null,
  };
}
