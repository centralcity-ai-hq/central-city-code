import { ChevronRight, MessageSquare, Pause, Play } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../../api';
import { ElricMark } from '../../elric/ElricMark';
import { prefetchElric } from '../../elric/prefetch';
import '../../elric/elric-tokens.css';
import { relativeTime } from '../../messagesV2';
import type { AgentPaneHandle } from './AgentPane';
import './agent-pane.css';

/** Where Elric's pane leads: its chat (/elric) or the console's Elric view (approvals, activity). */
export type ElricPlace = 'chat' | 'activity';

export interface ElricPaneProps {
  id: string;
  /** Elric's own state (GET /api/elric). */
  status: 'active' | 'paused';
  busy: boolean;
  onPause: (paused: boolean) => void;
  onOpen: (place: ElricPlace) => void;
  /** Manage Elric, the settings sheet of the Elric page. */
  onSettings: () => void;
}

type LatestChat = { title: string; at: string };

/**
 * What the pane's rows show, read once when it opens: the open approvals (GET /api/elric/pending)
 * and the latest chat (GET /api/elric/conversations, newest first). Null while unknown or when the
 * server does not answer: the row then shows no value.
 */
function useElricFacts() {
  const [approvals, setApprovals] = useState<number | null>(null);
  const [latest, setLatest] = useState<LatestChat | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    api<{ pending?: unknown }>('/api/elric/pending', undefined, 'GET', abort.signal)
      .then((read) => {
        if (Array.isArray(read.pending)) setApprovals(read.pending.length);
      })
      .catch(() => undefined);
    api<{ conversations?: unknown }>('/api/elric/conversations', undefined, 'GET', abort.signal)
      .then((read) => {
        const first = Array.isArray(read.conversations)
          ? (read.conversations[0] as { title?: unknown; updated_at?: unknown } | undefined)
          : undefined;
        if (typeof first?.title === 'string' && first.title && typeof first.updated_at === 'string')
          setLatest({ title: first.title, at: first.updated_at });
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, []);
  return { approvals, latest };
}

/**
 * Elric in the v4 pane (docs/design/my-agents-v4-mockup.html): its mark, "On · Built in", Chat ·
 * Pause, then rows that lead into the Elric page: Approvals to the console's Elric view (where
 * they are approved), Chats to /elric, Settings to Manage Elric. Elric is never removed or rotated
 * from here.
 */
export const ElricPane = forwardRef<AgentPaneHandle, ElricPaneProps>(function ElricPane(
  { id, status, busy, onPause, onOpen, onSettings },
  ref,
) {
  const heading = useRef<HTMLHeadingElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => heading.current?.focus() }), []);
  const { approvals, latest } = useElricFacts();
  const paused = status === 'paused';
  const chat = latest ? `${latest.title} · ${relativeTime(latest.at)}` : '';
  return (
    <aside id={id} className="ap4" aria-label="Elric details">
      <div className="ap4-wrap">
        <div className="ap4-head">
          <span className="ap4-avatar">
            <ElricMark size="md" />
            <i className="ap4-presence" data-state={paused ? 'paused' : 'online'} />
          </span>
          <div className="ap4-who">
            <h2 ref={heading} tabIndex={-1}>
              Elric
            </h2>
            <p>{paused ? 'Paused' : 'On'} · Built in</p>
          </div>
        </div>
        <div className="ap4-actions">
          {/* The chat opens without a wait: its chunk loads on the way to the click. */}
          <button
            type="button"
            className="ap4-btn"
            onPointerEnter={prefetchElric}
            onFocus={prefetchElric}
            onClick={() => onOpen('chat')}
          >
            <MessageSquare size={16} aria-hidden="true" />
            Chat
          </button>
          {/* One button that changes its words: focus stays on it after Pause or Resume. */}
          <button
            type="button"
            className="ap4-btn ap4-ghost"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onPause(!paused);
            }}
          >
            {paused ? (
              <Play size={16} aria-hidden="true" />
            ) : (
              <Pause size={16} aria-hidden="true" />
            )}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div className="ap4-group">
          <Row label="Approvals" onClick={() => onOpen('activity')}>
            {approvals ? (
              <span className="ap4-v">
                <span className="ap4-badge">{approvals}</span>
              </span>
            ) : approvals === 0 ? (
              <span className="ap4-v">None</span>
            ) : null}
          </Row>
          <Row label="Chats" warm onClick={() => onOpen('chat')}>
            {chat ? (
              <span className="ap4-v ap4-v-clip" title={chat}>
                {chat}
              </span>
            ) : null}
          </Row>
        </div>
        <div className="ap4-group">
          <Row label="Settings" dialog onClick={onSettings} />
        </div>
      </div>
    </aside>
  );
});

function Row({
  label,
  dialog = false,
  warm = false,
  onClick,
  children,
}: {
  label: string;
  /** The row opens a sheet over this page. */
  dialog?: boolean;
  /** The row opens /elric: its chunk loads on hover or focus. */
  warm?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="ap4-row"
      aria-haspopup={dialog ? 'dialog' : undefined}
      onPointerEnter={warm ? prefetchElric : undefined}
      onFocus={warm ? prefetchElric : undefined}
      onClick={onClick}
    >
      <span className="ap4-k">{label}</span>
      {children}
      <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
    </button>
  );
}
