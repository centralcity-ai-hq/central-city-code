import type { ComponentType } from 'react';
import { api } from '../api';

/*
 * Opening Elric from the workspace navigation without a wait (docs: ElricRoute in src/Root.tsx).
 * The dashboard's chunk is fetched when the browser is idle and again on hover, focus or press
 * of the Elric entry (a no-op once loaded); its status (GET /api/elric) starts on hover too, so
 * the click usually finds both ready. A status is used once and only while fresh: a later visit
 * asks again.
 */

/** What GET /api/elric answers (only `agent_id` is read here). */
export type ElricStatus = { agent_id?: string | null };

export type ElricDashboardModule = {
  default: ComponentType<{ embedded?: boolean; status?: ElricStatus; personName?: string }>;
  /** Starts reading the chat the dashboard opens with (ElricDashboard.tsx, prefetchFirstChat). */
  prefetchFirstChat?: (status: Promise<ElricStatus>) => void;
};

// The glob resolves to nothing while ElricDashboard.tsx does not exist (the route then answers
// Not found), so a build without the dashboard still compiles.
export const loadElricDashboard = import.meta.glob<ElricDashboardModule>('./ElricDashboard.tsx')[
  './ElricDashboard.tsx'
];

const STATUS_FRESH_MS = 10_000;
let warm: { at: number; value: Promise<ElricStatus>; ready?: ElricStatus } | null = null;

function ignore() {
  // A prefetch that fails is simply asked again when the page opens.
}

let module: Promise<ElricDashboardModule> | null = null;
let loadedModule: ElricDashboardModule | null = null;
/** GET /api/elric as the workspace shell read it (App.tsx), while it names an Elric. */
let known: ElricStatus | null = null;

/**
 * The workspace shell reads GET /api/elric when it opens (for its navigation). With an Elric,
 * opening the page skips asking again: the chat is read straight away (one round trip fewer).
 * A removed Elric then answers elric_not_found and the page shows the setup.
 */
export function noteElricStatus(status: ElricStatus) {
  known = status.agent_id ? status : null;
}

/**
 * The dashboard's module, loaded once (the prefetches and the route share the request). The
 * route renders it as soon as it resolves, so React never suspends on it.
 */
export function elricDashboardModule(): Promise<ElricDashboardModule> | null {
  if (!loadElricDashboard) return null;
  if (!module) {
    const value = loadElricDashboard();
    value.then(
      (loaded) => {
        loadedModule = loaded;
      },
      () => {
        if (module === value) module = null;
      },
    );
    module = value;
  }
  return module;
}

/** Starts loading the dashboard's chunk (a hint that Elric may open next). */
export function prefetchElricChunk() {
  void elricDashboardModule()?.catch(ignore);
}

/** Idle time on a workspace page: the chunk, and the first chat when the shell knows an Elric. */
export function prefetchElricIdle() {
  if (known) prefetchElric();
  else prefetchElricChunk();
}

/**
 * Chunk, status and the first chat: the person is about to open Elric (hover, focus, press, or
 * the phone navigation opening). The chat, its conversations and its latest messages start as
 * soon as the chunk and the status are in, so the click usually finds the page ready to draw.
 */
export function prefetchElric() {
  prefetchElricChunk();
  if (known) {
    const status = known;
    void elricDashboardModule()
      ?.then((loaded) => loaded.prefetchFirstChat?.(Promise.resolve(status)))
      .catch(ignore);
    return;
  }
  if (warm && Date.now() - warm.at < STATUS_FRESH_MS) return;
  const value = api<ElricStatus>('/api/elric', undefined, 'GET');
  const entry: NonNullable<typeof warm> = { at: Date.now(), value };
  value.then(
    (status) => {
      entry.ready = status;
    },
    () => {
      if (warm === entry) warm = null;
    },
  );
  warm = entry;
  void elricDashboardModule()
    ?.then((loaded) => loaded.prefetchFirstChat?.(value))
    .catch(ignore);
}

/**
 * The page opening now, when the chunk and a fresh status are both already here: the route
 * draws the dashboard on its first frame (no skeleton frame in between). Does not consume.
 */
export function readyElric(): {
  status: ElricStatus;
  Dashboard: ElricDashboardModule['default'];
} | null {
  const status = (warm && Date.now() - warm.at < STATUS_FRESH_MS ? warm.ready : undefined) ?? known;
  return status && loadedModule ? { status, Dashboard: loadedModule.default } : null;
}

/** The status for the page that opens now: the prefetched one when fresh, else a new request. */
export function takeElricStatus(): Promise<ElricStatus> {
  const fresh = warm && Date.now() - warm.at < STATUS_FRESH_MS ? warm.value : null;
  warm = null;
  return (
    fresh ?? (known ? Promise.resolve(known) : api<ElricStatus>('/api/elric', undefined, 'GET'))
  );
}
