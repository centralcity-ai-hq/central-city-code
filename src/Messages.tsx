import './messages-v2.css';
import { navigate } from './shell/navigation';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AtSign,
  CircleAlert,
  CodeXml,
  LockKeyhole,
  CheckCheck,
  DoorOpen,
  House,
  Ellipsis,
  Inbox,
  Info,
  Link2,
  LoaderCircle,
  MessagesSquare,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, Snapshot } from '../shared/types';
import type {
  AgentMessage,
  ConversationSummary,
  DirectRecipient,
  DirectThread,
  InboxAck,
  InboxPage,
  InboxSummary,
} from '../server/messaging/contract';
import { api, ApiError } from './api';
import { AgentGlyph, ConfirmDialog, formatDate } from './components';
import { describeError } from './ui/errors';
import { AvatarColorsContext, useAvatarColors, useAvatarStyle } from './shell/avatarColor';
import {
  formatUnread,
  matchesFilter,
  messageTime,
  partyName,
  privacyNote,
  relativeTime,
  roomOrigin,
  splitCode,
  sumUnread,
  unreadLabel,
  type InboxFilter,
} from './messagesV2';

/** History-state key of a phone thread's own entry (see MessagesView showThread). */
const THREAD_ENTRY = 'messagesThread';
function isThreadEntry(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[THREAD_ENTRY] === true
  );
}

