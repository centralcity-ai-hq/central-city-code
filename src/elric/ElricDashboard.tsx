import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  ArrowUp,
  ChevronDown,
  Ellipsis,
  LayoutGrid,
  Menu,
  PanelLeft,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react';
import { api, ApiError } from '../api';
import { CityMark } from '../brand';
import { usePageTitle } from '../shell/usePageTitle';
import { openSidebar } from '../shell/sidebarRooms';
import { PAGE_TITLES } from '../../shared/page-titles';
import { createHttpRoomsClient, type RoomMessage } from '../rooms/api';
import { MessageBoundary } from '../rooms/markdown/Boundary';
// Elric's answer while it is written, revealed smoothly (Streaming.tsx); loaded with the chat.
import { loadStreaming, useStreaming } from '../rooms/markdown/streamingLoader';
import { withoutBidiControls } from '../rooms/markdown/format';
import {
  ELRIC_AI_NOTICE,
  ELRIC_AI_TAG,
  ELRIC_NAME,
  elricProfileTitle,
  elricReplyTag,
  elricTooltip,
} from '../../shared/elric-copy';
import { ThinkingDots } from './ThinkingDots';
import { MascotRest } from './ElricMascot';
import { clearPendingDraft, readPendingDraft, savePendingDraft } from './pendingDraft';
import { ElricSkeleton, skeletonJustShown } from './ElricSkeleton';
import { ElricMark } from './ElricMark';
import { ElricSheet } from './ElricSheet';
import { ElricFirstVisit } from './ElricFirstVisit';
import { ManageElricSheet } from './ManageElricSheet';
import { liveLine, messageClock, waitingLabel } from './elricV3';
import type { ElricStatus } from './prefetch';
import './dashboard.css';
import './elric-v3.css';

/**
 * The /elric dashboard: a private chat with the owner's Elric (docs/ELRIC.md "Dashboard chat").
 * Everything comes from the server: the chat room (GET /api/elric/chat), its messages (the room
 * read route), pending actions Elric proposed (GET /api/elric/pending, the owner approves or
 * declines) and the "Ask in a room" picker (GET /api/elric/rooms + POST /api/elric/ask). A message
 * is posted as the owner's person member with an "@Elric" prefix, so every Elric rule applies.
 *
 * Drawn in the Workspace v3 language (docs/design/WORKSPACE_V3_ELRIC_AGENTS.md §1, elric-v3.css):
 * a floating top bar 10% smaller than the room's, the chats column, a minimal Home (the orb,
 * "What can I help with?", one approval pill, three suggestions and the composer), the rooms'
 * bubbles with action cards inside Elric's, the first-visit card and the Manage Elric sheet.
 */

const Markdown = lazy(() =>
  import('../rooms/markdown/Markdown').then((module) => ({ default: module.Markdown })),
);

type Chat = {
  room_id: string;
  person_member_id: string;
  status: 'active' | 'paused';
  latest_seq: number;
  waking: boolean;
  pending_count: number;
  /** The conversation's Elric was removed: history only, no composer. */
  read_only?: boolean;
};
/** One private conversation with Elric (GET /api/elric/conversations). */
type Conversation = {
  id: string;
  slug: string;
  title: string;
  person_member_id: string;
  created_at: string;
  updated_at: string;
  latest_seq: number;
  read_only: boolean;
  /** 'fallback' (first message), 'user' (renamed) or 'auto' (generated after the first reply). */
  title_source?: 'fallback' | 'user' | 'auto';
};
type Message = RoomMessage & { auto_reply?: { model?: string | null } | null };
type Pending = {
  id: string;
  tool?: string;
  summary: string | null;
  args_hash: string;
  room: { id: string; name: string } | null;
};
/** An action approved here, shown as done in Elric's action bubble for the rest of the visit. */
type DoneAction = { id: string; title: string; room: { id: string; name: string } | null };
type PickerRoom = { id: string; name: string; elric_member: boolean };
type Phase = 'loading' | 'ready' | 'none' | 'error';

/** Home's three suggestions (§1 Home): one tap fills the message box (it doesn't send). */
const SUGGESTIONS = [
  'How do I invite my ChatGPT into a room?',
  'Explain how Central City rooms work',
  'What can you do for me?',
];
const TOOL: Record<string, string> = { room_task_create: 'Create a task' };
const actionTitle = (item: Pending) =>
  item.summary || (item.tool ? (TOOL[item.tool] ?? item.tool.replace(/_/g, ' ')) : 'An action');
const MENTION = '@Elric ';
/** After an Elric reply: when the sidebar asks again for the generated title (until it is there). */
const TITLE_REFRESH_MS = [2_000, 5_000, 10_000];
/**
 * How long the dots wait for a reply before giving up (a failed or refused turn posts nothing):
 * the server's 55 s run budget plus a few seconds for the reply to arrive.
 */
const THINKING_TIMEOUT_MS = 60_000;
const rooms = createHttpRoomsClient();

/**
 * What the dashboard opens with: no Elric yet (`chat` absent), or the chat (the most recent
 * conversation when the server has several), the conversations and its latest messages.
 */
type FirstChat =
  | { chat?: undefined }
  | {
      chat: Chat;
      pendingCount: number;
      conversations: Conversation[] | null;
      messages: Message[];
    };

/** Status, then the chat and the conversations together, then the opened chat's messages. */
async function readFirstChat(status: Promise<ElricStatus>): Promise<FirstChat> {
  if (!(await status).agent_id) return {};
  const [value, list] = await Promise.all([
    api<Chat>('/api/elric/chat', undefined, 'GET'),
    api<{ conversations: Conversation[] }>('/api/elric/conversations', undefined, 'GET').catch(
      () => null,
    ),
  ]);
  const first = list?.conversations[0];
  const chat: Chat = first
    ? {
        ...value,
        room_id: first.id,
        person_member_id: first.person_member_id,
        read_only: first.read_only,
      }
    : value;
  const page = await rooms.read({ room_id: chat.room_id, limit: 50 });
  return {
    chat,
    pendingCount: value.pending_count,
    conversations: list ? list.conversations : null,
    messages: page.messages as Message[],
  };
}

const FIRST_CHAT_FRESH_MS = 30_000;
let warmFirstChat: { at: number; value: Promise<FirstChat>; ready?: FirstChat } | null = null;

/**
 * Started from the workspace navigation (src/elric/prefetch.ts) when the person is about to
 * open Elric: the dashboard's first load then finds the chat already read. Used once, and only
 * while fresh; the regular polling catches up with anything newer.
 */
