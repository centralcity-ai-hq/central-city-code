import './messages-rooms.css';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentMessage, ConversationSummary } from '../../../server/messaging/contract';
import { api } from '../../api';
import { messageTime } from '../../messagesV2';
import {
  directView,
  mergeMessages,
  messageText,
  threadView,
  type ThreadView,
} from './messagesRoomsModel';
import {
  conversationsPath,
  ErrorLine,
  IconSend,
  LoadingRow,
  ScreenFrame,
  failure,
  openedThread,
  useLoad,
  type AgentScreenProps,
} from './messagesRoomsShared';

/** Messages shown in a thread: its newest page. */
const PAGE = 50;

type ThreadData = { view: ThreadView | null; messages: AgentMessage[] };

/**
 * One thread of the agent: its messages (the agent's side on the right) and a composer. A
 * private room thread replies as the Messages page does (POST /api/rooms/:room/direct/messages,
 * from the viewer's member to the other); a thread along a connection replies as this agent.
 * The thread is marked read once its messages are on screen.
 */
export function ThreadScreen({
  agent,
  contextId,
  onBack,
  backLabel,
  onRead,
}: AgentScreenProps & {
  contextId: string;
  /** Called after the thread was marked read, so the shell can refresh its badges. */
  onRead?: () => void;
}) {
  const { load, reload, setLoad } = useLoad<ThreadData>(
    `${agent.id}:${contextId}`,
    async (signal) => {
      const [list, page] = await Promise.all([
        api<{ conversations: ConversationSummary[] }>(
          conversationsPath(agent.id),
          undefined,
          'GET',
          signal,
        ),
        api<{ messages: AgentMessage[] }>(
          `/api/messages/conversations/${encodeURIComponent(contextId)}?limit=${PAGE}`,
          undefined,
          'GET',
          signal,
        ),
      ]);
      const summary = list.conversations.find((item) => item.context_id === contextId);
      const opened = openedThread(contextId);
      const view = summary
        ? threadView(summary, agent.id)
        : opened
          ? directView(opened, agent.id)
          : null;
      return { view, messages: mergeMessages([], page.messages) };
    },
    10_000,
  );
  const data = load.state === 'ready' ? load.data : null;
  const view = data?.view ?? null;
  // The newest message, not the count: a full page (PAGE messages) stays the same length when a
  // new one arrives and the oldest drops off, but its newest message changes.
  const newest = data?.messages.at(-1)?.id ?? '';

  // Reading the thread marks it read for the owner (as the Messages page does).
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  useEffect(() => {
    if (!newest) return;
    api(`/api/messages/direct/${encodeURIComponent(contextId)}/read`, {})
      .then(() => onReadRef.current?.())
      .catch(() => undefined);
  }, [contextId, newest]);

  // Newest message in view: on open and whenever one arrives.
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [newest]);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const key = useRef(crypto.randomUUID());
  async function send(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!view || !body || busy) return;
    setBusy(true);
    setSendError('');
    try {
      const { send: route } = view;
      const result =
        route.mode === 'direct'
          ? await api<{ message: AgentMessage }>(
              `/api/rooms/${encodeURIComponent(route.room)}/direct/messages`,
              { from: route.from, to: route.to.id, text: body, idempotency_key: key.current },
            )
          : await api<{ message: AgentMessage }>(
              `/api/agents/${encodeURIComponent(route.from)}/messages`,
              {
                to_agent_id: route.to.id,
                text: body,
                context_id: contextId,
                idempotency_key: key.current,
              },
            );
      key.current = crypto.randomUUID();
      setText('');
      setLoad((prev) =>
        prev.state === 'ready'
          ? {
              state: 'ready',
              data: { ...prev.data, messages: mergeMessages(prev.data.messages, [result.message]) },
            }
          : prev,
      );
    } catch (err) {
      setSendError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const title = view?.with.name ?? '';
  const composer = view ? (
    <form className="amr4-composer" onSubmit={(event) => void send(event)}>
      <input
        className="amr4-field"
        placeholder={`Message ${view.send.to.name}`}
        aria-label="Message"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          key.current = crypto.randomUUID();
        }}
      />
      <button type="submit" className="amr4-btn" aria-label="Send" disabled={busy || !text.trim()}>
        <IconSend />
      </button>
    </form>
  ) : null;

  return (
    <ScreenFrame
      backLabel={backLabel ?? 'Messages'}
      onBack={onBack}
      title={title}
      sub={view ? `with ${agent.name}` : undefined}
      composer={composer}
    >
      {load.state === 'loading' ? (
        <LoadingRow />
      ) : load.state === 'error' ? (
        <ErrorLine message={load.message} onRetry={() => void reload()} />
      ) : (
        <div className="amr4-thread">
          {load.data.messages.map((message) => (
            <div
              key={message.id}
              className={`amr4-bub${view && message.from_agent_id === view.mine ? ' amr4-me' : ''}`}
            >
              {messageText(message)}
              <small>{messageTime(message.created_at)}</small>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
      {sendError ? (
        <p className="amr4-note amr4-errline" role="alert">
          {sendError}
        </p>
      ) : null}
    </ScreenFrame>
  );
}
