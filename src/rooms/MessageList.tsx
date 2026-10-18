import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowDown, Check, Copy, Info, LoaderCircle, Pin, Reply, RotateCw } from 'lucide-react';
import { Avatar, initialOf, useAvatarColours, type AvatarKind } from './Avatar';
import type { RoomTask } from './tasks';
import { pillPlacement, taskPill } from './taskStatusV3';
import { answersPost, type Member, type RoomMessage } from './api';
import { agentOwners, mentionNamesFor, ownerNames } from './people';
import { AgentLabel } from './AgentLabel';
import { messageFormat, NEW_POST_FORMAT, withoutBidiControls } from './markdown/format';
import { MessageBoundary } from './markdown/Boundary';
// Elric's answers that arrive while the room is open are revealed smoothly (Streaming.tsx).
import { useStreaming } from './markdown/streamingLoader';
import { ELRIC_AI_TAG, ELRIC_NAME, elricReplyTag, elricTooltip } from '../../shared/elric-copy';
import { ThinkingDots } from '../elric/ThinkingDots';
import { ElricApprovalCard } from './elric';
import { newSinceOf } from './newSince';
import { NewSinceDivider } from './NewSinceDivider';

// The Markdown renderer (parser, GFM) is its own chunk, loaded only for Markdown messages; until
// it arrives the message shows as plain text, so nothing waits on it.
const Markdown = lazy(() =>
  import('./markdown/Markdown').then((module) => ({ default: module.Markdown })),
);
/**
 * The reveal of one Elric answer: its draft, then the posted message that answers the same post
 * (auto_reply.reply_to), share it; any other message is its own.
 */
const revealKey = (room: string, message: RoomMessage) =>
  message.auto_reply?.reply_to !== undefined
    ? `room:${room}:${message.auto_reply.reply_to}`
    : `message:${message.id}`;
/** An Elric message this recent that appears while the room is open is revealed, not shown at once. */
const LIVE_MS = 120_000;

/** A text part: Markdown when the message's format says so (docs/ROOMS.md), else plain. */
function TextPart({
  text,
  names,
  markdown,
  priority = 0,
  reveal,
}: {
  text: string;
  names: string[];
  markdown: boolean;
  /** Parse order (the message seq): the newest messages are parsed first. */
  priority?: number;
  /** Elric's answer arriving live: revealed smoothly, `done` once it is the posted message. */
  reveal?: { done: boolean; key: string };
}) {
  const streaming = useStreaming(Boolean(reveal));
  const clean = withoutBidiControls(text);
  const plain = <RichText text={clean} names={names} />;
  if (!markdown) return plain;
  return (
    <MessageBoundary fallback={plain}>
      <Suspense fallback={plain}>
        {reveal && streaming ? (
          <streaming.StreamingMarkdown
            text={clean}
            done={reveal.done}
            revealKey={reveal.key}
            names={names}
          />
        ) : (
          <Markdown text={clean} names={names} priority={priority} />
        )}
      </Suspense>
    </MessageBoundary>
  );
}

const NO_NAMES: string[] = [];
const NO_MEMBERS: readonly Member[] = [];

/** Distance from the bottom (px) that still counts as "at the newest message". */
const PINNED_PX = 48;
/** Distance from the top (px) that starts loading older messages. */
const OLDER_PX = 160;
/** Consecutive messages from one agent within this window share a byline. */
const GROUP_MS = 5 * 60_000;

export { initialOf };

/** A message still on its way (or failed); it keeps its idempotency key for Retry. */
export type PendingMessage = {
  key: string;
  text: string;
  agentId?: string;
  sender: string;
  /** The newest seq shown when it was sent: its server copy has a greater seq. */
  afterSeq: number;
  failed?: string;
};
/** While the reader is at the bottom, state keeps only the newest messages (as in Messages). */
export const KEEP = 200;
const TRIM_AT = 250;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function dayLabel(date: Date, now = new Date()) {
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(date) - start(now)) / 86_400_000);
  return days >= -1
    ? relative.format(days, 'day').replace(/^./, (c) => c.toUpperCase())
    : dayFormat.format(date);
}

