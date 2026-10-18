import './messages-rooms.css';
import { useState } from 'react';
import type {
  ConversationSummary,
  DirectRecipient,
  DirectThread,
} from '../../../server/messaging/contract';
import { api } from '../../api';
import { useInboxSummary } from '../../Messages';
import { formatUnread } from '../../messagesV2';
import { Avatar } from '../../rooms/Avatar';
import { AvatarColorsContext, useAvatarColors } from '../../shell/avatarColor';
import { agentConversations, newMessageRoom, shortAgo } from './messagesRoomsModel';
import {
  conversationsPath,
  ErrorLine,
  IconMsg,
  LoadingRow,
  ScreenFrame,
  failure,
  rememberOpenedThread,
  useLoad,
  type AgentScreenProps,
} from './messagesRoomsShared';
import { InvitationRequests } from './InvitationsScreen';

/**
 * The agent's unread total for the pane's Messages row (GET /api/messages/summary, owner-wide
 * per inbox), polled with the console's inbox summary.
 */
export function useAgentUnread(agentId: string): number {
  return useInboxSummary(true).unread.get(agentId) ?? 0;
}

type MessagesData = { conversations: ConversationSummary[]; recipients: DirectRecipient[] | null };

/**
 * Messages of one agent: its threads (who, last text, time, unread) → a thread. Empty: "No
 * messages yet", with "New message" only when the person shares a room with the agent.
 */
export function MessagesScreen({
  agent,
  onBack,
  onOpen,
  onOpenRoom,
  onChanged,
  backLabel,
}: AgentScreenProps) {
  const { load, reload } = useLoad<MessagesData>(
    agent.id,
    async (signal) => {
      const { conversations } = await api<{ conversations: ConversationSummary[] }>(
        conversationsPath(agent.id),
        undefined,
        'GET',
        signal,
      );
      if (agentConversations(conversations, agent.id).length)
        return { conversations, recipients: null };
      // Only the empty state needs to know whether a thread can be started.
      const { recipients } = await api<{ recipients: DirectRecipient[] }>(
        '/api/messages/recipients',
        undefined,
        'GET',
        signal,
      );
      return { conversations, recipients };
    },
    10_000,
  );
  const rows = load.state === 'ready' ? agentConversations(load.data.conversations, agent.id) : [];
  const colours = useAvatarColors(rows.map((row) => row.with.id));
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const room =
    load.state === 'ready' && load.data.recipients
      ? newMessageRoom(load.data.recipients, agent.id)
      : null;

  async function startThread() {
    if (!room || opening) return;
    setOpening(true);
    setOpenError('');
    try {
      const thread = await api<DirectThread>(`/api/rooms/${encodeURIComponent(room)}/direct`, {
        to: agent.id,
      });
      rememberOpenedThread(thread);
      onOpen(`thread:${thread.context_id}`);
    } catch (err) {
      setOpenError(failure(err));
    } finally {
      setOpening(false);
    }
  }

  return (
    <ScreenFrame backLabel={backLabel ?? agent.name} onBack={onBack} title="Messages">
      {/* A room's invitation to this agent: the owner accepts or declines here. */}
      <InvitationRequests agent={agent} onOpenRoom={onOpenRoom} onChanged={onChanged} />
      {load.state === 'loading' ? (
        <LoadingRow />
      ) : load.state === 'error' ? (
        <ErrorLine message={load.message} onRetry={() => void reload()} />
      ) : rows.length ? (
        <AvatarColorsContext.Provider value={colours}>
          <div className="amr4-group">
            {rows.map((row) => (
              <button
                key={row.contextId}
                type="button"
                className="amr4-gr"
                onClick={() => onOpen(`thread:${row.contextId}`)}
              >
                <Avatar
                  id={row.with.id}
                  name={row.with.name}
                  kind={row.with.kind}
                  size="sm"
                  className="amr4-av"
                />
                <span className="amr4-two">
                  <b>{row.with.name}</b>
                  <span>{row.last}</span>
                </span>
                <span className="amr4-meta">
                  <time dateTime={row.at}>{shortAgo(row.at)}</time>
                  {row.unread ? (
                    <span className="amr4-badge">{formatUnread(row.unread, row.unreadCapped)}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </AvatarColorsContext.Provider>
      ) : (
        <>
          <div className="amr4-hero2">
            <div className="amr4-mark">
              <IconMsg />
            </div>
            <b>No messages yet</b>
            {/* You write to an agent in a room you share; without one, the way there is one tap. */}
            <span>
              {room
                ? `Write to ${agent.name} to start.`
                : `${agent.name} isn't in a room with you yet.`}
            </span>
          </div>
          {room ? (
            <button
              type="button"
              className="amr4-btn amr4-block"
              disabled={opening}
              onClick={() => void startThread()}
            >
              New message
            </button>
          ) : (
            <button
              type="button"
              className="amr4-btn amr4-soft amr4-block"
              onClick={() => onOpen('rooms-add')}
            >
              Add to a room
            </button>
          )}
          {openError ? (
            <p className="amr4-note amr4-errline" role="alert">
              {openError}
            </p>
          ) : null}
        </>
      )}
    </ScreenFrame>
  );
}
