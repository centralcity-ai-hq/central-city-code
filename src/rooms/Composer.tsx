import { lazy, Suspense, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, AtSign, Check, ChevronDown, CodeXml } from 'lucide-react';
import { Avatar, type AvatarKind } from './Avatar';
import type { Member } from './api';
import { agentLabel, agentOwners, mentionNamesFor, ownHost } from './people';
import { NEW_POST_FORMAT } from './markdown/format';
import { MessageBoundary } from './markdown/Boundary';
import './markdown/composer.css';

const Markdown = lazy(() =>
  import('./markdown/Markdown').then((module) => ({ default: module.Markdown })),
);

/** The server's text limit (MESSAGE_LIMITS.textChars). */
const MAX = 16_384;
const MAX_LINES = 8;
/** A Markdown code fence. */
const FENCE = '```';

/** The `@query` being typed right before the caret, if any. */
function mentionAt(text: string, caret: number) {
  const match = /(^|\s)@([^\s@]{0,32})$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() } : null;
}

const kindOf = (member: Member): AvatarKind =>
  member.auto_reply?.provider === 'elric' ? 'elric' : member.kind === 'person' ? 'person' : 'agent';

/**
 * Room composer (Workspace v3 §4.4): a floating card with the auto-growing 16 px textarea on top
 * and one tool row under it: the "Post as" picker on the left (only when the viewer has several
 * identities here; with one, Members already shows who you are), then mention, code block, add task, Preview and the
 * Send square. Enter sends, Shift+Enter adds a line (on touch Enter adds a line), @ opens the
 * member picker. The draft lives in the parent, so it survives polls and re-sorts.
 */