/** Plain text with line breaks kept, URLs linked and @mentions of members as chips. No Markdown. */
function RichText({ text, names }: { text: string; names: string[] }) {
  const mention = names.length
    ? `@(?:${names
        .sort((a, b) => b.length - a.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`
    : null;
  const pattern = new RegExp(
    `(https?://[^\\s<>"]+[^\\s<>".,;:!?)\\]'])${mention ? `|(${mention})` : ''}`,
    'g',
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1])
      out.push(
        <a key={match.index} href={match[1]} target="_blank" rel="noopener nofollow ugc noreferrer">
          {match[1]}
        </a>,
      );
    else
      out.push(
        <span key={match.index} className="rm-mention">
          {match[2]}
        </span>,
      );
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return <p className="rm-text">{out}</p>;
}

function dataSummary(data: unknown, mimeType?: string): string {
  if (mimeType) return `Shared data: ${mimeType}`;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data).slice(0, 4);
    if (keys.length)
      return `Shared data: ${keys.join(', ')}${Object.keys(data).length > 4 ? ', …' : ''}`;
  }
  return Array.isArray(data) ? `Shared data: a list of ${data.length}` : 'Shared data';
}

function DataPart({ data, mimeType }: { data: unknown; mimeType?: string }) {
  const json = JSON.stringify(data, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div className="rm-data">
      <span className="rm-data-summary">{dataSummary(data, mimeType)}</span>
      <details>
        <summary>Details</summary>
        <pre>{json}</pre>
        <button
          type="button"
          className="rm-quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(json).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </details>
    </div>
  );
}

const systemText = (message: RoomMessage) =>
  withoutBidiControls(
    message.text || message.parts?.map((p) => (p.type === 'text' ? p.text : '')).join('') || '',
  );

/**
 * A server line (a member left, a task changed, the room ended): a small centred pill. When the
 * line starts with a current member's name, a 24 px avatar in that member's colour leads it
 * (drawn by CSS from data-initial, so the line's text stays exactly the server's text).
 */
function SystemLine({
  message,
  byLength = NO_MEMBERS,
  folded = false,
}: {
  message: RoomMessage;
  /**
   * The line's task pill sits under the message just before it (§1.4), so the line is folded:
   * kept for screen readers, not shown.
   */
  folded?: boolean;
  /** The members, longest name first (memoised by the list), so "Nova Bot" wins over "Nova". */
  byLength?: readonly Member[];
}) {
  const clean = systemText(message);
  const actor = byLength.find((member) => member.name && clean.startsWith(`${member.name} `));
  const kind: AvatarKind | null = actor
    ? actor.auto_reply?.provider === 'elric'
      ? 'elric'
      : actor.kind === 'person'
        ? 'person'
        : 'agent'
    : null;
  const colours = useAvatarColours(actor?.id ?? '', kind);
  return (
    <li
      className={`rm-system-line${folded ? ' rm-visually-hidden' : ''}`}
      data-testid="room-system-line"
      data-id={message.id}
      data-folded={folded || undefined}
    >
      <span
        className="rm3-sys"
        data-initial={actor ? initialOf(actor.name) : undefined}
        data-kind={kind ?? undefined}
        style={
          colours?.backgroundColor
            ? ({ '--rm3-sys-av': colours.backgroundColor } as CSSProperties)
            : undefined
        }
      >
        {clean}
      </span>
    </li>
  );
}

/** A task's state under the message or line that created or claimed it (§1.4): opens the task. */
function StatusPill({ task, onOpen }: { task: RoomTask; onOpen?: (taskNumber: number) => void }) {
  const pill = taskPill(task);
  const body = (
    <>
      <i aria-hidden="true" />
      {pill.label}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="rm3-status"
      data-tone={pill.tone}
      data-testid="message-task-status"
      aria-label={`T${task.number} ${task.title}: ${pill.label}`}
      title={`T${task.number} ${task.title}`}
      onClick={() => onOpen(task.number)}
    >
      {body}
    </button>
  ) : (
    <span
      className="rm3-status"
      data-tone={pill.tone}
      data-testid="message-task-status"
      title={`T${task.number} ${task.title}`}
    >
      {body}
    </span>
  );
}

/**
 * The quiet action row under a message (§4.2): Reply (a mention of the author in the composer),
 * Pin, Copy (the message text) and Details (exact time, number, who posted it). Shown on hover or
 * focus on desktop, always on touch screens (rooms-v3.css).
 */