export function prefetchFirstChat(status: Promise<ElricStatus>) {
  if (warmFirstChat && Date.now() - warmFirstChat.at < FIRST_CHAT_FRESH_MS) return;
  const value = readFirstChat(status);
  const entry: NonNullable<typeof warmFirstChat> = { at: Date.now(), value };
  value.then(
    (loaded) => {
      entry.ready = loaded;
    },
    () => {
      if (warmFirstChat === entry) warmFirstChat = null;
    },
  );
  warmFirstChat = entry;
}

/** The read-ahead chat when it has already arrived: the dashboard then draws it at once. */
function readyFirstChat() {
  const ready =
    warmFirstChat && Date.now() - warmFirstChat.at < FIRST_CHAT_FRESH_MS
      ? warmFirstChat.ready
      : undefined;
  return ready?.chat ? ready : null;
}

function takeFirstChat(): Promise<FirstChat> | null {
  const fresh =
    warmFirstChat && Date.now() - warmFirstChat.at < FIRST_CHAT_FRESH_MS
      ? warmFirstChat.value
      : null;
  warmFirstChat = null;
  return fresh;
}

/** The person's text without the "@Elric" prefix the dashboard adds. */
const shown = (text: string) => text.replace(/^@Elric\s+/i, '');

/**
 * The reveal of one answer on /elric (Streaming.tsx): the draft for the person's post, then the
 * posted message that answers it (auto_reply.reply_to), share it.
 */
const revealKey = (room: string, post: number | string) => `chat:${room}:${post}`;

/**
 * Elric's name row above its bubble (WORKSPACE_V3.md §4.2): the name, one "built in" badge that
 * still says "AI" to assistive technology (AI transparency), and the time. The tooltip names the
 * version. A Tier 0 reply says "· automated" instead of AI.
 */
function ElricByline({ model, at }: { model?: string | null | undefined; at?: string }) {
  const tag = model === undefined ? ELRIC_AI_TAG : elricReplyTag(model);
  const clock = messageClock(at);
  return (
    <div className="elx3-meta">
      <p className="elx-meta elx-byline" title={elricTooltip()}>
        <span className="elx3-name">{ELRIC_NAME}</span>{' '}
        <span className="elx-tag">
          built in{tag ? <span className="visually-hidden"> {tag}</span> : null}
        </span>
        {tag ? null : <span className="elx3-automated"> · automated</span>}
      </p>
      {clock ? <time dateTime={at}>{clock}</time> : null}
    </div>
  );
}

/** `live`: the reply just arrived for the person's post, so it continues the smooth reveal. */
function Reply({
  message,
  live = false,
  arrived = false,
  room = '',
}: {
  message: Message;
  live?: boolean;
  /** Arrived while the page was open (not continuing its draft): it rises in. */
  arrived?: boolean;
  room?: string;
}) {
  const streaming = useStreaming(live);
  const clean = withoutBidiControls(message.text);
  const plain = <p className="elx-plain">{clean}</p>;
  return (
    <div
      className="elx-turn elx-turn-elric elx3-msg"
      data-testid="elric-reply"
      data-arrived={arrived ? 'true' : undefined}
    >
      <ElricMark />
      <div className="elx3-msg-body">
        <ElricByline model={message.auto_reply?.model ?? null} at={message.created_at} />
        <div className="elx-reply elx3-bubble">
          <MessageBoundary fallback={plain}>
            <Suspense fallback={plain}>
              {live && streaming ? (
                <streaming.StreamingMarkdown
                  text={clean}
                  done
                  revealKey={revealKey(
                    room,
                    (message.auto_reply as { reply_to?: number } | null | undefined)?.reply_to ??
                      message.id,
                  )}
                />
              ) : (
                <Markdown text={clean} priority={message.seq} />
              )}
            </Suspense>
          </MessageBoundary>
        </div>
      </div>
    </div>
  );
}

/** Elric's answer while it forms (GET /api/rooms/:room/elric-drafts), in the reply's place. */
type Draft = { agent_id: string; source_seq: number; text: string; updated_at: number };
/** How often a forming answer is read, and for how long at most (the run budget plus delivery). */
const DRAFT_POLL_MS = 500;
const DRAFT_MAX_MS = 60_000;

function DraftReply({ text, revealAs }: { text: string; revealAs: string }) {
  const streaming = useStreaming();
  const clean = withoutBidiControls(text);
  const plain = <p className="elx-plain">{clean}</p>;
  return (
    <div
      className="elx-turn elx-turn-elric elx3-msg elx-draft"
      data-testid="elric-draft"
      aria-busy="true"
    >
      <ElricMark />
      <div className="elx3-msg-body">
        <ElricByline />
        <div className="elx-reply elx3-bubble">
          <MessageBoundary fallback={plain}>
            {streaming ? (
              <streaming.StreamingMarkdown text={clean} done={false} revealKey={revealAs} />
            ) : (
              plain
            )}
          </MessageBoundary>
        </div>
        <span className="visually-hidden">Elric is writing</span>
      </div>
    </div>
  );
}

/**
 * Elric's action cards (§1 Chat), inside one Elric bubble at the end of the thread: an approved
 * action as "✓ Done" with what it did, a proposed one as "Waiting for your approval" with Approve
 * (the only filled button) and Decline. Elric only proposes; nothing runs until the owner approves.
 */