export function Composer({
  roomName,
  members,
  own,
  draft,
  onDraft,
  onSend,
  disabled,
  onTask,
}: {
  roomName: string;
  members: Member[];
  /** The viewer's own member agents in this room. */
  own: Member[];
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string, agentId?: string) => void;
  /** A reason the composer cannot send right now (offline), or ''. */
  disabled: string;
  /** Opens the room's new-task form (only where the viewer can add tasks). */
  onTask?: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // The caret to restore once an insert (code block, @mention) is rendered: set right after React
  // commits the new draft, never on a frame that may still show the old text.
  const pendingCaret = useRef<{ caret: number; track: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    const pending = pendingCaret.current;
    if (!element || !pending || element.value !== draft) return;
    pendingCaret.current = null;
    element.focus();
    element.setSelectionRange(pending.caret, pending.caret);
    if (pending.track) track(draft, pending.caret);
  }, [draft]);
  const [agentId, setAgentId] = useState('');
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // Markdown is typed as text; Preview shows it rendered. No editor.
  const markdown = NEW_POST_FORMAT === 'markdown';
  const [preview, setPreview] = useState(false);
  const agentOwner = agentOwners(members);
  const postable = own.filter((member) => member.auto_reply?.provider !== 'elric');
  // You write as yourself by default (your person member, when you are in the room); your agents
  // are a choice under "Post as".
  const self = postable.find((member) => member.kind === 'person');
  const sender = postable.find((member) => member.id === agentId) ?? self ?? postable[0];
  const asPerson = sender?.kind === 'person';
  // Never the sender itself. Your own room-host agent only when you write as yourself: then the
  // @mention wakes it (people.ts ownHost); from one of your agents it is no mention.
  const mine = ownHost(members);
  const options = picker
    ? members
        .filter((member) => member.id !== sender?.id)
        .filter((member) => asPerson || member.id !== mine?.id)
        .filter((member) => member.name.toLowerCase().includes(picker.query))
        .slice(0, 8)
    : [];

  // Auto-grow between 1 and 8 lines.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = 'auto';
    const line = parseFloat(getComputedStyle(element).lineHeight) || 24;
    const padding = element.offsetHeight - element.clientHeight + 16;
    element.style.height = `${Math.min(element.scrollHeight, line * MAX_LINES + padding)}px`;
  }, [draft]);

  function track(text: string, caret: number) {
    const found = mentionAt(text, caret);
    setPicker(found);
    setActive(0);
  }
  function choose(member: Member) {
    const element = box.current;
    if (!element || !picker) return;
    const caret = element.selectionStart;
    const next = `${draft.slice(0, picker.start)}@${member.name} ${draft.slice(caret)}`;
    pendingCaret.current = { caret: picker.start + member.name.length + 2, track: false };
    onDraft(next);
    setPicker(null);
  }
  /** Inserts text at the caret (around the selection), then puts the caret after it. */
  function insert(before: string, after = '') {
    const element = box.current;
    if (!element) return;
    const start = element.selectionStart ?? draft.length;
    const end = element.selectionEnd ?? start;
    const selected = draft.slice(start, end);
    const next = draft.slice(0, start) + before + selected + after + draft.slice(end);
    pendingCaret.current = { caret: start + before.length + selected.length, track: true };
    onDraft(next);
    setPreview(false);
  }
  function atCaret() {
    const start = box.current?.selectionStart ?? draft.length;
    return { start, previous: draft.slice(0, start).at(-1) };
  }
  function send() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text, own.length > 1 ? sender?.id : undefined);
    onDraft('');
    setPicker(null);
    setPreview(false);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((index) => (index + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(options[active]!);
        return;
      }
    }
    if (event.key === 'Escape' && picker) {
      event.preventDefault();
      setPicker(null);
      return;
    }
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  return (
    <form
      className="rm-composer rm3-composer"
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="rm-compose-card">
        <div className="rm-compose-row">
          {picker && options.length ? (
            <ul className="rm-picker" role="listbox" aria-label="Mention a member">
              {options.map((member, index) => (
                <li
                  key={member.id}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(member);
                  }}
                >
                  <Avatar id={member.id} name={member.name} kind={kindOf(member)} size="xs" />
                  <strong>{member.name}</strong>
                  <span title={member.own ? undefined : member.owner_label}>
                    {member.kind === 'person'
                      ? member.own
                        ? 'you'
                        : 'person'
                      : member.own
                        ? 'your agent'
                        : agentLabel(agentOwner(member.owner_label))}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {preview ? (
            <div className="rm-preview" aria-label="Preview" role="region">
              {draft.trim() ? (
                <MessageBoundary fallback={<p className="rm-text">{draft}</p>}>
                  <Suspense fallback={<p className="rm-text">{draft}</p>}>
                    <Markdown
                      text={draft}
                      names={mentionNamesFor(members, { own: true, sender_kind: sender?.kind })}
                    />
                  </Suspense>
                </MessageBoundary>
              ) : (
                <p className="rm-compose-note">Nothing to preview.</p>
              )}
            </div>
          ) : null}
          <textarea
            hidden={preview}
            ref={box}
            rows={1}
            aria-label="Message"
            value={draft}
            maxLength={MAX}
            placeholder={
              window.matchMedia?.('(max-width: 479px)').matches
                ? 'Message…'
                : `Message ${roomName}…`
            }
            // aria-expanded is not allowed on a textarea (axe aria-allowed-attr); the @-mention
            // list announces itself as a listbox.
            aria-autocomplete="list"
            onChange={(event) => {
              onDraft(event.target.value);
              track(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={keyDown}
            onClick={(event) =>
              track(event.currentTarget.value, event.currentTarget.selectionStart)
            }
            onBlur={() => setPicker(null)}
          />
        </div>
        <div className="rm-compose-tools">
          {postable.length > 1 ? (
            <label className="rm-post-as rm3-postas">
              <Avatar
                id={sender?.id}
                name={sender?.name ?? ''}
                kind={sender ? kindOf(sender) : 'agent'}
                size="xs"
              />
              <span className="rm3-postas-label">Post as</span>
              <select value={sender?.id ?? ''} onChange={(event) => setAgentId(event.target.value)}>
                {(self ? [self, ...postable.filter((member) => member !== self)] : postable).map(
                  (member) => (
                    <option key={member.id} value={member.id}>
                      {member.kind === 'person' ? `${member.name} (you)` : member.name}
                    </option>
                  ),
                )}
              </select>
              <ChevronDown className="rm3-postas-chevron" size={14} aria-hidden="true" />
            </label>
          ) : null}
          <span className="rm-tools-spacer" />
          <button
            type="button"
            className="rm-tool"
            aria-label="Mention a member"
            title="Mention a member"
            onClick={() => {
              const { previous } = atCaret();
              insert(previous && !/\s/.test(previous) ? ' @' : '@');
            }}
          >
            <AtSign size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rm-tool"
            aria-label="Insert code block"
            title="Insert code block"
            onClick={() => {
              const { start, previous } = atCaret();
              insert(`${start && previous !== '\n' ? '\n' : ''}${FENCE}\n`, `\n${FENCE}`);
            }}
          >
            <CodeXml size={18} aria-hidden="true" />
          </button>
          {onTask ? (
            <button
              type="button"
              className="rm-tool"
              aria-label="Add a task"
              title="Add a task"
              onClick={onTask}
            >
              <Check size={18} aria-hidden="true" />
            </button>
          ) : null}
          {markdown ? (
            <button
              type="button"
              className="rm-preview-toggle"
              aria-pressed={preview}
              onClick={() => {
                setPreview((value) => !value);
                if (preview) requestAnimationFrame(() => box.current?.focus());
              }}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
          ) : null}
          <button
            type="submit"
            className="rm-send"
            aria-label="Send"
            title={disabled || 'Send'}
            disabled={Boolean(disabled) || !draft.trim()}
          >
            <ArrowUp size={20} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
      </div>
      {disabled ? <p className="rm-compose-note">{disabled}</p> : null}
      {draft.length > MAX * 0.9 ? (
        <p className="rm-compose-note" aria-live="polite">
          {draft.length.toLocaleString()} / {MAX.toLocaleString()}
        </p>
      ) : null}
    </form>
  );
}
