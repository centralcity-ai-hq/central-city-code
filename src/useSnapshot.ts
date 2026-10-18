import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../shared/types';
import { api, ApiError, selectedWorkspaceId } from './api';
import { noteSnapshotPaging, pollSnapshotPath } from './agents/agentPages';

/*
 * The console's snapshot polling and stream hook. Kept out of src/api.ts so the entry chunk
 * (which needs only `api` for the session check) carries no console code.
 */

export function useSnapshot(enabled: boolean, operatorId: string, onUnauthorized: () => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [streamLive, setStreamLive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef<{ generation: number; again: boolean; promise: Promise<void> } | null>(
    null,
  );
  const generation = useRef(0);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = generation.current;
    if (inFlight.current?.generation === current) {
      inFlight.current.again = true;
      return inFlight.current.promise;
    }
    setRefreshing(true);
    const flight = { generation: current, again: false, promise: Promise.resolve() };
    const run = async () => {
      do {
        flight.again = false;
        try {
          const workspace = selectedWorkspaceId();
          // In a paged workspace the agent open in My agents is included, so its status is fresh.
          const next = await api<Snapshot>(pollSnapshotPath(workspace));
          if (current !== generation.current) return;
          // A paged workspace's screens of one agent ask the snapshot to include it.
          noteSnapshotPaging(workspace, next);
          if (next.operator.id !== operatorId) {
            setSnapshot(null);
            unauthorizedRef.current();
            return;
          }
          setSnapshot(next);
          setError('');
        } catch (err) {
          if (current !== generation.current) return;
          if (err instanceof ApiError && err.status === 401) unauthorizedRef.current();
          else
            setError(
              err instanceof Error ? err.message : "We couldn't reach Central City. Try again.",
            );
        }
      } while (flight.again && current === generation.current);
    };
    flight.promise = run();
    inFlight.current = flight;
    try {
      await flight.promise;
    } finally {
      if (inFlight.current === flight) inFlight.current = null;
      if (current === generation.current) setRefreshing(false);
    }
  }, [enabled, operatorId]);

  useEffect(() => {
    generation.current += 1;
    if (!enabled) {
      setSnapshot(null);
      setStreamLive(false);
      return;
    }
    void refresh();
    const workspace = selectedWorkspaceId();
    const stream = new EventSource(
      workspace ? `/api/events?workspace=${encodeURIComponent(workspace)}` : '/api/events',
    );
    const invalidate = () => {
      void refresh();
    };
    stream.onopen = () => setStreamLive(true);
    stream.onerror = () => setStreamLive(false);
    stream.onmessage = invalidate;
    stream.addEventListener('invalidate', invalidate);
    stream.addEventListener('snapshot', invalidate);
    const interval = window.setInterval(invalidate, 15_000);
    const focus = () => {
      if (document.visibilityState === 'visible') invalidate();
    };
    document.addEventListener('visibilitychange', focus);
    return () => {
      generation.current += 1;
      stream.close();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [enabled, refresh]);

  return { snapshot, error, streamLive, refreshing, refresh };
}