function ActionBubble({
  pending,
  done,
  deciding,
  onDecide,
  focusRef,
  continued = false,
}: {
  /** Right after an Elric reply: one group with it (no second avatar and name, as in rooms). */
  continued?: boolean;
  pending: Pending[];
  done: DoneAction[];
  deciding: string | null;
  onDecide: (item: Pending, decision: 'approve' | 'reject') => void;
  focusRef: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className="elx-turn elx-turn-elric elx3-msg"
      ref={focusRef}
      tabIndex={-1}
      role="group"
      aria-label="Elric’s actions"
      data-continued={continued ? 'true' : undefined}
    >
      {continued ? <span className="elx3-av-space" aria-hidden="true" /> : <ElricMark />}
      <div className="elx3-msg-body">
        {continued ? null : <ElricByline />}
        <div className="elx3-bubble elx3-cards">
          {done.map((item) => (
            <div
              key={item.id}
              className="elx3-action"
              data-testid="elric-done"
              data-done-id={item.id}
              tabIndex={-1}
            >
              <div className="elx3-action-row">
                <span className="elx3-status is-ok">
                  <i aria-hidden="true" />
                  Done
                </span>
                <b className="elx3-action-title">{item.title}</b>
              </div>
              {item.room ? <p className="elx-meta">In # {item.room.name}</p> : null}
            </div>
          ))}
          {pending.map((item) => (
            <div key={item.id} className="elx-card elx3-action" data-testid="elric-pending">
              <span className="elx3-status is-pending">
                <i aria-hidden="true" />
                Waiting for your approval
              </span>
              <p className="elx-card-title elx3-action-title">{actionTitle(item)}</p>
              {item.room ? <p className="elx-meta">In # {item.room.name}</p> : null}
              <div className="elx-card-actions elx3-action-buttons">
                <button
                  type="button"
                  className="elx3-btn is-primary is-sm"
                  disabled={deciding !== null}
                  aria-label={`Approve: ${actionTitle(item)}`}
                  onClick={() => onDecide(item, 'approve')}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="elx3-btn is-ghost is-sm"
                  disabled={deciding !== null}
                  aria-label={`Decline: ${actionTitle(item)}`}
                  onClick={() => onDecide(item, 'reject')}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Elric's profile/about sheet: the name and version (elricProfileTitle), the AI disclosure and
 * one button. Escape or the scrim closes it; focus moves in and goes back to the opener.
 */
function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <ElricSheet title={elricProfileTitle()} onClose={onClose} className="elx3-about">
      <p className="elx3-sheet-text">{ELRIC_AI_NOTICE}</p>
      <div className="elx3-sheet-foot">
        <button type="button" className="elx3-btn is-primary" autoFocus onClick={onClose}>
          OK
        </button>
      </div>
    </ElricSheet>
  );
}

/**
 * The chats column (§1 Layout): every conversation with Elric, newest activity first; the current
 * one is marked; each has a ⋯ menu with Rename and Delete (sheets, opened by the dashboard). A
 * column on wide screens; under 900px the "Chats" chip opens it as a drawer.
 */
function ConversationList({
  conversations,
  current,
  open,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: {
  conversations: Conversation[];
  current: string | null;
  open: boolean;
  onSelect: (conversation: Conversation) => void;
  onRename: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // As the phone drawer: focus moves in to the current chat (else the first), Escape closes, Tab
  // stays inside, and on close focus goes back to the Chats chip (as in the sheets).
  useEffect(() => {
    if (!open) return;
    const list = nav.current;
    (
      list?.querySelector<HTMLElement>('.elx-side-chat[aria-current="page"]') ??
      list?.querySelector<HTMLElement>('.elx-side-chat')
    )?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab' || !nav.current) return;
      // Only what is rendered: embedded in the workspace, the Workspace link is hidden, and a
      // hidden last item would let Tab leave the drawer.
      const items = [
        ...nav.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input'),
      ].filter((item) => item.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      const inside = nav.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.querySelector<HTMLElement>('.elx-side-toggle')?.focus();
    };
  }, [open]);
  // An open ⋯ menu closes on Escape (back to its button) and on a click elsewhere.
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      document.querySelector<HTMLElement>(`[data-chat-more="${CSS.escape(menu)}"]`)?.focus();
      setMenu(null);
    };
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.('.elx-side-item')) setMenu(null);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menu]);
  return (
    <>
      {open ? <div className="elx-side-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <nav ref={nav} className="elx-side" data-open={open ? 'true' : undefined} aria-label="Chats">
        <p className="elx3-side-label" aria-hidden="true">
          Chats
        </p>
        <ol className="elx-side-list">
          {conversations.map((conversation) => (
            <li key={conversation.id} className="elx-side-item">
              <button
                type="button"
                className="elx-side-chat"
                aria-current={conversation.id === current ? 'page' : undefined}
                title={conversation.title}
                onClick={() => onSelect(conversation)}
              >
                {conversation.title}
              </button>
              <button
                type="button"
                className="elx-icon elx-side-more"
                aria-label={`More for ${conversation.title}`}
                aria-haspopup="menu"
                aria-expanded={menu === conversation.id}
                data-chat-more={conversation.id}
                onClick={() => setMenu(menu === conversation.id ? null : conversation.id)}
              >
                <Ellipsis size={16} strokeWidth={1.9} aria-hidden="true" />
              </button>
              {menu === conversation.id ? (
                <div className="elx-side-menu" role="menu" aria-label={conversation.title}>
                  <button
                    type="button"
                    role="menuitem"
                    autoFocus
                    onClick={() => {
                      setMenu(null);
                      onRename(conversation);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    onClick={() => {
                      setMenu(null);
                      onDelete(conversation);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {conversations.length === 0 ? (
          <p className="elx3-side-note">Your chats appear here.</p>
        ) : null}
        <p className="elx3-side-note">Your chats with Elric are private to you.</p>
        <a className="elx-side-workspace" href="/">
          <LayoutGrid size={18} strokeWidth={1.75} aria-hidden="true" />
          Workspace
        </a>
      </nav>
    </>
  );
}

/** Rename a chat (today's "Chat name / Save name"), as a sheet. */
function RenameSheet({
  conversation,
  onSave,
  onClose,
}: {
  conversation: Conversation;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  return (
    <ElricSheet
      title="Rename chat"
      onClose={onClose}
      returnFocusTo={() =>
        document.querySelector<HTMLElement>(`[data-chat-more="${CSS.escape(conversation.id)}"]`) ??
        document.querySelector<HTMLElement>('.elx-side-toggle')
      }
    >
      <form
        className="elx3-rename"
        onSubmit={(event) => {
          event.preventDefault();
          const value = title.trim();
          if (!value || busy) return;
          setBusy(true);
          void onSave(value).finally(() => setBusy(false));
        }}
      >
        <input
          aria-label="Chat name"
          value={title}
          maxLength={80}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="elx3-sheet-foot">
          <button type="button" className="elx3-btn is-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="elx3-btn is-primary" disabled={busy || !title.trim()}>
            Save name
          </button>
        </div>
      </form>
    </ElricSheet>
  );
}

/** Delete a chat (today's "Delete this chat?"), as a confirm sheet. */
function DeleteSheet({
  conversation,
  onDelete,
  onClose,
}: {
  conversation: Conversation;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ElricSheet
      title="Delete this chat?"
      role="alertdialog"
      onClose={onClose}
      returnFocusTo={() =>
        document.querySelector<HTMLElement>('.elx-side-chat[aria-current="page"]') ??
        document.querySelector<HTMLElement>('.elx-side-toggle') ??
        document.querySelector<HTMLElement>('.elx-composer textarea')
      }
    >
      <p className="elx3-sheet-text">
        “{conversation.title}” and its messages are deleted. This can’t be undone.
      </p>
      <div className="elx3-sheet-foot">
        <button type="button" className="elx3-btn is-ghost" autoFocus onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="elx3-btn is-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDelete().finally(() => setBusy(false));
          }}
        >
          Delete
        </button>
      </div>
    </ElricSheet>
  );
}

/** To the end of the thread: the given scroller's, or the window's when there is none. */
function scrollToEnd(box: HTMLElement | null) {
  if (box) box.scrollTop = box.scrollHeight;
  else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
}

export function ElricDashboard({
  embedded = false,
  status: knownStatus,
}: {
  /** GET /api/elric as the route just read it (src/Root.tsx): the first load does not ask again. */
  status?: ElricStatus;
  /** The signed-in person's name when the shell already has it (kept for the route's call). */
  personName?: string;
  /**
   * Inside the workspace shell (the workspace preview): the dashboard fills the page area beside
   * the workspace navigation and scrolls its own thread, instead of taking the whole window.
   */
  embedded?: boolean;
} = {}) {
  usePageTitle(PAGE_TITLES['/elric']);
  // Read ahead from the navigation and already here: the chat draws on the first frame.
  const [opened] = useState(readyFirstChat);
  const [phase, setPhase] = useState<Phase>(opened ? 'ready' : 'loading');
  // The chat replaces Elric's skeleton (here or in the route): it settles in over it. Drawn at
  // once from the read-ahead, the page area's own entrance is the only motion (PageArea).
  const [arrive] = useState(() => !opened || skeletonJustShown());
  // Bumped after the inline setup creates Elric: the chat loads again.
  const [loadKey, setLoadKey] = useState(0);
  const [chat, setChat] = useState<Chat | null>(opened?.chat ?? null);
  // The chat history (null: this server has one chat only, no conversations API).
  const [conversations, setConversations] = useState<Conversation[] | null>(
    opened?.conversations ?? null,
  );
  const [sideOpen, setSideOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() =>
    opened ? [...opened.messages].sort((a, b) => a.seq - b.seq) : [],
  );
  const [fromSeq, setFromSeq] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  // A message typed before signing in is back in the composer (never sent on its own).
  const [draft, setDraft] = useState(readPendingDraft);
  const keptDraft = useRef(draft !== '');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  // The text of the last "used up for today" notice: while it is the notice shown, the resting
  // mascot sits beside it.
  const [limitNotice, setLimitNotice] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState<PickerRoom[] | null>(null);
  const [target, setTarget] = useState<PickerRoom | null>(null);
  const [sentSeq, setSentSeq] = useState<number | null>(null);
  // When the current wait began (for the dots' quiet lines), the last text sent, and what Try
  // again resends after a turn that never answered.
  const [sentAt, setSentAt] = useState(0);
  const lastText = useRef('');
  const [retry, setRetry] = useState<string | null>(null);
  // The answer forming for the person's last post (text '' until the first words arrive).
  const [forming, setForming] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const closeAbout = useCallback(() => setAbout(false), []);
  // Manage Elric (the sheet), Home's Review (the action bubble in view), actions approved here,
  // the rooms Elric is in (the top bar's live line) and the rename / delete sheets.
  const [manage, setManage] = useState(false);
  const closeManage = useCallback(() => setManage(false), []);
  const roomsRead = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState<DoneAction[]>([]);
  const [roomsOn, setRoomsOn] = useState<number | null>(null);
  const [chatSheet, setChatSheet] = useState<{
    kind: 'rename' | 'delete';
    conversation: Conversation;
  } | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  // Messages that arrived while the page was open (sent, or read by the poll): only these rise in;
  // history, a reload and another conversation show at once.
  const arrived = useRef(new Set<string>());
  const latest = useRef(opened ? Math.max(0, ...opened.messages.map((item) => item.seq)) : 0);
  const conversationsOn = useRef(false);
  conversationsOn.current = conversations !== null;
  const pendingCount = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  // The smooth reveal is ready before the first answer.
  useEffect(() => {
    void loadStreaming().catch(() => undefined);
  }, []);

  // A kept message: the composer takes focus once the chat is there, so Send is one key away.
  useEffect(() => {
    if (phase === 'ready' && keptDraft.current) input.current?.focus();
  }, [phase]);

  const merge = useCallback((list: Message[]) => {
    if (!list.length) return;
    setMessages((current) => {
      const bySeq = new Map(current.map((item) => [item.seq, item]));
      for (const item of list) bySeq.set(item.seq, item);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });
    latest.current = Math.max(latest.current, ...list.map((item) => item.seq));
  }, []);

  const loadPending = useCallback(async () => {
    try {
      setPending((await api<{ pending: Pending[] }>('/api/elric/pending')).pending);
    } catch {
      // The approvals list is best effort; the chat keeps working without it.
    }
  }, []);

  // First visit: the chat room (created once on the server) and its messages.
  useEffect(() => {
    let live = true;
    // Drawn from the read-ahead chat on the first frame (opened): only its approvals remain.
    if (loadKey === 0 && opened) {
      takeFirstChat();
      if (opened.pendingCount) void loadPending();
      return () => {
        live = false;
      };
    }
    void (async () => {
      try {
        // The chat read ahead from the navigation, else read now: no Elric yet (a first visit)
        // shows the setup without asking for a chat that can't exist (its 404 would show as an
        // error in the browser console); several conversations open the most recent one.
        const first =
          (loadKey === 0 ? takeFirstChat() : null) ??
          readFirstChat(
            loadKey === 0 && knownStatus
              ? Promise.resolve(knownStatus)
              : api<ElricStatus>('/api/elric', undefined, 'GET'),
          );
        const loaded = await first;
        if (!live) return;
        if (!loaded.chat) {
          setPhase('none');
          return;
        }
        // One render: the chat list, the chat and its messages arrive together (nothing shifts).
        setConversations(loaded.conversations);
        setChat(loaded.chat);
        merge(loaded.messages);
        setPhase('ready');
        if (loaded.pendingCount) void loadPending();
      } catch (err) {
        if (!live) return;
        setPhase(err instanceof ApiError && err.code === 'elric_not_found' ? 'none' : 'error');
      }
    })();
    return () => {
      live = false;
    };
  }, [merge, loadPending, loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll: every 2 s while Elric is working, backing off to 60 s when idle; never while hidden.
  const waking = chat?.waking ?? false;
  const awaiting = sentSeq !== null;
  useEffect(() => {
    // A new chat has no room until its first message (never an empty chat on the server).
    if (!chat?.room_id) return;
    let live = true;
    let delay = waking || awaiting ? 2_000 : 10_000;
    let timer = 0;
    const tick = async () => {
      if (!live) return;
      if (document.visibilityState === 'visible') {
        try {
          const [state, conversation] = await Promise.all([
            api<Chat>(`/api/elric/chat?since=${latest.current}`, undefined, 'GET'),
            conversationsOn.current
              ? api<Conversation>(
                  `/api/elric/conversations/${encodeURIComponent(chat.room_id)}?since=${latest.current}`,
                  undefined,
                  'GET',
                )
              : Promise.resolve(null),
          ]);
          if (!live) return;
          const newest = conversation ? conversation.latest_seq : state.latest_seq;
          if (newest > latest.current) {
            const page = await rooms.read({ room_id: chat.room_id, since: latest.current });
            if (live) {
              for (const item of page.messages) arrived.current.add(item.id);
              merge(page.messages as Message[]);
            }
            // A first message names the conversation: refresh the titles. After a reply, a few
            // more times while the title is still the fallback: the short title is written just
            // after the first reply (server/elric/titles.ts).
            if (conversationsOn.current) {
              const replied = (page.messages as Message[]).some((item) => item.auto_reply);
              const roomId = chat.room_id;
              const untitled = (items: Conversation[] | null) =>
                items?.find((item) => item.id === roomId)?.title_source === 'fallback';
              void refreshConversations().then(async (list) => {
                if (!replied || !untitled(list)) return;
                const start = Date.now();
                for (const at of TITLE_REFRESH_MS) {
                  await new Promise((done) =>
                    window.setTimeout(done, Math.max(0, at - (Date.now() - start))),
                  );
                  // Not tied to this poll's `live`: the poll restarts once the reply is in.
                  if (!untitled(await refreshConversations())) return;
                }
              });
            }
          }
          if (state.pending_count !== pendingCount.current) void loadPending();
          pendingCount.current = state.pending_count;
          setChat((current) =>
            current && (current.waking !== state.waking || current.status !== state.status)
              ? { ...current, waking: state.waking, status: state.status }
              : current,
          );
          delay = state.waking || awaiting ? 2_000 : Math.min(delay * 2, 60_000);
        } catch {
          delay = Math.min(delay * 2, 60_000);
        }
      }
      if (live) timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, delay);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [chat?.room_id, waking, awaiting, merge, loadPending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the person wrote this message. Elric's replies carry own:true for its owner (Elric
  // belongs to them), so the sender decides, not `own`.
  const mine = useCallback(
    (item: Message) => item.sender_agent_id === chat?.person_member_id && !item.auto_reply,
    [chat?.person_member_id],
  );

  // The dots end on an Elric reply after the person's post, or after the run budget with a
  // plain error and Try again (a failed or refused turn posts nothing); that also ends the fast
  // polling.
  useEffect(() => {
    if (sentSeq === null) return;
    if (messages.some((item) => item.seq > sentSeq && !mine(item))) {
      setSentSeq(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSentSeq(null);
      setRetry(lastText.current);
      setError('Elric didn’t answer.');
    }, THINKING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [messages, sentSeq, mine]);

  // Streamed answers: while waiting for Elric's reply to the person's post, read the forming
  // answer every 500 ms (up to the run budget). When the draft goes away the final message is
  // fetched at once, so it replaces the draft in place.
  useEffect(() => {
    if (sentSeq === null || !chat) {
      setForming(null);
      return;
    }
    let live = true;
    let seen = false;
    let timer = 0;
    const started = Date.now();
    const tick = async () => {
      if (!live) return;
      try {
        const { drafts } = await api<{ drafts: Draft[] }>(
          `/api/rooms/${encodeURIComponent(chat.room_id)}/elric-drafts`,
          undefined,
          'GET',
        );
        if (!live) return;
        const mine = drafts.find((item) => item.source_seq === sentSeq);
        if (mine) {
          seen = true;
          setForming(mine.text);
        } else if (seen) {
          // Done (or refused): pull the final message now instead of at the next slow poll. The
          // draft stays until then, so the posted message takes its place with no gap.
          try {
            const page = await rooms.read({ room_id: chat.room_id, since: latest.current });
            if (live) merge(page.messages as Message[]);
          } finally {
            if (live) setForming(null);
          }
          return;
        }
      } catch {
        // Drafts are a preview; the final message still arrives through the normal poll.
      }
      if (live && Date.now() - started < DRAFT_MAX_MS)
        timer = window.setTimeout(tick, DRAFT_POLL_MS);
    };
    timer = window.setTimeout(tick, DRAFT_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [sentSeq, chat?.room_id, merge]); // eslint-disable-line react-hooks/exhaustive-deps

  // The composer grows (a long draft, a notice, the room picker): the thread's bottom padding and
  // the page's scroll padding follow its measured height, so no reply hides behind it.
  // Stick to the bottom: while the reader is at the end, any growth (the composer, a reply whose
  // Markdown renders late, a new message) keeps the end in view; scrolling up releases it.
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const thread = useRef<HTMLElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element) return;
    // Embedded, the thread scrolls itself; standalone, the window does.
    const box = embedded ? thread.current : null;
    const page = box ?? document.documentElement;
    const target: HTMLElement | Window = box ?? window;
    const toEnd = () => scrollToEnd(box);
    const onScroll = () => {
      stick.current = page.clientHeight + page.scrollTop >= page.scrollHeight - 48;
    };
    const apply = () => {
      const height = `${Math.ceil(element.getBoundingClientRect().height)}px`;
      root.current?.style.setProperty('--elx-dock-h', height);
      page.style.scrollPaddingBottom = height;
      if (stick.current) toEnd();
    };
    apply();
    target.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver === 'undefined')
      return () => target.removeEventListener('scroll', onScroll);
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    // Embedded, the thread keeps its size as it fills: watch its column instead.
    const content = box ? box.firstElementChild : thread.current;
    if (content) observer.observe(content);
    return () => {
      observer.disconnect();
      target.removeEventListener('scroll', onScroll);
      page.style.scrollPaddingBottom = '';
    };
  }, [phase, embedded]);

  const visible = messages.filter((item) => item.seq > fromSeq);
  // Replies that arrive for the person's post continue the smooth reveal of their draft; every
  // other message (history, a reload, another conversation) shows at once.
  const liveReplies = useRef(new Set<string>());
  const answered = sentSeq !== null && visible.some((item) => item.seq > sentSeq && !mine(item));
  if (sentSeq !== null)
    for (const item of visible)
      if (item.seq > sentSeq && !mine(item)) liveReplies.current.add(item.id);
  const lastLive = liveReplies.current.has(visible.at(-1)?.id ?? '');
  useLayoutEffect(() => {
    // A reply that continues its draft while the reader scrolled up: leave them where they are.
    if (lastLive && !stick.current) return;
    // A new message or the person's own post: back to the end.
    // The page's real end (it includes the composer's padding), not the last element, so the
    // newest reply never starts under the composer.
    stick.current = true;
    scrollToEnd(embedded ? thread.current : null);
  }, [visible.length, sentSeq, pending.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // The composer grows with its text up to a few lines.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
  }, [draft]);

  async function send(text = draft) {
    const body = text.trim();
    if (!chat || !body || sending) return;
    setSending(true);
    setError('');
    setRetry(null);
    setNotice('');
    try {
      if (target) {
        // A question in a shared room is public there: the server checks both memberships first.
        const check = await api<{ room_id: string; person_member_id: string }>('/api/elric/ask', {
          room_id: target.id,
        });
        await rooms.post({
          room_id: check.room_id,
          text: `${MENTION}${body}`,
          agent_id: check.person_member_id,
          idempotency_key: crypto.randomUUID(),
        });
        setNotice(`Posted in ${target.name}. Elric replies there.`);
      } else {
        // A new chat is created with its first message, so no empty chat is ever stored.
        let open = { room_id: chat.room_id, person_member_id: chat.person_member_id };
        if (!open.room_id) {
          const created = await api<Conversation>('/api/elric/conversations', {});
          setConversations((list) => [created, ...(list ?? []).filter((c) => c.id !== created.id)]);
          setChat((current) =>
            current
              ? {
                  ...current,
                  room_id: created.id,
                  person_member_id: created.person_member_id,
                  read_only: created.read_only,
                  latest_seq: created.latest_seq,
                }
              : current,
          );
          open = { room_id: created.id, person_member_id: created.person_member_id };
        }
        const message = (await rooms.post({
          room_id: open.room_id,
          text: `${MENTION}${body}`,
          agent_id: open.person_member_id,
          idempotency_key: crypto.randomUUID(),
        })) as Message & { elric_notice?: { text?: string; code?: string } };
        arrived.current.add(message.id);
        merge([message]);
        // The first message names a new conversation: refresh the titles.
        if (conversations !== null) void refreshConversations();
        lastText.current = body;
        setSentAt(Date.now());
        setSentSeq(message.seq);
        if (message.elric_notice?.text) {
          setNotice(message.elric_notice.text);
          if (message.elric_notice.code === 'elric_limit')
            setLimitNotice(message.elric_notice.text);
          setSentSeq(null);
        }
      }
      setDraft('');
      if (keptDraft.current) {
        keptDraft.current = false;
        clearPendingDraft();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your message wasn’t sent. Try again.');
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }

  async function decide(item: Pending, decision: 'approve' | 'reject') {
    if (deciding) return;
    setDeciding(item.id);
    setError('');
    try {
      await api(
        `/api/elric/pending/${encodeURIComponent(item.id)}/${decision}`,
        decision === 'approve' ? { args_hash: item.args_hash } : {},
      );
      setPending((list) => list.filter((entry) => entry.id !== item.id));
      // Approved here: the card stays in Elric's bubble as done, with what it did.
      if (decision === 'approve')
        setDone((list) => [...list, { id: item.id, title: actionTitle(item), room: item.room }]);
      // Focus never drops to the page: the next waiting card's Approve, else this action's done
      // card, else the action bubble (or the composer when the bubble is gone).
      window.requestAnimationFrame(() => {
        const box = actions.current;
        const next =
          box?.querySelector<HTMLElement>('[data-testid="elric-pending"] .elx3-btn.is-primary') ??
          box?.querySelector<HTMLElement>(`[data-done-id="${CSS.escape(item.id)}"]`) ??
          box ??
          input.current;
        next?.focus({ preventScroll: false });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setDeciding(null);
    }
  }

  // The top bar's live line: the rooms Elric is in (GET /api/elric/rooms). Read lazily, never on
  // open: the first time the room picker or Manage Elric opens; no line until then.
  const readRooms = useCallback(async () => {
    try {
      const list = (await api<{ rooms: PickerRoom[] }>('/api/elric/rooms', undefined, 'GET')).rooms;
      setRoomsOn(list.filter((room) => room.elric_member).length);
      return list;
    } catch {
      return null;
    }
  }, []);

  /** Manage Elric: the sheet, and the rooms count for the live line the first time. */
  function openManage() {
    setManage(true);
    if (!roomsRead.current) {
      roomsRead.current = true;
      void readRooms();
    }
  }

  async function openPicker() {
    if (picker) {
      setPicker(null);
      return;
    }
    roomsRead.current = true;
    setPicker((await readRooms()) ?? []);
  }

  async function refreshConversations() {
    try {
      const list = await api<{ conversations: Conversation[] }>(
        '/api/elric/conversations',
        undefined,
        'GET',
      );
      setConversations(list.conversations);
      return list.conversations;
    } catch {
      // Titles are a nicety; the chat keeps working.
      return null;
    }
  }

  /** Opens a conversation: its own room, messages and composer state. */
  async function selectConversation(conversation: Conversation) {
    setSideOpen(false);
    if (chat?.room_id === conversation.id) return;
    setMessages([]);
    latest.current = 0;
    setSentSeq(null);
    setForming(null);
    setRetry(null);
    setError('');
    setNotice('');
    setFromSeq(0);
    setReviewing(false);
    setDone([]);
    setChat((current) =>
      current
        ? {
            ...current,
            room_id: conversation.id,
            person_member_id: conversation.person_member_id,
            read_only: conversation.read_only,
            latest_seq: conversation.latest_seq,
          }
        : current,
    );
    try {
      const page = await rooms.read({ room_id: conversation.id, limit: 50 });
      merge(page.messages as Message[]);
    } catch {
      setError('This chat couldn’t be loaded. Try again.');
    }
  }

  /** "New chat": a new conversation that keeps the old ones (or, without them, a fresh view). */
  async function newChat() {
    setNotice('');
    setError('');
    setReviewing(false);
    setDone([]);
    if (conversations === null) {
      setFromSeq(latest.current);
      setSentSeq(null);
      input.current?.focus();
      return;
    }
    // Only a fresh composer: the chat is created on the server with its first message, so an
    // unused "New chat" (or the view left after deleting the open chat) never lists as empty.
    setSideOpen(false);
    setMessages([]);
    latest.current = 0;
    setSentSeq(null);
    setForming(null);
    setRetry(null);
    setFromSeq(0);
    setChat((current) =>
      current
        ? { ...current, room_id: '', person_member_id: '', read_only: false, latest_seq: 0 }
        : current,
    );
    input.current?.focus();
  }

  async function renameConversation(conversation: Conversation, title: string) {
    try {
      const renamed = await api<Conversation>(
        `/api/elric/conversations/${encodeURIComponent(conversation.id)}`,
        { title },
        'PATCH',
      );
      setConversations((list) =>
        (list ?? []).map((item) =>
          item.id === renamed.id ? { ...item, title: renamed.title } : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The chat couldn’t be renamed. Try again.');
    }
  }

  async function deleteConversation(conversation: Conversation) {
    try {
      await api(`/api/elric/conversations/${encodeURIComponent(conversation.id)}`, {}, 'DELETE');
      const rest = (conversations ?? []).filter((item) => item.id !== conversation.id);
      setConversations(rest);
      if (chat?.room_id === conversation.id) {
        if (rest[0]) await selectConversation(rest[0]);
        else await newChat();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The chat couldn’t be deleted. Try again.');
    }
  }

  /** Home's Review: the chat with Elric's action cards, focus on them. */
  function review() {
    setReviewing(true);
    window.requestAnimationFrame(() => actions.current?.focus({ preventScroll: true }));
  }

  // Arriving from the workspace navigation (or a fresh load), the chat is ready to type into:
  // the composer takes focus once, unless the person already moved it, and not on touch screens
  // (it would open the keyboard over the chat).
  const focused = useRef(false);
  useEffect(() => {
    if (phase !== 'ready' || focused.current) return;
    focused.current = true;
    const active = document.activeElement;
    const free =
      !active ||
      active === document.body ||
      Boolean(active.closest('.wv2-navigation, [data-testid="elric-skeleton"]'));
    const fine =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    if (free && fine) input.current?.focus({ preventScroll: true });
  }, [phase]);

  // Reading the chat: Elric's frame (the same as the route showed while it loaded).
  if (phase === 'loading') return <ElricSkeleton embedded={embedded} />;

  const paused = chat?.status === 'paused';
  const readOnly = chat?.read_only === true;
  const atLimit = !error && notice !== '' && notice === limitNotice;
  const working = sentSeq !== null || forming !== null || chat?.waking === true;
  // Home (§1): nothing in this chat yet, and the person has not asked to review the actions.
  const home =
    phase === 'ready' &&
    !visible.length &&
    !working &&
    !(reviewing && (pending.length || done.length));
  const waiting = waitingLabel(pending.length);
  const live = liveLine(roomsOn, chat?.status);
  const typing = !paused && !readOnly;

  return (
    <div
      className={`elx elx3${conversations !== null && phase === 'ready' ? ' has-side' : ''}`}
      ref={root}
      data-embedded={embedded ? 'true' : undefined}
      data-arrive={arrive ? 'true' : undefined}
    >
      <header className="elx-header elx3-topbar">
        {/* In the workspace on phones and tablets the shell's ☰ row steps aside and this bar
            carries the ☰ chip: one top bar, as on a room page (elric-tokens.css). */}
        {embedded ? (
          <button
            type="button"
            className="elx3-chip elx3-menu"
            aria-label="Open navigation"
            onClick={openSidebar}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        ) : null}
        {conversations !== null && phase === 'ready' ? (
          <button
            type="button"
            className="elx3-chip elx-side-toggle"
            aria-label="Chats"
            aria-expanded={sideOpen}
            onClick={() => setSideOpen((value) => !value)}
          >
            <PanelLeft size={17} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
        {/* Standalone (outside the workspace shell): a way home, where the skeleton has its mark. */}
        {embedded ? null : (
          <a className="elx3-chip elx3-home-link" href="/" aria-label="Central City home">
            <CityMark small />
          </a>
        )}
        {/* No Elric yet (the first visit): the Meet Elric card is the page's only title. */}
        {phase === 'none' ? null : (
          <div className="elx-title elx3-pill">
            <ElricMark size="sm" />
            <h1>
              <button
                type="button"
                className="elx-name"
                title={elricTooltip()}
                aria-haspopup="dialog"
                onClick={() => setAbout(true)}
              >
                {ELRIC_NAME}
              </button>
            </h1>
            <span className="elx-tag" title={elricTooltip()}>
              built in<span className="visually-hidden"> {ELRIC_AI_TAG}</span>
            </span>
            {phase === 'ready' && live ? (
              <span className="elx3-live" data-live={live.live ? 'true' : undefined}>
                <i aria-hidden="true" />
                {live.text}
              </span>
            ) : null}
          </div>
        )}
        {/* No Elric yet (the first visit): nothing to manage and no chat to start. */}
        {phase !== 'none' ? (
          <div className="elx-actions elx3-actions">
            <button type="button" className="elx3-chip" aria-haspopup="dialog" onClick={openManage}>
              <Settings2 size={17} strokeWidth={1.9} aria-hidden="true" />
              <span className="elx3-chip-label">Manage Elric</span>
            </button>
            <button
              type="button"
              className="elx3-new"
              disabled={phase !== 'ready'}
              onClick={() => void newChat()}
            >
              <SquarePen size={17} strokeWidth={1.9} aria-hidden="true" />
              <span className="elx3-chip-label">New chat</span>
            </button>
          </div>
        ) : null}
      </header>

      {conversations !== null && phase === 'ready' ? (
        <ConversationList
          conversations={conversations}
          current={chat?.room_id || null}
          open={sideOpen}
          onSelect={(conversation) => void selectConversation(conversation)}
          onRename={(conversation) => {
            setSideOpen(false);
            setChatSheet({ kind: 'rename', conversation });
          }}
          onDelete={(conversation) => {
            setSideOpen(false);
            setChatSheet({ kind: 'delete', conversation });
          }}
          onClose={() => setSideOpen(false)}
        />
      ) : null}
      <main className="elx-main" ref={thread}>
        <div className="elx-column">
          {phase === 'none' ? (
            <ElricFirstVisit onReady={() => setLoadKey((key) => key + 1)} />
          ) : phase === 'error' ? (
            <div className="elx-empty elx3-gate" role="alert">
              <h2>Elric couldn’t load</h2>
              <button
                type="button"
                className="elx3-btn is-primary"
                onClick={() => location.reload()}
              >
                Try again
              </button>
            </div>
          ) : home ? (
            <div className="elx-empty elx3-home">
              <ElricMark size="orb" />
              <h2>What can I help with?</h2>
              {waiting ? (
                <p className="elx3-approve-pill">
                  <span id="elx3-waiting">{waiting}</span>
                  <button type="button" aria-describedby="elx3-waiting" onClick={review}>
                    Review
                  </button>
                </p>
              ) : null}
            </div>
          ) : (
            <div className="elx-thread" aria-live="polite">
              {fromSeq > 0 && messages.some((item) => item.seq <= fromSeq) && (
                <button type="button" className="elx-link" onClick={() => setFromSeq(0)}>
                  Show earlier messages
                </button>
              )}
              {visible.map((message) =>
                mine(message) ? (
                  <div
                    key={message.id}
                    className="elx-turn elx-turn-you"
                    data-arrived={arrived.current.has(message.id) ? 'true' : undefined}
                  >
                    <p className="elx-bubble">{shown(message.text)}</p>
                    {messageClock(message.created_at) ? (
                      <time className="elx3-time" dateTime={message.created_at}>
                        {messageClock(message.created_at)}
                      </time>
                    ) : null}
                  </div>
                ) : (
                  <Reply
                    key={message.id}
                    message={message}
                    live={liveReplies.current.has(message.id)}
                    arrived={
                      arrived.current.has(message.id) && !liveReplies.current.has(message.id)
                    }
                    room={chat?.room_id}
                  />
                ),
              )}
              {pending.length || done.length ? (
                <ActionBubble
                  pending={pending}
                  done={done}
                  deciding={deciding}
                  onDecide={(item, decision) => void decide(item, decision)}
                  focusRef={actions}
                  continued={Boolean(visible.length && !mine(visible[visible.length - 1]!))}
                />
              ) : null}
              {sentSeq !== null && forming && !answered ? (
                <DraftReply text={forming} revealAs={revealKey(chat?.room_id ?? '', sentSeq)} />
              ) : (sentSeq !== null && !answered) || chat?.waking ? (
                <div className="elx3-msg elx3-thinking">
                  <ElricMark />
                  <ThinkingDots
                    className="elx-turn elx-turn-elric"
                    {...(sentSeq !== null ? { since: sentAt } : {})}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </main>

      {phase === 'ready' && readOnly ? (
        <footer className="elx-dock" ref={dock}>
          <div className="elx-column">
            <p className="elx-notice" role="status">
              This chat is read-only: its Elric was removed. Start a new chat to continue.
            </p>
          </div>
        </footer>
      ) : null}
      {phase === 'ready' && !readOnly && (
        <footer className="elx-dock" ref={dock}>
          <div className="elx-column">
            {(notice || error || paused) && (
              <p
                className={`elx-notice ${error ? 'is-error' : ''}${atLimit ? ' is-limit' : ''}`}
                role="status"
              >
                {atLimit ? <MascotRest /> : null}
                {error || notice || (
                  <>
                    Elric is paused.{' '}
                    <button
                      type="button"
                      className="elx-retry"
                      aria-haspopup="dialog"
                      onClick={openManage}
                    >
                      Resume it in Manage Elric
                    </button>
                  </>
                )}
                {error && retry ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="elx-retry"
                      onClick={() => {
                        const text = retry;
                        setRetry(null);
                        void send(text);
                      }}
                    >
                      Try again
                    </button>
                  </>
                ) : null}
              </p>
            )}
            {picker && (
              <div className="elx-picker" role="listbox" aria-label="Ask in a room">
                {picker.length === 0 ? (
                  <p className="elx-meta">Elric isn’t in any room yet.</p>
                ) : (
                  picker.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      role="option"
                      aria-selected={target?.id === room.id}
                      className="elx-option"
                      disabled={!room.elric_member}
                      onClick={() => {
                        setTarget(room);
                        setPicker(null);
                        input.current?.focus();
                      }}
                    >
                      <span># {room.name}</span>
                      {!room.elric_member && <span className="elx-meta">Elric isn’t here</span>}
                    </button>
                  ))
                )}
              </div>
            )}
            {home && typing ? (
              <div className="elx-chips elx3-sugs" role="group" aria-label="Suggestions">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    type="button"
                    className="elx-chip"
                    onClick={() => {
                      setDraft(text);
                      input.current?.focus();
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            ) : null}
            <form
              className="elx-composer elx3-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={input}
                rows={1}
                value={draft}
                maxLength={4000}
                placeholder={home ? 'Ask Elric…' : 'Message Elric…'}
                aria-label="Message Elric"
                disabled={paused}
                onChange={(event) => {
                  setDraft(event.target.value);
                  // The kept message follows edits until it is sent (emptied: gone).
                  if (keptDraft.current) {
                    savePendingDraft(event.target.value);
                    if (!event.target.value.trim()) keptDraft.current = false;
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="elx3-tools">
                {/* The context pill: answer here, or ask in a room (posts there, publicly). */}
                <button
                  type="button"
                  className={`elx3-context${target ? ' is-on' : ''}`}
                  aria-label={`${target ? `# ${target.name}` : 'Here'} · Ask in a room`}
                  aria-expanded={!!picker}
                  aria-haspopup="listbox"
                  onClick={() => void openPicker()}
                >
                  <ElricMark size="xs" />
                  <span className="elx3-context-name">{target ? `# ${target.name}` : 'Here'}</span>
                  <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                {target && (
                  <button
                    type="button"
                    className="elx3-unset"
                    aria-label={`Stop asking in ${target.name}`}
                    onClick={() => setTarget(null)}
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
                <span className="elx3-grow" />
                <button
                  type="submit"
                  className="elx-send"
                  aria-label="Send"
                  disabled={!draft.trim() || sending || paused}
                >
                  <ArrowUp size={20} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
            </form>
          </div>
        </footer>
      )}
      {about && <AboutSheet onClose={closeAbout} />}
      {manage && (
        <ManageElricSheet
          onClose={closeManage}
          onStatus={(status) => setChat((current) => (current ? { ...current, status } : current))}
        />
      )}
      {chatSheet?.kind === 'rename' ? (
        <RenameSheet
          conversation={chatSheet.conversation}
          onClose={() => setChatSheet(null)}
          onSave={(title) =>
            renameConversation(chatSheet.conversation, title).then(() => setChatSheet(null))
          }
        />
      ) : chatSheet?.kind === 'delete' ? (
        <DeleteSheet
          conversation={chatSheet.conversation}
          onClose={() => setChatSheet(null)}
          onDelete={() => deleteConversation(chatSheet.conversation).then(() => setChatSheet(null))}
        />
      ) : null}
    </div>
  );
}

export default ElricDashboard;
