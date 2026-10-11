import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DirectThread } from '../../../server/messaging/contract';
import { ApiError } from '../../api';

/*
 * The frame, icons and quiet states the v4 Messages and Rooms screens share
 * (docs/design/my-agents-v4-mockup.html, the agent pane's sub-screens).
 */

/** Props every screen of the agent pane takes; the master-detail shell hosts them. */
export type AgentScreenProps = {
  agent: { id: string; name: string };
  onBack: () => void;
  /** Opens another screen of the pane: 'messages', 'thread:<context id>', 'rooms', 'rooms-add'. */
  onOpen: (screen: string) => void;
  /** The back link's label (the previous screen); each screen has the mockup's default. */
  backLabel?: string;
};

const Svg = ({ children, size }: { children: ReactNode; size?: number }) => (
  <svg
    className="amr4-i"
    viewBox="0 0 24 24"
    aria-hidden="true"
    style={size ? { width: size, height: size } : undefined}
  >
    {children}
  </svg>
);
export const IconBack = () => (
  <Svg>
    <path d="m15 6-6 6 6 6" />
  </Svg>
);
export const IconChev = () => (
  <Svg size={14}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconMsg = () => (
  <Svg>
    <path d="M4 5h16v11H8l-4 4z" />
  </Svg>
);
export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconSend = () => (
  <Svg>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </Svg>
);

/** A sub-screen: the back link on top, the title, the body, and an optional pinned composer. */
export function ScreenFrame({
  backLabel,
  onBack,
  title,
  sub,
  children,
  composer,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  sub?: string;
  children: ReactNode;
  composer?: ReactNode;
}) {
  return (
    <div className="amr4">
      <div className="amr4-dtop">
        <button type="button" className="amr4-backbtn" onClick={onBack}>
          <IconBack />
          {backLabel}
        </button>
      </div>
      <div className="amr4-dscroll" data-scroll>
        <div className="amr4-dwrap">
          <h3 className="amr4-dtitle">{title}</h3>
          {sub ? <p className="amr4-dsub">{sub}</p> : null}
          <div className="amr4-pb">{children}</div>
        </div>
      </div>
      {composer}
    </div>
  );
}

/** While a read is in flight: one quiet row (every read has a deadline, so it always ends). */
export function LoadingRow() {
  return (
    <div className="amr4-group" role="status" aria-label="Loading">
      <div className="amr4-gr">
        <span className="amr4-spin" />
      </div>
    </div>
  );
}

/** A failed read: one line and a retry. */
export function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="amr4-note amr4-errline" role="alert">
      {message}{' '}
      <button type="button" className="amr4-quiet" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

/** The mockup's toast: a short confirmation at the bottom, gone after 1.7 s. */
export function useToast() {
  const [text, setText] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((value: string) => {
    window.clearTimeout(timer.current);
    setText(value);
    timer.current = window.setTimeout(() => setText(''), 1700);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const node = text ? (
    <div className="amr4-toast" role="status">
      {text}
    </div>
  ) : null;
  return { show, node };
}

/** A sentence for a failed request (the server's plain message, or a generic line). */
export function failure(err: unknown): string {
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.name === 'TimeoutError') return 'This took too long.';
  return "Couldn't load. Check your connection.";
}

/** Every read gives up after this long, so nothing spins forever. */
export const READ_DEADLINE_MS = 15_000;

export type Load<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/**
 * One read with a deadline: loading, then data or an error line with retry. With `pollMs` it
 * re-reads quietly while the tab is visible; a failed re-read keeps the last data on screen.
 */
export function useLoad<T>(
  key: string,
  read: (signal: AbortSignal) => Promise<T>,
  pollMs?: number,
) {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const readRef = useRef(read);
  readRef.current = read;
  const run = useRef<(quiet: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    run.current = async (quiet: boolean) => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const deadline = window.setTimeout(() => {
        timedOut = true;
        request.abort();
      }, READ_DEADLINE_MS);
      if (!quiet) setLoad({ state: 'loading' });
      try {
        const data = await readRef.current(request.signal);
        if (active && controller === request) setLoad({ state: 'ready', data });
      } catch (err) {
        if (!active || controller !== request) return;
        const message = failure(
          timedOut ? Object.assign(new Error(), { name: 'TimeoutError' }) : err,
        );
        setLoad((prev) => (quiet && prev.state === 'ready' ? prev : { state: 'error', message }));
      } finally {
        window.clearTimeout(deadline);
      }
    };
    void run.current(false);
    const timer = pollMs
      ? window.setInterval(() => {
          if (document.visibilityState === 'visible') void run.current(true);
        }, pollMs)
      : undefined;
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [key, pollMs]);
  const reload = useCallback((quiet = false) => run.current(quiet), []);
  return { load, reload, setLoad };
}

/** The conversation list as these screens read it: the newest 100 threads (the server's cap). */
export const CONVERSATIONS_PATH = '/api/messages/conversations?limit=100';

/** Threads opened by "New message" before their first message (the list does not have them). */
const openedThreads = new Map<string, DirectThread>();
export function rememberOpenedThread(thread: DirectThread): void {
  openedThreads.set(thread.context_id, thread);
}
export function openedThread(contextId: string): DirectThread | undefined {
  return openedThreads.get(contextId);
}