function MessageActions({
  message,
  author,
  onReply,
  onPin,
}: {
  message: RoomMessage;
  /** The name a reply mentions; null on your own messages (no reply to yourself). */
  author: string | null;
  onReply?: ((name: string) => void) | undefined;
  onPin?: ((message: RoomMessage) => void) | undefined;
}) {
  const [copied, setCopied] = useState<'' | 'done' | 'failed'>('');
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  // One tab stop per row (roving): Tab reaches the row once, the arrow keys move inside it, so
  // the hidden-until-hover actions never add a tab stop per button.
  const [current, setCurrent] = useState(0);
  const count = (author && onReply ? 1 : 0) + (onPin ? 1 : 0) + 2;
  const active = Math.min(current, count - 1);
  const stop = (index: number) => (index === active ? 0 : -1);
  const roam = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    setCurrent(next);
    buttons[next]?.focus();
  };
  const copy = async () => {
    const clean = withoutBidiControls(text);
    let ok = false;
    try {
      await navigator.clipboard.writeText(clean);
      ok = true;
    } catch {
      // No clipboard permission (or an insecure page): the old copy command, from a hidden field.
      const field = document.createElement('textarea');
      field.value = clean;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      field.remove();
    }
    setCopied(ok ? 'done' : 'failed');
    window.setTimeout(() => setCopied(''), ok ? 2000 : 4000);
  };
  let index = -1;
  const nextIndex = () => (index += 1);
  const text = message.parts
    .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part.data, null, 2)))
    .join('\n\n');
  const date = new Date(message.created_at);
  return (
    <>
      <div
        className="rm3-actions"
        role="group"
        aria-label="Message actions"
        onKeyDown={roam}
        onFocus={(event) => {
          const buttons = [...event.currentTarget.querySelectorAll('button')];
          const at = buttons.indexOf(event.target as unknown as HTMLButtonElement);
          if (at >= 0) setCurrent(at);
        }}
      >
        {author && onReply ? (
          <button
            type="button"
            className="rm3-action"
            tabIndex={stop(nextIndex())}
            aria-label={`Reply to ${author}`}
            onClick={() => onReply(author)}
          >
            <Reply size={13} aria-hidden="true" />
            <span>Reply</span>
          </button>
        ) : null}
        {onPin ? (
          <button
            type="button"
            className="rm3-action rm-v2-message-action"
            tabIndex={stop(nextIndex())}
            data-testid="message-pin"
            aria-label="Pin this message"
            onClick={() => onPin(message)}
          >
            <Pin size={13} aria-hidden="true" />
            <span>Pin</span>
          </button>
        ) : null}
        <button
          type="button"
          className="rm3-action"
          tabIndex={stop(nextIndex())}
          aria-label={
            copied === 'done' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy message'
          }
          onClick={() => void copy()}
        >
          {copied === 'done' ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Copy size={13} aria-hidden="true" />
          )}
          <span>
            {copied === 'done' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
          </span>
        </button>
        <button
          type="button"
          className="rm3-action"
          tabIndex={stop(nextIndex())}
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={() => setDetails((value) => !value)}
        >
          <Info size={13} aria-hidden="true" />
          <span>Details</span>
        </button>
      </div>
      {copied === 'failed' ? (
        <p className="rm3-copy-failed" role="status">
          Couldn&rsquo;t copy. Select the text in the message and copy it yourself.
        </p>
      ) : null}
      {details ? (
        <dl className="rm3-details" id={detailsId}>
          <div>
            <dt>Sent</dt>
            <dd>
              <time dateTime={message.created_at}>{date.toLocaleString()}</time>
            </dd>
          </div>
          <div>
            <dt>Message</dt>
            <dd>#{message.seq}</dd>
          </div>
          {message.own ? null : (
            <div>
              <dt>From</dt>
              <dd>
                {message.sender}
                {message.sender_owner_label ? ` · ${message.sender_owner_label}` : ''}
              </dd>
            </div>
          )}
        </dl>
      ) : null}
    </>
  );
}

