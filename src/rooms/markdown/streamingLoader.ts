/*
 * Loads the smooth reveal (Streaming.tsx, its own chunk) once, ahead of the first answer. Not
 * React.lazy: a lazy component suspends on its first render even when its chunk is loaded, and
 * React holds a Suspense fallback for about 300 ms, which would freeze the first words.
 */
import { useEffect, useState } from 'react';

type StreamingModule = typeof import('./Streaming');
let loaded: StreamingModule | null = null;
let loading: Promise<StreamingModule> | null = null;

export function loadStreaming(): Promise<StreamingModule> {
  loading ??= import('./Streaming').then((module) => (loaded = module));
  return loading;
}

/**
 * The reveal module, or null until it has loaded (the caller then shows the text as usual).
 * `wanted`: load it now (callers preload it with loadStreaming when an answer may come).
 */
export function useStreaming(wanted = true): StreamingModule | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module || !wanted) return;
    let live = true;
    loadStreaming()
      .then((value) => live && setModule(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [module, wanted]);
  return module;
}