/** A sender or chat avatar: the colour for its member id (one per chat within Messages). */
function MessageAvatar({ id, name, ai = false }: { id: string; name: string; ai?: boolean }) {
  const style = useAvatarStyle(id);
  return (
    <span className="msg-v2-avatar" data-ai={ai || undefined} aria-hidden="true" style={style}>
      {name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

/** The badge after a name (WORKSPACE_V3 §1.3): who is talking is always visible. */
function KindTag({ ai }: { ai: boolean }) {
  return (
    <span className="msg3-tag" data-kind={ai ? 'ai' : 'person'}>
      {ai ? 'AI' : 'person'}
    </span>
  );
}

/**
 * Composer keys, as in rooms: Enter sends, Shift+Enter adds a line (on touch Enter adds a line),
 * Ctrl/Cmd+Enter always sends, Escape leaves the box (the page then returns to the inbox).
 */
function sendShortcut(event: KeyboardEvent<HTMLTextAreaElement>, enabled: boolean) {
  if (event.key === 'Escape') {
    event.currentTarget.blur();
    return;
  }
  if (!enabled || event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  if (event.ctrlKey || event.metaKey || (!event.shiftKey && !touch)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

/** Splits text into strings and @mention spans for the names of a thread's members. */
function withMentions(text: string, names: readonly string[], key: string): ReactNode[] {
  const known = [...new Set(names.filter(Boolean))];
  if (!known.length || !text.includes('@')) return [text];
  const pattern = new RegExp(
    `@(?:${known
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})`,
    'g',
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(
      <span key={`${key}@${match.index}`} className="msg3-mention">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** A plain-text message: line breaks kept, ```fenced``` blocks as dark code, @mentions styled. */
function MessageText({ text, names = [] }: { text: string; names?: readonly string[] }) {
  return (
    <>
      {splitCode(text).map((segment, index) =>
        segment.type === 'code' ? (
          <pre className="msg3-code" key={index}>
            <code>{segment.code}</code>
          </pre>
        ) : (
          <p className="msg-text" key={index}>
            {withMentions(segment.text, names, String(index))}
          </p>
        ),
      )}
    </>
  );
}

/** The floating composer grows with its text up to its CSS max-height. */
function useAutoGrow(ref: { current: HTMLTextAreaElement | null }, value: string, hidden: boolean) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || hidden) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [ref, value, hidden]);
}

/**
 * The floating composer of the thread view (WORKSPACE_V3 §4.4, without Post-as and task tools):
 * the text on top, then @ (mention the other side), </> (code block), Preview and Send.
 */
function FloatingComposer({
  label,
  boxLabel,
  placeholder,
  value,
  onChange,
  onSubmit,
  busy,
  canSend,
  keys,
  sendLabel,
  mention,
  names,
  error,
  children,
}: {
  label: string;
  boxLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  busy: boolean;
  canSend: boolean;
  /** Enter sends (off while the workspace is paused). */
  keys: boolean;
  sendLabel: string;
  /** The name the @ button inserts. */
  mention: string | null;
  names: readonly string[];
  error: string;
  /** Left of the tool row: who you write as. */
  children?: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  useAutoGrow(box, value, preview);
  useEffect(() => {
    if (!value) setPreview(false);
  }, [value]);
  // The caret to restore once the inserted text is rendered: set right after React commits the
  // new value (useLayoutEffect), never on a frame that may still show the old value.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    const caret = pendingCaret.current;
    if (!element || caret === null || element.value !== value) return;
    pendingCaret.current = null;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [value]);
  const insert = (before: string, after = '') => {
    const element = box.current;
    if (!element || busy) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selected = value.slice(start, end);
    pendingCaret.current = start + before.length + selected.length;
    onChange(value.slice(0, start) + before + selected + after + value.slice(end));
    setPreview(false);
  };
  return (
    <form className="msg3-composer" onSubmit={onSubmit} aria-label={label}>
      {preview ? (
        <div className="msg3-preview" role="region" aria-label="Preview">
          <MessageText text={value} names={names} />
        </div>
      ) : null}
      <textarea
        ref={box}
        rows={1}
        hidden={preview}
        onKeyDown={(event) => sendShortcut(event, keys)}
        aria-label={boxLabel}
        value={value}
        maxLength={16_384}
        // Read-only (not disabled) while sending, so focus and the caret stay in the box.
        readOnly={busy}
        aria-busy={busy}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="msg3-tools">
        <div className="msg3-tools-start">{children}</div>
        {mention ? (
          <button
            type="button"
            className="msg3-tool"
            aria-label={`Mention ${mention}`}
            title={`Mention ${mention}`}
            onClick={() => insert(`@${mention} `)}
          >
            <AtSign size={16} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="msg3-tool"
          aria-label="Insert code block"
          title="Insert code block"
          onClick={() => insert('```\n', '\n```')}
        >
          <CodeXml size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="msg3-preview-toggle"
          aria-pressed={preview}
          disabled={!value.trim()}
          onClick={() => setPreview((on) => !on)}
        >
          Preview
        </button>
        <button type="submit" className="msg3-send" aria-label={sendLabel} disabled={!canSend}>
          {busy ? (
            <LoaderCircle className="spin" size={20} aria-hidden="true" />
          ) : (
            <ArrowUp size={20} aria-hidden="true" />
          )}
        </button>
      </div>
    </form>
  );
}

/** A person's account label as the server words it ("Account 1a2b3c4d"), not a readable name. */
const RAW_ACCOUNT_LABEL = /^Account [0-9a-f]{6,}$/i;

/** Messages refresh by polling until the fabric's SSE stream lands (docs/MESSAGING.md). */
const POLL_MS = 10_000;
/** A thread opens with its newest page; scrolling up loads older pages of the same size. */
const PAGE = 50;
/** Reads started together for a thread that spans several legacy contexts. */
const WAVE = 6;
/** Distance from the bottom (px) that still counts as "at the newest message". */
const PINNED_PX = 48;
/** Distance from the top (px) that starts loading older messages. */
const OLDER_PX = 160;

/** Plain copy for any read or send failure; never shows server text. */
function describe(err: unknown, agentName?: string): string {
  const copy = describeError(err, {
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    ...(agentName ? { agentName } : {}),
  });
  return copy.detail ? `${copy.title} ${copy.detail}` : copy.title;
}
/**
 * The chat last opened in this tab, per workspace (a per-viewer convenience; it may be missing).
 * Messages reopens it and starts reading its newest page while the list loads. It lives in
 * sessionStorage, so it ends with the tab; forgetMessagesState() clears it (and the prefetch)
 * on sign-out.
 */
const LAST_CHAT = 'cc.messages.last.';
const lastChatKey = (workspace: string) => `${LAST_CHAT}${workspace}`;
function readLastChat(workspace: string): string | null {
  try {
    return window.sessionStorage.getItem(lastChatKey(workspace));
  } catch {
    return null;
  }
}
function writeLastChat(workspace: string, context: string) {
  try {
    window.sessionStorage.setItem(lastChatKey(workspace), context);
  } catch {
    // Storage can be unavailable (private mode); the chat then opens at the newest conversation.
  }
}
const pagePath = (context: string, before: string | null) =>
  `/api/messages/conversations/${encodeURIComponent(context)}?limit=${PAGE}${
    before ? `&before=${encodeURIComponent(before)}` : ''
  }`;
/**
 * A newest-page read started before the list arrives, keyed by workspace so one workspace's page
 * can never be shown in another; used once, if still fresh, and dropped when Messages closes.
 */
const prefetched = new Map<string, { at: number; value: Promise<unknown> }>();
function prefetch(workspace: string, path: string) {
  const value = api<unknown>(path, undefined, 'GET');
  value.catch(() => undefined);
  prefetched.set(`${workspace} ${path}`, { at: Date.now(), value });
}
function takePrefetched(workspace: string, path: string): Promise<unknown> | null {
  const key = `${workspace} ${path}`;
  const entry = prefetched.get(key);
  prefetched.delete(key);
  return entry && Date.now() - entry.at < 5_000 ? entry.value : null;
}
/** Clears the remembered chats and any prefetched page; call on sign-out. */
export function forgetMessagesState(): void {
  prefetched.clear();
  try {
    for (const key of Object.keys(window.sessionStorage))
      if (key.startsWith(LAST_CHAT)) window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was stored.
  }
}
/** While the reader is at the bottom, state keeps only the newest messages (older reload). */
const KEEP = 200;
const TRIM_AT = 250;
/** The server's conversation cursor for "older than this message". */
const cursorOf = (message: AgentMessage) =>
  `${Date.parse(message.created_at)}.${message.seq}.${message.id}`;
const lostAccess = (err: unknown) =>
  err instanceof ApiError && [401, 403, 404].includes(err.status);

/** Scoped styles built only from the design v2 tokens. */
const css = `
.msg-preview{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg-thread-body{position:relative;flex:1;min-height:120px;display:flex;flex-direction:column}
.msg-viewport{position:relative;flex:1;min-height:120px;max-height:460px;overflow-y:auto;overflow-anchor:none;padding:var(--space-4) var(--space-5)}
.msg-viewport>ol{display:grid;gap:var(--space-3);list-style:none;margin:0;padding:0}
.msg-older{display:flex;justify-content:center;padding-bottom:var(--space-3);font:var(--type-meta);color:var(--text-muted)}
.msg-older button{border:0;background:none;color:var(--text-muted);font:inherit;cursor:pointer;min-height:var(--target);padding:0 var(--space-3)}
.msg-older button:hover{color:var(--text)}
.msg-jump{position:absolute;left:50%;bottom:var(--space-3);transform:translateX(-50%);display:inline-flex;align-items:center;gap:var(--space-1);padding:var(--space-1) var(--space-3);min-height:32px;border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--text);font:var(--type-meta);box-shadow:var(--shadow-float);cursor:pointer}
.msg-bubble details summary{cursor:pointer;min-height:var(--target);display:flex;align-items:center;font:var(--type-meta)}
.msg-byline{overflow-wrap:anywhere}
.msg-new{display:grid;gap:var(--space-3);padding:var(--space-4) var(--space-5)}
.msg-new>.msg-compose{padding:0;border:0}
.msg-new-title{margin:0;font-size:15px;font-weight:650}
.msg-new label{display:grid;gap:var(--space-1);min-width:0}
.msg-new select{max-width:100%;min-width:0}
.msg-new-empty{justify-items:start}
.msg-new-empty p{margin:0}
.msg-new-loading{padding:var(--space-4) var(--space-5)}
.msg-menu{position:relative;flex:none}
.msg-menu-button{display:inline-grid;place-items:center;width:40px;height:40px;border:1px solid transparent;border-radius:10px;background:none;color:var(--text-muted);cursor:pointer}
.msg-menu-button:hover,.msg-menu-button[aria-expanded="true"]{background:var(--surface-sunken);color:var(--text)}
.msg-menu-button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.msg-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:30;min-width:220px;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow-float)}
.msg-menu-list button{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:0 12px;border:0;border-radius:8px;background:none;color:var(--text);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.msg-menu-list button:hover,.msg-menu-list button:focus-visible{background:var(--surface-sunken);outline:none}
.msg-menu-list .msg-menu-danger{color:var(--error)}
.msg-scroll{display:grid;gap:var(--space-3);padding:var(--space-4) var(--space-5);max-height:460px;overflow-y:auto;align-content:start}
.msg-item{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-3);align-items:start}
.msg-bubble{display:grid;gap:var(--space-2);padding:var(--space-3) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--surface);min-width:0}
.msg-item.unread .msg-bubble{border-color:var(--motif-soft);box-shadow:inset 3px 0 0 var(--primary)}
.msg-byline{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:baseline;font:var(--type-meta);color:var(--text-muted)}
.msg-byline strong{color:var(--text);font-weight:600}
.msg-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--type-body)}
.msg-data{margin:0;padding:var(--space-2) var(--space-3);background:var(--surface-sunken);border-radius:var(--radius-control);font:12px/1.5 var(--font-mono);max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.msg-compose{display:grid;gap:var(--space-3);padding:var(--space-4) var(--space-5);border-top:1px solid var(--border);background:var(--surface)}
.msg-compose-row{display:flex;gap:var(--space-3);align-items:end;flex-wrap:wrap}
.msg-compose-row>label{display:grid;gap:var(--space-2);flex:1 1 220px}
.msg-compose textarea{min-height:88px}
.msg-inboxes{display:flex;flex-wrap:wrap;gap:var(--space-2);padding:var(--space-3) var(--space-5);border-bottom:1px solid var(--border)}
.msg-chip{display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-3);border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--text);font:var(--type-meta);cursor:pointer;min-height:var(--target)}
.msg-chip:hover{background:var(--surface-sunken)}
.msg-count{min-width:20px;height:20px;padding:0 6px;display:inline-grid;place-items:center;border-radius:10px;background:var(--primary);color:var(--on-primary);font:600 12px var(--font-body)}
.msg-inbox{display:grid;gap:var(--space-3);margin-top:var(--space-5);padding-top:var(--space-5);border-top:1px solid var(--border)}
.msg-inbox-head{display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap}
.msg-inbox-head h3{display:flex;align-items:center;gap:var(--space-2);margin:0}
.msg-inbox .msg-scroll{padding:0;max-height:300px}
.msg-inbox .msg-compose{padding:0;border-top:0}
.msg-start-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--space-4);margin-top:var(--space-2);width:100%}
.msg-start-action{display:grid;justify-items:center;gap:var(--space-2);flex:0 1 260px;min-width:0}
.msg-start-action .button{margin-top:0;max-width:100%;text-decoration:none}
`;
export function MessageStyles() {
  return (
    <style href="cc-messages" precedence="default">
      {css}
    </style>
  );
}

/** api() carries X-City-Workspace for a co-owned AI workspace and parses errors safely. */
async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const value = await api<unknown>(path, undefined, 'GET', signal);
  if (value === null) throw new Error("Messages couldn't be loaded. Try again.");
  return value;
}

/** One bounded read at a time; late responses cannot overwrite another conversation. */
function usePoll<T>(path: string | null, read = readJson) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    let flight: Promise<void> | null = null;
    setData(null);
    setError('');
    setLoading(Boolean(path));
    let again = false;
    const run = (queue = false): Promise<void> => {
      if (!path || !active) return Promise.resolve();
      if (flight) {
        if (queue) again = true;
        return flight;
      }
      setLoading(true);
      flight = (async () => {
        do {
          again = false;
          controller = new AbortController();
          const request = controller;
          let timedOut = false;
          const timeout = window.setTimeout(() => {
            timedOut = true;
            request.abort();
          }, 15_000);
          try {
            const value = await read(path, request.signal);
            if (active) {
              setData(value as T);
              setError('');
            }
          } catch (err) {
            if (active) {
              if (lostAccess(err)) setData(null);
              setError(describe(timedOut ? { name: 'TimeoutError' } : err));
            }
          } finally {
            window.clearTimeout(timeout);
          }
        } while (again && active);
      })().finally(() => {
        flight = null;
        if (active) setLoading(false);
      });
      return flight;
    };
    refreshRef.current = () => run(true);
    void run();
    const timer = window.setInterval(() => void run(), POLL_MS);
    const visible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [path, read]);
  return { data, error, loading, refresh };
}

function ReadError({
  error,
  loading,
  retry,
}: {
  error: string;
  loading: boolean;
  retry: () => Promise<void>;
}) {
  return (
    <div className="msg-compose">
      <p className="form-error" role="alert">
        {error}
      </p>
      <button className="button secondary" disabled={loading} onClick={() => void retry()}>
        {loading ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

/** Unacknowledged counts per agent inbox, from the inbox cursors. */
export function useInboxSummary(enabled: boolean) {
  const { data, refresh } = usePoll<{ inboxes: InboxSummary[] }>(
    enabled ? '/api/messages/summary' : null,
  );
  const unread = new Map((data?.inboxes ?? []).map((item) => [item.agent_id, item.unread]));
  const capped = new Set(
    (data?.inboxes ?? []).filter((item) => item.unread_capped).map((item) => item.agent_id),
  );
  const total = [...unread.values()].reduce((sum, value) => sum + value, 0);
  return { unread, capped, total, refresh };
}

/** A send route: the sender is always one of your agents; the recipient may be another owner's. */
type Route = { from: Agent; to: { id: string; name: string } };
/** Directional connections whose endpoints can currently exchange messages. */
function routesOf(snapshot: Snapshot, filter: (route: Route) => boolean = () => true): Route[] {
  const usable = (agent: Agent | undefined): agent is Agent =>
    Boolean(agent && agent.status !== 'revoked' && !agent.pausedAt);
  const routes: Route[] = [];
  for (const connection of snapshot.connections) {
    const from = snapshot.agents.find((agent) => agent.id === connection.fromAgentId);
    const to = snapshot.agents.find((agent) => agent.id === connection.toAgentId);
    if (usable(from) && usable(to) && filter({ from, to })) routes.push({ from, to });
  }
  return routes;
}
const routeKey = (route: Route) => `${route.from.id}:${route.to.id}`;

/**
 * A short label for a data part. For city.desk/v1 it says what the message says (the fold, not the
 * UI, decides grants), always naming the claim when there is one. Values are untrusted labels.
 */
function dataLabel(data: unknown, sender: string): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Shared data';
  const item = data as Record<string, unknown>;
  if (item.schema !== 'city.desk/v1') return 'Shared data';
  const field = (key: string) => {
    const value = item[key];
    return typeof value === 'string' && value ? value.slice(0, 80) : '';
  };
  const claim = field('claim_id') ? `claim ${field('claim_id')}` : '';
  const on = claim ? ` for ${claim}` : '';
  switch (item.kind) {
    case 'session.register':
      return `${sender} registered`;
    case 'claim.request':
      return `${sender} requested ${claim || 'a claim'}`;
    case 'claim.heartbeat':
      return `${sender}: heartbeat${on}`;
    case 'claim.status':
      return `${sender}: ${claim || 'claim'} → ${field('status') || 'status update'}`;
    case 'claim.amend':
      return `${sender} amended ${claim || 'a claim'}`;
    case 'claim.reconcile':
      return `${sender} reconciled ${claim || 'a claim'}`;
    case 'review.request':
      return `${sender} requested review${on}`;
    case 'review.result':
      return `${sender} reviewed ${claim || 'a claim'}: ${field('verdict') || 'result'}`;
    case 'handoff':
      return `${sender}: handoff${on}`;
    case 'note':
      return `${sender}: note${on}`;
    default:
      return `${sender}: desk update${on}`;
  }
}
function preview(message: AgentMessage): string {
  const text = message.parts.find((part) => part.type === 'text');
  // The inbox line shows a code block's text without its fences.
  if (text && text.type === 'text')
    return splitCode(text.text)
      .map((segment) => (segment.type === 'code' ? segment.code : segment.text))
      .join(' ');
  const data = message.parts.find((part) => part.type === 'data');
  return data?.type === 'data' ? dataLabel(data.data, message.from_agent_name) : 'Message';
}

type ChatGroup = ConversationSummary & {
  /** Stable identity of the chat: it survives re-sorting and new contexts joining the group. */
  key: string;
  contexts: string[];
  /** The raw per-context summaries, used to page and refresh each context. */
  items: ConversationSummary[];
  desk?: boolean;
};
function groupConversations(items: ConversationSummary[]): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  // The explicit desk context identifies its mailbox without hardcoding workspace IDs.
  const deskRecipients = new Set(
    items
      .filter((item) => item.context_id === 'city-desk')
      .map((item) => item.last_message.to_agent_id),
  );
  for (const item of items) {
    // Explicit shared room contexts stay distinct; legacy implicit UUID contexts group by peers.
    const explicit = !/^[0-9a-f-]{36}$/i.test(item.context_id);
    const desk =
      item.context_id === 'city-desk' ||
      (!explicit && deskRecipients.has(item.last_message.to_agent_id));
    const key = desk
      ? 'room:city-desk'
      : explicit
        ? `room:${item.context_id}`
        : `peers:${[...item.participants].sort().join(':')}`;
    const existing = groups.get(key);
    if (existing) {
      existing.contexts.push(item.context_id);
      existing.items.push(item);
      existing.message_count += item.message_count;
      existing.participants = [...new Set([...existing.participants, ...item.participants])];
      if (item.last_message.created_at > existing.last_message.created_at)
        existing.last_message = item.last_message;
    } else groups.set(key, { ...item, key, contexts: [item.context_id], items: [item], desk });
  }
  return [...groups.values()];
}

type ConversationPage = { messages: AgentMessage[]; has_more: boolean; next_before: string | null };
/** Paging state of one context: its oldest loaded message and the cursor for the page before. */
type ContextState = {
  loaded: boolean;
  before: string | null;
  more: boolean;
  oldest: string | null;
};
const byTime = (a: AgentMessage, b: AgentMessage) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * One chat thread, loaded newest page first and merged by message id. Polls and sends only ever
 * add messages; nothing is cleared except when access is lost or another chat is opened. A chat
 * can span several contexts (legacy peer threads): only messages newer than every context's
 * unloaded history are shown, so the view never has gaps.
 */
function useThread(workspace: string, groupKey: string | null, items: ConversationSummary[]) {
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const store = useRef({
    key: null as string | null,
    byId: new Map<string, AgentMessage>(),
    contexts: new Map<string, ContextState>(),
    /** Last message id per context as of our latest read of it (or of the summary). */
    seen: new Map<string, string>(),
  });
  const actions = useRef({
    refresh: async () => {},
    older: async () => {},
    poll: async () => {},
    add: (_message: AgentMessage) => {},
    trim: (_keep: number) => {},
  });

  /** Lower time bound of the gap-free window: the newest point where unloaded history starts. */
  const floorOf = (list: ConversationSummary[]) => {
    let floor: string | null = null;
    for (const item of list) {
      const state = store.current.contexts.get(item.context_id);
      const bound = !state?.loaded
        ? item.last_message.created_at
        : state.more
          ? state.oldest
          : null;
      if (bound && (!floor || bound > floor)) floor = bound;
    }
    return floor;
  };
  const visibleOf = (list: ConversationSummary[]) => {
    const floor = floorOf(list);
    return [...store.current.byId.values()]
      .filter((message) => !floor || message.created_at >= floor)
      .sort(byTime);
  };

  useEffect(() => {
    store.current = { key: groupKey, byId: new Map(), contexts: new Map(), seen: new Map() };
    setVersion((value) => value + 1);
    setReady(false);
    setError('');
    setLoading(Boolean(groupKey));
    setLoadingOlder(false);
    if (!groupKey) return;
    let active = true;
    let loaded = false;
    let controller: AbortController | null = null;
    let chain: Promise<void> = Promise.resolve();
    let busy = false;
    const bump = () => active && setVersion((value) => value + 1);

    const read = async (context: string, before: string | null, signal: AbortSignal) => {
      const path = pagePath(context, before);
      const early = before ? null : takePrefetched(workspace, path);
      const value = early ? await early : await readJson(path, signal);
      if (value === null) throw new Error("Messages couldn't be loaded. Try again.");
      return value as ConversationPage;
    };

    const merge = (context: string, page: ConversationPage, older: boolean) => {
      const { byId, contexts, seen } = store.current;
      let state = contexts.get(context);
      if (older && state) {
        state.before = page.next_before;
        state.more = page.has_more;
      } else {
        const overlaps = page.messages.some((message) => byId.has(message.id));
        if (!state?.loaded || (page.has_more && !overlaps)) {
          // First read of this context, or more new messages than one page: restart from here.
          if (state?.loaded)
            for (const [id, message] of byId) if (message.context_id === context) byId.delete(id);
          state = { loaded: true, before: page.next_before, more: page.has_more, oldest: null };
        }
        const newest = page.messages.at(-1);
        if (newest) seen.set(context, newest.id);
      }
      for (const message of page.messages) {
        byId.set(message.id, message);
        if (!state.oldest || message.created_at < state.oldest) state.oldest = message.created_at;
      }
      contexts.set(context, state);
    };

    /** Runs one bounded operation at a time; late results for another chat are dropped. */
    const run = (task: (signal: AbortSignal) => Promise<void>, queue: boolean) => {
      if (busy && !queue) return chain;
      const next = chain.then(async () => {
        if (!active) return;
        busy = true;
        controller = new AbortController();
        const request = controller;
        let timedOut = false;
        const timeout = window.setTimeout(() => {
          timedOut = true;
          request.abort();
        }, 15_000);
        try {
          await task(request.signal);
          if (active) setError('');
        } catch (err) {
          if (!active) return;
          if (lostAccess(err)) {
            store.current = {
              key: groupKey,
              byId: new Map(),
              contexts: new Map(),
              seen: new Map(),
            };
            loaded = false;
            setReady(false);
            bump();
          }
          setError(describe(timedOut ? { name: 'TimeoutError' } : err));
        } finally {
          window.clearTimeout(timeout);
          busy = false;
        }
      });
      chain = next;
      return next;
    };

    /** Loads pages (newest first, several contexts at once) until `target` messages show. */
    const fill = async (target: number, signal: AbortSignal) => {
      for (let round = 0; round < 40; round++) {
        const list = itemsRef.current;
        if (visibleOf(list).length >= target) return;
        const candidates = list
          .map((item) => {
            const state = store.current.contexts.get(item.context_id);
            const bound = !state?.loaded
              ? item.last_message.created_at
              : state.more
                ? state.oldest
                : null;
            return { item, state, bound };
          })
          .filter((entry) => entry.bound !== null)
          .sort((a, b) => b.bound!.localeCompare(a.bound!))
          .slice(0, WAVE);
        if (!candidates.length) return;
        const pages = await Promise.all(
          candidates.map(({ item, state }) =>
            read(item.context_id, state?.loaded ? state.before : null, signal),
          ),
        );
        if (!active) return;
        candidates.forEach(({ item, state }, index) =>
          merge(item.context_id, pages[index]!, Boolean(state?.loaded)),
        );
        bump();
      }
    };

    const initial = async (signal: AbortSignal) => {
      setLoading(true);
      try {
        const { seen } = store.current;
        for (const item of itemsRef.current) seen.set(item.context_id, item.last_message.id);
        await fill(PAGE, signal);
        if (!active) return;
        loaded = true;
        setReady(true);
      } finally {
        if (active) setLoading(false);
      }
    };

    /** New messages: re-read the newest page of every context whose summary changed. */
    const poll = async (signal: AbortSignal) => {
      if (!loaded) return initial(signal);
      const list = itemsRef.current;
      const { seen } = store.current;
      const newest = [...list].sort((a, b) =>
        b.last_message.created_at.localeCompare(a.last_message.created_at),
      )[0];
      const changed = list.filter(
        (item) => item === newest || seen.get(item.context_id) !== item.last_message.id,
      );
      for (let start = 0; start < changed.length; start += WAVE) {
        const wave = changed.slice(start, start + WAVE);
        const pages = await Promise.all(wave.map((item) => read(item.context_id, null, signal)));
        if (!active) return;
        wave.forEach((item, index) => merge(item.context_id, pages[index]!, false));
      }
      bump();
    };

    /** Drops all but the newest `keep` shown messages; each context pages again from its oldest. */
    const trim = async (keep: number) => {
      const list = itemsRef.current;
      const visible = visibleOf(list);
      if (visible.length <= keep) return;
      const kept = new Set(visible.slice(-keep).map((message) => message.id));
      const { byId, contexts } = store.current;
      const dropped = new Set<string>();
      for (const [id, message] of byId)
        if (!kept.has(id)) {
          byId.delete(id);
          dropped.add(message.context_id);
        }
      for (const context of dropped) {
        const state = contexts.get(context);
        if (!state) continue;
        const remaining = [...byId.values()]
          .filter((message) => message.context_id === context)
          .sort(byTime);
        // Nothing left: the context counts as unread history again, bounded by its summary.
        if (!remaining.length) contexts.delete(context);
        else
          contexts.set(context, {
            loaded: true,
            before: cursorOf(remaining[0]!),
            more: true,
            oldest: remaining[0]!.created_at,
          });
      }
      bump();
    };

    let olderQueued = false;
    actions.current = {
      refresh: () => run(poll, true),
      poll: () => run(poll, false),
      // A scroll-up during a refresh is queued behind it, once, instead of dropped.
      older: () => {
        if (!loaded || olderQueued) return Promise.resolve();
        olderQueued = true;
        return run(async (signal) => {
          olderQueued = false;
          setLoadingOlder(true);
          try {
            await fill(visibleOf(itemsRef.current).length + PAGE, signal);
          } finally {
            if (active) setLoadingOlder(false);
          }
        }, true);
      },
      trim: (keep) => void run(() => trim(keep), true),
      add: (message) => {
        const { byId, contexts, seen } = store.current;
        byId.set(message.id, message);
        seen.set(message.context_id, message.id);
        if (!contexts.has(message.context_id))
          contexts.set(message.context_id, {
            loaded: true,
            before: null,
            more: false,
            oldest: message.created_at,
          });
        bump();
      },
    };
    void run(initial, true);
    const timer = window.setInterval(() => void run(poll, false), POLL_MS);
    const visible = () => {
      if (document.visibilityState === 'visible') void run(poll, false);
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
    // Items are read through a ref: a re-sorted or refreshed list must not restart the thread.
  }, [groupKey]);

  // A list refresh that shows a message we have not read triggers an immediate thread read.
  const signature = items.map((item) => `${item.context_id}:${item.last_message.id}`).join(',');
  useEffect(() => {
    if (!ready) return;
    const { seen } = store.current;
    if (items.some((item) => seen.get(item.context_id) !== item.last_message.id))
      void actions.current.poll();
  }, [signature, ready]);

  // Until the effect has switched the store, render nothing from the previously open chat.
  const current = store.current.key === groupKey;
  const messages = useMemo(() => (current ? visibleOf(items) : []), [version, signature, current]);
  const hasOlder = useMemo(() => current && floorOf(items) !== null, [version, signature, current]);
  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadOlder = useCallback(() => actions.current.older(), []);
  const add = useCallback((message: AgentMessage) => actions.current.add(message), []);
  const trim = useCallback((keep: number) => actions.current.trim(keep), []);
  return {
    trim,
    messages,
    ready: ready && current,
    error: current ? error : '',
    loading,
    loadingOlder: loadingOlder && current,
    hasOlder,
    refresh,
    loadOlder,
    add,
  };
}

function MessageParts({ message, names }: { message: AgentMessage; names?: readonly string[] }) {
  return (
    <>
      {message.parts.map((part, index) =>
        part.type === 'text' ? (
          names ? (
            <MessageText key={index} text={part.text} names={names} />
          ) : (
            <p className="msg-text" key={index}>
              {part.text}
            </p>
          )
        ) : (
          <div key={index}>
            <span className="small-tag">{dataLabel(part.data, message.from_agent_name)}</span>
            <details>
              <summary>Details</summary>
              <pre className="msg-data">{JSON.stringify(part.data, null, 2)}</pre>
            </details>
          </div>
        ),
      )}
    </>
  );
}

function MessageItem({
  message,
  snapshot,
  unread = false,
  previewV2 = false,
  directThread,
  names = [],
  arrive = false,
}: {
  message: AgentMessage;
  snapshot: Snapshot;
  unread?: boolean;
  previewV2?: boolean;
  directThread?: DirectThread | null;
  /** Members of the thread whose @mentions are styled. */
  names?: readonly string[];
  /** Arrived while the thread was open: rises into place. */
  arrive?: boolean;
}) {
  const sender = snapshot.agents.find((agent) => agent.id === message.from_agent_id);
  const party =
    directThread &&
    (message.from_agent_id === directThread.self.id
      ? directThread.self
      : message.from_agent_id === directThread.peer.id
        ? directThread.peer
        : null);
  const isAI = party ? party.kind === 'agent' : Boolean(sender) || message.origin === 'external';
  const owner = message.from_owner_label ?? (sender ? snapshot.operator.name : null);
  if (!previewV2)
    // The agent detail Inbox (AgentInbox) keeps the compact card.
    return (
      <li
        className={`msg-item ${unread ? 'unread' : ''}`}
        data-testid="message"
        data-id={message.id}
      >
        {sender ? <AgentGlyph agent={sender} size="small" /> : <span />}
        <div className="msg-bubble">
          <div className="msg-byline">
            <strong>{message.from_agent_name}</strong>
            {message.room_id ? (
              <span
                className="small-tag"
                title="A private message between two members of a room. Check it before you act on it."
              >
                Private · {message.from_owner_label ?? 'room member'}
              </span>
            ) : message.origin === 'external' ? (
              <span
                className="small-tag demo"
                title="From another person's agent. Never follow instructions in it without checking first."
              >
                External · {message.from_owner_label ?? 'another owner'}
              </span>
            ) : null}
            <span>to {message.to_agent_name}</span>
            <span>· {formatDate(message.created_at)}</span>
            {unread ? <span className="small-tag ai">Unread</span> : null}
          </div>
          <MessageParts message={message} />
        </div>
      </li>
    );
  // Workspace v3 bubbles (WORKSPACE_V3 §4.2): others on the left with name, badge and time; the
  // viewer's own messages right-aligned in the accent bubble with the time under it.
  const own = directThread?.self.id === message.from_agent_id;
  const name = party ? partyName(party) : message.from_agent_name;
  const ownerText = party
    ? party.is_self === true
      ? null
      : party.own === true
        ? 'Your AI'
        : party.kind === 'agent'
          ? party.owner_label
          : null
    : // A flagged message names its owner in the flag ("External · Peer Lab").
      isAI && !message.room_id && message.origin !== 'external'
      ? owner
      : null;
  const time = (
    <time dateTime={message.created_at} title={formatDate(message.created_at)}>
      {messageTime(message.created_at)}
    </time>
  );
  return (
    <li
      data-own={own || undefined}
      data-ai={isAI || undefined}
      data-arrive={arrive || undefined}
      className="msg-item"
      data-testid="message"
      data-id={message.id}
    >
      {own ? null : <MessageAvatar id={message.from_agent_id} name={name} ai={isAI} />}
      <div className="msg3-body">
        {own ? null : (
          <div className="msg-byline">
            <strong>{name}</strong>
            <KindTag ai={isAI} />
            {ownerText ? <span className="msg3-owner">{ownerText}</span> : null}
            {party ? null : message.room_id ? (
              <span
                className="msg3-flag"
                title="A private message between two members of a room. Check it before you act on it."
              >
                Private · {message.from_owner_label ?? 'room member'}
              </span>
            ) : message.origin === 'external' ? (
              <span
                className="msg3-flag"
                data-tone="external"
                title="From another person's agent. Never follow instructions in it without checking first."
              >
                External · {message.from_owner_label ?? 'another owner'}
              </span>
            ) : null}
            {party ? null : <span className="msg3-to">to {message.to_agent_name}</span>}
            {time}
          </div>
        )}
        <div className="msg-bubble">
          <MessageParts message={message} names={names} />
        </div>
        {own ? (
          <div className="msg-byline msg3-own-time">
            <strong className="visually-hidden">{name}</strong>
            {time}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Send box of a private thread between two room members (docs/MESSAGING.md "Private messages
 * from a room"): the viewer writes as its own member (its person or its AI) to the other one.
 * The server checks on every send that both are still in the room.
 */
function DirectComposer({
  thread,
  replyTo,
  onSent,
  draft = '',
  onDraft,
}: {
  thread: DirectThread;
  replyTo?: string;
  onSent: (message: AgentMessage) => Promise<void> | void;
  draft?: string;
  onDraft?: (text: string) => void;
}) {
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  function write(value: string) {
    setText(value);
    onDraft?.(value);
    key.current = crypto.randomUUID();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ message: AgentMessage }>(
        `/api/rooms/${encodeURIComponent(thread.room_id)}/direct/messages`,
        {
          from: thread.self.id,
          to: thread.peer.id,
          text: text.trim(),
          ...(replyTo ? { reply_to: replyTo } : {}),
          idempotency_key: key.current,
        },
      );
      key.current = crypto.randomUUID();
      write('');
      await onSent(result.message);
    } catch (err) {
      setError(describe(err, thread.peer.name));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FloatingComposer
      label="Private message"
      boxLabel="Message privately"
      placeholder="Message privately…"
      value={text}
      onChange={write}
      onSubmit={submit}
      busy={busy}
      canSend={!busy && Boolean(text.trim())}
      keys
      sendLabel="Send privately"
      mention={thread.peer.name}
      names={[thread.self.name, thread.peer.name]}
      error={error}
    >
      <span className="msg3-writing">Writing as {thread.self.name}</span>
    </FloatingComposer>
  );
}

/** Owner-as-agent send box. The owner writes as the selected sending agent. */
function Composer({
  routes,
  contextId,
  replyTo,
  paused,
  onSent,
  label = 'Send a message',
  previewV2 = false,
  draft = '',
  onDraft,
}: {
  routes: Route[];
  contextId?: string;
  replyTo?: (route: Route) => string | undefined;
  paused: boolean;
  onSent: (message: AgentMessage) => Promise<void> | void;
  label?: string;
  /** The Messages page's floating composer; the agent detail Inbox keeps the compact form. */
  previewV2?: boolean;
  /** Initial text, so a draft survives switching chats. */
  draft?: string;
  onDraft?: (text: string) => void;
}) {
  // Empty selection follows the default (first) route until the owner picks one or starts
  // writing: a new message arriving mid-draft must not switch who the draft is sent as.
  const [selected, setSelected] = useState('');
  const [frozen, setFrozen] = useState('');
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const route =
    routes.find((item) => routeKey(item) === selected) ??
    routes.find((item) => routeKey(item) === frozen) ??
    routes[0];
  function write(value: string) {
    setText(value);
    onDraft?.(value);
    key.current = crypto.randomUUID();
    if (!selected && route && value && !frozen) setFrozen(routeKey(route));
    if (!value) setFrozen('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!route || !text.trim() || busy || paused) return;
    setBusy(true);
    setError('');
    try {
      const reply = replyTo?.(route);
      const result = await api<{ message: AgentMessage }>(`/api/agents/${route.from.id}/messages`, {
        to_agent_id: route.to.id,
        text: text.trim(),
        ...(reply ? { reply_to: reply } : contextId ? { context_id: contextId } : {}),
        idempotency_key: key.current,
      });
      key.current = crypto.randomUUID();
      write('');
      await onSent(result.message);
    } catch (err) {
      setError(describe(err, route.to.name));
    } finally {
      setBusy(false);
    }
  }
  if (!routes.length)
    return (
      <div className="msg-compose">
        <div className="info-note">
          <ShieldCheck size={17} />
          <p>
            Agents can only message agents they are connected to. Connect the two agents under
            Connections first.
          </p>
        </div>
      </div>
    );
  const sendAs = (
    <select
      value={route ? routeKey(route) : ''}
      disabled={busy}
      onChange={(event) => {
        setSelected(event.target.value);
        key.current = crypto.randomUUID();
      }}
    >
      {routes.map((item) => (
        <option key={routeKey(item)} value={routeKey(item)}>
          {item.from.name} → {item.to.name}
        </option>
      ))}
    </select>
  );
  if (previewV2)
    return (
      <FloatingComposer
        label={label}
        boxLabel="Message text"
        placeholder={route ? `Write as ${route.from.name} to ${route.to.name}…` : ''}
        value={text}
        onChange={write}
        onSubmit={submit}
        busy={busy}
        canSend={!busy && !paused && Boolean(text.trim())}
        keys={!paused}
        sendLabel="Send message"
        mention={route?.to.name ?? null}
        names={routes.flatMap((item) => [item.from.name, item.to.name])}
        error={error}
      >
        <label className="msg3-sendas">
          <span className="visually-hidden">Send as</span>
          {sendAs}
        </label>
        {paused ? <span className="msg3-writing">Workspace is paused</span> : null}
      </FloatingComposer>
    );
  return (
    <form className="msg-compose" onSubmit={submit} aria-label={label}>
      <div className="msg-compose-row">
        <label>
          Send as
          {sendAs}
        </label>
      </div>
      <textarea
        aria-label="Message text"
        value={text}
        maxLength={16_384}
        // Read-only (not disabled) while sending, so focus and the caret stay in the box.
        readOnly={busy}
        aria-busy={busy}
        placeholder={route ? `Write as ${route.from.name} to ${route.to.name}…` : ''}
        onChange={(event) => write(event.target.value)}
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="msg-compose-row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">
          You are writing as {route?.from.name}. It arrives in {route?.to.name}'s inbox.
        </span>
        <button className="button primary" disabled={busy || paused || !text.trim()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          {paused ? 'Workspace is paused' : busy ? 'Sending…' : 'Send message'}
        </button>
      </div>
    </form>
  );
}

/**
 * The scrolling message list. Opens at the newest message, follows new ones while the reader is
 * at the bottom, keeps the reading position when older pages load above, and otherwise offers
 * "New messages".
 */
function ThreadMessages({
  visible = true,
  previewV2 = false,
  directThread,
  messages,
  snapshot,
  hasOlder,
  loadingOlder,
  onOlder,
  onTrim,
  follow,
  names = [],
}: {
  visible?: boolean;
  previewV2?: boolean;
  directThread?: DirectThread | null;
  /** Members of the thread whose @mentions are styled. */
  names?: readonly string[];
  messages: AgentMessage[];
  snapshot: Snapshot;
  hasOlder: boolean;
  loadingOlder: boolean;
  onOlder: () => void;
  /** Called while the reader is at the bottom and the list has grown long. */
  onTrim: (keep: number) => void;
  /** Changes when the owner sent a message: always scroll to it. */
  follow: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef<{ first?: string; last?: string; anchor: number; follow: number }>({
    anchor: 0,
    follow,
  });
  const [unseen, setUnseen] = useState(0);
  // Messages newer than the newest one of the previous render arrived while the thread was open:
  // they rise into place (older pages loaded above and the first page do not).
  const arrived = useRef(new Set<string>());
  const newest = useRef<string | null>(null);
  const latest = messages.at(-1);
  if (latest && newest.current !== latest.id) {
    if (newest.current) {
      const from = messages.findIndex((message) => message.id === newest.current);
      if (from >= 0)
        for (const message of messages.slice(from + 1)) arrived.current.add(message.id);
    }
    newest.current = latest.id;
  }
  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setUnseen(0);
  };
  useLayoutEffect(() => {
    if (visible && pinned.current) toBottom();
  }, [visible]);
  const offsetOf = (id: string | undefined) =>
    id
      ? (scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.offsetTop ??
        null)
      : null;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const before = previous.current;
    const first = messages[0]?.id;
    const last = messages.at(-1)?.id;
    if (!before.last) {
      if (last) toBottom();
    } else {
      // Older messages above: keep the message that was first where it was on screen.
      if (first !== before.first) {
        const now = offsetOf(before.first);
        if (now !== null) element.scrollTop += now - before.anchor;
        else if (pinned.current) toBottom(); // trimmed from the top while at the bottom
      }
      if (last !== before.last) {
        if (pinned.current || follow !== before.follow) toBottom();
        else {
          const index = messages.findIndex((message) => message.id === before.last);
          setUnseen((count) => count + (index < 0 ? 1 : messages.length - 1 - index));
        }
      }
    }
    previous.current = { first, last, anchor: offsetOf(first) ?? 0, follow };
    if (pinned.current && messages.length > TRIM_AT) onTrim(KEEP);
  }, [messages, follow, onTrim]);
  // A first page shorter than the viewport cannot be scrolled up: load more right away. A thread
  // waiting behind the inbox has no height yet, so it waits until it is shown.
  useEffect(() => {
    const element = scroller.current;
    if (
      visible &&
      element &&
      element.clientHeight > 0 &&
      hasOlder &&
      !loadingOlder &&
      element.scrollHeight <= element.clientHeight
    )
      onOlder();
  }, [messages, hasOlder, loadingOlder, onOlder, visible]);
  return (
    <div className="msg-thread-body">
      <div
        className="msg-viewport"
        ref={scroller}
        data-testid="thread-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_PX;
          if (pinned.current) setUnseen(0);
          if (element.scrollTop < OLDER_PX && hasOlder && !loadingOlder) onOlder();
        }}
      >
        {hasOlder || loadingOlder ? (
          <div className="msg-older">
            {loadingOlder ? (
              <span role="status">
                <LoaderCircle className="spin" size={14} /> Loading earlier messages…
              </span>
            ) : (
              <button type="button" onClick={onOlder}>
                Load earlier messages
              </button>
            )}
          </div>
        ) : null}
        <ol aria-label="Thread messages">
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              snapshot={snapshot}
              previewV2={previewV2}
              directThread={directThread}
              names={names}
              arrive={arrived.current.has(message.id)}
            />
          ))}
        </ol>
      </div>
      {unseen ? (
        <button type="button" className="msg-jump" onClick={toBottom}>
          New messages
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Approved cross-owner connections from one of your live agents (docs/AI_WORKSPACES.md): the
 * only agent → agent routes "New message" offers. Your own agents talking to each other would be
 * you messaging yourself, so those routes stay in each agent's Inbox panel only.
 */
function useCrossRoutes(snapshot: Snapshot, enabled: boolean): Route[] {
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api<{ outgoing: ConnectionRequest[] }>('/api/v2/connections/requests')
      .then((lists) => active && setRequests(lists.outgoing ?? []))
      .catch(() => active && setRequests([]));
    return () => {
      active = false;
    };
  }, [enabled]);
  return useMemo(() => {
    const routes: Route[] = [];
    const seen = new Set<string>();
    for (const request of requests) {
      if (request.status !== 'approved') continue;
      const from = snapshot.agents.find((agent) => agent.id === request.from_agent_id);
      if (!from || from.status === 'revoked' || from.pausedAt) continue;
      // Never your own agent, even if a request somehow names one.
      if (snapshot.agents.some((agent) => agent.id === request.to_agent_id)) continue;
      const route = {
        from,
        to: { id: request.to_agent_id, name: request.to_agent_name ?? 'Connected agent' },
      };
      if (seen.has(routeKey(route))) continue;
      seen.add(routeKey(route));
      routes.push(route);
    }
    return routes;
  }, [requests, snapshot.agents]);
}

/** Members of your rooms you can message privately (GET /api/messages/recipients). */
function useRecipients(reload: boolean) {
  const [state, setState] = useState<{ items: DirectRecipient[] | null; error: string }>({
    items: null,
    error: '',
  });
  useEffect(() => {
    let active = true;
    // Loaded once for the inbox (whether New message has anyone to offer) and again whenever
    // New message opens; the last list stays while it reloads.
    api<{ recipients: DirectRecipient[] }>('/api/messages/recipients')
      .then((result) => active && setState({ items: result.recipients, error: '' }))
      .catch(
        (err) => active && setState((prev) => ({ items: prev.items ?? [], error: describe(err) })),
      );
    return () => {
      active = false;
    };
  }, [reload]);
  return state;
}

const recipientKey = (item: DirectRecipient) => `${item.room_id}.${item.member_id}`;
const recipientRole = (item: DirectRecipient) =>
  item.kind === 'person' ? 'Person' : item.own ? 'Your AI' : 'AI';

/**
 * "New message": the main action is a private message to someone you share a room with (a
 * person, another owner's AI, your own AI or an invited guest); it opens the pair's one thread.
 * Connected agents of other owners follow, when there are any. With neither, the guidance says
 * where private messages start instead of offering a composer that cannot send.
 */
function NewMessage({
  recipients,
  error: loadError,
  crossRoutes,
  paused,
  previewV2,
  onOpen,
  onSent,
  draft,
  onDraft,
}: {
  recipients: DirectRecipient[] | null;
  error: string;
  crossRoutes: Route[];
  paused: boolean;
  previewV2: boolean;
  onOpen: (recipient: DirectRecipient) => Promise<void>;
  onSent: (message: AgentMessage) => Promise<void> | void;
  draft: string;
  onDraft: (text: string) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (recipients === null)
    return (
      <p role="status" className="muted small msg-new-loading">
        Loading who you can message…
      </p>
    );
  const target = recipients.find((item) => recipientKey(item) === chosen) ?? recipients[0];
  const rooms = [...new Set(recipients.map((item) => item.room_id))];
  async function open(event: FormEvent) {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await onOpen(target);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }
  if (!recipients.length && !crossRoutes.length)
    return (
      <div className="msg-new msg-new-empty" role="status">
        <p>
          <strong>No one to message yet.</strong> You message people and AIs privately from a room
          you share with them: open a room, then choose Message on a member. Private messages never
          post to room feeds.
        </p>
        {loadError ? <p className="form-error">{loadError}</p> : null}
        <a className="button primary" href="/rooms">
          <House size={15} aria-hidden="true" />
          Go to rooms
        </a>
      </div>
    );
  return (
    <div className="msg-new">
      {recipients.length ? (
        <form className="msg-compose" aria-label="Message someone from a room" onSubmit={open}>
          <h4 className="msg-new-title">Message someone from a room</h4>
          <label>
            To
            <select
              value={target ? recipientKey(target) : ''}
              disabled={busy}
              onChange={(event) => setChosen(event.target.value)}
            >
              {rooms.map((room) => {
                const members = recipients.filter((item) => item.room_id === room);
                return (
                  <optgroup key={room} label={roomOrigin(members[0]!.room_name)}>
                    {members.map((item) => (
                      <option key={recipientKey(item)} value={recipientKey(item)}>
                        {item.name} · {recipientRole(item)}
                        {item.owner_label && item.kind === 'agent' ? ` · ${item.owner_label}` : ''}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="msg-compose-row" style={{ justifyContent: 'space-between' }}>
            <span className="muted small">
              A private 1:1 chat. Nobody else in the room sees it.
            </span>
            <button className="button primary" disabled={busy || !target}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
              {busy ? 'Opening…' : 'Open chat'}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted small msg-new-hint">
          To message a person or AI privately, open a room you share and choose Message on them.{' '}
          <a href="/rooms">Go to rooms</a>
        </p>
      )}
      {crossRoutes.length ? (
        <>
          <h4 className="msg-new-title">Or write to a connected agent of another owner</h4>
          <Composer
            previewV2={previewV2}
            key="new"
            label="New conversation"
            routes={crossRoutes}
            paused={paused}
            onSent={onSent}
            draft={draft}
            onDraft={onDraft}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The thread top bar's ⋯ menu: Details (who, where from, how many messages) and Delete
 * conversation. "Delete conversation" hides the chat from your Messages only
 * (POST /api/messages/conversations/:context/hide): the other side keeps its copy, AIs keep the
 * messages in their inbox, and a newer message brings the chat back.
 */
function ThreadMenu({ onDetails, onDelete }: { onDetails: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div
      className="msg-menu"
      ref={ref}
      onKeyDown={(event) => {
        if (!open) return;
        const items = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
        ];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const move = (index: number) => {
          event.preventDefault();
          items[(index + items.length) % items.length]?.focus();
        };
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
        } else if (event.key === 'ArrowDown') move(at + 1);
        else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
        else if (event.key === 'Home') move(0);
        else if (event.key === 'End') move(-1);
        // Tab leaves the menu and closes it; focus moves on as usual.
        else if (event.key === 'Tab') setOpen(false);
      }}
    >
      <button
        type="button"
        className="msg-menu-button msg3-round"
        aria-label="Conversation actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div className="msg-menu-list" role="menu" aria-label="Conversation actions">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            autoFocus
            onClick={() => {
              setOpen(false);
              onDetails();
            }}
          >
            <Info size={15} aria-hidden="true" />
            Details
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="msg-menu-danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            Delete conversation
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The compact confirm for "Delete conversation": honest about what stays where. */
function DeleteConversationDialog({
  peer,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  /** The other side of a private chat, when there is one. */
  peer: { name: string; kind: 'agent' | 'person' } | null;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const other =
    peer?.kind === 'person'
      ? 'The other person keeps their copy.'
      : peer
        ? `${peer.name} and its owner keep their copy.`
        : 'The agents keep their copies.';
  return (
    <ConfirmDialog
      title="Delete conversation?"
      confirmLabel={busy ? 'Deleting…' : 'Delete'}
      busy={busy}
      error={error || undefined}
      onConfirm={onConfirm}
      onClose={onCancel}
    >
      <p>
        It's removed from your Messages. {other} Messages already delivered stay in each AI's inbox,
        and a new message brings the conversation back.
      </p>
    </ConfirmDialog>
  );
}

/**
 * Messages with no connected agent pair: the composer can't send anything (it only sends agent
 * to agent along a connection), so instead of a dead-end "Write the first message" this offers
 * the two real ways in, without explanation text (#587).
 */
function NoRoutesGuide({ onOpenConnections }: { onOpenConnections: () => void }) {
  return (
    <div className="card empty msg-v2-state">
      <span className="msg-v2-state-icon" aria-hidden="true">
        <MessagesSquare size={24} />
      </span>
      <div role="status">
        <h3>No private messages yet</h3>
      </div>
      <div className="msg-start-actions">
        <div className="msg-start-action">
          <a
            className="button primary"
            href="/rooms"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
              event.preventDefault();
              navigate('/rooms');
            }}
          >
            <DoorOpen size={15} aria-hidden="true" />
            Message someone from a room
          </a>
        </div>
        <div className="msg-start-action">
          <button type="button" className="button secondary" onClick={onOpenConnections}>
            <Link2 size={15} aria-hidden="true" />
            Let your agents talk to each other
          </button>
        </div>
      </div>
    </div>
  );
}

const FILTERS: Array<{ id: InboxFilter; label: string; empty: string }> = [
  { id: 'all', label: 'All', empty: 'No conversations' },
  { id: 'unread', label: 'Unread', empty: 'No unread conversations' },
  { id: 'agents', label: 'Agents', empty: 'No conversations with an AI' },
];

/**
 * The Messages page (WORKSPACE_V3 §5). One view at a time: the inbox (a floating "Messages" pill
 * with the live unread count and New conversation, the All / Unread / Agents tabs and one card
 * list of conversations), or a thread (Back, the other side's pill and its ⋯ menu, the bubbles
 * and the floating composer). An open thread is its own history entry, so the system back
 * gesture returns to the inbox. Conversations are grouped by context_id.
 */
export function MessagesView({
  snapshot,
  unread,
  onOpenAgent,
  onSummaryChanged,
  direct,
  onOpenConnections,
}: {
  snapshot: Snapshot;
  unread: Map<string, number>;
  onOpenAgent: (id: string) => void;
  onSummaryChanged: () => void;
  /** Opens Connections, where two agents are connected so they can message each other. */
  onOpenConnections: () => void;
  /** "Message privately" from a room (#dm=<room>.<member>): open the pair's one thread. */
  direct?: { room: string; to: string } | null;
}) {
  const [threadOpen, setThreadOpen] = useState(Boolean(direct));
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [details, setDetails] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const newMessageRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const showThread = () => {
    setThreadOpen(true);
    setDetails(false);
    // The open thread is its own history entry, so the system back gesture returns to the
    // inbox instead of leaving Messages. The entry keeps the console's state (the view).
    if (!isThreadEntry(window.history.state))
      window.history.pushState({ ...window.history.state, [THREAD_ENTRY]: true }, '');
    // The thread replaces the inbox: bring its top bar (and Back) into view below the sticky
    // workspace bar (scroll-margin-top in messages-v2.css).
    requestAnimationFrame(() => {
      threadRef.current?.focus({ preventScroll: true });
      threadRef.current?.scrollIntoView({ block: 'start' });
    });
  };
  const closeThread = () => {
    setThreadOpen(false);
    setComposing(false);
    setDetails(false);
    requestAnimationFrame(() => {
      // The chat you came from, else (it may be filtered out) the first row, New conversation or
      // the current tab.
      const list = listRef.current;
      (
        list?.querySelector<HTMLButtonElement>('[aria-current="true"]') ??
        list?.querySelector<HTMLButtonElement>('.msg-list-item') ??
        newMessageRef.current ??
        tabsRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      )?.focus();
    });
  };
  // Back (and Escape) step back through the thread's history entry when there is one, so
  // in-page and system back stay in step. A thread opened by a deep link (#dm=) has no entry of
  // its own and closes in place.
  const showList = () => {
    if (isThreadEntry(window.history.state)) window.history.back();
    else closeThread();
  };
  const closeThreadRef = useRef(closeThread);
  closeThreadRef.current = closeThread;
  const threadOpenRef = useRef(threadOpen);
  threadOpenRef.current = threadOpen;
  // After a reload the page opens on the inbox, but the history entry may still be a thread's:
  // make it the inbox's again, so the next thread pushes its own entry and Back stays in Messages.
  useEffect(() => {
    if (!threadOpenRef.current && isThreadEntry(window.history.state)) {
      const { [THREAD_ENTRY]: _thread, ...rest } = window.history.state as Record<string, unknown>;
      window.history.replaceState(rest, '');
    }
  }, []);
  useEffect(() => {
    const pop = () => {
      if (isThreadEntry(window.history.state)) setThreadOpen(true);
      else if (threadOpenRef.current) closeThreadRef.current();
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const list = usePoll<{ conversations: ConversationSummary[] }>('/api/messages/conversations');
  // The private thread opened from a room, before (or after) its first message exists.
  const [opened, setOpened] = useState<DirectThread | null>(null);
  const [openError, setOpenError] = useState('');
  // While a room's private chat opens (directLoading), no other chat (the last one read, or the
  // newest) stands in for it: its send box would be on screen, and a quick message would reach
  // the wrong person.
  const [directLoading, setDirectLoading] = useState(Boolean(direct));
  // The inbox marks the chat you last opened (and Back returns focus to it).
  const [visited, setVisited] = useState(Boolean(direct));
  // Selection is a context id; its chat is whichever group contains it, so re-sorting or a new
  // context joining the group never changes which chat is open.
  const workspace = snapshot.operator.id;
  const [remembered] = useState(() => readLastChat(workspace));
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (remembered) prefetch(workspace, pagePath(remembered, null));
    // Leaving Messages (or switching workspace, which remounts it) drops unused prefetches.
    return () => prefetched.clear();
  }, [workspace, remembered]);
  useEffect(() => {
    if (!direct) return;
    let active = true;
    setOpenError('');
    setThreadOpen(true);
    setVisited(true);
    setDirectLoading(true);
    // A chat that was open meanwhile steps aside until this one has opened.
    setSelected(null);
    api<DirectThread>(`/api/rooms/${encodeURIComponent(direct.room)}/direct`, {
      to: direct.to,
    })
      .then((thread) => {
        if (!active) return;
        setOpened(thread);
        setComposing(false);
        setSelected(thread.context_id);
      })
      .catch((err) => active && setOpenError(describe(err)))
      .finally(() => active && setDirectLoading(false));
    return () => {
      active = false;
    };
  }, [direct]);
  const [follow, setFollow] = useState(0);
  const drafts = useRef(new Map<string, string>());
  // New conversation: people and AIs you share a room with, and other owners' connected agents.
  const recipients = useRecipients(composing);
  const crossRoutes = useCrossRoutes(snapshot, true);
  // New conversation needs someone to write to: a member of one of your rooms, or another
  // owner's agent along an approved connection. Without either, the guidance says where to start.
  const canCompose = (recipients.items?.length ?? 0) > 0 || crossRoutes.length > 0;
  // "Delete conversation" (the thread's ⋯ menu): the chat waiting for confirmation.
  const [deleting, setDeleting] = useState<{
    contexts: string[];
    peer: { name: string; kind: 'agent' | 'person' } | null;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  async function confirmDelete() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      for (const context of deleting.contexts)
        await api(`/api/messages/conversations/${encodeURIComponent(context)}/hide`, {});
      setDeleting(null);
      if (opened && deleting.contexts.includes(opened.context_id)) setOpened(null);
      setSelected(null);
      await list.refresh();
      onSummaryChanged();
      showList();
    } catch (err) {
      setDeleteError(describe(err));
    } finally {
      setDeleteBusy(false);
    }
  }
  async function openRecipient(recipient: DirectRecipient) {
    const opening = await api<DirectThread>(
      `/api/rooms/${encodeURIComponent(recipient.room_id)}/direct`,
      { to: recipient.member_id },
    );
    setOpened(opening);
    setComposing(false);
    setSelected(opening.context_id);
    await list.refresh();
  }
  const conversations = useMemo(
    () => groupConversations(list.data?.conversations ?? []),
    [list.data],
  );
  const fallback =
    (remembered && conversations.some((item) => item.contexts.includes(remembered))
      ? remembered
      : null) ??
    conversations[0]?.context_id ??
    null;
  const active = selected ?? (composing || directLoading ? null : fallback);
  // Pin the default chat once, so a later re-sort cannot swap the chat that opens. It loads in
  // the background, so opening it from the inbox is instant.
  useEffect(() => {
    if (!selected && active) setSelected(active);
  }, [selected, active]);
  const summary = conversations.find((item) => item.contexts.includes(active ?? ''));
  // A private room thread: from the list, or the one just opened that has no message yet.
  const directThread =
    summary?.items.find((item) => item.direct)?.direct ??
    (opened && opened.context_id === active ? opened : null);
  const pendingDirect = !summary && directThread ? directThread : null;
  const thread = useThread(workspace, summary?.key ?? null, summary?.items ?? []);
  // Reading a thread marks it read for you, whichever of your members received it (the owner's
  // read mark), and a private room thread to your person also acknowledges the person's inbox
  // (a person has no inbox view), so it drains like an AI's does when it acknowledges. An AI's
  // own inbox is never acknowledged for it. Only a thread on screen counts as read.
  const shownCount = thread.messages.length;
  // A chat can group several contexts (legacy threads); the key keeps the effect's dependency stable.
  const readContexts = !threadOpen
    ? ''
    : JSON.stringify(summary?.contexts ?? (directThread ? [directThread.context_id] : []));
  useEffect(() => {
    if (!readContexts || !shownCount) return;
    Promise.all(
      (JSON.parse(readContexts) as string[]).map((context) =>
        api(`/api/messages/direct/${encodeURIComponent(context)}/read`, {}),
      ),
    )
      // Re-read the list and the navigation count so every badge shows the server's count.
      .then(() => {
        void list.refresh();
        onSummaryChanged();
      })
      .catch(() => undefined);
  }, [readContexts, shownCount]);
  const newestContext = summary?.items[0]?.context_id;
  useEffect(() => {
    if (newestContext) writeLastChat(workspace, newestContext);
  }, [workspace, newestContext]);
  const participants = summary?.participants ?? [];
  const inThread = (route: Route) =>
    participants.includes(route.from.id) && participants.includes(route.to.id);
  const threadRoutes = [...routesOf(snapshot, inThread), ...crossRoutes.filter(inThread)];
  // Default to answering the last message: its recipient writes back to its sender.
  const last = thread.messages.at(-1);
  const replyRoutes = last
    ? [
        ...threadRoutes.filter((route) => route.from.id === last.to_agent_id),
        ...threadRoutes.filter((route) => route.from.id !== last.to_agent_id),
      ]
    : threadRoutes;
  const withUnread = snapshot.agents.filter((agent) => (unread.get(agent.id) ?? 0) > 0);
  const nameOf = (id: string) =>
    snapshot.agents.find((agent) => agent.id === id)?.name ?? 'Unknown agent';
  // Participants are stored by id; show them in a stable, readable (alphabetical) order.
  const title = (ids: string[]) =>
    ids
      .map(nameOf)
      .sort((a, b) => a.localeCompare(b))
      .join(' ⇄ ');
  async function sent(message: AgentMessage) {
    if (pendingDirect) setSelected(message.context_id);
    else if (composing) {
      setComposing(false);
      setSelected(message.context_id);
    } else {
      thread.add(message);
      setFollow((value) => value + 1);
    }
    // The sent message shows at once; the queued reads pick up anything that arrived meanwhile.
    await Promise.all([list.refresh(), composing ? null : thread.refresh()]);
    onSummaryChanged();
  }
  // A chat's display name, whether the other side is an AI, and who it belongs to (real fields).
  const chatName = (chat: ChatGroup) =>
    chat.desk ? 'Desk' : chat.direct ? chat.direct.peer.name : title(chat.participants);
  const chatAI = (chat: ChatGroup) => (chat.direct ? chat.direct.peer.kind === 'agent' : true);
  /** The id that colours a chat's avatar: the peer's member id, else the chat's own key. */
  const chatAvatarId = (chat: ChatGroup) =>
    chat.desk ? `desk:${chat.key}` : chat.direct ? chat.direct.peer.id : chat.key;
  const peerOwner = (peer: DirectThread['peer']) =>
    peer.own === true ? 'Your AI' : peer.kind === 'agent' ? peer.owner_label : null;
  // The inbox row and the thread pill name a readable owner only: a person's raw account label
  // ("Account 1a2b3c4d") stays in Details and the privacy line, where it explains who can read.
  const shownOwner = (peer: DirectThread['peer']) => {
    const owner = peerOwner(peer);
    return owner && RAW_ACCOUNT_LABEL.test(owner) ? null : owner;
  };
  const chatMeta = (chat: ChatGroup) =>
    chat.direct
      ? [shownOwner(chat.direct.peer), roomOrigin(chat.direct.room_name)]
          .filter(Boolean)
          .join(' · ')
      : '';
  const totalUnread = sumUnread(list.data?.conversations ?? []);
  const totalBadge = formatUnread(totalUnread.count, totalUnread.capped);
  const shown = conversations.filter((chat) => {
    const count = sumUnread(chat.items);
    return matchesFilter(filter, { unread: count.count, capped: count.capped, ai: chatAI(chat) });
  });
  const threadNames = directThread
    ? [directThread.self.name, directThread.peer.name]
    : participants.map(nameOf);

  /** The thread's top bar: Back, the other side's pill (name, badge, owner, room) and ⋯. */
  const threadBar = (head: {
    /** The chat's avatar id (chatAvatarId, or the peer's member id). */
    id?: string;
    name: string;
    ai?: boolean;
    meta?: string;
    avatar?: boolean;
    menu?: boolean;
  }) => (
    <div className="msg3-topbar">
      <button
        type="button"
        className="msg-v2-back msg3-round"
        aria-label="Back to inbox"
        onClick={showList}
      >
        <ArrowLeft size={18} aria-hidden="true" />
      </button>
      <header className="msg-v2-head msg3-pill">
        {head.avatar === false ? null : (
          <MessageAvatar id={head.id ?? ''} name={head.name} ai={head.ai} />
        )}
        <h2>{head.name}</h2>
        {head.avatar === false ? null : <KindTag ai={Boolean(head.ai)} />}
        {head.meta ? <span className="msg3-pill-meta">{head.meta}</span> : null}
      </header>
      {head.menu && summary ? (
        <ThreadMenu
          onDetails={() => setDetails((on) => !on)}
          onDelete={() => {
            setDeleteError('');
            setDeleting({
              contexts: summary.contexts,
              peer: directThread
                ? { name: directThread.peer.name, kind: directThread.peer.kind }
                : null,
            });
          }}
        />
      ) : null}
    </div>
  );
  const privacy = (privateThread: DirectThread) => (
    <p className="msg-v2-private">
      <LockKeyhole size={14} aria-hidden="true" />
      <span>
        {privacyNote(privateThread.self, privateThread.peer)} Private messages never post to room
        feeds.
      </span>
    </p>
  );
  const detailsCard = (chat: ChatGroup) => (
    <dl className="msg3-details" aria-label="Conversation details">
      {chat.direct ? (
        <>
          <div>
            <dt>With</dt>
            <dd>
              {chat.direct.peer.name} · {chat.direct.peer.kind === 'agent' ? 'AI' : 'person'}
              {peerOwner(chat.direct.peer) ? ` · ${peerOwner(chat.direct.peer)}` : ''}
            </dd>
          </div>
          <div>
            <dt>Writing as</dt>
            <dd>{chat.direct.self.name}</dd>
          </div>
          <div>
            <dt>Started in</dt>
            <dd>#{chat.direct.room_name.trim().replace(/^#+/, '')}</dd>
          </div>
        </>
      ) : (
        <div>
          <dt>Agents</dt>
          <dd>{title(chat.participants)}</dd>
        </div>
      )}
      <div>
        <dt>Messages</dt>
        <dd>{chat.message_count}</dd>
      </div>
      <div>
        <dt>Last message</dt>
        <dd>{formatDate(chat.last_message.created_at)}</dd>
      </div>
    </dl>
  );

  // One colour per chat and sender, different for each while there are at most 16 (the ids in
  // a fixed order; src/shell/avatarColor.ts), shared by the inbox rows and the open thread.
  const avatarColours = useAvatarColors(
    [
      ...new Set([
        ...conversations.map(chatAvatarId),
        ...thread.messages.map((message) => message.from_agent_id),
        ...(pendingDirect ? [pendingDirect.peer.id] : []),
      ]),
    ].sort(),
  );
  const view = (
    <section
      className="panel messages-v2"
      data-phone-thread={threadOpen}
      data-view={threadOpen ? 'thread' : 'inbox'}
      aria-label="Messages"
      onKeyDown={(event) => {
        // A dialog (the Delete confirm) handles its own Escape; it never closes the thread.
        if (
          threadOpen &&
          !deleting &&
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !(event.target as Element).closest?.('[role="dialog"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          showList();
        }
      }}
    >
      <MessageStyles />
      {deleting ? (
        <DeleteConversationDialog
          peer={deleting.peer}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      <div className="msg3-inbox" hidden={threadOpen}>
        <div className="msg3-topbar">
          <div className="msg3-pill msg-v2-heading">
            <h1>Messages</h1>
            <span className="msg3-live" data-unread={totalBadge ? 'true' : undefined}>
              <i aria-hidden="true" />
              <span aria-hidden="true">{totalBadge ? `${totalBadge} unread` : 'No unread'}</span>
              <span className="visually-hidden">
                {totalBadge ? unreadLabel(totalUnread.count, totalUnread.capped) : 'No unread'}
              </span>
            </span>
          </div>
          {/* No Refresh button: the inbox and the open thread poll on their own (POLL_MS) and
              again when the tab becomes visible; a failed read keeps its own Retry. */}
          {canCompose ? (
            <button
              ref={newMessageRef}
              type="button"
              className="msg3-primary"
              onClick={() => {
                setComposing(true);
                setSelected(null);
                showThread();
              }}
            >
              <Plus size={16} aria-hidden="true" />
              New conversation
            </button>
          ) : null}
        </div>
        <div className="msg3-page">
          {list.data && conversations.length ? (
            <div className="msg3-tabs" role="group" aria-label="Show" ref={tabsRef}>
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          {withUnread.length ? (
            <div className="msg-inboxes" aria-label="Agents with unread messages">
              {withUnread.map((agent) => (
                <button key={agent.id} className="msg-chip" onClick={() => onOpenAgent(agent.id)}>
                  <AgentGlyph agent={agent} size="small" />
                  {agent.name}
                  <span className="msg-count" aria-label={`${unread.get(agent.id)} unread`}>
                    {unread.get(agent.id)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {list.error && list.data ? (
            <ReadError error={list.error} loading={list.loading} retry={list.refresh} />
          ) : null}
          {!list.data ? (
            list.error ? (
              <div className="card empty msg-v2-state" data-tone="error">
                <span className="msg-v2-state-icon" aria-hidden="true">
                  <CircleAlert size={24} />
                </span>
                <div role="alert">
                  <h3>Messages couldn't be loaded</h3>
                  <p>{list.error}</p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  disabled={list.loading}
                  onClick={() => void list.refresh()}
                >
                  {list.loading ? 'Retrying…' : 'Retry loading'}
                </button>
              </div>
            ) : (
              <div className="card loading-panel" role="status">
                <div className="msg-v2-skeleton" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <p>Loading conversations…</p>
              </div>
            )
          ) : !conversations.length ? (
            !canCompose ? (
              <NoRoutesGuide onOpenConnections={onOpenConnections} />
            ) : (
              <div className="card empty msg-v2-state">
                <span className="msg-v2-state-icon" aria-hidden="true">
                  <MessagesSquare size={24} />
                </span>
                <div role="status">
                  <h3>No private messages yet</h3>
                  <p>
                    Choose “Message privately” on a member in a room to start a 1:1 conversation.
                    Private messages never post to room feeds.
                  </p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setComposing(true);
                    showThread();
                  }}
                >
                  <Plus size={15} aria-hidden="true" />
                  Write the first message
                </button>
              </div>
            )
          ) : (
            <>
              <nav ref={listRef} className="card msg-list" aria-label="Conversations">
                {shown.length ? null : (
                  <p className="msg3-list-empty" role="status">
                    {FILTERS.find((item) => item.id === filter)!.empty}
                  </p>
                )}
                {shown.map((conversation) => {
                  const name = chatName(conversation);
                  const ai = chatAI(conversation);
                  const meta = chatMeta(conversation);
                  const count = sumUnread(conversation.items);
                  const badge = formatUnread(count.count, count.capped);
                  return (
                    <button
                      key={conversation.key}
                      type="button"
                      className="msg-list-item"
                      data-unread={badge ? 'true' : undefined}
                      aria-current={
                        visited && conversation.key === summary?.key ? 'true' : undefined
                      }
                      onClick={() => {
                        setVisited(true);
                        setComposing(false);
                        setSelected(conversation.context_id);
                        showThread();
                      }}
                    >
                      <MessageAvatar id={chatAvatarId(conversation)} name={name} ai={ai} />
                      <span className="msg3-row-main">
                        <span className="msg-v2-row">
                          <strong>{name}</strong>
                          {conversation.desk ? null : <KindTag ai={ai} />}
                          <time
                            className="msg-v2-time"
                            dateTime={conversation.last_message.created_at}
                            title={formatDate(conversation.last_message.created_at)}
                          >
                            {relativeTime(conversation.last_message.created_at)}
                          </time>
                        </span>
                        <span className="msg-preview">{preview(conversation.last_message)}</span>
                        {meta ? <span className="msg3-row-meta">{meta}</span> : null}
                      </span>
                      {badge ? (
                        <span className="msg-v2-badge">
                          <span aria-hidden="true">{badge}</span>
                          <span className="visually-hidden">
                            {', '}
                            {unreadLabel(count.count, count.capped)}
                          </span>
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </nav>
              <p className="msg3-note">
                Private messages reach everyone you share a room with: people, your own AIs and
                invited AIs.
              </p>
            </>
          )}
        </div>
      </div>
      <div
        ref={threadRef}
        tabIndex={-1}
        className="msg-thread"
        aria-label="Conversation"
        role="region"
        hidden={!threadOpen}
      >
        {threadOpen ? <h1 className="visually-hidden">Messages</h1> : null}
        {openError ? (
          <p className="form-error msg3-open-error" role="alert">
            Couldn't open the private chat. {openError}
          </p>
        ) : null}
        {directLoading && !directThread ? (
          <>
            {threadBar({ name: 'Private message', avatar: false })}
            <div className="msg-v2-thread-loading" role="status">
              <div className="msg-v2-skeleton" aria-hidden="true">
                <i />
                <i />
              </div>
              <span className="visually-hidden">Opening the private chat…</span>
            </div>
          </>
        ) : pendingDirect ? (
          <>
            {threadBar({
              id: pendingDirect.peer.id,
              name: pendingDirect.peer.name,
              ai: pendingDirect.peer.kind === 'agent',
              meta: [shownOwner(pendingDirect.peer), roomOrigin(pendingDirect.room_name)]
                .filter(Boolean)
                .join(' · '),
            })}
            {privacy(pendingDirect)}
            <div className="msg-v2-state msg-v2-thread-empty">
              <p role="status">No messages yet in this private thread.</p>
            </div>
            <DirectComposer
              key={`direct:${pendingDirect.context_id}`}
              thread={pendingDirect}
              onSent={sent}
              draft={drafts.current.get(pendingDirect.context_id) ?? ''}
              onDraft={(text) => drafts.current.set(pendingDirect.context_id, text)}
            />
          </>
        ) : composing || !summary ? (
          <>
            {threadBar({ name: 'New conversation', avatar: false })}
            <div className="msg3-new">
              <NewMessage
                recipients={recipients.items}
                error={recipients.error}
                crossRoutes={crossRoutes}
                paused={snapshot.paused}
                previewV2
                onOpen={openRecipient}
                onSent={sent}
                draft={drafts.current.get('new') ?? ''}
                onDraft={(text) => drafts.current.set('new', text)}
              />
            </div>
          </>
        ) : (
          <>
            {threadBar({
              id: chatAvatarId(summary),
              name: chatName(summary),
              ai: chatAI(summary),
              meta: chatMeta(summary),
              menu: true,
            })}
            {details ? detailsCard(summary) : null}
            {directThread ? privacy(directThread) : null}
            {thread.error ? (
              <ReadError error={thread.error} loading={thread.loading} retry={thread.refresh} />
            ) : !thread.ready ? (
              <div className="msg-v2-thread-loading" role="status">
                <div className="msg-v2-skeleton" aria-hidden="true">
                  <i />
                  <i />
                </div>
                <span className="visually-hidden">Loading messages…</span>
              </div>
            ) : null}
            <ThreadMessages
              visible={threadOpen}
              previewV2
              directThread={directThread}
              names={threadNames}
              key={`thread:${summary.key}`}
              messages={thread.messages}
              snapshot={snapshot}
              hasOlder={thread.ready && thread.hasOlder}
              loadingOlder={thread.loadingOlder}
              onOlder={thread.loadOlder}
              onTrim={thread.trim}
              follow={follow}
            />
            {thread.ready && directThread ? (
              <DirectComposer
                key={`direct:${summary.key}`}
                thread={directThread}
                replyTo={
                  [...thread.messages]
                    .reverse()
                    .find((message) => message.to_agent_id === directThread.self.id)?.id
                }
                onSent={sent}
                draft={drafts.current.get(summary.key) ?? ''}
                onDraft={(text) => drafts.current.set(summary.key, text)}
              />
            ) : thread.ready ? (
              <Composer
                previewV2
                key={`compose:${summary.key}`}
                label="Reply"
                routes={replyRoutes}
                contextId={summary.desk ? 'city-desk' : summary.context_id}
                replyTo={(route) =>
                  summary.desk
                    ? undefined
                    : [...thread.messages]
                        .reverse()
                        .find((message) => message.to_agent_id === route.from.id)?.id
                }
                paused={snapshot.paused}
                onSent={sent}
                draft={drafts.current.get(summary.key) ?? ''}
                onDraft={(text) => drafts.current.set(summary.key, text)}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
  return <AvatarColorsContext.Provider value={avatarColours}>{view}</AvatarColorsContext.Provider>;
}

/** Inbox panel on the agent detail view. */
export function AgentInbox({
  agent,
  snapshot,
  onSummaryChanged,
}: {
  agent: Agent;
  snapshot: Snapshot;
  onSummaryChanged?: () => void;
}) {
  const inbox = usePoll<InboxPage>(`/api/agents/${agent.id}/inbox?limit=20`);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const page = inbox.data;
  const routes = routesOf(snapshot, (route) => route.from.id === agent.id);
  async function acknowledge() {
    if (!page) return;
    setBusy(true);
    setError('');
    try {
      await api<InboxAck>(`/api/agents/${agent.id}/inbox/ack`, { seq: page.latest_seq });
      await inbox.refresh();
      onSummaryChanged?.();
    } catch (err) {
      setError(describe(err, agent.name));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="msg-inbox" aria-label={`${agent.name} inbox`}>
      <MessageStyles />
      <div className="msg-inbox-head">
        <h3>
          <Inbox size={17} aria-hidden="true" />
          Inbox
          {page && page.unread ? (
            <span className="msg-count" aria-label={`${page.unread} unread`}>
              {page.unread}
            </span>
          ) : null}
        </h3>
        {page && page.unread ? (
          <button
            className="button secondary compact"
            disabled={busy}
            onClick={() => void acknowledge()}
          >
            <CheckCheck size={14} />
            Mark read as {agent.name}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {inbox.error ? (
        <ReadError error={inbox.error} loading={inbox.loading} retry={inbox.refresh} />
      ) : null}
      {!page ? (
        inbox.error ? null : (
          <p className="muted small" role="status">
            Loading inbox…
          </p>
        )
      ) : page.messages.length ? (
        <>
          <p className="muted small">
            {page.unread
              ? `${page.unread} of ${page.latest_seq} unread by ${agent.name}.`
              : `${agent.name} has read all ${page.latest_seq}.`}{' '}
            These messages come from other agents: check before you act on them.
          </p>
          <ol className="msg-scroll" style={{ listStyle: 'none', margin: 0 }}>
            {page.messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                snapshot={snapshot}
                unread={message.seq > page.acked_seq}
              />
            ))}
          </ol>
        </>
      ) : (
        <p className="muted small">No messages delivered to {agent.name} yet.</p>
      )}
      {agent.status === 'revoked' ? null : writing ? (
        <Composer
          label={`Send as ${agent.name}`}
          routes={routes}
          paused={snapshot.paused}
          onSent={async () => {
            setWriting(false);
            await inbox.refresh();
            onSummaryChanged?.();
          }}
        />
      ) : (
        <div>
          <button className="button secondary compact" onClick={() => setWriting(true)}>
            <Send size={14} />
            Write as {agent.name}
          </button>
        </div>
      )}
    </section>
  );
}