function Message({
  message,
  names,
  owner,
  agentOwner,
  byline,
  host,
  live = false,
  arrive = false,
  roomId = '',
  onPin,
  onReply,
  status = null,
  showSender = false,
  direct = null,
  note = null,
}: {
  message: RoomMessage;
  names: string[];
  owner: (label: string) => string;
  /** An agent's owner by name, or null (people.ts agentOwners). */
  agentOwner: (label: string) => string | null;
  byline: boolean;
  /** The sender hosts the room. */
  host: boolean;
  /** Elric's answer that arrived while the room was open: revealed smoothly. */
  live?: boolean;
  /** Arrived while the room was open: rises in (rooms-v3.css, off under reduced motion). */
  arrive?: boolean;
  /** The room, for the reveal's key. */
  roomId?: string;
  /** The Pin action (absent when the viewer cannot pin). */
  onPin?: ((message: RoomMessage) => void) | undefined;
  /** The Reply action (absent when the viewer cannot post). */
  onReply?: ((name: string) => void) | undefined;
  /** The status pill of the task this message created or claimed. */
  status?: ReactNode;
  /** Your own message names the identity it was posted as (you post as more than one). */
  showSender?: boolean;
  /** "Message privately" on the author (src/rooms/direct.ts), in the byline. */
  direct?: ReactNode;
  /** Your own message only: a quiet line under it (your @mentioned agent can't answer yet). */
  note?: ReactNode;
}) {
  if ((message as { sender_kind?: string }).sender_kind === 'system') {
    return <SystemLine message={message} />;
  }
  const date = new Date(message.created_at);
  const time = (
    <time dateTime={message.created_at} title={date.toLocaleString()}>
      {timeFormat.format(date)}
    </time>
  );
  const isElric = message.auto_reply?.provider === 'elric';
  const markdown = messageFormat(message as { format?: unknown }) === 'markdown';
  const className = (kind: string) =>
    `rm-message ${kind}${byline ? '' : ' grouped'}${arrive ? ' rm3-arrive' : ''}`;
  // Your own messages: an accent bubble on the right, no avatar or byline (the name stays for
  // assistive technology), the time small under the bubble. Elric's replies always render as
  // Elric on the left with avatar, name and badges, even if own is true.
  if (message.own && !isElric)
    return (
      <li className={className('own')} data-testid="room-message" data-id={message.id}>
        <span className="rm-visually-hidden">{message.sender} (you)</span>
        <div className="rm3-body">
          <div className="rm-bubble rm-own-bubble">
            {message.parts.map((part, index) =>
              part.type === 'text' ? (
                <TextPart
                  key={index}
                  text={part.text}
                  names={names}
                  markdown={markdown}
                  priority={message.seq}
                />
              ) : (
                <DataPart
                  key={index}
                  data={part.data}
                  mimeType={(part as { mimeType?: string }).mimeType}
                />
              ),
            )}
          </div>
          {/* One quiet row under the bubble: the status pill, the actions, then the time. */}
          <div className="rm3-foot">
            {status}
            <MessageActions message={message} author={null} onPin={onPin} />
            <span className="rm-own-time">
              {showSender ? <span className="rm3-own-as">{message.sender} · </span> : null}
              {time}
            </span>
          </div>
          {note}
        </div>
      </li>
    );

  const senderName = isElric ? ELRIC_NAME : message.sender;
  const tag = isElric ? elricReplyTag(message.auto_reply?.model) : null;
  const tooltip = isElric ? elricTooltip() : undefined;
  const kind: AvatarKind = isElric
    ? 'elric'
    : message.sender_kind === 'person'
      ? 'person'
      : 'agent';

  return (
    <li
      className={className(isElric ? 'elric' : message.sender_kind === 'person' ? 'person' : 'ai')}
      data-testid="room-message"
      data-id={message.id}
    >
      <Avatar id={message.sender_agent_id} name={senderName} kind={kind} hidden={!byline} />
      <div className="rm3-body">
        {byline ? (
          <div className="rm-byline">
            <strong>{senderName}</strong>
            {isElric ? (
              <>
                {/* §4.2: one badge for Elric, "built-in AI" on a model reply (EU AI Act
                    Art. 50: visible to everyone), and the tooltip names the version. */}
                {tag ? (
                  <span className="rm-badge-elric rm3-tag" data-tone="accent" title={tooltip}>
                    built-in {tag}
                  </span>
                ) : (
                  <span className="rm3-tag" data-tone="accent">
                    built in
                  </span>
                )}
                {tag ? null : (
                  <span className="rm-server-label" title={tooltip}>
                    · automated
                  </span>
                )}
              </>
            ) : (
              <>
                {message.auto_reply?.label ? (
                  <span className="rm-badge-reply">{message.auto_reply.label}</span>
                ) : null}
                {host ? <span className="rm-role rm3-tag">Host</span> : null}
                {message.sender_kind === 'person' ? (
                  <>
                    {host ? null : <span className="rm-role rm-person rm3-tag">person</span>}
                    <span className="rm3-owner" title={message.sender_owner_label}>
                      · {owner(message.sender_owner_label)}
                    </span>
                  </>
                ) : (
                  <AgentLabel
                    owner={agentOwner(message.sender_owner_label)}
                    title={message.sender_owner_label}
                  />
                )}
              </>
            )}
            {time}
            {direct}
          </div>
        ) : null}
        <div className="rm-bubble">
          {message.parts.map((part, index) =>
            part.type === 'text' ? (
              <TextPart
                key={index}
                text={part.text}
                names={names}
                markdown={markdown}
                priority={message.seq}
                {...(live && isElric
                  ? { reveal: { done: true, key: revealKey(roomId, message) } }
                  : {})}
              />
            ) : (
              <DataPart
                key={index}
                data={part.data}
                mimeType={(part as { mimeType?: string }).mimeType}
              />
            ),
          )}
        </div>
        {message.auto_reply?.pending_id ? (
          <ElricApprovalCard pendingId={message.auto_reply.pending_id} />
        ) : null}
        <div className="rm3-foot">
          {status}
          <MessageActions message={message} author={senderName} onReply={onReply} onPin={onPin} />
        </div>
      </div>
    </li>
  );
}

/**
 * The scrolling message list (the same pattern as Messages): opens at the newest message,
 * follows new ones while the reader is at the bottom, keeps the reading position when older
 * pages load above, and otherwise offers "New messages".
 */
export function MessageList({
  messages,
  pending,
  members,
  hasOlder,
  loadingOlder,
  onOlder,
  onRetry,
  onDiscard,
  onTrim,
  follow,
  elricDraft = null,
  focus = null,
  roomId = '',
  onPin,
  onReply,
  tasks = null,
  onOpenTask,
  newSinceMark,
  newSinceSummary,
  directFor,
  noteFor,
  onPinnedChange,
  children,
}: {
  messages: RoomMessage[];
  pending: PendingMessage[];
  members: Member[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onOlder: () => void;
  onRetry: (key: string) => void;
  onDiscard: (key: string) => void;
  /** Called while the reader is at the bottom and the list has grown long. */
  onTrim: (keep: number) => void;
  /** Changes when the viewer sends: always scroll to it. */
  follow: number;
  /**
   * Elric's answer while it forms (GET /api/rooms/:room/elric-drafts) after the viewer's own
   * @Elric post: '' shows the thinking dots, text shows the forming answer; null shows nothing.
   * The posted message replaces it.
   */
  elricDraft?: { text: string; since: number; after?: number } | null;
  /** The room shown (keys the smooth reveal of Elric's answers). */
  roomId?: string;
  /**
   * A message to show (a search result): scrolled into view and briefly highlighted once it is in
   * the list. `key` changes on every jump, also to the same message again.
   */
  focus?: { id: string; key: number } | null;
  /** Smart Rooms v2 only: a Pin action on each message (absent: no action, v1 unchanged). */
  onPin?: ((message: RoomMessage) => void) | undefined;
  /** Reply on others' messages: puts "@Name " in the composer (absent when you cannot post). */
  onReply?: ((name: string) => void) | undefined;
  /** The room's tasks, for the status pills (null: no pills, tasks off or not loaded). */
  tasks?: readonly RoomTask[] | null;
  /** A status pill opens its task in the Tasks panel. */
  onOpenTask?: (taskNumber: number) => void;
  /**
   * Smart Rooms v2 preview: the person's read mark for this room when it opened (newSince.ts).
   * Set, a "New since" divider sits above the first unread message; undefined shows none.
   */
  newSinceMark?: number;
  /** Slot for an expandable catch-up summary inside the "New since" divider (the catch-up, CatchUpSummary). */
  newSinceSummary?: ReactNode;
  /** Shown above the first message (the room notice). */
  children?: ReactNode;
  /** The "Message privately" action on an author, by member id (null when not offered). */
  directFor?: (memberId: string) => ReactNode;
  /** A quiet line under one of your own messages (null for none). */
  noteFor?: (message: RoomMessage) => ReactNode;
  /** Whether the reader follows the bottom (true) or scrolled or jumped away (false), on each change. */
  onPinnedChange?: (pinned: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const pinnedChange = useRef(onPinnedChange);
  pinnedChange.current = onPinnedChange;
  const setPinned = (value: boolean) => {
    if (pinned.current !== value) pinnedChange.current?.(value);
    pinned.current = value;
  };
  // A new list (another room, or the list shown again) reports where it starts.
  useEffect(() => {
    pinnedChange.current?.(pinned.current);
  }, []);
  // The scroll position the last scroll event saw: only a move up releases the bottom.
  const lastTop = useRef(0);
  const previous = useRef<{ first?: string; last?: string; anchor: number; follow: number }>({
    anchor: 0,
    follow,
  });
  const [unseen, setUnseen] = useState(0);
  // The "New since" divider: the mark as it was when the list opened. It goes after the
  // viewer's next post (follow changes); once the room is read, the next visit has no divider.
  const [sinceMark] = useState(newSinceMark);
  const [followAtOpen] = useState(follow);
  const newSince =
    sinceMark !== undefined && follow === followAtOpen
      ? newSinceOf(messages, sinceMark, hasOlder)
      : null;
  // Your own pending posts: "@<your own host>" is a mention only when you wrote as yourself
  // (people.ts mentionNamesFor). Without an agentId the post goes as your only identity here.
  const mySenders = members.filter((member) => member.own);
  const ownNames = (item: PendingMessage) =>
    mentionNamesFor(members, {
      own: true,
      sender_kind: (item.agentId
        ? members.find((member) => member.id === item.agentId)
        : mySenders.length === 1
          ? mySenders[0]
          : undefined
      )?.kind,
    });
  const owner = ownerNames(members);
  const agentOwner = agentOwners(members);
  const hostId = members.find((member) => member.role === 'host')?.id;
  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setPinned(true);
    setUnseen(0);
  };
  const offsetOf = (id: string | undefined) =>
    id
      ? (scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.offsetTop ??
        null)
      : null;
  const lastKey = pending.at(-1)?.key ?? messages.at(-1)?.id;
  // A jump stops following the bottom first, so loading the pages around it never trims it away.
  const wanted = useRef<string | null>(null);
  const focusKey = focus?.key;
  useLayoutEffect(() => {
    if (!focus) return;
    wanted.current = focus.id;
    setPinned(false);
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const before = previous.current;
    const first = messages[0]?.id;
    const last = lastKey;
    if (!before.last) {
      // With unread messages above the fold, open at the "New since" divider instead.
      const divider = element.querySelector<HTMLElement>('[data-testid="room-new-since"]');
      if (divider && divider.offsetTop < element.scrollHeight - element.clientHeight) {
        element.scrollTop = Math.max(0, divider.offsetTop - 16);
        setPinned(false);
      } else if (last) toBottom();
    } else {
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
  }, [messages, lastKey, follow, onTrim]);
  useLayoutEffect(() => {
    const id = wanted.current;
    const element = id
      ? scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
      : null;
    if (!element) return;
    wanted.current = null;
    setPinned(false);
    element.scrollIntoView({ block: 'center' });
    // Keyboard and screen reader users land on the message too.
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
    element.classList.add('rm-found');
    window.setTimeout(() => element.classList.remove('rm-found'), 2600);
    // A thread that fits (or a jump that lands at the end) never scrolls, so no scroll event
    // re-pins it: check once the layout settles, or new messages would stay unread.
    window.requestAnimationFrame(() => {
      const list = scroller.current;
      if (list && list.scrollHeight - list.scrollTop - list.clientHeight < PINNED_PX) {
        setPinned(true);
        setUnseen(0);
      }
    });
  }, [messages, focusKey]);
  // Elric's forming answer sits under the viewer's post: while the reader is at the bottom,
  // keep it in view as it appears and grows (dots, then text revealed frame by frame), like a
  // message. Any growth of the thread follows while pinned; scrolling up releases it.
  const column = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    const content = column.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const draftShown = elricDraft !== null;
  useLayoutEffect(() => {
    if (draftShown && pinned.current) toBottom();
  }, [draftShown]); // eslint-disable-line react-hooks/exhaustive-deps

  // With Elric in the room (or its answer forming), the reveal is loaded before an answer comes.
  const elricHere =
    elricDraft !== null || members.some((member) => member.auto_reply?.provider === 'elric');
  const streaming = useStreaming(elricHere);

  // Elric messages that arrive while the room is open (after its first messages showed) are
  // revealed; history, older pages and another room's messages show at once.
  const seen = useRef<{ ids: Set<string>; maxSeq: number } | null>(null);
  const live = useRef(new Set<string>());
  // Messages from others that arrive while the room is open rise in (§2 motion). Your own posts
  // already rose in as pending, so their server copy does not move again.
  const arrived = useRef(new Set<string>());
  const base = seen.current;
  if (base && messages.some((message) => base.ids.has(message.id)))
    for (const message of messages)
      if (!base.ids.has(message.id) && message.seq > base.maxSeq) {
        if (!message.own || message.auto_reply?.provider === 'elric')
          arrived.current.add(message.id);
        if (
          message.auto_reply?.provider === 'elric' &&
          Date.now() - Date.parse(message.created_at) < LIVE_MS
        )
          live.current.add(message.id);
      }
  useLayoutEffect(() => {
    if (!messages.length) return;
    const ids = seen.current?.ids ?? new Set<string>();
    for (const message of messages) ids.add(message.id);
    seen.current = {
      ids,
      maxSeq: Math.max(seen.current?.maxSeq ?? 0, ...messages.map((message) => message.seq)),
    };
  }, [messages]);
  // The posted answer replaces the draft in the same frame.
  // The posted answer to the viewer's own post replaces the draft in the same frame (not
  // Elric answering someone else meanwhile).
  const answered =
    elricDraft?.after !== undefined &&
    messages.some((message) => answersPost(message, elricDraft.after!));
  useEffect(() => {
    const element = scroller.current;
    if (element && hasOlder && !loadingOlder && element.scrollHeight <= element.clientHeight)
      onOlder();
  }, [messages, hasOlder, loadingOlder, onOlder]);

  // Status pills (§4.2): placed once per change of the messages (taskStatusV3 pillPlacement),
  // filled from the task list on render (a map lookup per pill).
  const placement = useMemo(() => pillPlacement(messages, GROUP_MS), [messages]);
  const taskByNumber = useMemo(
    () => new Map((tasks ?? []).map((task) => [task.number, task])),
    [tasks],
  );
  const membersByLength = useMemo(
    () => [...members].sort((a, b) => b.name.length - a.name.length),
    [members],
  );
  const pillOn = (id: string) => {
    const number = placement.on.get(id);
    return number === undefined ? undefined : taskByNumber.get(number);
  };
  const pillAfter = (id: string) => {
    const number = placement.after.get(id);
    return number === undefined ? undefined : taskByNumber.get(number);
  };
  const pill = (task: RoomTask | undefined) =>
    task ? <StatusPill task={task} onOpen={onOpenTask} /> : null;
  // Posting as more than one identity: your own messages say which one.
  const ownIdentities = members.filter(
    (member) => member.own && member.auto_reply?.provider !== 'elric',
  ).length;

  const rows: ReactNode[] = [];
  let previousMessage: RoomMessage | undefined;
  for (const message of messages) {
    const date = new Date(message.created_at);
    const newDay =
      !previousMessage ||
      new Date(previousMessage.created_at).toDateString() !== date.toDateString();
    if (newDay)
      rows.push(
        <li key={`day-${message.id}`} className="rm-day" aria-hidden="true">
          <span>{dayLabel(date)}</span>
        </li>,
      );
    if (newSince?.firstId === message.id)
      rows.push(
        <NewSinceDivider
          key="new-since"
          info={newSince}
          time={timeFormat.format(newSince.since)}
          summary={newSinceSummary}
        />,
      );
    const isSystem = (message as { sender_kind?: string }).sender_kind === 'system';
    if (isSystem) {
      // A created/claimed line whose pill went under the message before it folds away (the
      // pill says it there); without a placed pill (task not loaded) the line stays.
      const folds = placement.folded.get(message.id);
      rows.push(
        <SystemLine
          key={message.id}
          message={message}
          byLength={membersByLength}
          folded={folds !== undefined && taskByNumber.has(folds)}
        />,
      );
      const after = pillAfter(message.id);
      if (after)
        rows.push(
          <li key={`status-${message.id}`} className="rm3-status-row">
            {pill(after)}
          </li>,
        );
    } else {
      const byline =
        newDay ||
        !previousMessage ||
        (previousMessage as { sender_kind?: string }).sender_kind === 'system' ||
        previousMessage.sender_agent_id !== message.sender_agent_id ||
        date.getTime() - new Date(previousMessage.created_at).getTime() > GROUP_MS;
      rows.push(
        <Message
          key={message.id}
          message={message}
          names={mentionNamesFor(members, message)}
          owner={owner}
          agentOwner={agentOwner}
          byline={byline}
          host={Boolean(hostId) && message.sender_agent_id === hostId}
          live={live.current.has(message.id)}
          arrive={arrived.current.has(message.id)}
          roomId={roomId}
          onPin={onPin}
          onReply={onReply}
          status={pill(pillOn(message.id))}
          showSender={ownIdentities > 1}
          direct={byline && directFor ? directFor(message.sender_agent_id) : null}
          note={message.own && noteFor ? noteFor(message) : null}
        />,
      );
    }
    previousMessage = message;
  }
  for (const item of pending)
    rows.push(
      <li
        key={item.key}
        className={`rm-message own rm3-arrive${item.failed ? ' failed' : ' sending'}`}
        data-id={item.key}
        data-testid="room-message-pending"
      >
        <span className="rm-visually-hidden">{item.sender} (you)</span>
        <div className="rm3-body">
          <div className="rm-bubble rm-own-bubble">
            <TextPart
              text={item.text}
              names={ownNames(item)}
              markdown={NEW_POST_FORMAT === 'markdown'}
              priority={Number.MAX_SAFE_INTEGER - 1}
            />
          </div>
          {item.failed ? (
            <div className="rm-failed" role="alert">
              <span>Not sent. {item.failed}</span>
              <button type="button" className="rm-quiet" onClick={() => onRetry(item.key)}>
                <RotateCw size={14} aria-hidden="true" />
                Retry
              </button>
              <button type="button" className="rm-quiet" onClick={() => onDiscard(item.key)}>
                Discard
              </button>
            </div>
          ) : (
            <span className="rm-sending">Sending…</span>
          )}
        </div>
      </li>,
    );
  if (elricDraft && !answered)
    rows.push(
      <li
        key="elric-draft"
        className="rm-message elric rm-elric-draft rm3-arrive"
        data-testid="room-elric-draft"
        aria-busy="true"
      >
        <Avatar name={ELRIC_NAME} kind="elric" />
        <div className="rm3-body">
          <div className="rm-byline">
            <strong>{ELRIC_NAME}</strong>
            <span className="rm-badge-elric rm3-tag" data-tone="accent" title={elricTooltip()}>
              built-in {ELRIC_AI_TAG}
            </span>
          </div>
          <div className="rm-bubble">
            {/* The dots stay until the reveal has loaded, so the first words never show twice. */}
            {elricDraft.text && streaming ? (
              <TextPart
                text={elricDraft.text}
                names={NO_NAMES}
                markdown
                priority={Number.MAX_SAFE_INTEGER}
                reveal={{ done: false, key: `room:${roomId}:${elricDraft.after ?? ''}` }}
              />
            ) : (
              <ThinkingDots since={elricDraft.since} className="rm-elric-dots" />
            )}
          </div>
        </div>
      </li>,
    );

  return (
    <div className="rm-list-wrap">
      <div
        className="rm-scroll"
        ref={scroller}
        data-testid="room-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          const top = element.scrollTop;
          const up = top < lastTop.current;
          lastTop.current = top;
          // A scroll event arrives a frame after the scroll. If the thread grew in between (a
          // message rendered, Markdown swapped in), our own scroll to the bottom reads as "away
          // from the bottom"; only the reader moving up stops following.
          if (element.scrollHeight - top - element.clientHeight < PINNED_PX) setPinned(true);
          else if (up) setPinned(false);
          if (pinned.current) setUnseen(0);
          if (element.scrollTop < OLDER_PX && hasOlder && !loadingOlder) onOlder();
        }}
      >
        <div className="rm-column" ref={column}>
          {hasOlder || loadingOlder ? (
            <div className="rm-older">
              {loadingOlder ? (
                <span role="status">
                  <LoaderCircle className="spin" size={14} aria-hidden="true" /> Loading earlier
                  messages…
                </span>
              ) : (
                <button type="button" className="rm-quiet" onClick={onOlder}>
                  Load earlier messages
                </button>
              )}
            </div>
          ) : (
            children
          )}
          <ol aria-label="Room messages" className="rm-messages">
            {rows}
          </ol>
        </div>
      </div>
      {unseen ? (
        <button type="button" className="rm-jump" onClick={toBottom}>
          New messages
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
